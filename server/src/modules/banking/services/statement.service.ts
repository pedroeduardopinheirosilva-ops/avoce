import { createHash }          from "node:crypto";
import { prisma }              from "../../../db.js";
import { AdapterFactory }      from "../adapters/adapter.factory.js";
import { credentialsService }  from "./credentials.service.js";
import { reconciliationService } from "./reconciliation.service.js";
import type { BankProvider } from "@prisma/client";

export interface SyncAccountOptions {
  emitenteId:    string;
  bankAccountId: string;
  startDate:     Date;
  endDate:       Date;
  triggeredBy:   string;
}

export interface GetStatementsOptions {
  emitenteId:    string;
  bankAccountId?: string;
  startDate?:    Date;
  endDate?:      Date;
  reconciliationStatus?: string;
  skip?:         number;
  take?:         number;
}

export interface CreateManualEntryInput {
  emitenteId:          string;
  bankAccountId:       string;
  entryDate:           Date;
  valueDate?:          Date;
  amount:              number;
  entryType:           "DEBIT" | "CREDIT";
  description:         string;
  documentNumber?:     string;
  counterpartyName?:   string;
  counterpartyDocument?: string;
  category?:           string;
  attachmentUrl?:      string;
  attachmentName?:     string;
  createdByUserId?:    string;
}

