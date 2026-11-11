import { prisma }                    from "../../../db.js";
import natural                       from "natural";
import { backfillBoletoPagamentos }  from "./boleto-backfill.service.js";

const { JaroWinklerDistance } = natural;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReconciliationSuggestion {
  statementId: string;
  cobrancaId:  string;
  confidence:  number;
  reason:      string;
  cobranca?: {
    id:          string;
    valor:       number;      // centavos
    valorPago:   number;      // reais (efetivo p/ comparação)
    vencimento:  string;
    tomadorNome: string | null;
    emAberto:    boolean;
    statusLabel: string;
  };
}

export interface ReconcileResult {
  examined:  number;
  matched:   number;
  byReason:  Record<string, number>;
}

interface Candidate {
  id:                string;
  valorCentavos:     number;
  amount:            number;        // reais, valor efetivamente pago (ou nominal)
  dataPagamento:     Date | null;
  vencimento:        Date | null;
  vencimentoRaw:     string;
  emAberto:          boolean;
  statusLabel:       string;
  pixEndToEndId:     string | null;
  pixTxid:           string | null;
  boletoNossoNumero: number | null;
  docs:              string[];      // documentos normalizados (pagador PIX, baixa manual, tomador)
  nomes:             string[];      // nomes p/ similaridade (tomador, pagador PIX, baixa manual)
  tomadorNome:       string | null;
}

