import { z }         from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }    from "../db.js";
import { whereEmpresa, canAccess } from "./tenant-utils.js";

/**
 * Deal importado (Pipedrive, planilha, bot) costuma nascer com `empresaId` nulo, e
 * `canAccess` recusa nulo. Como o kanban lista os cards só por `stageId`, o card
 * aparecia no funil mas não abria nem excluía. O dono real é a empresa do pipeline.
 */
const empresaDoDeal = (deal: { empresaId?: string | null; pipeline?: { empresaId: string | null } | null } | null) =>
  deal?.empresaId ?? deal?.pipeline?.empresaId ?? null;

const PIPELINE_EMPRESA = { pipeline: { select: { empresaId: true } } } as const;

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
    { chave: "aguardando_assinatura",    nome: "Aguardando Assinatura do Contrato",ordem: 7, cor: "#10b981", ehGanho: false },
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
            orderBy: { criadoEm: "asc" },
            select: {
              id: true, titulo: true, valor: true, urgencia: true,
              status: true, stageId: true, criadoEm: true,
              valorEstimado: true, iaAtiva: true, iaPausadaPor: true,
              origemPlataforma: true, origemTipo: true, origemAnuncioId: true, origemAnuncioTitulo: true, origemAnuncioTexto: true, origemUrl: true, origemEm: true,
              contato: { select: { id: true, nome: true, whatsapp: true, cidade: true, fotoPerfilUrl: true, fotoPerfilEm: true } },
            },
          });

          return { ...stage, deals };
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
        select: { pipelineId: true },
      });
      if (!destino) throw new Error("Etapa de destino não encontrada");

      await prisma.crmDealStageLog.create({
        data: {
          dealId: input.dealId,
          stageAnteriorId: deal.stageId,
          stageNovoId: input.stageId,
        },
      });

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

  listTags: authProc.query(async ({ ctx }) => {
    return (prisma as any).crmTag.findMany({
      where: whereEmpresa(ctx),
      orderBy: { nome: "asc" },
    });
  }),

  createTag: authProc
    .input(z.object({ nome: z.string().min(1), cor: z.string().default("#6366f1") }))
    .mutation(async ({ input, ctx }) => {
      return (prisma as any).crmTag.create({
        data: { ...input, empresaId: ctx.empresaId ?? undefined },
      });
    }),

  updateTag: authProc
    .input(z.object({ id: z.string(), nome: z.string().optional(), cor: z.string().optional() }))
    .mutation(async ({ input }) => {
      const { id, ...data } = input;
      return (prisma as any).crmTag.update({ where: { id }, data });
    }),

  deleteTag: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return (prisma as any).crmTag.delete({ where: { id: input.id } });
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
