import { z }                 from "zod";
import { router, authProc }  from "./trpc.js";
import { prisma }            from "../db.js";
import { whereEmitenteFilter, assertEmitenteAccess } from "./tenant-utils.js";
import nodemailer             from "nodemailer";
import { htmlToPdf }         from "../lib/pdf.js";
import { existsSync, readFileSync } from "node:fs";
import { readFile }          from "node:fs/promises";
import { sendText }          from "../services/evolution.js";
import { getEvolutionConfigForEmitente } from "../services/evolution-empresa.js";
import { fieldDecrypt }      from "../lib/field-crypto.js";
import { sendMailAndSave, type SmtpConfig } from "../lib/email.js";

// ── Auto-conversão de proposta aceita em contrato ────────────────────────────

export async function autoConverterEmContrato(propostaId: string): Promise<void> {
  const p = await prisma.proposta.findUnique({
    where: { id: propostaId },
  }) as any;

  if (!p) return;
  if (p.contratoId) return;  // já convertida

  // Para contratos de êxito, valor pode ser 0 e não há dia de vencimento fixo

  const descricao = p.contratoDescricao || p.titulo;

  const isEventual = (p.contratoTipoContrato ?? "RECORRENTE") === "EVENTUAL";

  const contrato = await prisma.contrato.create({
    data: {
      emitenteId:        p.emitenteId,
      tomadorId:         p.tomadorId,
      nomeServico:       p.titulo,
      descricaoServico:  descricao,
      valor:             p.valorEstimado ?? 0,
      diaVencimento:     p.contratoDiaVencimento ?? 5,
      metodoCobr:        p.contratoMetodoCobr ?? "PIX_BOLETO",
      emitirNfseAuto:    isEventual ? false : (p.contratoEmitirNfseAuto ?? false),
      gerarCobrancaAuto: isEventual ? false : (p.contratoGerarCobrancaAuto ?? true),
      tipoContrato:      p.contratoTipoContrato ?? "RECORRENTE",
      totalParcelas:     p.contratoTotalParcelas ?? null,
      issRetido:         p.contratoIssRetido ?? false,
    },
  });

  await prisma.proposta.update({
    where: { id: propostaId },
    data:  { contratoId: contrato.id } as any,
  });

  console.log(`[Proposta] ${propostaId} convertida automaticamente em contrato ${contrato.id}`);
}

// ── Preparação comum ao envio (e-mail e WhatsApp) ───────────────────────────
// Gera o PDF da proposta, os documentos (contrato + procuração), carrega os PDFs
// e cria os envelopes no PAKT (um por documento; exige e-mail do tomador, que é
// o signatário). Persiste paktSignUrl/paktDocumentId. Extraído do enviarEmail
// para o WhatsApp mandar exatamente o mesmo que o e-mail manda.
type EnvioAtt = { filename: string; content: Buffer; contentType: "application/pdf"; docId?: string; titulo?: string };
type EnvioPaktDoc = { filename: string; titulo: string; signUrl: string; documentId: string };

