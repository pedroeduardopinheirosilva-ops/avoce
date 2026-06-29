/**
 * Conversacional mode dispatch — extracted from stage-engine for testability.
 * Applies the conversational router override when modo_coleta = "conversacional".
 */

import { prisma } from "../db.js";
import type { VinculoEmprego } from "./types.js";

// ── Mode config cache (60s TTL per projetoId) ─────────────────────────────────

const _modoColetaCache = new Map<string, { valor: string; expiresAt: number }>();

export async function getModoColeta(projetoId: string): Promise<string> {
  const cached = _modoColetaCache.get(projetoId);
  if (cached && Date.now() < cached.expiresAt) return cached.valor;
  const cfg = await prisma.iaProjetoConfig
    .findFirst({ where: { projetoId, chave: "modo_coleta" } })
    .catch(() => null);
  // valid: "sequencial" | "conversacional" (outros valores fazem fallback silencioso para "sequencial")
  const raw = cfg?.valor ?? "sequencial";
  const valor = raw === "conversacional" ? "conversacional" : "sequencial";
  _modoColetaCache.set(projetoId, { valor, expiresAt: Date.now() + 60_000 });
  return valor;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export type MiniAgentResult = {
  systemInstructions: string;
  allDone: boolean;
  deterministicQuestion: string | null;
  phase: string;
};

export async function applyConversacionalMode(opts: {
  modoColeta: string;
  personaChave: string;
  agentResult: MiniAgentResult;
  currentNextQ: string | null;
  convParams: {
    projetoId: string;
    merged: Record<string, unknown>;
    vinculos: VinculoEmprego[];
    vinculosOk: boolean;
    vinculosTodosPrescritos: boolean;
    empresasBloqueadas: string[];
    outgoingCount: number;
  };
}): Promise<{ agentResult: MiniAgentResult; nextQDeterministico: string | null }> {
  // Modo conversacional desativado — sempre sequencial/determinístico.
  return { agentResult: opts.agentResult, nextQDeterministico: opts.currentNextQ };
}

export function invalidateModoColetaCache(projetoId: string) {
  _modoColetaCache.delete(projetoId);
}
