/**
 * Triagem Router — LiderHub-style triage routing for "Carreteiro 3.0" campaigns.
 *
 * When modo_sdr === "triagem":
 *   - Lead enters at stage "lead_triagem" and goes through 3 branching questions
 *   - Based on answers, routes to one of 3 qualification paths:
 *       lead_rescisao_indireta  → still employed, looking for indirect dismissal grounds
 *       lead_direito_suprimido  → had CLT, already left, investigating violations
 *       lead_reconhecimento_vinculo → worked informally, establishing employment bond
 *   - Disqualifies immediately when: saiu há +2 anos or trabalhou < 2 meses
 *   - After qualification path completes → lead_qualificado (advogado takes over)
 */

import { prisma } from "../db.js";
import { advanceAdvogadoFlow, type FlowPersonaFase } from "./flow-controller.js";
import type { AdvogadoFlowResult } from "./flow-controller.js";

// ── Stage → fase mapping ───────────────────────────────────────────────────────

const STAGE_TO_FASE: Record<string, string> = {
  lead_triagem:                "triagem",
  lead_rescisao_indireta:      "rescisao_indireta",
  lead_direito_suprimido:      "direito_suprimido",
  lead_reconhecimento_vinculo: "reconhecimento_vinculo",
};

export function getTriagemFaseForStage(stageChave: string): string | null {
  return STAGE_TO_FASE[stageChave] ?? null;
}

// ── Routing decisions after each phase ────────────────────────────────────────

export type TriagemRoute =
  | { action: "next_question"; question: string; stepChave: string | null }
  | { action: "transition"; toStage: string; motivo: string }
  | { action: "done" };                // advogado takes over (qualificado)

/**
 * After a triagem-phase flow step completes (nextQuestion === null / __done__),
 * determines the next stage based on collected data.
 */
export function resolvePostPhaseRoute(
  stageChave: string,
  merged: Record<string, unknown>,
): { toStage: string; motivo: string } | null {

  if (stageChave === "lead_triagem") {
    const aindeNaEmpresa = asBool(merged.ainda_na_empresa);
    const tempoMuitoCurto = asBool(merged.tempo_muito_curto);      // < 60 dias
    const prescrito = asBool(merged.prescrito);                     // > 730 dias
    const tinhaClt = asBool(merged.tinha_clt);
    // tipo_motorista_valido: false quando o lead NÃO é carreteiro/caminhoneiro/ônibus/van/carga
    // (ex: motorista de Uber, mototaxi, táxi digital). Configurado via gate no step de triagem.
    // Usa e_carreteiro como fallback pois tipo_motorista_valido pode não ser extraído pelo gate do DB (BUG-006)
    const tipoMotoristaValido = asBool(merged.tipo_motorista_valido) ?? asBool(merged.e_carreteiro);

    if (tipoMotoristaValido === false)  return { toStage: "lead_desqualificado",    motivo: "tipo_motorista_invalido" };
    if (aindeNaEmpresa === true)        return { toStage: "lead_rescisao_indireta", motivo: "ainda_na_empresa" };
    if (prescrito === true)             return { toStage: "lead_desqualificado",    motivo: "prescricao_2_anos" };
    if (tempoMuitoCurto === true)       return { toStage: "lead_desqualificado",    motivo: "menos_2_meses" };
    if (tinhaClt === true)              return { toStage: "lead_direito_suprimido", motivo: "tinha_clt" };
    if (tinhaClt === false)             return { toStage: "lead_reconhecimento_vinculo", motivo: "sem_clt" };
    return null; // triagem not complete yet
  }

  if (stageChave === "lead_rescisao_indireta") {
    if (asBool(merged.caso_viavel)   === true)  return { toStage: "lead_qualificado",    motivo: "caso_viavel" };
    if (asBool(merged.caso_inviavel) === true)  return { toStage: "lead_desqualificado", motivo: "caso_inviavel" };
    // Derive viability from collected phase fields
    const violations = ([
      merged.ri_salario_atrasado, merged.ri_pressao_humilhacao, merged.ri_desvio_funcao,
      merged.ri_insalubridade, merged.ri_horas_extras, merged.ri_beneficios_cortados,
    ] as unknown[]).filter(v => asBool(v) === true);
    if (violations.length > 0) return { toStage: "lead_qualificado",    motivo: "ri_violacao_encontrada" };
    const tudo = [
      merged.ri_salario_atrasado, merged.ri_pressao_humilhacao, merged.ri_desvio_funcao,
      merged.ri_insalubridade, merged.ri_horas_extras, merged.ri_ferias, merged.ri_beneficios_cortados,
    ];
    if (tudo.every(v => v !== undefined && v !== null)) return { toStage: "lead_desqualificado", motivo: "ri_sem_violacao" };
    return null;
  }

  if (stageChave === "lead_direito_suprimido") {
    if (asBool(merged.caso_viavel)   === true)  return { toStage: "lead_qualificado",    motivo: "caso_viavel" };
    if (asBool(merged.caso_inviavel) === true)  return { toStage: "lead_desqualificado", motivo: "caso_inviavel" };
    const violations = ([
      merged.ds_coacao, merged.ds_salario_por_fora, merged.ds_horas_extras, merged.ds_assedio,
      merged.ds_acidente, merged.ds_desvio_funcao, merged.ds_descontos_indevidos,
    ] as unknown[]).filter(v => asBool(v) === true);
    // verbas_rescisorias: false = NOT received correctly = violation
    if (violations.length > 0 || asBool(merged.ds_verbas_rescisorias) === false || asBool(merged.ds_adicionais) === false) {
      return { toStage: "lead_qualificado", motivo: "ds_violacao_encontrada" };
    }
    const tudo = [
      merged.ds_coacao, merged.ds_salario_por_fora, merged.ds_horas_extras, merged.ds_assedio,
      merged.ds_acidente, merged.ds_verbas_rescisorias, merged.ds_desvio_funcao, merged.ds_descontos_indevidos, merged.ds_adicionais,
    ];
    if (tudo.every(v => v !== undefined && v !== null)) return { toStage: "lead_desqualificado", motivo: "ds_sem_violacao" };
    return null;
  }

  if (stageChave === "lead_reconhecimento_vinculo") {
    if (asBool(merged.caso_viavel)   === true)  return { toStage: "lead_qualificado",    motivo: "caso_viavel" };
    if (asBool(merged.caso_inviavel) === true)  return { toStage: "lead_desqualificado", motivo: "caso_inviavel" };
    // 4 elements: habitualidade + subordinação + pessoalidade + onerosidade
    const habitualidade  = asBool(merged.rv_frequencia_trabalho);
    const subordinacao   = asBool(merged.rv_recebia_ordens);
    // rv_substituto=false → NÃO tinha substituto → pessoalidade PRESENTE → true (BUG-007)
    // rv_substituto=true  → TINHA substituto → pessoalidade AUSENTE → false
    // rv_substituto=null  → não respondido → null (aguardar)
    const rv_sub = asBool(merged.rv_substituto);
    const pessoalidade = rv_sub === false ? true : rv_sub === true ? false : null;
    const onerosidade    = merged.rv_forma_pagamento != null ? true : null;
    // Verificar completude ANTES de qualificar — evita pular rv_substituto (BUG-037)
    const tudo = [merged.rv_frequencia_trabalho, merged.rv_recebia_ordens, merged.rv_substituto, merged.rv_forma_pagamento];
    const todoRespondido = tudo.every(v => v !== undefined && v !== null);
    const elementos = [habitualidade, subordinacao, pessoalidade, onerosidade].filter(v => v === true).length;
    // Só qualificar/desqualificar quando todos os campos foram respondidos
    if (todoRespondido && elementos >= 3) return { toStage: "lead_qualificado",    motivo: "rv_elementos_presentes" };
    if (todoRespondido && elementos < 3)  return { toStage: "lead_desqualificado", motivo: "rv_elementos_insuficientes" };
    return null; // aguardar respostas restantes
  }

  return null;
}

