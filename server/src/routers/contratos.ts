import { z }         from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }    from "../db.js";

export const contratoRouter = router({
  listar: authProc
    .input(z.object({
      emitenteId: z.string().optional(),
      apenasAtivos: z.boolean().default(true),
    }))
    .query(async ({ input }) => {
      return prisma.contrato.findMany({
        where: {
          ...(input.emitenteId ? { emitenteId: input.emitenteId } : {}),
          ...(input.apenasAtivos ? { ativo: true } : {}),
        },
        include: {
          emitente: { select: { id: true, nome: true, cnpj: true } },
          tomador:  { select: { id: true, nome: true, cpfCnpj: true } },
        },
        orderBy: { criadoEm: "desc" },
      });
    }),

  obter: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return prisma.contrato.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          emitente: true,
          tomador:  true,
          notas: { orderBy: { criadoEm: "desc" }, take: 24 },
        },
      });
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
      diaVencimento:       z.number().int().min(1).max(28),
      issRetido:        z.boolean().default(false),
      retirIr:          z.boolean().default(false),
      retirCsll:        z.boolean().default(false),
      retirPis:         z.boolean().default(false),
      retirCofins:      z.boolean().default(false),
      metodoCobr:        z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]).default("PIX_BOLETO"),
      emitirNfseAuto:    z.boolean().default(false),
      gerarCobrancaAuto: z.boolean().default(true),
      tipoContrato:      z.enum(["RECORRENTE", "PARCELADO", "EVENTUAL"]).default("RECORRENTE"),
      totalParcelas:     z.number().int().positive().optional().nullable(),
      observacoes:       z.string().optional().nullable(),
    }))
    .mutation(async ({ input }) => {
      return prisma.contrato.create({ data: input });
    }),

  atualizar: authProc
    .input(z.object({
      id:               z.string(),
      nomeServico:      z.string().optional().nullable(),
      descricaoServico: z.string().min(5).max(2000).optional(),
      itemListaServico: z.string().optional().nullable(),
      codigoNbs:        z.string().optional().nullable(),
      valor:            z.number().int().positive().optional(),
      diaVencimento:       z.number().int().min(1).max(28).optional(),
      issRetido:        z.boolean().optional(),
      retirIr:          z.boolean().optional(),
      retirCsll:        z.boolean().optional(),
      retirPis:         z.boolean().optional(),
      retirCofins:      z.boolean().optional(),
      metodoCobr:        z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]).optional(),
      emitirNfseAuto:    z.boolean().optional(),
      gerarCobrancaAuto: z.boolean().optional(),
      tipoContrato:      z.enum(["RECORRENTE", "PARCELADO", "EVENTUAL"]).optional(),
      totalParcelas:     z.number().int().positive().optional().nullable(),
      ativo:            z.boolean().optional(),
      observacoes:      z.string().optional().nullable(),
    }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return prisma.contrato.update({ where: { id }, data });
    }),

  excluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.contrato.update({
        where: { id: input.id },
        data:  { ativo: false },
      });
    }),

  atualizarMetodoEmMassa: authProc
    .input(z.object({
      ids:        z.array(z.string()).min(1),
      metodoCobr: z.enum(["PIX_BOLETO", "PIX", "BOLETO", "NENHUM", "ALVARA"]),
    }))
    .mutation(async ({ input }) => {
      const result = await prisma.contrato.updateMany({
        where: { id: { in: input.ids } },
        data:  { metodoCobr: input.metodoCobr },
      });
      return { count: result.count };
    }),
});
