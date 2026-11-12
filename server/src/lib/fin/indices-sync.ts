/**
 * Importação dos índices (Selic 4390 / CDI 4391) do BCB para FinIndiceMensal — com I/O (Prisma + rede).
 * Nunca sobrescreve linhas `origem: "manual"`. Usado pelo cron diário e pelo botão "Importar agora".
 */
import { prisma } from "../../db.js";
import { apenasMesesFechados, buscarSgs, montarTabela, type Indice, type TabelaIndice } from "./indices.js";
import { addMeses, mesDe, paraDataCal, paraTaxaPct, primeiroDia, type DataCal } from "./util.js";

export interface ResultadoImportacao {
  indice: Indice;
  recebidos: number;
  criados: number;
  atualizados: number;
  inalterados: number;
  manuaisPreservados: number;
  erro?: string;
}

/** Taxa com 8 casas, como o Decimal(12,8) do banco. */
function taxa8(t: number): string {
  return t.toFixed(8);
}

export async function importarIndiceBcb(
  indice: Indice,
  inicio: DataCal,
  fim: DataCal,
  fetchFn: typeof fetch = fetch,
): Promise<ResultadoImportacao> {
  const r: ResultadoImportacao = { indice, recebidos: 0, criados: 0, atualizados: 0, inalterados: 0, manuaisPreservados: 0 };
  let taxas;
  try {
    taxas = apenasMesesFechados(await buscarSgs(indice, inicio, fim, fetchFn), paraDataCal(new Date()));
  } catch (e) {
    r.erro = e instanceof Error ? e.message : String(e);
    return r;
  }
  r.recebidos = taxas.length;
  if (!taxas.length) return r;
  const existentes = await prisma.finIndiceMensal.findMany({
    where: { indice, OR: taxas.map((t) => ({ ano: t.ano, mes: t.mes })) },
  });
  const porChave = new Map(existentes.map((e) => [`${e.ano}-${e.mes}`, e]));
  for (const t of taxas) {
    const ex = porChave.get(`${t.ano}-${t.mes}`);
    const nova = taxa8(t.taxaPct);
    if (!ex) {
      await prisma.finIndiceMensal.create({ data: { indice, ano: t.ano, mes: t.mes, taxa: nova, origem: "bcb" } });
      r.criados++;
    } else if (ex.origem === "manual") {
      r.manuaisPreservados++;
    } else if (taxa8(paraTaxaPct(ex.taxa)) !== nova) {
      await prisma.finIndiceMensal.update({ where: { id: ex.id }, data: { taxa: nova } });
      r.atualizados++;
    } else {
      r.inalterados++;
    }
  }
  return r;
}

/**
 * Importa Selic e CDI de `mesesAtras` meses atrás até hoje (default 24). Não lança: erro de
 * rede/BCB volta em `erro` de cada índice.
 */
export async function importarIndicesBcb(opts?: { desde?: DataCal; mesesAtras?: number; indices?: Indice[]; fetchFn?: typeof fetch }): Promise<ResultadoImportacao[]> {
  const hoje = paraDataCal(new Date());
  const inicio = opts?.desde ?? primeiroDia(addMeses(mesDe(hoje), -(opts?.mesesAtras ?? 24)));
  const out: ResultadoImportacao[] = [];
  for (const indice of opts?.indices ?? (["selic", "cdi"] as Indice[])) {
    out.push(await importarIndiceBcb(indice, inicio, hoje, opts?.fetchFn));
  }
  return out;
}

/** Tabelas de lookup carregadas do banco (todas as linhas; são poucas: 12/ano por índice). */
export async function carregarTabelasIndices(): Promise<{ selic: TabelaIndice; cdi: TabelaIndice }> {
  const rows = await prisma.finIndiceMensal.findMany({ select: { indice: true, ano: true, mes: true, taxa: true } });
  const conv = (i: string) => rows.filter((r) => r.indice === i).map((r) => ({ ano: r.ano, mes: r.mes, taxaPct: paraTaxaPct(r.taxa) }));
  return { selic: montarTabela(conv("selic")), cdi: montarTabela(conv("cdi")) };
}

/** Cron diário: loga e nunca lança. */
export async function cronImportarIndices(): Promise<void> {
  try {
    const res = await importarIndicesBcb({ mesesAtras: 3 });
    for (const r of res) {
      if (r.erro) console.warn(`[FinIndices] ${r.indice}: falha ao importar do BCB — ${r.erro}`);
      else console.log(`[FinIndices] ${r.indice}: ${r.recebidos} recebidos, ${r.criados} novos, ${r.atualizados} atualizados, ${r.manuaisPreservados} manuais preservados`);
    }
  } catch (e) {
    console.error("[FinIndices] erro inesperado no cron:", e);
  }
}

