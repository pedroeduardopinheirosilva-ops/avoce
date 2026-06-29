import { z }         from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }    from "../db.js";
import { assertEmitenteAccess, whereEmitenteFilter } from "./tenant-utils.js";

export const contratoRouter = router({
  listar: authProc
    .input(z.object({
      emitenteId: z.string().optional(),
      apenasAtivos: z.boolean().default(true),
    }))
    .query(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      return prisma.contrato.findMany({
        where: {
          ...emitenteFilter,
          ...(input.emitenteId ? { emitenteId: input.emitenteId } : {}),
          ...(input.apenasAtivos ? { ativo: true } : {}),
        },
        include: {
          emitente:               { select: { id: true, nome: true, cnpj: true } },
          tomador:                { select: { id: true, nome: true, cpfCnpj: true } },
          parcelasPersonalizadas: { orderBy: { numero: "asc" } },
        },
        orderBy: { criadoEm: "desc" },
      });
    }),

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const c = await prisma.contrato.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          emitente:               true,
          tomador:                true,
          notas:                  { orderBy: { criadoEm: "desc" }, take: 24 },
          parcelasPersonalizadas: { orderBy: { numero: "asc" } },
        },
      });
      assertEmitenteAccess(ctx, c.emitente.id);
      return c;
    }),

  criar: authProc
    .input(z.object({
      emitenteId:       z.string(),
      tomadorId:        z.string(),
      nomeServico:      z.string().optional().nullable(),
      descricaoServico: z.string().min(5).max(2000),
      itemListaServico: z.string().optional().nullable(),
      codigoNbs:        z.string().optional().nullable(),
      valor:            z.number().int().positive(),
      diaVencimento:    z.number().int().min(1).max(30),
      issRetido:        z.boolean().default(false),
      retirIr:          z.boolean().default(false),
      retirCsll:        z.boolean().default(false),
      retirPis:         z.boolean().default(false),
      retirCofins:      z.boolean().default(false),
      metodoCobr:       z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]).default("PIX_BOLETO"),
      emitirNfseAuto:   z.boolean().default(false),
      gerarCobrancaAuto:z.boolean().default(true),
      tipoContrato:     z.enum(["RECORRENTE", "PARCELADO", "EVENTUAL"]).default("RECORRENTE"),
      totalParcelas:    z.number().int().positive().optional().nullable(),
      observacoes:      z.string().optional().nullable(),
      nfseAoFaturar:    z.boolean().default(true),
      emailsCobranca:   z.array(z.string().email()).max(4).default([]),
      parcelas:         z.array(z.object({
        numero:         z.number().int().positive(),
        valor:          z.number().int().positive(),
        dataVencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      assertEmitenteAccess(ctx, input.emitenteId);
      const { parcelas, ...contratoData } = input;
      const contrato = await prisma.contrato.create({ data: contratoData });
      if (parcelas?.length) {
        await prisma.contratoParcelaPersonalizada.createMany({
          data: parcelas.map(p => ({ ...p, contratoId: contrato.id })),
        });
      }
      return contrato;
    }),

  atualizar: authProc
    .input(z.object({
      id:               z.string(),
      nomeServico:      z.string().optional().nullable(),
      descricaoServico: z.string().min(5).max(2000).optional(),
      itemListaServico: z.string().optional().nullable(),
      codigoNbs:        z.string().optional().nullable(),
      valor:            z.number().int().positive().optional(),
      diaVencimento:    z.number().int().min(1).max(30).optional(),
      issRetido:        z.boolean().optional(),
      retirIr:          z.boolean().optional(),
      retirCsll:        z.boolean().optional(),
      retirPis:         z.boolean().optional(),
      retirCofins:      z.boolean().optional(),
      metodoCobr:       z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]).optional(),
      emitirNfseAuto:   z.boolean().optional(),
      gerarCobrancaAuto:z.boolean().optional(),
      tipoContrato:     z.enum(["RECORRENTE", "PARCELADO", "EVENTUAL"]).optional(),
      totalParcelas:    z.number().int().positive().optional().nullable(),
      ativo:            z.boolean().optional(),
      observacoes:      z.string().optional().nullable(),
      nfseAoFaturar:    z.boolean().optional(),
      emailsCobranca:   z.array(z.string().email()).max(4).optional(),
      parcelas:         z.array(z.object({
        numero:         z.number().int().positive(),
        valor:          z.number().int().positive(),
        dataVencimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        processada:     z.boolean().optional(),
      })).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, parcelas, ...data } = input;
      const c = await prisma.contrato.findUniqueOrThrow({ where: { id }, select: { emitenteId: true } });
      assertEmitenteAccess(ctx, c.emitenteId);
      const contrato = await prisma.contrato.update({ where: { id }, data });
      if (parcelas !== undefined) {
        await prisma.contratoParcelaPersonalizada.deleteMany({ where: { contratoId: id } });
        if (parcelas.length) {
          await prisma.contratoParcelaPersonalizada.createMany({
            data: parcelas.map(p => ({ contratoId: id, numero: p.numero, valor: p.valor, dataVencimento: p.dataVencimento, processada: p.processada ?? false })),
          });
        }
      }
      return contrato;
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const c = await prisma.contrato.findUniqueOrThrow({ where: { id }, select: { emitenteId: true } });
      assertEmitenteAccess(ctx, c.emitenteId);
      return prisma.contrato.update({
        where: { id: input.id },
        data:  { ativo: false },
      });
    }),

  reativar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const c = await prisma.contrato.findUniqueOrThrow({ where: { id }, select: { emitenteId: true } });
      assertEmitenteAccess(ctx, c.emitenteId);
      return prisma.contrato.update({
        where: { id },
        data:  { ativo: true },
      });
    }),

  deletar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const c = await prisma.contrato.findUniqueOrThrow({
        where: { id },
        select: { emitenteId: true, _count: { select: { cobrancas: true, notas: true } } },
      });
      assertEmitenteAccess(ctx, c.emitenteId);
      if (c._count.cobrancas > 0 || c._count.notas > 0) {
        throw new (await import("@trpc/server")).TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Não é possível excluir: contrato possui ${c._count.cobrancas} cobrança(s) e ${c._count.notas} nota(s) vinculada(s).`,
        });
      }
      return prisma.contrato.delete({ where: { id } });
    }),

  atualizarMetodoEmMassa: authProc
    .input(z.object({
      ids:        z.array(z.string()).min(1),
      metodoCobr: z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]),
    }))
    .mutation(async ({ input, ctx }) => {
      const emitenteFilter = whereEmitenteFilter(ctx);
      const result = await prisma.contrato.updateMany({
        where: { id: { in: input.ids }, ...emitenteFilter },
        data:  { metodoCobr: input.metodoCobr },
      });
      return { count: result.count };
    }),
});