function asBool(v: unknown): boolean | null {
  if (v === true || v === "true" || v === "sim" || v === "s" || v === 1) return true;
  if (v === false || v === "false" || v === "nao" || v === "não" || v === "n" || v === 0) return false;
  return null;
}

// ── Main dispatch ──────────────────────────────────────────────────────────────

export type TriagemFlowResult = {
  nextQuestion: string | null;
  stepType: string | null;
  nextStepChave: string | null;
  campoColetar: string | null;
  postPhaseRoute: { toStage: string; motivo: string } | null;
};

export async function runTriagemFlow(
  projetoId: string,
  deal: {
    id: string;
    iaStageChave?: string | null;
    iaFlowStepChave?: string | null;
    iaFlowStepData?: Record<string, unknown> | null;
    qualificacao?: unknown;
  },
  incomingText: string,
  outgoingCount: number,
  history: Array<{ direcao: string; conteudo?: string | null; enviadaEm?: Date }>,
  merged: Record<string, unknown>,
): Promise<TriagemFlowResult> {
  const stageChave = deal.iaStageChave ?? "lead_triagem";
  const fase = getTriagemFaseForStage(stageChave);

  if (!fase) {
    return { nextQuestion: null, stepType: null, nextStepChave: null, campoColetar: null, postPhaseRoute: null };
  }

  const personaFase: FlowPersonaFase = { personaChave: "assistente", fase };
  const flowResult: AdvogadoFlowResult = await advanceAdvogadoFlow(
    projetoId,
    { id: deal.id, iaFlowStepChave: deal.iaFlowStepChave ?? null, iaFlowStepData: deal.iaFlowStepData ?? null, qualificacao: deal.qualificacao },
    incomingText,
    outgoingCount,
    history,
    personaFase,
  );

  const isDone = flowResult.nextStepChave === "__done__" || flowResult.nextQuestion === null;

  let postPhaseRoute: { toStage: string; motivo: string } | null = null;
  if (isDone) {
    postPhaseRoute = resolvePostPhaseRoute(stageChave, merged);
    // If routing is indeterminate (e.g. triagem fields not yet collected), keep asking
    if (!postPhaseRoute && stageChave === "lead_triagem") {
      postPhaseRoute = null; // will keep flow going with LLM prompt
    }
  }

  return {
    nextQuestion: flowResult.nextQuestion,
    stepType: flowResult.stepType ?? null,
    nextStepChave: flowResult.nextStepChave ?? null,
    campoColetar: flowResult.campoColetar ?? null,
    postPhaseRoute,
  };
}
