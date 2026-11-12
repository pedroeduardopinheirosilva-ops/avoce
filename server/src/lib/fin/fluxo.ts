/**
 * Fluxo de caixa realizado + projetado, mês a mês (§1.1/§1.9). Puro.
 *
 * O router converte tudo (lançamentos, recebimentos, empréstimos, aplicações, recorrências) em
 * `EventoFluxo` e esta função agrega. Escopo do saldo: disponibilidades do escritório
 * (contas + aplicações), então aplicação/resgate são transferências internas e não aparecem;
 * o rendimento (líquido de IR) é entrada.
 *
 * Valores de terceiros (repasse ao cliente) aparecem em linhas próprias (`terceiros_*`) e
 * NUNCA entram em `liquidoEscritorio`; entram no `saldoFinal` porque o dinheiro passa pelo caixa.
 *
 * Previsto com data anterior ao mês corrente (vencido e não realizado) é empurrado para o mês
 * corrente e somado também em `atrasados` daquele mês.
 */
import { aplicarBp, arred, chaveMes, compararMes, idxMes, mesDe, mesesEntre, addMeses, paraBp, type Centavos, type DataCal, type MesRef, type Numerico } from "./util.js";
import { calcularHonorarios, type RepasseStatus } from "./recebimento.js";

export type LinhaFluxo =
  | "receitas_lancamentos" // + Lancamento tipo receita
  | "honorarios_recebimentos" // + honorários + sucumbência (FinRecebimento)
  | "aportes_psa" // + aporte do empréstimo PSA
  | "emprestimo_bancario" // + liberação do empréstimo bancário (líquida de IOF/tarifas)
  | "rendimento_aplicacao" // + rendimento líquido de IR
  | "despesas" // − Lancamento tipo despesa
  | "despesas_recorrentes" // − projeção de despesa recorrente ainda não lançada
  | "parcelas_emprestimo" // − parcela/juros/amortização do bancário
  | "devolucoes_psa" // − amortização/devolução/pagamento ao empréstimo PSA
  | "terceiros_entrada" // + parte do cliente recebida (valores de terceiros)
  | "terceiros_saida"; // − repasse ao cliente

export const SINAL_LINHA: Record<LinhaFluxo, 1 | -1> = {
  receitas_lancamentos: 1,
  honorarios_recebimentos: 1,
  aportes_psa: 1,
  emprestimo_bancario: 1,
  rendimento_aplicacao: 1,
  despesas: -1,
  despesas_recorrentes: -1,
  parcelas_emprestimo: -1,
  devolucoes_psa: -1,
  terceiros_entrada: 1,
  terceiros_saida: -1,
};

export const LINHAS_FLUXO = Object.keys(SINAL_LINHA) as LinhaFluxo[];
const TERCEIROS: ReadonlySet<LinhaFluxo> = new Set(["terceiros_entrada", "terceiros_saida"]);

export interface EventoFluxo {
  data: DataCal;
  linha: LinhaFluxo;
  valorCentavos: Centavos; // positivo; a linha dá o sinal
  realizado: boolean;
}

export interface ValorLinha {
  realizado: Centavos;
  projetado: Centavos;
}

export interface MesFluxo {
  ano: number;
  mes: number;
  situacao: "passado" | "corrente" | "futuro";
  linhas: Record<LinhaFluxo, ValorLinha>;
  entradas: Centavos; // escritório (sem terceiros), realizado + projetado
  saidas: Centavos; // escritório (sem terceiros), positivo
  liquidoEscritorio: Centavos; // entradas − saidas
  liquidoTerceiros: Centavos; // terceiros_entrada − terceiros_saida
  atrasados: Centavos; // previstos vencidos empurrados para este mês (valor absoluto, todas as linhas)
  saldoInicial: Centavos;
  saldoFinal: Centavos; // saldoInicial + liquidoEscritorio + liquidoTerceiros
}

export interface FluxoCaixa {
  meses: MesFluxo[];
  totais: Record<LinhaFluxo, ValorLinha>;
  ignorados: number; // eventos fora do horizonte
}

function linhasZeradas(): Record<LinhaFluxo, ValorLinha> {
  const o = {} as Record<LinhaFluxo, ValorLinha>;
  for (const l of LINHAS_FLUXO) o[l] = { realizado: 0, projetado: 0 };
  return o;
}

export function montarFluxoCaixa(args: {
  eventos: EventoFluxo[];
  de: MesRef;
  meses: number;
  hoje: DataCal;
  saldoInicialCentavos?: Centavos;
}): FluxoCaixa {
  const n = Math.max(1, Math.trunc(args.meses));
  const ate = addMeses(args.de, n - 1);
  const atual = mesDe(args.hoje);
  const lista = mesesEntre(args.de, ate);
  const porChave = new Map<string, MesFluxo>();
  const meses: MesFluxo[] = lista.map((r) => {
    const c = compararMes(r, atual);
    const m: MesFluxo = {
      ano: r.ano, mes: r.mes,
      situacao: c < 0 ? "passado" : c === 0 ? "corrente" : "futuro",
      linhas: linhasZeradas(),
      entradas: 0, saidas: 0, liquidoEscritorio: 0, liquidoTerceiros: 0, atrasados: 0, saldoInicial: 0, saldoFinal: 0,
    };
    porChave.set(chaveMes(r), m);
    return m;
  });

  const totais = linhasZeradas();
  let ignorados = 0;
  for (const e of args.eventos) {
    if (!e.valorCentavos) continue;
    let ref = mesDe(e.data);
    let atrasado = false;
    if (!e.realizado && idxMes(ref) < idxMes(atual)) {
      ref = atual;
      atrasado = true;
    }
    const m = porChave.get(chaveMes(ref));
    if (!m) {
      ignorados++;
      continue;
    }
    const campo = e.realizado ? "realizado" : "projetado";
    m.linhas[e.linha][campo] += e.valorCentavos;
    totais[e.linha][campo] += e.valorCentavos;
    if (atrasado) m.atrasados += e.valorCentavos;
  }

  let saldo = args.saldoInicialCentavos ?? 0;
  for (const m of meses) {
    for (const l of LINHAS_FLUXO) {
      const v = m.linhas[l].realizado + m.linhas[l].projetado;
      if (TERCEIROS.has(l)) m.liquidoTerceiros += SINAL_LINHA[l] * v;
      else if (SINAL_LINHA[l] > 0) m.entradas += v;
      else m.saidas += v;
    }
    m.liquidoEscritorio = m.entradas - m.saidas;
    m.saldoInicial = saldo;
    saldo += m.liquidoEscritorio + m.liquidoTerceiros;
    m.saldoFinal = saldo;
  }
  return { meses, totais, ignorados };
}

