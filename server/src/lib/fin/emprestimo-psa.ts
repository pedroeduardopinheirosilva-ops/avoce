/**
 * Empréstimo PSA (§1.2 / decisão 6 do plano).
 *
 * Cada aporte é um "lote" corrigido separadamente pela Selic a partir da própria data:
 *  - mês de entrada: fator = (1+selic)^(dias_restantes/dias_do_mês), dias_restantes contando o dia
 *    do aporte (aporte em 16/06 → 15/30; em 01/06 → mês cheio);
 *  - meses cheios: fator = 1+selic.
 * Amortização/devolução (e pagamentos) abatem os lotes mais antigos primeiro (FIFO), na data.
 * O lote corrige até o dia anterior à amortização; o que sobra segue corrigindo.
 * Correção arredondada a centavos por lote em cada trecho do mês (entre dois eventos).
 */
import { taxaDoMes, type TabelaIndice } from "./indices.js";
import {
  compararMes, diasNoMes, idxMes, mesDe, mesesEntre, partesData, arred,
  type Centavos, type DataCal, type MesRef,
} from "./util.js";

export type TipoMovEmprestimo =
  | "saldo_inicial" | "aporte" | "amortizacao" | "devolucao" | "pagamento_juros" | "pagamento_parcela";

/** Tipos que ENTRAM no saldo devedor; todos os demais abatem (FIFO). */
export const TIPOS_ENTRADA: ReadonlySet<TipoMovEmprestimo> = new Set(["saldo_inicial", "aporte"]);

export interface MovPsa {
  id?: string;
  tipo: TipoMovEmprestimo;
  data: DataCal;
  valorCentavos: Centavos; // positivo; o tipo dá o sinal
  previsto?: boolean; // aporte futuro (projeção)
}

export interface OpcoesExtratoPsa {
  selic: TabelaIndice;
  /** Último mês do extrato (inclusive). Default: mês do último movimento considerado. */
  ate?: MesRef;
  /** Considerar movimentos `previsto` (default true). */
  incluirPrevistos?: boolean;
}

export interface LinhaExtratoPsa {
  ano: number;
  mes: number;
  saldoAnterior: Centavos;
  aportes: Centavos;
  correcao: Centavos;
  amortizacoes: Centavos; // efetivamente abatido (limitado ao saldo)
  saldoAtual: Centavos; // = saldoAnterior + aportes + correcao − amortizacoes
  taxaPct: number; // Selic do mês usada (% a.m.)
  projetado: boolean; // taxa projetada (mês sem Selic publicada)
  temPrevisto: boolean; // houve movimento previsto no mês
}

export interface LotePsa {
  origemId?: string;
  data: DataCal;
  previsto: boolean;
  valorOriginal: Centavos;
  correcao: Centavos;
  amortizado: Centavos;
  saldo: Centavos; // = valorOriginal + correcao − amortizado
}

export interface ExtratoPsa {
  linhas: LinhaExtratoPsa[];
  lotes: LotePsa[];
  saldoFinal: Centavos;
  totalAportado: Centavos;
  totalCorrecao: Centavos;
  totalAmortizado: Centavos;
  avisos: string[];
}

function fatorTrecho(taxaPct: number, dias: number, diasMes: number): number {
  return Math.pow(1 + taxaPct / 100, dias / diasMes) - 1;
}

