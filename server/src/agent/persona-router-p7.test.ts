import { describe, it, expect, vi, beforeEach } from "vitest";

// getFlowPassos agora lê de prisma.iaFlowStep (personaChave/fase/stepType) — o antigo
// modelo iaVinculoFlowPasso não existe mais. Campos opcionais para vínculo anterior são
// configurados via skipSe: { ordem_maior_que: 1 } nos próprios steps.
const FLOW_STEPS = [
  { chave: "empresa",        campoColetar: "empresa",        ordem: 1,  pergunta: "Empresa?",   skipSe: null, stepType: "question" },
  { chave: "funcao",         campoColetar: "funcao",         ordem: 2,  pergunta: "Função?",    skipSe: null, stepType: "question" },
  { chave: "vinculo",        campoColetar: "vinculo",        ordem: 3,  pergunta: "CLT?",       skipSe: null, stepType: "question" },
  { chave: "saida",          campoColetar: "saida",          ordem: 4,  pergunta: "Como saiu?", skipSe: null, stepType: "question" },
  { chave: "tempo",          campoColetar: "tempo",          ordem: 5,  pergunta: "Tempo?",     skipSe: null, stepType: "question" },
  { chave: "horas_extras",   campoColetar: "horas_extras",   ordem: 6,  pergunta: "HE?",        skipSe: { ordem_maior_que: 1 }, stepType: "question" },
  { chave: "pagamento_fora", campoColetar: "pagamento_fora", ordem: 7,  pergunta: "Pag fora?",  skipSe: { ordem_maior_que: 1 }, stepType: "question" },
  { chave: "injustica",      campoColetar: "injustica",      ordem: 8,  pergunta: "Injustiça?", skipSe: { ordem_maior_que: 1 }, stepType: "question" },
  { chave: "mais_empregos",  campoColetar: null,             ordem: 10, pergunta: "Mais emp?",  skipSe: null, stepType: "mais_empregos" },
].map(s => ({ ...s, ativo: true }));

vi.mock("../db.js", () => ({
  prisma: {
    iaFlowStep: { findMany: vi.fn().mockImplementation(async () => FLOW_STEPS) },
    // getNextVinculoQuestion → getTempoMinimoGate → loadGates lê iaGateSdr
    iaGateSdr: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock("./flow-controller.js", () => ({
  getGreetingStep: vi.fn().mockResolvedValue(null),
  getNextPreVinculosQuestion: vi.fn().mockResolvedValue(null),
  getNextPosVinculosQuestion: vi.fn().mockResolvedValue(null),
}));
vi.mock("./llm.js", () => ({ extractJson: vi.fn() }));

import { getNextDeterministicQuestion } from "./persona-router.js";
import { getNextPosVinculosQuestion } from "./flow-controller.js";

const mockPosQ = getNextPosVinculosQuestion as ReturnType<typeof vi.fn>;

// All basic flow passo fields filled → getNextVinculoQuestion returns null
function baseVinculo(overrides: Record<string, unknown> = {}) {
  return {
    ordem: 1,
    empresa: "Transportes SA",
    funcao: "Motorista",
    vinculo: "CLT" as const,
    tempo: "3 anos",
    tempo_meses_estimado: 36,
    saida: "demitido",
    data_saida: "03/2024",
    horas_extras: "sim, trabalhava 14h",
    pagamento_fora: "não recebia nada",
    injustica: "não pagavam FGTS",
    frota: "grande",
    ...overrides,
  };
}

// merged base: _saudacao_enviada + _mais_empregos_negado to bypass vinculo iteration
const BASE_MERGED = { _saudacao_enviada: true, _mais_empregos_negado: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockPosQ.mockResolvedValue(null);
});

// P7 (atualizado): os campos de cálculo (salario_holerite, jornada, salario_por_fora)
// NÃO são mais perguntados pelo fluxo determinístico da Ana — migraram para o fluxo da
// Daniela (flow-controller: comp_salario/comp_jornada + autoFillFromVinculo).
describe("P7 — campos de cálculo removidos do fluxo determinístico da Ana", () => {
  it("não pergunta salario_holerite — segue o passo de fluxo pendente (pagamento_fora)", async () => {
    const vinculo = baseVinculo({ pagamento_fora: undefined });
    const result = await getNextDeterministicQuestion(
      "proj-p7", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toBe("Pag fora?");
    expect(result).not.toMatch(/holerite|salário na carteira/i);
  });

  it("fluxo básico completo → null (nenhuma pergunta de cálculo extra)", async () => {
    const vinculo = baseVinculo(); // todos os campos do fluxo preenchidos, sem salario/jornada
    const result = await getNextDeterministicQuestion(
      "proj-p7b", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toBeNull();
  });

  it("não pergunta jornada mesmo sem jornada_inicio no vínculo", async () => {
    const vinculo = baseVinculo({ salario_holerite: 2000 }); // jornada ausente
    const result = await getNextDeterministicQuestion(
      "proj-p7d", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toBeNull();
  });

  it("não pergunta salario_por_fora mesmo com pagamento_fora positivo", async () => {
    const vinculo = baseVinculo({ pagamento_fora: "sim, recebia por Pix" });
    const result = await getNextDeterministicQuestion(
      "proj-p7f", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toBeNull();
  });

  it("skips flow questions when vinculosTodosPrescritos=true", async () => {
    const vinculo = baseVinculo({ pagamento_fora: undefined });
    const result = await getNextDeterministicQuestion(
      "proj-p7h", { ...BASE_MERGED }, [vinculo], false, true, [], 5,
    );
    expect(result).toBeNull();
  });

  it("asks for tempo (passo do fluxo) when vinculo has no tempo and no tempo_meses_estimado", async () => {
    const vinculo = baseVinculo({ tempo: undefined as any, tempo_meses_estimado: undefined as any });
    const result = await getNextDeterministicQuestion(
      "proj-p7i", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toBe("Tempo?");
  });
});

describe("PASSO 3 — campos opcionais para vínculo anterior (skipSe ordem_maior_que)", () => {
  it("vínculo ordem=1 sem horas_extras → pergunta horas_extras", async () => {
    const v1 = {
      ordem: 1, empresa: "TransABC", funcao: "Motorista", vinculo: "CLT",
      saida: "demitido", tempo: "3 anos",
      // horas_extras missing
    };
    const result = await getNextDeterministicQuestion(
      "proj-opc1", { _saudacao_enviada: true }, [v1], false, false, [], 5,
    );
    expect(result).toMatch(/HE\?|hora|extra/i);
  });

  it("vínculo ordem=2 sem horas_extras → não pergunta horas_extras (skipSe ordem_maior_que=1)", async () => {
    const v1 = {
      ordem: 1, empresa: "TransABC", funcao: "Motorista", vinculo: "CLT",
      saida: "demitido", tempo: "3 anos", horas_extras: "sim", pagamento_fora: "nao", injustica: "nao",
    };
    const v2 = {
      ordem: 2, empresa: "FreteCo", funcao: "Carreteiro", vinculo: "CLT",
      saida: "15/05/2025", tempo: "7 anos",
      // horas_extras, pagamento_fora, injustica: ausentes — opcionais para ordem > 1
    };
    const result = await getNextDeterministicQuestion(
      "proj-opc2", { _saudacao_enviada: true }, [v1, v2], false, false, [], 5,
    );
    expect(result).not.toMatch(/HE\?/);
  });
});
