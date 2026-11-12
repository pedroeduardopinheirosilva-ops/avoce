import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { whereEmitenteFilter } from "./tenant-utils.js";
import {
  CATEGORIAS_RECEITA, CATEGORIAS_DESPESA, CATEGORIAS_DESPESA_LEGADO, MAPA_DESPESA_LEGADO,
} from "../lib/fin/categorias.js";
import { registrarAudit } from "../lib/fin/audit.js";
import { assertEmitenteDoTenant, exigirFinanceiroEditar, exigirFinanceiroLeitura } from "../lib/fin/perm.js";
import {
  INCLUDE_LANCAMENTO, competenciaDeEntrada, dateDeEntrada, gravarRateio, resolverRateioOuErro,
  validarFontesDoEmitente, zItemRateio,
} from "../lib/fin/lancamentos.js";
import { reescalarRateio, type ItemRateio } from "../lib/fin/rateio.js";
import { pathAnexoDoEmitente } from "../lib/fin/anexos.js";
import { deCentavos, paraCentavos } from "../lib/fin/util.js";

export const FORMAS_PAGAMENTO = ["pix", "boleto", "cartao", "transferencia", "dinheiro", "debito_automatico", "outro"] as const;

/**
 * Compatibilidade com a tela atual (web/src/pages/Financeiro.tsx):
 *  - todos os campos novos são opcionais; a tela antiga não manda `fontes` e continua funcionando
 *    (lançamento sem rateio, aparece como "Sem fonte" nos relatórios);
 *  - quando o cliente ENVIA `fontes` numa despesa, a lista não pode ser vazia e a soma tem de fechar
 *    com o valor (tela nova sempre manda);
 *  - `data` "YYYY-MM-DD" passa a ser gravada às 12:00 UTC (deDataCal), o mesmo dia em qualquer fuso;
 *  - mutações exigem `financeiro_editar` OU `financeiro` (modo legado: quem já lança continua lançando).
 */
const zCamposGerenciais = {
  competencia: z.string().nullable().optional(), // "YYYY-MM" ou "YYYY-MM-DD" (gravada no dia 1)
  fornecedor: z.string().max(200).nullable().optional(),
  formaPagamento: z.enum(FORMAS_PAGAMENTO).nullable().optional(),
  recorrente: z.boolean().optional(),
  recorrenciaFimEm: z.string().nullable().optional(), // mês final da recorrência (inclusive); null = sem fim
  comprovantePath: z.string().nullable().optional(), // devolvido por POST /api/fin-anexos/upload
  comprovanteNome: z.string().max(255).nullable().optional(),
  fontes: z.array(zItemRateio).optional(),
};

function exigirComprovanteDoEmitente(path: string | null | undefined, emitenteId: string | null | undefined): void {
  if (!path) return;
  if (!emitenteId || !pathAnexoDoEmitente(path, emitenteId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "comprovante inválido para esta empresa emissora" });
  }
}

function camposGerenciaisParaDb(i: {
  competencia?: string | null; fornecedor?: string | null; formaPagamento?: string | null;
  recorrente?: boolean; recorrenciaFimEm?: string | null; comprovantePath?: string | null; comprovanteNome?: string | null;
}): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  if (i.competencia !== undefined) d.competencia = i.competencia ? competenciaDeEntrada(i.competencia) : null;
  if (i.fornecedor !== undefined) d.fornecedor = i.fornecedor?.trim() || null;
  if (i.formaPagamento !== undefined) d.formaPagamento = i.formaPagamento;
  if (i.recorrente !== undefined) d.recorrente = i.recorrente;
  if (i.recorrenciaFimEm !== undefined) d.recorrenciaFimEm = i.recorrenciaFimEm ? competenciaDeEntrada(i.recorrenciaFimEm) : null;
  if (i.comprovantePath !== undefined) {
    d.comprovantePath = i.comprovantePath || null;
    if (!i.comprovantePath) d.comprovanteNome = null;
  }
  if (i.comprovanteNome !== undefined && i.comprovantePath !== null) d.comprovanteNome = i.comprovanteNome || null;
  return d;
}

