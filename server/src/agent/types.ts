/**
 * Shared domain types — zero imports from this project.
 * All agent modules import from here, never from each other's type re-exports.
 */

// ── Employment links ──────────────────────────────────────────────────────────

export interface VinculoEmprego {
  ordem: number;
  empresa?: string;
  funcao?: string;
  vinculo?: string;
  tempo?: string;
  data_saida?: string;
  saida?: string;
  horas_extras?: string;
  pagamento_fora?: string;
  injustica?: string;
  frota?: string;
}

// ── Document extraction ───────────────────────────────────────────────────────

export type DocJsonResult = {
  tipo_documento: "CNH" | "RG" | "CTPS" | "COMPROVANTE_ENDERECO" | "OUTRO";
  subtipo?: "CNH_E" | "CNH_FOTO" | null;
  nome?: string | null;
  cpf?: string | null;
  rg?: string | null;
  orgao_emissor_rg?: string | null;
  uf_emissor_rg?: string | null;
  data_nascimento?: string | null;
  local_nascimento?: string | null;
  naturalidade?: string | null;
  filiacao_pai?: string | null;
  filiacao_mae?: string | null;
  pis?: string | null;
  numero_ctps?: string | null;
  serie_ctps?: string | null;
  endereco?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
};

// ── Evolution API ─────────────────────────────────────────────────────────────

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instancia: string;
}

// ── LLM router ────────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  projetoId: string;
  dealId?: string;
  systemPrompt: string;
  messages: LlmMessage[];
  personaChave?: string;
  personaLlmChave?: string | null;
  stageChave?: string;
  maxTokens?: number;
}

export interface LlmCallResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  model: string;
  provider: string;
}

export interface ExtractJsonOptions {
  projetoId: string;
  instruction: string;
  text: string;
  maxTokens?: number;
}

export interface ExtractJsonResult<T> {
  data: T | null;
  error: string | null;
}

// ── Vinculos processing ───────────────────────────────────────────────────────

export interface VinculosState {
  vinculos: VinculoEmprego[];
  vinculosOk: boolean;
  todosPrescritosFlag: boolean;
}

// ── Assistente sub-agents ─────────────────────────────────────────────────────

export type AssistentePhase = "inicial" | "vinculos_recente" | "vinculos_anterior" | "resumo";

export type AgentContext = {
  projetoId: string;
  merged: Record<string, unknown>;
  vinculos: VinculoEmprego[];
  vinculosOk: boolean;
  vinculosTodosPrescritos: boolean;
  empresasBloqueadas: string[];
  outgoingCount: number;
};

export type AgentResult = {
  deterministicQuestion: string | null;
  systemInstructions: string;
  allDone: boolean;
  phase: AssistentePhase;
};

// ── Advogado sub-agents ───────────────────────────────────────────────────────

export type AdvogadoPhase = "autoridade" | "coleta";

export type AdvogadoAgentContext = {
  projetoId: string;
  iaFlowStepChave: string | null;
  merged: Record<string, unknown>;
  vinculos: VinculoEmprego[];
};

export type AdvogadoAgentResult = {
  phase: AdvogadoPhase;
  systemInstructions: string;
};

// ── Flow controller ───────────────────────────────────────────────────────────

export type AdvogadoFlowResult = {
  nextQuestion: string | null;
  stepType?: string | null;
  nextStepChave?: string | null;
};

export type AdvogadoFlowDeal = {
  id: string;
  iaFlowStepChave?: string | null;
  iaFlowStepData?: Record<string, unknown> | null;
  qualificacao?: unknown;
};

// ── System prompt builder ─────────────────────────────────────────────────────

export interface PersonaInfo {
  chave: string;
  nomeExibicao: string;
  systemPrompt: string;
}

export interface SystemPromptContext {
  persona: PersonaInfo;
  personaChave: string;
  stageChave: string;
  merged: Record<string, unknown>;
  vinculos: VinculoEmprego[];
  vinculosOk: boolean;
  vinculosTodosPrescritos: boolean;
  documentosEnviados: boolean;
  nextQDeterministico: string | null;
  advFlowStepType: string | null;
  advFlowNextStepChave: string | null;
  frustrationInject: string | null;
  assistenteSystemInstructions: string | null;
  assistenteAllDone: boolean;
  perguntasPendentes: { chave: string; perguntaContexto: string; exemploAbordagem?: string | null }[];
  iaFlowStepChave: string | null;
  handoffSnapshot: string | null;
  advogadoSystemInstructions: string | null;
}
