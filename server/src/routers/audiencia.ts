import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { canOperate } from "./tenant-utils.js";
import {
  TIPOS_AUDIENCIA, MODALIDADES, ehTipoValido, formatarValor,
  montarMensagemDesignacao, montarMensagemLembrete,
  type DadosAudiencia, type Modalidade, type TipoAudiencia,
} from "../services/audiencia.js";
import { enviarTextoParaDeal, remetenteDoDeal } from "../services/whatsapp-deal.js";

const INCLUDE_DEAL = {
  contato: true,
  vinculos: { orderBy: { ordem: "asc" as const }, take: 1 },
} as const;

type DealComAudiencia = Awaited<ReturnType<typeof carregarDeal>>;

async function carregarDeal(id: string) {
  const deal = await prisma.crmDeal.findUnique({ where: { id }, include: INCLUDE_DEAL });
  if (!deal) throw new TRPCError({ code: "NOT_FOUND", message: "Lead não encontrado" });
  return deal;
}

function assertAcesso(
  ctx: { empresaId?: string; empresaIds?: string[]; role?: string },
  deal: { empresaId: string | null },
) {
  if (canOperate(ctx, deal.empresaId)) return;
  throw new TRPCError({ code: "FORBIDDEN", message: "Lead não pertence à sua empresa" });
}

/**
 * Junta o que a mensagem precisa. A empresa reclamada vem do primeiro vínculo de
 * emprego do lead (é a que foi para a inicial); o contato é a segunda fonte.
 */
function dadosParaMensagem(deal: DealComAudiencia): DadosAudiencia {
  if (!deal.audienciaEm || !ehTipoValido(deal.audienciaTipo)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Lead sem audiência cadastrada" });
  }
  const primeiroNome = (deal.contato?.nome ?? deal.titulo).trim().split(/\s+/)[0];
  return {
    nome:       primeiroNome,
    em:         deal.audienciaEm,
    tipo:       deal.audienciaTipo as TipoAudiencia,
    modalidade: (deal.audienciaModalidade === "virtual" ? "virtual" : "presencial") as Modalidade,
    local:      deal.audienciaLocal,
    empresa:    deal.vinculos?.[0]?.empresa ?? deal.contato?.empresa ?? null,
    valorCausa: formatarValor(deal.valorCausaAjuizada ?? deal.valorEstimado),
  };
}

export const audienciaRouter = router({
  /** Opções para os selects da tela — uma fonte só, para não divergir do backend. */
  opcoes: authProc.query(() => ({
    tipos: TIPOS_AUDIENCIA.map((t) => ({ ...t })),
    modalidades: MODALIDADES.map((m) => m),
  })),

  /** Cadastra ou atualiza a audiência do lead. Não envia nada. */
  salvar: authProc
    .input(z.object({
      dealId:     z.string(),
      em:         z.string().datetime({ offset: true }).nullable(),
      tipo:       z.enum(["inicial_protocolo", "inicial_posterior", "instrucao", "una"]).nullable(),
      modalidade: z.enum(["presencial", "virtual"]).nullable(),
      local:      z.string().max(500).nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      const deal = await carregarDeal(input.dealId);
      assertAcesso(ctx, deal);

      const em = input.em ? new Date(input.em) : null;
      if (em && Number.isNaN(em.getTime())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Data da audiência inválida" });
      }

      // Trocar a data reabre o aviso: a designação anterior já não vale.
      const mudouData = em?.getTime() !== deal.audienciaEm?.getTime();

      return prisma.crmDeal.update({
        where: { id: input.dealId },
        data: {
          audienciaEm:         em,
          audienciaTipo:       input.tipo,
          audienciaModalidade: input.modalidade,
          audienciaLocal:      input.local?.trim() || null,
          ...(mudouData ? { audienciaAvisadaEm: null, audienciaLembreteEm: null } : {}),
        },
        select: {
          id: true, audienciaEm: true, audienciaTipo: true, audienciaModalidade: true,
          audienciaLocal: true, audienciaAvisadaEm: true, audienciaLembreteEm: true,
        },
      });
    }),

  /**
   * Texto pronto para conferência antes de enviar. `qual` permite pré-visualizar
   * também o lembrete, que é o que o cron vai mandar depois.
   */
  preview: authProc
    .input(z.object({
      dealId: z.string(),
      qual:   z.enum(["designacao", "lembrete"]).default("designacao"),
    }))
    .query(async ({ input, ctx }) => {
      const deal = await carregarDeal(input.dealId);
      assertAcesso(ctx, deal);
      const dados = dadosParaMensagem(deal);
      return {
        texto: input.qual === "lembrete"
          ? montarMensagemLembrete(dados)
          : montarMensagemDesignacao(dados),
        destino: deal.contato?.whatsapp ?? null,
        jaAvisadoEm: deal.audienciaAvisadaEm,
      };
    }),

  /**
   * Envia a designação ao cliente. O texto vai como parâmetro para que valha o
   * que a pessoa leu (e eventualmente editou) na tela, não uma remontagem.
   */
  enviarDesignacao: authProc
    .input(z.object({ dealId: z.string(), texto: z.string().min(10).max(4000) }))
    .mutation(async ({ input, ctx }) => {
      const deal = await carregarDeal(input.dealId);
      assertAcesso(ctx, deal);
      if (!deal.audienciaEm) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Lead sem audiência cadastrada" });
      }

      let remetente = await remetenteDoDeal(deal.responsavelId);
      if (ctx.userId) {
        const u = await prisma.usuario.findUnique({ where: { id: ctx.userId }, select: { nome: true } });
        if (u?.nome) remetente = u.nome;
      }

      const envio = await enviarTextoParaDeal(input.dealId, input.texto, remetente);
      await prisma.crmDeal.update({
        where: { id: input.dealId },
        data: { audienciaAvisadaEm: new Date(), ultimoContatoEm: new Date() },
      });
      await prisma.crmNota.create({
        data: { dealId: input.dealId, conteudo: `[Audiência] Designação enviada ao cliente por ${remetente}.` },
      });
      return envio;
    }),

  /** Audiências futuras da empresa do usuário, para acompanhamento. */
  agenda: authProc
    .input(z.object({ dias: z.number().int().min(1).max(365).default(60) }))
    .query(async ({ input, ctx }) => {
      const ate = new Date(Date.now() + input.dias * 86_400_000);
      const deals = await prisma.crmDeal.findMany({
        where: { audienciaEm: { gte: new Date(), lte: ate } },
        orderBy: { audienciaEm: "asc" },
        select: {
          id: true, titulo: true, empresaId: true, numeroCnj: true,
          audienciaEm: true, audienciaTipo: true, audienciaModalidade: true,
          audienciaLocal: true, audienciaAvisadaEm: true, audienciaLembreteEm: true,
          contato: { select: { nome: true, whatsapp: true } },
        },
      });
      return deals.filter((d) => canOperate(ctx, d.empresaId));
    }),
});