export function extratoEmprestimoPsa(movs: MovPsa[], opts: OpcoesExtratoPsa): ExtratoPsa {
  const incluirPrevistos = opts.incluirPrevistos ?? true;
  const avisos: string[] = [];
  const validos = movs
    .map((m, ordem) => ({ ...m, ordem }))
    .filter((m) => incluirPrevistos || !m.previsto)
    .filter((m) => {
      if (!Number.isInteger(m.valorCentavos) || m.valorCentavos < 0) {
        avisos.push(`movimento ${m.id ?? m.ordem} ignorado: valor inválido`);
        return false;
      }
      return true;
    })
    // mesma data: entradas antes das saídas; depois ordem de entrada
    .sort((a, b) =>
      a.data < b.data ? -1 : a.data > b.data ? 1
        : (TIPOS_ENTRADA.has(a.tipo) ? 0 : 1) - (TIPOS_ENTRADA.has(b.tipo) ? 0 : 1) || a.ordem - b.ordem);

  const vazio: ExtratoPsa = {
    linhas: [], lotes: [], saldoFinal: 0, totalAportado: 0, totalCorrecao: 0, totalAmortizado: 0, avisos,
  };
  if (validos.length === 0) return vazio;

  const inicio = mesDe(validos[0].data);
  const fim = opts.ate ?? mesDe(validos[validos.length - 1].data);
  if (compararMes(fim, inicio) < 0) return vazio;

  const lotes: LotePsa[] = [];
  const linhas: LinhaExtratoPsa[] = [];
  let semTaxaAvisado = false;

  for (const ref of mesesEntre(inicio, fim)) {
    const D = diasNoMes(ref.ano, ref.mes);
    const tx = taxaDoMes(opts.selic, ref.ano, ref.mes);
    if (!tx && !semTaxaAvisado) {
      avisos.push("sem nenhuma taxa Selic cadastrada: correção zero");
      semTaxaAvisado = true;
    }
    const taxaPct = tx?.taxaPct ?? 0;
    const projetado = tx ? tx.projetado : true;

    const saldoAnterior = lotes.reduce((a, l) => a + l.saldo, 0);
    let aportes = 0, correcao = 0, amortizacoes = 0, temPrevisto = false;

    const corrigir = (dias: number) => {
      if (dias <= 0 || taxaPct === 0) return;
      const f = fatorTrecho(taxaPct, dias, D);
      for (const l of lotes) {
        if (l.saldo <= 0) continue;
        const c = arred(l.saldo * f);
        l.saldo += c;
        l.correcao += c;
        correcao += c;
      }
    };

    const doMes = validos.filter((m) => idxMes(mesDe(m.data)) === idxMes(ref));
    let t = 0; // dias já corrigidos no mês
    for (const m of doMes) {
      const tEvt = partesData(m.data).dia - 1;
      corrigir(tEvt - t);
      t = tEvt;
      if (m.previsto) temPrevisto = true;
      if (TIPOS_ENTRADA.has(m.tipo)) {
        lotes.push({
          origemId: m.id, data: m.data, previsto: !!m.previsto,
          valorOriginal: m.valorCentavos, correcao: 0, amortizado: 0, saldo: m.valorCentavos,
        });
        aportes += m.valorCentavos;
      } else {
        let resta = m.valorCentavos;
        for (const l of lotes) {
          if (resta <= 0) break;
          const abate = Math.min(l.saldo, resta);
          l.saldo -= abate;
          l.amortizado += abate;
          resta -= abate;
          amortizacoes += abate;
        }
        if (resta > 0) avisos.push(`${m.tipo} de ${m.data} excede o saldo devedor em ${resta} centavos`);
      }
    }
    corrigir(D - t);

    linhas.push({
      ano: ref.ano, mes: ref.mes, saldoAnterior, aportes, correcao, amortizacoes,
      saldoAtual: saldoAnterior + aportes + correcao - amortizacoes,
      taxaPct, projetado, temPrevisto,
    });
  }

  const movsForaDoPeriodo = validos.filter((m) => compararMes(mesDe(m.data), fim) > 0).length;
  if (movsForaDoPeriodo) avisos.push(`${movsForaDoPeriodo} movimento(s) após ${fim.mes}/${fim.ano} não entraram no extrato`);

  return {
    linhas,
    lotes,
    saldoFinal: linhas[linhas.length - 1].saldoAtual,
    totalAportado: linhas.reduce((a, l) => a + l.aportes, 0),
    totalCorrecao: linhas.reduce((a, l) => a + l.correcao, 0),
    totalAmortizado: linhas.reduce((a, l) => a + l.amortizacoes, 0),
    avisos,
  };
}

/** Atalho: saldo devedor ao fim do mês `ref` (projeta Selic se preciso). */
export function saldoPsaNoMes(movs: MovPsa[], selic: TabelaIndice, ref: MesRef, incluirPrevistos = true): Centavos {
  const ex = extratoEmprestimoPsa(movs, { selic, ate: ref, incluirPrevistos });
  return ex.linhas.length ? ex.saldoFinal : 0;
}
