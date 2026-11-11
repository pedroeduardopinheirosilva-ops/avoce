/**
 * Deal Repository — Prisma operations for CRM deals extracted from stage-engine.ts.
 * All DB writes are here; callers do not import prisma directly for deal mutations.
 */

import { prisma } from "../db.js";

export function splitState(merged: Record<string, unknown>): { qualificacao: any; iaFlags: any } {
  const qual: Record<string, unknown> = {};
  const iaf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith("_")) iaf[k] = v;
    else qual[k] = v;
  }
  return { qualificacao: qual as any, iaFlags: iaf as any };
}

export async function atualizarMergedFlags(
  dealId: string,
  mergedAtual: Record<string, unknown>,
  flags: Record<string, unknown>,
): Promise<void> {
  const novo = { ...mergedAtual, ...flags };
  await prisma.crmDeal.update({ where: { id: dealId }, data: splitState(novo) });
}

export async function persistMergedUpdates(
  dealId: string,
  mergedAtual: Record<string, unknown>,
  updates: Record<string, unknown>,
): Promise<void> {
  if (!Object.keys(updates).length) return;
  const novo = { ...mergedAtual, ...updates };
  await prisma.crmDeal.update({ where: { id: dealId }, data: splitState(novo) });
}

/** Funil/coluna/fase de entrada do projeto — onde um lead novo do WhatsApp nasce. */
export async function resolverEntradaProjeto(projetoId: string) {
  // 1. Pipeline explícito via IaProjetoConfig (chave pipeline_entrada_id) — fonte mais confiável
  const pipelineConfig = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, chave: "pipeline_entrada_id" },
  });
  const pipelineEntradaId = pipelineConfig?.valor || undefined;

  const faseEntrada = await prisma.iaFaseFunil.findFirst({
    where: { projetoId, ehEntrada: true, pipelineTipo: "comercial" },
    orderBy: { ordem: "asc" },
  });

  // Resolve pipelineId: config explícita > IaFaseFunil
  const resolvedPipelineId = pipelineEntradaId ?? faseEntrada?.pipelineId;

  let stageId: string | undefined;
  let pipelineId: string | undefined;

  if (resolvedPipelineId) {
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: resolvedPipelineId, ehEntrada: true },
    }) ?? await prisma.crmStage.findFirst({
      where: { pipelineId: resolvedPipelineId },
      orderBy: { ordem: "asc" },
    });
    stageId = stage?.id;
    pipelineId = resolvedPipelineId;
  }

  if (!stageId) {
    const pipeline = await prisma.crmPipeline.findFirst({
      where: { tipo: "comercial", ativo: true },
      include: { stages: { where: { ehEntrada: true }, take: 1 } },
    });
    if (pipeline?.stages[0]) {
      stageId = pipeline.stages[0].id;
      pipelineId = pipeline.id;
    }
  }

  if (!stageId || !pipelineId) throw new Error("Nenhum pipeline comercial configurado");

  return { pipelineId, stageId, faseEntrada };
}

export async function createInitialDeal(projetoId: string, contatoId: string, nome: string) {
  const { pipelineId, stageId, faseEntrada } = await resolverEntradaProjeto(projetoId);
  const projeto = await prisma.iaProjeto.findUnique({ where: { id: projetoId }, select: { empresaId: true } });

  return prisma.crmDeal.create({
    data: {
      titulo: `${nome} — WhatsApp`,
      pipelineId,
      stageId,
      contatoId,
      projetoId,
      empresaId: projeto?.empresaId ?? undefined,
      iaAtiva: true,
      iaStageChave: faseEntrada?.chave ?? "lead_carreteiro",
      iaPersonaChave: faseEntrada?.personaChave ?? "assistente",
      fonteLead: "whatsapp",
    },
  });
}

/**
 * Cliente já GANHO neste projeto que volta a falar: a conversa continua no card ganho, sem IA.
 * Antes nascia outro card "— WhatsApp" com a IA ligada, e a Isabella saudava de novo quem
 * já tinha fechado (Cigano 6688 ganhou 3 cards em 06/11; Alexander e Leandro, 1 cada).
 */
export async function dealGanhoDoContato(projetoId: string, contatoIds: string[]) {
  if (!contatoIds.length) return null;
  return prisma.crmDeal.findFirst({
    where: { contatoId: { in: contatoIds }, projetoId, status: "ganho" },
    orderBy: [{ atualizadoEm: "desc" }],
  });
}

/**
 * Lead que já tinha card aberto SEM projeto de IA (importado do Supabase/Pipedrive,
 * cadastrado à mão) e manda mensagem: o card antigo passa a ser o da conversa, em
 * vez de nascer outro "— WhatsApp" ao lado. Gilson 5096 tinha 3 cards abertos e, em
 * 27/10, 220 leads da RAP estavam duplicados assim.
 *
 * Só card comercial da mesma empresa do projeto — card processual é cliente com
 * processo, não lead, e continua separado. Se o card está num funil que não é do
 * projeto, vai para a entrada do projeto (é onde o SDR enxerga a conversa).
 */
