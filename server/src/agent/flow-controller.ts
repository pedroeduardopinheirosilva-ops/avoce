/**
 * Flow Controller — deterministic step sequencing for IA personas.
 *
 * Ana (assistente): DB-driven pre-vinculos and pos-vinculos questions,
 *   with hardcoded fallback when no steps configured.
 *
 * Daniela (advogado): fully sequential DB-driven flow. Each client reply
 *   is validated by a lightweight LLM call before advancing.
 */

import { prisma } from "../db.js";
import { extractJson } from "./llm.js";
import { saveFlowStepData } from "./deal-repository.js";

// ── Cache ──────────────────────────────────────────────────────────────────

const _cache = new Map<string, { steps: any[]; ts: number }>();
const CACHE_TTL = 5 * 60 * 1000;

export function invalidateFlowStepCache(projetoId: string): void {
  for (const key of _cache.keys()) {
    if (key.startsWith(projetoId)) _cache.delete(key);
  }
}

async function loadSteps(projetoId: string, personaChave: string, fase: string) {
  const key = `${projetoId}:${personaChave}:${fase}`;
  const cached = _cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.steps;

  const steps = await prisma.iaFlowStep.findMany({
    where: { projetoId, personaChave, fase, ativo: true },
    orderBy: { ordem: "asc" },
    include: { gates: { orderBy: { ordem: "asc" } } },
  });
  _cache.set(key, { steps, ts: Date.now() });
  return steps;
}

// ── Ana — assistente ───────────────────────────────────────────────────────

/**
 * Returns the greeting step text for the first exchange, or null if not configured.
 */
export async function getGreetingStep(projetoId: string): Promise<string | null> {
  const steps = await loadSteps(projetoId, "assistente", "pre_vinculos");
  const greeting = steps.find((s: any) => s.stepType === "saudacao");
  return greeting ? (greeting.pergunta as string) : null;
}

/**
 * Returns the next pre-vinculos question from DB.
 * Returns `undefined` when no steps are configured (caller uses hardcoded fallback).
 * Returns `null` when all steps are done.
 */
export async function getNextPreVinculosQuestion(
  projetoId: string,
  merged: Record<string, unknown>,
): Promise<string | null | undefined> {
  const steps = await loadSteps(projetoId, "assistente", "pre_vinculos");
  // Exclude greeting steps — they are only used on the very first exchange
  const regularSteps = steps.filter((s: any) => s.stepType !== "saudacao");
  if (!regularSteps.length) return undefined;

  for (const step of regularSteps) {
    if (!step.campoColetar) continue;
    const val = merged[step.campoColetar];
    if (val === undefined || val === null || val === "") return step.pergunta as string;
  }
  return null;
}

/**
 * Returns the next pos-vinculos question from DB.
 * Returns `undefined` when no steps are configured.
 * Returns `null` when all steps are done.
 *
 * @param fase - which pos-vinculos phase to load ("pos_vinculos" = Ag2 long, "pos_vinculos_curto" = Ag3 short)
 */
export async function getNextPosVinculosQuestion(
  projetoId: string,
  merged: Record<string, unknown>,
  fase: string = "pos_vinculos",
): Promise<string | null | undefined> {
  const steps = await loadSteps(projetoId, "assistente", fase);
  if (!steps.length) return undefined;

  for (const step of steps) {
    if (!step.campoColetar) continue;
    const val = merged[step.campoColetar];
    if (val === undefined || val === null || val === "") {
      // Se "não tem emprego anterior", pula todos os campos do anterior
      const semAnterior = merged.tem_emprego_anterior === "nao" || merged.tem_emprego_anterior === false;
      if (semAnterior && (step.campoColetar as string).includes("anterior")) continue;
      return step.pergunta as string;
    }
  }
  return null;
}

// ── Daniela — advogado ─────────────────────────────────────────────────────

