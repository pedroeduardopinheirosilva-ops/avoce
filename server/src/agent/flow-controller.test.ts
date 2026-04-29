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

const mockFindMany = prisma.iaFlowStep.findMany as ReturnType<typeof vi.fn>;
const mockDealUpdate = prisma.crmDeal.update as ReturnType<typeof vi.fn>;

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
  it("returns { nextQuestion: null } when no steps configured", async () => {
    const deal = { id: "d1", iaFlowStepChave: null, iaFlowStepData: null, qualificacao: {} };
    const result = await advanceAdvogadoFlow("proj-1", deal, "", 0);
    expect(result).toEqual({ nextQuestion: null });
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