export async function adotarDealSemProjeto(projetoId: string, contatoIds: string[]) {
  if (!contatoIds.length) return null;
  const projeto = await prisma.iaProjeto.findUnique({ where: { id: projetoId }, select: { empresaId: true } });
  if (!projeto?.empresaId) return null;
  const orfao = await prisma.crmDeal.findFirst({
    where: {
      contatoId: { in: contatoIds }, projetoId: null, status: "aberto",
      empresaId: projeto.empresaId, pipeline: { tipo: "comercial" },
    },
    orderBy: [{ ultimoContatoEm: { sort: "desc", nulls: "last" } }, { criadoEm: "desc" }],
  });
  if (!orfao) return null;

  const entrada = await resolverEntradaProjeto(projetoId);
  const funisDoProjeto = new Set(
    (await prisma.iaFaseFunil.findMany({ where: { projetoId }, select: { pipelineId: true } }))
      .map((f) => f.pipelineId).filter(Boolean) as string[],
  );
  funisDoProjeto.add(entrada.pipelineId);
  const mover = !funisDoProjeto.has(orfao.pipelineId);

  const adotado = await prisma.crmDeal.update({
    where: { id: orfao.id },
    data: {
      projetoId,
      // Importação grava iaAtiva=false por padrão; só respeita a pausa se alguém pausou.
      ...(orfao.iaPausadaPor ? {} : { iaAtiva: true }),
      ...(mover ? { pipelineId: entrada.pipelineId, stageId: entrada.stageId } : {}),
      ...(orfao.iaStageChave ? {} : {
        iaStageChave: entrada.faseEntrada?.chave ?? "lead_carreteiro",
        iaPersonaChave: entrada.faseEntrada?.personaChave ?? "assistente",
      }),
    },
  });
  if (mover) {
    await prisma.crmDealStageLog.create({
      data: { dealId: orfao.id, stageAnteriorId: orfao.stageId, stageNovoId: entrada.stageId, motivo: "Lead voltou pelo WhatsApp — card sem projeto adotado pela IA" },
    });
  }
  return adotado;
}

export async function updateDealFields(
  dealId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await prisma.crmDeal.update({ where: { id: dealId }, data: fields as any });
}

export async function saveFlowStepData(
  deal: { id: string; iaFlowStepData?: Record<string, unknown> | null },
  extracted: Record<string, unknown>,
  nextStepChave: string,
): Promise<void> {
  const current = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
  const updated: Record<string, unknown> = { ...current, ...extracted };
  await prisma.crmDeal.update({
    where: { id: deal.id },
    data: { iaFlowStepChave: nextStepChave, iaFlowStepData: updated as any },
  });
}

export async function saveParecerValue(dealId: string, parecer: string, valorEstimado: number): Promise<void> {
  await prisma.crmDeal.update({ where: { id: dealId }, data: { parecer, valorEstimado } });
  await prisma.crmNota.create({
    data: { dealId, conteudo: `[Parecer Daniela] Valor estimado: ${valorEstimado.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` },
  });
}

export async function moveToDescarte(
  projetoId: string, dealId: string, vinculosTodosPrescritos: boolean,
): Promise<{ moved: boolean; justificativa: string }> {
  const faseFunil = await prisma.iaFaseFunil.findUnique({ where: { projetoId_chave: { projetoId, chave: "descartado" } } });
  if (!faseFunil) return { moved: false, justificativa: "" };

  // Procurar a coluna só pela chave pegava o "descartado" de QUALQUER funil — na prática
  // o da Subvenção ICMS, que é o primeiro. Um lead de Carreteiros descartado ia parar no
  // funil de outro cliente. A coluna tem que ser a do funil da fase (ou a do próprio deal),
  // e o pipelineId anda junto com o stageId, senão a IA devolve o card pro funil antigo.
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: { pipelineId: true } });
  const pipelineId = faseFunil.pipelineId ?? deal?.pipelineId ?? null;
  const crmStage = pipelineId
    ? await prisma.crmStage.findFirst({ where: { pipelineId, chave: "descartado" } })
    : null;

  await prisma.crmDeal.update({
    where: { id: dealId },
    data: {
      iaStageChave: "descartado",
      ...(crmStage ? { stageId: crmStage.id, pipelineId: crmStage.pipelineId } : {}),
    },
  });
  const justificativa = vinculosTodosPrescritos
    ? "Prescrição trabalhista: vínculo mais recente encerrado há mais de 2 anos."
    : "Empresa/caso fora do perfil de atuação do escritório (filtro silencioso ativado).";
  await prisma.crmNota.create({ data: { dealId, conteudo: `[IA] Descarte pendente revisão humana — ${justificativa}` } });
  return { moved: true, justificativa };
}
