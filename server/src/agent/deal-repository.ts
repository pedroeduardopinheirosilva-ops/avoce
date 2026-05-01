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
  const faseEntrada = await prisma.iaFaseFunil.findFirst({
    where: { projetoId, ehEntrada: true, pipelineTipo: "comercial" },
    orderBy: { ordem: "asc" },
  });

  let stageId: string | undefined;
  let pipelineId: string | undefined;

  if (faseEntrada?.pipelineId) {
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: faseEntrada.pipelineId, chave: faseEntrada.chave },
    });
    stageId = stage?.id;
    pipelineId = faseEntrada.pipelineId;
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

  return prisma.crmDeal.create({
    data: {
      titulo: `${nome} — WhatsApp`,
      pipelineId,
      stageId,
      contatoId,
      projetoId,
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
  const crmStage = await prisma.crmStage.findFirst({ where: { chave: "descartado" } });
  await prisma.crmDeal.update({ where: { id: dealId }, data: { iaStageChave: "descartado", ...(crmStage ? { stageId: crmStage.id } : {}) } });
  const justificativa = vinculosTodosPrescritos
    ? "Prescrição trabalhista: vínculo mais recente encerrado há mais de 2 anos."
    : "Empresa/caso fora do perfil de atuação do escritório (filtro silencioso ativado).";
  await prisma.crmNota.create({ data: { dealId, conteudo: `[IA] Descarte pendente revisão humana — ${justificativa}` } });
  return { moved: true, justificativa };
}
