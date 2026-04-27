import "dotenv/config";
import Fastify, { type FastifyRequest } from "fastify";
import cors                 from "@fastify/cors";
import multipart            from "@fastify/multipart";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { appRouter }        from "./routers/index.js";
import type { Context }     from "./routers/index.js";
import { prisma }           from "./db.js";
import { salvarCertificado, salvarLogo, LOGOS_DIR, certPathForEmpresa } from "./upload.js";
import { createReadStream, existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { writeFile }                               from "node:fs/promises";
import { join, resolve }                           from "node:path";
import { iniciarCron, emitirContratosDoDia, gerarCobrancasDoDia } from "./cron.js";
import { getCronHealthSnapshot } from "./agent/cron-tracker.js";
import { initBankingCron } from "./modules/banking/cron/banking.cron.js";
import { ofxImportService } from "./modules/banking/services/ofx-import.service.js";
import { gerarCartaCobrancaHtml }            from "./lib/cobranca-html.js";
import { getCobrancaConfig }                from "./lib/cobranca-config.js";
import { propostaHtmlPage, autoConverterEmContrato, logoPathToBase64, enviarEmailAceite } from "./routers/propostas.js";
import { renderTemplate }                   from "./lib/template.js";
import { handlePixWebhookCobranca }         from "./lib/pix-webhook.js";
import { gerarBoletoHtml }                  from "./lib/boleto-html.js";
import jwt                  from "jsonwebtoken";
import bcrypt               from "bcryptjs";

const PORT = parseInt(process.env.PORT ?? "8470");

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  credentials: true,
});

// Allow form submissions (browser HTML forms send application/x-www-form-urlencoded)
app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
  done(null, body);
});

await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

// ── tRPC ──────────────────────────────────────────────────────────────────────

await app.register(fastifyTRPCPlugin, {
  prefix: "/trpc",
  trpcOptions: {
    router: appRouter,
    createContext: ({ req }: { req: FastifyRequest }): Context => ({ req }),
  },
});

// ── Upload de certificado ─────────────────────────────────────────────────────

app.post("/api/cert/:empresaId", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { empresaId } = req.params as { empresaId: string };

  const parts = req.parts();
  let fileBuffer: Buffer | null = null;
  let senha = "";

  for await (const part of parts) {
    if (part.type === "file" && part.fieldname === "cert") {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
    } else if (part.type === "field" && part.fieldname === "senha") {
      senha = part.value as string;
    }
  }

  if (!fileBuffer) return reply.status(400).send({ error: "Arquivo não enviado" });

  try {
    const meta = await salvarCertificado(empresaId, fileBuffer, senha);
    return reply.send({ ok: true, nome: meta.nome, validade: meta.validade });
  } catch (err) {
    return reply.status(400).send({ error: err instanceof Error ? err.message : "Erro ao processar certificado" });
  }
});

// ── Upload de logo da empresa ─────────────────────────────────────────────────

app.post("/api/logo/:empresaId", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { empresaId } = req.params as { empresaId: string };
  let fileBuffer: Buffer | null = null;
  let mimetype = "image/jpeg";

  for await (const part of req.parts()) {
    if (part.type === "file" && part.fieldname === "logo") {
      mimetype = part.mimetype;
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
    }
  }
  if (!fileBuffer) return reply.status(400).send({ error: "Arquivo não enviado" });
  try {
    const path = await salvarLogo(empresaId, fileBuffer, mimetype);
    return reply.send({ ok: true, path });
  } catch (err) {
    return reply.status(400).send({ error: err instanceof Error ? err.message : "Erro ao salvar logo" });
  }
});

// ── Servir logo da empresa ────────────────────────────────────────────────────

app.get("/api/logo/:empresaId", async (req, reply) => {
  const { empresaId } = req.params as { empresaId: string };
  for (const ext of ["png", "jpg", "jpeg", "svg"]) {
    const p = join(LOGOS_DIR, `${empresaId}.${ext}`);
    if (existsSync(p)) {
      const ct = ext === "svg" ? "image/svg+xml" : ext === "png" ? "image/png" : "image/jpeg";
      reply.type(ct);
      return reply.send(createReadStream(p));
    }
  }
  return reply.status(404).send({ error: "Logo não encontrada" });
});

// ── Upload de timbrado da empresa ─────────────────────────────────────────────

// ── Consulta CNPJ via ListaCNPJ interno ───────────────────────────────────────

app.get("/api/cnpj-lookup/:cnpj", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { cnpj } = req.params as { cnpj: string };
  const cnpjLimpo = cnpj.replace(/\D/g, "");
  if (cnpjLimpo.length !== 14) return reply.status(400).send({ error: "CNPJ inválido" });

  try {
    const res  = await fetch(`https://www.listascnpj.com.br/api/cnpj/${cnpjLimpo}`);
    if (!res.ok) return reply.status(404).send({ error: "CNPJ não encontrado" });
    const data = await res.json() as any;
    const e    = data.empresa;

    // Mapear natureza jurídica para tipo societário simplificado
    const natureza = e.natureza_desc ?? "";
    let tipoSocietario = "";
    if (/limitada/i.test(natureza))                tipoSocietario = "LTDA";
    else if (/anônima/i.test(natureza))            tipoSocietario = "S.A.";
    else if (/microempreendedor individual/i.test(natureza)) tipoSocietario = "MEI";
    else if (/empresário individual/i.test(natureza))        tipoSocietario = "Empresário Individual";
    else if (/simples/i.test(natureza))            tipoSocietario = "Sociedade Simples";
    else if (/cooperativa/i.test(natureza))        tipoSocietario = "Cooperativa";
    else if (/associação/i.test(natureza))         tipoSocietario = "Associação";
    else if (/fundação/i.test(natureza))           tipoSocietario = "Fundação";

    const logradouro = [e.tipo_logradouro, e.logradouro].filter(Boolean).join(" ");
    const telefone   = e.ddd_1 && e.telefone_1 ? `(${e.ddd_1}) ${e.telefone_1}` : "";

    return reply.send({
      nome:          e.razao_social ?? "",
      nomeFantasia:  e.nome_fantasia ?? "",
      tipoSocietario,
      endereco:      logradouro,
      numero:        e.numero ?? "",
      complemento:   (e.complemento ?? "").trim(),
      bairro:        e.bairro ?? "",
      cidade:        e.municipio_nome ?? "",
      uf:            e.uf ?? "",
      cep:           e.cep ?? "",
      email:         e.correio_eletronico ?? "",
      telefone,
      socios:        (data.socios ?? []).map((s: any) => ({
        nome:         s.nome_socio_razao_social ?? "",
        qualificacao: s.qual_desc ?? "",
        cpf:          s.cpf_cnpj_socio ?? "",
        representante: s.nome_representante ?? "",
      })),
    });
  } catch {
    return reply.status(500).send({ error: "Erro ao consultar CNPJ" });
  }
});

const TIMBRADOS_EMPRESA_DIR = join(LOGOS_DIR, "../timbrados-empresa");
try { mkdirSync(TIMBRADOS_EMPRESA_DIR, { recursive: true }); } catch {}

