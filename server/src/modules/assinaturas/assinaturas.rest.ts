/**
 * Rotas REST do módulo Assinaturas.
 * Multipart (upload de PDF) e download de binários não passam pelo tRPC.
 *
 *   POST /api/assinatura/analisar        → PDF  → signatários sugeridos pela IA
 *   POST /api/assinatura/criar           → PDF + metadata → documento DRAFT no PAKT
 *   GET  /api/assinatura/:id/download    → PDF original ou assinado
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import jwt from "jsonwebtoken";
import { createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "../../db.js";
import { analisarSignatarios } from "../../lib/assinatura-ia.js";
import { paktBaixarPdf, paktCriarDocumento, type PaktSignerInput } from "../../lib/pakt.js";
import { ASSINATURAS_DIR, sanitizar, type Signatario } from "./assinatura-service.js";

type JwtPayload = { userId: string; empresaId?: string; role?: string };

function verifyJwt(req: FastifyRequest): JwtPayload | null {
  const auth = req.headers.authorization ?? "";
  const header = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const token = header || ((req.query as any)?.token ?? "");
  try {
    return jwt.verify(token, process.env.JWT_SECRET!) as JwtPayload;
  } catch {
    return null;
  }
}

/** O usuário pode operar sobre este emitente (escritório)? */
async function podeUsarEmitente(payload: JwtPayload, emitenteId: string): Promise<boolean> {
  if (payload.role === "admin" && !payload.empresaId) return true;

  const usuario = await prisma.usuario.findUnique({
    where: { id: payload.userId },
    select: { permissoes: true },
  });
  const emitentes = (usuario?.permissoes as any)?.emitentes as string[] | undefined;
  if (emitentes) return emitentes.includes(emitenteId);

  const emitente = await prisma.empresaEmitente.findUnique({
    where: { id: emitenteId },
    select: { empresaId: true },
  });
  return !!emitente && !!payload.empresaId && emitente.empresaId === payload.empresaId;
}

async function lerMultipart(req: FastifyRequest): Promise<{ arquivo: Buffer | null; nomeArquivo: string; campos: Record<string, string> }> {
  let arquivo: Buffer | null = null;
  let nomeArquivo = "documento.pdf";
  const campos: Record<string, string> = {};

  for await (const part of req.parts()) {
    if (part.type === "file" && part.fieldname === "file") {
      nomeArquivo = part.filename || nomeArquivo;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk as Buffer);
      arquivo = Buffer.concat(chunks);
    } else if (part.type === "field") {
      campos[part.fieldname] = String(part.value);
    }
  }
  return { arquivo, nomeArquivo, campos };
}

const PAPEIS = new Set(["SIGNER", "WITNESS", "APPROVER"]);

