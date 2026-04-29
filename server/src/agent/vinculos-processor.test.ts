import { describe, it, expect, vi, beforeEach } from "vitest";
import { processVinculos } from "./vinculos-processor.js";

vi.mock("./qualification.js", () => ({
  tryExtractVinculo: vi.fn(),
  checkVinculoPrazo: vi.fn(),
}));

import { tryExtractVinculo, checkVinculoPrazo } from "./qualification.js";

const mockTryExtract = tryExtractVinculo as ReturnType<typeof vi.fn>;
const mockCheckPrazo = checkVinculoPrazo as ReturnType<typeof vi.fn>;

function emptyResult() {
  return { semMaisEmpregos: false, vinculo: null, updatedVinculos: [], confirmouMaisEmpregos: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPrazo.mockResolvedValue(true);
});

describe("processVinculos", () => {
  it("returns vinculosOk: false without throwing given empty merged and 'nunca trabalhei de carteira'", async () => {
    mockTryExtract.mockResolvedValue({ ...emptyResult(), semMaisEmpregos: true });

    const result = await processVinculos({
      projetoId: "proj-1",
      merged: {},
      text: "nunca trabalhei de carteira",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculosOk).toBe(false);
    expect(result.state.vinculos).toHaveLength(0);
    expect(result.notasParaCriar).toHaveLength(0);
  });

  it("preserves vinculosOk: true when already set (skips LLM)", async () => {
    const result = await processVinculos({
      projetoId: "proj-1",
      merged: { _vinculos_ok: true },
      text: "alguma coisa",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculosOk).toBe(true);
    expect(mockTryExtract).not.toHaveBeenCalled();
  });

  it("returns empty mergedUpdates when nothing changed", async () => {
    const result = await processVinculos({
      projetoId: "proj-1",
      merged: { _vinculos_ok: true },
      text: null,
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates).toEqual({});
  });

  it("seeds vinculos[0] from flat empresa_recente and includes it in mergedUpdates", async () => {
    // Real tryExtractVinculo always echoes existing vinculos in updatedVinculos; mirror that here.
    mockTryExtract.mockImplementation(async (_proj, _text, vinculos) => ({
      semMaisEmpregos: false, vinculo: null, updatedVinculos: vinculos, confirmouMaisEmpregos: false,
    }));

    const result = await processVinculos({
      projetoId: "proj-1",
      merged: { empresa_recente: "TransABC", funcao_recente: "Motorista" },
      text: "algum texto",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculos[0]?.empresa).toBe("TransABC");
    expect(result.state.vinculos[0]?.funcao).toBe("Motorista");
    expect(result.mergedUpdates).toHaveProperty("vinculos");
  });

  it("sets _vinculos_todos_prescritos when first vínculo is prescribed", async () => {
    mockTryExtract.mockResolvedValue({
      ...emptyResult(),
      vinculo: { ordem: 1, empresa: "FreteCo", saida: "demitido", data_saida: "01/01/2020" },
      updatedVinculos: [],
    });
    mockCheckPrazo.mockResolvedValue(false);

    const result = await processVinculos({
      projetoId: "proj-1",
      merged: {},
      text: "saí da empresa em 2020",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.todosPrescritosFlag).toBe(true);
    expect(result.state.vinculosOk).toBe(true);
  });

  it("adds nota when enrichment occurs", async () => {
    const existing = [{ ordem: 1, empresa: "TransABC" }];
    mockTryExtract.mockResolvedValue({
      ...emptyResult(),
      updatedVinculos: [{ ordem: 1, empresa: "TransABC", funcao: "Motorista" }],
    });

    const result = await processVinculos({
      projetoId: "proj-1",
      merged: { vinculos: existing },
      text: "sou motorista",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.notasParaCriar.length).toBeGreaterThan(0);
    expect(result.notasParaCriar[0]).toContain("enriquecidos");
  });

  it("does not throw on LLM error — returns unchanged state", async () => {
    mockTryExtract.mockRejectedValue(new Error("LLM timeout"));

    const result = await processVinculos({
      projetoId: "proj-1",
      merged: { _vinculos_ok: false },
      text: "algum texto",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculosOk).toBe(false);
    expect(result.mergedUpdates).toEqual({});
  });
});