export const financeiroRouter = router({

  categorias: authProc.query(async () => {
    return {
      receita: CATEGORIAS_RECEITA,
      despesa: CATEGORIAS_DESPESA,
      despesaLegado: CATEGORIAS_DESPESA_LEGADO,
      mapaDespesaLegado: MAPA_DESPESA_LEGADO,
      formasPagamento: FORMAS_PAGAMENTO,
    };
  }),

  listar: authProc
    .input(z.object({
      mes: z.number().int().min(1).max(12).optional(),
      ano: z.number().int().optional(),
      tipo: z.enum(["receita", "despesa"]).optional(),
      emitenteId: z.string().optional(),
      // filtros novos (opcionais)
      categoria: z.string().optional(),
      fonteId: z.string().optional(), // "sem_fonte" = lançamentos sem rateio
      recorrente: z.boolean().optional(),
      porCompetencia: z.boolean().optional(), // filtra pelo mês de competência (sem competência → data)
    }))
    .query(async ({ input, ctx }) => {
      exigirFinanceiroLeitura(ctx);
      const ano = input.ano ?? new Date().getFullYear();
      const mes = input.mes;

      const dataInicio = mes
        ? new Date(ano, mes - 1, 1)
        : new Date(ano, 0, 1);
      const dataFim = mes
        ? new Date(ano, mes, 0, 23, 59, 59)
        : new Date(ano, 11, 31, 23, 59, 59);

      const emitenteFilter = whereEmitenteFilter(ctx);
      const where: Record<string, unknown> = { ...emitenteFilter };
      const faixa = { gte: dataInicio, lte: dataFim };
      if (input.porCompetencia) {
        where.OR = [{ competencia: faixa }, { competencia: null, data: faixa }];
      } else {
        where.data = faixa;
      }
      if (input.tipo) where.tipo = input.tipo;
      if (input.emitenteId) where.emitenteId = input.emitenteId;
      if (input.categoria) where.categoria = input.categoria;
      if (input.recorrente !== undefined) where.recorrente = input.recorrente;
      if (input.fonteId === "sem_fonte") where.fontes = { none: {} };
      else if (input.fonteId) where.fontes = { some: { fonteId: input.fonteId } };

      const lancamentos = await prisma.lancamento.findMany({
        where,
        orderBy: { data: "desc" },
        include: INCLUDE_LANCAMENTO,
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

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      exigirFinanceiroLeitura(ctx);
      const l = await prisma.lancamento.findFirst({ where: { id: input.id, ...whereEmitenteFilter(ctx) }, include: INCLUDE_LANCAMENTO });
      if (!l) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado" });
      return l;
    }),

  resumoAnual: authProc
    .input(z.object({ ano: z.number().int().optional() }))
    .query(async ({ input, ctx }) => {
      exigirFinanceiroLeitura(ctx);
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
      data: z.string(), // "YYYY-MM-DD" (ou ISO)
      emitenteId: z.string().optional(),
      dealId: z.string().optional(),
      pago: z.boolean().default(true),
      obs: z.string().optional(),
      ...zCamposGerenciais,
    }))
    .mutation(async ({ input, ctx }) => {
      exigirFinanceiroEditar(ctx, { legado: true });
      const { data: dataStr, fontes, competencia, fornecedor, formaPagamento, recorrente, recorrenciaFimEm,
        comprovantePath, comprovanteNome, valor, ...rest } = input;
      if (rest.emitenteId) await assertEmitenteDoTenant(ctx, rest.emitenteId);
      const valorC = paraCentavos(valor);

      let rateio: ItemRateio[] = [];
      if (fontes !== undefined) {
        if (input.tipo === "despesa" && fontes.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "informe a fonte de recursos da despesa" });
        }
        if (fontes.length) {
          rateio = resolverRateioOuErro(valorC, fontes);
          await validarFontesDoEmitente(rest.emitenteId, rateio.map((r) => r.fonteId));
        }
      }
      exigirComprovanteDoEmitente(comprovantePath, rest.emitenteId);

      return prisma.$transaction(async (tx) => {
        const criado = await tx.lancamento.create({
          data: {
            ...rest,
            valor: deCentavos(valorC),
            data: dateDeEntrada(dataStr),
            criadoPorId: ctx.userId ?? null,
            ...camposGerenciaisParaDb({ competencia, fornecedor, formaPagamento, recorrente, recorrenciaFimEm, comprovantePath, comprovanteNome }),
          },
        });
        await gravarRateio(tx, criado.id, rateio);
        const depois = await tx.lancamento.findUniqueOrThrow({ where: { id: criado.id }, include: INCLUDE_LANCAMENTO });
        await registrarAudit(tx, ctx, { emitenteId: criado.emitenteId, entidade: "Lancamento", entidadeId: criado.id, acao: "criar", depois });
        return depois;
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
      ...zCamposGerenciais,
    }))
    .mutation(async ({ input, ctx }) => {
      exigirFinanceiroEditar(ctx, { legado: true });
      const { id, data: dataStr, fontes, competencia, fornecedor, formaPagamento, recorrente, recorrenciaFimEm,
        comprovantePath, comprovanteNome, valor, ...rest } = input;
      const antes = await prisma.lancamento.findUnique({ where: { id }, include: INCLUDE_LANCAMENTO });
      if (!antes) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado" });
      if (antes.emitenteId) await assertEmitenteDoTenant(ctx, antes.emitenteId);

      const valorC = valor !== undefined ? paraCentavos(valor) : paraCentavos(antes.valor);
      const tipoFinal = rest.tipo ?? antes.tipo;
      let novoRateio: ItemRateio[] | null = null; // null = não mexe
      if (fontes !== undefined) {
        if (tipoFinal === "despesa" && fontes.length === 0) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "informe a fonte de recursos da despesa" });
        }
        novoRateio = fontes.length ? resolverRateioOuErro(valorC, fontes) : [];
        await validarFontesDoEmitente(antes.emitenteId, novoRateio.map((r) => r.fonteId));
      } else if (antes.fontes.length && valorC !== paraCentavos(antes.valor)) {
        // valor mudou pela tela antiga: mantém as proporções do rateio
        novoRateio = reescalarRateio(antes.fontes.map((f) => ({ fonteId: f.fonteId, valorCentavos: paraCentavos(f.valor) })), valorC);
      }
      exigirComprovanteDoEmitente(comprovantePath, antes.emitenteId);

      return prisma.$transaction(async (tx) => {
        await tx.lancamento.update({
          where: { id },
          data: {
            ...rest,
            ...(valor !== undefined ? { valor: deCentavos(valorC) } : {}),
            data: dataStr ? dateDeEntrada(dataStr) : undefined,
            ...camposGerenciaisParaDb({ competencia, fornecedor, formaPagamento, recorrente, recorrenciaFimEm, comprovantePath, comprovanteNome }),
          },
        });
        if (novoRateio) await gravarRateio(tx, id, novoRateio);
        const depois = await tx.lancamento.findUniqueOrThrow({ where: { id }, include: INCLUDE_LANCAMENTO });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "Lancamento", entidadeId: id, acao: "atualizar", antes, depois });
        return depois;
      });
    }),

  deletar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      exigirFinanceiroEditar(ctx, { legado: true });
      const { id } = input;
      const antes = await prisma.lancamento.findUnique({ where: { id }, include: INCLUDE_LANCAMENTO });
      if (!antes) throw new TRPCError({ code: "NOT_FOUND", message: "Lançamento não encontrado" });
      if (antes.emitenteId) await assertEmitenteDoTenant(ctx, antes.emitenteId);
      return prisma.$transaction(async (tx) => {
        const r = await tx.lancamento.delete({ where: { id } });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "Lancamento", entidadeId: id, acao: "excluir", antes });
        return r;
      });
    }),
});
