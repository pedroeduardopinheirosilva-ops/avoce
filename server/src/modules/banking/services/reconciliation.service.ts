import { prisma }            from "../../../db.js";
import natural               from "natural";

const { JaroWinklerDistance } = natural;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReconciliationSuggestion {
  statementId: string;
  cobrancaId:  string;
  confidence:  number;
  reason:      string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDateString(s: string | null | undefined): Date | null {
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}`);
  return null;
}

function amountFromCobranca(c: {
  boletoValorPago: number | null;
  valor:           number;
}): number {
  if (c.boletoValorPago !== null) return c.boletoValorPago / 100;
  return c.valor / 100;
}

function dateFromCobranca(c: {
  pixPagoEm:    Date | null | undefined;
  boletoPagoEm: string | null | undefined;
}): Date | null {
  if (c.pixPagoEm) return c.pixPagoEm;
  return parseDateString(c.boletoPagoEm);
}

function datesClose(a: Date | null, b: Date | null, daysMargin = 5): boolean {
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) <= daysMargin * 86400000;
}

function amountsMatch(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance;
}

// Get IDs of cobranças that already have a bank statement
async function getReconciledCobrancaIds(emitenteId: string): Promise<Set<string>> {
  const statements = await prisma.bankStatement.findMany({
    where: { emitenteId, cobrancaId: { not: null } },
    select: { cobrancaId: true },
  });
  return new Set(statements.map((s) => s.cobrancaId!));
}

// ── Service ───────────────────────────────────────────────────────────────────

export const reconciliationService = {
  /**
   * Full reconciliation algorithm for a bank account.
   * Levels 0-2: auto-match.  Levels 3-4: suggestions only.
   */
  async reconcileAccount(emitenteId: string, bankAccountId: string): Promise<void> {
    const statements = await prisma.bankStatement.findMany({
      where: {
        emitenteId,
        bankAccountId,
        reconciliationStatus: "UNMATCHED",
        entryType:            "CREDIT",
      },
    });

    if (statements.length === 0) return;

    // Cobranças already reconciled (exclude them)
    const reconciledIds = await getReconciledCobrancaIds(emitenteId);

    const cobrancas = await prisma.cobranca.findMany({
      where: {
        emitenteId,
        OR: [{ pixStatus: "PAGO" }, { boletoStatus: "PAGO" }],
      },
      select: {
        id:                true,
        valor:             true,
        boletoValorPago:   true,
        pixPagoEm:         true,
        boletoPagoEm:      true,
        pixEndToEndId:     true,
        pixTxid:           true,
        boletoNossoNumero: true,
        pixPagadorDoc:     true,
      },
    });

    const available = cobrancas.filter((c) => !reconciledIds.has(c.id));
    if (available.length === 0) return;

    const usedCobrancas = new Set<string>();

    for (const stmt of statements) {
      if (stmt.cobrancaId) continue; // already reconciled

      const rawData      = (stmt.rawData ?? {}) as Record<string, unknown>;
      const stmtEndToEnd = rawData["endToEndId"] as string | undefined;
      const stmtTxid     = rawData["txid"]       as string | undefined;
      const stmtAmount   = Number(stmt.amount);

      // Level 0: Exact field match
      let matched = false;
      for (const c of available) {
        if (usedCobrancas.has(c.id)) continue;

        const isMatch =
          (stmtEndToEnd && c.pixEndToEndId && stmtEndToEnd === c.pixEndToEndId) ||
          (stmtTxid     && c.pixTxid       && stmtTxid     === c.pixTxid)       ||
          (stmt.documentNumber && c.boletoNossoNumero &&
            String(c.boletoNossoNumero) === String(stmt.documentNumber));

        if (isMatch) {
          await this.applyMatch(stmt.id, c.id, "MATCHED", "auto");
          usedCobrancas.add(c.id);
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Level 1: Amount + date ±1 day
      for (const c of available) {
        if (usedCobrancas.has(c.id)) continue;
        const cAmount = amountFromCobranca(c);
        const cDate   = dateFromCobranca(c);
        if (amountsMatch(stmtAmount, cAmount) && datesClose(stmt.entryDate, cDate, 1)) {
          await this.applyMatch(stmt.id, c.id, "MATCHED", "auto");
          usedCobrancas.add(c.id);
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // Level 2: Amount + date ±5 days + pagador doc
      for (const c of available) {
        if (usedCobrancas.has(c.id)) continue;
        const cAmount = amountFromCobranca(c);
        const cDate   = dateFromCobranca(c);
        if (
          amountsMatch(stmtAmount, cAmount) &&
          datesClose(stmt.entryDate, cDate, 5) &&
          stmt.counterpartyDocument &&
          c.pixPagadorDoc &&
          stmt.counterpartyDocument.replace(/\D/g, "") === c.pixPagadorDoc.replace(/\D/g, "")
        ) {
          await this.applyMatch(stmt.id, c.id, "MATCHED", "auto");
          usedCobrancas.add(c.id);
          break;
        }
      }
    }
  },

  async applyMatch(
    statementId:  string,
    cobrancaId:   string,
    status:       "MATCHED" | "MANUAL",
    reconciledBy: string
  ): Promise<void> {
    await prisma.$transaction([
      prisma.bankStatement.update({
        where: { id: statementId },
        data:  {
          reconciliationStatus: status,
          reconciledAt:         new Date(),
          reconciledBy,
          cobrancaId,
        },
      }),
      prisma.cobranca.update({
        where: { id: cobrancaId },
        data:  {
          reconciledAt: new Date(),
          reconciledBy,
        },
      }),
    ]);
  },

  async unmatch(emitenteId: string, statementId: string): Promise<void> {
    const stmt = await prisma.bankStatement.findFirst({
      where: { id: statementId, emitenteId },
    });
    if (!stmt) throw new Error("Statement not found");

    await prisma.$transaction([
      prisma.bankStatement.update({
        where: { id: statementId },
        data:  {
          reconciliationStatus: "UNMATCHED",
          reconciledAt:         null,
          reconciledBy:         null,
          cobrancaId:           null,
        },
      }),
      ...(stmt.cobrancaId
        ? [
            prisma.cobranca.update({
              where: { id: stmt.cobrancaId },
              data:  {
                reconciledAt: null,
                reconciledBy: null,
              },
            }),
          ]
        : []),
    ]);
  },

  async getSuggestions(
    emitenteId:    string,
    bankAccountId: string
  ): Promise<ReconciliationSuggestion[]> {
    const statements = await prisma.bankStatement.findMany({
      where: {
        emitenteId,
        bankAccountId,
        reconciliationStatus: "UNMATCHED",
        entryType:            "CREDIT",
        cobrancaId:           null,
      },
      take: 100,
    });

    const reconciledIds = await getReconciledCobrancaIds(emitenteId);

    const cobrancas = await prisma.cobranca.findMany({
      where: {
        emitenteId,
        OR: [{ pixStatus: "PAGO" }, { boletoStatus: "PAGO" }],
      },
      select: {
        id:                true,
        valor:             true,
        boletoValorPago:   true,
        pixPagoEm:         true,
        boletoPagoEm:      true,
        pixEndToEndId:     true,
        pixTxid:           true,
        boletoNossoNumero: true,
        contrato: {
          select: {
            tomador: { select: { nome: true } },
          },
        },
      },
    });

    const available = cobrancas.filter((c) => !reconciledIds.has(c.id));

    const suggestions: ReconciliationSuggestion[] = [];

    for (const stmt of statements) {
      const stmtAmount = Number(stmt.amount);

      for (const c of available) {
        const cAmount  = amountFromCobranca(c);
        const cDate    = dateFromCobranca(c);
        let   confidence = 0;
        const reasons: string[] = [];

        if (amountsMatch(stmtAmount, cAmount)) {
          confidence += 0.4;
          reasons.push("amount_match");
        } else if (amountsMatch(stmtAmount, cAmount, 1)) {
          confidence += 0.2;
          reasons.push("amount_approx");
        } else {
          continue;
        }

        if (datesClose(stmt.entryDate, cDate, 3)) {
          confidence += 0.3;
          reasons.push("date_close");
        } else if (datesClose(stmt.entryDate, cDate, 10)) {
          confidence += 0.15;
          reasons.push("date_approx");
        }

        if (stmt.counterpartyName && c.contrato?.tomador?.nome) {
          const similarity = JaroWinklerDistance(
            stmt.counterpartyName.toLowerCase(),
            c.contrato.tomador.nome.toLowerCase()
          );
          if (similarity > 0.85) {
            confidence += 0.3;
            reasons.push("name_match");
          } else if (similarity > 0.7) {
            confidence += 0.15;
            reasons.push("name_approx");
          }
        }

        if (confidence >= 0.4) {
          suggestions.push({
            statementId: stmt.id,
            cobrancaId:  c.id,
            confidence:  Math.min(confidence, 1),
            reason:      reasons.join("+"),
          });
        }
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  },

  async getUnmatched(emitenteId: string, bankAccountId?: string) {
    return prisma.bankStatement.findMany({
      where: {
        emitenteId,
        ...(bankAccountId ? { bankAccountId } : {}),
        reconciliationStatus: "UNMATCHED",
        entryType:            "CREDIT",
      },
      orderBy: { entryDate: "desc" },
      take:    100,
    });
  },

  async getStats(emitenteId: string, bankAccountId?: string) {
    const baseWhere = {
      emitenteId,
      ...(bankAccountId ? { bankAccountId } : {}),
    };

    const [unmatched, matched, manual, ignored] = await Promise.all([
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "UNMATCHED" } }),
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "MATCHED"   } }),
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "MANUAL"    } }),
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "IGNORED"   } }),
    ]);

    // Count paid cobranças not referenced by any statement
    const reconciledIds = await getReconciledCobrancaIds(emitenteId);
    const allPaidIds = await prisma.cobranca.findMany({
      where: {
        emitenteId,
        OR: [{ pixStatus: "PAGO" }, { boletoStatus: "PAGO" }],
      },
      select: { id: true },
    });
    const cobrancasSemExtrato = allPaidIds.filter((c) => !reconciledIds.has(c.id)).length;

    return { unmatched, matched, manual, ignored, cobrancasSemExtrato };
  },

  async getCobrancasSemExtrato(emitenteId: string) {
    const reconciledIds = await getReconciledCobrancaIds(emitenteId);

    const allPaid = await prisma.cobranca.findMany({
      where: {
        emitenteId,
        OR: [{ pixStatus: "PAGO" }, { boletoStatus: "PAGO" }],
      },
      include: {
        contrato: {
          select: {
            tomador: { select: { id: true, nome: true, cpfCnpj: true } },
          },
        },
      },
      orderBy: { pixPagoEm: "desc" },
      take:    200,
    });

    return allPaid.filter((c) => !reconciledIds.has(c.id)).slice(0, 100);
  },
};
