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
import type { VinculoEmprego } from "./types.js";

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
  /** The campoColetar of the current step — used to skip the mandatory-question instruction when already collected */
  campoColetar?: string | null;
};

/**
 * Manages Daniela's sequential data collection flow.
 *
 * On first call (iaFlowStepChave = null): sets step 1, returns its question.
 * On subsequent calls: validates the client's answer with a lightweight LLM,
 *   advances the step, and returns the next question.
 * Returns null when the flow is complete or not configured.
 */
export async function initAdvogadoFlowIfNeeded(
  projetoId: string,
  dealId: string,
): Promise<{ message: string | null; firstStepChave: string | null }> {
  const steps = await loadSteps(projetoId, "advogado", "advogado");
  const firstStep = steps[0];
  if (!firstStep) return { message: null, firstStepChave: null };
  // Reset flow step data but preserve apresentacao_enviado (the concurrency lock flag
  // written by enviarMensagemProativa before this call — wiping it would allow duplicate sends).
  await prisma.$executeRaw`
    UPDATE "CrmDeal"
    SET "iaFlowStepChave" = ${firstStep.chave},
        "iaFlowStepData" = CASE
          WHEN COALESCE("iaFlowStepData", '{}') ? 'apresentacao_enviado'
          THEN '{"apresentacao_enviado": true}'::jsonb
          ELSE '{}'::jsonb
        END
    WHERE id = ${dealId}
  `;
  return { message: (firstStep.pergunta as string) ?? null, firstStepChave: firstStep.chave as string };
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
  history?: Array<{ direcao: string; conteudo?: string | null }>,
): Promise<AdvogadoFlowResult> {
  const steps = await loadSteps(projetoId, "advogado", "advogado");
  if (!steps.length) return { nextQuestion: null };

  const currentStepChave = deal.iaFlowStepChave;
  const merged = (deal.qualificacao as Record<string, unknown>) ?? {};

  // First interaction with Daniela — send step 1 without validation.
  // Only triggered when iaFlowStepChave is truly absent (null/empty).
  // outgoingCount === 0 is NOT a valid restart signal: the deal may already be in progress
  // but this be the first message of a new WhatsApp session.
  if (!currentStepChave || currentStepChave === "") {
    const firstStep = steps[0];
    if (!firstStep) return { nextQuestion: null };
    const existingStepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    // P1 guard: cron's $executeRaw lock writes apresentacao_enviado=true before calling
    // initAdvogadoFlowIfNeeded. If that flag is already true when the webhook reads the deal,
    // the cron won the race — return null so the webhook path doesn't send a duplicate intro.
    if (existingStepData.apresentacao_enviado === true) {
      return { nextQuestion: null };
    }
    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: {
        iaFlowStepChave: firstStep.chave,
        // Preserve the apresentacao_enviado concurrency lock — do not wipe it.
        iaFlowStepData: { apresentacao_enviado: existingStepData.apresentacao_enviado ?? false },
      },
    });
    return { nextQuestion: firstStep.pergunta as string, stepType: firstStep.stepType as string, nextStepChave: firstStep.chave as string, campoColetar: firstStep.campoColetar ?? null };
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
      return { nextQuestion: currentStep.pergunta as string, stepType: "llm_generated", nextStepChave: currentStepChave, campoColetar: null };
    }
    // Already sent — user is responding to it, advance
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" (llm_generated) already sent — advancing`);
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // For plain data-collection steps (campoColetar set, no gates): extract and advance.
  // Guard: only advance if the field was actually extracted, OR the lead has already
  // tried 2+ times (deliberate impatience). This prevents silently losing required
  // fields when the lead sends a non-answer like "pode seguir".
  const ACKS_REGEX_FC = /^(ok|certo|beleza|tá|ta|aham|combinado|opa|oi|sim|não|nao|blz|bom|legal)\.?$/i;
  const isSubstantive = incomingText.replace(/\s/g, "").length >= 4 && !ACKS_REGEX_FC.test(incomingText.trim());
  if (currentStep.campoColetar && !currentStep.gates.length && isSubstantive) {
    const extracted = await extractJson<Record<string, string>>({
      projetoId,
      instruction: `Extraia o valor do campo "${currentStep.campoColetar}" da resposta do cliente à pergunta abaixo. Retorne apenas: { "${currentStep.campoColetar}": "valor_extraído" }`,
      text: `Pergunta: "${currentStep.pergunta}"\nResposta: "${incomingText}"`,
      maxTokens: 128,
    });
    const campoExtraido = extracted != null &&
      Object.values(extracted).some(v => v !== null && v !== undefined && v !== "");
    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const tentativasKey = `${currentStepChave}_tentativas`;
    const tentativas = (stepData[tentativasKey] as number) ?? 0;
    if (campoExtraido || tentativas >= 2) {
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" answered=true extracted=${JSON.stringify(extracted ?? {})} tentativas=${tentativas}`);
      return await advanceToNextStep(deal, steps, currentStep, extracted ?? {}, null);
    }
    const novasTentativas = tentativas + 1;
    await saveFlowStepData(deal, { [tentativasKey]: novasTentativas }, currentStepChave);
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" campo não extraído — tentativa ${novasTentativas}/3`);
    return { nextQuestion: currentStep.pergunta as string, stepType: currentStep.stepType as string, campoColetar: currentStep.campoColetar ?? null };
  }

  // Clear gate-silence flag — lead sent a new message, allow re-evaluation
  if (currentStep.gates.length > 0) {
    const existingData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    if (existingData._gate_silenciado === true) {
      await saveFlowStepData(deal, { _gate_silenciado: false }, currentStepChave);
    }
  }

  // Build gate context for the LLM
  const gatesContext = currentStep.gates.length > 0
    ? `Gates disponíveis:\n${currentStep.gates.map((g: any) => `  id:"${g.id}" condição:"${g.condicao}"`).join("\n")}\n\nRetorne: { "answered": boolean, "gate_id": "id_do_gate que se aplica ou null", "extracted": { "campo": "valor_extraido" } }`
    : `Retorne: { "answered": boolean, "gate_id": null, "extracted": { "${currentStep.campoColetar ?? "dado"}": "valor_extraído" } }`;

  // When the step has no fixed question (llm_generated/gate with empty pergunta), inject the last
  // outgoing message as context so the gate LLM knows what was said before the client responded.
  const lastOutMsg = currentStep.pergunta
    ? null
    : (history ?? [])
        .filter((m) => m.direcao === "out")
        .slice(-2)
        .map((m) => m.conteudo ?? "")
        .filter(Boolean)
        .join("\n");

  const perguntaCtx = currentStep.pergunta
    ? `Pergunta que foi feita ao cliente: "${currentStep.pergunta}"`
    : lastOutMsg
      ? `Última mensagem enviada pela advogada:\n"${lastOutMsg}"`
      : `(sem pergunta específica — avalie apenas a resposta do cliente)`;

  const validation = await extractJson<{
    answered: boolean;
    gate_id?: string | null;
    extracted?: Record<string, string>;
  }>({
    projetoId,
    instruction: `${perguntaCtx}\n\n${gatesContext}`,
    text: `Resposta do cliente: "${incomingText}"`,
    maxTokens: 256,
  });

  // Not answered or LLM failed
  if (!validation || !validation.answered) {
    if (currentStep.gates.length > 0) {
      // Gate step: no match — stay silent, don't pester the lead
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" — gate sem match, silêncio`);
      await saveFlowStepData(deal, { _gate_silenciado: true }, currentStepChave);
      return { nextQuestion: null, stepType: currentStep.stepType as string ?? null, nextStepChave: currentStepChave };
    }
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" — não respondida, repetindo`);
    return { nextQuestion: currentStep.pergunta as string, stepType: currentStep.stepType as string, campoColetar: currentStep.campoColetar ?? null };
  }

  console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" answered=true gate="${validation.gate_id ?? "none"}"`);

  // Handle gate action if step has gates
  if (currentStep.gates.length > 0) {
    const gate = validation.gate_id
      ? currentStep.gates.find((g: any) => g.id === validation.gate_id)
      : null;
    if (gate) {
      return await executeGateAction(deal, steps, currentStep, gate, validation.extracted ?? {});
    }
    // gate_id not matched — silence
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" — gate_id="${validation.gate_id ?? "null"}" sem match, silêncio`);
    await saveFlowStepData(deal, { _gate_silenciado: true }, currentStepChave);
    return { nextQuestion: null, stepType: currentStep.stepType as string ?? null, nextStepChave: currentStepChave };
  }

  // No gate → continue to next step
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

