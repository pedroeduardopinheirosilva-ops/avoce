import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type SystemPromptContext } from "./system-prompt-builder.js";

function minimalCtx(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
  return {
    personaChave: "assistente",
    personaNome: "Ana",
    personaInstrucoes: "INSTRUÇÃO-AGENTE",
    personaFase: "qualificacao",
    instrucaoComportamento: "Você é {nome_persona}. {INSTRUÇÃO BASE}",
    instrucaoBase: "DATA E HORA ATUAL: agora",
    perguntasDeterministicas: [],
    camposBloqueados: [],
    merged: {},
    vinculos: [],
    vinculosOk: false,
    vinculosTodosPrescritos: false,
    iaFlowStepChave: null,
    iaFlowStepData: {},
    outgoingCount: 0,
    nomeCliente: null,
    cidadeCliente: null,
    ...overrides,
  };
}

describe("buildSystemPrompt", () => {
  it("returns a non-empty string for a minimal valid ctx", () => {
    const result = buildSystemPrompt(minimalCtx());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("contains personaNome in identity rule", () => {
    const result = buildSystemPrompt(minimalCtx({ personaNome: "Ana" }));
    expect(result).toContain("Você é Ana");
  });

  it("advogado with iaFlowStepChave → string contains personaInstrucoes", () => {
    const ctx = minimalCtx({
      personaChave: "advogado",
      personaNome: "Dra. Daniela Pires",
      iaFlowStepChave: "dados_pessoais",
      personaInstrucoes: "STEP_DADOS_PESSOAIS_INSTRUCAO",
    });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("STEP_DADOS_PESSOAIS_INSTRUCAO");
  });

  it("assistente personaInstrucoes injected in middle section", () => {
    const ctx = minimalCtx({ personaInstrucoes: "ANA_AGENT_INSTRUCAO" });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("ANA_AGENT_INSTRUCAO");
  });

  it("handoffSnapshot prepended for advogado", () => {
    const ctx = minimalCtx({
      personaChave: "advogado",
      personaNome: "Dra. Daniela Pires",
      handoffSnapshot: "HANDOFF_PREFIX",
      personaInstrucoes: "adv",
    });
    const result = buildSystemPrompt(ctx);
    expect(result.startsWith("HANDOFF_PREFIX")).toBe(true);
  });

  it("does not throw when all optional fields are absent", () => {
    expect(() => buildSystemPrompt(minimalCtx())).not.toThrow();
  });

  it("includes CPF confirmation when cpf in merged is valid", () => {
    const ctx = minimalCtx({ merged: { cpf: "529.982.247-25" } });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("CPF CONFIRMADO");
    expect(result).toContain("529.982.247-25");
  });

  it("does NOT include CPF confirmation for invalid CPF", () => {
    const ctx = minimalCtx({ merged: { cpf: "111.111.111-11" } });
    const result = buildSystemPrompt(ctx);
    expect(result).not.toContain("CPF CONFIRMADO");
  });

  it("includes prescrição warning when vinculosTodosPrescritos", () => {
    const ctx = minimalCtx({ vinculosTodosPrescritos: true });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("PRAZO PRESCRICIONAL VENCIDO");
  });

  it("injects frustrationInjection when provided", () => {
    const ctx = minimalCtx({ frustrationInjection: "FRUSTRATION_TEXT" });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("FRUSTRATION_TEXT");
  });

  it("includes nextQDeterministico for non-llm_generated step", () => {
    const ctx = minimalCtx({ nextQDeterministico: "Qual é o seu CPF?" });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("Qual é o seu CPF?");
    expect(result).toContain("PRÓXIMA PERGUNTA OBRIGATÓRIA");
  });

  it("handles llm_generated step with valueInjection", () => {
    const ctx = minimalCtx({
      nextQDeterministico: "Apresente o valor estimado.",
      advFlowStepType: "llm_generated",
      valueInjection: "VALOR_CALC_TEXTO",
    });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("TAREFA OBRIGATÓRIA");
    expect(result).toContain("VALOR_CALC_TEXTO");
  });

  it("includes pending questions and skips them when vinculosTodosPrescritos", () => {
    const withQ = buildSystemPrompt(minimalCtx({ perguntasDeterministicas: ["- Qual empresa?"] }));
    expect(withQ).toContain("INFORMAÇÕES AINDA NÃO COLETADAS");

    const prescribed = buildSystemPrompt(minimalCtx({
      perguntasDeterministicas: ["- Qual empresa?"],
      vinculosTodosPrescritos: true,
    }));
    expect(prescribed).not.toContain("INFORMAÇÕES AINDA NÃO COLETADAS");
  });

  // FIX 2B — skip instruction when campo already collected
  it("step com campoColetar já em merged → instrução 'já coletado', NÃO OBRIGATÓRIA", () => {
    const ctx = minimalCtx({
      personaChave: "advogado",
      personaNome: "Dra. Daniela Pires",
      personaInstrucoes: "",
      nextQDeterministico: "Qual o salário?",
      advFlowNextStepChave: "comp_salario",
      advFlowCampoColetar: "salario_total_declarado",
      merged: { salario_total_declarado: 10000 },
    });
    const result = buildSystemPrompt(ctx);
    expect(result).not.toContain("PRÓXIMA PERGUNTA OBRIGATÓRIA");
    expect(result).toContain("já foi coletado");
    expect(result).toContain("10000");
  });

  it("step com campoColetar ausente no merged → instrução OBRIGATÓRIA", () => {
    const ctx = minimalCtx({
      personaChave: "advogado",
      personaNome: "Dra. Daniela Pires",
      personaInstrucoes: "",
      nextQDeterministico: "Qual o salário?",
      advFlowNextStepChave: "comp_salario",
      advFlowCampoColetar: "salario_total_declarado",
      merged: {},
    });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("PRÓXIMA PERGUNTA OBRIGATÓRIA");
  });

  it("step de documento (solicitar_cnh) com cpf no merged → mantém instrução OBRIGATÓRIA", () => {
    const ctx = minimalCtx({
      personaChave: "advogado",
      personaNome: "Dra. Daniela Pires",
      personaInstrucoes: "",
      nextQDeterministico: "Envie sua CNH",
      advFlowNextStepChave: "solicitar_cnh",
      advFlowCampoColetar: "cpf",
      merged: { cpf: "12345678901" },
    });
    const result = buildSystemPrompt(ctx);
    expect(result).toContain("PRÓXIMA PERGUNTA OBRIGATÓRIA");
  });
});
