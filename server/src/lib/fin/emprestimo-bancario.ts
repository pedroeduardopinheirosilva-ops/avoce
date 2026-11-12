/**
 * Empréstimo bancário (§1.3 / decisão 7 do plano).
 *
 * Taxa do mês = (1+selic_mes) × (1+spread_anual)^(1/12) − 1   (spread default 6% a.a.).
 * Parcela k (k = 1..carência+N) vence em dataContratacao + k meses; os juros dela usam a Selic do
 * mês em que o período COMEÇA (vencimento − 1 mês) — é a taxa que já existe quando a parcela vence.
 * Mês sem Selic publicada → última conhecida, linha marcada `projetado`.
 *
 * Carência (k ≤ carenciaMeses):
 *   juros_pagos   → saldo constante; juros saem do caixa (prestação = juros);
 *   capitalizados → juros somam ao saldo; prestação 0.
 * Depois, N parcelas sobre o saldo do fim da carência:
 *   SAC   → amortização constante = saldo/N (resto de centavos na última); juros do mês sobre o saldo;
 *   Price → prestação recalculada a cada mês com a taxa do mês e o prazo remanescente.
 * IOF e tarifas: custo na contratação (reduzem o líquido recebido, entram no custo total).
 */
import { taxaDoMes, type TabelaIndice } from "./indices.js";
import { addMeses, addMesesData, arred, mesDe, type Centavos, type DataCal } from "./util.js";

export type SistemaAmortizacao = "sac" | "price";
export type CarenciaModo = "juros_pagos" | "capitalizados";

export interface ParamsEmprestimoBancario {
  dataContratacao: DataCal;
  valorCentavos: Centavos; // principal contratado
  carenciaMeses: number; // >= 0
  carenciaModo: CarenciaModo; // ignorado se carenciaMeses = 0
  sistema: SistemaAmortizacao;
  numParcelas: number; // >= 1
  spreadAnualPct?: number; // default 6 (% a.a.)
  iofCentavos?: Centavos;
  tarifasCentavos?: Centavos;
}

export interface LinhaCronogramaBancario {
  numero: number; // 1..carência+N
  fase: "carencia" | "amortizacao";
  parcelaAmortizacao: number | null; // 1..N na fase de amortização
  vencimento: DataCal;
  refAno: number; // mês cuja Selic foi usada
  refMes: number;
  selicPct: number;
  taxaMensalPct: number; // taxa efetiva do mês (Selic + spread), em %
  projetado: boolean;
  saldoInicial: Centavos;
  juros: Centavos; // juros do mês (pagos ou capitalizados)
  jurosCapitalizados: Centavos; // parte dos juros que foi para o saldo
  amortizacao: Centavos;
  prestacao: Centavos; // saída de caixa da parcela (juros pagos + amortização)
  saldoFinal: Centavos;
}

export interface CronogramaBancario {
  linhas: LinhaCronogramaBancario[];
  saldoFimCarencia: Centavos;
  totalJuros: Centavos;
  totalAmortizado: Centavos;
  totalPago: Centavos; // soma das prestações
  custoContratacao: Centavos; // IOF + tarifas
  valorLiquidoRecebido: Centavos; // principal − IOF − tarifas
  custoTotal: Centavos; // juros + IOF + tarifas
  avisos: string[];
}

/** Taxa efetiva mensal (fração): (1+selic)×(1+spread)^(1/12) − 1. */
export function taxaMensalBancaria(selicPct: number, spreadAnualPct = 6): number {
  return (1 + selicPct / 100) * Math.pow(1 + spreadAnualPct / 100, 1 / 12) - 1;
}

/** Prestação Price (centavos) para saldo, taxa (fração) e n parcelas restantes. */
export function prestacaoPrice(saldo: Centavos, taxa: number, n: number): Centavos {
  if (n <= 0) return saldo;
  if (taxa === 0) return arred(saldo / n);
  return arred((saldo * taxa) / (1 - Math.pow(1 + taxa, -n)));
}

