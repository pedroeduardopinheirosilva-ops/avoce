/**
 * Fontes de recursos (FinFonte) — semeadura das três padrão no primeiro acesso do emitente.
 * Idempotente e segura contra corrida (advisory lock por emitente). Só semeia se o emitente
 * não tiver NENHUMA fonte: uma fonte padrão excluída/renomeada depois não é recriada.
 */
import { prisma } from "../../db.js";

export const TIPOS_FONTE = ["emprestimo_psa", "emprestimo_bancario", "receita_propria", "outra"] as const;
export type TipoFonte = (typeof TIPOS_FONTE)[number];

export const FONTES_PADRAO: Array<{ nome: string; tipo: TipoFonte; ordem: number }> = [
  { nome: "Empréstimo PSA", tipo: "emprestimo_psa", ordem: 1 },
  { nome: "Empréstimo bancário", tipo: "emprestimo_bancario", ordem: 2 },
  { nome: "Receita própria (honorários)", tipo: "receita_propria", ordem: 3 },
];

export async function garantirFontesPadrao(emitenteId: string): Promise<void> {
  const ja = await prisma.finFonte.count({ where: { emitenteId } });
  if (ja > 0) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fin_fontes:${emitenteId}`}))`;
    const n = await tx.finFonte.count({ where: { emitenteId } });
    if (n > 0) return;
    await tx.finFonte.createMany({ data: FONTES_PADRAO.map((f) => ({ ...f, emitenteId })) });
  });
}

/** Primeira fonte ativa do tipo (semeando antes, se preciso). null se não houver. */
export async function fontePadraoDoTipo(emitenteId: string, tipo: TipoFonte): Promise<{ id: string; nome: string } | null> {
  await garantirFontesPadrao(emitenteId);
  return prisma.finFonte.findFirst({
    where: { emitenteId, tipo, ativo: true },
    orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }],
    select: { id: true, nome: true },
  });
}
