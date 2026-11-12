import { describe, it, expect } from "vitest";
import { caixaDisponivel, calcularHonorarios, diasEmAtraso, statusRecebimento, totalizarRecebimentos } from "./recebimento.js";

describe("calcularHonorarios", () => {
  it("honorários contratuais + repasse; sucumbência separada", () => {
    expect(calcularHonorarios({ valorBrutoCentavos: 1_000_000, percHonorarios: 30, valorSucumbenciaCentavos: 150_000 })).toEqual({
      bruto: 1_000_000, honorarios: 300_000, repasse: 700_000, sucumbencia: 150_000,
      receitaEscritorio: 450_000, valoresTerceiros: 700_000, totalRecebido: 1_150_000, nfValorSugerido: 450_000,
    });
  });
  it("honorário informado prevalece; nao_aplicavel = sem repasse", () => {
    expect(calcularHonorarios({ valorBrutoCentavos: 100_000, percHonorarios: 30, honorariosInformadosCentavos: 25_000 }).repasse).toBe(75_000);
    expect(calcularHonorarios({ valorBrutoCentavos: 100_000, percHonorarios: 30, repasseStatus: "nao_aplicavel" }))
      .toMatchObject({ honorarios: 100_000, repasse: 0 });
    expect(() => calcularHonorarios({ valorBrutoCentavos: 100, honorariosInformadosCentavos: 200 })).toThrow();
  });
});

describe("status derivado", () => {
  const hoje = "2025-06-10";
  it("prevista / em_atraso / recebida", () => {
    expect(statusRecebimento({ vencimento: "2025-06-10" }, hoje)).toBe("prevista");
    expect(statusRecebimento({ vencimento: "2025-06-09" }, hoje)).toBe("em_atraso");
    expect(statusRecebimento({ vencimento: "2025-06-01", dataRecebimento: "2025-06-05" }, hoje)).toBe("recebida");
    expect(statusRecebimento({}, hoje)).toBe("prevista");
    expect(diasEmAtraso({ vencimento: "2025-06-01" }, hoje)).toBe(9);
  });
});

describe("totalizarRecebimentos", () => {
  it("receita do escritório × valores de terceiros", () => {
    const t = totalizarRecebimentos(
      [
        { dataRecebimento: "2025-06-01", valorBrutoCentavos: 100_000, valorHonorariosCentavos: 30_000, valorRepasseCentavos: 70_000,
          valorSucumbenciaCentavos: 10_000, repasseStatus: "pendente", nfStatus: "a_emitir" },
        { dataRecebimento: "2025-06-02", valorBrutoCentavos: 50_000, valorHonorariosCentavos: 15_000, valorRepasseCentavos: 35_000,
          repasseStatus: "realizado", nfStatus: "emitida" },
        { vencimento: "2025-06-05", valorPrevistoCentavos: 40_000, repasseStatus: "pendente", nfStatus: "a_emitir" },
        { vencimento: "2025-07-05", valorPrevistoCentavos: 40_000, repasseStatus: "pendente", nfStatus: "a_emitir" },
      ],
      "2025-06-10",
    );
    expect(t).toEqual({
      qtd: 4, qtdRecebidas: 2, qtdEmAtraso: 1, previstoAReceber: 80_000, emAtraso: 40_000,
      recebidoBruto: 150_000, sucumbencia: 10_000, receitaEscritorio: 55_000,
      repassePendente: 70_000, repasseRealizado: 35_000, qtdSemNf: 1,
    });
    expect(caixaDisponivel(200_000, t.repassePendente)).toBe(130_000);
  });
});