export const statementService = {
  async syncAccount(options: SyncAccountOptions) {
    const { emitenteId, bankAccountId, startDate, endDate, triggeredBy } = options;

    // Create sync log
    const syncLog = await prisma.statementSyncLog.create({
      data: {
        emitenteId,
        bankAccountId,
        startDate,
        endDate,
        triggeredBy,
        status: "PENDING",
      },
    });

    const t0 = Date.now();

    try {
      // Get bank account
      const account = await prisma.bankAccount.findFirst({
        where: { id: bankAccountId, emitenteId, isActive: true },
      });
      if (!account) throw new Error("Bank account not found or inactive");

      // Check credential expiry
      const cred = await prisma.bankCredential.findUnique({
        where: { bankAccountId },
      });
      if (cred?.expiresAt && cred.expiresAt < new Date()) {
        throw new Error("Bank credentials have expired");
      }

      // Mark as running
      await prisma.statementSyncLog.update({
        where: { id: syncLog.id },
        data:  { status: "RUNNING" },
      });

      const decrypted = await credentialsService.getDecrypted(bankAccountId);
      if (!decrypted) throw new Error("No credentials configured for this account");

      const adapter = AdapterFactory.getAdapter(account.provider as BankProvider);

      // Fetch entries
      const entries = await adapter.fetchStatement(decrypted, {
        account:           account.account,
        agency:            account.agency,
        agencyDigit:       account.agencyDigit ?? undefined,
        accountDigit:      account.accountDigit ?? undefined,
        startDate,
        endDate,
        externalAccountId: account.externalAccountId ?? undefined,
      });

      let recordsNew = 0;

      for (const entry of entries) {
        // Generate sha256 fallback externalId if missing
        const externalId = entry.externalId ||
          createHash("sha256")
            .update(`${bankAccountId}:${entry.entryDate.toISOString()}:${entry.amount}:${entry.entryType}:${entry.description}`)
            .digest("hex")
            .slice(0, 40);

        const existing = await prisma.bankStatement.findFirst({
          where: { bankAccountId, externalId },
        });

        if (!existing) {
          await prisma.bankStatement.create({
            data: {
              emitenteId,
              bankAccountId,
              externalId,
              entryDate:           entry.entryDate,
              valueDate:           entry.valueDate,
              amount:              entry.amount,
              entryType:           entry.entryType,
              balance:             entry.balance,
              description:         entry.description,
              documentNumber:      entry.documentNumber,
              counterpartyName:    entry.counterpartyName,
              counterpartyDocument: entry.counterpartyDocument,
              source:              "API_SYNC",
              rawData:             (entry.rawData ?? {}) as any,
            },
          });
          recordsNew++;
        }
      }

      // Fetch and update balance
      try {
        const balance = await adapter.fetchBalance(decrypted, {
          account:           account.account,
          agency:            account.agency,
          agencyDigit:       account.agencyDigit ?? undefined,
          accountDigit:      account.accountDigit ?? undefined,
          externalAccountId: account.externalAccountId ?? undefined,
        });
        await prisma.bankAccount.update({
          where: { id: bankAccountId },
          data:  { currentBalance: balance.available, balanceDate: balance.date },
        });
      } catch {
        // Non-fatal: balance update failure doesn't fail the sync
      }

      const durationMs = Date.now() - t0;

      await prisma.statementSyncLog.update({
        where: { id: syncLog.id },
        data:  {
          status:         "SUCCESS",
          recordsFetched: entries.length,
          recordsNew,
          durationMs,
          finishedAt:     new Date(),
        },
      });

      // Fire reconciliation asynchronously
      reconciliationService.reconcileAccount(emitenteId, bankAccountId).catch(() => {});

      return { syncLogId: syncLog.id, recordsFetched: entries.length, recordsNew };
    } catch (err) {
      const durationMs = Date.now() - t0;
      const errorMessage = err instanceof Error ? err.message : String(err);

      await prisma.statementSyncLog.update({
        where: { id: syncLog.id },
        data:  {
          status:       "ERROR",
          errorMessage,
          durationMs,
          finishedAt:   new Date(),
        },
      });

      throw err;
    }
  },

  async getStatements(options: GetStatementsOptions) {
    const { emitenteId, bankAccountId, startDate, endDate, reconciliationStatus, skip = 0, take = 50 } = options;

    const where: Record<string, unknown> = { emitenteId };
    if (bankAccountId) where.bankAccountId = bankAccountId;
    if (reconciliationStatus) where.reconciliationStatus = reconciliationStatus;
    if (startDate || endDate) {
      where.entryDate = {};
      if (startDate) (where.entryDate as Record<string, unknown>).gte = startDate;
      if (endDate)   (where.entryDate as Record<string, unknown>).lte = endDate;
    }

    const [items, total] = await Promise.all([
      prisma.bankStatement.findMany({
        where:   where as any,
        include: { cobranca: { select: { id: true, competencia: true, valor: true } } },
        orderBy: { entryDate: "desc" },
        skip,
        take,
      }),
      prisma.bankStatement.count({ where: where as any }),
    ]);

    return { items, total };
  },

  async getUnified(emitenteId: string, bankAccountId: string, startDate: Date, endDate: Date) {
    return prisma.bankStatement.findMany({
      where: {
        emitenteId,
        bankAccountId,
        entryDate: { gte: startDate, lte: endDate },
      },
      include: {
        cobranca: {
          select: {
            id:          true,
            competencia: true,
            valor:       true,
            pixStatus:   true,
            boletoStatus: true,
          },
        },
      },
      orderBy: { entryDate: "asc" },
    });
  },

  async createManual(input: CreateManualEntryInput) {
    return prisma.bankStatement.create({
      data: {
        emitenteId:          input.emitenteId,
        bankAccountId:       input.bankAccountId,
        entryDate:           input.entryDate,
        valueDate:           input.valueDate,
        amount:              input.amount,
        entryType:           input.entryType,
        description:         input.description,
        documentNumber:      input.documentNumber,
        counterpartyName:    input.counterpartyName,
        counterpartyDocument: input.counterpartyDocument,
        category:            input.category,
        source:              "MANUAL",
        attachmentUrl:       input.attachmentUrl,
        attachmentName:      input.attachmentName,
        createdByUserId:     input.createdByUserId,
      },
    });
  },

  async updateManual(
    emitenteId: string,
    id:         string,
    data:       Partial<CreateManualEntryInput>,
    userId?:    string
  ) {
    const entry = await prisma.bankStatement.findFirst({ where: { id, emitenteId } });
    if (!entry) throw new Error("Statement not found");
    if (entry.source !== "MANUAL") throw new Error("Only manual entries can be updated");

    return prisma.bankStatement.update({
      where: { id },
      data:  {
        ...data,
        updatedByUserId: userId,
      },
    });
  },

  async deleteManual(emitenteId: string, id: string) {
    const entry = await prisma.bankStatement.findFirst({ where: { id, emitenteId } });
    if (!entry) throw new Error("Statement not found");
    if (entry.source !== "MANUAL") throw new Error("Only manual entries can be deleted");
    await prisma.bankStatement.delete({ where: { id } });
  },

  async getSyncLogs(emitenteId: string, bankAccountId?: string, limit = 20) {
    return prisma.statementSyncLog.findMany({
      where:   { emitenteId, ...(bankAccountId ? { bankAccountId } : {}) },
      orderBy: { createdAt: "desc" },
      take:    limit,
    });
  },
};
