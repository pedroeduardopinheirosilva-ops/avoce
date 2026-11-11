import { z }         from "zod";
import { Prisma }    from "@prisma/client";
import { router, authProc } from "./trpc.js";
import { prisma }    from "../db.js";
import { whereEmpresa, canAccess } from "./tenant-utils.js";
import { marcarEntradaEtapa } from "../agent/lead-qualificado.js";

/**
 * Deal importado (Pipedrive, planilha, bot) costuma nascer com `empresaId` nulo, e
 * `canAccess` recusa nulo. Como o kanban lista os cards só por `stageId`, o card
 * aparecia no funil mas não abria nem excluía. O dono real é a empresa do pipeline.
 */
const empresaDoDeal = (deal: { empresaId?: string | null; pipeline?: { empresaId: string | null } | null } | null) =>
  deal?.empresaId ?? deal?.pipeline?.empresaId ?? null;

/**
 * Quem faz follow-up na empresa (`Configuracao` followup_sdr:<empresaId>, JSON
 * `{ padrao, sdrs }`). SDR que marca a data fica com o follow-up; quando quem marca não é SDR
 * (advogada, sócia), a ligação vai para a SDR padrão. Valor antigo (só um id) = padrão.
 */
export async function configFollowup(empresaId: string | null): Promise<{ padrao: string | null; sdrs: string[] }> {
  const chaveEmpresa = `followup_sdr:${empresaId ?? "global"}`;
  const cfgs = await prisma.configuracao.findMany({ where: { chave: { in: [chaveEmpresa, "followup_sdr:global"] } } });
  // A da empresa vale mais que a global
  const cfg = cfgs.find(c => c.chave === chaveEmpresa) ?? cfgs.find(c => c.chave === "followup_sdr:global");
  if (!cfg?.valor) return { padrao: null, sdrs: [] };
  let bruto: { padrao?: string | null; sdrs?: string[] };
  try { bruto = cfg.valor.trim().startsWith("{") ? JSON.parse(cfg.valor) : { padrao: cfg.valor, sdrs: [cfg.valor] }; }
  catch { return { padrao: null, sdrs: [] }; }
  const ids = [...new Set([...(bruto.sdrs ?? []), ...(bruto.padrao ? [bruto.padrao] : [])])];
  const ativos = new Set((await prisma.usuario.findMany({ where: { id: { in: ids }, ativo: true }, select: { id: true } })).map(u => u.id));
  return {
    padrao: bruto.padrao && ativos.has(bruto.padrao) ? bruto.padrao : null,
    sdrs: (bruto.sdrs ?? []).filter(id => ativos.has(id)),
  };
}

/**
 * Quem pode ficar com um follow-up do deal: usuários ativos da empresa, sem empresa, ou com a
 * empresa em `permissoes.empresas`. Este último caso é o da Noemi: está cadastrada na PSA e
 * cuida do pós-venda da RAP.
 */
export function usuariosDoFollowup(empresaId: string | null) {
  return prisma.usuario.findMany({
    where: {
      ativo: true,
      ...(empresaId ? { OR: [
        { empresaId },
        { empresaId: null },
        { permissoes: { path: ["empresas"], array_contains: [empresaId] } },
      ] } : {}),
    },
    orderBy: { nome: "asc" },
    select: { id: true, nome: true },
  });
}

/** Dono do follow-up marcado por `usuarioId`: ele mesmo se for SDR (ou se não houver config), senão a SDR padrão. */
export async function donoDoFollowup(empresaId: string | null, usuarioId: string | null): Promise<string | null> {
  const cfg = await configFollowup(empresaId);
  if (usuarioId && (cfg.sdrs.includes(usuarioId) || !cfg.padrao)) return usuarioId;
  return cfg.padrao ?? usuarioId;
}

const PIPELINE_EMPRESA = { pipeline: { select: { empresaId: true } } } as const;

/**
 * Tag sem empresa é tag DO SISTEMA (as de engajamento SDR e as auto-tags do agente
 * foram semeadas assim, com ids fixos). `whereEmpresa` sozinho escondia todas elas de
 * qualquer usuário com empresa — o filtro de tags do Kanban aparecia vazio.
 */
export const whereTagVisivel = (ctx: Parameters<typeof whereEmpresa>[0]) =>
  ({ OR: [whereEmpresa(ctx), { empresaId: null }] });

/** Tag do sistema (sem empresa) só o admin altera; as demais, quem tem a empresa. */
const podeEditarTag = (ctx: Parameters<typeof canAccess>[0] & { role?: string }, empresaId: string | null) =>
  empresaId ? canAccess(ctx, empresaId) : ctx.role === "admin";

// ─── Seed dados carreteiros ───────────────────────────────────────────────────

