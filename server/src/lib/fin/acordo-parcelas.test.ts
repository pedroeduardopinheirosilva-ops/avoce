import { describe, it, expect } from "vitest";
import { gerarParcelasAcordo } from "./acordo-parcelas.js";

const soma = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("gerarParcelasAcordo", () => {
  it("1.000,00 em 3x: resto de centavos na última; honorários 30% somam exatos", () => {
    const r = gerarParcelasAcordo({ valorTotalCentavos: 100_000, numParcelas: 3, primeiroVencimento: "2025-01-31", percHonorarios: 30 });
    expect(r.parcelas.map((p) => [p.numero, p.vencimento, p.valorCentavos, p.honorariosCentavos, p.repasseCentavos])).toEqual([
      [1, "2025-01-31", 33_333, 10_000, 23_333],
      [2, "2025-02-28", 33_333, 10_000, 23_333],
      [3, "2025-03-31", 33_334, 10_000, 23_334],
    ]);
    expect(r.totalHonorarios).toBe(30_000);
    expect(r.totalRepasse).toBe(70_000);
    expect(soma(r.parcelas.map((p) => p.valorCentavos))).toBe(100_000);
  });

  it("entrada + parcelas automáticas", () => {
    const r = gerarParcelasAcordo({
      valorTotalCentavos: 100_000, numParcelas: 3, primeiroVencimento: "2025-02-10",
      entrada: { valorCentavos: 20_000, vencimento: "2025-01-10" }, percHonorarios: "33.33",
    });
    expect(r.parcelas.map((p) => [p.numero, p.valorCentavos])).toEqual([[0, 20_000], [1, 26_666], [2, 26_666], [3, 26_668]]);
    expect(soma(r.parcelas.map((p) => p.honorariosCentavos))).toBe(33_330);
    expect(soma(r.parcelas.map((p) => p.repasseCentavos))).toBe(66_670);
  });

  it("valores informados manualmente; automáticas dividem o restante", () => {
    const r = gerarParcelasAcordo({ valorTotalCentavos: 100_000, numParcelas: 3, primeiroVencimento: "2025-01-05", valores: [null, 50_000, null] });
    expect(r.parcelas.map((p) => [p.valorCentavos, p.manual])).toEqual([[25_000, false], [50_000, true], [25_000, false]]);
    expect(r.totalHonorarios).toBe(0);
    expect(r.parcelas[0].repasseCentavos).toBe(25_000);
  });

  it("todas manuais precisam fechar o total", () => {
    expect(() => gerarParcelasAcordo({ valorTotalCentavos: 100_000, numParcelas: 2, primeiroVencimento: "2025-01-05", valores: [50_000, 40_000] }))
      .toThrow("não bate");
    expect(() => gerarParcelasAcordo({ valorTotalCentavos: 100_000, numParcelas: 2, primeiroVencimento: "2025-01-05", valores: [90_000, 20_000] }))
      .toThrow("ultrapassam");
  });

  it("vencimentos manuais e intervalo", () => {
    const r = gerarParcelasAcordo({
      valorTotalCentavos: 30_000, numParcelas: 3, primeiroVencimento: "2025-01-10", intervaloMeses: 2,
      vencimentos: [null, "2025-02-01"],
    });
    expect(r.parcelas.map((p) => p.vencimento)).toEqual(["2025-01-10", "2025-02-01", "2025-05-10"]);
  });
});
