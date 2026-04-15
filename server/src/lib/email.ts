// ── Envio de NFS-e por e-mail ─────────────────────────────────────────────────
// Envia a NFS-e emitida para o tomador e para o emitente.
// Configuração SMTP via cobranca-config.json (campos EMAIL_*).

import nodemailer from "nodemailer";

function fmtValor(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export interface SmtpConfig {
  host:   string;
  port:   number;
  secure: boolean;
  user:   string;
  pass:   string;
  from:   string;
}

function criarTransporter(smtp: SmtpConfig) {
  // Porta 465 → SSL direto; demais portas → STARTTLS (evita "wrong version number")
  const secure = smtp.port === 465;
  return nodemailer.createTransport({
    host:       smtp.host,
    port:       smtp.port,
    secure,
    requireTLS: !secure,   // força upgrade STARTTLS em 587/25
    auth:       { user: smtp.user, pass: smtp.pass },
    tls:        { rejectUnauthorized: false },
  });
}

export interface NfseEmailParams {
  // NFS-e
  numero:      string;
  competencia: string;
  valor:       number;       // centavos
  discriminacao: string;
  linkNfse?:   string;
  codigoVerif?: string;
  // Partes
  emitente: {
    nome: string; nomeFantasia?: string | null; cnpj: string; email?: string | null;
    smtp?: SmtpConfig | null;
  };
  tomador:  { nome: string; cpfCnpj: string; email?: string | null };
}

function htmlEmail(p: NfseEmailParams): string {
  const emitenteNome = p.emitente.nomeFantasia || p.emitente.nome;
  const valorFmt     = fmtValor(p.valor);
  const link         = p.linkNfse
    ? `<p style="margin:16px 0"><a href="${p.linkNfse}" style="background:#1d6cb8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:14px">📄 Visualizar NFS-e</a></p>`
    : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

        <!-- Header -->
        <tr><td style="background:#1d4e89;padding:24px 32px">
          <p style="margin:0;color:#fff;font-size:20px;font-weight:bold">NFS-e Emitida</p>
          <p style="margin:4px 0 0;color:#a8c4e0;font-size:13px">Nota Fiscal de Serviços Eletrônica</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px">
          <p style="margin:0 0 8px;font-size:14px;color:#555">Prezado(a) <strong>${p.tomador.nome}</strong>,</p>
          <p style="margin:0 0 24px;font-size:14px;color:#555">
            Segue a NFS-e referente aos serviços prestados por <strong>${emitenteNome}</strong>.
          </p>

          <!-- Dados da NFS-e -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:24px">
            <tr><td style="padding:16px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Número da NFS-e</td>
                <td align="right" style="font-size:16px;font-weight:bold;color:#1d4e89">${p.numero}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Competência</td>
                <td align="right" style="font-size:14px;color:#1e293b">${p.competencia}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:12px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Valor</td>
                <td align="right" style="font-size:16px;font-weight:bold;color:#16a34a">${valorFmt}</td>
              </tr></table>
            </td></tr>
            ${p.codigoVerif ? `<tr><td style="padding:12px 20px">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Código de Verificação</td>
                <td align="right" style="font-size:13px;font-family:monospace;color:#1e293b">${p.codigoVerif}</td>
              </tr></table>
            </td></tr>` : ""}
          </table>

          <!-- Discriminação -->
          <p style="margin:0 0 8px;font-size:13px;font-weight:bold;color:#374151;text-transform:uppercase;letter-spacing:.5px">Discriminação dos Serviços</p>
          <p style="margin:0 0 24px;font-size:13px;color:#4b5563;background:#f8fafc;border-left:3px solid #1d4e89;padding:12px 16px;border-radius:0 6px 6px 0;white-space:pre-wrap">${p.discriminacao.slice(0, 500)}</p>

          ${link}

          <!-- Emitente -->
          <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;padding-top:20px;margin-top:8px">
            <tr><td style="font-size:12px;color:#9ca3af">
              <strong style="color:#374151">${emitenteNome}</strong><br>
              CNPJ: ${p.emitente.cnpj}<br>
              ${p.emitente.email ? `E-mail: ${p.emitente.email}` : ""}
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8">
            Este é um e-mail automático gerado pelo sistema Avoce.<br>
            Município de Vitória da Conquista / BA — E&L Sistemas — ABRASF 2.04
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function enviarEmailNfse(p: NfseEmailParams): Promise<void> {
  const smtp = p.emitente.smtp;
  if (!smtp?.host || !smtp?.user) {
    console.log(`[Email] NFS-e ${p.numero}: SMTP da empresa não configurado — e-mail não enviado`);
    return;
  }

  const transporter = criarTransporter(smtp);
  const from        = smtp.from || smtp.user;
  const assunto  = `NFS-e nº ${p.numero} — ${p.emitente.nomeFantasia || p.emitente.nome} — ${p.competencia}`;
  const html     = htmlEmail(p);

  const destinatarios: string[] = [];
  if (p.tomador.email)  destinatarios.push(p.tomador.email);
  if (p.emitente.email) destinatarios.push(p.emitente.email);

  if (!destinatarios.length) {
    console.log(`[Email] NFS-e ${p.numero}: sem e-mails cadastrados — não enviado`);
    return;
  }

  try {
    const info = await transporter.sendMail({
      from,
      to:      destinatarios.join(", "),
      subject: assunto,
      html,
    });
    console.log(`[Email] NFS-e ${p.numero} enviada para: ${destinatarios.join(", ")} (msgId=${info.messageId})`);
  } catch (err) {
    // Não lançar — falha de e-mail não deve reverter a NFS-e
    console.error(`[Email] Falha ao enviar NFS-e ${p.numero}:`, err);
  }
}

export function emailConfigurado(smtp?: SmtpConfig | null): boolean {
  return !!(smtp?.host && smtp?.user && smtp?.pass);
}
