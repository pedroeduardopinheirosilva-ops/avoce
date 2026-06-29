import { z }                     from "zod";
import { router, authProc }      from "../../routers/trpc.js";
import { assertEmitenteAccess } from "../../routers/tenant-utils.js";
import { bankAccountService }    from "./services/bank-account.service.js";
import { credentialsService }    from "./services/credentials.service.js";
import { statementService }      from "./services/statement.service.js";
import { reconciliationService } from "./services/reconciliation.service.js";
import { BANK_METADATA }         from "./adapters/bank-metadata.js";

// ── Accounts sub-router ───────────────────────────────────────────────────────

const accountsRouter = router({
  create: authProc
    .input(z.object({
      emitenteId:        z.string(),
      provider:          z.enum(["SICOOB", "BRADESCO", "INTER", "BTG"]),
      name:              z.string().min(1).max(100),
      bankCode:          z.string().max(10),
      agency:            z.string().max(10),
      agencyDigit:       z.string().max(2).optional(),
      account:           z.string().max(20),
      accountDigit:      z.string().max(2).optional(),
      accountType:       z.string().max(10),
      pixKey:            z.string().max(100).optional(),
      isDefault:         z.boolean().optional(),
      externalAccountId: z.string().max(100).optional(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return bankAccountService.create(input);
    }),

  list: authProc
    .input(z.object({ emitenteId: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return bankAccountService.findAll(input.emitenteId);
    }),

  get: authProc
    .input(z.object({ emitenteId: z.string(), id: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return bankAccountService.findById(input.emitenteId, input.id);
    }),

  update: authProc
    .input(z.object({
      emitenteId:         z.string(),
      id:                 z.string(),
      name:               z.string().optional(),
      pixKey:             z.string().optional(),
      isDefault:          z.boolean().optional(),
      isActive:           z.boolean().optional(),
      externalAccountId:  z.string().optional(),
      accountType:        z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      const { emitenteId, id, ...data } = input;
      return bankAccountService.update(emitenteId, id, data);
    }),

  deactivate: authProc
    .input(z.object({ emitenteId: z.string(), id: z.string() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return bankAccountService.deactivate(input.emitenteId, input.id);
    }),

  setDefault: authProc
    .input(z.object({ emitenteId: z.string(), id: z.string() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return bankAccountService.setDefault(input.emitenteId, input.id);
    }),

  summary: authProc
    .input(z.object({ emitenteId: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return bankAccountService.getSummary(input.emitenteId);
    }),

  metadata: authProc
    .query(() => BANK_METADATA),
});

// ── Credentials sub-router ────────────────────────────────────────────────────

const credentialsRouter = router({
  save: authProc
    .input(z.object({
      emitenteId:     z.string(),
      bankAccountId:  z.string(),
      credentialType: z.enum(["MTLS_CERT", "MTLS_KEYPAIR", "OAUTH2"]),
      certData:       z.string().optional(),
      certPassword:   z.string().optional(),
      certPem:        z.string().optional(),
      keyPem:         z.string().optional(),
      clientId:       z.string().optional(),
      clientSecret:   z.string().optional(),
      expiresAt:      z.string().datetime().optional(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return credentialsService.save({
        ...input,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
      });
    }),

  getMeta: authProc
    .input(z.object({ emitenteId: z.string(), bankAccountId: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return credentialsService.getMeta(input.emitenteId, input.bankAccountId);
    }),

  testConnection: authProc
    .input(z.object({
      emitenteId:    z.string(),
      bankAccountId: z.string(),
      provider:      z.enum(["SICOOB", "BRADESCO", "INTER", "BTG"]),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return credentialsService.testConnection(input.emitenteId, input.bankAccountId, input.provider);
    }),

  getExpiring: authProc
    .input(z.object({ emitenteId: z.string(), daysAhead: z.number().int().min(1).max(90).default(30) }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return credentialsService.getExpiring(input.emitenteId, input.daysAhead);
    }),

  remove: authProc
    .input(z.object({ emitenteId: z.string(), bankAccountId: z.string() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return credentialsService.remove(input.emitenteId, input.bankAccountId);
    }),
});

// ── Statements sub-router ─────────────────────────────────────────────────────

const statementsRouter = router({
  sync: authProc
    .input(z.object({
      emitenteId:    z.string(),
      bankAccountId: z.string(),
      startDate:     z.string().datetime(),
      endDate:       z.string().datetime(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return statementService.syncAccount({
        emitenteId:    input.emitenteId,
        bankAccountId: input.bankAccountId,
        startDate:     new Date(input.startDate),
        endDate:       new Date(input.endDate),
        triggeredBy:   (ctx as { userId?: string }).userId ?? "api",
      });
    }),

  list: authProc
    .input(z.object({
      emitenteId:             z.string(),
      bankAccountId:          z.string().optional(),
      startDate:              z.string().datetime().optional(),
      endDate:                z.string().datetime().optional(),
      reconciliationStatus:   z.string().optional(),
      skip:                   z.number().int().min(0).default(0),
      take:                   z.number().int().min(1).max(200).default(50),
    }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return statementService.getStatements({
        ...input,
        startDate: input.startDate ? new Date(input.startDate) : undefined,
        endDate:   input.endDate   ? new Date(input.endDate)   : undefined,
      });
    }),

  unified: authProc
    .input(z.object({
      emitenteId:    z.string(),
      bankAccountId: z.string(),
      startDate:     z.string().datetime(),
      endDate:       z.string().datetime(),
    }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return statementService.getUnified(
        input.emitenteId,
        input.bankAccountId,
        new Date(input.startDate),
        new Date(input.endDate)
      );
    }),

  createManual: authProc
    .input(z.object({
      emitenteId:           z.string(),
      bankAccountId:        z.string(),
      entryDate:            z.string().datetime(),
      valueDate:            z.string().datetime().optional(),
      amount:               z.number().positive(),
      entryType:            z.enum(["DEBIT", "CREDIT"]),
      description:          z.string().min(1).max(500),
      documentNumber:       z.string().optional(),
      counterpartyName:     z.string().optional(),
      counterpartyDocument: z.string().optional(),
      category:             z.string().optional(),
      attachmentUrl:        z.string().optional(),
      attachmentName:       z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return statementService.createManual({
        ...input,
        entryDate: new Date(input.entryDate),
        valueDate: input.valueDate ? new Date(input.valueDate) : undefined,
        createdByUserId: (ctx as { userId?: string }).userId,
      });
    }),

  updateManual: authProc
    .input(z.object({
      emitenteId:   z.string(),
      id:           z.string(),
      description:  z.string().optional(),
      category:     z.string().optional(),
      attachmentUrl: z.string().optional(),
      attachmentName: z.string().optional(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      const { emitenteId, id, ...data } = input;
      return statementService.updateManual(emitenteId, id, data, (ctx as { userId?: string }).userId);
    }),

  deleteManual: authProc
    .input(z.object({ emitenteId: z.string(), id: z.string() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return statementService.deleteManual(input.emitenteId, input.id);
    }),

  syncLogs: authProc
    .input(z.object({
      emitenteId:    z.string(),
      bankAccountId: z.string().optional(),
      limit:         z.number().int().min(1).max(100).default(20),
    }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return statementService.getSyncLogs(input.emitenteId, input.bankAccountId, input.limit);
    }),
});

// ── Reconciliation sub-router ─────────────────────────────────────────────────

const reconciliationRouter = router({
  run: authProc
    .input(z.object({ emitenteId: z.string(), bankAccountId: z.string() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.reconcileAccount(input.emitenteId, input.bankAccountId);
    }),

  applyMatch: authProc
    .input(z.object({
      emitenteId:  z.string(),
      statementId: z.string(),
      cobrancaId:  z.string(),
    }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.applyMatch(
        input.statementId,
        input.cobrancaId,
        "MANUAL",
        (ctx as { userId?: string }).userId ?? "manual"
      );
    }),

  unmatch: authProc
    .input(z.object({ emitenteId: z.string(), statementId: z.string() }))
    .mutation(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.unmatch(input.emitenteId, input.statementId);
    }),

  suggestions: authProc
    .input(z.object({ emitenteId: z.string(), bankAccountId: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.getSuggestions(input.emitenteId, input.bankAccountId);
    }),

  unmatched: authProc
    .input(z.object({ emitenteId: z.string(), bankAccountId: z.string().optional() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.getUnmatched(input.emitenteId, input.bankAccountId);
    }),

  stats: authProc
    .input(z.object({ emitenteId: z.string(), bankAccountId: z.string().optional() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.getStats(input.emitenteId, input.bankAccountId);
    }),

  cobrancasSemExtrato: authProc
    .input(z.object({ emitenteId: z.string() }))
    .query(({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      return reconciliationService.getCobrancasSemExtrato(input.emitenteId);
    }),
});

// ── Main banking router ───────────────────────────────────────────────────────

export const bankingRouter = router({
  accounts:       accountsRouter,
  credentials:    credentialsRouter,
  statements:     statementsRouter,
  reconciliation: reconciliationRouter,
});