app.post("/api/empresa/:id/timbrado", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  let fileBuffer: Buffer | null = null;
  let ext = "png";

  for await (const part of req.parts()) {
    if (part.type === "file" && part.fieldname === "timbrado") {
      ext = (part.filename?.split(".").pop()?.toLowerCase()) ?? "png";
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
    }
  }
  if (!fileBuffer) return reply.status(400).send({ error: "Arquivo não enviado" });

  // Remover timbrado anterior desta empresa (qualquer extensão)
  for (const e of ["png", "jpg", "jpeg", "docx"]) {
    const old = join(TIMBRADOS_EMPRESA_DIR, `${id}.${e}`);
    if (existsSync(old)) try { unlinkSync(old); } catch {}
  }

  const timbradoPath = join(TIMBRADOS_EMPRESA_DIR, `${id}.${ext}`);
  await writeFile(timbradoPath, fileBuffer);
  await prisma.empresaEmitente.update({ where: { id }, data: { timbradoPath } as any });

  return reply.send({ ok: true, timbradoPath });
});

app.delete("/api/empresa/:id/timbrado", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  await prisma.empresaEmitente.update({ where: { id }, data: { timbradoPath: null } as any });
  return reply.send({ ok: true });
});

// ── Boleto PDF ────────────────────────────────────────────────────────────────

app.get("/api/cobranca/:id/boleto.pdf", async (req, reply) => {
  const auth  = (req.headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query as Record<string, string>).token ?? "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { id } = req.params as { id: string };
  const cobranca = await prisma.cobranca.findUnique({
    where: { id },
    include: { emitente: true, contrato: { include: { tomador: true } } },
  });
  if (!cobranca) return reply.status(404).send({ error: "Não encontrada" });
  if (!cobranca.boletoNossoNumero) return reply.status(404).send({ error: "Boleto não gerado para esta cobrança" });

  // Carregar logo como base64
  let logoBase64: string | undefined;
  if (cobranca.emitente.logoPath && existsSync(cobranca.emitente.logoPath)) {
    try {
      const buf = readFileSync(cobranca.emitente.logoPath);
      const ext  = cobranca.emitente.logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
      const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
      logoBase64 = `data:${mime};base64,${buf.toString("base64")}`;
    } catch { /* ignora */ }
  }

  // Carregar logo do Sicoob
  let sicoobLogo: string | undefined;
  try {
    const sicoobPath = join(LOGOS_DIR, "sicoob.png");
    if (existsSync(sicoobPath)) {
      sicoobLogo = `data:image/png;base64,${readFileSync(sicoobPath).toString("base64")}`;
    }
  } catch { /* ignora */ }

  const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const html = gerarBoletoHtml({
    beneficiario: {
      nome:            cobranca.emitente.nome,
      cnpj:            cobranca.emitente.cnpj,
      endereco:        cobranca.emitente.endereco    ?? undefined,
      numero:          cobranca.emitente.numero      ?? undefined,
      complemento:     cobranca.emitente.complemento ?? undefined,
      bairro:          cobranca.emitente.bairro      ?? undefined,
      cidade:          cobranca.emitente.cidade      ?? undefined,
      uf:              cobranca.emitente.uf           ?? undefined,
      cep:             cobranca.emitente.cep          ?? undefined,
      cooperativa:     "3226",
      codBeneficiario: cobranca.emitente.boletoNumeroCliente ?? "161756",
      carteira:        cobranca.emitente.boletoModalidade    ?? "1",
      logoBase64,
      sicoobLogo,
    },
    pagador: {
      nome:     cobranca.contrato.tomador.nome,
      cpfCnpj:  cobranca.contrato.tomador.cpfCnpj,
      endereco: cobranca.contrato.tomador.endereco ?? undefined,
      cidade:   cobranca.contrato.tomador.cidade   ?? undefined,
      uf:       cobranca.contrato.tomador.uf        ?? undefined,
      cep:      cobranca.contrato.tomador.cep       ?? undefined,
    },
    nossoNumero:       cobranca.boletoNossoNumero,
    linhaDigitavel:    cobranca.boletoLinhaDigitavel ?? "",
    codigoBarras:      cobranca.boletoCodigoBarras   ?? "",
    valor:             cobranca.valor,
    vencimento:        cobranca.vencimento,
    dataEmissao:       cobranca.criadoEm.toISOString().slice(0, 10),
    dataProcessamento: today,
    nroDocumento:      cobranca.id.slice(-10).toUpperCase(),
    instrucoes: [
      `Ref.: ${cobranca.contrato.nomeServico || "Serviços prestados"} — ${cobranca.competencia}`,
      "Multa de 2% + juros de 0,033% ao dia após o vencimento.",
      "Não receber após 30 dias do vencimento.",
    ],
  });

  reply.header("Content-Type", "text/html; charset=utf-8");
  return reply.send(html);
});

// ── Nota de Honorários HTML ───────────────────────────────────────────────────

