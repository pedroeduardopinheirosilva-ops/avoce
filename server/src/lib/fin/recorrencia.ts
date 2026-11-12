/**
 * Despesas recorrentes (Lancamento.recorrente = true). Puro.
 *
 * A série nasce do lançamento de origem (mês-base = mês da competência, ou da data se não houver)
 * e se repete todo mês até `recorrenciaFimEm` (mês inclusive; null = sem fim). A data de cada
 * ocorrência é a data da origem + n meses (dia ajustado ao fim do mês), então uma despesa de
 * competência 10/2026 paga em 05/11/2026 projeta competência 11/2026 paga em 05/12/2026.
 * O mês-base é o próprio lançamento de origem (não é projetado). Mês que já tem lançamento real da
 * série (`recorrenciaOrigemId` = origem, mesma competência) também não é projetado.
 * Nada é lançado automaticamente: a projeção só entra no fluxo de caixa; "lançar o mês" é ação explícita.
 */
import {
  addMeses, addMesesData, chaveMes, compararMes, idxMes, mesDe, mesesEntre, primeiroDia,
  type Centavos, type DataCal, type MesRef,
} from "./util.js";

export interface OrigemRecorrente {
  id: string;
  data: DataCal;
  competencia?: DataCal | null;
  recorrenciaFimEm?: DataCal | null;
  valorCentavos: Centavos;
  descricao: string;
  categoria?: string | null;
  fontes?: Array<{ fonteId: string; valorCentavos: Centavos }>;
}

export interface OcorrenciaRecorrente {
  origemId: string;
  ano: number; // mês de competência
  mes: number;
  data: DataCal; // data prevista do pagamento
  competencia: DataCal; // dia 1 do mês de competência
  valorCentavos: Centavos;
  descricao: string;
  categoria: string | null;
  fontes: Array<{ fonteId: string; valorCentavos: Centavos }>;
}

/** Chave para o conjunto de meses já lançados: `${origemId}|YYYY-MM` (mês de competência). */
export function chaveOcorrencia(origemId: string, ref: MesRef): string {
  return `${origemId}|${chaveMes(ref)}`;
}

export function mesBaseOrigem(o: Pick<OrigemRecorrente, "data" | "competencia">): MesRef {
  return mesDe(o.competencia ?? o.data);
}

/** Ocorrências (por mês de competência) em [de, ate] que ainda não foram lançadas. */
export function projetarRecorrencias(
  origens: OrigemRecorrente[],
  jaLancados: ReadonlySet<string>,
  de: MesRef,
  ate: MesRef,
): OcorrenciaRecorrente[] {
  const out: OcorrenciaRecorrente[] = [];
  for (const o of origens) {
    const base = mesBaseOrigem(o);
    const primeiro = addMeses(base, 1);
    const ini = compararMes(de, primeiro) > 0 ? de : primeiro;
    let fim = ate;
    if (o.recorrenciaFimEm) {
      const f = mesDe(o.recorrenciaFimEm);
      if (compararMes(f, fim) < 0) fim = f;
    }
    if (compararMes(fim, ini) < 0) continue;
    for (const ref of mesesEntre(ini, fim)) {
      if (jaLancados.has(chaveOcorrencia(o.id, ref))) continue;
      out.push({
        origemId: o.id,
        ano: ref.ano,
        mes: ref.mes,
        data: addMesesData(o.data, idxMes(ref) - idxMes(base)),
        competencia: primeiroDia(ref),
        valorCentavos: o.valorCentavos,
        descricao: o.descricao,
        categoria: o.categoria ?? null,
        fontes: (o.fontes ?? []).map((f) => ({ ...f })),
      });
    }
  }
  return out.sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : a.origemId.localeCompare(b.origemId)));
}
