import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    iaFlowStep: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    crmDeal: {
      update: vi.fn(),
    },
  },
}));

vi.mock("./llm.js", () => ({
  extractJson: vi.fn(),
}));

vi.mock("./deal-repository.js", () => ({
  saveFlowStepData: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "../db.js";
import { getNextPreVinculosQuestion, getGreetingStep, advanceAdvogadoFlow, handleAdvogadoFlow } from "./flow-controller.js";
import { extractJson } from "./llm.js";
import { saveFlowStepData } from "./deal-repository.js";

const mockFindMany = prisma.iaFlowStep.findMany as ReturnType<typeof vi.fn>;
const mockDealUpdate = prisma.crmDeal.update as ReturnType<typeof vi.fn>;
const mockExtractJson = extractJson as ReturnType<typeof vi.fn>;
const mockSaveFlowStep = saveFlowStepData as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
  mockDealUpdate.mockResolvedValue({});
});

describe("getGreetingStep", () => {
  it("returns null when no steps configured", async () => {
    const result = await getGreetingStep("proj-1");
    expect(result).toBeNull();
  });

  it("returns pergunta of the greeting step", async () => {
    mockFindMany.mockResolvedValue([{ stepType: "saudacao", pergunta: "Olá! Como posso ajudar?" }]);
    const result = await getGreetingStep("proj-greet-" + Date.now());
    expect(result).toBe("Olá! Como posso ajudar?");
  });
});

describe("getNextPreVinculosQuestion", () => {
  it("returns undefined when no steps configured", async () => {
    const result = await getNextPreVinculosQuestion("proj-1", {});
    expect(result).toBeUndefined();
  });

  it("returns null when all fields collected", async () => {
    const pid = "proj-complete-" + Date.now();
    mockFindMany.mockResolvedValue([
      { stepType: "question", campoColetar: "nome", pergunta: "Qual seu nome?" },
      { stepType: "question", campoColetar: "cidade", pergunta: "Qual sua cidade?" },
    ]);
    const result = await getNextPreVinculosQuestion(pid, { nome: "João", cidade: "Salvador" });
    expect(result).toBeNull();
  });

  it("returns question for first uncollected field", async () => {
    const pid = "proj-next-" + Date.now();
    mockFindMany.mockResolvedValue([
      { stepType: "question", campoColetar: "nome", pergunta: "Qual seu nome?" },
      { stepType: "question", campoColetar: "cidade", pergunta: "Qual sua cidade?" },
    ]);
    const result = await getNextPreVinculosQuestion(pid, { nome: "João" });
    expect(result).toBe("Qual sua cidade?");
  });
});

describe("advanceAdvogadoFlow", () => {
  it("returns { nextQuestion: null, nextStepChave: '__done__' } when no steps configured", async () => {
    const deal = { id: "d1", iaFlowStepChave: null, iaFlowStepData: null, qualificacao: {} };
    const result = await advanceAdvogadoFlow("proj-1", deal, "", 0);
    // Sem steps configurados o flow é considerado concluído ("__done__").
    expect(result).toEqual({ nextQuestion: null, nextStepChave: "__done__" });
  });

  it("returns { nextQuestion: null } when step is __done__", async () => {
    const pid = "proj-done-" + Date.now();
    mockFindMany.mockResolvedValue([{ chave: "cpf", pergunta: "CPF?", stepType: "question", gates: [], campoColetar: "cpf" }]);
    const deal = { id: "d2", iaFlowStepChave: "__done__", iaFlowStepData: {}, qualificacao: {} };
    const result = await advanceAdvogadoFlow(pid, deal, "ok", 5);
    expect(result.nextQuestion).toBeNull();
  });

  it("sets first step on first interaction (outgoingCount=0)", async () => {
    const pid = "proj-first-" + Date.now();
    mockFindMany.mockResolvedValue([{ chave: "apresentacao", pergunta: "Olá!", stepType: "question", gates: [], campoColetar: null }]);
    const deal = { id: "d3", iaFlowStepChave: null, iaFlowStepData: null, qualificacao: {} };
    const result = await advanceAdvogadoFlow(pid, deal, "", 0);
    expect(result.nextQuestion).toBe("Olá!");
    expect(result.nextStepChave).toBe("apresentacao");
    expect(mockDealUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d3" } }));
  });
});

describe("handleAdvogadoFlow (deprecated alias)", () => {
  it("is the same function as advanceAdvogadoFlow", () => {
    expect(handleAdvogadoFlow).toBe(advanceAdvogadoFlow);
  });
});

// P6 — llm_generated steps must not be skipped
describe("P6 — llm_generated step sequencing", () => {
  const STEPS = [
    { chave: "apresentacao", pergunta: "Olá!", stepType: "question", gates: [], campoColetar: null, ordem: 0, subFase: null },
    { chave: "parecer", pergunta: "INSTRUÇÃO: gere o parecer jurídico", stepType: "llm_generated", gates: [], campoColetar: null, ordem: 1, subFase: null },
    { chave: "valor_estimado", pergunta: "INSTRUÇÃO: gere o valor estimado", stepType: "llm_generated", gates: [], campoColetar: null, ordem: 2, subFase: null },
    { chave: "solicitar_cnh", pergunta: "Envie sua CNH", stepType: "question", gates: [], campoColetar: "rg", ordem: 3, subFase: null },
  ];

  it("returns parecer when apresentacao_enviado=true but parecer_enviado=false", async () => {
    const pid = "proj-p6a-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS);
    const deal = {
      id: "deal-p6a",
      iaFlowStepChave: "parecer",
      iaFlowStepData: { apresentacao_enviado: true },
      qualificacao: {},
    };
    const result = await advanceAdvogadoFlow(pid, deal, "qualquer texto", 3);
    expect(result.stepType).toBe("llm_generated");
    expect(result.nextStepChave).toBe("parecer");
  });

  it("advances to valor_estimado when parecer_enviado=true and lead responds", async () => {
    const pid = "proj-p6b-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS);
    const deal = {
      id: "deal-p6b",
      iaFlowStepChave: "parecer",
      iaFlowStepData: { apresentacao_enviado: true, parecer_enviado: true },
      qualificacao: {},
    };
    const result = await advanceAdvogadoFlow(pid, deal, "entendi, obrigado", 4);
    expect(result.nextStepChave).toBe("valor_estimado");
    expect(result.stepType).toBe("llm_generated");
  });

  it("does not advance to CNH when valor_estimado_enviado=false", async () => {
    const pid = "proj-p6c-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS);
    const deal = {
      id: "deal-p6c",
      iaFlowStepChave: "valor_estimado",
      iaFlowStepData: { apresentacao_enviado: true, parecer_enviado: true },
      qualificacao: {},
    };
    const result = await advanceAdvogadoFlow(pid, deal, "ok", 5);
    expect(result.stepType).toBe("llm_generated");
    expect(result.nextStepChave).toBe("valor_estimado");
    expect(result.nextStepChave).not.toBe("solicitar_cnh");
  });
});

// Fast-path tentativas guard (BUG 2 fix)
describe("advanceAdvogadoFlow — fast-path tentativas (Bug 2 fix)", () => {
  const STEPS_FP = [
    { chave: "apresentacao", pergunta: "Olá!", stepType: "question", gates: [], campoColetar: null, ordem: 0, subFase: null },
    { chave: "comp_salario", pergunta: "Qual o salário?", stepType: "question", gates: [], campoColetar: "comp_salario", ordem: 5, subFase: null },
    { chave: "comp_banco", pergunta: "Qual o banco?", stepType: "question", gates: [], campoColetar: "comp_banco", ordem: 6, subFase: null },
  ];

  beforeEach(() => {
    mockExtractJson.mockResolvedValue(null);
  });

  it("texto não-resposta com tentativas=0 → não avança, incrementa para 1", async () => {
    const pid = "proj-fp1-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS_FP);
    const deal = { id: "d-fp1", iaFlowStepChave: "comp_salario", iaFlowStepData: {}, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "pode seguir", 3);

    expect(result.nextQuestion).toBe("Qual o salário?");
    expect(mockSaveFlowStep).toHaveBeenCalledWith(deal, { comp_salario_tentativas: 1 }, "comp_salario");
  });

  it("texto não-resposta com tentativas=1 → não avança ainda", async () => {
    const pid = "proj-fp2-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS_FP);
    const deal = { id: "d-fp2", iaFlowStepChave: "comp_salario", iaFlowStepData: { comp_salario_tentativas: 1 }, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "pode seguir", 4);

    expect(result.nextQuestion).toBe("Qual o salário?");
    expect(mockSaveFlowStep).toHaveBeenCalledWith(deal, { comp_salario_tentativas: 2 }, "comp_salario");
  });

  it("texto não-resposta com tentativas=2 → avança para próximo step", async () => {
    const pid = "proj-fp3-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS_FP);
    const deal = { id: "d-fp3", iaFlowStepChave: "comp_salario", iaFlowStepData: { comp_salario_tentativas: 2 }, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "pode seguir", 5);

    expect(result.nextStepChave).toBe("comp_banco");
  });

  it("resposta com campo extraído → avança imediatamente (tentativas=0)", async () => {
    const pid = "proj-fp4-" + Date.now();
    mockFindMany.mockResolvedValue(STEPS_FP);
    mockExtractJson.mockResolvedValue({ comp_salario: "2000 reais" });
    const deal = { id: "d-fp4", iaFlowStepChave: "comp_salario", iaFlowStepData: {}, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "2000 reais", 3);

    expect(result.nextStepChave).toBe("comp_banco");
  });
});

// P1 — apresentacao_enviado guard prevents duplicate intro via webhook path
describe("advanceAdvogadoFlow — P1 apresentacao_enviado guard", () => {
  const FIRST_STEP = { chave: "apresentacao", pergunta: "Olá!", stepType: "question", gates: [], campoColetar: null };

  it("returns nextQuestion: null when step=null and apresentacao_enviado=true (cron already won lock)", async () => {
    const pid = "proj-p1-guard-" + Date.now();
    mockFindMany.mockResolvedValue([FIRST_STEP]);
    const deal = { id: "d-p1-block", iaFlowStepChave: null, iaFlowStepData: { apresentacao_enviado: true }, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "", 0);

    expect(result.nextQuestion).toBeNull();
    expect(mockDealUpdate).not.toHaveBeenCalled();
  });

  it("proceeds normally when step=null and apresentacao_enviado=false (webhook goes first)", async () => {
    const pid = "proj-p1-pass-" + Date.now();
    mockFindMany.mockResolvedValue([FIRST_STEP]);
    const deal = { id: "d-p1-pass", iaFlowStepChave: null, iaFlowStepData: { apresentacao_enviado: false }, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "", 0);

    expect(result.nextQuestion).toBe("Olá!");
    expect(result.nextStepChave).toBe("apresentacao");
    expect(mockDealUpdate).toHaveBeenCalled();
  });

  it("proceeds normally when step=null and iaFlowStepData is empty (fresh deal)", async () => {
    const pid = "proj-p1-fresh-" + Date.now();
    mockFindMany.mockResolvedValue([FIRST_STEP]);
    const deal = { id: "d-p1-fresh", iaFlowStepChave: null, iaFlowStepData: {}, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "", 0);

    expect(result.nextQuestion).toBe("Olá!");
  });
});

// P3B — gate evaluation injects conversation history when pergunta is empty
describe("advanceAdvogadoFlow — P3B history injection for gate steps", () => {
  const GATE_STEPS = [
    {
      chave: "contorno_objecao", pergunta: "", stepType: "gate", campoColetar: null, ordem: 0, subFase: null,
      gates: [
        { id: "gate-accept", condicao: "Lead concorda em prosseguir ou quer ver o cálculo", actionType: "continue", actionValue: null, ordem: 1 },
        { id: "gate-end",    condicao: "Lead declara explicitamente que não quer prosseguir", actionType: "end",      actionValue: "Entendido.", ordem: 2 },
      ],
    },
    { chave: "explicar_processo", pergunta: "Quer que eu explique o processo?", stepType: "question", gates: [], campoColetar: null, ordem: 1, subFase: null },
  ];

  it("includes last outgoing message in extractJson instruction when pergunta is empty", async () => {
    const pid = "proj-p3b-hist-" + Date.now();
    mockFindMany.mockResolvedValue(GATE_STEPS);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: "gate-accept", extracted: {} });

    const deal = { id: "d-p3b", iaFlowStepChave: "contorno_objecao", iaFlowStepData: {}, qualificacao: {} };
    const history = [
      { direcao: "in",  conteudo: "não tenho certeza" },
      { direcao: "out", conteudo: "Entendo sua hesitação. O risco é zero — só cobramos se ganhar." },
    ];

    await advanceAdvogadoFlow(pid, deal, "faz o calculo e me mostra", 5, history);

    expect(mockExtractJson).toHaveBeenCalledWith(expect.objectContaining({
      instruction: expect.stringContaining("Entendo sua hesitação"),
    }));
  });

  it("acceptance gate ('faz o calculo') → continues without ending conversation", async () => {
    const pid = "proj-p3b-accept-" + Date.now();
    mockFindMany.mockResolvedValue(GATE_STEPS);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: "gate-accept", extracted: {} });

    const deal = { id: "d-p3b-accept", iaFlowStepChave: "contorno_objecao", iaFlowStepData: {}, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "faz o calculo e me mostra", 5);

    expect(result.nextStepChave).not.toBe("__done__");
    expect(mockSaveFlowStep).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "__done__");
  });

  it("end gate ('não quero mesmo') → sets __done__ and returns closure message", async () => {
    const pid = "proj-p3b-end-" + Date.now();
    mockFindMany.mockResolvedValue(GATE_STEPS);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: "gate-end", extracted: {} });

    const deal = { id: "d-p3b-end", iaFlowStepChave: "contorno_objecao", iaFlowStepData: {}, qualificacao: {} };

    const result = await advanceAdvogadoFlow(pid, deal, "não quero mesmo, pode parar", 5);

    expect(result.nextStepChave).toBe("__done__");
    expect(result.nextQuestion).toBe("Entendido.");
  });
});

