/**
 * Apoio a Lancamento com rateio por fontes (usado por routers/financeiro.ts e routers/finGerencial.ts).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { prisma } from "../../db.js";
import type { DbFin } from "./audit.js";
import { ErroRateio, resolverRateio, type ItemRateio, type ItemRateioEntrada } from "./rateio.js";
import { deCentavos, deDataCal, paraDataCal, type Centavos, type DataCal } from "./util.js";

/** Include padrão de lançamento (emitente + rateio com o nome da fonte). */
export const INCLUDE_LANCAMENTO = {
  emitente: { select: { id: true, nome: true } },
  fontes: { include: { fonte: { select: { id: true, nome: true, tipo: true } } } },
} as const;

/** Entrada de data: "YYYY-MM-DD", "YYYY-MM" (dia 1) ou ISO completo (convertido para o dia em America/Bahia). */
export function dataCalDeEntrada(s: string): DataCal {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{4}-\d{2}$/.test(t)) return `${t}-01`;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: `data inválida: ${s}` });
  return paraDataCal(d);
}

/**
 * Data-calendário de Lancamento.data/competencia. Lançamentos antigos foram gravados com
 * `new Date("YYYY-MM-DD")` = 00:00 UTC (que no fuso da Bahia é o dia anterior): nesse caso exato
 * vale o dia UTC; o resto segue `paraDataCal` (12:00 UTC dos novos cai no mesmo dia).
 */
export function calLancamento(d: Date): DataCal {
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) {
    return d.toISOString().slice(0, 10);
  }
  return paraDataCal(d);
}

/** Converte a entrada de data em Date às 12:00 UTC (convenção do lib/fin). */
export function dateDeEntrada(s: string): Date {
  return deDataCal(dataCalDeEntrada(s));
}

/** Competência sempre gravada no dia 1 do mês. */
export function competenciaDeEntrada(s: string): Date {
  return deDataCal(`${dataCalDeEntrada(s).slice(0, 7)}-01`);
}

export const zItemRateio = z.object({
  fonteId: z.string().min(1),
  valor: z.number().positive().optional(),
  percentual: z.number().positive().max(100).optional(),
});

/** Resolve o rateio e traduz o erro para BAD_REQUEST. */
export function resolverRateioOuErro(totalCentavos: Centavos, itens: ItemRateioEntrada[]): ItemRateio[] {
  try {
    return resolverRateio(totalCentavos, itens);
  } catch (e) {
    if (e instanceof ErroRateio) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

/** Todas as fontes precisam existir, estar ativas e ser do emitente do lançamento. */
export async function validarFontesDoEmitente(emitenteId: string | null | undefined, fonteIds: string[]): Promise<void> {
  if (!fonteIds.length) return;
  if (!emitenteId) throw new TRPCError({ code: "BAD_REQUEST", message: "lançamento com rateio precisa de empresa emissora" });
  const ok = await prisma.finFonte.count({ where: { id: { in: fonteIds }, emitenteId, ativo: true } });
  if (ok !== new Set(fonteIds).size) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "fonte de recursos inválida, inativa ou de outra empresa" });
  }
}

/** Substitui o rateio do lançamento. */
export async function gravarRateio(db: DbFin, lancamentoId: string, itens: ItemRateio[]): Promise<void> {
  await db.finLancamentoFonte.deleteMany({ where: { lancamentoId } });
  if (!itens.length) return;
  await db.finLancamentoFonte.createMany({
    data: itens.map((i) => ({
      lancamentoId,
      fonteId: i.fonteId,
      valor: deCentavos(i.valorCentavos),
      percentual: i.percentual.toFixed(4),
    })),
  });
}
