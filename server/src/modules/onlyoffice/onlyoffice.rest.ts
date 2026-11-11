/**
 * Edição dos documentos gerados no OnlyOffice — o mesmo Document Server que o
 * PSA Docs usa (container `psa-onlyoffice`, publicado em /oo-ds pelo nginx).
 *
 * O que o editor exige e por que cada rota existe:
 *   GET  /api/oo/sessao/:docId      → config assinada em JWT para o browser abrir
 *   GET  /api/oo/arquivo/:cap       → o DS baixa o .docx por aqui (capability token,
 *                                     porque o DS não tem o Bearer do usuário)
 *   POST /api/oo/callback/:cap      → o DS devolve o .docx salvo; regeramos o PDF
 *   POST /api/oo/forcesave/:docId   → "Salvar e fechar" sem esperar o autosave
 *
 * O PDF é regerado pelo próprio OnlyOffice (ConvertService), não pelo LibreOffice:
 * o cliente assina o PDF, e ele precisa ser idêntico à paginação que o revisor viu.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { createReadStream, existsSync, statSync, copyFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { prisma } from "../../db.js";

/** Segredo do Document Server (o mesmo do PSA Docs — DS único na máquina). */
const OO_JWT_SECRET = process.env.OO_JWT_SECRET ?? "psa-oo-jwt-2026";
/** URL que o BROWSER usa para carregar o editor. */
const OO_PUBLIC_URL = (process.env.OO_PUBLIC_URL ?? "https://avoce.capium.com.br/oo-ds").replace(/\/$/, "");
/** URL que o SERVIDOR usa para falar com o DS (ConvertService/CommandService). */
const OO_INTERNAL_URL = (process.env.OO_INTERNAL_URL ?? "http://127.0.0.1:8402").replace(/\/$/, "");
/** URL que o DS (dentro do Docker) usa para chegar no Avoce. */
const APP_INTERNAL_URL = (process.env.APP_INTERNAL_URL ?? "http://host.docker.internal:8470").replace(/\/$/, "");

type JwtPayload = { userId: string; empresaId?: string; role?: string };

function verifyUsuario(req: FastifyRequest): JwtPayload | null {
  const auth = req.headers.authorization ?? "";
  const header = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = header || ((req.query as any)?.token ?? "");
  try {
    return jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  } catch {
    return null;
  }
}

/** Token de capacidade para o DS: vale só para um documento e uma finalidade. */
function capability(docId: string, uso: "arquivo" | "callback"): string {
  return jwt.sign({ docId, uso }, OO_JWT_SECRET, { expiresIn: "24h" });
}

function lerCapability(cap: string, uso: "arquivo" | "callback"): string | null {
  try {
    const p = jwt.verify(cap, OO_JWT_SECRET) as { docId: string; uso: string };
    return p.uso === uso ? p.docId : null;
  } catch {
    return null;
  }
}

/**
 * Chave do documento para o DS. Precisa mudar a cada alteração do arquivo,
 * senão o DS serve a versão em cache e a correção "some" ao reabrir.
 */
function chaveDocumento(docId: string, caminho: string): string {
  const mtime = existsSync(caminho) ? Math.floor(statSync(caminho).mtimeMs) : 0;
  return `${docId}-${mtime}`.replace(/[^0-9a-zA-Z_-]/g, "").slice(-100);
}

/** Converte o .docx salvo em PDF pelo próprio OnlyOffice (paginação fiel). */
async function converterParaPdfViaOO(docId: string, titulo: string): Promise<Buffer> {
  const payload = {
    async: false,
    filetype: "docx",
    outputtype: "pdf",
    key: randomUUID().replace(/-/g, ""),
    title: `${titulo}.docx`,
    url: `${APP_INTERNAL_URL}/api/oo/arquivo/${capability(docId, "arquivo")}`,
  };
  const token = jwt.sign(payload, OO_JWT_SECRET, { expiresIn: "5m" });

  const res = await fetch(`${OO_INTERNAL_URL}/ConvertService.ashx`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ ...payload, token }),
  });
  if (!res.ok) throw new Error(`ConvertService HTTP ${res.status}`);
  const json = await res.json() as { fileUrl?: string; error?: number };
  if (json.error || !json.fileUrl) throw new Error(`ConvertService erro ${json.error ?? "sem fileUrl"}`);

  const pdfRes = await fetch(urlInternaDoDS(json.fileUrl));
  if (!pdfRes.ok) throw new Error(`download do PDF convertido HTTP ${pdfRes.status}`);
  return Buffer.from(await pdfRes.arrayBuffer());
}