// Pre-skip with vinculos[0] fallback (salary/jornada collected by Ana)
describe("advanceAdvogadoFlow — pre-skip via vinculos[0] fallback", () => {
  const COMP_STEPS = [
    { chave: "apresentacao", pergunta: "Olá!", stepType: "question", gates: [], campoColetar: null, ordem: 0 },
    { chave: "comp_salario",  pergunta: "Qual o salário?",  stepType: "question", gates: [], campoColetar: "salario_total_declarado", ordem: 1 },
    { chave: "comp_jornada",  pergunta: "Qual a jornada?",  stepType: "question", gates: [], campoColetar: "jornada_descricao",       ordem: 2 },
    { chave: "comp_fgts",     pergunta: "FGTS ok?",         stepType: "question", gates: [], campoColetar: "fgts_ok",                 ordem: 3 },
  ];

  it("pula comp_salario quando vinculos[0].salario_holerite está preenchido", async () => {
    // apresentacao has no campoColetar/gates → gate validation path
    // mock: { answered: true } advances from apresentacao → pre-skip evaluates comp_salario
    const pid = "proj-preskip-sal-" + Date.now();
    mockFindMany.mockResolvedValue(COMP_STEPS);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: null, extracted: {} });
    const deal = {
      id: "d-preskip-sal",
      iaFlowStepChave: "apresentacao",
      iaFlowStepData: {},
      qualificacao: { vinculos: [{ ordem: 1, empresa: "ABCDE", salario_holerite: 2500, salario_por_fora: 7500 }] },
    };

    const result = await advanceAdvogadoFlow(pid, deal, "entendido obrigado", 2);

    expect(result.nextStepChave).not.toBe("comp_salario");
    expect(result.nextStepChave).toBe("comp_jornada");
  });

  it("pula comp_jornada quando vinculos[0].jornada_inicio está preenchido", async () => {
    // comp_salario has campoColetar → extraction path; mock returns the extracted field
    const pid = "proj-preskip-jorn-" + Date.now();
    mockFindMany.mockResolvedValue(COMP_STEPS);
    mockExtractJson.mockResolvedValue({ salario_total_declarado: "10000" });
    const deal = {
      id: "d-preskip-jorn",
      iaFlowStepChave: "comp_salario",
      iaFlowStepData: {},
      qualificacao: { vinculos: [{ ordem: 1, empresa: "ABCDE", jornada_inicio: "05:00", jornada_fim: "23:00" }] },
    };

    const result = await advanceAdvogadoFlow(pid, deal, "recebia 10 mil por mes", 3);

    expect(result.nextStepChave).not.toBe("comp_jornada");
    expect(result.nextStepChave).toBe("comp_fgts");
  });

  it("flat salario_total_declarado preenchido — também pula comp_salario (sem vinculos)", async () => {
    const pid = "proj-preskip-flat-" + Date.now();
    mockFindMany.mockResolvedValue(COMP_STEPS);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: null, extracted: {} });
    const deal = {
      id: "d-preskip-flat",
      iaFlowStepChave: "apresentacao",
      iaFlowStepData: { salario_total_declarado: "10000" },
      qualificacao: {},
    };

    const result = await advanceAdvogadoFlow(pid, deal, "entendido obrigado", 2);

    expect(result.nextStepChave).not.toBe("comp_salario");
  });
});

