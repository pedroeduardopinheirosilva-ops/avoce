// ─────────────────────────────────────────────────────────────────────────────
// Envio de e-mail de cobrança (Nota de Honorários + Boleto em PDF)
// Chamado após gerar cobrança (PIX / Boleto) no router ou no cron
// ─────────────────────────────────────────────────────────────────────────────

import nodemailer                       from "nodemailer";
import { existsSync, readFileSync }    from "node:fs";
import { join }                        from "node:path";
import { prisma }                      from "../db.js";
import { renderTemplate }              from "./template.js";
import { gerarCartaCobrancaHtml }      from "./cobranca-html.js";
import { gerarBoletoHtml }             from "./boleto-html.js";
import { htmlToPdf }                   from "./pdf.js";
import { LOGOS_DIR }                   from "../upload.js";
import type { SmtpConfig }             from "./email.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtValor(c: number) {
  return (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtData(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function loadLogoBase64(logoPath: string | null | undefined): string | undefined {
  if (!logoPath || !existsSync(logoPath)) return undefined;
  try {
    const buf  = readFileSync(logoPath);
    const ext  = logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch { return undefined; }
}
function loadSicoobLogo(): string | undefined {
  try {
    const p = join(LOGOS_DIR, "sicoob.png");
    if (existsSync(p)) return `data:image/png;base64,${readFileSync(p).toString("base64")}`;
  } catch { /* ignora */ }
  return undefined;
}

// ── Barcode ITF-25 para email — tabela HTML (Gmail bloqueia SVG) ─────────────

function barcodeEmailTable(code: string): string {
  // N=1px, W=2px → barcode total ~320px para 44 dígitos; cabe em qualquer email
  const N = 1, W = 2, H = 48;
  const enc: Record<string, string> = {
    "0": "nnwwn", "1": "wnnnw", "2": "nwnnw", "3": "wwnnn", "4": "nnwnw",
    "5": "wnwnn", "6": "nwwnn", "7": "nnnww", "8": "wnnwn", "9": "nwnwn",
  };
  const raw = code.replace(/\D/g, "");
  const s   = raw.length % 2 === 0 ? raw : "0" + raw;
  const cells: { w: number; black: boolean }[] = [];
  // Start: NNNN
  cells.push({ w:N, black:true }, { w:N, black:false }, { w:N, black:true }, { w:N, black:false });
  for (let i = 0; i < s.length; i += 2) {
    const bE = enc[s[i]], sE = enc[s[i + 1]];
    if (!bE || !sE) continue;
    for (let j = 0; j < 5; j++) {
      cells.push({ w: bE[j] === "w" ? W : N, black: true  });
      cells.push({ w: sE[j] === "w" ? W : N, black: false });
    }
  }
  // Stop: WNN
  cells.push({ w:W, black:true }, { w:N, black:false }, { w:N, black:true });

  const tds = cells
    .map(c => `<td style="width:${c.w}px;height:${H}px;background:${c.black ? "#000" : "#fff"};padding:0;font-size:0;line-height:0;"></td>`)
    .join("");

  return `<table cellpadding="0" cellspacing="0" border="0"
    style="border-collapse:collapse;height:${H}px;background:#fff;"><tr>${tds}</tr></table>`;
}

// ── Template HTML do corpo do e-mail ─────────────────────────────────────────

function corpoEmail(params: {
  emitenteNome:         string;
  logoHasCid:           boolean;   // true quando logo está anexada como cid:emitente_logo
  tomadorNome:          string;
  competencia:          string;
  vencimento:           string;
  valor:                number;
  nomeServico?:         string;
  pixBrcode?:           string;
  pixQrcodeHasCid:      boolean;   // true quando o QR está anexado como cid:pix_qrcode
  boletoLinhaDigitavel?: string;
  boletoCodigoBarras?:  string;
  temAnexos:            boolean;
}): string {
  const v = fmtValor(params.valor);
  const d = fmtData(params.vencimento);

  const pixSection = params.pixBrcode ? `
    <tr><td style="padding:0 32px 24px">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#f0faf4;border-radius:8px;border:1px solid #86efac;padding:16px">
        <tr>
          ${params.pixQrcodeHasCid ? `
          <td width="146" style="vertical-align:top;padding-right:16px">
            <img src="cid:pix_qrcode" width="130" height="130"
                 style="display:block;border-radius:4px;border:1px solid #d1fae5;" alt="QR Code PIX">
          </td>` : ""}
          <td style="vertical-align:top">
            <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#15803d;text-transform:uppercase;letter-spacing:.5px">⚡ PIX — Pagamento instantâneo</p>
            <p style="margin:0 0 4px;font-size:11px;color:#374151;">Copie o código Copia e Cola:</p>
            <div style="background:#fff;border:1px solid #d1fae5;border-radius:4px;padding:8px;
                        font-family:monospace;font-size:10px;color:#065f46;word-break:break-all;">${params.pixBrcode}</div>
          </td>
        </tr>
      </table>
    </td></tr>` : "";

  const boletoSection = params.boletoLinhaDigitavel ? `
    <tr><td style="padding:0 32px 24px">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#eef4f8;border-radius:8px;border:1px solid #b6cfd9;padding:16px">
        <tr><td>
          <p style="margin:0 0 8px;font-size:12px;font-weight:bold;color:#004a5c;text-transform:uppercase;letter-spacing:.5px">🏦 Boleto Bancário</p>
          <p style="margin:0 0 6px;font-size:11px;color:#374151;">Linha digitável:</p>
          <div style="background:#fff;border:1px solid #b6cfd9;border-radius:4px;padding:10px;
                      font-family:monospace;font-size:11px;color:#004a5c;font-weight:bold;
                      letter-spacing:0.5px;word-break:break-all;text-align:center;">${params.boletoLinhaDigitavel}</div>
          ${params.boletoCodigoBarras ? `
          <p style="margin:12px 0 6px;font-size:11px;color:#374151;">Código de barras:</p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:10px;">
            ${barcodeEmailTable(params.boletoCodigoBarras)}
          </div>` : ""}
          <p style="margin:8px 0 0;font-size:10px;color:#888;">Vencimento: ${d} &nbsp;·&nbsp; Valor: ${v}</p>
        </td></tr>
      </table>
    </td></tr>` : "";

  return `<!DOCTYPE html>
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
            ${params.logoHasCid ? `
            <td width="80" style="vertical-align:middle;padding-right:16px">
              <img src="cid:emitente_logo" width="70" height="70"
                   style="display:block;border-radius:6px;object-fit:contain;background:#fff;padding:4px;" alt="Logo">
            </td>` : ""}
            <td style="vertical-align:middle">
              <p style="margin:0;color:#fff;font-size:20px;font-weight:bold">Cobrança — ${params.competencia}</p>
              <p style="margin:4px 0 0;color:#7dd3e8;font-size:13px">${params.emitenteNome}</p>
            </td>
          </tr></table>
        </td></tr>

        <!-- Saudação -->
        <tr><td style="padding:24px 32px 0">
          <p style="margin:0 0 16px;font-size:14px;color:#374151">
            Prezado(a) <strong>${params.tomadorNome}</strong>,
          </p>
          <p style="margin:0 0 24px;font-size:14px;color:#555">
            Encaminhamos o faturamento referente a
            <strong>${params.nomeServico || "serviços prestados"}</strong>
            — competência ${params.competencia}.
          </p>
        </td></tr>

        <!-- Dados da cobrança -->
        <tr><td style="padding:0 32px 24px">
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
            <tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Competência</td>
                <td align="right" style="font-size:14px;color:#1e293b;font-weight:bold">${params.competencia}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Vencimento</td>
                <td align="right" style="font-size:14px;color:#1e293b;font-weight:bold">${d}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 20px">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Valor</td>
                <td align="right" style="font-size:18px;font-weight:bold;color:#16a34a">${v}</td>
              </tr></table>
            </td></tr>
          </table>
        </td></tr>

        <!-- PIX -->
        ${pixSection}

        <!-- Boleto -->
        ${boletoSection}

        <!-- Documentos em anexo -->
        ${params.temAnexos ? `
        <tr><td style="padding:0 32px 24px">
          <p style="margin:0;font-size:13px;color:#6b7280;background:#f8fafc;border-left:3px solid #004a5c;
                    padding:10px 14px;border-radius:0 6px 6px 0;">
            📎 Os documentos completos (Nota de Honorários${params.boletoLinhaDigitavel ? " e Boleto Bancário" : ""}) estão em anexo neste e-mail.
          </p>
        </td></tr>` : ""}

        <!-- Footer -->
        <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8">
            E-mail automático gerado pelo sistema Avoce.<br>
            ${params.emitenteNome}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Função principal ──────────────────────────────────────────────────────────

export async function enviarEmailCobranca(cobrancaId: string): Promise<void> {
  const cobranca = await prisma.cobranca.findUnique({
    where: { id: cobrancaId },
    include: { emitente: true, contrato: { include: { tomador: true } } },
  });
  if (!cobranca) {
    console.warn(`[Email-Cob] Cobrança ${cobrancaId} não encontrada`);
    return;
  }

  // ── SMTP ──
  const emp = cobranca.emitente;
  if (!emp.smtpHost || !emp.smtpUser) {
    console.log(`[Email-Cob] SMTP não configurado para empresa ${emp.nome} — e-mail não enviado`);
    return;
  }

  const destinatarios: string[] = [];
  const tomadorEmail = cobranca.contrato.tomador.email;
  if (tomadorEmail) destinatarios.push(tomadorEmail);
  if (emp.email && emp.email !== tomadorEmail) destinatarios.push(emp.email);

  if (!destinatarios.length) {
    console.log(`[Email-Cob] Cobrança ${cobrancaId}: sem e-mails cadastrados — não enviado`);
    return;
  }

  // Montar o campo "from" corretamente: se smtpFrom não contém "@", é um nome
  // de exibição e precisa ser combinado com o smtpUser
  const fromEmail = emp.smtpUser;
  const fromName  = emp.smtpFrom && !emp.smtpFrom.includes("@") ? emp.smtpFrom : null;
  const fromField = fromName ? `"${fromName}" <${fromEmail}>` : (emp.smtpFrom ?? fromEmail);

  const smtp: SmtpConfig = {
    host:   emp.smtpHost,
    port:   emp.smtpPort ?? 587,
    secure: emp.smtpPort === 465,   // SSL apenas se porta for explicitamente 465
    user:   emp.smtpUser,
    pass:   emp.smtpPass   ?? "",
    from:   fromField,
  };

  // ── Variáveis de template ──
  const vars = {
    competencia: cobranca.competencia,
    vencimento:  cobranca.vencimento,
    valor:       cobranca.valor,
    emitente:    emp.nomeFantasia || emp.nome,
    tomador:     cobranca.contrato.tomador.nome,
    servico:     cobranca.contrato.nomeServico ?? undefined,
  };

  // ── NFS-e emitida para esta competência ──
  const notaFiscal = await prisma.notaFiscal.findFirst({
    where: {
      contratoId:  cobranca.contratoId,
      competencia: cobranca.competencia,
      status:      "EMITIDA",
    },
    orderBy: { emitidoEm: "desc" },
  });

  // ── Logos ──
  const logoBase64   = loadLogoBase64(emp.logoPath);
  const sicoobLogo   = loadSicoobLogo();

  // ── Gerar carta de cobrança (PDF) ──
  let cartaPdf: Buffer | undefined;
  try {
    const cartaHtml = gerarCartaCobrancaHtml({
      emitente: {
        nome:         emp.nome,
        nomeFantasia: emp.nomeFantasia ?? undefined,
        cnpj:         emp.cnpj,
        endereco:     emp.endereco    ?? undefined,
        numero:       emp.numero      ?? undefined,
        complemento:  emp.complemento ?? undefined,
        bairro:       emp.bairro      ?? undefined,
        cidade:       emp.cidade      ?? undefined,
        uf:           emp.uf          ?? undefined,
        cep:          emp.cep         ?? undefined,
        email:        emp.email       ?? undefined,
        telefone:     emp.telefone    ?? undefined,
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
      nomeServico:   cobranca.contrato.nomeServico    ?? undefined,
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
      nfse: notaFiscal ? {
        numero:      notaFiscal.numero!,
        emitidoEm:   notaFiscal.emitidoEm,
        codigoVerif: notaFiscal.codigoVerif,
        linkNfse:    notaFiscal.linkNfse,
      } : undefined,
    });
    cartaPdf = await htmlToPdf(cartaHtml);
  } catch (err) {
    console.error(`[Email-Cob] Falha ao gerar carta PDF:`, err);
  }

  // ── Gerar boleto (PDF) ──
  let boletoPdf: Buffer | undefined;
  if (cobranca.boletoNossoNumero) {
    try {
      const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const boletoHtml = gerarBoletoHtml({
        beneficiario: {
          nome:            emp.nome,
          cnpj:            emp.cnpj,
          endereco:        emp.endereco    ?? undefined,
          numero:          emp.numero      ?? undefined,
          complemento:     emp.complemento ?? undefined,
          bairro:          emp.bairro      ?? undefined,
          cidade:          emp.cidade      ?? undefined,
          uf:              emp.uf          ?? undefined,
          cep:             emp.cep         ?? undefined,
          cooperativa:     "3226",
          codBeneficiario: emp.boletoNumeroCliente ?? "161756",
          carteira:        emp.boletoModalidade    ?? "1",
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
      boletoPdf = await htmlToPdf(boletoHtml);
    } catch (err) {
      console.error(`[Email-Cob] Falha ao gerar boleto PDF:`, err);
    }
  }

  // ── Montar e-mail ──
  const transporter = nodemailer.createTransport({
    host:       smtp.host,
    port:       smtp.port,
    secure:     smtp.secure,
    requireTLS: !smtp.secure,  // STARTTLS quando não for SSL direto
    auth:       { user: smtp.user, pass: smtp.pass },
    tls:        { rejectUnauthorized: false },
  });

  const emitenteNome = emp.nomeFantasia || emp.nome;
  const assunto = `Cobrança ${cobranca.competencia} — ${cobranca.contrato.nomeServico || emitenteNome} — ${fmtValor(cobranca.valor)}`;

  // ── Preparar imagens CID (inline) ──
  // QR Code PIX: extrair base64 do data URL e anexar como cid:pix_qrcode
  let pixQrcodeBase64: Buffer | null = null;
  if (cobranca.pixQrcode) {
    const m = cobranca.pixQrcode.match(/^data:image\/png;base64,(.+)$/);
    if (m) pixQrcodeBase64 = Buffer.from(m[1], "base64");
  }

  // Logo da empresa: extrair base64 para cid:emitente_logo
  let logoBuffer: Buffer | null = null;
  let logoMime   = "image/jpeg";
  if (emp.logoPath && existsSync(emp.logoPath)) {
    try {
      logoBuffer = readFileSync(emp.logoPath);
      const ext  = emp.logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
      logoMime   = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
    } catch { /* ignora */ }
  }

  const attachments: nodemailer.SendMailOptions["attachments"] = [];

  // Anexos inline (CID)
  if (pixQrcodeBase64) {
    attachments.push({
      cid:         "pix_qrcode",
      filename:    "qrcode-pix.png",
      content:     pixQrcodeBase64,
      contentType: "image/png",
    });
  }
  if (logoBuffer) {
    attachments.push({
      cid:         "emitente_logo",
      filename:    "logo-emitente",
      content:     logoBuffer,
      contentType: logoMime,
    });
  }

  // Anexos PDF
  if (cartaPdf) {
    const comp = cobranca.competencia.replace("/", "-");
    attachments.push({
      filename:    `Carta-Cobranca-${comp}.pdf`,
      content:     cartaPdf,
      contentType: "application/pdf",
    });
  }
  if (boletoPdf) {
    attachments.push({
      filename:    `Boleto-${cobranca.boletoNossoNumero}.pdf`,
      content:     boletoPdf,
      contentType: "application/pdf",
    });
  }

  const html = corpoEmail({
    emitenteNome,
    logoHasCid:           !!logoBuffer,
    tomadorNome:          cobranca.contrato.tomador.nome,
    competencia:          cobranca.competencia,
    vencimento:           cobranca.vencimento,
    valor:                cobranca.valor,
    nomeServico:          cobranca.contrato.nomeServico ?? undefined,
    pixBrcode:            cobranca.pixBrcode            ?? undefined,
    pixQrcodeHasCid:      !!pixQrcodeBase64,
    boletoLinhaDigitavel: cobranca.boletoLinhaDigitavel ?? undefined,
    boletoCodigoBarras:   cobranca.boletoCodigoBarras   ?? undefined,
    temAnexos:            !!(cartaPdf || boletoPdf),
  });

  try {
    const info = await transporter.sendMail({
      from:        smtp.from || smtp.user,
      to:          destinatarios.join(", "),
      subject:     assunto,
      html,
      attachments,
    });
    console.log(`[Email-Cob] Cobrança ${cobrancaId} enviada para ${destinatarios.join(", ")} (msgId=${info.messageId})`);
  } catch (err) {
    console.error(`[Email-Cob] Falha ao enviar cobrança ${cobrancaId}:`, err);
  }
}
