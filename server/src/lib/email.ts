// ── E-mail: SMTP + cópia na pasta Enviados (IMAP) ─────────────────────────────
// O envio da NFS-e ao tomador fica em email-cobranca.ts (enviarEmailNfse).

import nodemailer from "nodemailer";
import { connect as tlsConnect } from "tls";

export interface SmtpConfig {
  host:   string;
  port:   number;
  secure: boolean;
  user:   string;
  pass:   string;
  from:   string;
}

// ── IMAP: salvar cópia na pasta Enviados ──────────────────────────────────────

const SENT_FOLDERS = ["Sent", "Sent Items", "Sent Messages", "INBOX.Sent"];

/** O Gmail/Workspace já arquiva sozinho o que sai pelo smtp.gmail.com. */
function salvaSozinho(smtpHost: string): boolean {
  const h = smtpHost.toLowerCase();
  return h === "smtp.gmail.com" || h === "smtp.googlemail.com";
}

function imapAppend(smtp: SmtpConfig, rawMsg: Buffer, folder: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 12_000);

    const sock = tlsConnect({ host: smtp.host, port: 993, rejectUnauthorized: false });
    let buf = "";
    let seq = 1;
    let step: "greeting" | "login" | "appending" | "appended" | "done" = "greeting";
    let ok = false;

    function q(s: string) { return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
    function send(cmd: string) { sock.write(cmd + "\r\n"); }

    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        handle(line);
      }
    });

    function handle(line: string) {
      if (step === "greeting") {
        if (/^\* OK/i.test(line)) {
          send(`A${seq} LOGIN ${q(smtp.user)} ${q(smtp.pass)}`);
          step = "login";
        }
      } else if (step === "login") {
        if (line.startsWith(`A${seq} OK`)) {
          seq++;
          send(`A${seq} APPEND ${q(folder)} (\\Seen) {${rawMsg.length}}`);
          step = "appending";
        } else if (/^A\d+ (NO|BAD)/i.test(line)) {
          sock.destroy(); clearTimeout(timer); resolve(false);
        }
      } else if (step === "appending") {
        if (line.startsWith("+ ")) {
          sock.write(rawMsg);
          sock.write("\r\n");
          step = "appended";
        } else if (/^A\d+ (NO|BAD)/i.test(line)) {
          sock.destroy(); clearTimeout(timer); resolve(false);
        }
      } else if (step === "appended") {
        if (line.startsWith(`A${seq} OK`)) {
          ok = true; seq++;
          send(`A${seq} LOGOUT`);
          step = "done";
        } else if (/^A\d+ (NO|BAD)/i.test(line)) {
          sock.destroy(); clearTimeout(timer); resolve(false);
        }
      } else if (step === "done") {
        sock.destroy(); clearTimeout(timer); resolve(ok);
      }
    }

    sock.on("error",  () => { clearTimeout(timer); resolve(false); });
    sock.on("close",  () => { clearTimeout(timer); resolve(ok);    });
  });
}

export async function appendToSentImap(smtp: SmtpConfig, rawMsg: Buffer): Promise<void> {
  if (salvaSozinho(smtp.host)) return; // duplicaria a mensagem em Enviados
  for (const folder of SENT_FOLDERS) {
    try {
      if (await imapAppend(smtp, rawMsg, folder)) {
        console.log(`[IMAP] Mensagem salva em "${folder}"`);
        return;
      }
    } catch { /* tenta próxima */ }
  }
  console.warn("[IMAP] Não foi possível salvar em Enviados (todas as pastas falharam)");
}

// Envia e-mail via SMTP e salva cópia na pasta Enviados (fire-and-forget para IMAP).
export async function sendMailAndSave(
  smtp:        SmtpConfig,
  mailOptions: nodemailer.SendMailOptions,
): Promise<nodemailer.SentMessageInfo> {
  const transporter = criarTransporter(smtp);
  const info        = await transporter.sendMail(mailOptions);

  // Gerar raw RFC-822 e salvar no IMAP Sent — assíncrono, não bloqueia
  (async () => {
    try {
      const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
      const { message } = await stream.sendMail(mailOptions);
      await appendToSentImap(smtp, message as Buffer);
    } catch (e) {
      console.error("[IMAP] Falha ao salvar em Enviados:", e);
    }
  })();

  return info;
}

// ─────────────────────────────────────────────────────────────────────────────

function criarTransporter(smtp: SmtpConfig) {
  return nodemailer.createTransport({
    host:       smtp.host,
    port:       smtp.port,
    secure:     smtp.secure,
    requireTLS: !smtp.secure,
    auth:       { user: smtp.user, pass: smtp.pass },
    tls:        { rejectUnauthorized: false },
  });
}

export function emailConfigurado(smtp?: SmtpConfig | null): boolean {
  return !!(smtp?.host && smtp?.user && smtp?.pass);
}