/**
 * O DS devolve URLs com o host público (…/oo-ds/cache/…). Quem baixa é o Node,
 * que fala com o DS direto na 8402 — sem esta troca a requisição sai para a
 * internet e volta pelo nginx à toa (e falha se o DNS externo oscilar).
 */
function urlInternaDoDS(url: string): string {
  if (url.startsWith(OO_PUBLIC_URL)) return OO_INTERNAL_URL + url.slice(OO_PUBLIC_URL.length);
  return url.replace(/^https?:\/\/[^/]+\/oo-ds/, OO_INTERNAL_URL);
}

/** Fallback de conversão quando o Document Server não responde. */
function docxParaPdfLibreOffice(docxPath: string, pdfPath: string): void {
  const outDir = dirname(pdfPath);
  const loHome = mkdtempSync(join(tmpdir(), "oo-lo-"));
  try {
    execSync(
      `libreoffice --headless --norestore --convert-to pdf --outdir "${outDir}" "${docxPath}"`,
      { timeout: 90000, env: { ...process.env, HOME: loHome } },
    );
    const gerado = join(outDir, basename(docxPath).replace(/\.docx$/i, ".pdf"));
    if (existsSync(gerado) && gerado !== pdfPath) {
      copyFileSync(gerado, pdfPath);
      unlinkSync(gerado);
    }
  } finally {
    try { rmSync(loHome, { recursive: true, force: true }); } catch {}
  }
}