interface StatementLike {
  id:                   string;
  amount:               unknown;
  entryDate:            Date;
  documentNumber:       string | null;
  counterpartyName:     string | null;
  counterpartyDocument: string | null;
  rawData:              unknown;
  cobrancaId:           string | null;
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

function normDoc(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

function datesClose(a: Date | null, b: Date | null, daysMargin: number): boolean {
  if (!a || !b) return false;
  return Math.abs(a.getTime() - b.getTime()) <= daysMargin * 86400000;
}

function amountsMatch(a: number, b: number, tolerance = 0.01): boolean {
  return Math.abs(a - b) <= tolerance;
}

function bestNameSimilarity(counterpartyName: string | null, nomes: string[]): number {
  if (!counterpartyName) return 0;
  const cp = counterpartyName.toLowerCase().trim();
  let best = 0;
  for (const n of nomes) {
    if (!n) continue;
    const sim = JaroWinklerDistance(cp, n.toLowerCase().trim());
    if (sim > best) best = sim;
  }
  return best;
}

// Get IDs of cobranças that already have a bank statement (1:1 ou grupo N:1)
async function getReconciledCobrancaIds(emitenteId: string): Promise<Set<string>> {
  const [statements, groupMatches] = await Promise.all([
    prisma.bankStatement.findMany({
      where: { emitenteId, cobrancaId: { not: null } },
      select: { cobrancaId: true },
    }),
    prisma.bankStatementMatch.findMany({
      where: { statement: { emitenteId } },
      select: { cobrancaId: true },
    }),
  ]);
  return new Set([
    ...statements.map((s) => s.cobrancaId!),
    ...groupMatches.map((m) => m.cobrancaId),
  ]);
}

// ── Subset-sum (conciliação de liquidações agrupadas) ─────────────────────────
// Conta soluções (com teto 2) e, se a solução for ÚNICA, a reconstrói.
// Valores em centavos para aritmética exata.

function findUniqueSubset(values: number[], target: number): number[] | null {
  const n = values.length;
  if (n === 0 || target <= 0) return null;

  // Soma dos sufixos p/ poda: se nem usando tudo dá, corta o ramo.
  const suffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + values[i];
  if (suffix[0] < target) return null;

  const memo = new Map<string, number>();
  function count(i: number, remaining: number): number {
    if (remaining === 0) return 1;
    if (i >= n || remaining < 0 || suffix[i] < remaining) return 0;
    const key = `${i}:${remaining}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let total = count(i + 1, remaining) + count(i + 1, remaining - values[i]);
    if (total > 2) total = 2; // só precisamos saber se é 0, 1 ou "várias"
    memo.set(key, total);
    return total;
  }

  if (count(0, target) !== 1) return null;

  // Reconstrução da solução única
  const picked: number[] = [];
  let i = 0, remaining = target;
  while (remaining > 0 && i < n) {
    if (count(i + 1, remaining - values[i]) === 1 && remaining - values[i] >= 0) {
      picked.push(i);
      remaining -= values[i];
    }
    i += 1;
  }
  return remaining === 0 ? picked : null;
}

// ── Candidate loading ─────────────────────────────────────────────────────────

function cobrancaStatusLabel(c: {
  pixStatus: string; boletoStatus: string; baixaManualStatus: string | null;
}): string {
  if (c.baixaManualStatus === "PAGO") return "Baixa manual";
  if (c.pixStatus === "PAGO")         return "PIX pago";
  if (c.boletoStatus === "PAGO")      return "Boleto pago";
  if (c.boletoStatus === "VENCIDO")   return "Boleto vencido";
  return "Em aberto";
}

async function loadCandidates(emitenteId: string): Promise<Candidate[]> {
  const reconciledIds = await getReconciledCobrancaIds(emitenteId);

  const cobrancas = await prisma.cobranca.findMany({
    where: { emitenteId },
    select: {
      id:                         true,
      valor:                      true,
      vencimento:                 true,
      pixStatus:                  true,
      pixPagoEm:                  true,
      pixEndToEndId:              true,
      pixTxid:                    true,
      pixPagadorDoc:              true,
      pixPagadorNome:             true,
      boletoStatus:               true,
      boletoPagoEm:               true,
      boletoValorPago:            true,
      boletoNossoNumero:          true,
      baixaManualStatus:          true,
      baixaManualValorPago:       true,
      baixaManualDataRecebimento: true,
      baixaManualPagadorDoc:      true,
      baixaManualPagadorNome:     true,
      contrato: {
        select: {
          tomador: { select: { nome: true, cpfCnpj: true } },
        },
      },
    },
  });

  return cobrancas
    .filter((c) => {
      if (reconciledIds.has(c.id)) return false;
      // Candidata válida: paga por algum canal OU com canal de cobrança vivo.
      // Exclui canceladas/expiradas sem pagamento (não podem receber crédito).
      const paga = c.pixStatus === "PAGO" || c.boletoStatus === "PAGO" || c.baixaManualStatus === "PAGO";
      const viva = ["AGUARDANDO", "VENCIDO"].includes(c.boletoStatus) || c.pixStatus === "PENDENTE";
      return paga || viva;
    })
    .map((c): Candidate => {
      const emAberto =
        c.pixStatus !== "PAGO" &&
        c.boletoStatus !== "PAGO" &&
        c.baixaManualStatus !== "PAGO";

      const valorPagoCentavos =
        c.baixaManualStatus === "PAGO" && c.baixaManualValorPago != null
          ? c.baixaManualValorPago
          : c.boletoStatus === "PAGO" && c.boletoValorPago != null
            ? c.boletoValorPago
            : c.valor;

      const dataPagamento =
        c.pixPagoEm ??
        parseDateString(c.boletoStatus === "PAGO" ? c.boletoPagoEm : null) ??
        parseDateString(c.baixaManualStatus === "PAGO" ? c.baixaManualDataRecebimento : null);

      const docs = [
        normDoc(c.pixPagadorDoc),
        normDoc(c.baixaManualPagadorDoc),
        normDoc(c.contrato?.tomador?.cpfCnpj),
      ].filter((d) => d.length >= 11);

      const nomes = [
        c.contrato?.tomador?.nome,
        c.pixPagadorNome,
        c.baixaManualPagadorNome,
      ].filter((n): n is string => !!n);

      return {
        id:                c.id,
        valorCentavos:     c.valor,
        amount:            valorPagoCentavos / 100,
        dataPagamento,
        vencimento:        parseDateString(c.vencimento),
        vencimentoRaw:     c.vencimento,
        emAberto,
        statusLabel:       cobrancaStatusLabel(c),
        pixEndToEndId:     c.pixEndToEndId,
        pixTxid:           c.pixTxid,
        boletoNossoNumero: c.boletoNossoNumero,
        docs,
        nomes,
        tomadorNome:       c.contrato?.tomador?.nome ?? null,
      };
    });
}

// ── Scoring engine ────────────────────────────────────────────────────────────

function scoreMatch(stmt: StatementLike, cand: Candidate): { score: number; reasons: string[] } {
  const rawData      = (stmt.rawData ?? {}) as Record<string, unknown>;
  const stmtEndToEnd = rawData["endToEndId"] as string | undefined;
  const stmtTxid     = rawData["txid"]       as string | undefined;
  const stmtAmount   = Number(stmt.amount);

  // Nível 0: identificadores exatos → certeza
  const idExato =
    (stmtEndToEnd && cand.pixEndToEndId && stmtEndToEnd === cand.pixEndToEndId) ||
    (stmtTxid     && cand.pixTxid       && stmtTxid     === cand.pixTxid)       ||
    (stmt.documentNumber && cand.boletoNossoNumero &&
      String(cand.boletoNossoNumero) === String(stmt.documentNumber));
  if (idExato) return { score: 1, reasons: ["id_exato"] };

  let score = 0;
  const reasons: string[] = [];

  // Valor — obrigatório: sem proximidade de valor não há match
  if (amountsMatch(stmtAmount, cand.amount)) {
    score += 0.4;
    reasons.push("valor_exato");
  } else if (amountsMatch(stmtAmount, cand.amount, 1)) {
    score += 0.15;
    reasons.push("valor_aprox");
  } else {
    return { score: 0, reasons: [] };
  }

  // Data — pagamento (forte) ou vencimento (mais fraco, cobrança em aberto)
  if (cand.dataPagamento) {
    if (datesClose(stmt.entryDate, cand.dataPagamento, 1)) {
      score += 0.3;
      reasons.push("data_pagamento_1d");
    } else if (datesClose(stmt.entryDate, cand.dataPagamento, 5)) {
      score += 0.2;
      reasons.push("data_pagamento_5d");
    } else if (datesClose(stmt.entryDate, cand.dataPagamento, 10)) {
      score += 0.1;
      reasons.push("data_pagamento_10d");
    } else {
      // Data de pagamento CONHECIDA e longe do lançamento: quase certamente
      // não é este crédito (evita casar por valor+doc+nome um pagamento de
      // outro mês do mesmo cliente).
      score -= 0.3;
      reasons.push("data_pagamento_incompativel");
    }
  } else if (cand.vencimento) {
    if (datesClose(stmt.entryDate, cand.vencimento, 3)) {
      score += 0.2;
      reasons.push("vencimento_3d");
    } else if (datesClose(stmt.entryDate, cand.vencimento, 10)) {
      score += 0.1;
      reasons.push("vencimento_10d");
    }
  }

  // Documento do pagador × (pagador PIX / baixa manual / tomador do contrato)
  const stmtDoc = normDoc(stmt.counterpartyDocument);
  if (stmtDoc.length >= 11 && cand.docs.includes(stmtDoc)) {
    score += 0.35;
    reasons.push("doc_match");
  }

  // Nome do pagador × nomes conhecidos da cobrança
  const sim = bestNameSimilarity(stmt.counterpartyName, cand.nomes);
  if (sim > 0.85) {
    score += 0.25;
    reasons.push("nome_match");
  } else if (sim > 0.7) {
    score += 0.12;
    reasons.push("nome_aprox");
  }

  if (cand.emAberto) {
    reasons.push("cobranca_em_aberto");
    // Crédito não chega bem antes do vencimento: cobrança em aberto com
    // vencimento >5d após a data do lançamento quase certamente é de OUTRA
    // competência (cliente mensal de mesmo valor). Penalidade proibitiva p/
    // auto-match (0.4+0.35+0.25-0.35 = 0.65 < 0.85); sobra como sugestão.
    if (cand.vencimento && cand.vencimento.getTime() > stmt.entryDate.getTime() + 5 * 86400000) {
      score -= 0.35;
      reasons.push("vencimento_futuro");
    }
  }

  return { score: Math.max(Math.min(score, 1), 0), reasons };
}

// Auto-aplicação: exige valor exato, score alto e ausência de ambiguidade.
const AUTO_SCORE_MIN       = 0.85;
const AUTO_AMBIGUITY_DELTA = 0.1;

// ── Service ───────────────────────────────────────────────────────────────────

export const reconciliationService = {
  /**
   * Conciliação automática de uma conta: casa lançamentos de crédito não
   * conciliados com cobranças por identificadores exatos ou por score
   * (valor + data + documento/nome do pagador e do tomador).
   * Só aplica quando o match é inequívoco; o resto vira sugestão na UI.
   */
  async reconcileAccount(emitenteId: string, bankAccountId: string): Promise<ReconcileResult> {
    // Antes de casar: busca no Sicoob a data real de pagamento dos boletos
    // PAGOS que estão sem ela (essencial p/ liquidações agrupadas).
    try {
      await backfillBoletoPagamentos(emitenteId);
    } catch (err) {
      console.error("[reconciliation] backfill de boletos falhou (seguindo sem):", err);
    }

    const statements = await prisma.bankStatement.findMany({
      where: {
        emitenteId,
        bankAccountId,
        reconciliationStatus: "UNMATCHED",
        entryType:            "CREDIT",
      },
    });

    const result: ReconcileResult = { examined: statements.length, matched: 0, byReason: {} };
    if (statements.length === 0) return result;

    const candidates = await loadCandidates(emitenteId);
    if (candidates.length === 0) return result;

    const usedCobrancas = new Set<string>();

    for (const stmt of statements) {
      if (stmt.cobrancaId) continue;

      let best:   { cand: Candidate; score: number; reasons: string[] } | null = null;
      let second: number = 0;

      for (const cand of candidates) {
        if (usedCobrancas.has(cand.id)) continue;
        const { score, reasons } = scoreMatch(stmt, cand);
        if (score <= 0) continue;
        if (!best || score > best.score) {
          second = best?.score ?? 0;
          best   = { cand, score, reasons };
        } else if (score > second) {
          second = score;
        }
      }

      if (!best) continue;

      const idExato    = best.reasons.includes("id_exato");
      const valorExato = best.reasons.includes("valor_exato");
      const inequivoco = best.score - second >= AUTO_AMBIGUITY_DELTA;

      if (idExato || (best.score >= AUTO_SCORE_MIN && valorExato && inequivoco)) {
        await this.applyMatch(stmt.id, best.cand.id, "MATCHED", "auto");
        usedCobrancas.add(best.cand.id);
        result.matched += 1;
        const key = idExato ? "id_exato" : best.reasons.filter((r) => r !== "cobranca_em_aberto").join("+");
        result.byReason[key] = (result.byReason[key] ?? 0) + 1;
      }
    }

    // Passo 2: liquidações agrupadas (um crédito = soma de N boletos pagos)
    const grupo = await this.reconcileLiquidacoes(emitenteId, bankAccountId);
    result.matched += grupo.matched;
    if (grupo.matched > 0) {
      result.byReason["liquidacao_grupo"] = grupo.matched;
    }

    return result;
  },

  /**
   * Concilia créditos de liquidação de cobrança (ex.: "CRÉD.LIQUIDAÇÃO
   * COBRANÇA" do Sicoob) que agregam VÁRIOS boletos num único lançamento.
   * Para cada crédito, procura o subconjunto ÚNICO de boletos pagos na janela
   * de datas (pagamento até 3 dias antes / 1 dia depois do crédito) cuja soma
   * bate exatamente com o valor. Só aplica quando a combinação é única.
   */
  async reconcileLiquidacoes(
    emitenteId:    string,
    bankAccountId: string
  ): Promise<{ matched: number; cobrancasVinculadas: number }> {
    const statements = await prisma.bankStatement.findMany({
      where: {
        emitenteId,
        bankAccountId,
        reconciliationStatus: "UNMATCHED",
        entryType:            "CREDIT",
        cobrancaId:           null,
        description:          { contains: "LIQUID", mode: "insensitive" },
      },
      orderBy: { entryDate: "asc" },
    });

    const out = { matched: 0, cobrancasVinculadas: 0 };
    if (statements.length === 0) return out;

    const reconciledIds = await getReconciledCobrancaIds(emitenteId);

    const boletos = (await prisma.cobranca.findMany({
      where: {
        emitenteId,
        boletoStatus: "PAGO",
        boletoPagoEm: { not: null },
      },
      select: {
        id:              true,
        valor:           true,
        boletoValorPago: true,
        boletoPagoEm:    true,
      },
    }))
      .filter((c) => !reconciledIds.has(c.id))
      .map((c) => ({
        id:     c.id,
        cents:  c.boletoValorPago ?? c.valor,
        pagoEm: parseDateString(c.boletoPagoEm),
      }))
      .filter((b) => b.pagoEm !== null && b.cents > 0);

    if (boletos.length === 0) return out;

    const DAY = 86400000;
    const MAX_CANDIDATES = 30;
    const used = new Set<string>();

    for (const stmt of statements) {
      const target = Math.round(Number(stmt.amount) * 100);
      if (target <= 0) continue;

      // Janela: boleto pago entre 3 dias antes e 1 dia depois do crédito
      const lo = stmt.entryDate.getTime() - 3 * DAY;
      const hi = stmt.entryDate.getTime() + 1 * DAY;
      const candidates = boletos.filter(
        (b) => !used.has(b.id) && b.pagoEm!.getTime() >= lo && b.pagoEm!.getTime() <= hi
      );
      if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) {
        if (candidates.length > MAX_CANDIDATES) {
          console.log(`[reconciliation] Liquidação ${stmt.id}: ${candidates.length} candidatos (> ${MAX_CANDIDATES}), pulando`);
        }
        continue;
      }

      const subsetIdx = findUniqueSubset(candidates.map((c) => c.cents), target);
      if (!subsetIdx || subsetIdx.length === 0) continue;

      const picked = subsetIdx.map((i) => candidates[i]);

      if (picked.length === 1) {
        // Combinação única de 1 boleto → usa o vínculo 1:1 normal
        await this.applyMatch(stmt.id, picked[0].id, "MATCHED", "auto-liquidacao");
      } else {
        const now = new Date();
        await prisma.$transaction([
          prisma.bankStatement.update({
            where: { id: stmt.id },
            data:  {
              reconciliationStatus: "MATCHED",
              reconciledAt:         now,
              reconciledBy:         "auto-liquidacao",
            },
          }),
          prisma.bankStatementMatch.createMany({
            data: picked.map((p) => ({ statementId: stmt.id, cobrancaId: p.id })),
          }),
          prisma.cobranca.updateMany({
            where: { id: { in: picked.map((p) => p.id) } },
            data:  { reconciledAt: now, reconciledBy: "auto-liquidacao" },
          }),
        ]);
      }

      picked.forEach((p) => used.add(p.id));
      out.matched += 1;
      out.cobrancasVinculadas += picked.length;
    }

    if (out.matched > 0) {
      console.log(`[reconciliation] Liquidações agrupadas: ${out.matched} créditos ↔ ${out.cobrancasVinculadas} boletos`);
    }
    return out;
  },

  /**
   * Aplica em lote as sugestões com confiança >= minConfidence (padrão 0.9).
   * Greedy por confiança, sem reutilizar lançamento nem cobrança.
   */
  async applyAllSuggestions(
    emitenteId:    string,
    bankAccountId: string,
    minConfidence  = 0.9
  ): Promise<{ applied: number }> {
    const suggestions = await this.getSuggestions(emitenteId, bankAccountId);

    const usedStatements = new Set<string>();
    const usedCobrancas  = new Set<string>();
    let   applied        = 0;

    for (const s of suggestions) {
      if (s.confidence < minConfidence) break; // já vem ordenado desc
      if (usedStatements.has(s.statementId) || usedCobrancas.has(s.cobrancaId)) continue;
      await this.applyMatch(s.statementId, s.cobrancaId, "MATCHED", "auto-sugestao");
      usedStatements.add(s.statementId);
      usedCobrancas.add(s.cobrancaId);
      applied += 1;
    }

    return { applied };
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
      where:   { id: statementId, emitenteId },
      include: { groupMatches: { select: { cobrancaId: true } } },
    });
    if (!stmt) throw new Error("Statement not found");

    const cobrancaIds = [
      ...(stmt.cobrancaId ? [stmt.cobrancaId] : []),
      ...stmt.groupMatches.map((m) => m.cobrancaId),
    ];

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
      prisma.bankStatementMatch.deleteMany({ where: { statementId } }),
      ...(cobrancaIds.length
        ? [
            prisma.cobranca.updateMany({
              where: { id: { in: cobrancaIds } },
              data:  {
                reconciledAt: null,
                reconciledBy: null,
              },
            }),
          ]
        : []),
    ]);
  },

  /** Marca um lançamento como ignorado (não entra mais na conciliação). */
  async ignore(emitenteId: string, statementId: string, userId?: string): Promise<void> {
    const stmt = await prisma.bankStatement.findFirst({
      where: { id: statementId, emitenteId },
    });
    if (!stmt) throw new Error("Statement not found");
    if (stmt.cobrancaId) await this.unmatch(emitenteId, statementId);

    await prisma.bankStatement.update({
      where: { id: statementId },
      data:  {
        reconciliationStatus: "IGNORED",
        reconciledAt:         new Date(),
        reconciledBy:         userId ?? "manual",
      },
    });
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

    // Inclui cobranças EM ABERTO (além das pagas): é o que permite descobrir
    // "cliente cobrado por boleto que na verdade pagou por PIX/transferência".
    const candidates = await loadCandidates(emitenteId);

    const suggestions: ReconciliationSuggestion[] = [];
    const MAX_PER_STATEMENT = 3;

    for (const stmt of statements) {
      const scored = candidates
        .map((cand) => ({ cand, ...scoreMatch(stmt, cand) }))
        .filter((s) => s.score >= 0.4)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_PER_STATEMENT);

      for (const s of scored) {
        suggestions.push({
          statementId: stmt.id,
          cobrancaId:  s.cand.id,
          confidence:  s.score,
          reason:      s.reasons.join("+"),
          cobranca: {
            id:          s.cand.id,
            valor:       s.cand.valorCentavos,
            valorPago:   s.cand.amount,
            vencimento:  s.cand.vencimentoRaw,
            tomadorNome: s.cand.tomadorNome,
            emAberto:    s.cand.emAberto,
            statusLabel: s.cand.statusLabel,
          },
        });
      }
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  },

  /**
   * Lançamentos conciliados com o detalhe das cobranças liquidadas — inclui
   * os grupos N:1 (CRÉD.LIQUIDAÇÃO COBRANÇA com vários boletos/clientes).
   */
  async getMatched(emitenteId: string, bankAccountId?: string, take = 100) {
    const statements = await prisma.bankStatement.findMany({
      where: {
        emitenteId,
        ...(bankAccountId ? { bankAccountId } : {}),
        reconciliationStatus: { in: ["MATCHED", "MANUAL"] },
      },
      orderBy: { entryDate: "desc" },
      take,
      include: {
        cobranca: {
          include: {
            contrato: { select: { tomador: { select: { nome: true, cpfCnpj: true } } } },
          },
        },
        groupMatches: {
          include: {
            cobranca: {
              include: {
                contrato: { select: { tomador: { select: { nome: true, cpfCnpj: true } } } },
              },
            },
          },
        },
      },
    });

    return statements.map((s) => {
      const cobrancas = [
        ...(s.cobranca ? [s.cobranca] : []),
        ...s.groupMatches.map((m) => m.cobranca),
      ];
      return {
        id:                   s.id,
        entryDate:            s.entryDate,
        amount:               Number(s.amount),
        description:          s.description,
        reconciliationStatus: s.reconciliationStatus,
        reconciledBy:         s.reconciledBy,
        reconciledAt:         s.reconciledAt,
        cobrancas: cobrancas.map((c) => ({
          id:          c.id,
          tomadorNome: c.contrato?.tomador?.nome ?? null,
          tomadorDoc:  c.contrato?.tomador?.cpfCnpj ?? null,
          valor:       c.valor,
          valorPago:   c.boletoValorPago ?? c.baixaManualValorPago ?? c.valor,
          vencimento:  c.vencimento,
          competencia: c.competencia,
          nossoNumero: c.boletoNossoNumero,
          pagoEm:      c.pixPagoEm ?? parseDateString(c.boletoPagoEm) ?? parseDateString(c.baixaManualDataRecebimento),
        })),
      };
    });
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

    const [unmatched, matched, manual, ignored, pendingAgg] = await Promise.all([
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "UNMATCHED" } }),
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "MATCHED"   } }),
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "MANUAL"    } }),
      prisma.bankStatement.count({ where: { ...baseWhere, reconciliationStatus: "IGNORED"   } }),
      prisma.bankStatement.aggregate({
        where: { ...baseWhere, reconciliationStatus: "UNMATCHED", entryType: "CREDIT" },
        _sum:  { amount: true },
      }),
    ]);

    // Count paid cobranças not referenced by any statement
    const reconciledIds = await getReconciledCobrancaIds(emitenteId);
    const allPaidIds = await prisma.cobranca.findMany({
      where: {
        emitenteId,
        OR: [
          { pixStatus: "PAGO" },
          { boletoStatus: "PAGO" },
          { baixaManualStatus: "PAGO" },
        ],
      },
      select: { id: true },
    });
    const cobrancasSemExtrato = allPaidIds.filter((c) => !reconciledIds.has(c.id)).length;

    const total = unmatched + matched + manual + ignored;

    return {
      unmatched,
      matched,
      manual,
      ignored,
      total,
      pendingAmount: Number(pendingAgg._sum.amount ?? 0),
      cobrancasSemExtrato,
    };
  },

  async getCobrancasSemExtrato(emitenteId: string) {
    const reconciledIds = await getReconciledCobrancaIds(emitenteId);

    const allPaid = await prisma.cobranca.findMany({
      where: {
        emitenteId,
        OR: [
          { pixStatus: "PAGO" },
          { boletoStatus: "PAGO" },
          { baixaManualStatus: "PAGO" },
        ],
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