const SEED_COMERCIAL = {
  nome: "Captação Carreteiros",
  tipo: "comercial",
  cor: "#6366f1",
  stages: [
    { chave: "lead_carreteiro",          nome: "Lead Qualificado como Carreteiro", ordem: 0, cor: "#3b82f6", ehEntrada: true },
    { chave: "lead_sem_resposta",        nome: "Lead sem Resposta",                ordem: 1, cor: "#6b7280" },
    { chave: "lead_qualificado",         nome: "Lead Qualificado",                 ordem: 2, cor: "#8b5cf6" },
    { chave: "lead_indeciso",            nome: "Lead Indeciso / Futuro",           ordem: 3, cor: "#f59e0b" },
    { chave: "com_closer",               nome: "Lead com Contato do Closer",       ordem: 4, cor: "#f97316" },
    { chave: "sem_resposta_closer",      nome: "Lead sem Resposta ao Closer",      ordem: 5, cor: "#ef4444", requerAcaoHumana: true },
    { chave: "aguardando_docs_pessoais", nome: "Aguardando Documentos Pessoais",   ordem: 6, cor: "#06b6d4" },
    { chave: "docs_em_revisao",          nome: "📝 Documentos em Revisão",          ordem: 7, cor: "#f59e0b" },
    { chave: "aguardando_assinatura",    nome: "Aguardando Assinatura do Contrato",ordem: 8, cor: "#10b981", ehGanho: false },
  ],
};

const SEED_PROCESSUAL = {
  nome: "Jurídico Processual",
  tipo: "processual",
  cor: "#0ea5e9",
  stages: [
    { chave: "aguardando_reuniao",          nome: "Aguardando Reunião c/ Advogado",    ordem: 0, cor: "#6b7280", ehEntrada: true, requerAcaoHumana: true },
    { chave: "aguardando_docs_adicionais",  nome: "Aguardando Documentos Adicionais",  ordem: 1, cor: "#3b82f6", requerAcaoHumana: true },
    { chave: "elaboracao_inicial",          nome: "Elaboração da Inicial",             ordem: 2, cor: "#8b5cf6", requerAcaoHumana: true },
    { chave: "ajuizado_audiencia",          nome: "Ajuizado / Aguardando Audiência",   ordem: 3, cor: "#6366f1", requerAcaoHumana: true },
    { chave: "audiencia_feita",             nome: "Audiência Feita",                   ordem: 4, cor: "#06b6d4", requerAcaoHumana: true },
    { chave: "aguardando_sentenca",         nome: "Aguardando Sentença",               ordem: 5, cor: "#f59e0b", requerAcaoHumana: true },
    { chave: "aguardando_faturamento",      nome: "Aguardando Faturamento",            ordem: 6, cor: "#10b981", ehGanho: true, requerAcaoHumana: true },
  ],
};

// ─── Router ───────────────────────────────────────────────────────────────────

// Funis cuja fila é por valor (maior primeiro) em vez de ordem de chegada.
const PIPELINES_ORDEM_VALOR = new Set(["pipeline_defesa_icms"]);