export type AdvogadoFlowResult = {
  nextQuestion: string | null;
  /** When stepType is "llm_generated", nextQuestion is an LLM instruction, not the text to send verbatim */
  stepType?: string | null;
  /** The chave of the step that was just set as current (useful to fire side-effects on step transitions) */
  nextStepChave?: string | null;
};

/**
 * Manages Daniela's sequential data collection flow.
 *
 * On first call (iaFlowStepChave = null): sets step 1, returns its question.
 * On subsequent calls: validates the client's answer with a lightweight LLM,
 *   advances the step, and returns the next question.
 * Returns null when the flow is complete or not configured.
 */
export async function initAdvogadoFlowIfNeeded(projetoId: string, dealId: string): Promise<string | null> {
  const steps = await loadSteps(projetoId, "advogado", "advogado");
  const firstStep = steps[0];
  if (!firstStep) return null;
  await prisma.crmDeal.update({
    where: { id: dealId },
    data: { iaFlowStepChave: firstStep.chave, iaFlowStepData: {} },
  });
  return (firstStep.pergunta as string) ?? null;
}

export async function advanceAdvogadoFlow(
  projetoId: string,
  deal: {
    id: string;
    iaFlowStepChave?: string | null;
    iaFlowStepData?: Record<string, unknown> | null;
    qualificacao?: unknown;
  },
  incomingText: string,
  outgoingCount: number,
): Promise<AdvogadoFlowResult> {
  const steps = await loadSteps(projetoId, "advogado", "advogado");
  if (!steps.length) return { nextQuestion: null };

  const currentStepChave = deal.iaFlowStepChave;
  const merged = (deal.qualificacao as Record<string, unknown>) ?? {};

  // First interaction with Daniela — send step 1 without validation
  if (!currentStepChave || currentStepChave === "" || outgoingCount === 0) {
    const firstStep = steps[0];
    if (!firstStep) return { nextQuestion: null };
    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: { iaFlowStepChave: firstStep.chave, iaFlowStepData: {} },
    });
    return { nextQuestion: firstStep.pergunta as string, stepType: firstStep.stepType as string, nextStepChave: firstStep.chave as string };
  }

  // Flow already completed or discarded
  if (currentStepChave === "__done__" || currentStepChave === "__discarded__") {
    return { nextQuestion: null };
  }

  const currentStep = steps.find((s: any) => s.chave === currentStepChave);
  if (!currentStep) return { nextQuestion: null };

  // Steps that don't require client validation (document sending, final confirmation)
  if (currentStep.stepType === "document" || currentStep.stepType === "end") {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // llm_generated steps: send LLM content first, advance only after user responds
  // Uses _enviado flag stored in iaFlowStepData to track whether content was already sent.
  if (currentStep.stepType === "llm_generated") {
    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const alreadySent = stepData[`${currentStepChave}_enviado`] === true;
    if (!alreadySent) {
      // Not yet sent — return instruction so stage-engine generates the LLM response
      return { nextQuestion: currentStep.pergunta as string, stepType: "llm_generated", nextStepChave: currentStepChave };
    }
    // Already sent — user is responding to it, advance
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" (llm_generated) already sent — advancing`);
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // For plain data-collection steps (campoColetar set, no gates): any substantive text counts as answered.
  // Skip the answered=true gate to avoid loops where the LLM rejects typed data for a step that originally
  // asked for a document. Just extract the value and advance.
  const ACKS_REGEX_FC = /^(ok|certo|beleza|tá|ta|aham|combinado|opa|oi|sim|não|nao|blz|bom|legal)\.?$/i;
  const isSubstantive = incomingText.replace(/\s/g, "").length >= 4 && !ACKS_REGEX_FC.test(incomingText.trim());
  if (currentStep.campoColetar && !currentStep.gates.length && isSubstantive) {
    const extracted = await extractJson<Record<string, string>>({
      projetoId,
      instruction: `Extraia o valor do campo "${currentStep.campoColetar}" da resposta do cliente à pergunta abaixo. Retorne apenas: { "${currentStep.campoColetar}": "valor_extraído" }`,
      text: `Pergunta: "${currentStep.pergunta}"\nResposta: "${incomingText}"`,
      maxTokens: 128,
    });
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" answered=true (verbal) extracted=${JSON.stringify(extracted ?? {})}`);
    return await advanceToNextStep(deal, steps, currentStep, extracted ?? {}, null);
  }

  // Build gate context for the LLM
  const gatesContext = currentStep.gates.length > 0
    ? `Gates disponíveis:\n${currentStep.gates.map((g: any) => `  id:"${g.id}" condição:"${g.condicao}"`).join("\n")}\n\nRetorne: { "answered": boolean, "gate_id": "id_do_gate que se aplica ou null", "extracted": { "campo": "valor_extraido" } }`
    : `Retorne: { "answered": boolean, "gate_id": null, "extracted": { "${currentStep.campoColetar ?? "dado"}": "valor_extraído" } }`;

  const validation = await extractJson<{
    answered: boolean;
    gate_id?: string | null;
    extracted?: Record<string, string>;
  }>({
    projetoId,
    instruction:
      `Pergunta que foi feita ao cliente: "${currentStep.pergunta}"\n\n` +
      gatesContext,
    text: `Resposta do cliente: "${incomingText}"`,
    maxTokens: 256,
  });

  // Not answered or LLM failed → repeat current question (preserve stepType so llm_generated is never sent verbatim)
  if (!validation || !validation.answered) {
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" — não respondida, repetindo`);
    return { nextQuestion: currentStep.pergunta as string, stepType: currentStep.stepType as string };
  }

  console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" answered=true gate="${validation.gate_id ?? "none"}"`);

  // Handle gate action if step has gates
  if (currentStep.gates.length > 0 && validation.gate_id) {
    const gate = currentStep.gates.find((g: any) => g.id === validation.gate_id);
    if (gate) {
      return await executeGateAction(deal, steps, currentStep, gate, validation.extracted ?? {});
    }
  }

  // No gate or gate not matched → continue
  return await advanceToNextStep(deal, steps, currentStep, validation.extracted ?? {}, null);
}

async function executeGateAction(
  deal: { id: string; iaFlowStepData?: Record<string, unknown> | null; qualificacao?: unknown },
  steps: any[],
  currentStep: any,
  gate: any,
  extracted: Record<string, string>,
): Promise<AdvogadoFlowResult> {
  switch (gate.actionType) {
    case "end":
      await saveFlowStepData(deal, extracted, "__done__");
      return { nextQuestion: gate.actionValue ?? null, nextStepChave: "__done__" };

    case "discard":
      await saveFlowStepData(deal, extracted, "__discarded__");
      return { nextQuestion: gate.actionValue ?? "Infelizmente não conseguiremos prosseguir com seu caso.", nextStepChave: "__discarded__" };

    case "repeat":
      return { nextQuestion: currentStep.pergunta as string };

    case "goto_step": {
      const target = steps.find((s: any) => s.chave === gate.actionValue);
      if (!target) return await advanceToNextStep(deal, steps, currentStep, extracted, null);
      await saveFlowStepData(deal, extracted, target.chave);
      return { nextQuestion: target.pergunta as string, stepType: target.stepType as string, nextStepChave: target.chave as string };
    }

    case "continue":
    case "notify":
    default:
      return await advanceToNextStep(deal, steps, currentStep, extracted, null);
  }
}

// ── Sprint 2: validação de transição de fase (P5) ────────────────────────────

function validarTransicaoFase(
  proximoStep: any,
  merged: Record<string, unknown>
): { permitido: boolean; redirecionarPara?: string } {
  const subFase: string | null = proximoStep.subFase ?? null;

  // Não pode entrar em advogado_dados sem valor ter sido apresentado
  // Aceita tanto _valor_apresentado (path antigo) quanto valor_estimado_enviado (path flow-controller)
  if (subFase === "advogado_dados" && !merged._valor_apresentado && !merged.valor_estimado_enviado) {
    return { permitido: false, redirecionarPara: "valor_estimado" };
  }

  // Não pode entrar em advogado_documentos sem dados pessoais completos
  if (subFase === "advogado_documentos") {
    const camposObrigatorios = ["cpf", "nome_completo", "data_nascimento", "endereco"];
    const stepFaltando = camposObrigatorios.find(c => !isFieldCollected(merged, c));
    if (stepFaltando) {
      return { permitido: false, redirecionarPara: stepFaltando };
    }
  }

  return { permitido: true };
}

function isFieldCollected(merged: Record<string, unknown>, campo: string): boolean {
  const value = merged[campo];
  if (value == null) return false;
  if (typeof value === "string" && value.trim().length === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (campo === "cpf") return /^\d{11}$/.test(String(value).replace(/\D/g, ""));
  if (campo === "data_nascimento") return /\d{4}-\d{2}-\d{2}/.test(String(value)) || /\d{2}\/\d{2}\/\d{4}/.test(String(value));
  return true;
}

async function advanceToNextStep(
  deal: { id: string; iaFlowStepData?: Record<string, unknown> | null; qualificacao?: unknown },
  steps: any[],
  currentStep: any,
  extracted: Record<string, string>,
  overrideNextChave: string | null,
): Promise<AdvogadoFlowResult> {
  let nextStepChave = overrideNextChave;
  const mergedGlobal = (deal.qualificacao as Record<string, unknown>) ?? {};
  const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
  const merged = { ...mergedGlobal, ...stepData };

  if (!nextStepChave) {
    let idx = steps.findIndex((s: any) => s.chave === currentStep.chave);

    // Sprint 2/3: pre-skip de steps cujo campo já está coletado + validação de fase
    while (true) {
      idx++;
      const candidate = steps[idx];
      if (!candidate) {
        await saveFlowStepData(deal, extracted, "__done__");
        return { nextQuestion: null, nextStepChave: "__done__" };
      }

      // Pre-skip: campo já coletado — usa merged (qualificacao + stepData) exceto para campos
      // que Daniela precisa confirmar explicitamente (nunca pular mesmo que estejam na qualificacao)
      const NUNCA_PULAR = new Set(["estado_civil", "nacionalidade"]);
      if (candidate.campoColetar && !NUNCA_PULAR.has(candidate.campoColetar) && isFieldCollected(merged, candidate.campoColetar)) {
        console.log(`[FlowController] Pre-skip step "${candidate.chave}" — campo "${candidate.campoColetar}" já coletado`);
        continue;
      }

      // Validação de transição de fase
      const transicao = validarTransicaoFase(candidate, merged);
      if (!transicao.permitido && transicao.redirecionarPara) {
        const redirectStep = steps.find((s: any) => s.chave === transicao.redirecionarPara);
        if (redirectStep) {
          console.log(`[FlowController] Bloqueio de fase: "${candidate.chave}" → redireciona para "${transicao.redirecionarPara}"`);
          nextStepChave = redirectStep.chave;
          await saveFlowStepData(deal, extracted, nextStepChave!);
          return { nextQuestion: redirectStep.pergunta ?? null, stepType: redirectStep.stepType ?? null, nextStepChave: redirectStep.chave };
        }
      }

      nextStepChave = candidate.chave;
      break;
    }
  }

  await saveFlowStepData(deal, extracted, nextStepChave!);

  const nextStep = steps.find((s: any) => s.chave === nextStepChave);
  return { nextQuestion: nextStep?.pergunta ?? null, stepType: nextStep?.stepType ?? null, nextStepChave: nextStep?.chave ?? null };
}

/** @deprecated Use advanceAdvogadoFlow */
export const handleAdvogadoFlow = advanceAdvogadoFlow;
