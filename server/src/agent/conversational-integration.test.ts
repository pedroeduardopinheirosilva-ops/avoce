import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./conversational-router.js", () => ({
  getConversationalSystemInstructions: vi.fn(),
}));

import { getConversationalSystemInstructions } from "./conversational-router.js";
import { applyConversacionalMode } from "./conversational-dispatch.js";

const mockConvRouter = getConversationalSystemInstructions as ReturnType<typeof vi.fn>;

const baseAgentResult = {
  systemInstructions: "INSTRUCOES_BASE",
  allDone: false,
  deterministicQuestion: "Qual empresa você trabalhou?",
  phase: "vinculos_recente" as const,
};

const convParams = {
  projetoId: "proj-1",
  merged: {},
  vinculos: [],
  vinculosOk: false,
  vinculosTodosPrescritos: false,
  empresasBloqueadas: [],
  outgoingCount: 1,
};

beforeEach(() => vi.clearAllMocks());

describe("applyConversacionalMode", () => {
  it("sequencial → router NÃO é chamado, retorna result original", async () => {
    const result = await applyConversacionalMode({
      modoColeta: "sequencial",
      personaChave: "assistente",
      agentResult: baseAgentResult,
      currentNextQ: "Qual empresa?",
      convParams,
    });

    expect(mockConvRouter).not.toHaveBeenCalled();
    expect(result.nextQDeterministico).toBe("Qual empresa?");
    expect(result.agentResult.systemInstructions).toBe("INSTRUCOES_BASE");
    expect(result.agentResult.allDone).toBe(false);
  });

  it("modoColeta = undefined → equivale a sequencial, router NÃO chamado", async () => {
    const result = await applyConversacionalMode({
      modoColeta: (undefined as any) ?? "sequencial",
      personaChave: "assistente",
      agentResult: baseAgentResult,
      currentNextQ: "Qual empresa?",
      convParams,
    });

    expect(mockConvRouter).not.toHaveBeenCalled();
    expect(result.nextQDeterministico).toBe("Qual empresa?");
  });

  it("conversacional → router É chamado, nextQDeterministico = null", async () => {
    mockConvRouter.mockResolvedValue({
      systemSuffix: "⚠️ CAMPO OBRIGATÓRIO — combine empresa + função",
      isDone: false,
    });

    const result = await applyConversacionalMode({
      modoColeta: "conversacional",
      personaChave: "assistente",
      agentResult: baseAgentResult,
      currentNextQ: "Qual empresa?",
      convParams,
    });

    expect(mockConvRouter).toHaveBeenCalledOnce();
    expect(result.nextQDeterministico).toBeNull();
    expect(result.agentResult.systemInstructions).toContain("INSTRUCOES_BASE");
    expect(result.agentResult.systemInstructions).toContain("⚠️ CAMPO OBRIGATÓRIO");
  });

  it("conversacional, isDone=true → agentResult.allDone = true", async () => {
    mockConvRouter.mockResolvedValue({ systemSuffix: "Encerramento", isDone: true });

    const result = await applyConversacionalMode({
      modoColeta: "conversacional",
      personaChave: "assistente",
      agentResult: baseAgentResult,
      currentNextQ: null,
      convParams,
    });

    expect(result.agentResult.allDone).toBe(true);
    expect(result.nextQDeterministico).toBeNull();
  });

  it("conversacional + router lança erro → fallback para sequencial", async () => {
    mockConvRouter.mockRejectedValue(new Error("LLM timeout"));

    const result = await applyConversacionalMode({
      modoColeta: "conversacional",
      personaChave: "assistente",
      agentResult: baseAgentResult,
      currentNextQ: "Qual empresa?",
      convParams,
    });

    expect(result.nextQDeterministico).toBe("Qual empresa?");
    expect(result.agentResult.systemInstructions).toBe("INSTRUCOES_BASE");
    expect(result.agentResult.allDone).toBe(false);
  });

  it("personaChave = advogado + modoColeta = conversacional → router NÃO chamado", async () => {
    const result = await applyConversacionalMode({
      modoColeta: "conversacional",
      personaChave: "advogado",
      agentResult: baseAgentResult,
      currentNextQ: "Qual o CPF?",
      convParams,
    });

    expect(mockConvRouter).not.toHaveBeenCalled();
    expect(result.nextQDeterministico).toBe("Qual o CPF?");
  });
});