// Fallback keys: OCR pipeline stores CNH name as "nome" (not "nome_completo").
// Only alias when the stored value looks like a full name (2+ words).
const CAMPO_ALIAS: Record<string, string> = {
  nome_completo: "nome",
};

// Salary and jornada fields collected by Ana land in vinculos[0], not flat merged.
const VINCULO_FALLBACK: Record<string, (v: VinculoEmprego) => unknown> = {
  salario_total_declarado:  (v) => v.salario_holerite  ?? v.salario_por_fora,
  salario_holerite:         (v) => v.salario_holerite,
  salario_mensal:           (v) => v.salario_holerite  ?? v.salario_por_fora,
  jornada_descricao:        (v) => v.jornada_inicio    ?? v.jornada_fim,
  jornada_inicio:           (v) => v.jornada_inicio,
  horas_extras_descricao:   (v) => v.horas_extras,
  pagamento_fora_descricao: (v) => v.pagamento_fora,
};

function isFieldCollected(
  merged: Record<string, unknown>,
  campo: string,
  vinculos?: VinculoEmprego[],
): boolean {
  let value = merged[campo];
  if ((value == null || (typeof value === "string" && value.trim().length === 0)) && CAMPO_ALIAS[campo]) {
    const aliasVal = merged[CAMPO_ALIAS[campo]];
    if (typeof aliasVal === "string" && aliasVal.trim().includes(" ")) {
      value = aliasVal;
    }
  }
  if (value == null && VINCULO_FALLBACK[campo] && vinculos && vinculos.length > 0) {
    const val = VINCULO_FALLBACK[campo](vinculos[0]);
    if (val != null && val !== "") return true;
  }
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
    const vinculos = Array.isArray(merged.vinculos) ? merged.vinculos as VinculoEmprego[] : [];

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
      if (candidate.campoColetar && !NUNCA_PULAR.has(candidate.campoColetar) && isFieldCollected(merged, candidate.campoColetar, vinculos)) {
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
  return { nextQuestion: nextStep?.pergunta ?? null, stepType: nextStep?.stepType ?? null, nextStepChave: nextStep?.chave ?? null, campoColetar: nextStep?.campoColetar ?? null };
}

/** @deprecated Use advanceAdvogadoFlow */
export const handleAdvogadoFlow = advanceAdvogadoFlow;
