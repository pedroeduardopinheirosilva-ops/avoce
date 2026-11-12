/**
 * Aplicações financeiras (§1.4 / decisão 8 do plano).
 * Movimentos: aplicacao (+) | rendimento (+) | resgate (−) | ir (−). Valores sempre positivos.
 * Rendimento mensal sugerido = saldo no início do mês × taxa do mês, onde
 * taxa = (Selic ou CDI do mês) × percentualIndexador/100  (102% do CDI → CDI × 1,02). Editável na tela.
 * Custo líquido do empréstimo = juros incorridos − (rendimento bruto − IR).
 */
import { taxaDoMes, type TabelaIndice } from "./indices.js";
import {
  arred, compararMes, mesDe, mesesEntre, primeiroDia, ultimoDia,
  type Centavos, type DataCal, type MesRef,
} from "./util.js";

export type TipoMovAplicacao = "aplicacao" | "resgate" | "rendimento" | "ir";
export type IndexadorAplicacao = "selic" | "cdi";

export interface MovAplicacao {
  id?: string;
  tipo: TipoMovAplicacao;
  data: DataCal;
  valorCentavos: Centavos;
  fonteId?: string | null;
}

export interface SaldoAplicacao {
  saldo: Centavos;
  aplicado: Centavos;
  resgatado: Centavos;
  rendimentoBruto: Centavos;
  ir: Centavos;
  rendimentoLiquido: Centavos; // rendimentoBruto − ir
}

const SINAL: Record<TipoMovAplicacao, 1 | -1> = { aplicacao: 1, rendimento: 1, resgate: -1, ir: -1 };

/** Saldo e totais considerando movimentos com data <= `ate` (todos, se omitido). */
export function saldoAplicacao(movs: MovAplicacao[], ate?: DataCal): SaldoAplicacao {
  const r: SaldoAplicacao = { saldo: 0, aplicado: 0, resgatado: 0, rendimentoBruto: 0, ir: 0, rendimentoLiquido: 0 };
  for (const m of movs) {
    if (ate && m.data > ate) continue;
    r.saldo += SINAL[m.tipo] * m.valorCentavos;
    if (m.tipo === "aplicacao") r.aplicado += m.valorCentavos;
    else if (m.tipo === "resgate") r.resgatado += m.valorCentavos;
    else if (m.tipo === "rendimento") r.rendimentoBruto += m.valorCentavos;
    else r.ir += m.valorCentavos;
  }
  r.rendimentoLiquido = r.rendimentoBruto - r.ir;
  return r;
}

export interface TabelasIndices {
  selic: TabelaIndice;
  cdi: TabelaIndice;
}

/** Taxa da aplicação no mês (% a.m.) já com o percentual do indexador. */
export function taxaAplicacaoMes(
  indexador: IndexadorAplicacao,
  percentualIndexador: number,
  tabelas: TabelasIndices,
  ano: number,
  mes: number,
): { taxaPct: number; projetado: boolean } | null {
  const t = taxaDoMes(indexador === "selic" ? tabelas.selic : tabelas.cdi, ano, mes);
  if (!t) return null;
  return { taxaPct: (t.taxaPct * percentualIndexador) / 100, projetado: t.projetado };
}

export interface RendimentoSugerido {
  ano: number;
  mes: number;
  saldoBase: Centavos; // saldo antes do dia 1 do mês
  taxaPct: number;
  projetado: boolean;
  valorCentavos: Centavos;
}

/** Rendimento sugerido do mês = saldo no início do mês × taxa do mês. */
export function sugerirRendimentoMes(args: {
  movs: MovAplicacao[];
  indexador: IndexadorAplicacao;
  percentualIndexador: number;
  tabelas: TabelasIndices;
  ano: number;
  mes: number;
}): RendimentoSugerido {
  const { ano, mes } = args;
  const dia1 = primeiroDia({ ano, mes });
  const saldoBase = saldoAplicacao(args.movs.filter((m) => m.data < dia1)).saldo;
  const t = taxaAplicacaoMes(args.indexador, args.percentualIndexador, args.tabelas, ano, mes);
  const taxaPct = t?.taxaPct ?? 0;
  return {
    ano, mes, saldoBase, taxaPct, projetado: t ? t.projetado : true,
    valorCentavos: saldoBase > 0 ? arred((saldoBase * taxaPct) / 100) : 0,
  };
}

