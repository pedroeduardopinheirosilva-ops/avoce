import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    crmDeal: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    iaRegraTransicao: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    iaFaseFunil: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    crmStage: {
      findFirst: vi.fn(),
    },
    crmDealStageLog: {
      create: vi.fn(),
    },
    crmContato: {
      findFirst: vi.fn(),
    },
    iaPersona: {
      findUnique: vi.fn().mockResolvedValue({ systemPrompt: "", nomeExibicao: "Daniela", llmProviderChave: null }),
      // getPersonaNomeExibicao (transition-engine.ts:51) agora usa findFirst
      findFirst: vi.fn().mockResolvedValue({ nomeExibicao: "Daniela" }),
    },
    iaMensagemTemplate: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    crmMensagemWhatsapp: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
    },
    iaInteracaoLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    iaProjetoConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("./llm.js", () => ({ callLlm: vi.fn() }));
vi.mock("./humanizer.js", () => ({ isHumanized: vi.fn().mockReturnValue(true) }));
vi.mock("./message-handler.js", () => ({
  getEvolutionConfig: vi.fn().mockResolvedValue(null),
  sendHumanized: vi.fn(),
  limparResposta: vi.fn((t: string) => t),
  sendAudioIfConfigured: vi.fn().mockResolvedValue(undefined),
  dispararNotificacoes: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./persona-router.js", () => ({ buildInstrucaoBase: vi.fn().mockReturnValue("") }));
vi.mock("./flow-controller.js", () => ({ initAdvogadoFlowIfNeeded: vi.fn().mockResolvedValue({ message: null, firstStepChave: null }) }));
vi.mock("./deal-repository.js", () => ({ saveFlowStepData: vi.fn().mockResolvedValue(undefined) }));

import { prisma } from "../db.js";
import { transitionDeal, checkTransitions, enviarMensagemProativa } from "./transition-engine.js";
import { getEvolutionConfig } from "./message-handler.js";
import { callLlm } from "./llm.js";

const mockDealFindUnique = prisma.crmDeal.findUnique as ReturnType<typeof vi.fn>;
const mockGetEvoConfig = getEvolutionConfig as ReturnType<typeof vi.fn>;
const mockExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;
const mockCallLlm = callLlm as ReturnType<typeof vi.fn>;
const mockRegrFindFirst = prisma.iaRegraTransicao.findFirst as ReturnType<typeof vi.fn>;
const mockFaseFindUnique = prisma.iaFaseFunil.findUnique as ReturnType<typeof vi.fn>;
const mockStageFindFirst = prisma.crmStage.findFirst as ReturnType<typeof vi.fn>;
const mockLogCreate = prisma.crmDealStageLog.create as ReturnType<typeof vi.fn>;
const mockDealUpdate = prisma.crmDeal.update as ReturnType<typeof vi.fn>;
const mockContatoFindFirst = prisma.crmContato.findFirst as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockDealUpdate.mockResolvedValue({});
  mockLogCreate.mockResolvedValue({});
  mockContatoFindFirst.mockResolvedValue({ nome: "João", whatsapp: "5511999" });
});

function setupValidTransition(acaoAdicional: string | null = null) {
  mockDealFindUnique.mockResolvedValue({ id: "d1", iaStageChave: "lead_qualificado", iaPersonaChave: "assistente", stageId: "s1", qualificacao: {} });
  mockRegrFindFirst.mockResolvedValue({ stageOrigemChave: "lead_qualificado", stageDestinoChave: "com_advogado", condicao: "qualificacao_completa", acaoAdicional, ordem: 1 });
  mockFaseFindUnique.mockResolvedValue({ chave: "com_advogado", personaChave: "advogado", pipelineId: null });
  mockStageFindFirst.mockResolvedValue(null);
}

describe("transitionDeal", () => {
  it("returns { transitioned: false, pendingActions: [] } when deal not found", async () => {
    mockDealFindUnique.mockResolvedValue(null);
    const result = await transitionDeal("proj-1", "d-missing", "qualificacao_completa");
    expect(result.transitioned).toBe(false);
    expect(result.pendingActions).toEqual([]);
  });

  it("returns { transitioned: false, pendingActions: [] } when no matching rule", async () => {
    mockDealFindUnique.mockResolvedValue({ id: "d1", iaStageChave: "lead_qualificado", qualificacao: {}, stageId: "s1" });
    mockRegrFindFirst.mockResolvedValue(null);
    const result = await transitionDeal("proj-1", "d1", "qualificacao_completa");
    expect(result.transitioned).toBe(false);
    expect(result.pendingActions).toEqual([]);
  });

  it("transitions and returns notify pending action with no acaoAdicional", async () => {
    setupValidTransition(null);
    const result = await transitionDeal("proj-1", "d1", "qualificacao_completa");
    expect(result.transitioned).toBe(false); // no proactive message sent
    expect(result.pendingActions).toHaveLength(1);
    expect(result.pendingActions[0]).toMatchObject({ type: "notify", evento: "stage_entrada:com_advogado", dealId: "d1" });
  });

  it("returns transitioned:true with send_proativa pending action for trocar_persona", async () => {
    setupValidTransition("trocar_persona:advogado");
    mockContatoFindFirst.mockResolvedValue({ nome: "Maria", whatsapp: "5511888" });
    const result = await transitionDeal("proj-1", "d1", "qualificacao_completa", "5511888");
    expect(result.transitioned).toBe(true);
    const proativa = result.pendingActions.find(a => a.type === "send_proativa");
    expect(proativa).toBeDefined();
    expect(proativa).toMatchObject({ type: "send_proativa", dealId: "d1", phone: "5511888", motivoCron: "primeira_mensagem", delayMs: 45_000 });
  });
});

describe("checkTransitions", () => {
  it("returns { transitioned: false, pendingActions: [] } when no condition matches", async () => {
    const result = await checkTransitions("proj-1", "d1", "lead_carreteiro", "não sei", "5511999");
    expect(result.transitioned).toBe(false);
    expect(result.pendingActions).toEqual([]);
  });

  it("attempts transition on 'lead_sem_resposta' when client responds", async () => {
    setupValidTransition(null);
    mockDealFindUnique.mockResolvedValue({ id: "d1", iaStageChave: "lead_sem_resposta", iaPersonaChave: "assistente", stageId: "s1", qualificacao: {} });
    mockRegrFindFirst.mockResolvedValue({ stageOrigemChave: "lead_sem_resposta", stageDestinoChave: "lead_qualificado", condicao: "cliente_respondeu", acaoAdicional: null, ordem: 1 });
    mockFaseFindUnique.mockResolvedValue({ chave: "lead_qualificado", personaChave: "assistente", pipelineId: null });
    const result = await checkTransitions("proj-1", "d1", "lead_sem_resposta", "oi, voltei", "5511999");
    expect(result.transitioned).toBe(false); // no proactive message
    expect(result.pendingActions.some(a => a.type === "notify")).toBe(true);
  });
});

// Universal atomic lock: $executeRaw at the top of enviarMensagemProativa prevents duplicate intro.
// Old in-memory guard replaced — $executeRaw is now the single source of truth.
describe("enviarMensagemProativa — universal $executeRaw lock", () => {
  it("retorna imediatamente quando $executeRaw retorna 0 (flag já no DB)", async () => {
    mockDealFindUnique.mockResolvedValue({
      id: "d-guard",
      iaAtiva: true,
      iaStageChave: "com_advogado",
      iaPersonaChave: "advogado",
      iaFlowStepData: { apresentacao_enviado: true },
    });
    mockExecuteRaw.mockResolvedValueOnce(0); // flag already set — another process won

    await enviarMensagemProativa("proj-1", "d-guard", "5511999", "primeira_mensagem", "Pedro");

    expect(mockGetEvoConfig).not.toHaveBeenCalled();
  });

  it("prossegue quando $executeRaw retorna 1 (lock adquirido)", async () => {
    mockDealFindUnique.mockResolvedValue({
      id: "d-guard2",
      iaAtiva: true,
      iaStageChave: "com_advogado",
      iaPersonaChave: "advogado",
      iaFlowStepData: {},
    });
    // mockExecuteRaw returns 1 by default → lock acquired → proceeds to getEvolutionConfig
    mockGetEvoConfig.mockResolvedValue(null);

    await enviarMensagemProativa("proj-1", "d-guard2", "5511999", "primeira_mensagem", "Pedro");

    expect(mockGetEvoConfig).toHaveBeenCalled();
  });
});

// When initAdvogadoFlowIfNeeded returns null (flow already initialized) the lock still applies.
describe("enviarMensagemProativa — lock com initAdvogadoFlowIfNeeded retornando null", () => {
  const advogadoDeal = {
    id: "d-else",
    iaAtiva: true,
    iaStageChave: "com_advogado",
    iaPersonaChave: "advogado",
    iaFlowStepData: {},
  };

  beforeEach(() => {
    mockDealFindUnique.mockResolvedValue(advogadoDeal);
    // initAdvogadoFlowIfNeeded returns null → falls to else path
    // (already mocked at top-level: { message: null, firstStepChave: null })
    mockGetEvoConfig.mockResolvedValue({ instance: "test", apiKey: "key" });
    mockCallLlm.mockResolvedValue({ content: "Olá!", tokensIn: 10, tokensOut: 5, latencyMs: 100, model: "m", provider: "groq" });
  });

  it("$executeRaw retorna 0 (outro processo ganhou) → callLlm NÃO chamado", async () => {
    mockExecuteRaw.mockResolvedValue(0);

    await enviarMensagemProativa("proj-1", "d-else", "5511999", "primeira_mensagem", "Pedro");

    expect(mockCallLlm).not.toHaveBeenCalled();
  });

  it("$executeRaw retorna 1 (este processo ganhou) → callLlm É chamado", async () => {
    mockExecuteRaw.mockResolvedValue(1);

    await enviarMensagemProativa("proj-1", "d-else", "5511999", "primeira_mensagem", "Pedro");

    expect(mockCallLlm).toHaveBeenCalled();
  });
});