async function prepararEnvioProposta(p: any): Promise<{
  propostaPdf?: Buffer; docAttachments: EnvioAtt[]; paktDocs: EnvioPaktDoc[];
  baseUrl: string; paktBaseUrl: string; emitenteNome: string;
}> {
  const baseUrl     = process.env.APP_BASE_URL ?? "https://avoce.com.br";
  const paktApiKey  = process.env.PAKT_API_KEY;
  const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
  const emitenteNome = p.emitente.nomeFantasia || p.emitente.nome;

  // ── 1. Gerar PDF da proposta ───────────────────────────────────────────────
  let propostaPdf: Buffer | undefined;
  try {
    const pageHtml = propostaHtmlPage(p.titulo, p.textoHtml, {
      id: p.emitente.id, nome: p.emitente.nome, nomeFantasia: p.emitente.nomeFantasia,
      cnpj: p.emitente.cnpj, logoSrc: logoPathToBase64(p.emitente.logoPath),
      cidade: p.emitente.cidade, uf: p.emitente.uf,
      endereco: p.emitente.endereco, numero: p.emitente.numero,
      complemento: p.emitente.complemento, bairro: p.emitente.bairro,
      cep: p.emitente.cep, telefone: p.emitente.telefone, email: p.emitente.email,
    }, p.validadeAte, { nome: p.tomador.nome });
    propostaPdf = await htmlToPdf(pageHtml);
  } catch (e) {
    console.error("[Proposta] Falha ao gerar PDF da proposta:", e);
  }

  // ── 2. Gerar documentos (contrato + procuração) ────────────────────────────
  // Importação dinâmica para evitar dependência circular com templateDocumentos.ts
  try {
    const { gerarDocumentosProposta } = await import("./templateDocumentos.js");
    await gerarDocumentosProposta(p.id);
  } catch (e) {
    console.error("[Proposta] Falha ao gerar documentos:", e);
  }

  // ── 3. Carregar PDFs dos documentos gerados ────────────────────────────────
  const docAttachments: EnvioAtt[] = [];

  try {
    const docs = await (prisma as any).documentoGerado.findMany({
      where:   { propostaId: p.id },
      orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }], // CONTRATO antes PROCURACAO
    });
    console.log(`[Proposta] ${docs.length} documento(s) gerado(s) para proposta ${p.id}`);
    for (const doc of docs) {
      if (!doc.pdfPath) { console.warn(`[Proposta] Doc ${doc.id} sem pdfPath`); continue; }
      if (!existsSync(doc.pdfPath)) { console.warn(`[Proposta] PDF não encontrado: ${doc.pdfPath}`); continue; }
      const buf      = await readFile(doc.pdfPath);
      const tipoLabel = doc.tipo === "CONTRATO" ? "Contrato" : doc.tipo === "PROCURACAO" ? "Procuracao" : doc.tipo;
      docAttachments.push({
        filename:    `${tipoLabel}-${doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`,
        content:     buf,
        contentType: "application/pdf",
        docId:       doc.id,
        titulo:      doc.titulo,
      });
    }
  } catch (e) {
    console.error("[Proposta] Erro ao carregar documentos gerados:", e);
  }

  // ── 4. PAKT: criar um documento por template (contrato + procuração) ────────
  // Cada doc recebe seu próprio link de assinatura → cliente assina sucessivamente
  const paktDocs: EnvioPaktDoc[] = [];

  // Docs a enviar ao PAKT: todos os gerados, ou proposta como fallback
  const docsParaPakt = docAttachments.length > 0 ? docAttachments : (propostaPdf
    ? [{ filename: `${p.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`,
         content: propostaPdf, contentType: "application/pdf" as const,
         titulo: p.titulo }]
    : []);

  if (paktApiKey && docsParaPakt.length > 0 && p.tomador.email) {
    for (const att of docsParaPakt) {
      try {
        const form = new FormData();
        form.append(
          "file",
          new Blob([att.content as unknown as BlobPart], { type: "application/pdf" }),
          att.filename,
        );
        // Prazo de assinatura = validade da proposta, mas NUNCA uma data no
        // passado: proposta vencida gerava envelope já expirado, e o cliente
        // abria o link e via "Este documento expirou"
        const validadeFutura = p.validadeAte && p.validadeAte.getTime() > Date.now()
          ? p.validadeAte
          : null;
        if (p.validadeAte && !validadeFutura) {
          console.warn(`[Proposta] validade ${p.validadeAte.toISOString()} já venceu — enviando ao PAKT sem prazo de expiração`);
        }

        form.append("metadata", JSON.stringify({
          nome:      att.titulo ?? att.filename.replace(/\.pdf$/i, ""),
          mensagem:  `Documento de ${emitenteNome} para assinatura digital. Por favor, leia e assine.`,
          expiresAt: validadeFutura ? validadeFutura.toISOString() : undefined,
          signers:   [{ nome: p.tomador.nome, email: p.tomador.email, countryCode: "BR" }],
        }));

        const createRes = await fetch(`${paktBaseUrl}/api/v1/documents`, {
          method: "POST",
          headers: { Authorization: `Bearer ${paktApiKey}` },
          body: form,
        });

        if (createRes.ok) {
          const doc = await createRes.json() as { id: string; signers: Array<{ signUrl: string }> };
          const signUrl = doc.signers[0]?.signUrl;
          if (signUrl) {
            paktDocs.push({ filename: att.filename, titulo: att.titulo ?? att.filename, signUrl, documentId: doc.id });
            await fetch(`${paktBaseUrl}/api/v1/documents/${doc.id}/send`, {
              method: "POST", headers: { Authorization: `Bearer ${paktApiKey}` },
            });
            console.log(`[Proposta] PAKT doc criado: ${doc.id} (${att.filename}) | signUrl: ${signUrl}`);
          }
        } else {
          console.error(`[Proposta] PAKT erro para ${att.filename}:`, createRes.status, await createRes.text());
        }
      } catch (e) {
        console.error(`[Proposta] Falha PAKT para ${att.filename}:`, e);
      }
    }

    // Persistir: primeiro signUrl + todos os IDs como JSON
    if (paktDocs.length > 0) {
      await prisma.proposta.update({
        where: { id: p.id },
        data: {
          paktSignUrl:    paktDocs[0].signUrl,
          paktDocumentId: JSON.stringify(paktDocs.map(d => d.documentId)),
        } as any,
      });
    }
  }
  return { propostaPdf, docAttachments, paktDocs, baseUrl, paktBaseUrl, emitenteNome };
}

