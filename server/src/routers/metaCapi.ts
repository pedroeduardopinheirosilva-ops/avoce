import { z }                from "zod";
import { TRPCError }        from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { whereEmpresa }     from "./tenant-utils.js";
import { carregarConfigCapi, podeEnviarNoAmbiente } from "../lib/meta-capi.js";

/**
 * Observabilidade da devolução de "lead qualificado" à Meta (lib/meta-capi.ts):
 * eventos emitidos / enviados / falhados e o vazamento de atribuição (lead de anúncio
 * que chegou sem ctwa_clid — esse nunca pode ser devolvido).
 */

async function projetosPermitidos(ctx: any, projetoId?: string) {
  return prisma.iaProjeto.findMany({
    where: { ...whereEmpresa(ctx), ...(projetoId ? { id: projetoId } : {}) },
    select: { id: true, nome: true },
  });
}

export const metaCapiRouter = router({
  resumo: authProc
    .input(z.object({ dias: z.number().int().min(1).max(90).default(30) }))
    .query(async ({ input, ctx }) => {
      const projetos = await projetosPermitidos(ctx);
      const desde = new Date(Date.now() - input.dias * 86_400_000);

      return Promise.all(projetos.map(async (p) => {
        const [porStatus, leadsAnuncio, leadsAnuncioSemCtwa, cfg] = await Promise.all([
          prisma.metaConversaoEvento.groupBy({
            by: ["status"],
            where: { projetoId: p.id, criadoEm: { gte: desde } },
            _count: { _all: true },
          }),
          prisma.crmDeal.count({ where: { projetoId: p.id, origemTipo: "anuncio", criadoEm: { gte: desde } } }),
          prisma.crmDeal.count({ where: { projetoId: p.id, origemTipo: "anuncio", origemCtwaClid: null, criadoEm: { gte: desde } } }),
          carregarConfigCapi(p.id),
        ]);
        const n = (s: string) => porStatus.find((r) => r.status === s)?._count._all ?? 0;
        const emitidos = porStatus.reduce((acc, r) => acc + r._count._all, 0);
        return {
          projetoId: p.id,
          projetoNome: p.nome,
          emitidos,
          enviados: n("enviado"),
          naFila: n("pendente") + n("falhou") + n("enviando"),
          falhados: n("falhou") + n("morto"),
          mortos: n("morto"),
          semCtwa: n("sem_ctwa"),
          expirados: n("expirado"),
          leadsAnuncio,
          leadsAnuncioSemCtwa,
          taxaSemCtwa: leadsAnuncio ? leadsAnuncioSemCtwa / leadsAnuncio : null,
          config: {
            ativo: cfg.ativo,
            datasetId: cfg.datasetId,
            wabaId: cfg.wabaId,
            mktProjetoId: cfg.mktProjetoId,
            modoTeste: !!cfg.testEventCode,
            ambientePermite: podeEnviarNoAmbiente(process.env.NODE_ENV, cfg.testEventCode),
          },
        };
      }));
    }),

  eventos: authProc
    .input(z.object({
      projetoId: z.string(),
      status: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      if (!(await projetosPermitidos(ctx, input.projetoId)).length) throw new TRPCError({ code: "FORBIDDEN" });
      return prisma.metaConversaoEvento.findMany({
        where: { projetoId: input.projetoId, ...(input.status ? { status: input.status } : {}) },
        orderBy: { criadoEm: "desc" },
        take: input.limit,
        select: {
          id: true, eventId: true, dealId: true, eventName: true, via: true, stageChave: true,
          status: true, tentativas: true, ocorridoEm: true, enviadoEm: true, proximaTentativaEm: true,
          erro: true, testEventCode: true,
          ctwaClid: true,
          deal: { select: { titulo: true, origemAnuncioId: true, origemPlataforma: true } },
        },
      });
    }),

  /** Devolve à fila um evento que falhou de vez (ex.: token corrigido, dataset trocado). */
  reprocessar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const ev = await prisma.metaConversaoEvento.findUnique({ where: { id: input.id }, select: { projetoId: true, status: true } });
      if (!ev?.projetoId || !(await projetosPermitidos(ctx, ev.projetoId)).length) throw new TRPCError({ code: "NOT_FOUND" });
      if (!["morto", "falhou", "expirado"].includes(ev.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `Evento em "${ev.status}" não pode ser reprocessado` });
      }
      await prisma.metaConversaoEvento.update({
        where: { id: input.id },
        data: { status: "pendente", tentativas: 0, proximaTentativaEm: new Date(), erro: null },
      });
      return { ok: true };
    }),
});
