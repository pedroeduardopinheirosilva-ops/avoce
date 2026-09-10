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

export async function createInitialDeal(projetoId: string, contatoId: string, nome: string) {
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