export function registrarRotasOnlyOffice(app: FastifyInstance): void {

  // ── Configuração do editor ────────────────────────────────────────────────
  app.get("/api/oo/sessao/:docId", async (req, reply) => {
    const usuario = verifyUsuario(req);
    if (!usuario) return reply.status(401).send({ error: "Não autorizado" });

    const { docId } = req.params as { docId: string };
    const doc = await (prisma as any).documentoGerado.findUnique({
      where: { id: docId },
      include: { proposta: { select: { tomador: { select: { nome: true } } } } },
    });
    if (!doc) return reply.status(404).send({ error: "Documento não encontrado" });
    if (!doc.docxPath || !existsSync(doc.docxPath)) {
      return reply.status(409).send({ error: "Este documento não tem DOCX — regenere os documentos da proposta" });
    }

    const dadosUsuario = await prisma.usuario.findUnique({
      where: { id: usuario.userId },
      select: { nome: true },
    });

    const config: Record<string, any> = {
      document: {
        fileType: "docx",
        key:      chaveDocumento(docId, doc.docxPath),
        title:    `${doc.titulo}.docx`,
        url:      `${APP_INTERNAL_URL}/api/oo/arquivo/${capability(docId, "arquivo")}`,
        permissions: { edit: true, download: true, print: true },
      },
      documentType: "word",
      type: "desktop",
      editorConfig: {
        lang: "pt-BR",
        mode: "edit",
        callbackUrl: `${APP_INTERNAL_URL}/api/oo/callback/${capability(docId, "callback")}`,
        user: { id: usuario.userId, name: dadosUsuario?.nome ?? "Revisor" },
        customization: {
          autosave: true,
          forcesave: true,
          compactHeader: true,
          hideRightMenu: true,
          chat: false,
          comments: false,
          help: false,
        },
      },
    };
    config.token = jwt.sign(config, OO_JWT_SECRET, { expiresIn: "12h" });

    return reply.send({ config, scriptUrl: `${OO_PUBLIC_URL}/web-apps/apps/api/documents/api.js` });
  });

  // ── O DS baixa o arquivo por aqui ─────────────────────────────────────────
  app.get("/api/oo/arquivo/:cap", async (req, reply) => {
    const { cap } = req.params as { cap: string };
    const docId = lerCapability(cap, "arquivo");
    if (!docId) return reply.status(403).send({ error: "Token inválido" });

    const doc = await (prisma as any).documentoGerado.findUnique({ where: { id: docId } });
    if (!doc?.docxPath || !existsSync(doc.docxPath)) return reply.status(404).send({ error: "DOCX não disponível" });

    reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    return reply.send(createReadStream(doc.docxPath));
  });

  // ── O DS devolve o arquivo salvo ──────────────────────────────────────────
  app.post("/api/oo/callback/:cap", async (req, reply) => {
    const { cap } = req.params as { cap: string };
    const docId = lerCapability(cap, "callback");
    if (!docId) return reply.status(403).send({ error: 1 });

    const body = (req.body ?? {}) as { status?: number; url?: string; key?: string };
    // 2 = todos fecharam e há o que salvar; 6 = forcesave (nosso "Salvar e fechar")
    if (body.status !== 2 && body.status !== 6) return reply.send({ error: 0 });
    if (!body.url) return reply.send({ error: 0 });

    try {
      const doc = await (prisma as any).documentoGerado.findUnique({ where: { id: docId } });
      if (!doc?.docxPath) return reply.send({ error: 0 });

      const res = await fetch(urlInternaDoDS(body.url));
      if (!res.ok) throw new Error(`download do DOCX editado HTTP ${res.status}`);
      await writeFile(doc.docxPath, Buffer.from(await res.arrayBuffer()));
      console.log(`[OO] DOCX salvo: ${doc.docxPath} (status ${body.status})`);

      // PDF é o que vai para assinatura: regerar sempre, e falhar alto se não der
      try {
        const pdf = await converterParaPdfViaOO(docId, doc.titulo);
        const pdfPath = doc.pdfPath ?? doc.docxPath.replace(/\.docx$/i, ".pdf");
        await writeFile(pdfPath, pdf);
        await (prisma as any).documentoGerado.update({
          where: { id: docId },
          data: { pdfPath, atualizadoEm: new Date() },
        });
        console.log(`[OO] PDF regerado pelo OnlyOffice: ${pdfPath} (${pdf.length} bytes)`);
      } catch (e) {
        // Fallback: LibreOffice. Pagina diferente do editor, mas é melhor que
        // deixar o revisor com um PDF desatualizado do texto que ele acabou de corrigir.
        console.error("[OO] ConvertService falhou, convertendo por LibreOffice:", (e as Error).message);
        const pdfPath = doc.pdfPath ?? doc.docxPath.replace(/\.docx$/i, ".pdf");
        docxParaPdfLibreOffice(doc.docxPath, pdfPath);
        await (prisma as any).documentoGerado.update({
          where: { id: docId },
          data: { pdfPath, atualizadoEm: new Date() },
        });
      }
    } catch (e) {
      console.error("[OO] callback falhou:", e);
      return reply.send({ error: 1 });
    }

    return reply.send({ error: 0 });
  });

  // ── "Salvar e fechar": pede o forcesave em vez de esperar o autosave ──────
  app.post("/api/oo/forcesave/:docId", async (req, reply) => {
    const usuario = verifyUsuario(req);
    if (!usuario) return reply.status(401).send({ error: "Não autorizado" });

    const { docId } = req.params as { docId: string };
    const doc = await (prisma as any).documentoGerado.findUnique({ where: { id: docId } });
    if (!doc?.docxPath) return reply.status(404).send({ error: "Documento não encontrado" });

    const payload = { c: "forcesave", key: chaveDocumento(docId, doc.docxPath) };
    const token = jwt.sign(payload, OO_JWT_SECRET, { expiresIn: "5m" });
    try {
      const res = await fetch(`${OO_INTERNAL_URL}/coauthoring/CommandService.ashx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, token }),
      });
      const json = await res.json() as { error?: number };
      // error 4 = nada mudou desde o último save; para o usuário é sucesso
      return reply.send({ ok: !json.error || json.error === 4, oo: json.error ?? 0 });
    } catch (e) {
      console.error("[OO] forcesave falhou:", e);
      return reply.status(502).send({ error: "Document Server indisponível" });
    }
  });
}
