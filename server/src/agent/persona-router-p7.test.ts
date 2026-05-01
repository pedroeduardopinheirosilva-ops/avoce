import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    iaVinculoFlowPasso: {
      findMany: vi.fn().mockResolvedValue([
        { chave: "empresa",        campoColetar: "empresa",        ordemPadrao: 1, pergunta: "Empresa?",    skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "funcao",         campoColetar: "funcao",         ordemPadrao: 2, pergunta: "Função?",     skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "vinculo",        campoColetar: "vinculo",        ordemPadrao: 3, pergunta: "CLT?",        skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "saida",          campoColetar: "saida",          ordemPadrao: 4, pergunta: "Como saiu?",  skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "tempo",          campoColetar: "tempo",          ordemPadrao: 5, pergunta: "Tempo?",      skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "horas_extras",   campoColetar: "horas_extras",   ordemPadrao: 6, pergunta: "HE?",         skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "pagamento_fora", campoColetar: "pagamento_fora", ordemPadrao: 7, pergunta: "Pag fora?",   skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "injustica",      campoColetar: "injustica",      ordemPadrao: 8, pergunta: "Injustiça?",  skipSe: null, tipoEspecial: null, ativo: true },
        { chave: "mais_empregos",  campoColetar: null,             ordemPadrao: 10, pergunta: "Mais emp?",  skipSe: null, tipoEspecial: "mais_empregos", ativo: true },
      ]),
      createMany: vi.fn().mockResolvedValue({}),
    },
    iaFlowStep: { findMany: vi.fn().mockResolvedValue([]) },
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
    pagamento_fora: undefined,
    injustica: "não pagavam FGTS",
    frota: "grande",
    salario_holerite: undefined,
    salario_por_fora: undefined,
    jornada_inicio: undefined,
    jornada_fim: undefined,
    intervalo_minutos: undefined,
    ...overrides,
  };
}

// merged base: _saudacao_enviada + _mais_empregos_negado to bypass vinculo iteration
const BASE_MERGED = { _saudacao_enviada: true, _mais_empregos_negado: true };

beforeEach(() => {
  vi.clearAllMocks();
  mockPosQ.mockResolvedValue(null);
});

describe("P7 — mandatory calc field questions", () => {
  it("asks for salario_holerite when missing from vinculo and merged", async () => {
    const vinculo = baseVinculo(); // salario_holerite: null
    const result = await getNextDeterministicQuestion(
      "proj-p7", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toMatch(/holerite|salário na carteira/i);
  });

  it("does not ask for salario_holerite when already set in vinculo", async () => {
    const vinculo = baseVinculo({ salario_holerite: 2000 });
    const result = await getNextDeterministicQuestion(
      "proj-p7b", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).not.toMatch(/holerite|salário na carteira/i);
  });

  it("asks for salario_holerite when set in merged (not vinculo)", async () => {
    const vinculo = baseVinculo(); // salario_holerite: null
    const result = await getNextDeterministicQuestion(
      "proj-p7c", { _saudacao_enviada: true, salario_holerite: 1800 }, [vinculo], false, false, [], 5,
    );
    // merged has it → should NOT ask again
    expect(result).not.toMatch(/holerite|salário na carteira/i);
  });

  it("asks for jornada when salario collected but jornada missing", async () => {
    const vinculo = baseVinculo({ salario_holerite: 2000 });
    const result = await getNextDeterministicQuestion(
      "proj-p7d", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toMatch(/horário|horas|começava|terminava/i);
  });

  it("does not ask for jornada when already set in vinculo", async () => {
    const vinculo = baseVinculo({ salario_holerite: 2000, jornada_inicio: "05:00" });
    const result = await getNextDeterministicQuestion(
      "proj-p7e", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    // All mandatory fields filled → proceeds to pos-vinculos (mocked null) → null
    expect(result).toBeNull();
  });

  it("asks for salario_por_fora when pagamento_fora is positive and amount missing", async () => {
    const vinculo = baseVinculo({ salario_holerite: 2000, jornada_inicio: "05:00", pagamento_fora: "sim, recebia por Pix" });
    const result = await getNextDeterministicQuestion(
      "proj-p7f", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toMatch(/por fora|pix|comissão|dinheiro/i);
  });

  it("does not ask for salario_por_fora when pagamento_fora is negative", async () => {
    const vinculo = baseVinculo({ salario_holerite: 2000, jornada_inicio: "05:00", pagamento_fora: "não recebia nada" });
    const result = await getNextDeterministicQuestion(
      "proj-p7g", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    // pagamento_fora negative → salario_por_fora skipped; all mandatory fields covered → null
    expect(result).toBeNull();
  });

  it("skips mandatory field questions when vinculosTodosPrescritos=true", async () => {
    const vinculo = baseVinculo(); // missing salario_holerite
    const result = await getNextDeterministicQuestion(
      "proj-p7h", { ...BASE_MERGED }, [vinculo], false, true, [], 5,
    );
    // All blocks gated on !vinculosTodosPrescritos → returns null
    expect(result).toBeNull();
  });

  it("asks for tempo when vinculo has no tempo and no tempo_meses_estimado", async () => {
    const vinculo = baseVinculo({ tempo: undefined as any, tempo_meses_estimado: undefined as any });
    const result = await getNextDeterministicQuestion(
      "proj-p7i", { ...BASE_MERGED }, [vinculo], false, false, [], 5,
    );
    expect(result).toMatch(/quanto tempo|meses|anos/i);
  });
});

describe("PASSO 3 — campos opcionais para vínculo anterior (ordem > 1)", () => {
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

  it("vínculo ordem=2 sem horas_extras → não pergunta horas_extras (campo opcional para vínculo anterior)", async () => {
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