app.get("/api/cobranca/:id/html", async (req, reply) => {
  const auth  = (req.headers.authorization ?? "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query as Record<string, string>).token ?? "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { id } = req.params as { id: string };
  const cobranca = await prisma.cobranca.findUnique({
    where: { id },
    include: {
      emitente: true,
      contrato: { include: { tomador: true } },
    },
  });
  if (!cobranca) return reply.status(404).send({ error: "Não encontrada" });

  // Buscar NFS-e emitida para o mesmo contrato e competência
  const notaFiscal = await prisma.notaFiscal.findFirst({
    where: {
      contratoId:  cobranca.contratoId,
      competencia: cobranca.competencia,
      status:      "EMITIDA",
    },
    orderBy: { emitidoEm: "desc" },
  });

  // Carregar logo da empresa como base64
  let logoBase64: string | undefined;
  if (cobranca.emitente.logoPath && existsSync(cobranca.emitente.logoPath)) {
    try {
      const buf = readFileSync(cobranca.emitente.logoPath);
      const ext = cobranca.emitente.logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
      const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
      logoBase64 = `data:${mime};base64,${buf.toString("base64")}`;
    } catch { /* ignora */ }
  }

  const vars  = {
    competencia: cobranca.competencia,
    vencimento:  cobranca.vencimento,
    valor:       cobranca.valor,
    emitente:    cobranca.emitente.nomeFantasia || cobranca.emitente.nome,
    tomador:     cobranca.contrato.tomador.nome,
    servico:     cobranca.contrato.nomeServico ?? undefined,
  };

  const html = gerarCartaCobrancaHtml({
    emitente: {
      nome:         cobranca.emitente.nome,
      nomeFantasia: cobranca.emitente.nomeFantasia ?? undefined,
      cnpj:         cobranca.emitente.cnpj,
      endereco:     cobranca.emitente.endereco    ?? undefined,
      numero:       cobranca.emitente.numero      ?? undefined,
      complemento:  cobranca.emitente.complemento ?? undefined,
      bairro:       cobranca.emitente.bairro      ?? undefined,
      cidade:       cobranca.emitente.cidade      ?? undefined,
      uf:           cobranca.emitente.uf           ?? undefined,
      cep:          cobranca.emitente.cep          ?? undefined,
      email:        cobranca.emitente.email        ?? undefined,
      telefone:     cobranca.emitente.telefone     ?? undefined,
      logoBase64,
    },
    tomador: {
      nome:     cobranca.contrato.tomador.nome,
      cpfCnpj:  cobranca.contrato.tomador.cpfCnpj,
      endereco: cobranca.contrato.tomador.endereco ?? undefined,
      cidade:   cobranca.contrato.tomador.cidade   ?? undefined,
      uf:       cobranca.contrato.tomador.uf        ?? undefined,
      email:    cobranca.contrato.tomador.email     ?? undefined,
    },
    nomeServico:   cobranca.contrato.nomeServico ?? undefined,
    discriminacao: renderTemplate(cobranca.contrato.descricaoServico, vars),
    observacao:    cobranca.contrato.observacoes
      ? renderTemplate(cobranca.contrato.observacoes, vars)
      : undefined,
    competencia: cobranca.competencia,
    vencimento:  cobranca.vencimento,
    valor:       cobranca.valor,
    pixBrcode:    cobranca.pixBrcode    ?? undefined,
    pixQrcode:    cobranca.pixQrcode    ?? undefined,
    pixExpiresAt: cobranca.pixExpiresAt ?? undefined,
    boletoLinhaDigitavel: cobranca.boletoLinhaDigitavel ?? undefined,
    boletoCodigoBarras:   cobranca.boletoCodigoBarras   ?? undefined,
    boletoPdfEndpoint: cobranca.boletoUrlPdf
      ? `/api/cobranca/${cobranca.id}/boleto.pdf?token=${token}`
      : undefined,
    nfse: notaFiscal ? {
      numero:      notaFiscal.numero!,
      emitidoEm:   notaFiscal.emitidoEm,
      codigoVerif: notaFiscal.codigoVerif,
      linkNfse:    notaFiscal.linkNfse,
    } : undefined,
  });

  reply.header("Content-Type", "text/html; charset=utf-8");
  return reply.send(html);
});

// ── PIX Webhook — Sicoob notifica quando cobrança é paga ─────────────────────
// URL a registrar no Sicoob: https://nfse.capium.com.br/api/pix/webhook
// O Sicoob faz mTLS de saída; este endpoint é público (sem auth header)
// mas só atualiza txids conhecidos no banco.

app.post("/api/pix/webhook", async (req, reply) => {
  try {
    const body = req.body as { pix?: unknown[] };
    if (!body?.pix?.length) return reply.send({ ok: true });
    await handlePixWebhookCobranca(body as any);
    return reply.send({ ok: true });
  } catch (err) {
    app.log.error({ err }, "[PIX-Webhook] Erro");
    return reply.status(500).send({ error: "Internal error" });
  }
});

// ── Aceite público de proposta (sem auth) ─────────────────────────────────────

app.get("/api/proposta/:token", async (req, reply) => {
  const { token } = req.params as { token: string };
  const p = await prisma.proposta.findUnique({
    where: { tokenAceite: token },
    include: {
      emitente: { select: {
        id: true, nome: true, nomeFantasia: true, cnpj: true,
        cidade: true, uf: true, endereco: true, numero: true,
        complemento: true, bairro: true, cep: true,
        telefone: true, email: true,
      }},
      tomador:  { select: { nome: true, email: true } },
    },
  });
  if (!p) return reply.status(404).send({ error: "Proposta não encontrada" });

  const baseUrl = process.env.APP_BASE_URL ?? "https://avoce.com.br";
  const html = propostaHtmlPage(p.titulo, p.textoHtml, {
    ...p.emitente,
    logoSrc: `${baseUrl}/api/logo/${p.emitente.id}`,
  }, p.validadeAte, { nome: p.tomador.nome });

  // Injetar botão de aceite se ainda não aceita
  const aceiteBtn = p.status === "ACEITA"
    ? `<div style="background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:16px 24px;margin:24px 32px;font-family:Arial,sans-serif;font-size:14px;color:#065f46">
        ✅ <strong>Proposta aceita em ${p.aceitoEm ? new Date(p.aceitoEm).toLocaleString("pt-BR") : "—"}</strong>
       </div>`
    : (() => {
        // Só usar PAKT quando a proposta NÃO tem documentos para gerar (contrato/procuração)
        // Se tem templatesGerar, o contrato/procuração assume o papel da assinatura
        let temDocs = false;
        try { temDocs = JSON.parse((p as any).templatesGerar ?? "[]").length > 0; } catch {}
        const usarPakt = p.paktSignUrl && !temDocs;
        return `<div style="text-align:center;padding:24px 32px;font-family:Arial,sans-serif">
        ${usarPakt
          ? `<a href="${p.paktSignUrl}" target="_blank" style="display:inline-block;background:#004a5c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:bold">✍️ Assinar digitalmente via PAKT</a>`
          : `<form method="POST" action="/api/proposta/${token}/aceitar">
               <button type="submit" style="background:#16a34a;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:bold;cursor:pointer">✅ Aceitar esta Proposta</button>
             </form>`}
       </div>`;
      })();

  const finalHtml = html.replace("</div>\n</body>", `${aceiteBtn}</div>\n</body>`);
  reply.header("Content-Type", "text/html; charset=utf-8");
  return reply.send(finalHtml);
});

app.post("/api/proposta/:token/aceitar", async (req, reply) => {
  const { token } = req.params as { token: string };
  const p = await prisma.proposta.findUnique({ where: { tokenAceite: token } });
  if (!p) return reply.status(404).send("Proposta não encontrada");
  if (p.status === "ACEITA") return reply.redirect(`/api/proposta/${token}`);

  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    ?? req.socket.remoteAddress ?? "desconhecido";

  await prisma.proposta.update({
    where: { id: p.id },
    data:  { status: "ACEITA", aceitoEm: new Date(), aceitoIp: ip },
  });

  // Executar em sequência (fire-and-forget): contrato → e-mail confirmação
  // (documentos já foram gerados no momento do envio da proposta)
  ;(async () => {
    try { await autoConverterEmContrato(p.id); } catch (e) { app.log.error({ err: e }, "[Aceite-Manual] Falha na auto-conversão"); }
    try { await enviarEmailAceite(p.id);       } catch (e) { app.log.error({ err: e }, "[Aceite-Manual] Falha ao enviar e-mail de aceite"); }
  })();

  reply.header("Content-Type", "text/html; charset=utf-8");
  return reply.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=/api/proposta/${token}"></head>
<body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:Arial;background:#f0fdf4">
<div style="text-align:center"><div style="font-size:48px">✅</div>
<h2 style="color:#16a34a">Proposta aceita com sucesso!</h2>
<p style="color:#555">Você será redirecionado em instantes...</p></div></body></html>`);
});

// ── Webhook PAKT — recebe eventos de assinatura ───────────────────────────────

app.post("/api/pakt-webhook", {
  config: { rawBody: true },
}, async (req, reply) => {
  const webhookSecret = process.env.PAKT_WEBHOOK_SECRET;

  // Verificar assinatura HMAC se o secret estiver configurado
  if (webhookSecret) {
    const { createHmac } = await import("node:crypto");
    const sig      = (req.headers["x-pakt-signature"] as string) ?? "";
    const body     = (req as any).rawBody ?? JSON.stringify(req.body);
    const expected = "sha256=" + createHmac("sha256", webhookSecret).update(body).digest("hex");
    if (sig !== expected) {
      app.log.warn("[PAKT-Webhook] Assinatura inválida");
      return reply.status(401).send({ error: "Invalid signature" });
    }
  }

  const payload = req.body as { event: string; documentId: string; data: any };
  app.log.info({ event: payload.event, documentId: payload.documentId }, "[PAKT-Webhook] Evento recebido");

  try {
    if (payload.event === "document.completed") {
      const { documentId, data } = payload;

      // Encontrar proposta pelo paktDocumentId (pode ser ID simples ou JSON array)
      const proposta = await prisma.proposta.findFirst({
        where: { paktDocumentId: { contains: documentId } } as any,
      });

      if (proposta && proposta.status !== "ACEITA") {
        const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
          ?? req.socket.remoteAddress ?? "pakt-webhook";

        // Baixar PDF assinado do PAKT
        let paktSignedPdfPath: string | null = null;
        try {
          const paktApiKey  = process.env.PAKT_API_KEY;
          const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
          if (paktApiKey) {
            const pdfRes = await fetch(`${paktBaseUrl}/api/v1/documents/${documentId}/download?type=final`, {
              headers: { Authorization: `Bearer ${paktApiKey}` },
            });
            if (pdfRes.ok) {
              const pdfDir = resolve("./uploads/propostas-signed");
              mkdirSync(pdfDir, { recursive: true });
              const pdfPath = join(pdfDir, `${proposta.id}.pdf`);
              await writeFile(pdfPath, Buffer.from(await pdfRes.arrayBuffer()));
              paktSignedPdfPath = pdfPath;
              app.log.info(`[PAKT-Webhook] PDF assinado salvo em ${pdfPath}`);
            } else {
              app.log.warn(`[PAKT-Webhook] Falha ao baixar PDF: ${pdfRes.status}`);
            }
          }
        } catch (e) {
          app.log.error({ err: e }, "[PAKT-Webhook] Erro ao baixar PDF assinado");
        }

        await prisma.proposta.update({
          where: { id: proposta.id },
          data:  {
            status:   "ACEITA",
            aceitoEm: new Date(),
            aceitoIp: `pakt:${ip}`,
            ...(paktSignedPdfPath ? { paktSignedPdfPath } as any : {}),
          },
        });

        app.log.info(`[PAKT-Webhook] Proposta ${proposta.id} marcada como ACEITA via PAKT doc ${documentId}`);

        // Executar em sequência: contrato → e-mail confirmação
        // (documentos já foram gerados no momento do envio da proposta)
        ;(async () => {
          try { await autoConverterEmContrato(proposta.id); } catch (e) { app.log.error({ err: e }, "[PAKT-Webhook] Falha na auto-conversão"); }
          try { await enviarEmailAceite(proposta.id);       } catch (e) { app.log.error({ err: e }, "[PAKT-Webhook] Falha ao enviar e-mail de aceite"); }
        })();

        // Notificar SDR via WhatsApp
        ;(async () => {
          try {
            const projetoConfig = await prisma.iaProjetoConfig.findFirst({
              where: { chave: "proposta_emitente_id", valor: proposta.emitenteId, categoria: "proposta" },
            });
            if (!projetoConfig) return;
            const tomador = await prisma.tomador.findUnique({ where: { id: proposta.tomadorId } });
            const contato = tomador?.cpfCnpj
              ? await prisma.crmContato.findFirst({ where: { cpf: tomador.cpfCnpj } })
              : null;
            const { dispararNotificacoes } = await import("./agent/stage-engine.js");
            await dispararNotificacoes(projetoConfig.projetoId, "proposta_aceita", {
              nome:     tomador?.nome ?? "",
              telefone: contato?.whatsapp ?? tomador?.telefone ?? "",
              valor:    proposta.valorEstimado
                ? `R$ ${(proposta.valorEstimado / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`
                : "",
              cpf: tomador?.cpfCnpj ?? "",
            });
          } catch (e) { app.log.error({ err: e }, "[PAKT-Webhook] Falha na notificação SDR"); }
        })();
      }
    }

    if (payload.event === "signer.signed") {
      app.log.info(`[PAKT-Webhook] Signatário assinou doc ${payload.documentId}`);
      // Nenhuma ação adicional por enquanto — o document.completed já finaliza
    }
  } catch (e) {
    app.log.error({ err: e }, "[PAKT-Webhook] Erro ao processar evento");
  }

  return reply.send({ ok: true });
});

// ── Download PDF assinado da proposta ────────────────────────────────────────

app.get("/api/proposta/:id/pdf-assinado", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { id } = req.params as { id: string };
  const proposta = await prisma.proposta.findUnique({ where: { id } }) as any;
  if (!proposta) return reply.status(404).send({ error: "Proposta não encontrada" });
  if (!proposta.paktSignedPdfPath || !existsSync(proposta.paktSignedPdfPath)) {
    return reply.status(404).send({ error: "PDF assinado não disponível" });
  }

  const titulo = (proposta.titulo as string).replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-");
  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `attachment; filename="Proposta-Assinada-${titulo}.pdf"`);
  return reply.send(createReadStream(proposta.paktSignedPdfPath));
});

// ── Download de documento gerado (contrato/procuração) ───────────────────────

app.get("/api/documento-gerado/:id/pdf", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { id } = req.params as { id: string };
  const doc = await (prisma as any).documentoGerado.findUnique({ where: { id } });
  if (!doc) return reply.status(404).send({ error: "Documento não encontrado" });
  if (!doc.pdfPath || !existsSync(doc.pdfPath)) {
    return reply.status(404).send({ error: "PDF não disponível" });
  }

  const nome = (doc.titulo as string).replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-");
  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `attachment; filename="${doc.tipo}-${nome}.pdf"`);
  return reply.send(createReadStream(doc.pdfPath));
});

app.get("/api/documento-gerado/:id/docx", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  const { id } = req.params as { id: string };
  const doc = await (prisma as any).documentoGerado.findUnique({ where: { id } });
  if (!doc) return reply.status(404).send({ error: "Documento não encontrado" });
  if (!(doc as any).docxPath || !existsSync((doc as any).docxPath)) {
    return reply.status(404).send({ error: "DOCX não disponível" });
  }

  const nome = (doc.titulo as string).replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-");
  reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  reply.header("Content-Disposition", `attachment; filename="${doc.tipo}-${nome}.docx"`);
  return reply.send(createReadStream((doc as any).docxPath));
});

// ── Upload de timbrado para template de documento ────────────────────────────

const TIMBRADOS_DIR = join(LOGOS_DIR, "../timbrados");
try { mkdirSync(TIMBRADOS_DIR, { recursive: true }); } catch {}

app.post("/api/template-documento/:id/timbrado", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  let fileBuffer: Buffer | null = null;
  let ext = "png";

  for await (const part of req.parts()) {
    if (part.type === "file" && part.fieldname === "timbrado") {
      ext = (part.filename?.split(".").pop()?.toLowerCase()) ?? "png";
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
    }
  }

  if (!fileBuffer) return reply.status(400).send({ error: "Arquivo não enviado" });

  // Remover timbrado anterior (qualquer extensão)
  for (const e of ["png", "jpg", "jpeg", "docx"]) {
    const old = join(TIMBRADOS_DIR, `${id}.${e}`);
    if (existsSync(old)) try { unlinkSync(old); } catch {}
  }

  const cabecalhoPath = join(TIMBRADOS_DIR, `${id}.${ext}`);
  await writeFile(cabecalhoPath, fileBuffer);

  await (prisma as any).templateDocumento.update({ where: { id }, data: { cabecalhoPath } });

  return reply.send({ ok: true, cabecalhoPath });
});

app.delete("/api/template-documento/:id/timbrado", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  await (prisma as any).templateDocumento.update({ where: { id }, data: { cabecalhoPath: null } });
  return reply.send({ ok: true });
});

// ── Preview PDF de template (dados fictícios) ─────────────────────────────────

app.get("/api/template-documento/:id/preview.pdf", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query as any).token ?? "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  const template = await (prisma as any).templateDocumento.findUnique({
    where: { id },
    include: { emitente: true },
  });
  if (!template) return reply.status(404).send({ error: "Template não encontrado" });

  const { buildVars, renderTemplateDoc, documentoHtmlPage, generateFromDocxTemplate } = await import("./routers/templateDocumentos.js");
  const { htmlToPdf } = await import("./lib/pdf.js");

  const emitente = template.emitente;
  const fakeTomador = {
    nome: "CLIENTE EXEMPLO DA SILVA",
    cpfCnpj: "000.000.000-00",
    email: "cliente@exemplo.com.br",
    telefone: "(11) 99999-9999",
    endereco: "Rua das Flores",
    numero: "123",
    complemento: "Sala 1",
    bairro: "Centro",
    cidade: emitente.cidade ?? "Cidade",
    uf: emitente.uf ?? "UF",
    cep: "00000-000",
  };
  const fakeContrato = { valorEstimado: 1500, contratoDiaVencimento: 10, contratoMetodoCobr: "PIX" };

  const vars = buildVars(emitente, fakeTomador, fakeContrato);

  const timbrado = template.cabecalhoPath && existsSync(template.cabecalhoPath)
    ? template.cabecalhoPath
    : (emitente.timbradoPath && existsSync(emitente.timbradoPath) ? emitente.timbradoPath : null);

  let pdfBuffer: Buffer;
  if (timbrado?.toLowerCase().endsWith(".docx")) {
    const tmpDir = join(resolve("./uploads/documentos-gerados"), "preview");
    mkdirSync(tmpDir, { recursive: true });
    const docxOut = join(tmpDir, `${id}-preview.docx`);
    const pdfOut  = join(tmpDir, `${id}-preview.pdf`);
    await generateFromDocxTemplate(timbrado, template.titulo, template.textoHtml, vars, docxOut, pdfOut);
    pdfBuffer = await import("node:fs/promises").then(m => m.readFile(pdfOut));
  } else {
    const { logoPathToBase64 } = await import("./routers/propostas.js");
    const html = renderTemplateDoc(template.textoHtml, vars);
    const page = documentoHtmlPage(template.titulo, html, { ...emitente, logoSrc: logoPathToBase64(emitente.logoPath) }, timbrado);
    pdfBuffer = await htmlToPdf(page);
  }

  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `inline; filename="preview-${template.titulo}.pdf"`);
  return reply.send(pdfBuffer);
});

// ── Upload de contrato assinado (PDF) ─────────────────────────────────────────

const CONTRATOS_DIR = join(LOGOS_DIR, "../contratos");
try { mkdirSync(CONTRATOS_DIR, { recursive: true }); } catch {}

app.post("/api/contrato/:id/upload-assinado", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  let fileBuffer: Buffer | null = null;
  let filename = "contrato.pdf";

  for await (const part of req.parts()) {
    if (part.type === "file" && part.fieldname === "pdf") {
      filename = part.filename || "contrato.pdf";
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
    }
  }

  if (!fileBuffer) return reply.status(400).send({ error: "Arquivo não enviado" });
  if (!filename.toLowerCase().endsWith(".pdf"))
    return reply.status(400).send({ error: "Apenas arquivos PDF são aceitos" });

  const safeName = `${id}-${Date.now()}.pdf`;
  const filePath = join(CONTRATOS_DIR, safeName);
  await writeFile(filePath, fileBuffer);

  await prisma.contrato.update({
    where: { id },
    data: {
      contratoAssinadoPath: filePath,
      contratoAssinadoNome: filename,
      contratoAssinadoEm:   new Date(),
    },
  });

  return reply.send({ ok: true, nome: filename });
});

// ── Download de contrato assinado ─────────────────────────────────────────────

app.get("/api/contrato/:id/assinado.pdf", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : (req.query as any).token ?? "";
  try { jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret"); }
  catch { return reply.status(401).send({ error: "Não autorizado" }); }

  const { id } = req.params as { id: string };
  const contrato = await prisma.contrato.findUnique({ where: { id } });
  if (!contrato || !contrato.contratoAssinadoPath)
    return reply.status(404).send({ error: "Contrato assinado não encontrado" });
  if (!existsSync(contrato.contratoAssinadoPath))
    return reply.status(404).send({ error: "Arquivo não encontrado no servidor" });

  reply.header("Content-Type", "application/pdf");
  reply.header("Content-Disposition", `inline; filename="${contrato.contratoAssinadoNome ?? "contrato.pdf"}"`);
  return reply.send(createReadStream(contrato.contratoAssinadoPath));
});

// ── WhatsApp Webhook — Evolution API ─────────────────────────────────────────
// Handles Evolution API v1.x and v2.x payload formats

app.post("/api/whatsapp/webhook", async (req, reply) => {
  const body = req.body as any;

  // Log raw payload for debugging (first 500 chars)
  const rawPreview = JSON.stringify(body).slice(0, 500);
  app.log.info(`[WA-Webhook] Payload: ${rawPreview}`);

  // Determine event type
  const event: string = body?.event ?? body?.type ?? "";

  // Only process message events
  if (!event.includes("messages")) {
    return reply.send({ ok: true });
  }

  // Extract instance name (v1: body.instance, v2: body.data.instance or body.instance)
  const instanceName: string =
    body?.instance ??
    body?.data?.instance ??
    body?.data?.key?.remoteJid?.split("@")[0] ??
    "";

  // Find project by instance name
  const config = await prisma.iaProjetoConfig.findFirst({
    where: { chave: "evolution_instancia", valor: instanceName },
  });

  if (!config?.projetoId) {
    // Try to find by any active project (single-project mode)
    const anyConfig = await prisma.iaProjetoConfig.findFirst({
      where: { chave: "evolution_instancia" },
    });
    if (!anyConfig?.projetoId) {
      app.log.warn(`[WA-Webhook] Instância desconhecida: "${instanceName}". Configure em Config IA.`);
      return reply.send({ ok: true });
    }
    const { projetoId } = anyConfig;
    await processMessages(body, projetoId, app);
    return reply.send({ ok: true });
  }

  await processMessages(body, config.projetoId, app);
  return reply.send({ ok: true });
});

// In-memory dedup: ignore duplicate webhook calls for the same message ID (5-min TTL)
const _processedMsgIds = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, ts] of _processedMsgIds) {
    if (ts < cutoff) _processedMsgIds.delete(id);
  }
}, 5 * 60 * 1000).unref();

// Per-phone debounce: accumulates rapid-fire messages and processes them after a quiet window.
// All messages in the window are saved to DB; only the LAST triggers the LLM response.
// This prevents double responses when the lead breaks a message into two parts.
//
// Processing mutex (_phoneProcessingPromise): if new messages arrive while an LLM call is in
// flight for this phone, they wait for the current call to finish before firing. This prevents
// concurrent LLM calls for the same conversation when Evolution API delivers webhooks with delay.
const DEBOUNCE_MS = 15000; // 15-second quiet window — carreteiros type slowly on mobile
const _phoneDebounce = new Map<string, { timer: ReturnType<typeof setTimeout>; msgs: any[]; projetoId: string }>();
const _phoneProcessingPromise = new Map<string, Promise<void>>();

function debounceForPhone(
  phone: string,
  msg: any,
  projetoId: string,
  processIncomingMessage: (pid: string, m: any, saveOnly?: boolean) => Promise<void>,
  app: any
): void {
  const existing = _phoneDebounce.get(phone);
  if (existing) {
    clearTimeout(existing.timer);
    existing.msgs.push(msg);   // accumulate ALL messages
    existing.projetoId = projetoId;
  } else {
    _phoneDebounce.set(phone, { msgs: [msg], projetoId, timer: null! });
  }

  const entry = _phoneDebounce.get(phone)!;
  entry.timer = setTimeout(async () => {
    const { msgs, projetoId: pid } = entry;
    _phoneDebounce.delete(phone);

    // Wait for any ongoing LLM processing for this phone before sending a new response.
    // This handles the case where Evolution API delivers webhooks with delays — messages
    // that arrive while the LLM is running will correctly wait and then re-check for new batches.
    const ongoingProcessing = _phoneProcessingPromise.get(phone);
    if (ongoingProcessing) {
      try { await ongoingProcessing; } catch { /* ignore — errors are handled inside */ }
    }

    // After waiting for ongoing processing, check if newer messages arrived in the meantime.
    // If so, save this batch to DB only and let the pending batch send the response — this
    // avoids a response for a "stale" batch after a more recent one has already queued up.
    const hasPendingBatch = _phoneDebounce.has(phone);

    const p: Promise<void> = (async () => {
      if (hasPendingBatch) {
        // Save all messages to DB so the pending batch sees full history
        for (const m of msgs) {
          try { await processIncomingMessage(pid, m, true); } catch (err) {
            app.log.warn({ err }, `[WA-Webhook] Erro ao salvar msg de ${phone}`);
          }
        }
        app.log.info(`[WA-Webhook] Lote de ${msgs.length} msg(s) de ${phone} salvo sem resposta — lote mais recente pendente`);
        return;
      }

      // Save intermediate messages to DB (no LLM call) so the final processing sees full history
      for (let i = 0; i < msgs.length - 1; i++) {
        try {
          await processIncomingMessage(pid, msgs[i], true /* saveOnly */);
        } catch (err) {
          app.log.warn({ err }, `[WA-Webhook] Erro ao salvar msg intermediária de ${phone}`);
        }
      }

      // Process only the last message (triggers LLM with full accumulated history)
      try {
        await processIncomingMessage(pid, msgs[msgs.length - 1]);
      } catch (err) {
        app.log.error({ err }, `[WA-Webhook] Erro ao processar mensagem de ${phone}`);
      }
    })();

    _phoneProcessingPromise.set(phone, p);
    try { await p; } finally { _phoneProcessingPromise.delete(phone); }
  }, DEBOUNCE_MS);
}

async function processMessages(body: any, projetoId: string, app: any) {
  const projeto = await prisma.iaProjeto.findUnique({ where: { id: projetoId } });
  if (!projeto?.ativo) return;

  const data = body?.data ?? body;

  // Evolution v1: data.messages is an array
  // Evolution v2: data is the message itself OR data.message exists
  let messages: any[] = [];

  if (Array.isArray(data?.messages)) {
    messages = data.messages;
  } else if (Array.isArray(data)) {
    messages = data;
  } else if (data?.key) {
    messages = [data];
  } else {
    messages = [data];
  }

  const { processIncomingMessage } = await import("./agent/stage-engine.js");

  for (const msg of messages) {
    if (!msg?.key?.remoteJid) continue;
    if (msg.key.fromMe) continue;
    // Skip status broadcasts
    if (msg.key.remoteJid === "status@broadcast") continue;

    // Dedup: skip if this message ID was already processed recently.
    // When key.id is missing, synthesize a stable ID from phone + content hash
    // so that two identical webhook fires in different workers still deduplicate.
    const phone = (msg.key.remoteJid as string).replace(/@.*/, "");
    let msgId = msg.key?.id as string | undefined;
    if (!msgId) {
      const content = JSON.stringify(msg.message ?? msg.body ?? "");
      const crypto = await import("node:crypto");
      msgId = `syn_${phone}_${crypto.createHash("md5").update(content).digest("hex").slice(0, 12)}`;
      msg.key.id = msgId;
    }
    if (_processedMsgIds.has(msgId)) {
      app.log.warn(`[WA-Webhook] Dedup: mensagem ${msgId} já processada, ignorando`);
      continue;
    }
    _processedMsgIds.set(msgId, Date.now());

    debounceForPhone(phone, msg, projetoId, processIncomingMessage, app);
  }
}

// ── Endpoint para disparar emissão manual do dia (admin) ──────────────────────

app.post("/api/cron/executar", async (req, reply) => {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
  } catch {
    return reply.status(401).send({ error: "Não autorizado" });
  }

  emitirContratosDoDia().catch(console.error);
  gerarCobrancasDoDia().catch(console.error);
  return reply.send({ ok: true, message: "Execução iniciada em background" });
});

// ── Agent health check (Sprint 4) ────────────────────────────────────────────

app.get("/api/agent/health", async (_req, reply) => {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since30m = new Date(now.getTime() - 30 * 60 * 1000);
  const since5m  = new Date(now.getTime() -  5 * 60 * 1000);

  // ── LLM health ────────────────────────────────────────────────────────────
  const [totalCalls24h, errCalls24h, logsByProvider] = await Promise.all([
    prisma.iaInteracaoLog.count({ where: { criadoEm: { gte: since24h } } }),
    prisma.iaInteracaoLog.count({ where: { criadoEm: { gte: since24h }, erro: { not: null } } }),
    prisma.iaInteracaoLog.groupBy({
      by: ["llmUsado"],
      where: { criadoEm: { gte: since24h }, llmUsado: { not: null } },
      _count: { _all: true },
      _sum: { tokensSaida: true },
    }),
  ]);

  const errRate = totalCalls24h > 0 ? errCalls24h / totalCalls24h : 0;
  const providers_status = logsByProvider.map((row: any) => ({
    provider: row.llmUsado as string,
    calls: row._count._all,
    status: "ok" as const,
  }));

  // ── Deals anômalos ────────────────────────────────────────────────────────
  // handoff_atrasado_30min: iaPersonaChave=advogado, last out msg é da assistente, >30min
  const dealsAdvogado = await prisma.crmDeal.findMany({
    where: { iaPersonaChave: "advogado", iaAtiva: true, status: "aberto" },
    select: { id: true },
  });
  let handoffAtrasado30m = 0;
  if (dealsAdvogado.length > 0) {
    const dealIds = dealsAdvogado.map((d: any) => d.id);
    const ultimasMsgs = await prisma.crmMensagemWhatsapp.findMany({
      where: { dealId: { in: dealIds }, direcao: "out" },
      orderBy: { enviadaEm: "desc" },
      distinct: ["dealId"],
      select: { dealId: true, enviadaEm: true, personaChave: true },
    });
    handoffAtrasado30m = ultimasMsgs.filter(
      (m: any) => m.personaChave === "assistente" && m.enviadaEm < since30m
    ).length;
  }

  // cliente_sem_resposta_5min: last msg = "in", older than 5 min
  const STAGES_HUMANOS = ["com_advogado", "reuniao_agendada", "fechado", "sem_resposta_closer", "lead_sem_resposta"];
  const dealsAtivosIds = await prisma.crmDeal.findMany({
    where: { iaAtiva: true, status: "aberto", iaStageChave: { notIn: STAGES_HUMANOS } },
    select: { id: true },
  });
  let clienteSemResposta5m = 0;
  if (dealsAtivosIds.length > 0) {
    const ids = dealsAtivosIds.map((d: any) => d.id);
    const ultimas = await prisma.crmMensagemWhatsapp.findMany({
      where: { dealId: { in: ids } },
      orderBy: { enviadaEm: "desc" },
      distinct: ["dealId"],
      select: { dealId: true, enviadaEm: true, direcao: true },
    });
    clienteSemResposta5m = ultimas.filter(
      (m: any) => m.direcao === "in" && m.enviadaEm < since5m && m.enviadaEm > since24h
    ).length;
  }

  // bloqueados_intervencao_humana
  const bloqueados = await prisma.crmDeal.count({
    where: {
      iaAtiva: true,
      status: "aberto",
      qualificacao: { path: ["_requer_intervencao_humana"], equals: true },
    },
  }).catch(() => 0);

  // em_loop_repeticao: 3+ blocked sends no mesmo deal nas últimas 24h
  const loopGroups = await prisma.iaInteracaoLog.groupBy({
    by: ["dealId"],
    where: { criadoEm: { gte: since24h }, erro: { contains: "BLOCKED" }, dealId: { not: null } },
    _count: { _all: true },
  }).catch(() => [] as any[]);
  const loopCandidates = (loopGroups as any[]).filter((r: any) => r._count._all >= 3);

  // prompt leaks e identity questions
  const [promptLeaks24h, identityQuestions24h] = await Promise.all([
    prisma.iaInteracaoLog.count({ where: { criadoEm: { gte: since24h }, erro: { contains: "BLOCKED" } } }),
    (prisma as any).iaEventoIdentidade?.count({ where: { criadoEm: { gte: since24h } } }).catch(() => 0) ?? 0,
  ]);

  return reply.send({
    timestamp: now.toISOString(),
    llm_health: {
      last_24h_calls: totalCalls24h,
      last_24h_errors: errCalls24h,
      error_rate: Math.round(errRate * 1000) / 1000,
      providers_status,
    },
    cron_health: getCronHealthSnapshot(),
    deals_anomalos: {
      handoff_atrasado_30min: handoffAtrasado30m,
      cliente_sem_resposta_5min: clienteSemResposta5m,
      bloqueados_intervencao_humana: bloqueados,
      em_loop_repeticao: loopCandidates.length,
    },
    prompt_leaks_24h: promptLeaks24h,
    identity_questions_24h: identityQuestions24h,
  });
});

// ── Admin agent dashboard (Sprint 4) ─────────────────────────────────────────

app.get("/admin/agent-dashboard", async (_req, reply) => {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Fetch health data
  const [totalCalls24h, errCalls24h, promptLeaks24h] = await Promise.all([
    prisma.iaInteracaoLog.count({ where: { criadoEm: { gte: since24h } } }),
    prisma.iaInteracaoLog.count({ where: { criadoEm: { gte: since24h }, erro: { not: null } } }),
    prisma.iaInteracaoLog.count({ where: { criadoEm: { gte: since24h }, erro: { contains: "BLOCKED" } } }),
  ]);

  const cronHealth = getCronHealthSnapshot();

  // Deals anomalos
  const dealsAdvogado = await prisma.crmDeal.findMany({
    where: { iaPersonaChave: "advogado", iaAtiva: true, status: "aberto" },
    include: { contato: { select: { nome: true, whatsapp: true } } },
  });
  const since30m = new Date(now.getTime() - 30 * 60 * 1000);
  const handoffAtrasados: typeof dealsAdvogado = [];
  for (const d of dealsAdvogado) {
    const lastOut = await prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId: d.id, direcao: "out" },
      orderBy: { enviadaEm: "desc" },
      select: { enviadaEm: true, personaChave: true },
    });
    if (lastOut?.personaChave === "assistente" && lastOut.enviadaEm < since30m) {
      handoffAtrasados.push(d);
    }
  }

  // Últimas 10 entradas prompt_leak_blocked
  const leakLogs = await prisma.iaInteracaoLog.findMany({
    where: { criadoEm: { gte: since24h }, erro: { contains: "BLOCKED" } },
    orderBy: { criadoEm: "desc" },
    take: 10,
    select: { id: true, dealId: true, criadoEm: true, erro: true, personaChave: true, stageChave: true },
  });

  const fmt = (d: Date | null) => d ? d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "—";
  const errRate = totalCalls24h > 0 ? ((errCalls24h / totalCalls24h) * 100).toFixed(1) : "0.0";

  const card = (title: string, value: string | number, color = "#333") =>
    `<div style="background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px 20px;min-width:160px;text-align:center">
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:.5px">${title}</div>
      <div style="font-size:28px;font-weight:700;color:${color};margin-top:6px">${value}</div>
    </div>`;

  const cronRow = (label: string, val: string | null) =>
    `<tr><td style="padding:6px 12px;color:#555">${label}</td><td style="padding:6px 12px;font-family:monospace;font-size:12px">${val ?? '<span style="color:#aaa">aguardando 1º run</span>'}</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Avoce — Agent Dashboard</title>
<style>
  body{font-family:system-ui,sans-serif;background:#f5f5f5;margin:0;padding:24px;color:#222}
  h1{margin:0 0 4px;font-size:22px}
  .subtitle{color:#888;font-size:13px;margin-bottom:24px}
  .section{background:#fff;border:1px solid #ddd;border-radius:8px;margin-bottom:20px;overflow:hidden}
  .section-header{background:#f0f0f0;padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid #ddd}
  .cards{display:flex;gap:12px;flex-wrap:wrap;padding:16px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:8px 12px;font-size:12px;color:#888;border-bottom:1px solid #eee;font-weight:500;text-transform:uppercase}
  td{border-bottom:1px solid #f0f0f0;font-size:13px}
  tr:last-child td{border-bottom:none}
  .badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
  .ok{background:#d4edda;color:#155724}
  .warn{background:#fff3cd;color:#856404}
  .crit{background:#f8d7da;color:#721c24}
</style>
</head>
<body>
<h1>🤖 Avoce — Agent Dashboard</h1>
<div class="subtitle">Atualizado em ${fmt(now)}</div>

<div class="section">
  <div class="section-header">LLM — Últimas 24h</div>
  <div class="cards">
    ${card("Chamadas", totalCalls24h)}
    ${card("Erros", errCalls24h, errCalls24h > 0 ? "#c0392b" : "#27ae60")}
    ${card("Taxa de erro", errRate + "%", parseFloat(errRate) > 5 ? "#c0392b" : "#27ae60")}
    ${card("Prompt leaks bloqueados", promptLeaks24h, promptLeaks24h > 0 ? "#c0392b" : "#27ae60")}
  </div>
</div>

<div class="section">
  <div class="section-header">Cron — Última execução</div>
  <table>
    <thead><tr><th>Job</th><th>Última execução</th></tr></thead>
    <tbody>
      ${cronRow("processarTimeoutsAgente (15min)", cronHealth.last_run_processarTimeoutsAgente)}
      ${cronRow("recuperarMensagensPerdidas (15min)", cronHealth.last_run_recuperarMensagensPerdidas)}
      ${cronRow("processarHandoffsAtrasados (5min)", cronHealth.last_run_processarHandoffsAtrasados)}
    </tbody>
  </table>
  <div style="padding:10px 16px;font-size:12px;color:${cronHealth.any_overdue ? "#c0392b" : "#888"}">
    ${cronHealth.any_overdue ? "⚠️ Algum cron está atrasado (>30min sem rodar)" : "✓ Todos os crons rodando normalmente"}
  </div>
</div>

<div class="section">
  <div class="section-header">Handoffs atrasados — persona Daniela sem intro (>30min)</div>
  ${handoffAtrasados.length === 0
    ? '<div style="padding:16px;color:#888;font-size:13px">Nenhum handoff atrasado detectado ✓</div>'
    : `<table>
        <thead><tr><th>Deal ID</th><th>Contato</th><th>WhatsApp</th><th>Stage</th></tr></thead>
        <tbody>
          ${handoffAtrasados.map((d: any) => `
            <tr>
              <td style="padding:8px 12px;font-family:monospace;font-size:11px">${d.id}</td>
              <td style="padding:8px 12px">${d.contato?.nome ?? "—"}</td>
              <td style="padding:8px 12px">${d.contato?.whatsapp ?? "—"}</td>
              <td style="padding:8px 12px"><span class="badge warn">${d.iaStageChave ?? "?"}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>`
  }
</div>

<div class="section">
  <div class="section-header">Últimas 10 entradas de prompt_leak_blocked</div>
  ${leakLogs.length === 0
    ? '<div style="padding:16px;color:#888;font-size:13px">Nenhum vazamento nas últimas 24h ✓</div>'
    : `<table>
        <thead><tr><th>Quando</th><th>Deal</th><th>Persona</th><th>Stage</th><th>Motivo</th></tr></thead>
        <tbody>
          ${leakLogs.map((l: any) => `
            <tr>
              <td style="padding:8px 12px;font-size:11px">${fmt(l.criadoEm)}</td>
              <td style="padding:8px 12px;font-family:monospace;font-size:10px">${l.dealId ?? "—"}</td>
              <td style="padding:8px 12px">${l.personaChave ?? "—"}</td>
              <td style="padding:8px 12px">${l.stageChave ?? "—"}</td>
              <td style="padding:8px 12px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#c0392b">${l.erro ?? "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table>`
  }
</div>

<div style="font-size:11px;color:#aaa;text-align:center;margin-top:12px">
  <a href="/api/agent/health" style="color:#aaa">JSON bruto</a> · Refresh: <a href="" style="color:#aaa">F5</a>
</div>
</body>
</html>`;

  return reply.type("text/html").send(html);
});

// ── Banking — OFX / CSV import (multipart) ────────────────────────────────────

function verifyJwt(req: FastifyRequest): boolean {
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    jwt.verify(token, process.env.JWT_SECRET ?? "avoce_secret");
    return true;
  } catch {
    return false;
  }
}

app.post("/banking/import/ofx", async (req, reply) => {
  if (!verifyJwt(req)) return reply.status(401).send({ error: "Não autorizado" });

  let emitenteId    = "";
  let bankAccountId = "";
  let fileContent   = "";

  for await (const part of req.parts()) {
    if (part.type === "field" && part.fieldname === "emitenteId")    emitenteId    = part.value as string;
    if (part.type === "field" && part.fieldname === "bankAccountId") bankAccountId = part.value as string;
    if (part.type === "file"  && part.fieldname === "file") {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileContent = Buffer.concat(chunks).toString("utf-8");
    }
  }

  if (!emitenteId || !bankAccountId || !fileContent) {
    return reply.status(400).send({ error: "Campos obrigatórios: emitenteId, bankAccountId, file" });
  }

  try {
    const result = await ofxImportService.importOfx(emitenteId, bankAccountId, fileContent);
    return reply.send({ ok: true, ...result });
  } catch (err) {
    return reply.status(500).send({ error: err instanceof Error ? err.message : "Erro ao importar OFX" });
  }
});

app.post("/banking/import/csv/preview", async (req, reply) => {
  if (!verifyJwt(req)) return reply.status(401).send({ error: "Não autorizado" });

  let fileContent = "";
  for await (const part of req.parts()) {
    if (part.type === "file" && part.fieldname === "file") {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileContent = Buffer.concat(chunks).toString("utf-8");
    }
  }

  if (!fileContent) return reply.status(400).send({ error: "Arquivo CSV não enviado" });

  try {
    const result = await ofxImportService.previewCsv(fileContent);
    return reply.send(result);
  } catch (err) {
    return reply.status(500).send({ error: err instanceof Error ? err.message : "Erro ao ler CSV" });
  }
});

app.post("/banking/import/csv", async (req, reply) => {
  if (!verifyJwt(req)) return reply.status(401).send({ error: "Não autorizado" });

  let emitenteId    = "";
  let bankAccountId = "";
  let fileContent   = "";
  let mappingRaw    = "";

  for await (const part of req.parts()) {
    if (part.type === "field" && part.fieldname === "emitenteId")    emitenteId    = part.value as string;
    if (part.type === "field" && part.fieldname === "bankAccountId") bankAccountId = part.value as string;
    if (part.type === "field" && part.fieldname === "mapping")       mappingRaw    = part.value as string;
    if (part.type === "file"  && part.fieldname === "file") {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) chunks.push(chunk);
      fileContent = Buffer.concat(chunks).toString("utf-8");
    }
  }

  if (!emitenteId || !bankAccountId || !fileContent || !mappingRaw) {
    return reply.status(400).send({ error: "Campos obrigatórios: emitenteId, bankAccountId, mapping, file" });
  }

  let mapping: import("./modules/banking/services/ofx-import.service.js").CsvMapping;
  try {
    mapping = JSON.parse(mappingRaw);
  } catch {
    return reply.status(400).send({ error: "Campo mapping deve ser JSON válido" });
  }

  try {
    const result = await ofxImportService.importCsv(emitenteId, bankAccountId, fileContent, mapping);
    return reply.send({ ok: true, ...result });
  } catch (err) {
    return reply.status(500).send({ error: err instanceof Error ? err.message : "Erro ao importar CSV" });
  }
});

// ── Setup inicial (seed do admin se não existir) ──────────────────────────────

async function ensureAdmin() {
  const count = await prisma.usuario.count();
  if (count === 0) {
    const adminEmail = process.env.ADMIN_EMAIL ?? "admin@capium.com.br";
    const adminSenha = process.env.ADMIN_SENHA ?? "avoce@2025";
    const hash = await bcrypt.hash(adminSenha, 10);
    await prisma.usuario.create({
      data: { email: adminEmail, senha: hash, nome: "Administrador" },
    });
    console.log(`[SETUP] Admin criado: ${adminEmail}`);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  await prisma.$connect();
  await ensureAdmin();
  iniciarCron();
  initBankingCron();

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`[API] Rodando na porta ${PORT}`);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
