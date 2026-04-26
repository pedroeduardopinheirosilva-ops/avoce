import { describe, it, expect } from "vitest";
import { assertSendable, PromptLeakError, type SendableContext } from "../../src/agent/output-guard.js";

const persona = { chave: "advogado", nomeExibicao: "Dra. Daniela Pires" };
const dealId = "deal-test-123";

function makeCtx(text: string, currentStep?: SendableContext["currentStep"]): SendableContext {
  return { text, currentStep: currentStep ?? null, persona, dealId };
}

// ──────────────────────────────────────────────────────────────────────────────
// Casos de prompt leak detectado
// ──────────────────────────────────────────────────────────────────────────────

describe("output-guard — prompt leak detection", () => {
  it("bloqueia verbo imperativo 'Gere' no início", () => {
    expect(() => assertSendable(makeCtx("Gere um parecer jurídico personalizado com base nos dados coletados."))).toThrow(PromptLeakError);
  });

  it("bloqueia verbo imperativo 'Analise' no início", () => {
    expect(() => assertSendable(makeCtx("Analise os vínculos trabalhistas do cliente."))).toThrow(PromptLeakError);
  });

  it("bloqueia verbo imperativo 'Elabore' no início", () => {
    expect(() => assertSendable(makeCtx("Elabore uma resposta personalizada para o cliente."))).toThrow(PromptLeakError);
  });

  it("bloqueia meta-instrução 'com base nos dados coletados'", () => {
    expect(() => assertSendable(makeCtx("Escreva um texto com base nos dados coletados pela Ana."))).toThrow(PromptLeakError);
  });

  it("bloqueia meta-instrução 'de forma personalizada'", () => {
    expect(() => assertSendable(makeCtx("Responda de forma personalizada ao cliente."))).toThrow(PromptLeakError);
  });

  it("bloqueia placeholder não substituído {nome}", () => {
    expect(() => assertSendable(makeCtx("Olá {nome}, como posso ajudá-lo?"))).toThrow(PromptLeakError);
  });

  it("bloqueia placeholder {empresa_recente}", () => {
    expect(() => assertSendable(makeCtx("Você trabalhou na {empresa_recente} por quanto tempo?"))).toThrow(PromptLeakError);
  });

  it("bloqueia placeholder {cargo}", () => {
    expect(() => assertSendable(makeCtx("Sua função era {cargo}, correto?"))).toThrow(PromptLeakError);
  });

  it("bloqueia role marker 'system:'", () => {
    expect(() => assertSendable(makeCtx("system: Você deve agir como advogado."))).toThrow(PromptLeakError);
  });

  it("bloqueia role marker 'assistant:'", () => {
    expect(() => assertSendable(makeCtx("assistant: Olá, sou a Dra. Daniela."))).toThrow(PromptLeakError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Eco de step llm_generated
// ──────────────────────────────────────────────────────────────────────────────

describe("output-guard — eco de step llm_generated", () => {
  const stepLlmGenerated = {
    stepType: "llm_generated",
    chave: "parecer",
    pergunta: "Gere um parecer jurídico personalizado baseado nos vínculos trabalhistas coletados. Cite as irregularidades relatadas. Fundamente brevemente com a legislação aplicável. Máximo 5 frases.",
  };

  it("bloqueia quando resposta repete ≥60% dos tokens do step", () => {
    const textoEco = "Gere um parecer jurídico personalizado baseado nos vínculos trabalhistas coletados citando as irregularidades.";
    expect(() => assertSendable(makeCtx(textoEco, stepLlmGenerated))).toThrow(PromptLeakError);
  });

  it("bloqueia quando copia instrução quase literal", () => {
    const textoEco = "Gere um parecer jurídico personalizado baseado nos vínculos trabalhistas coletados. Cite as irregularidades relatadas. Fundamente brevemente com a legislação.";
    expect(() => assertSendable(makeCtx(textoEco, stepLlmGenerated))).toThrow(PromptLeakError);
  });

  it("não bloqueia resposta natural com sobreposição baixa", () => {
    const ctx = makeCtx(
      "Com base no que você me contou, identifico que você trabalhou por mais de 3 anos sem receber horas extras. Isso configura crédito trabalhista significativo.",
      stepLlmGenerated
    );
    expect(() => assertSendable(ctx)).not.toThrow();
  });

  it("não bloqueia step question (sobreposição não é calculada)", () => {
    const stepQuestion = { stepType: "question", chave: "cpf", pergunta: "Qual é o seu CPF?" };
    const ctx = makeCtx("Qual é o seu CPF?", stepQuestion);
    // question steps não calculam sobreposição — eco permitido para perguntas determinísticas
    expect(() => assertSendable(ctx)).not.toThrow();
  });

  it("bloqueia eco alto independente de letra maiúscula/acento", () => {
    const textoEco = "gere um parecer juridico personalizado baseado nos vinculos trabalhistas coletados";
    expect(() => assertSendable(makeCtx(textoEco, stepLlmGenerated))).toThrow(PromptLeakError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Placeholders
// ──────────────────────────────────────────────────────────────────────────────

describe("output-guard — placeholders", () => {
  it("bloqueia {nome_persona}", () => {
    expect(() => assertSendable(makeCtx("Olá, eu sou {nome_persona}."))).toThrow(PromptLeakError);
  });

  it("bloqueia {escritorio_nome}", () => {
    expect(() => assertSendable(makeCtx("Sou do escritório {escritorio_nome}."))).toThrow(PromptLeakError);
  });

  it("bloqueia {vinculo_tipo}", () => {
    expect(() => assertSendable(makeCtx("Seu vínculo era {vinculo_tipo}, certo?"))).toThrow(PromptLeakError);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Quebra de personagem
// ──────────────────────────────────────────────────────────────────────────────

describe("output-guard — quebra de personagem", () => {
  it("bloqueia 'Como uma IA, não posso...'", () => {
    expect(() => assertSendable(makeCtx("Como uma IA, não posso fornecer aconselhamento jurídico."))).toThrow(PromptLeakError);
  });

  it("bloqueia 'Não posso gerar esse tipo de conteúdo'", () => {
    expect(() => assertSendable(makeCtx("Não posso gerar esse tipo de conteúdo."))).toThrow(PromptLeakError);
  });

  it("não bloqueia resposta normal da persona", () => {
    const ctx = makeCtx("Com base no que você me contou, vejo que há uma causa trabalhista viável. Vou precisar dos seus dados pessoais.");
    expect(() => assertSendable(ctx)).not.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Sanidade
// ──────────────────────────────────────────────────────────────────────────────

describe("output-guard — sanidade básica", () => {
  it("bloqueia texto vazio", () => {
    expect(() => assertSendable(makeCtx("   "))).toThrow(PromptLeakError);
  });

  it("bloqueia texto longo demais", () => {
    expect(() => assertSendable(makeCtx("a".repeat(4001)))).toThrow(PromptLeakError);
  });

  it("permite texto normal", () => {
    expect(() => assertSendable(makeCtx("Claro! Me conta o nome da empresa onde você trabalhava."))).not.toThrow();
  });
});
