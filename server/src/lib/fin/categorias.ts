/**
 * Categorias de lançamento (§1.5). As antigas continuam aceitas (o campo é texto livre) e são
 * normalizadas para as novas nos relatórios (DRE, orçado × realizado, consumo por fonte).
 */

export const CATEGORIAS_RECEITA = ["Honorários Advocatícios", "Consultoria", "Êxito", "Mensalidade", "Outro"];

export const CATEGORIAS_DESPESA = [
  "Folha", "Comissões", "Estrutura", "Sistemas", "Marketing",
  "Consultorias", "Tributos", "Despesas processuais", "Outros",
];

/** Categorias de despesa usadas antes do §1.5 (ainda podem existir em lançamentos antigos). */
export const CATEGORIAS_DESPESA_LEGADO = ["Pessoal", "Aluguel", "Software", "Marketing", "Tributário", "Cartório", "Outro"];

export const MAPA_DESPESA_LEGADO: Record<string, string> = {
  Pessoal: "Folha",
  Aluguel: "Estrutura",
  Software: "Sistemas",
  Marketing: "Marketing",
  "Tributário": "Tributos",
  "Cartório": "Despesas processuais",
  Outro: "Outros",
};

export const SEM_CATEGORIA = "Sem categoria";

/** Categoria de despesa para relatório: legado → nova; vazia → "Sem categoria"; outras passam. */
export function normalizarCategoriaDespesa(c: string | null | undefined): string {
  const s = (c ?? "").trim();
  if (!s) return SEM_CATEGORIA;
  return MAPA_DESPESA_LEGADO[s] ?? s;
}

export function normalizarCategoriaReceita(c: string | null | undefined): string {
  const s = (c ?? "").trim();
  return s || SEM_CATEGORIA;
}
