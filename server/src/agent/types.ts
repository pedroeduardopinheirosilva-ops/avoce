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
  /** Trecho trabalhado sem carteira quando houve período misto na mesma empresa (tese de
   *  reconhecimento de vínculo). Ex.: "os 5 primeiros meses sem registro". */
  periodo_sem_registro?: string;
  tempo?: string;
  data_saida?: string;
  saida?: string;
  horas_extras?: string;
  pagamento_fora?: string;
  injustica?: string;
  frota?: string;
  /** Salary on payslip (holerite) in BRL */
  salario_holerite?: number | string;
  /** Off-payroll salary portion (Pix, Pamcard, cash) in BRL */
  salario_por_fora?: number | string;
  /** Shift start time, e.g. "05:00" */
  jornada_inicio?: string;
  /** Shift end time, e.g. "22:00" */
  jornada_fim?: string;
  /** Break duration in minutes */
  intervalo_minutos?: number | string;
  /** Estimated employment duration in months (calculated from tempo or data_saida) */
  tempo_meses_estimado?: number;
  /** FGTS depositado? "sim" | "nao" | "parcial" */
  fgts_ok?: string;
  /** CTPS assinada? "assinada" | "nao_assinada" | "parcial" */
  situacao_ctps?: string;
  // ── Campos específicos para motorista carreteiro ──────────────────────────────
  /** Descrição livre da jornada diária, horários e frequência de folgas */
  jornada_descricao?: string;
  /** Base de cálculo de comissão de frete: "bruto" | "liquido" | descrição livre */
  base_calculo_comissao?: string;
  /** Se o holerite mostrava valor diferente do real: "sim" | "nao" | descrição */
  holerite_ficticio?: string;
  /** Pagamento de diárias: "sim" | "nao" | descrição */
  diarias?: string;
  /** Acidente de trabalho ou doença ocupacional: "sim" | "nao" | descrição */
  acidente_trabalho?: string;
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
  nacionalidade?: string | null;
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

// ── IA flags (iaFlags JSONB — keys with leading _) ───────────────────────────

export interface KnownIaFlags {
  _vinculos_ok?: boolean;
  _vinculos_todos_prescritos?: boolean;
  _mais_empregos_confirmado?: boolean;
  /** Set to true after Ana sends the mais_empregos question; used by vinculos gate. */
  _mais_empregos_perguntado?: boolean;
  /** Set to true when lead explicitly denied having more employers (semMaisEmpregos). Stops loop. */
  _mais_empregos_negado?: boolean;
  _saudacao_enviada?: boolean;
  _pos_vinculos_fase?: string;
  _valor_apresentado?: boolean;
  [key: string]: unknown;
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
  forceDescarte?: boolean;
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