/** Alíquota de IR regressivo de renda fixa (%), pelo prazo em dias corridos. */
export function aliquotaIrRegressivo(dias: number): number {
  if (dias <= 180) return 22.5;
  if (dias <= 360) return 20;
  if (dias <= 720) return 17.5;
  return 15;
}

/** IR sugerido sobre um rendimento (centavos) dado o prazo da aplicação. */
export function irSugerido(rendimentoCentavos: Centavos, dias: number): Centavos {
  return rendimentoCentavos > 0 ? arred((rendimentoCentavos * aliquotaIrRegressivo(dias)) / 100) : 0;
}

/** Soma dos resgates por fonte de destino. Resgate sem fonte vai em "sem_fonte". */
export function resgatesPorFonte(movs: MovAplicacao[], de?: DataCal, ate?: DataCal): Record<string, Centavos> {
  const out: Record<string, Centavos> = {};
  for (const m of movs) {
    if (m.tipo !== "resgate") continue;
    if ((de && m.data < de) || (ate && m.data > ate)) continue;
    const k = m.fonteId || "sem_fonte";
    out[k] = (out[k] ?? 0) + m.valorCentavos;
  }
  return out;
}

export interface LinhaExtratoAplicacao {
  ano: number;
  mes: number;
  saldoAnterior: Centavos;
  aplicacoes: Centavos;
  resgates: Centavos;
  rendimentos: Centavos;
  ir: Centavos;
  saldoAtual: Centavos;
}

/** Extrato mensal da aplicação de `de` até `ate` (default: primeiro e último mês com movimento). */
export function extratoAplicacao(movs: MovAplicacao[], de?: MesRef, ate?: MesRef): LinhaExtratoAplicacao[] {
  if (movs.length === 0 && (!de || !ate)) return [];
  const datas = movs.map((m) => m.data).sort();
  const ini = de ?? mesDe(datas[0]);
  const fim = ate ?? mesDe(datas[datas.length - 1]);
  if (compararMes(fim, ini) < 0) return [];
  let saldo = saldoAplicacao(movs.filter((m) => m.data < primeiroDia(ini))).saldo;
  return mesesEntre(ini, fim).map((ref) => {
    const a = primeiroDia(ref), b = ultimoDia(ref);
    const doMes = movs.filter((m) => m.data >= a && m.data <= b);
    const s = saldoAplicacao(doMes);
    const linha: LinhaExtratoAplicacao = {
      ano: ref.ano, mes: ref.mes, saldoAnterior: saldo,
      aplicacoes: s.aplicado, resgates: s.resgatado, rendimentos: s.rendimentoBruto, ir: s.ir,
      saldoAtual: saldo + s.saldo,
    };
    saldo = linha.saldoAtual;
    return linha;
  });
}

export interface CustoLiquidoEmprestimo {
  jurosIncorridos: Centavos;
  rendimentoBruto: Centavos;
  ir: Centavos;
  rendimentoLiquido: Centavos;
  custoLiquido: Centavos; // juros − rendimento líquido (negativo = aplicação rendeu mais que o custo)
}

/** Indicador "custo líquido do empréstimo" (decisão 8). */
export function custoLiquidoEmprestimo(args: {
  jurosIncorridosCentavos: Centavos;
  rendimentoBrutoCentavos: Centavos;
  irCentavos: Centavos;
}): CustoLiquidoEmprestimo {
  const rendimentoLiquido = args.rendimentoBrutoCentavos - args.irCentavos;
  return {
    jurosIncorridos: args.jurosIncorridosCentavos,
    rendimentoBruto: args.rendimentoBrutoCentavos,
    ir: args.irCentavos,
    rendimentoLiquido,
    custoLiquido: args.jurosIncorridosCentavos - rendimentoLiquido,
  };
}
