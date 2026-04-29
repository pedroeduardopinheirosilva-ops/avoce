/**
 * Assistente Agents — 4 sub-agents focused for Ana's qualification flow.
 *
 * Each agent handles ONE phase with a narrow, focused system prompt.
 * Phase transitions are determined by code (state), not by the LLM.
 *
 * Flow:
 *   "inicial"           → greeting + nome + cidade
 *   "vinculos_recente"  → employment details for the most recent employer (vinculos[0])
 *   "vinculos_anterior" → employment details for previous employers (vinculos[1+])
 *   "resumo"            → pos-vinculos questions + hand off to Daniela
 */

import type { VinculoEmprego, AssistentePhase, AgentContext, AgentResult } from "./types.js";
import { getNextDeterministicQuestion } from "./persona-router.js";

// Re-export for backward compat — callers should migrate to types.ts
export type { AssistentePhase, AgentContext, AgentResult };

// ── Required fields per vínculo ────────────────────────────────────────────────

const CAMPOS_REQ: Array<keyof VinculoEmprego> = [
  "empresa", "funcao", "vinculo", "saida", "tempo",
  "horas_extras", "pagamento_fora", "injustica",
];

function isVinculoComplete(v: VinculoEmprego): boolean {
  return CAMPOS_REQ.every(k => {
    const val = v[k];
    return val !== undefined && val !== null && val !== "";
  });
}

// ── Phase detection (pure, based on state) ────────────────────────────────────

