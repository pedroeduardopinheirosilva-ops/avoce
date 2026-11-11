import cron                   from "node-cron";
import pLimit                 from "p-limit";
import nodemailer              from "nodemailer";
import { prisma }             from "../../../db.js";
import { statementService }   from "../services/statement.service.js";
import { reconciliationService } from "../services/reconciliation.service.js";
import { credentialsService } from "../services/credentials.service.js";

// Track in-progress syncs to avoid overlap
const syncInProgress = new Set<string>();

// ── Sync all active bank accounts ────────────────────────────────────────────

async function syncAllAccounts(): Promise<void> {
  const accounts = await prisma.bankAccount.findMany({
    where:   { isActive: true },
    select:  { id: true, emitenteId: true, provider: true },
  });

  const limit = pLimit(5);
  const endDate   = new Date();
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  await Promise.all(
    accounts.map((account) =>
      limit(async () => {
        const key = account.id;
        if (syncInProgress.has(key)) {
          console.log(`[banking-cron] Skipping ${key} — sync already in progress`);
          return;
        }

        syncInProgress.add(key);
        try {
          await statementService.syncAccount({
            emitenteId:    account.emitenteId,
            bankAccountId: account.id,
            startDate,
            endDate,
            triggeredBy:   "cron",
          });
        } catch (err) {
          console.error(`[banking-cron] Error syncing account ${key}:`, err);
        } finally {
          syncInProgress.delete(key);
        }
      })
    )
  );
}

// ── Reconcile all emitentes ───────────────────────────────────────────────────

async function reconcileAll(): Promise<void> {
  const emitentes = await prisma.empresaEmitente.findMany({
    where:  { ativo: true },
    select: { id: true },
  });

  for (const emitente of emitentes) {
    const accounts = await prisma.bankAccount.findMany({
      where:  { emitenteId: emitente.id, isActive: true },
      select: { id: true },
    });

    for (const account of accounts) {
      try {
        const r = await reconciliationService.reconcileAccount(emitente.id, account.id);
        if (r.matched > 0) {
          console.log(
            `[banking-cron] Reconciled ${r.matched}/${r.examined} statements for ${emitente.id}/${account.id}`,
            r.byReason
          );
        }
      } catch (err) {
        console.error(`[banking-cron] Reconciliation error for ${emitente.id}/${account.id}:`, err);
      }
    }
  }
}

// ── Alert expiring credentials ────────────────────────────────────────────────

async function alertExpiringCredentials(): Promise<void> {
  const emitentes = await prisma.empresaEmitente.findMany({
    where:  { ativo: true },
    select: { id: true, nome: true, email: true, smtpHost: true, smtpPort: true, smtpUser: true, smtpPass: true, smtpFrom: true, smtpSecure: true },
  });

  for (const emitente of emitentes) {
    const expiring = await credentialsService.getExpiring(emitente.id, 30);
    if (expiring.length === 0) continue;

    const adminEmail = process.env.ADMIN_EMAIL ?? emitente.email;
    if (!adminEmail) continue;

    // Resolve transporter: prefer emitente SMTP, fall back to env
    const smtpHost = emitente.smtpHost ?? process.env.SMTP_HOST;
    const smtpPort = emitente.smtpPort ?? parseInt(process.env.SMTP_PORT ?? "587");
    const smtpUser = emitente.smtpUser ?? process.env.SMTP_USER;
    const smtpPass = emitente.smtpPass ?? process.env.SMTP_PASS;
    const smtpFrom = emitente.smtpFrom ?? process.env.SMTP_FROM ?? "noreply@avoce.com.br";

    if (!smtpHost || !smtpUser || !smtpPass) continue;

    const transporter = nodemailer.createTransport({
      host:   smtpHost,
      port:   smtpPort,
      secure: emitente.smtpSecure,
      auth:   { user: smtpUser, pass: smtpPass },
    });

    const accountNames = await Promise.all(
      expiring.map(async (cred) => {
        const acc = await prisma.bankAccount.findUnique({
          where:  { id: cred.bankAccountId },
          select: { name: true, provider: true },
        });
        return `${acc?.name ?? cred.bankAccountId} (${acc?.provider ?? ""}) — expira em ${cred.expiresAt?.toLocaleDateString("pt-BR") ?? "?"}`;
      })
    );

    try {
      await transporter.sendMail({
        from:    smtpFrom,
        to:      adminEmail,
        subject: `[Avoce] Credenciais bancárias expirando — ${emitente.nome}`,
        text: [
          `As seguintes credenciais bancárias estão próximas do vencimento:`,
          "",
          ...accountNames.map((n) => `• ${n}`),
          "",
          "Acesse o painel Avoce e renove as credenciais antes do vencimento.",
        ].join("\n"),
      });
    } catch (err) {
      console.error(`[banking-cron] Error sending expiry alert to ${adminEmail}:`, err);
    }
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initBankingCron(): void {
  // Sync accounts daily at 02:00
  cron.schedule("0 2 * * *", async () => {
    console.log("[banking-cron] Starting daily account sync");
    try { await syncAllAccounts(); }
    catch (err) { console.error("[banking-cron] syncAllAccounts error:", err); }
  });

  // Reconcile hourly
  cron.schedule("15 * * * *", async () => {
    console.log("[banking-cron] Starting hourly reconciliation");
    try { await reconcileAll(); }
    catch (err) { console.error("[banking-cron] reconcileAll error:", err); }
  });

  // Alert expiring credentials every Monday at 09:00
  cron.schedule("0 9 * * 1", async () => {
    console.log("[banking-cron] Checking expiring credentials");
    try { await alertExpiringCredentials(); }
    catch (err) { console.error("[banking-cron] alertExpiringCredentials error:", err); }
  });

  console.log("[banking-cron] Banking cron jobs registered");
}