// ── Conversores usados pelo router ──────────────────────────────────────────

export interface RecebimentoFluxo {
  vencimento?: DataCal | null;
  dataRecebimento?: DataCal | null;
  valorPrevistoCentavos?: Centavos | null;
  valorBrutoCentavos?: Centavos | null;
  percHonorarios?: Numerico | null;
  valorHonorariosCentavos?: Centavos | null;
  valorSucumbenciaCentavos?: Centavos | null;
  valorRepasseCentavos?: Centavos | null;
  repasseStatus: RepasseStatus;
  repasseData?: DataCal | null;
}

/**
 * FinRecebimento → eventos. Recebido: honorários+sucumbência e parte do cliente realizados na data
 * do recebimento; repasse realizado na `repasseData` (ou na do recebimento); repasse pendente vira
 * saída projetada em `hoje`. Não recebido (com vencimento): mesma divisão sobre o valor previsto,
 * projetada no vencimento. Sem % e sem valor de honorários (e repasse aplicável) → todo o previsto é
 * tratado como valor de terceiros (conservador para a receita) e `semPercentual` = true.
 */
export function eventosDeRecebimento(r: RecebimentoFluxo, hoje: DataCal): { eventos: EventoFluxo[]; semPercentual: boolean } {
  const eventos: EventoFluxo[] = [];
  const suc = r.valorSucumbenciaCentavos ?? 0;
  if (r.dataRecebimento) {
    const bruto = r.valorBrutoCentavos ?? r.valorPrevistoCentavos ?? 0;
    let repasse: Centavos;
    if (r.repasseStatus === "nao_aplicavel") repasse = 0;
    else if (r.valorRepasseCentavos !== null && r.valorRepasseCentavos !== undefined) repasse = r.valorRepasseCentavos;
    else if (r.valorHonorariosCentavos !== null && r.valorHonorariosCentavos !== undefined) repasse = Math.max(bruto - r.valorHonorariosCentavos, 0);
    else repasse = bruto - aplicarBp(bruto, paraBp(r.percHonorarios ?? 0));
    const honor = bruto - repasse;
    eventos.push({ data: r.dataRecebimento, linha: "honorarios_recebimentos", valorCentavos: honor + suc, realizado: true });
    if (repasse > 0) {
      eventos.push({ data: r.dataRecebimento, linha: "terceiros_entrada", valorCentavos: repasse, realizado: true });
      if (r.repasseStatus === "realizado") {
        eventos.push({ data: r.repasseData ?? r.dataRecebimento, linha: "terceiros_saida", valorCentavos: repasse, realizado: true });
      } else {
        eventos.push({ data: hoje, linha: "terceiros_saida", valorCentavos: repasse, realizado: false });
      }
    }
    return { eventos, semPercentual: false };
  }
  if (!r.vencimento) return { eventos, semPercentual: false };
  const prev = r.valorPrevistoCentavos ?? 0;
  const semInfo = r.repasseStatus !== "nao_aplicavel"
    && (r.valorHonorariosCentavos === null || r.valorHonorariosCentavos === undefined)
    && (r.percHonorarios === null || r.percHonorarios === undefined || r.percHonorarios === "");
  let honor: Centavos;
  try {
    honor = calcularHonorarios({
      valorBrutoCentavos: prev,
      percHonorarios: r.percHonorarios ?? 0,
      honorariosInformadosCentavos: r.valorHonorariosCentavos !== null && r.valorHonorariosCentavos !== undefined
        ? Math.min(r.valorHonorariosCentavos, prev) : null,
      repasseStatus: r.repasseStatus,
    }).honorarios;
  } catch {
    honor = prev;
  }
  const repasse = prev - honor;
  if (honor + suc > 0) eventos.push({ data: r.vencimento, linha: "honorarios_recebimentos", valorCentavos: honor + suc, realizado: false });
  if (repasse > 0) {
    eventos.push({ data: r.vencimento, linha: "terceiros_entrada", valorCentavos: repasse, realizado: false });
    eventos.push({ data: r.vencimento, linha: "terceiros_saida", valorCentavos: repasse, realizado: false });
  }
  return { eventos, semPercentual: semInfo && prev > 0 };
}

/** Rendimento projetado de um saldo aplicado, capitalizando mês a mês. */
export function projetarRendimento(saldoInicial: Centavos, taxasPct: number[]): Centavos[] {
  let s = saldoInicial;
  return taxasPct.map((t) => {
    const r = s > 0 ? arred((s * t) / 100) : 0;
    s += r;
    return r;
  });
}
