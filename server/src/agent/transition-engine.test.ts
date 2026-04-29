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
vi.mock("./flow-controller.js", () => ({ initAdvogadoFlowIfNeeded: vi.fn().mockResolvedValue(null) }));

import { prisma } from "../db.js";
import { transitionDeal, checkTransitions } from "./transition-engine.js";

const mockDealFindUnique = prisma.crmDeal.findUnique as ReturnType<typeof vi.fn>;
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
