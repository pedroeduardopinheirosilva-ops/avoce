/**
 * Agregações dos relatórios gerenciais (DRE, orçado × realizado, consumo por fonte). Puro, centavos.
 * As categorias chegam já normalizadas pelo router (ver categorias.ts).
 */
import { chaveMes, type Centavos, type MesRef } from "./util.js";

export interface ItemCategoriaMes {
  mes: MesRef;
  categoria: string;
  valorCentavos: Centavos;
}

export interface LinhaCategoria {
  categoria: string;
  valores: Centavos[]; // um por mês, na ordem de `meses`
  total: Centavos;
}

/** Agrupa por categoria × mês. Itens fora de `meses` são ignorados. Ordena por total desc. */
export function agruparCategoriaMes(itens: ItemCategoriaMes[], meses: MesRef[]): LinhaCategoria[] {
  const pos = new Map(meses.map((m, i) => [chaveMes(m), i]));
  const porCat = new Map<string, LinhaCategoria>();
  for (const it of itens) {
    const i = pos.get(chaveMes(it.mes));
    if (i === undefined) continue;
    let l = porCat.get(it.categoria);
    if (!l) {
      l = { categoria: it.categoria, valores: meses.map(() => 0), total: 0 };
      porCat.set(it.categoria, l);
    }
    l.valores[i] += it.valorCentavos;
    l.total += it.valorCentavos;
  }
  return [...porCat.values()].sort((a, b) => b.total - a.total || a.categoria.localeCompare(b.categoria));
}

export function somaColunas(linhas: LinhaCategoria[], nMeses: number): Centavos[] {
  const out = Array.from({ length: nMeses }, () => 0);
  for (const l of linhas) l.valores.forEach((v, i) => (out[i] += v));
  return out;
}

// ── DRE gerencial ───────────────────────────────────────────────────────────

export interface Dre {
  receitas: LinhaCategoria[]; // receita do escritório (honorários+sucumbência e Lancamento receita)
  despesas: LinhaCategoria[];
  financeiro: LinhaCategoria[]; // valores com sinal: + receita financeira, − despesa financeira
  totalReceitas: Centavos[];
  totalDespesas: Centavos[];
  resultadoOperacional: Centavos[];
  resultadoFinanceiro: Centavos[];
  resultadoLiquido: Centavos[];
}

export function montarDre(args: {
  meses: MesRef[];
  receitas: ItemCategoriaMes[];
  despesas: ItemCategoriaMes[];
  financeiro: ItemCategoriaMes[]; // com sinal
}): Dre {
  const n = args.meses.length;
  const receitas = agruparCategoriaMes(args.receitas, args.meses);
  const despesas = agruparCategoriaMes(args.despesas, args.meses);
  const financeiro = agruparCategoriaMes(args.financeiro, args.meses);
  const totalReceitas = somaColunas(receitas, n);
  const totalDespesas = somaColunas(despesas, n);
  const resultadoFinanceiro = somaColunas(financeiro, n);
  const resultadoOperacional = totalReceitas.map((r, i) => r - totalDespesas[i]);
  const resultadoLiquido = resultadoOperacional.map((r, i) => r + resultadoFinanceiro[i]);
  return { receitas, despesas, financeiro, totalReceitas, totalDespesas, resultadoOperacional, resultadoFinanceiro, resultadoLiquido };
}

// ── Orçado × realizado ──────────────────────────────────────────────────────

export interface CelulaOrcado {
  orcado: Centavos;
  realizado: Centavos;
  diferenca: Centavos; // orcado − realizado (negativo = estourou)
  percentual: number | null; // realizado / orcado × 100 (null sem orçamento)
}

export interface LinhaOrcado {
  categoria: string;
  meses: CelulaOrcado[];
  total: CelulaOrcado;
}

function celula(orcado: Centavos, realizado: Centavos): CelulaOrcado {
  return {
    orcado, realizado, diferenca: orcado - realizado,
    percentual: orcado > 0 ? Math.round((realizado / orcado) * 10000) / 100 : null,
  };
}

export function orcadoRealizado(args: {
  meses: MesRef[];
  orcamentos: ItemCategoriaMes[];
  realizados: ItemCategoriaMes[];
  /** Categorias que sempre aparecem (ex.: lista padrão), mesmo zeradas. */
  categoriasFixas?: string[];
}): { linhas: LinhaOrcado[]; totais: CelulaOrcado[]; total: CelulaOrcado } {
  const orc = agruparCategoriaMes(args.orcamentos, args.meses);
  const rea = agruparCategoriaMes(args.realizados, args.meses);
  const n = args.meses.length;
  const cats: string[] = [];
  for (const c of [...(args.categoriasFixas ?? []), ...orc.map((l) => l.categoria), ...rea.map((l) => l.categoria)]) {
    if (!cats.includes(c)) cats.push(c);
  }
  const zero = Array.from({ length: n }, () => 0);
  const linhas = cats.map((categoria) => {
    const o = orc.find((l) => l.categoria === categoria)?.valores ?? zero;
    const r = rea.find((l) => l.categoria === categoria)?.valores ?? zero;
    const tO = o.reduce((a, b) => a + b, 0), tR = r.reduce((a, b) => a + b, 0);
    return { categoria, meses: o.map((v, i) => celula(v, r[i])), total: celula(tO, tR) };
  });
  const totais = args.meses.map((_, i) => celula(
    linhas.reduce((a, l) => a + l.meses[i].orcado, 0),
    linhas.reduce((a, l) => a + l.meses[i].realizado, 0),
  ));
  const total = celula(totais.reduce((a, c) => a + c.orcado, 0), totais.reduce((a, c) => a + c.realizado, 0));
  return { linhas, totais, total };
}

// ── Consumo de recursos por fonte × categoria ───────────────────────────────

export interface ItemConsumo {
  mes: MesRef;
  fonteId: string; // "sem_fonte" para despesa sem rateio
  categoria: string;
  valorCentavos: Centavos;
}

export interface ConsumoFonte {
  fonteId: string;
  total: Centavos;
  porMes: Centavos[];
  categorias: LinhaCategoria[];
}

export function consumoPorFonte(itens: ItemConsumo[], meses: MesRef[]): { fontes: ConsumoFonte[]; totalPorMes: Centavos[]; total: Centavos } {
  const porFonte = new Map<string, ItemConsumo[]>();
  for (const it of itens) {
    const l = porFonte.get(it.fonteId) ?? [];
    l.push(it);
    porFonte.set(it.fonteId, l);
  }
  const fontes: ConsumoFonte[] = [...porFonte.entries()].map(([fonteId, lista]) => {
    const categorias = agruparCategoriaMes(lista, meses);
    const porMes = somaColunas(categorias, meses.length);
    return { fonteId, categorias, porMes, total: porMes.reduce((a, b) => a + b, 0) };
  }).filter((f) => f.total !== 0).sort((a, b) => b.total - a.total);
  const totalPorMes = meses.map((_, i) => fontes.reduce((a, f) => a + f.porMes[i], 0));
  return { fontes, totalPorMes, total: totalPorMes.reduce((a, b) => a + b, 0) };
}