export function registrarRotasAssinatura(app: FastifyInstance): void {
  // ── Análise por IA ─────────────────────────────────────────────────────────
  app.post("/api/assinatura/analisar", async (req, reply) => {
    const payload = verifyJwt(req);
    if (!payload) return reply.status(401).send({ error: "Não autorizado" });

    const { arquivo, nomeArquivo } = await lerMultipart(req);
    if (!arquivo) return reply.status(400).send({ error: "Envie o PDF no campo 'file'" });
    if (arquivo.subarray(0, 5).toString() !== "%PDF-")
      return reply.status(400).send({ error: "Apenas arquivos PDF são aceitos" });

    try {
      const analise = await analisarSignatarios(arquivo, nomeArquivo);
      return reply.send(analise);
    } catch (e) {
      app.log.error({ err: e }, "[Assinatura] análise por IA falhou");
      return reply.status(500).send({ error: "Falha ao analisar o PDF" });
    }
  });

  // ── Criação do documento ───────────────────────────────────────────────────
  app.post("/api/assinatura/criar", async (req, reply) => {
    const payload = verifyJwt(req);
    if (!payload) return reply.status(401).send({ error: "Não autorizado" });

    const { arquivo, nomeArquivo, campos } = await lerMultipart(req);
    if (!arquivo) return reply.status(400).send({ error: "Envie o PDF no campo 'file'" });
    if (arquivo.subarray(0, 5).toString() !== "%PDF-")
      return reply.status(400).send({ error: "Apenas arquivos PDF são aceitos" });
    if (arquivo.length > 20 * 1024 * 1024)
      return reply.status(400).send({ error: "PDF acima do limite do PAKT (20 MB)" });

    let meta: {
      emitenteId?: string;
      nome?: string;
      mensagem?: string;
      expiresAt?: string;
      tomadorId?: string;
      signatarios?: Array<Partial<Signatario>>;
    };
    try {
      meta = JSON.parse(campos.metadata ?? "{}");
    } catch {
      return reply.status(400).send({ error: "Campo 'metadata' não é um JSON válido" });
    }

    if (!meta.emitenteId) return reply.status(400).send({ error: "Escolha o escritório remetente" });
    if (!(await podeUsarEmitente(payload, meta.emitenteId)))
      return reply.status(403).send({ error: "Acesso negado a este escritório" });

    const emitente = await prisma.empresaEmitente.findUnique({ where: { id: meta.emitenteId } });
    if (!emitente) return reply.status(400).send({ error: "Escritório remetente não encontrado" });

    const entrada = (meta.signatarios ?? []).filter((s) => s?.nome?.trim() && s?.email?.trim());
    if (entrada.length === 0)
      return reply.status(400).send({ error: "Informe ao menos um signatário com nome e e-mail" });

    const nomeDoc = (meta.nome ?? "").trim() || nomeArquivo.replace(/\.pdf$/i, "");

    const signersPakt: PaktSignerInput[] = entrada.map((s, i) => ({
      nome: s.nome!.trim(),
      email: s.email!.trim(),
      telefone: s.telefone?.trim() || undefined,
      countryCode: "BR",
      signatureRole: (PAPEIS.has(s.papel ?? "") ? s.papel : "SIGNER") as PaktSignerInput["signatureRole"],
      orderIndex: i,
    }));

    let doc;
    try {
      doc = await paktCriarDocumento(arquivo, nomeArquivo, {
        nome: nomeDoc,
        mensagem: meta.mensagem?.trim() || undefined,
        expiresAt: meta.expiresAt || undefined,
        signers: signersPakt,
      });
    } catch (e) {
      app.log.error({ err: e }, "[Assinatura] criação no PAKT falhou");
      return reply.status(502).send({ error: e instanceof Error ? e.message : "Falha ao criar documento no PAKT" });
    }

    // Mescla o signUrl devolvido pelo PAKT com os dados locais (CPF/telefone não vão ao PAKT).
    const signatarios: Signatario[] = entrada.map((s, i) => {
      const remoto = doc.signers?.[i];
      return {
        nome: s.nome!.trim(),
        email: s.email!.trim(),
        cpf: s.cpf?.trim() ?? "",
        telefone: s.telefone?.trim() ?? "",
        papel: (PAPEIS.has(s.papel ?? "") ? s.papel : "SIGNER") as Signatario["papel"],
        orderIndex: i,
        paktSignerId: remoto?.id,
        signUrl: remoto?.signUrl,
        tokenAcesso: remoto?.tokenAcesso,
        status: remoto?.status ?? "PENDING_VIEW",
        signedAt: null,
      };
    });

    const usuario = await prisma.usuario.findUnique({
      where: { id: payload.userId },
      select: { nome: true },
    });

    // Persiste ANTES de qualquer envio: se o /send falhar depois, o documento
    // continua rastreado como DRAFT em vez de sumir da lista.
    const assinatura = await prisma.assinatura.create({
      data: {
        paktDocumentId: doc.id,
        emitenteId: meta.emitenteId,
        nome: nomeDoc,
        status: doc.status ?? "DRAFT",
        mensagem: meta.mensagem?.trim() || null,
        expiresAt: meta.expiresAt ? new Date(meta.expiresAt) : null,
        paktResponse: doc as any,
        arquivoNome: nomeArquivo,
        arquivoTamanho: arquivo.length,
        criadoPorId: payload.userId,
        criadoPorNome: usuario?.nome ?? null,
        tomadorId: meta.tomadorId || null,
        signatarios: signatarios as any,
      },
    });

    // Guarda o original em disco (o PAKT também guarda, mas isso evita depender dele).
    const caminho = join(ASSINATURAS_DIR, "originais", `${assinatura.id}-${sanitizar(nomeDoc)}.pdf`);
    try {
      await writeFile(caminho, arquivo);
      await prisma.assinatura.update({ where: { id: assinatura.id }, data: { arquivoPath: caminho } });
    } catch (e) {
      app.log.warn({ err: e }, "[Assinatura] não foi possível gravar o PDF original");
    }

    return reply.send({
      ok: true,
      id: assinatura.id,
      paktDocumentId: doc.id,
      nome: nomeDoc,
      status: assinatura.status,
      signatarios: signatarios.length,
    });
  });

  // ── Download ───────────────────────────────────────────────────────────────
  app.get("/api/assinatura/:id/download", async (req, reply) => {
    const payload = verifyJwt(req);
    if (!payload) return reply.status(401).send({ error: "Não autorizado" });

    const { id } = req.params as { id: string };
    const tipo = ((req.query as any)?.tipo ?? "original") === "assinado" ? "assinado" : "original";

    const a = await prisma.assinatura.findUnique({ where: { id } });
    if (!a) return reply.status(404).send({ error: "Documento não encontrado" });
    if (!(await podeUsarEmitente(payload, a.emitenteId)))
      return reply.status(403).send({ error: "Acesso negado" });

    const caminho = tipo === "assinado" ? a.arquivoAssinadoPath : a.arquivoPath;
    const nomeSaida = `${sanitizar(a.nome)}${tipo === "assinado" ? "-assinado" : ""}.pdf`;

    if (caminho && existsSync(caminho)) {
      reply.header("Content-Type", "application/pdf");
      reply.header("Content-Disposition", `attachment; filename="${nomeSaida}"`);
      return reply.send(createReadStream(caminho));
    }

    // Sem cópia local: busca no PAKT e guarda para as próximas vezes.
    if (!a.paktDocumentId) return reply.status(404).send({ error: "Arquivo não disponível" });
    let pdf: Buffer;
    try {
      pdf = await paktBaixarPdf(a.paktDocumentId, tipo === "assinado" ? "final" : "original");
    } catch (e) {
      app.log.error({ err: e }, "[Assinatura] download no PAKT falhou");
      return reply.status(404).send({ error: "Arquivo não disponível no PAKT" });
    }

    const destino = join(
      ASSINATURAS_DIR,
      tipo === "assinado" ? "assinados" : "originais",
      `${a.id}-${sanitizar(a.nome)}${tipo === "assinado" ? "-assinado" : ""}.pdf`,
    );
    try {
      await writeFile(destino, pdf);
      await prisma.assinatura.update({
        where: { id: a.id },
        data: tipo === "assinado" ? { arquivoAssinadoPath: destino } : { arquivoPath: destino },
      });
    } catch { /* servir o PDF é o que importa */ }

    reply.header("Content-Type", "application/pdf");
    reply.header("Content-Disposition", `attachment; filename="${nomeSaida}"`);
    return reply.send(pdf);
  });
}
