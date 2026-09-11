/**
 * Serviço do módulo Assinaturas — convites, notificações e conclusão.
 *
 * O escritório remetente (RAP ou PSA) é o `EmpresaEmitente` escolhido na criação
 * do documento; o nome dele é interpolado em todos os textos enviados ao
 * signatário (e-mail e WhatsApp) através do token {escritorio}.
 */

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prisma } from "../../db.js";
import { fieldDecrypt } from "../../lib/field-crypto.js";
import { sendMailAndSave, type SmtpConfig } from "../../lib/email.js";
import { sendText, sendDocument, type EvolutionConfig } from "../../services/evolution.js";
import { getEvolutionConfigForEmitente } from "../../services/evolution-empresa.js";
import { paktBaixarPdf } from "../../lib/pakt.js";

export const ASSINATURAS_DIR = resolve("./uploads/assinaturas");
try { mkdirSync(join(ASSINATURAS_DIR, "originais"), { recursive: true }); } catch { /* ok */ }
try { mkdirSync(join(ASSINATURAS_DIR, "assinados"), { recursive: true }); } catch { /* ok */ }

export type Signatario = {
  nome: string;
  email: string;
  cpf?: string;
  telefone?: string;
  papel?: "SIGNER" | "WITNESS" | "APPROVER";
  orderIndex?: number;
  paktSignerId?: string;
  signUrl?: string;
  tokenAcesso?: string;
  status?: string;
  signedAt?: string | null;
};

// ── Templates ─────────────────────────────────────────────────────────────────
// Sobrescrevíveis pela tabela Configuracao (chaves abaixo).

const TEMPLATE_PADRAO = {
  assinatura_wa_convite:
    "📄 *{documento}*\n\nOlá {signatario}! {solicitante}, do escritório *{escritorio}*, solicita sua assinatura eletrônica.\n\n🔗 *Link para assinar:*\n{link}\n\nA assinatura é feita com verificação de identidade (selfie + validação bancária).",
  assinatura_wa_assinado:
    "✅ *Documento assinado!*\n\nOlá {signatario}, segue em anexo o PDF final de *{documento}*, com todas as assinaturas e a trilha de auditoria. Qualquer dúvida estamos à disposição.\n\n_{escritorio}_",
  assinatura_email_assunto: "{escritorio} — documento para assinatura: {documento}",
};

async function template(chave: keyof typeof TEMPLATE_PADRAO): Promise<string> {
  try {
    const cfg = await prisma.configuracao.findUnique({ where: { chave } });
    if (cfg?.valor?.trim()) return cfg.valor;
  } catch { /* usa o padrão */ }
  return TEMPLATE_PADRAO[chave];
}

function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

/** Nome do escritório remetente exibido nos textos (ex.: "RAP" / "PSA"). */
export function nomeEscritorio(emitente: { nome: string; nomeFantasia?: string | null }): string {
  return (emitente.nomeFantasia?.trim() || emitente.nome).trim();
}

/** Razão social completa, usada na assinatura do e-mail. */
export function razaoEscritorio(emitente: { nome: string; nomeFantasia?: string | null }): string {
  const fantasia = emitente.nomeFantasia?.trim();
  return fantasia && fantasia !== emitente.nome ? `${emitente.nome} (${fantasia})` : emitente.nome;
}

function normalizarTelefone(tel?: string | null): string {
  const limpo = (tel ?? "").replace(/\D/g, "");
  if (!limpo) return "";
  // Números brasileiros sem DDI recebem o 55 na frente.
  if (limpo.length >= 10 && limpo.length <= 11) return `55${limpo}`;
  return limpo;
}

// ── WhatsApp ──────────────────────────────────────────────────────────────────

