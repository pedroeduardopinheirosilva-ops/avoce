import { z } from "zod";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { whereEmitenteFilter, assertEmitenteAccess } from "./tenant-utils.js";

const CATEGORIAS_RECEITA = ["Honorários Advocatícios", "Consultoria", "Êxito", "Mensalidade", "Outro"];
const CATEGORIAS_DESPESA = ["Pessoal", "Aluguel", "Software", "Marketing", "Tributário", "Cartório", "Outro"];

export const financeiroRouter = router({

  categorias: authProc.query(async () => {
    return { receita: CATEGORIAS_RECEITA, despesa: CATEGORIAS_DESPESA };
  }),

  listar: authProc
    .input(z.object({
      mes: z.number().int().min(1).max(12).optional(),
      ano: z.number().int().optional(),
      tipo: z.enum(["receita", "despesa"]).optional(),
      emitenteId: z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const ano = input.ano ?? new Date().getFullYear();
      const mes = input.mes;

      const dataInicio = mes
        ? new Date(ano, mes - 1, 1)
        : new Date(ano, 0, 1);
      const dataFim = mes
        ? new Date(ano, mes, 0, 23, 59, 59)
        : new Date(ano, 11, 31, 23, 59, 59);

      const emitenteFilter = whereEmitenteFilter(ctx);
      const where: Record<string, unknown> = {
        ...emitenteFilter,
        data: { gte: dataInicio, lte: dataFim },
      };
      if (input.tipo) where.tipo = input.tipo;
      if (input.emitenteId) where.emitenteId = input.emitenteId;

      const lancamentos = await prisma.lancamento.findMany({
        where,
        orderBy: { data: "desc" },
        include: { emitente: { select: { id: true, nome: true } } },
      });

      // Aggregates
      const totalReceita = lancamentos
        .filter(l => l.tipo === "receita")
        .reduce((acc, l) => acc + Number(l.valor), 0);
      const totalDespesa = lancamentos
        .filter(l => l.tipo === "despesa")
        .reduce((acc, l) => acc + Number(l.valor), 0);

      return {
        lancamentos,
        totalReceita,
        totalDespesa,
        saldo: totalReceita - totalDespesa,
      };
    }),

  resumoAnual: authProc
    .input(z.object({ ano: z.number().int().optional() }))
    .query(async ({ input, ctx }) => {
      const ano = input.ano ?? new Date().getFullYear();
      const meses = Array.from({ length: 12 }, (_, i) => i + 1);
      const emitenteFilter = whereEmitenteFilter(ctx);

      const rows = await Promise.all(
        meses.map(async (mes) => {
          const dataInicio = new Date(ano, mes - 1, 1);
          const dataFim = new Date(ano, mes, 0, 23, 59, 59);
          const items = await prisma.lancamento.findMany({
            where: { ...emitenteFilter, data: { gte: dataInicio, lte: dataFim } },
            select: { tipo: true, valor: true },
          });
          const receita = items.filter(i => i.tipo === "receita").reduce((a, i) => a + Number(i.valor), 0);
          const despesa = items.filter(i => i.tipo === "despesa").reduce((a, i) => a + Number(i.valor), 0);
          return { mes, receita, despesa, saldo: receita - despesa };
        })
      );
      return rows;
    }),

  criar: authProc
    .input(z.object({
      tipo: z.enum(["receita", "despesa"]),
      descricao: z.string().min(1),
      categoria: z.string().optional(),
      valor: z.number().positive(),
      data: z.string(), // ISO date string
      emitenteId: z.string().optional(),
      dealId: z.string().optional(),
      pago: z.boolean().default(true),
      obs: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { data: dataStr, ...rest } = input;
      if (rest.emitenteId) assertEmitenteAccess(ctx, rest.emitenteId);
      return prisma.lancamento.create({
        data: { ...rest, data: new Date(dataStr) },
        include: { emitente: { select: { id: true, nome: true } } },
      });
    }),

  atualizar: authProc
    .input(z.object({
      id: z.string(),
      tipo: z.enum(["receita", "despesa"]).optional(),
      descricao: z.string().min(1).optional(),
      categoria: z.string().optional(),
      valor: z.number().positive().optional(),
      data: z.string().optional(),
      pago: z.boolean().optional(),
      obs: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, data: dataStr, ...rest } = input;
      const l = await prisma.lancamento.findUniqueOrThrow({ where: { id }, select: { emitenteId: true } });
      if (l.emitenteId) assertEmitenteAccess(ctx, l.emitenteId);
      return prisma.lancamento.update({
        where: { id },
        data: { ...rest, data: dataStr ? new Date(dataStr) : undefined },
        include: { emitente: { select: { id: true, nome: true } } },
      });
    }),

  deletar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const l = await prisma.lancamento.findUniqueOrThrow({ where: { id }, select: { emitenteId: true } });
      if (l.emitenteId) assertEmitenteAccess(ctx, l.emitenteId);
      return prisma.lancamento.delete({ where: { id: input.id } });
    }),
});