export function cronogramaEmprestimoBancario(
  p: ParamsEmprestimoBancario,
  selic: TabelaIndice,
): CronogramaBancario {
  const avisos: string[] = [];
  if (!Number.isInteger(p.numParcelas) || p.numParcelas < 1) throw new Error("numParcelas deve ser >= 1");
  if (!Number.isInteger(p.carenciaMeses) || p.carenciaMeses < 0) throw new Error("carenciaMeses deve ser >= 0");
  const spread = p.spreadAnualPct ?? 6;
  const C = p.carenciaMeses;
  const N = p.numParcelas;
  const inicio = mesDe(p.dataContratacao);

  const linhas: LinhaCronogramaBancario[] = [];
  let saldo = p.valorCentavos;
  let saldoFimCarencia = C === 0 ? saldo : 0;
  let amortSac = 0;
  let semTaxa = false;

  for (let k = 1; k <= C + N; k++) {
    const ref = addMeses(inicio, k - 1);
    const tx = taxaDoMes(selic, ref.ano, ref.mes);
    if (!tx) semTaxa = true;
    const selicPct = tx?.taxaPct ?? 0;
    const taxa = taxaMensalBancaria(selicPct, spread);
    const saldoInicial = saldo;
    const juros = arred(saldoInicial * taxa);
    let jurosCap = 0, amortizacao = 0, prestacao = 0;
    let parcelaAmortizacao: number | null = null;

    if (k <= C) {
      if (p.carenciaModo === "capitalizados") {
        jurosCap = juros;
        saldo += juros;
      } else {
        prestacao = juros;
      }
      if (k === C) saldoFimCarencia = saldo;
    } else {
      const j = k - C;
      parcelaAmortizacao = j;
      const restantes = N - j + 1;
      if (j === 1 && p.sistema === "sac") amortSac = Math.floor(saldo / N);
      if (j === N) {
        amortizacao = saldo; // última quita o saldo (absorve o resto de centavos)
      } else if (p.sistema === "sac") {
        amortizacao = Math.min(amortSac, saldo);
      } else {
        amortizacao = Math.min(Math.max(prestacaoPrice(saldo, taxa, restantes) - juros, 0), saldo);
      }
      prestacao = juros + amortizacao;
      saldo -= amortizacao;
    }

    linhas.push({
      numero: k,
      fase: k <= C ? "carencia" : "amortizacao",
      parcelaAmortizacao,
      vencimento: addMesesData(p.dataContratacao, k),
      refAno: ref.ano,
      refMes: ref.mes,
      selicPct,
      taxaMensalPct: taxa * 100,
      projetado: tx ? tx.projetado : true,
      saldoInicial,
      juros,
      jurosCapitalizados: jurosCap,
      amortizacao,
      prestacao,
      saldoFinal: saldo,
    });
  }
  if (semTaxa) avisos.push("sem nenhuma taxa Selic cadastrada: cronograma calculado só com o spread");

  const custoContratacao = (p.iofCentavos ?? 0) + (p.tarifasCentavos ?? 0);
  const totalJuros = linhas.reduce((a, l) => a + l.juros, 0);
  return {
    linhas,
    saldoFimCarencia,
    totalJuros,
    totalAmortizado: linhas.reduce((a, l) => a + l.amortizacao, 0),
    totalPago: linhas.reduce((a, l) => a + l.prestacao, 0),
    custoContratacao,
    valorLiquidoRecebido: p.valorCentavos - custoContratacao,
    custoTotal: totalJuros + custoContratacao,
    avisos,
  };
}

/**
 * Saldo devedor contratual numa data: saldo final da última parcela vencida até `data`
 * (principal se nenhuma venceu). Não considera pagamentos reais — a Fase 2 confronta com os movimentos.
 */
export function saldoDevedorNaData(c: CronogramaBancario, principal: Centavos, data: DataCal): Centavos {
  let saldo = principal;
  for (const l of c.linhas) {
    if (l.vencimento <= data) saldo = l.saldoFinal;
    else break;
  }
  return saldo;
}

/** Juros incorridos (pagos + capitalizados) das parcelas com vencimento em [de, ate]. */
export function jurosNoPeriodo(c: CronogramaBancario, de: DataCal, ate: DataCal): Centavos {
  return c.linhas.filter((l) => l.vencimento >= de && l.vencimento <= ate).reduce((a, l) => a + l.juros, 0);
}