async function evolutionConfig(emitente?: { id: string; empresaId?: string | null } | null): Promise<EvolutionConfig | null> {
  // Por escritório primeiro (PSA → Judite, RAP → Isabella); o resto é o fallback antigo.
  if (emitente) {
    const porEscritorio = await getEvolutionConfigForEmitente(emitente).catch(() => null);
    if (porEscritorio) return porEscritorio;
  }
  const cfgProjeto = await prisma.configuracao
    .findUnique({ where: { chave: "assinatura_projeto_ia_id" } })
    .catch(() => null);

  const projeto = cfgProjeto?.valor
    ? { id: cfgProjeto.valor }
    : await prisma.iaProjeto.findFirst({ where: { ativo: true }, orderBy: { criadoEm: "asc" }, select: { id: true } });
  if (!projeto) return null;

  const configs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId: projeto.id, categoria: "whatsapp" },
  });
  const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
  const baseUrl = get("evolution_api_url");
  const apiKey = get("evolution_api_key");
  const instancia = get("evolution_instancia");
  if (!baseUrl || !apiKey || !instancia) return null;
  return { baseUrl, apiKey, instancia };
}

// ── Envio dos convites ────────────────────────────────────────────────────────

export type ResultadoConvites = {
  emailsEnviados: number;
  whatsappsEnviados: number;
  erros: string[];
};

/**
 * Envia o convite de assinatura para cada signatário: e-mail pelo SMTP do
 * escritório escolhido (RAP ou PSA) e WhatsApp quando houver telefone.
 * O PAKT também dispara o e-mail dele — este aqui é o que traz o escritório no texto.
 */
export async function enviarConvites(
  assinaturaId: string,
  canais: { email?: boolean; whatsapp?: boolean } = {},
): Promise<ResultadoConvites> {
  const { email: comEmail = true, whatsapp: comWhatsapp = true } = canais;
  const res: ResultadoConvites = { emailsEnviados: 0, whatsappsEnviados: 0, erros: [] };

  const a = await prisma.assinatura.findUnique({
    where: { id: assinaturaId },
    include: { emitente: true },
  });
  if (!a) throw new Error("Assinatura não encontrada");

  const signatarios = (a.signatarios as unknown as Signatario[]) ?? [];
  const escritorio = nomeEscritorio(a.emitente);
  const solicitante = a.criadoPorNome ?? escritorio;

  // ── E-mail (SMTP do escritório) ──
  const smtpOk = !!(a.emitente.smtpHost && a.emitente.smtpUser);
  if (comEmail && smtpOk) {
    const fromName = a.emitente.smtpFrom && !a.emitente.smtpFrom.includes("@") ? a.emitente.smtpFrom : null;
    const fromEmail = a.emitente.smtpUser!;
    const smtp: SmtpConfig = {
      host: a.emitente.smtpHost!,
      port: a.emitente.smtpPort ?? 587,
      secure: a.emitente.smtpPort === 465,
      user: fromEmail,
      pass: fieldDecrypt(a.emitente.smtpPass),
      from: fromName ? `"${fromName}" <${fromEmail}>` : (a.emitente.smtpFrom ?? fromEmail),
    };
    const assuntoTpl = await template("assinatura_email_assunto");

    for (const s of signatarios) {
      if (!s.email || !s.signUrl) continue;
      try {
        await sendMailAndSave(smtp, {
          from: smtp.from,
          to: s.email,
          subject: render(assuntoTpl, { escritorio, documento: a.nome }),
          html: emailConviteHtml({
            signatario: s.nome,
            documento: a.nome,
            link: s.signUrl,
            escritorio,
            razao: razaoEscritorio(a.emitente),
            solicitante,
            mensagem: a.mensagem ?? "",
            emitente: a.emitente,
          }),
        });
        res.emailsEnviados++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Assinatura] e-mail para ${s.email}:`, msg);
        res.erros.push(`E-mail ${s.email}: ${msg}`);
      }
    }
  } else if (comEmail) {
    res.erros.push(
      `SMTP não configurado para ${escritorio} — o convite por e-mail saiu apenas pelo PAKT. ` +
      `Configure em Cadastros → Empresas → ${escritorio} → SMTP.`,
    );
  }

  // ── WhatsApp ──
  const evo = comWhatsapp ? await evolutionConfig(a.emitente) : null;
  if (evo) {
    const tpl = await template("assinatura_wa_convite");
    for (const s of signatarios) {
      const telefone = normalizarTelefone(s.telefone);
      if (!telefone || !s.signUrl) continue;
      try {
        await sendText(
          evo,
          telefone,
          render(tpl, {
            documento: a.nome,
            signatario: s.nome,
            solicitante,
            escritorio,
            link: s.signUrl,
          }),
        );
        res.whatsappsEnviados++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Assinatura] WhatsApp para ${telefone}:`, msg);
        res.erros.push(`WhatsApp ${telefone}: ${msg}`);
      }
    }
  }

  await prisma.assinatura.update({
    where: { id: a.id },
    data: {
      emailEnviado: res.emailsEnviados > 0 || a.emailEnviado,
      emailEnviadoEm: res.emailsEnviados > 0 ? new Date() : a.emailEnviadoEm,
      whatsappEnviado: res.whatsappsEnviados > 0 || a.whatsappEnviado,
      whatsappEnviadoEm: res.whatsappsEnviados > 0 ? new Date() : a.whatsappEnviadoEm,
    },
  });

  return res;
}

