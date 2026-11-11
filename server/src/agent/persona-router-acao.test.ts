import { describe, it, expect, vi, beforeEach } from "vitest";

// Pergunta "já tem advogado/ação?" do emprego recente (caso Flavio Helton 24/10): o vínculo não
// tem campo acao_em_andamento — a resposta extraída fica no campo solto merged.acao_em_andamento.
const FLOW_STEPS = [
  { chave: "empresa_recente",    campoColetar: "empresa",           ordem: 1, pergunta: "Empresa?",  skipSe: null, stepType: "question" },
  { chave: "acao_andamento_rec", campoColetar: "acao_em_andamento", ordem: 6, pergunta: "Advogado?", skipSe: { max_tentativas: 3 }, stepType: "question" },
  { chave: "frota_rec",          campoColetar: "frota",             ordem: 7, pergunta: "Frota?",    skipSe: null, stepType: "question" },
].map(s => ({ ...s, ativo: true }));

vi.mock("../db.js", () => ({
  prisma: {
    iaFlowStep: { findMany: vi.fn().mockImplementation(async () => FLOW_STEPS) },
    iaGateSdr: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("./flow-controller.js", () => ({
  getGreetingStep: vi.fn().mockResolvedValue(null),
  getNextPreVinculosQuestion: vi.fn().mockResolvedValue(null),
  getNextPosVinculosQuestion: vi.fn().mockResolvedValue(null),
}));
vi.mock("./llm.js", () => ({ extractJson: vi.fn() }));

import { getNextDeterministicQuestion, getMaxTentativasPasso, invalidateFlowCache } from "./persona-router.js";

const vinculo = { ordem: 1, empresa: "Fontanella Transportes", vinculo: "CLT" as const, tempo: "1 ano e 4 meses" };
const BASE = { _saudacao_enviada: true, _mais_empregos_negado: true, _conta_caso_rec_enviada: true };

beforeEach(() => { vi.clearAllMocks(); invalidateFlowCache("proj-acao"); });

describe("acao_em_andamento no emprego recente", () => {
  it("sem resposta → pergunta se já tem advogado", async () => {
    const q = await getNextDeterministicQuestion("proj-acao", { ...BASE }, [vinculo], false, false, [], 5);
    expect(q).toBe("Advogado?");
  });

  it("lead já respondeu 'não' (campo solto false) → não repergunta, segue o fluxo", async () => {
    const q = await getNextDeterministicQuestion("proj-acao", { ...BASE, acao_em_andamento: false }, [vinculo], false, false, [], 5);
    expect(q).toBe("Frota?");
  });
});

describe("getMaxTentativasPasso", () => {
  it("lê skipSe.max_tentativas do passo", async () => {
    expect(await getMaxTentativasPasso("proj-acao", "acao_andamento_rec")).toBe(3);
  });
  it("padrão 2 sem configuração", async () => {
    expect(await getMaxTentativasPasso("proj-acao", "frota_rec")).toBe(2);
    expect(await getMaxTentativasPasso("proj-acao", "inexistente")).toBe(2);
  });
});
