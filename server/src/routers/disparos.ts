import { z }                from "zod";
import { TRPCError }        from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { whereEmpresa, canOperate } from "./tenant-utils.js";
import { previa, criarDisparo, INTERVALO_MIN_SEG, LIMITE_DIA_MAX } from "../lib/disparos.js";

/** Disparo segmentado (lib/disparos.ts): prévia, criação e controle. O envio é do cron. */

const filtro = z.object({
  pipelineId: z.string(),
  stageIds: z.array(z.string()).optional(),
  tagIds: z.array(z.string()).optional(),
  origemTipos: z.array(z.string()).optional(),
  palavras: z.array(z.string()).optional(),
  somenteQuemConversou: z.boolean().optional(),
  pularContatadosHoras: z.number().int().min(0).max(720).optional(),
});

async function pipelineDoUsuario(ctx: any, pipelineId: string) {
  const p = await prisma.crmPipeline.findUnique({ where: { id: pipelineId }, select: { id: true, empresaId: true } });
  if (!p || !canOperate(ctx, p.empresaId)) throw new TRPCError({ code: "FORBIDDEN", message: "Funil não pertence à sua empresa" });
  return p;
}

async function disparoDoUsuario(ctx: any, id: string) {
  const d = await prisma.crmDisparo.findUnique({ where: { id } });
  if (!d || !canOperate(ctx, d.empresaId)) throw new TRPCError({ code: "NOT_FOUND", message: "Disparo não encontrado" });
  return d;
}

export const disparosRouter = router({
  /** Etapas, etiquetas e palavras-chave/vídeos do funil, para montar o filtro. */
  opcoes: authProc
    .input(z.object({ pipelineId: z.string() }))
    .query(async ({ input, ctx }) => {
      await pipelineDoUsuario(ctx, input.pipelineId);
      const [stages, tags, palavras, projeto] = await Promise.all([
        prisma.crmStage.findMany({ where: { pipelineId: input.pipelineId, ativo: true }, orderBy: { ordem: "asc" }, select: { id: true, nome: true, cor: true } }),
        prisma.crmTag.findMany({ where: { OR: [{ pipelineId: input.pipelineId }, { pipelineId: null }] }, orderBy: { nome: "asc" }, select: { id: true, nome: true, cor: true } }),
        prisma.crmDeal.groupBy({
          by: ["origemAnuncioId"],
          where: { pipelineId: input.pipelineId, origemTipo: "organico", origemAnuncioId: { not: null }, status: "aberto" },
          _count: { _all: true },
        }),
        prisma.iaProjeto.findFirst({ where: { pipelineId: input.pipelineId }, select: { id: true } }),
      ]);
      return {
        stages, tags,
        palavras: palavras.map((p) => ({ id: p.origemAnuncioId!, n: p._count._all })).sort((a, b) => b.n - a.n),
        projetoId: projeto?.id ?? null,
        intervaloMin: INTERVALO_MIN_SEG, limiteMax: LIMITE_DIA_MAX,
      };
    }),

  previa: authProc
    .input(filtro)
    .query(async ({ input, ctx }) => {
      await pipelineDoUsuario(ctx, input.pipelineId);
      // O funil já foi autorizado acima; deal sem empresaId (legado) do mesmo funil também entra.
      return previa(input, {});
    }),

  criar: authProc
    .input(z.object({
      nome: z.string().min(1).max(120),
      mensagem: z.string().min(1).max(2000),
      filtro,
      intervaloSeg: z.number().int().default(90),
      limiteDia: z.number().int().default(60),
    }))
    .mutation(async ({ input, ctx }) => {
      const p = await pipelineDoUsuario(ctx, input.filtro.pipelineId);
      const projeto = await prisma.iaProjeto.findFirst({ where: { pipelineId: p.id }, select: { id: true } })
        ?? await prisma.iaProjeto.findFirst({ where: { empresaId: p.empresaId }, select: { id: true } });
      if (!projeto) throw new TRPCError({ code: "BAD_REQUEST", message: "Funil sem projeto de WhatsApp configurado" });
      return criarDisparo({
        projetoId: projeto.id, empresaId: p.empresaId, nome: input.nome, mensagem: input.mensagem, filtro: input.filtro,
        intervaloSeg: input.intervaloSeg, limiteDia: input.limiteDia, criadoPor: ctx.userId ?? null, whereEmpresa: {},
      });
    }),

  listar: authProc.query(async ({ ctx }) =>
    prisma.crmDisparo.findMany({ where: whereEmpresa(ctx) as any, orderBy: { criadoEm: "desc" }, take: 30 })),

  falhas: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      await disparoDoUsuario(ctx, input.id);
      return prisma.crmDisparoItem.groupBy({
        by: ["status", "erro"], where: { disparoId: input.id, status: { in: ["falha", "pulado"] } }, _count: { _all: true },
      });
    }),

  mudarStatus: authProc
    .input(z.object({ id: z.string(), status: z.enum(["enviando", "pausado", "cancelado"]) }))
    .mutation(async ({ input, ctx }) => {
      const d = await disparoDoUsuario(ctx, input.id);
      if (d.status === "concluido" || d.status === "cancelado") throw new TRPCError({ code: "BAD_REQUEST", message: "Disparo já encerrado" });
      return prisma.crmDisparo.update({ where: { id: d.id }, data: { status: input.status } });
    }),
});