// FIX 2 — Gate steps with no match → silence (don't re-send question)
describe("advanceAdvogadoFlow — gate step silence when no gate matched", () => {
  const GATE_STEP = {
    chave: "explicar_processo",
    pergunta: "Quer que eu explique como funciona o processo?",
    stepType: "question",
    campoColetar: null,
    ordem: 0,
    subFase: null,
    gates: [
      { id: "gate-confirm", condicao: "Cliente confirma interesse em prosseguir", actionType: "continue",  actionValue: null,    ordem: 1 },
      { id: "gate-depois",  condicao: "Lead quer continuar depois, amanhã ou mais tarde", actionType: "end", actionValue: "Claro! Estarei aqui quando quiser continuar.", ordem: 2 },
    ],
  };
  const NEXT_STEP = { chave: "comp_salario", pergunta: "Qual o salário?", stepType: "question", gates: [], campoColetar: "salario_total_declarado", ordem: 1, subFase: null };

  it("answered=false em step com gates → nextQuestion: null (silêncio) + salva _gate_silenciado=true", async () => {
    const pid = "proj-gate-sil-a-" + Date.now();
    mockFindMany.mockResolvedValue([GATE_STEP, NEXT_STEP]);
    mockExtractJson.mockResolvedValue({ answered: false, gate_id: null, extracted: {} });

    const deal = { id: "d-gate-sil-a", iaFlowStepChave: "explicar_processo", iaFlowStepData: {}, qualificacao: {} };
    const result = await advanceAdvogadoFlow(pid, deal, "amanhã vc fala comigo?", 3);

    expect(result.nextQuestion).toBeNull();
    expect(result.nextStepChave).toBe("explicar_processo");
    expect(mockSaveFlowStep).toHaveBeenCalledWith(deal, { _gate_silenciado: true }, "explicar_processo");
  });

  it("answered=true gate_id=null em step com gates → nextQuestion: null (silêncio) + salva _gate_silenciado=true", async () => {
    const pid = "proj-gate-sil-b-" + Date.now();
    mockFindMany.mockResolvedValue([GATE_STEP, NEXT_STEP]);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: null, extracted: {} });

    const deal = { id: "d-gate-sil-b", iaFlowStepChave: "explicar_processo", iaFlowStepData: {}, qualificacao: {} };
    const result = await advanceAdvogadoFlow(pid, deal, "ok", 3);

    expect(result.nextQuestion).toBeNull();
    expect(result.nextStepChave).toBe("explicar_processo");
    expect(mockSaveFlowStep).toHaveBeenCalledWith(deal, { _gate_silenciado: true }, "explicar_processo");
  });

  it("nova mensagem com _gate_silenciado=true → limpa flag antes de processar", async () => {
    const pid = "proj-gate-sil-e-" + Date.now();
    mockFindMany.mockResolvedValue([GATE_STEP, NEXT_STEP]);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: "gate-confirm", extracted: {} });

    const deal = {
      id: "d-gate-sil-e",
      iaFlowStepChave: "explicar_processo",
      iaFlowStepData: { _gate_silenciado: true },
      qualificacao: {},
    };
    const result = await advanceAdvogadoFlow(pid, deal, "sim pode continuar", 4);

    // Should clear the flag AND advance
    expect(mockSaveFlowStep).toHaveBeenCalledWith(deal, { _gate_silenciado: false }, "explicar_processo");
    expect(result.nextStepChave).toBe("comp_salario");
  });

  it("gate 'depois/amanhã' matched → actionType end, mensagem amigável", async () => {
    const pid = "proj-gate-sil-c-" + Date.now();
    mockFindMany.mockResolvedValue([GATE_STEP, NEXT_STEP]);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: "gate-depois", extracted: {} });

    const deal = { id: "d-gate-sil-c", iaFlowStepChave: "explicar_processo", iaFlowStepData: {}, qualificacao: {} };
    const result = await advanceAdvogadoFlow(pid, deal, "amanhã você fala comigo?", 3);

    expect(result.nextStepChave).toBe("__done__");
    expect(result.nextQuestion).toBe("Claro! Estarei aqui quando quiser continuar.");
  });

  it("gate 'confirma' matched → avança para próximo step", async () => {
    const pid = "proj-gate-sil-d-" + Date.now();
    mockFindMany.mockResolvedValue([GATE_STEP, NEXT_STEP]);
    mockExtractJson.mockResolvedValue({ answered: true, gate_id: "gate-confirm", extracted: {} });

    const deal = { id: "d-gate-sil-d", iaFlowStepChave: "explicar_processo", iaFlowStepData: {}, qualificacao: {} };
    const result = await advanceAdvogadoFlow(pid, deal, "sim pode explicar", 3);

    expect(result.nextStepChave).toBe("comp_salario");
  });
});
