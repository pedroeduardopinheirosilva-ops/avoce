import { describe, it, expect, vi, beforeEach } from "vitest";
import { processVinculos } from "./vinculos-processor.js";

vi.mock("./qualification.js", () => ({
  tryExtractVinculo: vi.fn(),
  checkVinculoPrazo: vi.fn(),
  // vinculos-processor agora importa também os derivadores de data de saída
  deriveDataSaida: vi.fn(() => null),
  deriveDataSaidaFromText: vi.fn(() => null),
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

  describe("gate _mais_empregos_perguntado (backward-compat via maisEmpregosPerguntado input)", () => {
    function completeVinculo(overrides: Record<string, unknown> = {}) {
      return {
        ordem: 1, empresa: "TransABC", funcao: "Motorista", vinculo: "CLT",
        saida: "demitido", tempo: "1 ano", horas_extras: "sim",
        pagamento_fora: "nao", injustica: "nao",
        ...overrides,
      };
    }

    it("flag = true (maisEmpregosPerguntado = true) → vinculos_ok setado ao receber semMaisEmpregos", async () => {
      const vinculo = completeVinculo();
      mockTryExtract.mockResolvedValue({
        ...emptyResult(),
        semMaisEmpregos: true,
        updatedVinculos: [vinculo],
      });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [vinculo] },
        text: "não, só trabalhei lá",
        history: [],
        maisEmpregosPerguntado: true, // flag = true equivalente
      });

      expect(result.state.vinculosOk).toBe(true);
      expect(result.mergedUpdates._vinculos_ok).toBe(true);
    });

    // Comportamento atual: a "trusted negation" foi removida. Quando semMaisEmpregos chega
    // ANTES de a pergunta mais_empregos ter sido feita (maisEmpregosPerguntado=false), o
    // processor NÃO fecha a coleta nem seta _mais_empregos_negado — a pergunta será feita
    // normalmente no próximo turno (negação implícita do LLM não é confiável).
    it("semMaisEmpregos + maisEmpregosPerguntado = false → NÃO fecha nem seta negado (negação implícita ignorada)", async () => {
      const vinculo = completeVinculo({ tempo: "10 meses" });
      mockTryExtract.mockResolvedValue({
        ...emptyResult(),
        semMaisEmpregos: true,
        updatedVinculos: [vinculo],
      });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [vinculo] },
        text: "não, só trabalhei lá",
        history: [],
        maisEmpregosPerguntado: false,
      });

      expect(result.state.vinculosOk).toBe(false);
      expect(result.mergedUpdates._mais_empregos_negado).toBeUndefined();
    });

    it("flag = false + tempo >= 24m → ainda assim NÃO fecha (pergunta não foi feita)", async () => {
      const vinculo = completeVinculo({ tempo: "3 anos" });
      mockTryExtract.mockResolvedValue({
        ...emptyResult(),
        semMaisEmpregos: true,
        updatedVinculos: [vinculo],
      });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [vinculo] },
        text: "não, só trabalhei lá",
        history: [],
        maisEmpregosPerguntado: false,
      });

      // Fechamento com 1 vínculo só ocorre via semMaisEmpregos COM maisEmpregosPerguntado=true
      expect(result.state.vinculosOk).toBe(false);
    });
  });

  describe("_mais_empregos_negado flag (Bug A regression)", () => {
    function completeVinculo(overrides: Record<string, unknown> = {}) {
      return {
        ordem: 1, empresa: "TransABC", funcao: "Motorista", vinculo: "CLT",
        saida: "demitido", tempo: "1 ano", horas_extras: "sim",
        pagamento_fora: "nao", injustica: "nao",
        ...overrides,
      };
    }

    it("cenário 1 — semMaisEmpregos + vínculo completo → vinculos_ok + negado", async () => {
      const vinculo = completeVinculo();
      mockTryExtract.mockResolvedValue({ ...emptyResult(), semMaisEmpregos: true, updatedVinculos: [vinculo] });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [vinculo] },
        text: "não",
        history: [],
        maisEmpregosPerguntado: true,
      });

      expect(result.state.vinculosOk).toBe(true);
      expect(result.mergedUpdates._mais_empregos_negado).toBe(true);
    });

    it("cenário 2 — semMaisEmpregos + vínculo incompleto (sem saida) → vinculos_ok false + negado true", async () => {
      const incompleto = { ordem: 1, empresa: "TransABC", vinculo: "CLT" }; // sem saida
      mockTryExtract.mockResolvedValue({ ...emptyResult(), semMaisEmpregos: true, updatedVinculos: [incompleto] });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [incompleto] },
        text: "não",
        history: [],
        maisEmpregosPerguntado: true,
      });

      expect(result.state.vinculosOk).toBe(false);
      expect(result.mergedUpdates._mais_empregos_negado).toBe(true);
    });

    it("cenário 4 — semMaisEmpregos com maisEmpregosPerguntado=false → negado NÃO é setado (aguarda pergunta)", async () => {
      // Comportamento atual: a flag _mais_empregos_negado só é setada quando a pergunta
      // mais_empregos foi explicitamente feita (maisEmpregosPerguntado=true). Negação
      // implícita detectada pelo LLM antes da pergunta não fecha a coleta.
      const vinculo = completeVinculo();
      mockTryExtract.mockResolvedValue({ ...emptyResult(), semMaisEmpregos: true, updatedVinculos: [vinculo] });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [vinculo] },
        text: "não trabalhei em outro lugar",
        history: [],
        maisEmpregosPerguntado: false,
      });

      expect(result.mergedUpdates._mais_empregos_negado).toBeUndefined();
      expect(result.state.vinculosOk).toBe(false);
    });
  });

  describe("auto-close parcial — lead impaciente no vínculo anterior", () => {
    // Vínculo principal completo + vínculo anterior com mínimo (empresa+vinculo+saida)
    function vinculoPrincipal(): Record<string, unknown> {
      return {
        ordem: 1, empresa: "Transnorte SA", funcao: "Motorista", vinculo: "CLT",
        saida: "demitido", data_saida: "30/03/2026", tempo: "8 meses",
        horas_extras: "sim", pagamento_fora: "sim", injustica: "sim",
      };
    }
    function vinculoAnteriorMinimo(): Record<string, unknown> {
      return {
        ordem: 2, empresa: "ABC Limitada", funcao: "carreteiro",
        vinculo: "CLT", saida: "15/05/2025", tempo: "7 anos",
        // horas_extras, pagamento_fora, injustica ausentes — lead ficou impaciente
      };
    }

    it("2 vínculos com v2 incompleto + _mais_empregos_perguntado=true → NÃO auto-fecha (exige todosCompletos)", async () => {
      // Comportamento atual: o auto-close parcial foi removido — o auto-close exige
      // 2+ vínculos TODOS completos (todosCompletos). Vínculo anterior só com o mínimo
      // (sem horas_extras/pagamento_fora/injustica) não fecha mais a coleta aqui;
      // o fechamento por impaciência é tratado via _q_skipped (mais_empregos 2× sem resposta).
      const v1 = vinculoPrincipal();
      const v2 = vinculoAnteriorMinimo();
      mockTryExtract.mockResolvedValue({ ...emptyResult(), updatedVinculos: [v1, v2] });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [v1, v2], _mais_empregos_perguntado: true },
        text: "tá bom",
        history: [],
        maisEmpregosPerguntado: true,
      });

      expect(result.state.vinculosOk).toBe(false);
      expect(result.mergedUpdates._vinculos_ok).toBeUndefined();
    });

    it("2 vínculos com mínimo mas _mais_empregos_perguntado=false → NÃO auto-fecha", async () => {
      const v1 = vinculoPrincipal();
      const v2 = vinculoAnteriorMinimo();
      mockTryExtract.mockResolvedValue({ ...emptyResult(), updatedVinculos: [v1, v2] });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [v1, v2] },
        text: "tá bom",
        history: [],
        maisEmpregosPerguntado: false,
      });

      expect(result.state.vinculosOk).toBe(false);
    });

    it("1 vínculo com mínimo + _mais_empregos_perguntado=true → NÃO auto-fecha (exige 2+)", async () => {
      // Vínculo parcial: tem empresa+vinculo+saida mas falta horas_extras/pagamento_fora/injustica
      // → todosCompletos=false (bloco normal não fecha) E length<2 (parcial não fecha)
      const v1parcial = {
        ordem: 1, empresa: "Transnorte SA", funcao: "Motorista",
        vinculo: "CLT", saida: "demitido", tempo: "8 meses",
      };
      mockTryExtract.mockResolvedValue({ ...emptyResult(), updatedVinculos: [v1parcial] });

      const result = await processVinculos({
        projetoId: "proj-1",
        merged: { vinculos: [v1parcial], _mais_empregos_perguntado: true },
        text: "tá bom",
        history: [],
        maisEmpregosPerguntado: true,
      });

      expect(result.state.vinculosOk).toBe(false);
    });
  });

  describe("buildFlatSync — campos emprego_anterior_* sempre sobrescrevem de vinculos[1]", () => {
    const v0 = {
      ordem: 1, empresa: "Transnorte SA", funcao: "Motorista", vinculo: "CLT",
      saida: "demitido", tempo: "8 meses", horas_extras: "sim", pagamento_fora: "nao", injustica: "nao",
    };
    const v1abc = {
      ordem: 2, empresa: "Transportadora ABC Limitada", funcao: "Carreteiro",
      vinculo: "CLT", saida: "15/05/2025", tempo: "7 anos",
    };

    it("sobrescreve emprego_anterior_empresa stale quando vinculos[1] tem dado correto", async () => {
      const result = await processVinculos({
        projetoId: "proj-flat1",
        merged: {
          _vinculos_ok: true,
          vinculos: [v0, v1abc],
          emprego_anterior_empresa: "Transnorte SA", // stale — deve ser sobrescrito
          emprego_anterior_tempo: "8 meses",
          empresa_anterior: "Transnorte SA",
        },
        text: null,
        history: [],
        maisEmpregosPerguntado: true,
      });

      expect(result.mergedUpdates.emprego_anterior_empresa).toBe("Transportadora ABC Limitada");
      expect(result.mergedUpdates.emprego_anterior_tempo).toBe("7 anos");
      expect(result.mergedUpdates.empresa_anterior).toBe("Transportadora ABC Limitada");
    });

    it("não seta emprego_anterior_empresa quando há só um vínculo (sem v1)", async () => {
      const result = await processVinculos({
        projetoId: "proj-flat2",
        merged: { _vinculos_ok: true, vinculos: [v0] },
        text: null,
        history: [],
        maisEmpregosPerguntado: false,
      });

      expect(result.mergedUpdates.emprego_anterior_empresa).toBeUndefined();
    });

    it("recovery seed: adiciona vinculos[1] quando _mais_empregos_confirmado=true e emprego_anterior_empresa diferente", async () => {
      mockTryExtract.mockResolvedValue({
        vinculo: null,
        semMaisEmpregos: false,
        updatedVinculos: [v0],
        confirmouMaisEmpregos: false,
      });
      const result = await processVinculos({
        projetoId: "proj-seed-v1",
        merged: {
          vinculos: [v0],
          _mais_empregos_confirmado: true,
          emprego_anterior_empresa: "Azul Ltda",
          emprego_anterior_tempo: "7 anos",
          emprego_anterior_saida: "março de 2025",
        },
        text: "mais de 7 anos",
        history: [],
        maisEmpregosPerguntado: true,
      });
      const vinculosResult = result.mergedUpdates.vinculos as any[];
      expect(vinculosResult).toHaveLength(2);
      expect(vinculosResult[1].empresa).toBe("Azul Ltda");
      expect(vinculosResult[1].tempo).toBe("7 anos");
    });

    it("recovery seed: não duplica quando emprego_anterior_empresa é igual a vinculos[0]", async () => {
      mockTryExtract.mockResolvedValue({
        vinculo: null,
        semMaisEmpregos: false,
        updatedVinculos: [v0],
        confirmouMaisEmpregos: false,
      });
      const result = await processVinculos({
        projetoId: "proj-seed-v1-same",
        merged: {
          vinculos: [v0],
          _mais_empregos_confirmado: true,
          emprego_anterior_empresa: v0.empresa, // mesma empresa — não deve criar v1
        },
        text: "mais de 7 anos",
        history: [],
        maisEmpregosPerguntado: true,
      });
      const vinculosResult = (result.mergedUpdates.vinculos ?? [v0]) as any[];
      expect(vinculosResult).toHaveLength(1);
    });

    it("não sobrescreve empresa_recente (v0-derived, guarda falsy mantida)", async () => {
      const result = await processVinculos({
        projetoId: "proj-flat3",
        merged: {
          _vinculos_ok: true,
          vinculos: [v0],
          empresa_recente: "JaDefinida", // deve permanecer intacta
        },
        text: null,
        history: [],
        maisEmpregosPerguntado: false,
      });

      expect(result.mergedUpdates.empresa_recente).toBeUndefined();
    });
  });
});
