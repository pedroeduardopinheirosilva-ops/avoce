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

/** Identifies the persona+fase pair to load steps for. */
export type FlowPersonaFase = { personaChave: string; fase: string };

/**
 * Returns the greeting step text for the first exchange, or null if not configured.
 * fase defaults to "pre_vinculos" (classic flow); pass "sdr_simples" for the simplified SDR.
 */
export async function getGreetingStep(projetoId: string, fase = "pre_vinculos"): Promise<string | null> {
  const steps = await loadSteps(projetoId, "assistente", fase);
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

  const qAskedAt = (merged._q_asked_at && typeof merged._q_asked_at === "object")
    ? (merged._q_asked_at as Record<string, unknown>) : {};

  for (const step of regularSteps) {
    if (!step.campoColetar) continue;
    const val = merged[step.campoColetar];
    if (val === undefined || val === null || val === "") {
      // Flag steps (campoColetar starts with "_"): ask the question once, then persist the flag.
      // On the next turn merged[campoColetar] will be true (persisted via stage-engine) → skipped.
      if ((step.campoColetar as string).startsWith("_")) {
        merged[step.campoColetar] = true;
        return step.pergunta as string;
      }
      // Already asked once without answer — advance with what we have.
      if (qAskedAt[step.campoColetar as string] !== undefined) continue;
      merged._q_asked_at = { ...qAskedAt, [step.campoColetar as string]: true };
      return step.pergunta as string;
    }
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

  const qAskedAt = (merged._q_asked_at && typeof merged._q_asked_at === "object")
    ? (merged._q_asked_at as Record<string, unknown>) : {};

  for (const step of steps) {
    if (!step.campoColetar) continue;
    const val = merged[step.campoColetar];
    if (val === undefined || val === null || val === "") {
      // Se "não tem emprego anterior", pula todos os campos do anterior
      const semAnterior = merged.tem_emprego_anterior === "nao" || merged.tem_emprego_anterior === false;
      if (semAnterior && (step.campoColetar as string).includes("anterior")) continue;
      // Already asked once without answer — advance with what we have.
      if (qAskedAt[step.campoColetar as string] !== undefined) continue;
      merged._q_asked_at = { ...qAskedAt, [step.campoColetar as string]: true };
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
  /** If true, stage-engine should auto-advance without waiting for lead response */
  proativo?: boolean;
  /** Notification event to fire in stage-engine (fired by notify or end_notify gate actions) */
  firedNotify?: string | null;
  /** Step proativo ativo — webhook deve silenciar completamente (sem LLM, sem resposta) */
  silentReturn?: boolean;
};

/**
 * Manages Daniela's sequential data collection flow.
 *
 * On first call (iaFlowStepChave = null): sets step 1, returns its question.
 * On subsequent calls: validates the client's answer with a lightweight LLM,
 *   advances the step, and returns the next question.
 * Returns null when the flow is complete or not configured.
 */
// ── Pre-fill from authoritative sources ──────────────────────────────────────
// Maps DocJsonResult / transcription field names → flow step campoColetar names.
const PF_FIELD_MAP: Record<string, string> = {
  nome:            "nome",
  cpf:             "cpf",
  rg:              "rg",
  data_nascimento: "data_nascimento",
  endereco:        "endereco",
  estado_civil:    "estado_civil",
  profissao:       "profissao",
  naturalidade:    "nacionalidade",
  nacionalidade:   "nacionalidade",
};

async function prefillFromSources(
  projetoId: string,
  dealId: string,
): Promise<Record<string, string>> {
  const pf: Record<string, string> = {};

  // 1. DealAnexo.dadosExtraidos — structured OCR from CNH/RG/CTPS already sent
  try {
    const anexos = await prisma.dealAnexo.findMany({
      where: { dealId },
      orderBy: { criadoEm: "asc" },
      select: { dadosExtraidos: true },
    });
    for (const a of anexos) {
      if (!a.dadosExtraidos) continue;
      const d = a.dadosExtraidos as Record<string, unknown>;
      for (const [src, dest] of Object.entries(PF_FIELD_MAP)) {
        if (pf[dest]) continue;
        const v = d[src];
        if (typeof v === "string" && v.trim()) pf[dest] = v.trim();
      }
    }
  } catch {}

  // 2. SessaoReuniao.transcricao — extract structured fields via LLM
  try {
    const rows = await (prisma.sessaoReuniao as any).findMany({
      where: { dealId, NOT: [{ transcricao: null }, { transcricao: "" }] },
      orderBy: { encerradaEm: "desc" },
      take: 1,
      select: { transcricao: true },
    });
    const transcricao: string | undefined = rows[0]?.transcricao;
    if (transcricao && transcricao.length > 80) {
      const extracted = await extractJson<Record<string, string>>({
        projetoId,
        instruction: `Extraia da transcrição abaixo os dados pessoais do CLIENTE (não do advogado). Retorne apenas os campos claramente mencionados: nome, cpf, rg, data_nascimento (DD/MM/AAAA), endereco, estado_civil, profissao, nacionalidade. Omita campos ausentes ou incertos.`,
        text: transcricao.slice(0, 4000),
        maxTokens: 300,
      });
      if (extracted) {
        for (const [src, dest] of Object.entries(PF_FIELD_MAP)) {
          if (pf[dest]) continue;
          const v = extracted[src] ?? extracted[dest];
          if (typeof v === "string" && v.trim()) pf[dest] = v.trim();
        }
      }
    }
  } catch {}

  return pf;
}

export async function initAdvogadoFlowIfNeeded(
  projetoId: string,
  dealId: string,
  personaFase: FlowPersonaFase = { personaChave: "advogado", fase: "advogado" },
): Promise<{ message: string | null; firstStepChave: string | null }> {
  const steps = await loadSteps(projetoId, personaFase.personaChave, personaFase.fase);
  const firstStep = steps[0];
  if (!firstStep) return { message: null, firstStepChave: null };

  // Pre-fill from documents and meeting transcription before sending the first question
  const pfData = await prefillFromSources(projetoId, dealId);
  const pfStepData: Record<string, string> = {};
  for (const [k, v] of Object.entries(pfData)) pfStepData[`_pf_${k}`] = v;
  const pfJson = JSON.stringify(pfStepData);

  if (Object.keys(pfData).length > 0) {
    console.log(`[FlowController] Pre-fill deal=${dealId} campos=${Object.keys(pfData).join(",")}`);
  }

  // Reset flow step data, preserve apresentacao_enviado concurrency lock, merge pre-fill
  await prisma.$executeRaw`
    UPDATE "CrmDeal"
    SET "iaFlowStepChave" = ${firstStep.chave},
        "iaFlowStepData" = (
          CASE
            WHEN COALESCE("iaFlowStepData", '{}') ? 'apresentacao_enviado'
            THEN '{"apresentacao_enviado": true}'::jsonb
            ELSE '{}'::jsonb
          END
        ) || ${pfJson}::jsonb
    WHERE id = ${dealId}
  `;
  // llm_generated first steps must go through the LLM — never send the instruction verbatim.
  const message = firstStep.stepType === "llm_generated"
    ? null
    : (firstStep.pergunta as string) ?? null;
  return { message, firstStepChave: firstStep.chave as string };
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
  personaFase: FlowPersonaFase = { personaChave: "advogado", fase: "advogado" },
): Promise<AdvogadoFlowResult> {
  const steps = await loadSteps(projetoId, personaFase.personaChave, personaFase.fase);
  // A1: sem steps configurados → encerra fluxo (não cai em LLM livre)
  if (!steps.length) return { nextQuestion: null, nextStepChave: "__done__" };

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
    // Also check the standard _enviado flag used by stage-engine after sending llm_generated content.
    if (existingStepData.apresentacao_enviado === true || existingStepData[`${firstStep.chave}_enviado`] === true) {
      // A3: cron ganhou a corrida — sentinel para o stage-engine silenciar sem chamar LLM
      return { nextQuestion: null, nextStepChave: "__concurrency_lock__" };
    }
    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: {
        iaFlowStepChave: firstStep.chave,
        // Preserve the apresentacao_enviado concurrency lock — do not wipe it.
        iaFlowStepData: { apresentacao_enviado: existingStepData.apresentacao_enviado ?? false },
      },
    });
    return { nextQuestion: firstStep.pergunta as string, stepType: firstStep.stepType as string, nextStepChave: firstStep.chave as string, campoColetar: firstStep.campoColetar ?? null, proativo: (firstStep as any).proativo === true };
  }

  // Flow already completed or discarded
  if (currentStepChave === "__done__" || currentStepChave === "__discarded__") {
    return { nextQuestion: null };
  }

  const currentStep = steps.find((s: any) => s.chave === currentStepChave);
  // A2: step chave não encontrado (deletado/renomeado no DB) → encerra fluxo em vez de cair em LLM livre
  if (!currentStep) {
    console.error(`[FlowController] step "${currentStepChave}" não encontrado para persona="${personaFase.personaChave}" fase="${personaFase.fase}" dealId=${deal.id} — encerrando fluxo`);
    await saveFlowStepData(deal, {}, "__done__");
    return { nextQuestion: null, nextStepChave: "__done__" };
  }

  // Fast-track to __done__ when the lead explicitly asks to schedule (Daniela flow only).
  // Prevents Daniela from continuing through remaining steps after the lead already agreed.
  const SCHEDULING_INTENT_FC = /me\s*pass[ae]\s*(os\s*)?hor[aá]rios|me\s*mand[ae]\s*(os\s*)?hor[aá]rios|quero\s*(ver\s*)?(os\s*)?hor[aá]rios|quero\s*(marcar|agendar)|pode\s*agendar|vamos\s*agendar|agendar\s*(a\s*)?reuni[aã]o|quero\s*contratar|quero\s*prosseguir|quero\s*seguir\s*em\s*frente/i;
  if (
    personaFase.personaChave === "advogado" &&
    incomingText.trim().length > 0 &&
    SCHEDULING_INTENT_FC.test(incomingText)
  ) {
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" — scheduling intent, fast-track __done__`);
    await saveFlowStepData(deal, {}, "__done__");
    return { nextQuestion: null, nextStepChave: "__done__" };
  }

  // Auto-advance comp_ steps if Ana already collected the data per-vínculo
  const v0 = Array.isArray(merged.vinculos) ? (merged.vinculos[0] as Record<string, unknown>) : null;
  const COMP_PREENCHIDO: Record<string, boolean> = {
    comp_salario:   !!(v0?.salario_holerite || merged.salario_total_declarado || merged.salario_holerite),
    comp_jornada:   !!(v0?.jornada_inicio   || merged.jornada_inicio           || merged.jornada_descricao),
    comp_fgts:      !!(v0?.fgts_ok          || merged.fgts_ok),
    comp_carteira:  !!(v0?.situacao_ctps    || merged.situacao_ctps),
  };
  if (COMP_PREENCHIDO[currentStepChave] === true) {
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" já preenchido por Ana — avançando`);
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // context_load: silent pre-processing step — auto-advance without sending any message
  if (currentStep.stepType === "context_load") {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // saudacao: greeting step — auto-advance on any incoming message (no specific answer required)
  if (currentStep.stepType === "saudacao") {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // document_request: advance when doc flag is set, user already skipped, or user explicitly refuses
  if (currentStep.stepType === "document_request") {
    const campo = currentStep.campoColetar as string | null;
    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const mergedAll = { ...(deal.qualificacao as Record<string, unknown> ?? {}), ...stepData };

    const isReceived = campo && (mergedAll[campo] === true || mergedAll[campo] === "true");
    const isSkipped  = campo && (stepData[`${campo}_skip`] === true || stepData[`${campo}_skip`] === "true");

    if (isReceived || isSkipped) {
      const reason = isSkipped ? "ignorado pelo usuário" : "recebido";
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" documento ${reason} — avançando`);
      return await advanceToNextStep(deal, steps, currentStep, {}, null);
    }

    // Detect explicit refusal when user sends text instead of a document
    if (campo && incomingText.trim()) {
      const RECUSA_DOC = /n[aã]o.{0,20}(tenho|consigo|vou|posso|quero|mando|envio)|sem documento|depois.{0,10}(mando|envio)|agora n[aã]o|mais tarde|n[aã]o.{0,15}em m[aã]os|n[aã]o.{0,15}dispon[ií]vel|n[aã]o.{0,20}foto/i;
      if (RECUSA_DOC.test(incomingText)) {
        const configs = await prisma.iaProjetoConfig.findMany({
          where: { projetoId, categoria: "coleta_docs", chave: { in: ["coleta_docs_doc_opcional", "coleta_docs_doc_recusa_resposta"] } },
        });
        const docOpcional = configs.find(c => c.chave === "coleta_docs_doc_opcional")?.valor === "true";
        if (docOpcional) {
          const recusaResposta = configs.find(c => c.chave === "coleta_docs_doc_recusa_resposta")?.valor;
          console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" recusa detectada — avançando sem documento`);
          const advanced = await advanceToNextStep(deal, steps, currentStep, { [`${campo}_skip`]: "true" }, null);
          const nextQ = advanced.nextQuestion;
          const resposta = recusaResposta
            ? (nextQ ? `${recusaResposta}\n\n${nextQ}` : recusaResposta)
            : nextQ;
          return {
            nextQuestion: resposta ?? null,
            stepType: advanced.stepType ?? "question",
            nextStepChave: advanced.nextStepChave ?? null,
            campoColetar: advanced.campoColetar ?? null,
          };
        }
      }
    }

    // Document not yet received — stay on this step
    return { nextQuestion: currentStep.pergunta as string, stepType: "document_request", campoColetar: campo };
  }

  // "end" step = conclusão do fluxo — retorna __done__ imediatamente sem procurar próximo step.
  // Não chamar advanceToNextStep: steps de ordem maior (ex: cd_correcao) seriam encontrados.
  if (currentStep.stepType === "end") {
    await saveFlowStepData(deal, {}, "__done__");
    return { nextQuestion: null, nextStepChave: "__done__" };
  }

  // Steps that don't require client validation (document sending)
  if (currentStep.stepType === "document") {
    return await advanceToNextStep(deal, steps, currentStep, {}, null);
  }

  // llm_generated steps: send LLM content first, advance only after user responds
  // Uses _enviado flag stored in iaFlowStepData to track whether content was already sent.
  if (currentStep.stepType === "llm_generated") {
    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const alreadySent = stepData[`${currentStepChave}_enviado`] === true;
    if (!alreadySent) {
      // Not yet sent — return instruction so stage-engine generates the LLM response
      return { nextQuestion: currentStep.pergunta as string, stepType: "llm_generated", nextStepChave: currentStepChave, campoColetar: null, proativo: (currentStep as any).proativo === true };
    }
    // Steps proativos só avançam via runProativoNextStep (incomingText="").
    // Webhooks com mensagem real do lead retornam silentReturn=true: stage-engine encerra
    // sem chamar LLM, sem marcar _enviado, sem enviar resposta — elimina duplicata de áudio.
    if ((currentStep as any).proativo === true && incomingText.trim().length > 0) {
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" proativo ativo — silenciando webhook`);
      return { nextQuestion: null, stepType: "llm_generated", nextStepChave: currentStepChave, silentReturn: true };
    }

    // Already sent — extract campoColetar if set, then advance
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" (llm_generated) already sent — advancing`);
    let llmGenExtracted: Record<string, string> = {};
    if (currentStep.campoColetar) {
      const result = await extractJson<Record<string, string>>({
        projetoId,
        instruction: `Extraia o valor do campo "${currentStep.campoColetar}" da resposta do cliente abaixo. Retorne apenas: { "${currentStep.campoColetar}": "valor_extraído" }`,
        text: `Resposta do cliente: "${incomingText}"`,
        maxTokens: 128,
      });
      llmGenExtracted = result ?? {};
    }
    return await advanceToNextStep(deal, steps, currentStep, llmGenExtracted, null);
  }

  // llm_gate steps: first visit generates LLM content (like llm_generated),
  // subsequent visits evaluate gate conditions against the lead's response (like gate).
  // pergunta = LLM instruction; gates = routing conditions evaluated after send.
  if (currentStep.stepType === "llm_gate") {
    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const alreadySent = stepData[`${currentStepChave}_enviado`] === true;
    if (!alreadySent) {
      return { nextQuestion: currentStep.pergunta as string, stepType: "llm_gate", nextStepChave: currentStepChave, campoColetar: null };
    }
    // Sent — clear silence flag and evaluate gates using last outgoing message as context.
    if (stepData._gate_silenciado === true) {
      await saveFlowStepData(deal, { _gate_silenciado: false }, currentStepChave);
    }
    const lastOut = (history ?? []).filter(m => m.direcao === "out").slice(-2).map(m => m.conteudo ?? "").filter(Boolean).join("\n");
    const gateList = currentStep.gates.length > 0
      ? `Gates disponíveis:\n${currentStep.gates.map((g: any) => `  id:"${g.id}" condição:"${g.condicao}"`).join("\n")}\n\nRetorne: { "answered": boolean, "gate_id": "id_do_gate que se aplica ou null", "extracted": {} }`
      : `Retorne: { "answered": boolean, "gate_id": null, "extracted": {} }`;
    const gateInstruction = lastOut
      ? `Última mensagem enviada pela advogada:\n"${lastOut}"\n\n${gateList}`
      : gateList;
    const gateVal = await extractJson<{ answered: boolean; gate_id?: string | null; extracted?: Record<string, string> }>({
      projetoId,
      instruction: gateInstruction,
      text: `Resposta do cliente: "${incomingText}"`,
      maxTokens: 256,
    });
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" (llm_gate) answered=${gateVal?.answered ?? false} gate="${gateVal?.gate_id ?? "none"}"`);
    if (!gateVal?.answered) {
      await saveFlowStepData(deal, { _gate_silenciado: true }, currentStepChave);
      return { nextQuestion: null, stepType: "llm_gate", nextStepChave: currentStepChave };
    }
    if (currentStep.gates.length > 0) {
      const gate = gateVal.gate_id ? currentStep.gates.find((g: any) => g.id === gateVal.gate_id) : null;
      if (gate) return await executeGateAction(deal, steps, currentStep, gate, gateVal.extracted ?? {});
      // gate_id not returned despite answered=true — advance to next step as default continue path.
      // (If lead refused, answered would be false, so this is safe.)
    }
    return await advanceToNextStep(deal, steps, currentStep, gateVal.extracted ?? {}, null);
  }

  // Auto-advance via pre-filled document data: when OCR set _pf_{campo}, accept it directly.
  if (currentStep.campoColetar && !currentStep.gates.length) {
    const pfValue = merged[`_pf_${currentStep.campoColetar}`];
    if (pfValue) {
      const extracted = { [currentStep.campoColetar as string]: String(pfValue) };
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" auto-advance via _pf_ prefill: ${currentStep.campoColetar}="${pfValue}"`);
      return await advanceToNextStep(deal, steps, currentStep, extracted, null);
    }
  }

  // For plain data-collection steps (campoColetar set, no gates): extract and advance.
  // Guard: only advance if the field was actually extracted, OR the lead has already
  // tried 2+ times (deliberate impatience). This prevents silently losing required
  // fields when the lead sends a non-answer like "pode seguir".
  // B1: "sim"/"não" são respostas válidas para perguntas binárias (horas_extras, fgts_ok, etc.)
  // — NÃO incluir no regex de ACKs para não bloquear o path de extração substantiva
  const ACKS_REGEX_FC = /^(ok|certo|beleza|tá|ta|aham|combinado|opa|oi|blz|bom|legal)\.?$/i;
  const isSubstantive = incomingText.replace(/\s/g, "").length >= 4 && !ACKS_REGEX_FC.test(incomingText.trim());
  if (currentStep.campoColetar && !currentStep.gates.length && isSubstantive) {
    // Regex fallback: extract well-known document patterns directly, avoiding LLM call.
    // This is essential when extractJson times out or returns null for unambiguous formats.
    const REGEX_FIELDS: Record<string, RegExp> = {
      cpf:             /\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}/,
      cnpj:            /\d{2}[.\s]?\d{3}[.\s]?\d{3}[\/\s]?\d{4}[-\s]?\d{2}/,
      rg:              /[A-Z0-9]{1,2}[-.\s]?\d{3}[-.\s]?\d{3}[-.\s]?[\dxX]/i,
      data_nascimento: /\b\d{2}[\/\-\.]\d{2}[\/\-\.]\d{4}\b|\b\d{4}[\/\-\.]\d{2}[\/\-\.]\d{2}\b/,
    };
    const campoKey = Object.keys(REGEX_FIELDS).find(k => (currentStep.campoColetar as string).toLowerCase().includes(k));
    const regexMatch = campoKey ? incomingText.match(REGEX_FIELDS[campoKey]) : null;

    let extracted: Record<string, string> | null = null;
    if (regexMatch) {
      extracted = { [currentStep.campoColetar as string]: regexMatch[0].trim() };
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" regex-extracted ${campoKey}="${regexMatch[0].trim()}"`);
    } else {
      extracted = await extractJson<Record<string, string>>({
        projetoId,
        instruction: `Extraia o valor do campo "${currentStep.campoColetar}" da resposta do cliente à pergunta abaixo. Retorne apenas: { "${currentStep.campoColetar}": "valor_extraído" }`,
        text: `Pergunta: "${currentStep.pergunta}"\nResposta: "${incomingText}"`,
        maxTokens: 128,
      });
    }
    // Values that look extracted but are meaningless — treat as "not answered"
    const VALOR_INVALIDO = /^(n[aã]o\s*informado|veja\s*(no|o)\s*documento|sem\s*informa[cç][aã]o|n[aã]o\s*sei|s\/n|s\.n\.|null|undefined|n\/a|n[aã]o\s*dispon[ií]vel|desconhecido)$/i;
    const campoExtraido = extracted != null &&
      Object.values(extracted).some(v => {
        if (v === null || v === undefined || v === "") return false;
        if (VALOR_INVALIDO.test(String(v).trim())) return false;
        return true;
      });
    const stepData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    const tentativasKey = `${currentStepChave}_tentativas`;
    const tentativas = (stepData[tentativasKey] as number) ?? 0;
    if (campoExtraido) {
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" answered=true extracted=${JSON.stringify(extracted)} tentativas=${tentativas}`);
      return await advanceToNextStep(deal, steps, currentStep, extracted!, null);
    }
    if (tentativas >= 2) {
      // Force-advance without saving the (potentially garbage) extracted value
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" force-advance after ${tentativas} tentativas (extracted discarded)`);
      return await advanceToNextStep(deal, steps, currentStep, {}, null);
    }
    const novasTentativas = tentativas + 1;
    await saveFlowStepData(deal, { [tentativasKey]: novasTentativas }, currentStepChave);
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" campo não extraído — tentativa ${novasTentativas}/3`);
    return { nextQuestion: currentStep.pergunta as string, stepType: currentStep.stepType as string, campoColetar: currentStep.campoColetar ?? null };
  }

  // A4: resposta não-substantiva (ACK) em step de coleta sem gates → re-perguntar diretamente,
  // sem chamar extractJson (que pode retornar answered=true para "ok"/"aham" e avançar o step).
  if (currentStep.campoColetar && !currentStep.gates.length) {
    console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" — ACK/não-substantivo, re-perguntando sem LLM`);
    return { nextQuestion: currentStep.pergunta as string, stepType: currentStep.stepType as string, campoColetar: currentStep.campoColetar ?? null };
  }

  // Clear gate-silence flag — lead sent a new message, allow re-evaluation
  if (currentStep.gates.length > 0) {
    const existingData = (deal.iaFlowStepData ?? {}) as Record<string, unknown>;
    if (existingData._gate_silenciado === true) {
      await saveFlowStepData(deal, { _gate_silenciado: false }, currentStepChave);
    }

    // Trivial-always gate: "Lead enviou qualquer mensagem" — advance without LLM to avoid
    // gate evaluation failures (LLM timeout / null response) that leave Daniela stuck.
    const trivialContinue = currentStep.gates.find(
      (g: any) => g.actionType === "continue" && /qualquer mensagem|qualquer resposta/i.test(g.condicao ?? ""),
    );
    if (trivialContinue && incomingText.trim().length >= 1) {
      console.log(`[FlowController] dealId=${deal.id} step="${currentStepChave}" trivial-continue gate fired (no LLM)`);
      return await executeGateAction(deal, steps, currentStep, trivialContinue, {});
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

    case "end_notify":
      await saveFlowStepData(deal, extracted, "__done__");
      return { nextQuestion: gate.actionValue ?? null, nextStepChave: "__done__", firedNotify: "descarte_revisao_humana" };

    case "discard":
      await saveFlowStepData(deal, extracted, "__discarded__");
      return { nextQuestion: gate.actionValue ?? null, nextStepChave: "__discarded__" };

    case "repeat":
      return { nextQuestion: currentStep.pergunta as string };

    case "goto_step": {
      const target = steps.find((s: any) => s.chave === gate.actionValue);
      if (!target) return await advanceToNextStep(deal, steps, currentStep, extracted, null);
      // Clear _enviado flag so llm_generated/llm_gate steps re-generate fresh content on revisit
      const resetExtracted = { ...extracted, [`${target.chave}_enviado`]: false };
      await saveFlowStepData(deal, resetExtracted, target.chave);
      return { nextQuestion: target.pergunta as string, stepType: target.stepType as string, nextStepChave: target.chave as string };
    }

    case "notify": {
      const result = await advanceToNextStep(deal, steps, currentStep, extracted, null);
      return { ...result, firedNotify: gate.actionValue ?? "notify" };
    }

    case "continue":
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

function parseTempoEmAnos(texto: string): number {
  let anos = 0; let meses = 0;
  const anosM = texto.match(/(\d+)\s*anos?/);
  if (anosM) anos = parseInt(anosM[1]);
  const mesesM = texto.match(/(\d+)\s*m[eê]s(?:es)?/);
  if (mesesM) meses = parseInt(mesesM[1]);
  return anos + meses / 12;
}

function isFieldCollected(
  merged: Record<string, unknown>,
  campo: string,
  vinculos?: VinculoEmprego[],
): boolean {
  // Pre-filled from authoritative source (meeting transcription / document OCR)
  const pfValue = merged[`_pf_${campo}`];
  if (typeof pfValue === "string" && pfValue.trim().length > 0) return true;

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
  if (value === false) return false;  // boolean false = "not yet received" (e.g. _cnh_recebida, _comprovante_recebido)
  if (typeof value === "string" && value.trim().length === 0) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (campo === "cpf") return /^\d{11}$/.test(String(value).replace(/\D/g, ""));
  if (campo === "data_nascimento") return /\d{4}-\d{2}-\d{2}/.test(String(value)) || /\d{2}\/\d{2}\/\d{4}/.test(String(value));
  return true;
}

// PERSISTÊNCIA: extracted fields are merged into iaFlowStepData via saveFlowStepData at the end of
// this function. stage-engine.ts merges iaFlowStepData with qualificacao on the next request, so
// the data is always available to getNextDeterministicQuestion even if it arrived via audio/áudio.
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
      // que precisam ser confirmados explicitamente (nunca pular via chat-inferred data).
      // _pf_* (prefill from transcription/OCR) bypasses NUNCA_PULAR — data is authoritative.
      // funcao/empresa: frequently extracted from context (user mentions job in passing) and reused
      // across vinculos_anterior/vinculos_recente phases — always ask explicitly.
      const NUNCA_PULAR = new Set(["estado_civil", "nacionalidade", "nome", "cpf", "rg", "funcao", "empresa"]);
      const isPreFilled = candidate.campoColetar && !!merged[`_pf_${candidate.campoColetar}`];
      if (candidate.campoColetar && (!NUNCA_PULAR.has(candidate.campoColetar) || isPreFilled) && isFieldCollected(merged, candidate.campoColetar, vinculos)) {
        console.log(`[FlowController] Pre-skip step "${candidate.chave}" — campo "${candidate.campoColetar}" já coletado`);
        continue;
      }

      // skipSe: conditional skip. Formats:
      // { "campo": "saida", "contem_qualquer": ["ainda", "lá", "hoje"] }
      // { "tipo": "tempo_mais_de_anos", "campo": "tempo_no_emprego", "anos": 2 }
      if (candidate.skipSe) {
        const skipCond = candidate.skipSe as any;
        if (skipCond.tipo === "tempo_mais_de_anos") {
          const tempoStr = String(merged[skipCond.campo] ?? "").toLowerCase();
          const anos = parseTempoEmAnos(tempoStr);
          if (anos >= (skipCond.anos ?? 2)) {
            console.log(`[FlowController] skipSe step "${candidate.chave}" — ${skipCond.campo} = "${tempoStr}" (${anos.toFixed(1)} anos ≥ ${skipCond.anos ?? 2})`);
            continue;
          }
        } else {
          const campoVal = String(merged[skipCond.campo] ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
          const contem = (skipCond.contem_qualquer as string[]) ?? [];
          const matchSkip = contem.some(v => campoVal.includes(v.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")));
          if (matchSkip) {
            console.log(`[FlowController] skipSe step "${candidate.chave}" — campo "${skipCond.campo}"="${campoVal}" matched`);
            continue;
          }
        }
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

/**
 * Returns the deterministic pergunta and stepType for the given stepChave.
 * Used by respondFromDealState to avoid free LLM generation when flow step is known.
 */
export async function getCurrentStepQuestion(
  projetoId: string,
  stepChave: string,
  personaFase: FlowPersonaFase = { personaChave: "advogado", fase: "advogado" },
): Promise<{ pergunta: string | null; stepType: string | null; campoColetar: string | null }> {
  const steps = await loadSteps(projetoId, personaFase.personaChave, personaFase.fase);
  const step = steps.find((s: any) => s.chave === stepChave);
  return {
    pergunta: (step?.pergunta as string) ?? null,
    stepType: (step?.stepType as string) ?? null,
    campoColetar: (step?.campoColetar as string) ?? null,
  };
}