function emailConviteHtml(p: {
  signatario: string;
  documento: string;
  link: string;
  escritorio: string;
  razao: string;
  solicitante: string;
  mensagem: string;
  emitente: { telefone?: string | null; email?: string | null; cidade?: string | null; uf?: string | null };
}): string {
  const esc = (s: string) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const contato = [p.emitente.telefone, p.emitente.email]
    .filter((v): v is string => !!v)
    .map(esc)
    .join(" · ");
  const local = [p.emitente.cidade, p.emitente.uf].filter(Boolean).join("/");

  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#1f2937">
  <div style="background:#004a5c;color:#fff;padding:20px 28px;border-radius:10px 10px 0 0">
    <div style="font-size:18px;font-weight:700">${esc(p.escritorio)}</div>
    <div style="font-size:12px;opacity:.85">Assinatura eletrônica de documentos</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:28px">
    <p style="margin:0 0 14px">Olá, <strong>${esc(p.signatario)}</strong>!</p>
    <p style="margin:0 0 14px">
      ${esc(p.solicitante)}, do escritório <strong>${esc(p.razao)}</strong>, encaminha o documento
      <strong>${esc(p.documento)}</strong> para sua assinatura eletrônica.
    </p>
    ${p.mensagem ? `<p style="margin:0 0 14px;padding:12px 14px;background:#f8fafc;border-left:3px solid #004a5c;font-size:14px">${esc(p.mensagem)}</p>` : ""}
    <p style="text-align:center;margin:28px 0">
      <a href="${p.link}" style="background:#004a5c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:700;display:inline-block">
        ✍️ Assinar documento
      </a>
    </p>
    <p style="margin:0 0 14px;font-size:13px;color:#6b7280">
      Se o botão não funcionar, copie e cole este link no navegador:<br>
      <a href="${p.link}" style="color:#004a5c;word-break:break-all">${p.link}</a>
    </p>
    <p style="margin:0;font-size:12px;color:#6b7280">
      A assinatura é feita com verificação de identidade (selfie + validação bancária) na plataforma PAKT.
      O documento assinado, com a trilha de auditoria, é devolvido a você por e-mail e WhatsApp ao final.
    </p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:22px 0">
    <div style="font-size:12px;color:#6b7280">
      <strong>${esc(p.razao)}</strong>${local ? ` — ${esc(local)}` : ""}<br>${contato}
    </div>
  </div>
</div>`;
}

// ── Conclusão (webhook / sync) ────────────────────────────────────────────────

/**
 * document.completed: baixa o PDF final do PAKT, grava em disco e devolve o
 * documento assinado aos signatários por WhatsApp.
 */
/** Classifica o assinado pelo nome do documento, para ele entrar no acervo do
 *  deal já identificado em vez de cair como "OUTRO". */
export function tipoDoAssinado(nome: string): string {
  const n = (nome ?? "").toLowerCase();
  if (/procura[cç][aã]o/.test(n)) return "PROCURACAO_ASSINADA";
  if (/contrato|honor[aá]rio/.test(n)) return "CONTRATO_ASSINADO";
  return "DOCUMENTO_ASSINADO";
}

export async function processarConclusao(paktDocumentId: string, pdfBytes?: Buffer): Promise<void> {
  const a = await prisma.assinatura.findUnique({
    where: { paktDocumentId },
    include: { emitente: true },
  });
  if (!a) return;

  // O PAKT pode reentregar o webhook de conclusão; sem isto o anexo do deal
  // seria criado de novo a cada reentrega.
  const jaConcluida = a.status === "COMPLETED";

  let pdf = pdfBytes;
  if (!pdf) {
    try {
      pdf = await paktBaixarPdf(paktDocumentId, "final");
    } catch (e) {
      console.error(`[Assinatura] download do PDF final ${paktDocumentId}:`, e);
    }
  }

  let arquivoAssinadoPath = a.arquivoAssinadoPath;
  if (pdf?.length) {
    const base = (a.arquivoNome ?? `${a.nome}.pdf`).replace(/\.pdf$/i, "");
    arquivoAssinadoPath = join(ASSINATURAS_DIR, "assinados", `${a.id}-${sanitizar(base)}-assinado.pdf`);
    try {
      await writeFile(arquivoAssinadoPath, pdf);
    } catch (e) {
      console.error("[Assinatura] gravação do PDF assinado:", e);
      arquivoAssinadoPath = a.arquivoAssinadoPath;
    }
  }

  await prisma.assinatura.update({
    where: { id: a.id },
    data: {
      status: "COMPLETED",
      arquivoAssinadoPath,
      arquivoAssinadoEm: arquivoAssinadoPath ? new Date() : a.arquivoAssinadoEm,
    },
  });

  // O assinado vivia só na tela de Assinaturas e no disco: não aparecia na aba
  // de anexos do deal, e o coleta_docs (que se orienta pelos anexos) não sabia
  // que a procuração já tinha sido assinada.
  if (pdf?.length && a.dealId && !jaConcluida) {
    try {
      const { salvarAnexoDeal } = await import("../../agent/deal-anexos.js");
      await salvarAnexoDeal(
        a.dealId,
        pdf,
        "application/pdf",
        `${sanitizar(a.nome)}-assinado.pdf`,
        null,
        null,
        tipoDoAssinado(a.nome),
      );
      console.log(`[Assinatura] ${a.nome} anexado ao deal ${a.dealId} como ${tipoDoAssinado(a.nome)}`);
    } catch (e) {
      // Nunca deixar de concluir a assinatura por causa do anexo.
      console.error(`[Assinatura] falha ao anexar assinado ao deal ${a.dealId}:`, e);
    }
  }

  if (pdf?.length && !a.whatsappAssinadoEnviado) {
    const enviados = await enviarPdfAssinadoWhatsapp(a.id, pdf);
    if (enviados > 0) {
      await prisma.assinatura.update({
        where: { id: a.id },
        data: { whatsappAssinadoEnviado: true, whatsappAssinadoEnviadoEm: new Date() },
      });
    }
  }

  console.log(`[Assinatura] documento ${paktDocumentId} concluído (${a.nome})`);
}

export async function enviarPdfAssinadoWhatsapp(assinaturaId: string, pdf: Buffer): Promise<number> {
  const a = await prisma.assinatura.findUnique({
    where: { id: assinaturaId },
    include: { emitente: true },
  });
  if (!a) return 0;

  const evo = await evolutionConfig(a.emitente);
  if (!evo) return 0;

  const tpl = await template("assinatura_wa_assinado");
  const escritorio = nomeEscritorio(a.emitente);
  const fileName = `${sanitizar(a.nome)}-assinado.pdf`;
  const base64 = pdf.toString("base64");
  const signatarios = (a.signatarios as unknown as Signatario[]) ?? [];

  let enviados = 0;
  for (const s of signatarios) {
    const telefone = normalizarTelefone(s.telefone);
    if (!telefone) continue;
    try {
      await sendDocument(
        evo,
        telefone,
        base64,
        fileName,
        render(tpl, { documento: a.nome, signatario: s.nome, escritorio }),
      );
      enviados++;
    } catch (e) {
      console.error(`[Assinatura] envio do PDF assinado para ${telefone}:`, e);
    }
  }
  return enviados;
}

export function sanitizar(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "documento";
}