// ── E-mail de confirmação de aceite com todos os documentos ─────────────────
export async function enviarEmailAceite(propostaId: string): Promise<void> {
  const p = await prisma.proposta.findUnique({
    where: { id: propostaId },
    include: { emitente: true, tomador: true },
  }) as any;

  if (!p) return;
  // Precisa de SMTP e e-mail do tomador
  if (!p.emitente.smtpHost || !p.emitente.smtpUser) {
    console.log(`[Aceite-Email] ${propostaId}: SMTP não configurado — e-mail não enviado`);
    return;
  }
  if (!p.tomador.email) {
    console.log(`[Aceite-Email] ${propostaId}: tomador sem e-mail — e-mail não enviado`);
    return;
  }

  const emitenteNome = p.emitente.nomeFantasia || p.emitente.nome;

  // ── Gerar PDF da proposta ──────────────────────────────────────────────────
  const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = [];

  try {
    const pageHtml = propostaHtmlPage(p.titulo, p.textoHtml, {
      id: p.emitente.id, nome: p.emitente.nome, nomeFantasia: p.emitente.nomeFantasia,
      cnpj: p.emitente.cnpj, logoSrc: logoPathToBase64(p.emitente.logoPath),
      cidade: p.emitente.cidade, uf: p.emitente.uf,
      endereco: p.emitente.endereco, numero: p.emitente.numero,
      complemento: p.emitente.complemento, bairro: p.emitente.bairro,
      cep: p.emitente.cep, telefone: p.emitente.telefone, email: p.emitente.email,
    }, p.validadeAte, { nome: p.tomador.nome });
    const pdf = await htmlToPdf(pageHtml);
    attachments.push({
      filename:    `Proposta-${p.titulo.replace(/[^a-zA-Z0-9]/g, "-")}.pdf`,
      content:     pdf,
      contentType: "application/pdf",
    });
  } catch (e) {
    console.error("[Aceite-Email] Falha ao gerar PDF da proposta:", e);
  }

  // ── PDF assinado (PAKT) se existir ────────────────────────────────────────
  if (p.paktSignedPdfPath && existsSync(p.paktSignedPdfPath)) {
    try {
      const buf = await readFile(p.paktSignedPdfPath);
      attachments.push({
        filename:    `Proposta-Assinada-${p.titulo.replace(/[^a-zA-Z0-9]/g, "-")}.pdf`,
        content:     buf,
        contentType: "application/pdf",
      });
    } catch { /* ignora */ }
  }

  // ── Documentos gerados (contrato + procuração) ────────────────────────────
  try {
    const docs = await (prisma as any).documentoGerado.findMany({
      where: { propostaId },
      orderBy: { criadoEm: "asc" },
    });
    for (const doc of docs) {
      if (doc.pdfPath && existsSync(doc.pdfPath)) {
        const buf = await readFile(doc.pdfPath);
        const tipoLabel = doc.tipo === "CONTRATO" ? "Contrato" : doc.tipo === "PROCURACAO" ? "Procuração" : doc.tipo;
        attachments.push({
          filename:    `${tipoLabel}-${doc.titulo.replace(/[^a-zA-Z0-9]/g, "-")}.pdf`,
          content:     buf,
          contentType: "application/pdf",
        });
      }
    }
  } catch (e) {
    console.error("[Aceite-Email] Erro ao carregar documentos gerados:", e);
  }

  // ── Montar e enviar e-mail ─────────────────────────────────────────────────
  const fromName  = p.emitente.smtpFrom && !p.emitente.smtpFrom.includes("@") ? p.emitente.smtpFrom : null;
  const fromEmail = p.emitente.smtpUser;
  const fromField = fromName ? `"${fromName}" <${fromEmail}>` : (p.emitente.smtpFrom ?? fromEmail);

  const smtpAceite: SmtpConfig = {
    host:   p.emitente.smtpHost,
    port:   p.emitente.smtpPort ?? 587,
    secure: p.emitente.smtpPort === 465,
    user:   p.emitente.smtpUser,
    pass:   fieldDecrypt(p.emitente.smtpPass),
    from:   fromField,
  };

  const logoBase64 = logoPathToBase64(p.emitente.logoPath);
  const aceitoStr  = p.aceitoEm ? new Date(p.aceitoEm).toLocaleString("pt-BR", { timeZone: "America/Bahia" }) : "—";
  const cnpjFmtAc  = fmtCnpj(p.emitente.cnpj);
  const docsCount  = attachments.length;

  const htmlEmail = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
      <tr><td style="background:#16a34a;padding:20px 32px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          ${logoBase64 ? `<td style="width:80px;vertical-align:middle;padding-right:16px">
            <img src="${logoBase64}" alt="${emitenteNome}" style="max-width:80px;max-height:50px;object-fit:contain;display:block;background:#fff;border-radius:4px;padding:4px">
          </td>` : ""}
          <td style="vertical-align:middle">
            <p style="margin:0;color:#fff;font-size:18px;font-weight:bold">✅ Proposta Aceita</p>
            <p style="margin:3px 0 0;color:#bbf7d0;font-size:12px">${emitenteNome} · CNPJ ${cnpjFmtAc}</p>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:24px 32px">
        <p style="margin:0 0 12px;font-size:15px;color:#111827">
          Prezado(a) <strong>${p.tomador.nome}</strong>,
        </p>
        <p style="margin:0 0 12px;font-size:14px;color:#374151">
          Sua proposta <strong>"${p.titulo}"</strong> foi aceita com sucesso em <strong>${aceitoStr}</strong>.
        </p>
        <p style="margin:0 0 20px;font-size:14px;color:#374151">
          Segue${docsCount > 1 ? `m em anexo ${docsCount} documentos` : " em anexo o documento"} referente a este acordo:
        </p>
        <ul style="margin:0 0 20px;padding-left:20px;font-size:14px;color:#374151;line-height:2">
          ${attachments.map(a => `<li>📄 ${a.filename}</li>`).join("")}
        </ul>
        <p style="margin:0;font-size:13px;color:#6b7280">
          Em caso de dúvidas, entre em contato com ${emitenteNome}${p.emitente.email ? ` pelo e-mail <a href="mailto:${p.emitente.email}">${p.emitente.email}</a>` : ""}.
        </p>
      </td></tr>
      <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center">
        <p style="margin:0;font-size:11px;color:#94a3b8">
          ${emitenteNome} · CNPJ ${cnpjFmtAc} · E-mail automático via Avoce
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const recipients = [p.tomador.email, p.emitente.email].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);

  await sendMailAndSave(smtpAceite, {
    from:        fromField,
    to:          recipients.join(", "),
    subject:     `✅ Proposta aceita: ${p.titulo} — ${emitenteNome}`,
    html:        htmlEmail,
    attachments,
  });

  console.log(`[Aceite-Email] E-mail com ${attachments.length} anexo(s) enviado para ${recipients.join(", ")}`);
}

// ── Templates de proposta ─────────────────────────────────────────────────────

export const TEMPLATES_PROPOSTA = [
  {
    id: "assessoria",
    titulo: "Proposta de Assessoria Jurídica",
    html: `<h2>PROPOSTA DE PRESTAÇÃO DE SERVIÇOS ADVOCATÍCIOS</h2>
<p><strong>{{emitente}}</strong>, inscrito na OAB/BA, vem respeitosamente apresentar a <strong>{{tomador}}</strong> a seguinte proposta de serviços:</p>
<h3>1. Objeto</h3>
<p>Prestação de serviços de assessoria jurídica na área {{servico}}, compreendendo consultoria, elaboração de pareceres, minutas de contratos e representação extrajudicial nos interesses do contratante.</p>
<h3>2. Honorários</h3>
<p>Pelos serviços descritos, os honorários mensais serão de <strong>{{valor}}</strong>, pagáveis até o dia {{diaVencimento}} de cada mês.</p>
<h3>3. Prazo</h3>
<p>O contrato vigerá por prazo indeterminado, podendo ser rescindido por qualquer das partes mediante aviso prévio de 30 (trinta) dias.</p>
<h3>4. Reajuste</h3>
<p>Os honorários serão reajustados anualmente pelo IGP-M ou índice que o substitua.</p>
<h3>5. Validade da Proposta</h3>
<p>Esta proposta é válida até <strong>{{validadeAte}}</strong>.</p>
<p><br>{{cidade}}, {{dataAtual}}</p>`,
  },
  {
    id: "honorarios_parcelados",
    titulo: "Proposta de Honorários Parcelados",
    html: `<h2>PROPOSTA DE HONORÁRIOS ADVOCATÍCIOS</h2>
<p><strong>{{emitente}}</strong> apresenta a <strong>{{tomador}}</strong> proposta de honorários para a prestação dos serviços abaixo descritos:</p>
<h3>1. Serviço</h3>
<p>{{servico}}</p>
<h3>2. Honorários</h3>
<p>Total: <strong>{{valor}}</strong><br>
Forma de pagamento: parcelado em {{totalParcelas}}x de {{valorParcela}} mensais, vencendo a primeira parcela em {{diaVencimento}}/{{mesVencimento}}/{{anoVencimento}}.</p>
<h3>3. Escopo</h3>
<p>Os serviços incluem: análise do caso, elaboração de peças processuais e/ou extrajudiciais, acompanhamento e todos os atos necessários à conclusão do objeto.</p>
<h3>4. Validade</h3>
<p>Proposta válida até <strong>{{validadeAte}}</strong>.</p>
<p><br>{{cidade}}, {{dataAtual}}</p>`,
  },
  {
    id: "consultoria",
    titulo: "Proposta de Consultoria Jurídica Pontual",
    html: `<h2>PROPOSTA DE CONSULTORIA JURÍDICA</h2>
<p><strong>{{emitente}}</strong> apresenta proposta de consultoria jurídica especializada para <strong>{{tomador}}</strong>.</p>
<h3>1. Objeto da Consulta</h3>
<p>{{servico}}</p>
<h3>2. Honorários</h3>
<p>Honorários fixos de <strong>{{valor}}</strong>, a serem pagos conforme acordado.</p>
<h3>3. Prazo de Entrega</h3>
<p>O parecer/relatório será entregue em até 10 (dez) dias úteis após a contratação e recebimento de toda a documentação necessária.</p>
<h3>4. Sigilo</h3>
<p>Todas as informações fornecidas pelo contratante serão tratadas com absoluto sigilo profissional.</p>
<h3>5. Validade</h3>
<p>Proposta válida até <strong>{{validadeAte}}</strong>.</p>
<p><br>{{cidade}}, {{dataAtual}}</p>`,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtValor(c: number) {
  return (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtData(d: Date) {
  return d.toLocaleDateString("pt-BR");
}

function renderProposta(html: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`\\{\\{${k}\\}\\}`, "gi"), v),
    html,
  );
}

function fmtCnpj(cnpj: string): string {
  const d = cnpj.replace(/\D/g, "");
  return d.length === 14
    ? `${d.slice(0,2)}.${d.slice(2,5)}.${d.slice(5,8)}/${d.slice(8,12)}-${d.slice(12)}`
    : cnpj;
}

/** Converte logoPath (caminho de disco) → data:URI base64, ou retorna null */
export function logoPathToBase64(logoPath: string | null | undefined): string | null {
  if (!logoPath || !existsSync(logoPath)) return null;
  const buf  = readFileSync(logoPath);
  const ext  = logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
  const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export function propostaHtmlPage(
  titulo: string,
  textoHtml: string,
  emitente: {
    id?: string;
    nome: string; nomeFantasia?: string | null; cnpj: string;
    logoSrc?: string | null;   // base64 data:URI ou URL absoluta
    cidade?: string | null; uf?: string | null;
    endereco?: string | null; numero?: string | null;
    complemento?: string | null; bairro?: string | null; cep?: string | null;
    telefone?: string | null; email?: string | null;
  },
  validadeAte?: Date | null,
  tomador?: { nome: string } | null,
): string {
  const emitenteNome = emitente.nomeFantasia || emitente.nome;
  const cnpjFmt      = fmtCnpj(emitente.cnpj);
  const localidade   = [emitente.cidade, emitente.uf].filter(Boolean).join("/");

  // Endereço completo para o header
  const endParts = [
    emitente.endereco && emitente.numero ? `${emitente.endereco}, ${emitente.numero}` : emitente.endereco,
    emitente.complemento,
    emitente.bairro,
    localidade,
    emitente.cep ? `CEP ${emitente.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
  ].filter(Boolean);
  const enderecoCompleto = endParts.join(" — ");

  // Substituir campos dinâmicos restantes no textoHtml
  const htmlFinal = textoHtml
    .replace(/\{\{emitente\}\}/gi, emitenteNome)
    .replace(/\{\{tomador\}\}/gi,  tomador?.nome ?? "")
    .replace(/\{\{cnpj\}\}/gi,     cnpjFmt)
    .replace(/\{\{cidade\}\}/gi,   localidade);

  const logoHtml = emitente.logoSrc
    ? `<img src="${emitente.logoSrc}" alt="${emitenteNome}"
            style="max-height:60px;max-width:180px;object-fit:contain;display:block;">`
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${titulo}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1a1a1a; background: #f4f6f9; }
    .page { max-width: 750px; margin: 30px auto; background: #fff; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08); overflow: hidden; }
    .header { background: #004a5c; color: #fff; padding: 20px 32px; display: flex; align-items: flex-start; gap: 20px; }
    .header-logo { flex-shrink: 0; background: #fff; border-radius: 6px; padding: 6px 8px; display: flex; align-items: center; justify-content: center; }
    .header-text { flex: 1; }
    .header h1 { font-size: 16pt; margin-bottom: 3px; line-height: 1.2; }
    .header .razao { font-size: 10pt; color: #7dd3e8; margin-bottom: 2px; }
    .header .detalhe { font-size: 8.5pt; color: #a5c8d4; margin-top: 2px; line-height: 1.4; }
    .body { padding: 32px; }
    .body h2 { font-size: 14pt; color: #004a5c; margin: 20px 0 8px; }
    .body h3 { font-size: 11pt; color: #004a5c; margin: 16px 0 6px; }
    .body p  { margin-bottom: 10px; line-height: 1.6; }
    .body ul, .body ol { margin: 8px 0 12px 20px; line-height: 1.7; }
    .validade { background: #fff8e1; border: 1px solid #ffc107; border-radius: 6px; padding: 10px 16px; margin-top: 20px; font-size: 9.5pt; color: #795548; }
    .footer { border-top: 1px solid #eee; padding: 16px 32px; font-size: 8.5pt; color: #999; text-align: center; }
    @media print { .page { box-shadow: none; margin: 0; border-radius: 0; } }
  </style>
</head>
<body>
<div class="page">
  <div class="header">
    ${logoHtml ? `<div class="header-logo">${logoHtml}</div>` : ""}
    <div class="header-text">
      <h1>${titulo}</h1>
      <p class="razao">${emitenteNome}${emitente.nome !== emitenteNome ? ` — ${emitente.nome}` : ""}</p>
      <p class="detalhe">CNPJ ${cnpjFmt}${enderecoCompleto ? `<br>${enderecoCompleto}` : ""}</p>
    </div>
  </div>
  <div class="body">
    ${htmlFinal}
    ${validadeAte ? `<div class="validade">⏳ Esta proposta é válida até <strong>${fmtData(validadeAte)}</strong>.</div>` : ""}
  </div>
  <div class="footer">${emitenteNome} · CNPJ ${cnpjFmt} · Documento gerado pelo sistema Avoce</div>
</div>
</body>
</html>`;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const propostaRouter = router({

  templates: authProc
    .input(z.object({ emitenteId: z.string().optional() }))
    .query(async ({ input, ctx }) => {
      if (input.emitenteId) assertEmitenteAccess(ctx, input.emitenteId);
      // Templates do tipo PROPOSTA salvos no banco têm prioridade
      const dbTemplates = input.emitenteId
        ? await (prisma as any).templateDocumento.findMany({
            where: { emitenteId: input.emitenteId, tipo: "PROPOSTA", ativo: true },
            orderBy: { titulo: "asc" },
          })
        : [];
      if (dbTemplates.length > 0) {
        return dbTemplates.map((t: any) => ({ id: t.id, titulo: t.titulo, html: t.textoHtml }));
      }
      // Fallback: templates hardcoded
      return TEMPLATES_PROPOSTA.map(t => ({ id: t.id, titulo: t.titulo, html: t.html }));
    }),

  listar: authProc
    .input(z.object({
      status:     z.string().optional(),
      emitenteId: z.string().optional(),
      // "PENDENTE" = só o que o agente gerou e ainda espera conferência humana
      revisao:    z.enum(["PENDENTE", "LIBERADA"]).optional(),
      page:       z.number().int().default(1),
      pageSize:   z.number().int().default(20),
    }))
    .query(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      const where = {
        ...emitenteFilter,
        ...(input.status     ? { status: input.status }         : {}),
        ...(input.emitenteId ? { emitenteId: input.emitenteId } : {}),
        ...(input.revisao    ? { revisaoStatus: input.revisao } : {}),
      } as any;
      const [propostas, total] = await Promise.all([
        prisma.proposta.findMany({
          where,
          include: {
            emitente: { select: { id: true, nome: true, nomeFantasia: true, cnpj: true, cidade: true } },
            tomador:  { select: { id: true, nome: true, email: true, telefone: true } },
            contrato: { select: { id: true } },
          },
          orderBy: { criadoEm: "desc" },
          skip:  (input.page - 1) * input.pageSize,
          take:  input.pageSize,
        }),
        prisma.proposta.count({ where }),
      ]);
      return {
        propostas: propostas.map(p => ({
          ...p,
          paktSignedPdfPath: (p as any).paktSignedPdfPath as string | null ?? null,
        })),
        total,
        pages: Math.ceil(total / input.pageSize),
      };
    }),

  obterPorToken: authProc
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      return prisma.proposta.findUniqueOrThrow({
        where: { tokenAceite: input.token },
        include: {
          emitente: { select: { nome: true, nomeFantasia: true, cnpj: true, cidade: true, logoPath: true } },
          tomador:  { select: { nome: true, email: true } },
        },
      });
    }),

  criar: authProc
    .input(z.object({
      emitenteId:    z.string(),
      tomadorId:     z.string(),
      titulo:        z.string().min(3),
      textoHtml:     z.string().min(10),
      valorEstimado: z.number().int().positive().optional().nullable(),
      validadeAte:   z.string().optional().nullable(),
      paktSignUrl:   z.string().url().optional().nullable(),
      // parâmetros do contrato
      contratoDiaVencimento:     z.number().int().min(1).max(30).optional().nullable(),
      contratoMetodoCobr:        z.enum(["PIX_BOLETO","PIX","BOLETO","NENHUM","ALVARA"]).optional().nullable(),
      contratoTipoContrato:      z.enum(["RECORRENTE","PARCELADO","EVENTUAL"]).optional().nullable(),
      contratoTotalParcelas:     z.number().int().positive().optional().nullable(),
      contratoEmitirNfseAuto:    z.boolean().optional().nullable(),
      contratoGerarCobrancaAuto: z.boolean().optional().nullable(),
      contratoIssRetido:         z.boolean().optional().nullable(),
      contratoDescricao:         z.string().optional().nullable(),
      templatesGerar:            z.array(z.string()).optional().nullable(),
      honorariosExitoPerc:       z.number().min(0.01).max(100).optional().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return prisma.proposta.create({
        data: {
          emitenteId:    input.emitenteId,
          tomadorId:     input.tomadorId,
          titulo:        input.titulo,
          textoHtml:     input.textoHtml,
          valorEstimado: input.valorEstimado ?? null,
          validadeAte:   input.validadeAte ? new Date(input.validadeAte) : null,
          paktSignUrl:   input.paktSignUrl ?? null,
          status:        "RASCUNHO",
          contratoDiaVencimento:     input.contratoDiaVencimento ?? null,
          contratoMetodoCobr:        input.contratoMetodoCobr ?? "PIX_BOLETO",
          contratoTipoContrato:      input.contratoTipoContrato ?? "RECORRENTE",
          contratoTotalParcelas:     input.contratoTotalParcelas ?? null,
          contratoEmitirNfseAuto:    input.contratoEmitirNfseAuto ?? false,
          contratoGerarCobrancaAuto: input.contratoGerarCobrancaAuto ?? true,
          contratoIssRetido:         input.contratoIssRetido ?? false,
          contratoDescricao:         input.contratoDescricao ?? null,
          templatesGerar:            input.templatesGerar ? JSON.stringify(input.templatesGerar) : null,
          honorariosExitoPerc:       input.honorariosExitoPerc ?? null,
        } as any,
        include: {
          emitente: { select: { id: true, nome: true, nomeFantasia: true, cnpj: true } },
          tomador:  { select: { id: true, nome: true, email: true } },
        },
      });
    }),

  atualizar: authProc
    .input(z.object({
      id:            z.string(),
      titulo:        z.string().min(3).optional(),
      textoHtml:     z.string().min(10).optional(),
      valorEstimado: z.number().int().positive().optional().nullable(),
      validadeAte:   z.string().optional().nullable(),
      paktSignUrl:   z.string().optional().nullable(),
      status:        z.enum(["RASCUNHO", "ENVIADA", "ACEITA", "RECUSADA", "EM_NEGOCIACAO"]).optional(),
      contratoDiaVencimento:     z.number().int().min(1).max(30).optional().nullable(),
      contratoMetodoCobr:        z.enum(["PIX_BOLETO","PIX","BOLETO","NENHUM","ALVARA"]).optional().nullable(),
      contratoTipoContrato:      z.enum(["RECORRENTE","PARCELADO","EVENTUAL"]).optional().nullable(),
      contratoTotalParcelas:     z.number().int().positive().optional().nullable(),
      contratoEmitirNfseAuto:    z.boolean().optional().nullable(),
      contratoGerarCobrancaAuto: z.boolean().optional().nullable(),
      contratoIssRetido:         z.boolean().optional().nullable(),
      contratoDescricao:         z.string().optional().nullable(),
      templatesGerar:            z.array(z.string()).optional().nullable(),
      honorariosExitoPerc:       z.number().min(0.01).max(100).optional().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, validadeAte, templatesGerar, ...rest } = input;
      const p = await prisma.proposta.findUniqueOrThrow({ where: { id }, select: { emitenteId: true } });
      assertEmitenteAccess(ctx, p.emitenteId);
      return prisma.proposta.update({
        where: { id },
        data: {
          ...rest,
          ...(validadeAte !== undefined ? { validadeAte: validadeAte ? new Date(validadeAte) : null } : {}),
          ...(templatesGerar !== undefined ? { templatesGerar: templatesGerar ? JSON.stringify(templatesGerar) : null } : {}),
        } as any,
      });
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const p = await prisma.proposta.findUniqueOrThrow({ where: { id: input.id }, select: { emitenteId: true, status: true } });
      assertEmitenteAccess(ctx, p.emitenteId);
      if (p.status !== "RASCUNHO") throw new Error("Apenas rascunhos podem ser excluídos");
      return prisma.proposta.delete({ where: { id: input.id } });
    }),

  enviarEmail: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const p = await prisma.proposta.findUniqueOrThrow({
        where: { id: input.id },
        include: { emitente: true, tomador: true },
      });
      assertEmitenteAccess(ctx, p.emitenteId);

      if (!p.tomador.email) throw new Error("Tomador não possui e-mail cadastrado");
      if (!p.emitente.smtpHost || !p.emitente.smtpUser)
        throw new Error("SMTP não configurado para esta empresa");

      const { propostaPdf, docAttachments, paktDocs, baseUrl, emitenteNome } =
        await prepararEnvioProposta(p);

      // ── 5. Montar e enviar e-mail ──────────────────────────────────────────────
      const usandoPakt    = paktDocs.length > 0;
      const temDocs       = docAttachments.length > 0;
      const linkAceite    = `${baseUrl}/api/proposta/${p.tokenAceite}`;

      const fromName  = p.emitente.smtpFrom && !p.emitente.smtpFrom.includes("@") ? p.emitente.smtpFrom : null;
      const fromEmail = p.emitente.smtpUser;
      const fromField = fromName ? `"${fromName}" <${fromEmail}>` : (p.emitente.smtpFrom ?? fromEmail);

      const smtpProposta: SmtpConfig = {
        host:   p.emitente.smtpHost,
        port:   p.emitente.smtpPort ?? 587,
        secure: p.emitente.smtpPort === 465,
        user:   p.emitente.smtpUser,
        pass:   fieldDecrypt(p.emitente.smtpPass),
        from:   fromField,
      };

      const cnpjFmtEmail = fmtCnpj(p.emitente.cnpj);
      const valorStr     = p.valorEstimado ? fmtValor(p.valorEstimado) : null;
      const endPartsEmail = [
        p.emitente.endereco && p.emitente.numero ? `${p.emitente.endereco}, ${p.emitente.numero}` : p.emitente.endereco,
        p.emitente.complemento, p.emitente.bairro,
        [p.emitente.cidade, p.emitente.uf].filter(Boolean).join("/"),
        p.emitente.cep ? `CEP ${p.emitente.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}` : null,
      ].filter(Boolean).join(" — ");

      // Todos os PDFs como anexo (proposta + docs gerados)
      const allAttachments: EnvioAtt[] = [
        ...(propostaPdf ? [{ filename: `Proposta-${p.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`, content: propostaPdf, contentType: "application/pdf" as const }] : []),
        ...docAttachments,
      ];

      // Logo via CID para funcionar no Gmail/Outlook
      const logoPath   = p.emitente.logoPath && existsSync(p.emitente.logoPath) ? p.emitente.logoPath : null;
      const logoCid    = "logo@avoce";
      const logoExt    = logoPath?.split(".").pop()?.toLowerCase() ?? "png";
      const logoMime   = logoExt === "png" ? "image/png" : logoExt === "svg" ? "image/svg+xml" : "image/jpeg";

      // Botões de assinatura: um por documento PAKT, ou link de aceite simples
      const botoesAssinatura = usandoPakt
        ? paktDocs.map((d, i) => `
          <tr><td style="padding:${i === 0 ? "24px" : "0"} 32px ${i === paktDocs.length - 1 ? "24px" : "8px"}">
            <p style="margin:0 0 8px;font-size:13px;color:#374151">
              <strong>📄 ${d.titulo}</strong>
            </p>
            <a href="${d.signUrl}"
               style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;padding:11px 28px;border-radius:8px;font-size:14px;font-weight:bold;">
              ✍️ Assinar
            </a>
          </td></tr>`).join("")
        : `<tr><td style="padding:24px 32px">
            <p style="margin:0 0 12px;font-size:14px;color:#374151">Para aceitar esta proposta, clique no botão abaixo:</p>
            <a href="${linkAceite}"
               style="display:inline-block;background:#004a5c;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:15px;font-weight:bold;">
              ✅ Aceitar Proposta
            </a>
          </td></tr>`;

      const htmlEmail = `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
           style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
      <!-- Header -->
      <tr><td style="background:#004a5c;padding:20px 32px">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          ${logoPath ? `<td style="width:80px;vertical-align:middle;padding-right:16px">
            <img src="cid:${logoCid}" alt="${emitenteNome}"
                 style="max-width:80px;max-height:50px;object-fit:contain;display:block;background:#fff;border-radius:4px;padding:4px">
          </td>` : ""}
          <td style="vertical-align:middle">
            <p style="margin:0;color:#fff;font-size:18px;font-weight:bold;line-height:1.2">${p.titulo}</p>
            <p style="margin:3px 0 0;color:#7dd3e8;font-size:12px">${emitenteNome}</p>
            <p style="margin:2px 0 0;color:#a5c8d4;font-size:10px">CNPJ ${cnpjFmtEmail}${endPartsEmail ? ` — ${endPartsEmail}` : ""}</p>
          </td>
        </tr></table>
      </td></tr>
      <!-- Corpo -->
      <tr><td style="padding:24px 32px 0">
        <p style="margin:0 0 12px;font-size:14px;color:#374151">Prezado(a) <strong>${p.tomador.nome}</strong>,</p>
        <p style="margin:0 0 16px;font-size:14px;color:#555">
          Encaminhamos ${temDocs ? "a proposta e os documentos para assinatura" : "a proposta de serviços"} em anexo.
          ${valorStr ? `<br>Valor: <strong>${valorStr}</strong>.` : ""}
          ${p.validadeAte ? `<br>Válida até: <strong>${fmtData(p.validadeAte)}</strong>.` : ""}
        </p>
        ${allAttachments.length > 0 ? `
        <p style="margin:0 0 16px;font-size:13px;color:#374151"><strong>Anexos:</strong></p>
        <ul style="margin:0 0 16px;padding-left:18px;font-size:13px;color:#374151;line-height:1.8">
          ${allAttachments.map(a => `<li>📄 ${a.filename}</li>`).join("")}
        </ul>` : ""}
        ${usandoPakt ? `<p style="margin:0 0 0;font-size:13px;color:#374151">Para assinar cada documento, clique no botão correspondente:</p>` : ""}
      </td></tr>
      <!-- Botões de assinatura -->
      ${botoesAssinatura}
      ${usandoPakt ? `<tr><td style="padding:0 32px 24px">
        <p style="margin:0;font-size:12px;color:#6b7280">A assinatura é realizada com verificação de identidade bancária via <strong>PAKT</strong>.</p>
      </td></tr>` : ""}
      <!-- Footer -->
      <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center">
        <p style="margin:0;font-size:11px;color:#94a3b8">${emitenteNome} · CNPJ ${cnpjFmtEmail} · E-mail automático via Avoce</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

      await sendMailAndSave(smtpProposta, {
        from:    fromField,
        to:      p.tomador.email,
        subject: `${temDocs ? "Documentos para assinar" : "Proposta"}: ${p.titulo} — ${emitenteNome}`,
        html:    htmlEmail,
        attachments: [
          ...allAttachments,
          ...(logoPath ? [{ filename: `logo.${logoExt}`, path: logoPath, cid: logoCid, contentType: logoMime }] : []),
        ],
      });

      console.log(`[Proposta] E-mail enviado para ${p.tomador.email}: ${allAttachments.length} anexo(s), ${paktDocs.length} link(s) PAKT`);

      await prisma.proposta.update({
        where: { id: p.id },
        data:  {
          status: "ENVIADA",
          // Mandar por e-mail É liberar: sem isto o card ficaria "em revisão" para sempre
          ...((p as any).revisaoStatus === "PENDENTE"
            ? { revisaoStatus: "LIBERADA", revisadoEm: new Date() }
            : {}),
        } as any,
      });

      return { ok: true, usandoPakt, docsGerados: docAttachments.length, paktDocs: paktDocs.length };
    }),

  enviarWhatsApp: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const p = await prisma.proposta.findUniqueOrThrow({
        where: { id: input.id },
        include: { emitente: true, tomador: true },
      }) as any;
      assertEmitenteAccess(ctx, p.emitenteId);

      const telefone: string | null = p.tomador.telefone ?? null;
      if (!telefone) throw new Error("Tomador não possui telefone cadastrado");

      // Mesmo preparo do e-mail: gera documentos e envelopes PAKT (quando o
      // tomador tem e-mail, exigido pelo PAKT como signatário). Sem e-mail o
      // link enviado é o da página de aceite da proposta.
      const { paktDocs } = await prepararEnvioProposta(p);

      const phone = telefone.replace(/\D/g, "");
      const to = phone.startsWith("55") ? phone : `55${phone}`;

      // Instância do WhatsApp POR ESCRITÓRIO: PSA → Judite (psa-docs), RAP →
      // Isabella (avoce). Vem de Configuracao.whatsapp_evolution_<empresaId>
      // (fallback: projeto de IA do escritório). Antes saía tudo pela RAP.
      const evo = await getEvolutionConfigForEmitente(p.emitente);
      if (!evo) throw new Error(`WhatsApp (Evolution) não configurado para o escritório ${p.emitente.nome} — cadastre Configuracao.whatsapp_evolution_${p.emitente.empresaId ?? "<empresaId>"}`);

      const appUrl = process.env.APP_BASE_URL ?? "https://avoce.com.br";
      const nome = (p.tomador.nome as string).split(" ")[0];
      const emitenteNome = p.emitente.nomeFantasia || p.emitente.nome;

      // Links: um por documento PAKT (criados agora ou já existentes), senão o aceite
      let links: string[] = paktDocs.map(d => `${d.titulo}:\n${d.signUrl}`);
      if (links.length === 0 && p.paktSignUrl) links = [p.paktSignUrl];
      const texto = links.length > 0
        ? `Olá, ${nome}! Segue${links.length > 1 ? "m os links" : " o link"} para assinar ${links.length > 1 ? "os documentos" : "o documento"} de ${emitenteNome}:\n\n${links.join("\n\n")}\n\nQualquer dúvida é só falar. 👍`
        : `Olá, ${nome}! Segue o link da sua proposta "${p.titulo}" de ${emitenteNome} para aprovação:\n\n${appUrl}/api/proposta/${p.tokenAceite}\n\nQualquer dúvida é só falar. 👍`;

      await sendText(evo, to, texto);
      console.log(`[Proposta] WhatsApp via instância ${evo.instancia} (escritório ${p.emitente.nome})`);
      console.log(`[Proposta] WhatsApp enviado para ${to}: ${links.length} link(s) PAKT`);

      if (p.status === "RASCUNHO" || p.revisaoStatus === "PENDENTE") {
        await prisma.proposta.update({
          where: { id: p.id },
          data: {
            ...(p.status === "RASCUNHO" ? { status: "ENVIADA" } : {}),
            ...(p.revisaoStatus === "PENDENTE" ? { revisaoStatus: "LIBERADA", revisadoEm: new Date() } : {}),
          } as any,
        });
      }
      return { ok: true, usandoPakt: links.length > 0, paktDocs: paktDocs.length };
    }),

  // Quantas propostas do agente estão paradas esperando revisão (badge do menu)
  pendentesDeRevisao: authProc
    .query(async ({ ctx }) => {
      return prisma.proposta.count({
        where: { ...whereEmitenteFilter(ctx), revisaoStatus: "PENDENTE" } as any,
      });
    }),

  // Revisão aprovada: converte em contrato, cria os envelopes no PAKT e manda os
  // links ao cliente pela mesma instância de WhatsApp que fez a coleta.
  liberarParaAssinatura: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const p = await prisma.proposta.findUniqueOrThrow({
        where:  { id: input.id },
        select: { emitenteId: true, revisaoStatus: true } as any,
      }) as any;
      assertEmitenteAccess(ctx, p.emitenteId);
      if (p.revisaoStatus === "LIBERADA") throw new Error("Esta proposta já foi liberada para assinatura");

      const { enviarPropostaParaAssinatura } = await import("../agent/proposal-engine.js");
      const revisor = ctx.userId
        ? await prisma.usuario.findUnique({ where: { id: ctx.userId }, select: { nome: true, email: true } })
        : null;
      const revisadoPor = revisor?.nome || revisor?.email || ctx.userId;
      const r = await enviarPropostaParaAssinatura(input.id, { revisadoPor });

      const docs = await (prisma as any).documentoGerado.count({ where: { propostaId: input.id } });
      return { ok: true, enviado: r.enviado, paktDocs: r.paktDocs, docs };
    }),

  converterEmContrato: authProc
    .input(z.object({
      id:               z.string(),
      // campos obrigatórios do contrato que não estão na proposta
      descricaoServico: z.string().min(5),
      nomeServico:      z.string().optional().nullable(),
      valor:            z.number().int().positive(),
      diaVencimento:    z.number().int().min(1).max(30),
      metodoCobr:       z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]).default("PIX_BOLETO"),
      emitirNfseAuto:   z.boolean().default(false),
      gerarCobrancaAuto:z.boolean().default(true),
      tipoContrato:     z.enum(["RECORRENTE", "PARCELADO", "EVENTUAL"]).default("RECORRENTE"),
      totalParcelas:    z.number().int().positive().optional().nullable(),
      issRetido:        z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => {
      const p = await prisma.proposta.findUniqueOrThrow({
        where: { id: input.id },
        select: { emitenteId: true, contratoId: true, tomadorId: true },
      });
      if (p.contratoId) throw new Error("Proposta já convertida em contrato");
      assertEmitenteAccess(ctx, p.emitenteId);

      const { id: propostaId, ...contratoData } = input;

      const contrato = await prisma.contrato.create({
        data: {
          emitenteId:        p.emitenteId,
          tomadorId:         p.tomadorId,
          nomeServico:       contratoData.nomeServico ?? null,
          descricaoServico:  contratoData.descricaoServico,
          valor:             contratoData.valor,
          diaVencimento:     contratoData.diaVencimento,
          metodoCobr:        contratoData.metodoCobr,
          emitirNfseAuto:    contratoData.emitirNfseAuto,
          gerarCobrancaAuto: contratoData.gerarCobrancaAuto,
          tipoContrato:      contratoData.tipoContrato,
          totalParcelas:     contratoData.totalParcelas ?? null,
          issRetido:         contratoData.issRetido,
        },
      });

      await prisma.proposta.update({
        where: { id: propostaId },
        data:  { contratoId: contrato.id, status: "ACEITA" },
      });

      return contrato;
    }),
});