export const crmRouter = router({

  // ── Pipelines ──────────────────────────────────────────────────────────────

  listPipelines: authProc.query(async ({ ctx }) => {
    return prisma.crmPipeline.findMany({
      where: { ativo: true, ...whereEmpresa(ctx) },
      orderBy: { ordem: "asc" },
      include: { _count: { select: { deals: { where: { status: "aberto" } } } } },
    });
  }),

  createPipeline: authProc
    .input(z.object({
      nome: z.string().min(1),
      descricao: z.string().optional(),
      cor: z.string().optional(),
      tipo: z.enum(["comercial", "processual", "custom"]).default("comercial"),
    }))
    .mutation(async ({ input, ctx }) => {
      const last = await prisma.crmPipeline.findFirst({
        where: whereEmpresa(ctx),
        orderBy: { ordem: "desc" },
      });
      return prisma.crmPipeline.create({
        data: { ...input, empresaId: ctx.empresaId ?? undefined, ordem: (last?.ordem ?? -1) + 1 },
      });
    }),

  updatePipeline: authProc
    .input(z.object({
      id: z.string(),
      nome: z.string().min(1).optional(),
      descricao: z.string().optional(),
      cor: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const p0 = await prisma.crmPipeline.findUnique({ where: { id }, select: { empresaId: true } });
      if (!p0 || !canAccess(ctx, p0.empresaId)) throw new Error("Pipeline não pertence à sua empresa");
      return prisma.crmPipeline.update({ where: { id }, data });
    }),

  deletePipeline: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      const p0 = await prisma.crmPipeline.findUnique({ where: { id }, select: { empresaId: true } });
      if (!p0 || !canAccess(ctx, p0.empresaId)) throw new Error("Pipeline não pertence à sua empresa");
      // Excluir deals do pipeline (cascade via stages)
      const stages = await prisma.crmStage.findMany({ where: { pipelineId: input.id } });
      for (const stage of stages) {
        await prisma.crmDeal.deleteMany({ where: { stageId: stage.id } });
      }
      await prisma.crmStage.deleteMany({ where: { pipelineId: input.id } });
      return prisma.crmPipeline.delete({ where: { id: input.id } });
    }),

  // ── Kanban: stages + deals agrupados ──────────────────────────────────────

  kanban: authProc
    .input(z.object({
      pipelineId: z.string(),
      busca: z.string().optional(),
      tagIds: z.array(z.string()).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const busca = input.busca?.trim();

      const [pipeline, stages] = await Promise.all([
        prisma.crmPipeline.findUniqueOrThrow({ where: { id: input.pipelineId } }),
        prisma.crmStage.findMany({
          where: { pipelineId: input.pipelineId, ativo: true },
          orderBy: { ordem: "asc" },
        }),
      ]);

      if (!canAccess(ctx, pipeline.empresaId)) throw new Error("Pipeline não pertence à sua empresa");

      // Carregar deals por stage em paralelo (usa índice stageId+status)
      const stagesComDeals = await Promise.all(
        stages.map(async (stage) => {
          const where: any = {
            stageId: stage.id,
            status: "aberto",
            ...(busca ? {
              OR: [
                { titulo: { contains: busca, mode: "insensitive" } },
                { contato: { nome: { contains: busca, mode: "insensitive" } } },
                { contato: { whatsapp: { contains: busca } } },
              ],
            } : {}),
            ...(input.tagIds && input.tagIds.length > 0 ? {
              tags: { some: { id: { in: input.tagIds } } },
            } : {}),
          };

          const deals = await (prisma as any).crmDeal.findMany({
            where,
            orderBy: { criadoEm: "desc" },
            select: {
              id: true, titulo: true, valor: true, urgencia: true,
              status: true, stageId: true, criadoEm: true, followupEm: true,
              valorEstimado: true, iaAtiva: true, iaPausadaPor: true,
              origemPlataforma: true, origemTipo: true, origemAnuncioId: true, origemAnuncioTitulo: true, origemAnuncioTexto: true, origemUrl: true, origemEm: true,
              // instagramId/messengerId: lead do Direct/Messenger também tem conversa no WhatsApp IA.
              contato: { select: { id: true, nome: true, whatsapp: true, instagramId: true, messengerId: true, cidade: true, fotoPerfilUrl: true, fotoPerfilEm: true } },
            },
          });

          // Quem ainda não recebeu follow-up humano fica no topo, do mais NOVO ao mais antigo
          // (o lead que acabou de chegar é o mais quente — pedido do Pedro em 23/10/2026). Feito o follow-up (ligação registrada, mensagem do
          // painel ou do celular, chamada de WhatsApp), o lead vai para o fim da coluna, atrás
          // de quem ainda espera contato — e entre os já contatados, quem teve follow-up há
          // mais tempo vem antes. Assim ninguém é procurado duas vezes por engano.
          // Funis de auto de infração: quem espera contato vem do maior valor lavrado para o menor.
          const porValor = (a: any, b: any) => Number(b.valor ?? 0) - Number(a.valor ?? 0);
          const pendentes = deals.filter((d: any) => !d.followupEm);
          if (PIPELINES_ORDEM_VALOR.has(input.pipelineId)) pendentes.sort(porValor);
          const contatados = deals.filter((d: any) => d.followupEm)
            .sort((a: any, b: any) => a.followupEm.getTime() - b.followupEm.getTime());

          return { ...stage, deals: [...pendentes, ...contatados] };
        })
      );

      return { pipeline, stages: stagesComDeals };
    }),

  // ── Stages ─────────────────────────────────────────────────────────────────

  listStages: authProc
    .input(z.object({ pipelineId: z.string() }))
    .query(async ({ input, ctx }) => {
      { const p = await prisma.crmPipeline.findUnique({ where: { id: input.pipelineId }, select: { empresaId: true } });
        if (!p || !canAccess(ctx, p.empresaId)) throw new Error("Pipeline não pertence à sua empresa"); }
      return prisma.crmStage.findMany({
        where: { pipelineId: input.pipelineId, ativo: true },
        orderBy: { ordem: "asc" },
      });
    }),

  createStage: authProc
    .input(z.object({
      pipelineId: z.string(),
      chave: z.string().min(1),
      nome: z.string().min(1),
      cor: z.string().optional(),
      ehEntrada: z.boolean().optional(),
      ehGanho: z.boolean().optional(),
      requerAcaoHumana: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      { const p = await prisma.crmPipeline.findUnique({ where: { id: input.pipelineId }, select: { empresaId: true } });
        if (!p || !canAccess(ctx, p.empresaId)) throw new Error("Pipeline não pertence à sua empresa"); }
      const last = await prisma.crmStage.findFirst({
        where: { pipelineId: input.pipelineId },
        orderBy: { ordem: "desc" },
      });
      return prisma.crmStage.create({
        data: { ...input, ordem: (last?.ordem ?? -1) + 1 },
      });
    }),

  updateStage: authProc
    .input(z.object({
      id: z.string(),
      nome: z.string().min(1).optional(),
      cor: z.string().optional(),
      requerAcaoHumana: z.boolean().optional(),
      ehEntrada: z.boolean().optional(),
      ehGanho: z.boolean().optional(),
      ehEncerramento: z.boolean().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      { const stage = await prisma.crmStage.findUnique({ where: { id }, include: { pipeline: { select: { empresaId: true } } } });
        if (!stage || !canAccess(ctx, stage.pipeline.empresaId)) throw new Error("Stage não pertence à sua empresa"); }
      return prisma.crmStage.update({ where: { id }, data });
    }),

  reorderStages: authProc
    .input(z.object({
      pipelineId: z.string(),
      stageIds: z.array(z.string()),
    }))
    .mutation(async ({ input, ctx }) => {
      { const p = await prisma.crmPipeline.findUnique({ where: { id: input.pipelineId }, select: { empresaId: true } });
        if (!p || !canAccess(ctx, p.empresaId)) throw new Error("Pipeline não pertence à sua empresa"); }
      await Promise.all(
        input.stageIds.map((id, idx) => prisma.crmStage.update({ where: { id }, data: { ordem: idx } }))
      );
      return { ok: true };
    }),

  deleteStage: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { id } = input;
      { const stage = await prisma.crmStage.findUnique({ where: { id }, include: { pipeline: { select: { empresaId: true } } } });
        if (!stage || !canAccess(ctx, stage.pipeline.empresaId)) throw new Error("Stage não pertence à sua empresa"); }
      return prisma.crmStage.update({ where: { id: input.id }, data: { ativo: false } });
    }),

  // ── Deals ──────────────────────────────────────────────────────────────────

  getDeal: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUniqueOrThrow({
        where: { id: input.id },
        include: {
          contato: true,
          stage: true,
          // As etiquetas do deal só existiam no card do kanban; sem elas aqui,
          // a ficha (app iOS) mostraria o seletor de etiquetas sem saber quais
          // já estão marcadas.
          tags: { select: { id: true, nome: true, cor: true } },
          pipeline: {
            include: {
              stages: { select: { id: true, nome: true, cor: true }, orderBy: { ordem: "asc" } },
            },
          },
          notas: { orderBy: { criadoEm: "desc" } },
          stageLog: {
            orderBy: { criadoEm: "asc" },
          },
        },
      });
      if (!canAccess(ctx, empresaDoDeal(deal))) throw new Error("Deal não pertence à sua empresa");
      return deal;
    }),

  createDeal: authProc
    .input(z.object({
      titulo: z.string().min(1),
      pipelineId: z.string(),
      stageId: z.string(),
      valor: z.number().optional(),
      fonteLead: z.string().optional(),
      descricao: z.string().optional(),
      urgencia: z.boolean().optional(),
      // contato inline
      contato: z.object({
        nome: z.string().min(1),
        whatsapp: z.string().optional(),
        cpf: z.string().optional(),
        email: z.string().optional(),
        cidade: z.string().optional(),
      }).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { contato, valor, ...rest } = input;

      let contatoId: string | undefined;
      if (contato) {
        const created = await prisma.crmContato.create({ data: { ...contato, empresaId: ctx.empresaId ?? undefined } });
        contatoId = created.id;
      }

      const deal = await prisma.crmDeal.create({
        data: {
          ...rest,
          empresaId: ctx.empresaId ?? undefined,
          valor: valor != null ? valor : undefined,
          contatoId,
        },
        include: { contato: true, stage: true },
      });

      await prisma.crmDealStageLog.create({
        data: { dealId: deal.id, stageNovoId: input.stageId },
      });

      return deal;
    }),

  updateDeal: authProc
    .input(z.object({
      id: z.string(),
      titulo: z.string().optional(),
      valor: z.number().nullable().optional(),
      descricao: z.string().optional(),
      urgencia: z.boolean().optional(),
      status: z.enum(["aberto", "ganho", "perdido"]).optional(),
      numeroCnj: z.string().optional(),
      proximoPrazo: z.string().optional(), // ISO date string
      parecer: z.string().nullable().optional(),
      valorEstimado: z.number().nullable().optional(),
      valorCausaAjuizada: z.number().nullable().optional(),
      valorCondenacao: z.number().nullable().optional(),
      valorAcordo: z.number().nullable().optional(),
      motivoPerda: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, proximoPrazo, valor, valorEstimado, valorCausaAjuizada, valorCondenacao, valorAcordo, ...rest } = input;
      { const d = await prisma.crmDeal.findUnique({ where: { id }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
        if (!d || !canAccess(ctx, empresaDoDeal(d))) throw new Error("Deal não pertence à sua empresa"); }
      return prisma.crmDeal.update({
        where: { id },
        data: {
          ...rest,
          valor: valor != null ? valor : undefined,
          valorEstimado:       valorEstimado       != null ? valorEstimado       : undefined,
          valorCausaAjuizada:  valorCausaAjuizada  != null ? valorCausaAjuizada  : undefined,
          valorCondenacao:     valorCondenacao     != null ? valorCondenacao     : undefined,
          valorAcordo:         valorAcordo         != null ? valorAcordo         : undefined,
          proximoPrazo: proximoPrazo ? new Date(proximoPrazo) : undefined,
        },
        include: { contato: true, stage: true },
      });
    }),

  // ── Rotina do SDR: atividades, próximo follow-up e encerramento ──────────

  /**
   * Ligação (feita pelo WhatsApp/celular, fora do VoIP) ou reunião — alimenta o Funil do SDR.
   * Com `atividadeId`, completa uma ligação detectada automaticamente (evento CALL do WhatsApp)
   * em vez de criar outra: é o que evita contar a mesma ligação duas vezes.
   */
  registrarAtividade: authProc
    .input(z.object({
      dealId: z.string(),
      tipo: z.enum(["ligacao", "reuniao"]),
      resultado: z.enum(["atendeu", "nao_atendeu", "recusou", "pediu_retorno", "numero_errado", "agendada", "realizada", "no_show", "remarcada", "cancelada"]),
      nota: z.string().optional(),
      /** Ligação: whatsapp | celular | voip · Reunião: video | whatsapp | telefone | presencial. */
      canal: z.enum(["whatsapp", "celular", "voip", "video", "telefone", "presencial"]).optional(),
      direcao: z.enum(["saida", "entrada"]).optional(),
      duracaoMin: z.number().min(0).max(600).optional(),
      atividadeId: z.string().optional(),
      /** Quando aconteceu (ISO). Vem preenchido com "agora" na tela, mas a SDR pode corrigir. */
      em: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const d = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
      if (!d || !canAccess(ctx, empresaDoDeal(d))) throw new Error("Deal não pertence à sua empresa");
      const DA_LIGACAO = ["atendeu", "nao_atendeu", "recusou", "pediu_retorno", "numero_errado"];
      const DA_REUNIAO = ["agendada", "realizada", "no_show", "remarcada", "cancelada"];
      if (!(input.tipo === "ligacao" ? DA_LIGACAO : DA_REUNIAO).includes(input.resultado)) {
        throw new Error("Resultado não combina com o tipo de atividade");
      }
      const CANAIS = input.tipo === "ligacao" ? ["whatsapp", "celular", "voip"] : ["video", "whatsapp", "telefone", "presencial"];
      if (input.canal && !CANAIS.includes(input.canal)) throw new Error("Canal não combina com o tipo de atividade");
      const quando = input.em ? new Date(input.em) : null;
      if (quando && isNaN(quando.getTime())) throw new Error("Data/hora inválida");
      if (quando && quando.getTime() > Date.now() + 5 * 60_000) throw new Error("A data/hora não pode ser no futuro");
      const dados = {
        resultado: input.resultado,
        ...(quando ? { criadoEm: quando } : {}),
        nota: input.nota?.trim() || null,
        ...(input.tipo === "ligacao" ? {
          canal: input.canal ?? "whatsapp",
          direcao: input.direcao ?? "saida",
        } : input.canal ? { canal: input.canal } : {}),
        ...(input.duracaoMin != null ? { duracaoSeg: Math.round(input.duracaoMin * 60) } : {}),
      };
      let atividade;
      if (input.atividadeId) {
        const atual = await prisma.crmAtividade.findUnique({ where: { id: input.atividadeId } });
        if (!atual || atual.dealId !== input.dealId || atual.tipo !== input.tipo) throw new Error("Atividade não encontrada neste lead");
        // Duração medida (WhatsApp / sala de reunião) vale mais que a estimativa digitada.
        atividade = await prisma.crmAtividade.update({
          where: { id: atual.id },
          data: { ...dados, ...(atual.duracaoSeg != null ? { duracaoSeg: atual.duracaoSeg } : {}), usuarioId: (ctx as any).userId ?? atual.usuarioId },
        });
      } else {
        atividade = await prisma.crmAtividade.create({
          data: { dealId: input.dealId, tipo: input.tipo, ...dados, usuarioId: (ctx as any).userId ?? null },
        });
      }
      await prisma.crmDeal.update({ where: { id: input.dealId }, data: { ultimoContatoEm: new Date(), followupEm: new Date() } });
      return atividade;
    }),

  listAtividades: authProc
    .input(z.object({ dealId: z.string() }))
    .query(({ input }) =>
      prisma.crmAtividade.findMany({ where: { dealId: input.dealId }, orderBy: { criadoEm: "desc" }, take: 30 }),
    ),

  /**
   * "Lead ativo = responsável + etapa + próximo follow-up" (script comercial). Sem data, o
   * lead some da rotina do dia. null limpa.
   */
  /** Opções do campo "Follow-up com" do Registrar ligação: usuários + sugestão pela regra das SDRs. */
  responsaveisFollowup: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input, ctx }) => {
      const d = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
      if (!d || !canAccess(ctx, empresaDoDeal(d))) throw new Error("Deal não pertence à sua empresa");
      const [usuarios, sugerido] = await Promise.all([
        usuariosDoFollowup(empresaDoDeal(d)),
        donoDoFollowup(empresaDoDeal(d), (ctx as any).userId ?? null),
      ]);
      return { usuarios, sugerido };
    }),

  definirProximoContato: authProc
    .input(z.object({ dealId: z.string(), em: z.string().nullable(), responsavelId: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const d = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
      if (!d || !canAccess(ctx, empresaDoDeal(d))) throw new Error("Deal não pertence à sua empresa");
      // Dono da ligação (a fila dele no painel diário): quem foi escolhido em "Follow-up com";
      // sem escolha, quem marcou se for SDR, senão a SDR padrão (painel diário → Etapas).
      let dono: string | null = null;
      if (input.em && input.responsavelId) {
        const ok = (await usuariosDoFollowup(empresaDoDeal(d))).some(u => u.id === input.responsavelId);
        if (!ok) throw new Error("Responsável pelo follow-up inválido");
        dono = input.responsavelId;
      } else if (input.em) {
        dono = await donoDoFollowup(empresaDoDeal(d), (ctx as any).userId ?? null);
      }
      return prisma.crmDeal.update({
        where: { id: input.dealId },
        data: { proximoContatoEm: input.em ? new Date(input.em) : null, proximoContatoPor: dono },
        select: { id: true, proximoContatoEm: true, proximoContatoPor: true },
      });
    }),

  /**
   * Encerra o lead como ganho ou perdido. Perda sem motivo não entra: é o motivo que diz
   * onde o funil vaza. Reabrir volta para "aberto" sem apagar o histórico.
   */
  encerrarDeal: authProc
    .input(z.object({
      dealId: z.string(),
      resultado: z.enum(["ganho", "perdido", "aberto"]),
      motivo: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const d = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
      if (!d || !canAccess(ctx, empresaDoDeal(d))) throw new Error("Deal não pertence à sua empresa");
      if (input.resultado === "perdido" && !input.motivo?.trim()) throw new Error("Informe o motivo da perda");
      const [deal] = await Promise.all([
        prisma.crmDeal.update({
          where: { id: input.dealId },
          data: {
            status: input.resultado,
            motivoPerda: input.resultado === "perdido" ? input.motivo!.trim() : null,
            ...(input.resultado !== "aberto" ? { proximoContatoEm: null, proximoContatoPor: null } : {}),
          },
          select: { id: true, status: true, motivoPerda: true },
        }),
        prisma.crmAtividade.create({
          data: {
            dealId: input.dealId, tipo: "encerramento", resultado: input.resultado,
            nota: input.motivo?.trim() || null, usuarioId: (ctx as any).userId ?? null,
          },
        }),
      ]);
      return deal;
    }),

  /**
   * Ganhos e perdidos de um funil (o Kanban só mostra os abertos). Data e autor do
   * encerramento vêm da última atividade "encerramento"; lead encerrado fora do botão
   * (edição, importação, IA, unificação) não tem essa atividade — aí a data é a da última
   * alteração do deal e o autor fica vazio. Motivos agrupados sem diferença de caixa/acento.
   */
  encerrados: authProc
    .input(z.object({
      pipelineId: z.string(),
      status: z.enum(["ganho", "perdido"]),
      de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      motivo: z.string().optional(),
      busca: z.string().optional(),
      pagina: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      const pipe = await prisma.crmPipeline.findUnique({ where: { id: input.pipelineId }, select: { empresaId: true } });
      if (!pipe || !canAccess(ctx, pipe.empresaId)) throw new Error("Pipeline não pertence à sua empresa");
      const POR_PAGINA = 50;
      const chaveMotivo = Prisma.sql`lower(trim(translate(COALESCE(d."motivoPerda", ''), 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC')))`;
      const base = Prisma.sql`
        FROM "CrmDeal" d
        LEFT JOIN "CrmContato" c ON c.id = d."contatoId"
        LEFT JOIN "CrmStage" s ON s.id = d."stageId"
        LEFT JOIN LATERAL (
          SELECT a."criadoEm", a."usuarioId" FROM "CrmAtividade" a
           WHERE a."dealId" = d.id AND a.tipo = 'encerramento' AND a.resultado = d.status
           ORDER BY a."criadoEm" DESC LIMIT 1
        ) e ON true
        WHERE d."pipelineId" = ${input.pipelineId} AND d.status = ${input.status}`;
      const fechadoEm = Prisma.sql`COALESCE(e."criadoEm", d."atualizadoEm")`;
      const busca = input.busca?.trim();
      const filtros = Prisma.join([
        Prisma.sql`TRUE`,
        input.de ? Prisma.sql`${fechadoEm} >= ${new Date(`${input.de}T00:00:00-03:00`)}` : Prisma.empty,
        input.ate ? Prisma.sql`${fechadoEm} < ${new Date(new Date(`${input.ate}T00:00:00-03:00`).getTime() + 86_400_000)}` : Prisma.empty,
        busca ? Prisma.sql`(d.titulo ILIKE ${`%${busca}%`} OR c.nome ILIKE ${`%${busca}%`} OR c.whatsapp LIKE ${`%${busca.replace(/\D/g, "") || busca}%`})` : Prisma.empty,
      ].filter((x) => x !== Prisma.empty), " AND ");
      const filtroMotivo = input.motivo != null ? Prisma.sql` AND ${chaveMotivo} = ${input.motivo}` : Prisma.empty;

      const [itens, totais, motivos] = await Promise.all([
        prisma.$queryRaw<{
          id: string; titulo: string; stageId: string; stageNome: string | null; contatoId: string | null;
          contatoNome: string | null; whatsapp: string | null; instagramId: string | null; messengerId: string | null;
          motivoPerda: string | null; valor: Prisma.Decimal | null; valorEstimado: Prisma.Decimal | null;
          fechadoEm: Date; fechadoPorBotao: boolean; usuarioId: string | null; usuarioNome: string | null; criadoEm: Date;
        }[]>(Prisma.sql`
          SELECT x.*, u.nome AS "usuarioNome" FROM (
            SELECT d.id, d.titulo, d."stageId", s.nome AS "stageNome", c.id AS "contatoId", c.nome AS "contatoNome", c.whatsapp, c."instagramId", c."messengerId",
                   d."motivoPerda", d.valor, d."valorEstimado", ${fechadoEm} AS "fechadoEm",
                   (e."criadoEm" IS NOT NULL) AS "fechadoPorBotao", e."usuarioId", d."criadoEm"
              ${base} AND ${filtros}${filtroMotivo}
             ORDER BY ${fechadoEm} DESC
             LIMIT ${POR_PAGINA} OFFSET ${input.pagina * POR_PAGINA}
          ) x LEFT JOIN "Usuario" u ON u.id = x."usuarioId"
          ORDER BY x."fechadoEm" DESC
        `),
        prisma.$queryRaw<{ qtd: bigint; valor: Prisma.Decimal | null }[]>(Prisma.sql`
          SELECT COUNT(*)::bigint AS qtd, SUM(COALESCE(d.valor, d."valorEstimado")) AS valor ${base} AND ${filtros}${filtroMotivo}
        `),
        // Motivos do período/busca (sem o filtro de motivo, para os chips mostrarem todos).
        prisma.$queryRaw<{ chave: string; rotulo: string; qtd: bigint }[]>(Prisma.sql`
          SELECT ${chaveMotivo} AS chave, MODE() WITHIN GROUP (ORDER BY COALESCE(d."motivoPerda", '')) AS rotulo, COUNT(*)::bigint AS qtd
            ${base} AND ${filtros}
           GROUP BY 1 ORDER BY 3 DESC LIMIT 30
        `),
      ]);
      return {
        porPagina: POR_PAGINA,
        total: Number(totais[0]?.qtd ?? 0),
        valorTotal: totais[0]?.valor != null ? Number(totais[0].valor) : null,
        motivos: motivos.map((m) => ({ chave: m.chave, rotulo: m.rotulo || "Sem motivo", qtd: Number(m.qtd) })),
        itens: itens.map((i) => ({
          ...i,
          valor: i.valor != null ? Number(i.valor) : i.valorEstimado != null ? Number(i.valorEstimado) : null,
          valorEstimado: undefined,
          temConversa: !!(i.whatsapp || i.instagramId || i.messengerId),
        })),
      };
    }),

  moveDeal: authProc
    .input(z.object({ dealId: z.string(), stageId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUniqueOrThrow({ where: { id: input.dealId }, include: PIPELINE_EMPRESA });
      if (!canAccess(ctx, empresaDoDeal(deal))) throw new Error("Deal não pertence à sua empresa");

      // Mover de funil tem que mover o funil, não só a coluna: o motor da IA
      // (moveDealToStage) resolve a coluna por `deal.pipelineId`, então um deal com
      // pipelineId antigo é puxado de volta pro funil anterior no ciclo seguinte.
      const destino = await prisma.crmStage.findUnique({
        where: { id: input.stageId },
        select: { pipelineId: true, chave: true },
      });
      if (!destino) throw new Error("Etapa de destino não encontrada");

      await prisma.crmDealStageLog.create({
        data: {
          dealId: input.dealId,
          stageAnteriorId: deal.stageId,
          stageNovoId: input.stageId,
        },
      });
      void marcarEntradaEtapa(input.dealId, destino.chave, "crm:manual");

      return prisma.crmDeal.update({
        where: { id: input.dealId },
        data: { stageId: input.stageId, pipelineId: destino.pipelineId },
        include: { contato: true, stage: true },
      });
    }),

  deleteDeal: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({ where: { id: input.id }, include: PIPELINE_EMPRESA });
      if (!deal) throw new Error("Deal não encontrado");
      if (!canAccess(ctx, empresaDoDeal(deal))) throw new Error("Deal não pertence à sua empresa");

      // Limpar tudo relacionado ao deal
      await prisma.crmMensagemWhatsapp.deleteMany({ where: { dealId: input.id } });
      await prisma.iaInteracaoLog.deleteMany({ where: { dealId: input.id } });
      await prisma.crmDealStageLog.deleteMany({ where: { dealId: input.id } });
      await prisma.crmNota.deleteMany({ where: { dealId: input.id } });
      await (prisma as any).crmVinculoEmprego.deleteMany({ where: { dealId: input.id } }).catch(() => {});
      await prisma.crmDeal.delete({ where: { id: input.id } });

      // Se o contato não tem outros deals, apagá-lo também (reset completo para testes)
      if (deal.contatoId) {
        const outrosDeals = await prisma.crmDeal.count({ where: { contatoId: deal.contatoId } });
        if (outrosDeals === 0) {
          await prisma.crmMensagemWhatsapp.deleteMany({ where: { contatoId: deal.contatoId } });
          await prisma.crmContato.delete({ where: { id: deal.contatoId } }).catch(() => {});
        }
      }

      return { ok: true };
    }),

  // ── Notas ─────────────────────────────────────────────────────────────��────

  /// Editar os dados do lead (a pessoa). Existia criação e busca de contato,
  /// mas não edição: corrigir um nome ou um telefone errado só dava pelo banco.
  updateContato: authProc
    .input(z.object({
      id:        z.string(),
      nome:      z.string().optional(),
      whatsapp:  z.string().nullable().optional(),
      telefone:  z.string().nullable().optional(),
      email:     z.string().nullable().optional(),
      cpf:       z.string().nullable().optional(),
      cidade:    z.string().nullable().optional(),
      profissao: z.string().nullable().optional(),
      empresa:   z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...campos } = input;
      const atual = await prisma.crmContato.findUnique({ where: { id }, select: { empresaId: true } });
      if (!atual) throw new Error("Contato não encontrado");
      // Contato importado pode ter empresaId nulo; nesse caso vale o acesso ao
      // deal, que o app já checou para chegar até aqui.
      if (atual.empresaId && !canAccess(ctx, atual.empresaId)) {
        throw new Error("Contato não pertence à sua empresa");
      }
      // Só dígitos: o WhatsApp é chave de envio, e "(77) 99999-9999" não casa
      // com o remoteJid que volta do Evolution.
      const whatsapp = campos.whatsapp === undefined
        ? undefined
        : campos.whatsapp === null ? null : campos.whatsapp.replace(/\D/g, "");
      return prisma.crmContato.update({
        where: { id },
        data: { ...campos, whatsapp },
      });
    }),

  addNota: authProc
    .input(z.object({ dealId: z.string(), conteudo: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      { const d = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
        if (!d || !canAccess(ctx, empresaDoDeal(d))) throw new Error("Deal não pertence à sua empresa"); }
      return prisma.crmNota.create({ data: input });
    }),

  // ── Contatos ───────────────────────────────────────────────────────────────

  searchContatos: authProc
    .input(z.object({ q: z.string() }))
    .query(async ({ input, ctx }) => {
      if (input.q.length < 2) return [];
      return prisma.crmContato.findMany({
        where: {
          ...whereEmpresa(ctx),
          OR: [
            { nome: { contains: input.q, mode: "insensitive" } },
            { whatsapp: { contains: input.q } },
            { cpf: { contains: input.q } },
          ],
        },
        take: 10,
        orderBy: { nome: "asc" },
      });
    }),

  // ── Tags ─────────────────────────────────────────────────────────────────

  /**
   * Tags da empresa. Com `pipelineId`, devolve as tags DAQUELE funil + as gerais
   * (pipelineId nulo) — é o que o Kanban e o WhatsApp IA mostram quando há um
   * funil em foco. Sem `pipelineId`, devolve todas (gerenciador de tags).
   */
  listTags: authProc
    .input(z.object({ pipelineId: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      return prisma.crmTag.findMany({
        where: {
          AND: [
            whereTagVisivel(ctx),
            ...(input?.pipelineId ? [{ OR: [{ pipelineId: input.pipelineId }, { pipelineId: null }] }] : []),
          ],
        },
        include: { pipeline: { select: { id: true, nome: true, cor: true } } },
        orderBy: [{ pipelineId: { sort: "asc", nulls: "first" } }, { nome: "asc" }],
      });
    }),

  createTag: authProc
    .input(z.object({
      nome: z.string().min(1),
      cor: z.string().default("#6366f1"),
      pipelineId: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      let empresaId = ctx.empresaId ?? undefined;
      if (input.pipelineId) {
        const p = await prisma.crmPipeline.findUnique({ where: { id: input.pipelineId }, select: { empresaId: true } });
        if (!p || !canAccess(ctx, p.empresaId)) throw new Error("Funil não pertence à sua empresa");
        // A tag do funil é da empresa do funil (admin global cria para qualquer escritório).
        empresaId = p.empresaId ?? empresaId;
      }
      return prisma.crmTag.create({
        data: { nome: input.nome.trim(), cor: input.cor, pipelineId: input.pipelineId ?? null, empresaId },
      });
    }),

  updateTag: authProc
    .input(z.object({
      id: z.string(),
      nome: z.string().optional(),
      cor: z.string().optional(),
      pipelineId: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const tag = await prisma.crmTag.findUnique({ where: { id: input.id }, select: { empresaId: true } });
      if (!tag || !podeEditarTag(ctx, tag.empresaId)) throw new Error("Tag não pertence à sua empresa");
      const { id, ...data } = input;
      return prisma.crmTag.update({ where: { id }, data });
    }),

  deleteTag: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const tag = await prisma.crmTag.findUnique({ where: { id: input.id }, select: { empresaId: true } });
      if (!tag || !podeEditarTag(ctx, tag.empresaId)) throw new Error("Tag não pertence à sua empresa");
      return prisma.crmTag.delete({ where: { id: input.id } });
    }),

  setDealTags: authProc
    .input(z.object({ dealId: z.string(), tagIds: z.array(z.string()) }))
    .mutation(async ({ input }) => {
      return (prisma as any).crmDeal.update({
        where: { id: input.dealId },
        data: { tags: { set: input.tagIds.map((id: string) => ({ id })) } },
        select: { id: true, tags: { select: { id: true, nome: true, cor: true } } },
      });
    }),

  /**
   * Liga/desliga UMA tag no deal. O `setDealTags` regrava a lista inteira a partir
   * do que a tela tinha carregado — e apagava a tag que a IA aplicou nesse meio-tempo
   * (engajamento SDR, auto-tag de qualificação). Aqui é connect/disconnect pontual.
   */
  toggleDealTag: authProc
    .input(z.object({ dealId: z.string(), tagId: z.string(), ativo: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { empresaId: true, ...PIPELINE_EMPRESA } });
      if (!deal || !canAccess(ctx, empresaDoDeal(deal))) throw new Error("Deal não pertence à sua empresa");
      return prisma.crmDeal.update({
        where: { id: input.dealId },
        data: { tags: input.ativo ? { connect: { id: input.tagId } } : { disconnect: { id: input.tagId } } },
        select: { id: true, tags: { select: { id: true, nome: true, cor: true, pipelineId: true } } },
      });
    }),

  // ── Seed carreteiros ───────────────────────────────────────────────────────

  seedCarreteiros: authProc.mutation(async ({ ctx }) => {
    const existing = await prisma.crmPipeline.count();
    if (existing > 0) return { skipped: true, message: "Pipelines já existem." };

    for (const seed of [SEED_COMERCIAL, SEED_PROCESSUAL]) {
      const pipeline = await prisma.crmPipeline.create({
        data: { nome: seed.nome, tipo: seed.tipo, cor: seed.cor, empresaId: ctx.empresaId ?? undefined, ordem: seed === SEED_COMERCIAL ? 0 : 1 },
      });
      for (const s of seed.stages) {
        await prisma.crmStage.create({
          data: {
            pipelineId: pipeline.id,
            chave: s.chave,
            nome: s.nome,
            ordem: s.ordem,
            cor: s.cor,
            ehEntrada: s.ehEntrada ?? false,
            ehGanho: s.ehGanho ?? false,
            requerAcaoHumana: s.requerAcaoHumana ?? false,
          },
        });
      }
    }

    return { skipped: false, message: "Seed carreteiros executado com sucesso." };
  }),
});
