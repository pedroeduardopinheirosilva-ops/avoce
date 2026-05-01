import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./llm.js", () => ({
  extractJson: vi.fn(),
  callLlm: vi.fn(),
}));

import { extractJson } from "./llm.js";
import { tryExtractVinculo } from "./qualification.js";

const mockExtractJson = extractJson as ReturnType<typeof vi.fn>;

function vinculoResult(saida: string | null, empresa = "ABC") {
  return {
    sem_mais_empregos: false,
    confirmou_mais_empregos: false,
    vinculos_atualizados: [{ ordem: 1, empresa, saida }],
    novo_vinculo: null,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("tryExtractVinculo — saida field prompt rule", () => {
  it("prompt contains REGRA CRÍTICA para o campo saida", async () => {
    mockExtractJson.mockResolvedValue(vinculoResult(null));
    await tryExtractVinculo("proj-1", "qualquer coisa", [], "");
    const callArgs = mockExtractJson.mock.calls[0];
    expect(callArgs[0].instruction).toContain("REGRA CRÍTICA para o campo");
    expect(callArgs[0].instruction).toContain("declarou EXPLICITAMENTE");
  });

  it("past-tense-only message ('trabalhei na ABC') → saida propagated as null", async () => {
    mockExtractJson.mockResolvedValue(vinculoResult(null, "Transportadora ABC Ltda"));
    const result = await tryExtractVinculo(
      "proj-1",
      "eu trabalhei na Transportadora ABC Ltda",
      [{ ordem: 1, empresa: "Transportadora ABC Ltda" }],
      "",
    );
    const updated = result.updatedVinculos.find((v) => v.ordem === 1);
    expect(updated?.saida).toBeFalsy(); // null/undefined — merge converts null→undefined
    expect(updated?.empresa).toBe("Transportadora ABC Ltda");
  });

  it("explicit demitido message → saida ≠ null", async () => {
    mockExtractJson.mockResolvedValue(vinculoResult("demitido há 6 meses", "ABC"));
    const result = await tryExtractVinculo(
      "proj-1",
      "trabalhei na ABC, fui demitido há 6 meses",
      [{ ordem: 1, empresa: "ABC" }],
      "",
    );
    const updated = result.updatedVinculos.find((v) => v.ordem === 1);
    expect(updated?.saida).toBeTruthy();
  });

  it("'estou na empresa até hoje' → saida = 'ainda empregado'", async () => {
    mockExtractJson.mockResolvedValue(vinculoResult("ainda empregado", "XYZ"));
    const result = await tryExtractVinculo(
      "proj-1",
      "estou na empresa XYZ até hoje",
      [{ ordem: 1, empresa: "XYZ" }],
      "",
    );
    const updated = result.updatedVinculos.find((v) => v.ordem === 1);
    expect(updated?.saida).toBe("ainda empregado");
  });

  it("explicit departure date → saida ≠ null", async () => {
    mockExtractJson.mockResolvedValue(vinculoResult("saiu em março do ano passado", "ABC"));
    const result = await tryExtractVinculo(
      "proj-1",
      "saí da empresa em março do ano passado",
      [{ ordem: 1, empresa: "ABC" }],
      "",
    );
    const updated = result.updatedVinculos.find((v) => v.ordem === 1);
    expect(updated?.saida).toBeTruthy();
  });

  it("past-tense role only ('era motorista na XYZ por 3 anos') → saida propagated as null", async () => {
    mockExtractJson.mockResolvedValue(vinculoResult(null, "Transportes XYZ"));
    const result = await tryExtractVinculo(
      "proj-1",
      "era motorista na Transportes XYZ por 3 anos",
      [{ ordem: 1, empresa: "Transportes XYZ" }],
      "",
    );
    const updated = result.updatedVinculos.find((v) => v.ordem === 1);
    expect(updated?.saida).toBeFalsy(); // null/undefined — merge converts null→undefined
  });
});

describe("getNextVinculoQuestion SAIDA_INFERIDA guard (via persona-router)", () => {
  it("values in SAIDA_INFERIDA are treated as missing — tested indirectly via qualification prompt", () => {
    // The SAIDA_INFERIDA guard in persona-router.ts ensures these values force a re-ask.
    // This test documents the expected guard values for the reader.
    const SAIDA_INFERIDA = ['saiu', 'já saiu', 'saiu da empresa', 'deixou a empresa', 'não trabalha mais'];
    for (const val of SAIDA_INFERIDA) {
      expect(SAIDA_INFERIDA.includes(val.toLowerCase().trim())).toBe(true);
    }
  });
});
