/**
 * Índices mensais (Selic / CDI) — parse do SGS do Banco Central, busca e lookup com projeção.
 * Decisão 5 do plano: série 4390 (Selic acumulada no mês, % a.m.) e 4391 (CDI acumulado no mês).
 * Mês sem taxa publicada → usa a última taxa conhecida e marca `projetado: true`.
 */
import { chaveMes, compararMes, montarData, partesData, type DataCal, type MesRef } from "./util.js";

export type Indice = "selic" | "cdi";

export const SERIES_SGS: Record<Indice, number> = { selic: 4390, cdi: 4391 };

export interface TaxaMensal {
  indice: Indice;
  ano: number;
  mes: number;
  taxaPct: number; // % a.m. (1.1 = 1,10%)
}

export interface TaxaDoMes {
  taxaPct: number;
  projetado: boolean;
  /** Mês de onde a taxa veio (igual ao pedido quando não projetado). */
  base: MesRef;
}

/** Tabela de um índice, indexada por "YYYY-MM". Monte com `montarTabela`. */
export interface TabelaIndice {
  porMes: Map<string, number>;
  /** Meses conhecidos em ordem crescente. */
  meses: MesRef[];
}

/** "dd/mm/aaaa" ↔ DataCal */
function sgsParaData(s: string): DataCal | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s.trim());
  return m ? montarData(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

function dataParaSgs(d: DataCal): string {
  const { ano, mes, dia } = partesData(d);
  return `${String(dia).padStart(2, "0")}/${String(mes).padStart(2, "0")}/${ano}`;
}

/**
 * Converte o JSON do SGS (`[{data:"01/06/2025", valor:"1.10"}]`) em taxas mensais.
 * Itens malformados são ignorados; se o mesmo mês vier repetido, vale o último.
 * Lança erro se o corpo não for um array (ex.: página de erro do BCB).
 */
export function parseSgs(json: unknown, indice: Indice): TaxaMensal[] {
  if (!Array.isArray(json)) throw new Error("resposta do SGS/BCB não é uma lista");
  const porMes = new Map<string, TaxaMensal>();
  for (const it of json) {
    if (!it || typeof it !== "object") continue;
    const { data, valor } = it as { data?: unknown; valor?: unknown };
    if (typeof data !== "string" || (typeof valor !== "string" && typeof valor !== "number")) continue;
    const d = sgsParaData(data);
    const taxa = Number(String(valor).replace(",", "."));
    if (!d || !Number.isFinite(taxa)) continue;
    const { ano, mes } = partesData(d);
    porMes.set(chaveMes({ ano, mes }), { indice, ano, mes, taxaPct: taxa });
  }
  return [...porMes.values()].sort((a, b) => compararMes(a, b));
}

/** URL da API do SGS para o intervalo [inicio, fim]. */
export function urlSgs(indice: Indice, inicio: DataCal, fim: DataCal): string {
  return (
    `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${SERIES_SGS[indice]}/dados` +
    `?formato=json&dataInicial=${dataParaSgs(inicio)}&dataFinal=${dataParaSgs(fim)}`
  );
}

/**
 * Busca o índice no BCB (única função com I/O do lib/fin). `fetchFn` injetável para teste.
 * Lança erro em HTTP != 2xx ou corpo inválido.
 */
export async function buscarSgs(
  indice: Indice,
  inicio: DataCal,
  fim: DataCal,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<TaxaMensal[]> {
  const res = await fetchFn(urlSgs(indice, inicio, fim), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`SGS/BCB ${indice}: HTTP ${res.status}`);
  return parseSgs(await res.json(), indice);
}

/** Monta a tabela de lookup a partir das linhas (do banco ou do parse). */
export function montarTabela(taxas: Array<{ ano: number; mes: number; taxaPct: number }>): TabelaIndice {
  const porMes = new Map<string, number>();
  for (const t of taxas) porMes.set(chaveMes(t), t.taxaPct);
  const meses = [...porMes.keys()]
    .map((k) => ({ ano: Number(k.slice(0, 4)), mes: Number(k.slice(5, 7)) }))
    .sort(compararMes);
  return { porMes, meses };
}

/**
 * Taxa do mês. Sem taxa publicada: usa a do mês conhecido mais recente ANTERIOR ao pedido
 * (ou, se o pedido é anterior a tudo, a mais antiga) e marca `projetado`.
 * Retorna null só se a tabela estiver vazia.
 */
export function taxaDoMes(tabela: TabelaIndice, ano: number, mes: number): TaxaDoMes | null {
  const pedido = { ano, mes };
  const exata = tabela.porMes.get(chaveMes(pedido));
  if (exata !== undefined) return { taxaPct: exata, projetado: false, base: pedido };
  if (tabela.meses.length === 0) return null;
  let base = tabela.meses[0];
  for (const m of tabela.meses) {
    if (compararMes(m, pedido) < 0) base = m;
    else break;
  }
  return { taxaPct: tabela.porMes.get(chaveMes(base))!, projetado: true, base };
}

/**
 * O SGS publica o mês CORRENTE com o acumulado parcial (ex.: 0,36% em 12/11 para um mês de ~1,07%).
 * Gravar isso como a taxa do mês subestima a correção do mês e toda a projeção (que repete a
 * última taxa conhecida). Só meses já encerrados em relação a `hoje` entram; o mês corrente fica
 * "projetado" até o cron do mês seguinte trazer o valor fechado.
 */
export function apenasMesesFechados<T extends { ano: number; mes: number }>(taxas: T[], hoje: DataCal): T[] {
  const { ano, mes } = partesData(hoje);
  return taxas.filter((t) => compararMes(t, { ano, mes }) < 0);
}

/** Último mês com taxa publicada (null se vazia). */
export function ultimoMesConhecido(tabela: TabelaIndice): MesRef | null {
  return tabela.meses.length ? tabela.meses[tabela.meses.length - 1] : null;
}