export function detectPhase(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
): AssistentePhase {
  // Phase 4: all vinculos collected and confirmed
  if (vinculosOk) return "resumo";

  // Phase 3: collecting a previous employer
  if (merged._mais_empregos_confirmado === true) return "vinculos_anterior";
  if (vinculos.some(v => v.ordem > 1)) return "vinculos_anterior";

  // Phase 2: collecting the most recent employer (may be ongoing)
  if (vinculos.length > 0) return "vinculos_recente";

  // Phase 1: no vinculos started yet (greeting, nome, cidade)
  return "inicial";
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runAssistenteAgent(ctx: AgentContext): Promise<AgentResult> {
  const phase = detectPhase(ctx.merged, ctx.vinculos, ctx.vinculosOk);

  const nextQ = await getNextDeterministicQuestion(
    ctx.projetoId,
    ctx.merged,
    ctx.vinculos,
    ctx.vinculosOk,
    ctx.vinculosTodosPrescritos,
    ctx.empresasBloqueadas,
    ctx.outgoingCount,
  );

  // All phases complete → signal transition to Daniela
  if (!nextQ && ctx.merged._vinculos_ok === true) {
    return {
      deterministicQuestion: null,
      systemInstructions: buildResumoEncerramento(ctx.vinculos),
      allDone: true,
      phase: "resumo",
    };
  }

  return {
    deterministicQuestion: nextQ,
    systemInstructions: buildPhaseInstructions(phase, ctx.merged, ctx.vinculos),
    allDone: false,
    phase,
  };
}

// ── Per-phase system instructions ─────────────────────────────────────────────

function buildPhaseInstructions(
  phase: AssistentePhase,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
): string {
  switch (phase) {
    case "inicial":           return buildInicialInstructions(merged);
    case "vinculos_recente":  return buildVinculosRecenteInstructions(merged, vinculos);
    case "vinculos_anterior": return buildVinculosAnteriorInstructions(merged, vinculos);
    case "resumo":            return buildResumoInstructions(merged, vinculos);
  }
}

// ── Agente Inicial ─────────────────────────────────────────────────────────────

function buildInicialInstructions(merged: Record<string, unknown>): string {
  const nomeOk = typeof merged.nome === "string" && merged.nome.trim().length > 1;
  const cidadeOk = Boolean(merged.cidade);

  if (!nomeOk && !cidadeOk) {
    return [
      `AGENTE INICIAL — OBJETIVO ÚNICO: Coletar o nome e a cidade do cliente em UMA pergunta natural.`,
      `Não mencione emprego, direitos trabalhistas, advogados ou qualquer outro assunto ainda.`,
      `Exemplo: "Qual é o seu nome e de onde você é?"`,
    ].join("\n");
  }

  if (!nomeOk) {
    return `AGENTE INICIAL — Pergunte APENAS o nome do cliente. Nada mais ainda.`;
  }

  if (!cidadeOk) {
    return `AGENTE INICIAL — Pergunte APENAS a cidade do cliente. Nada mais ainda.`;
  }

  return [
    `AGENTE INICIAL — Dados básicos coletados (nome: ${merged.nome}, cidade: ${merged.cidade}).`,
    `Siga o fluxo e pergunte o que está pendente abaixo.`,
  ].join("\n");
}

// ── Agente Emprego Recente ─────────────────────────────────────────────────────

function buildVinculosRecenteInstructions(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
): string {
  const v0 = vinculos.find(v => v.ordem === 1);
  const empresa = v0?.empresa ?? null;
  const faltando = v0
    ? CAMPOS_REQ.filter(k => !v0[k]).map(k => String(k)).join(", ")
    : "todos os campos";

  return [
    `AGENTE EMPREGO RECENTE — Você está coletando dados do emprego MAIS RECENTE do carreteiro.`,
    empresa
      ? `Empresa: ${empresa}. Campos ainda faltando: ${faltando || "nenhum — confirme se há mais empregos"}.`
      : `Ainda não sabemos a empresa. Pergunte em qual empresa o carreteiro trabalha ou trabalhou mais recentemente.`,
    `REGRA CRÍTICA: O cliente PODE ainda estar empregado nessa empresa. Pergunte "você ainda está lá ou já saiu?" — NUNCA assuma que já saiu.`,
    `Colete um campo de cada vez. NÃO mencione a Dra. Daniela ainda — isso acontece só no final.`,
    `NÃO repita perguntas que o cliente claramente já respondeu nesta conversa.`,
  ].join("\n");
}

// ── Agente Emprego Anterior ────────────────────────────────────────────────────

function buildVinculosAnteriorInstructions(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
): string {
  const anteriores = vinculos.filter(v => v.ordem > 1).sort((a, b) => b.ordem - a.ordem);
  const alvo = anteriores[0];
  const empresa = alvo?.empresa ?? null;
  const faltando = alvo
    ? CAMPOS_REQ.filter(k => !alvo[k]).map(k => String(k)).join(", ")
    : "todos os campos";

  return [
    `AGENTE EMPREGO ANTERIOR — Você está coletando dados de um emprego ANTERIOR (não o mais recente).`,
    empresa
      ? `Empresa anterior: ${empresa}. Campos faltando: ${faltando || "nenhum — confirme se há mais empregos"}.`
      : `O cliente confirmou que trabalhou em outra empresa. Pergunte qual foi essa empresa anterior.`,
    `REGRA ABSOLUTA: A pessoa JÁ SAIU dessa empresa. NUNCA pergunte "ainda está trabalhando lá?".`,
    `Sempre use o passado: "Como foi o desligamento na [empresa]?" / "Quando foi isso?".`,
    `NÃO mencione a Dra. Daniela ainda.`,
  ].join("\n");
}

// ── Agente Resumo ──────────────────────────────────────────────────────────────

function buildResumoInstructions(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
): string {
  const empresas = vinculos.map(v => v.empresa ?? "?").join(", ");

  return [
    `AGENTE RESUMO — Vínculos completos (${vinculos.length} empresa(s): ${empresas}).`,
    `Agora: responda a pergunta pendente do fluxo (ver abaixo) de forma natural.`,
    `NÃO pergunte mais sobre empregos — essa fase já encerrou.`,
    `Quando não houver mais perguntas, encerre brevemente e passe para a Dra. Daniela (máx 2 frases).`,
  ].join("\n");
}

function buildResumoEncerramento(vinculos: VinculoEmprego[]): string {
  const empresas = vinculos.map(v => v.empresa ?? "?").join(", ");

  return [
    `FASE DE ENCERRAMENTO — Todos os dados foram coletados (${empresas}).`,
    `Sua resposta DEVE:`,
    `1. Agradecer brevemente pelo tempo do cliente`,
    `2. Informar que a Dra. Daniela Pires vai entrar em contato agora mesmo para dar o parecer jurídico`,
    `MÁXIMO 2 frases. NÃO prometa ligação. NÃO peça horário. NÃO colete mais dados.`,
    `Exemplo: "Registrei tudo certinho. A Dra. Daniela Pires vai te chamar agora mesmo com o parecer do seu caso."`,
  ].join("\n");
}
