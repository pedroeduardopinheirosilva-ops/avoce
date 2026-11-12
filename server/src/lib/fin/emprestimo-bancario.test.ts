import { describe, it, expect } from "vitest";
import { cronogramaEmprestimoBancario, jurosNoPeriodo, prestacaoPrice, saldoDevedorNaData, taxaMensalBancaria } from "./emprestimo-bancario.js";
import { montarTabela } from "./indices.js";

const selic1 = montarTabela([{ ano: 2025, mes: 1, taxaPct: 1 }]);
const base = {
  dataContratacao: "2025-01-15", valorCentavos: 1_000_000, carenciaMeses: 0,
  carenciaModo: "juros_pagos" as const, numParcelas: 4, spreadAnualPct: 0,
};

describe("taxaMensalBancaria", () => {
  it("(1+selic)×(1+spread)^(1/12) − 1", () => {
    expect(taxaMensalBancaria(1, 6)).toBeCloseTo(1.01 * Math.pow(1.06, 1 / 12) - 1, 12);
    expect(taxaMensalBancaria(1, 6)).toBeCloseTo(0.0149162, 6);
    expect(taxaMensalBancaria(1, 0)).toBeCloseTo(0.01, 12);
  });
});

describe("cronogramaEmprestimoBancario", () => {
  it("SAC sem carência (10.000 em 4x a 1%)", () => {
    const c = cronogramaEmprestimoBancario({ ...base, sistema: "sac" }, selic1);
    expect(c.linhas.map((l) => [l.juros, l.amortizacao, l.prestacao, l.saldoFinal])).toEqual([
      [10_000, 250_000, 260_000, 750_000],
      [7_500, 250_000, 257_500, 500_000],
      [5_000, 250_000, 255_000, 250_000],
      [2_500, 250_000, 252_500, 0],
    ]);
    expect(c.totalJuros).toBe(25_000);
    expect(c.linhas[1].projetado).toBe(true); // fev sem Selic → projetada
    expect(c.linhas[0].vencimento).toBe("2025-02-15");
  });

  it("Price sem carência: prestação ~constante com taxa constante, quita o saldo", () => {
    const c = cronogramaEmprestimoBancario({ ...base, sistema: "price" }, selic1);
    expect(prestacaoPrice(1_000_000, 0.01, 4)).toBe(256_281);
    expect(c.linhas[0]).toMatchObject({ juros: 10_000, amortizacao: 246_281, prestacao: 256_281, saldoFinal: 753_719 });
    for (const l of c.linhas) expect(Math.abs(l.prestacao - 256_281)).toBeLessThanOrEqual(2);
    expect(c.linhas[3].saldoFinal).toBe(0);
    expect(c.totalAmortizado).toBe(1_000_000);
  });

  it("carência com juros pagos: saldo constante, juros saem do caixa", () => {
    const c = cronogramaEmprestimoBancario({ ...base, carenciaMeses: 2, numParcelas: 2, sistema: "sac" }, selic1);
    expect(c.linhas.map((l) => [l.fase, l.juros, l.prestacao, l.saldoFinal])).toEqual([
      ["carencia", 10_000, 10_000, 1_000_000],
      ["carencia", 10_000, 10_000, 1_000_000],
      ["amortizacao", 10_000, 510_000, 500_000],
      ["amortizacao", 5_000, 505_000, 0],
    ]);
    expect(c.saldoFimCarencia).toBe(1_000_000);
  });

  it("carência com juros capitalizados: juros somam ao saldo", () => {
    const c = cronogramaEmprestimoBancario(
      { ...base, carenciaMeses: 2, carenciaModo: "capitalizados", numParcelas: 2, sistema: "sac" }, selic1);
    expect(c.linhas[0]).toMatchObject({ juros: 10_000, jurosCapitalizados: 10_000, prestacao: 0, saldoFinal: 1_010_000 });
    expect(c.linhas[1]).toMatchObject({ juros: 10_100, prestacao: 0, saldoFinal: 1_020_100 });
    expect(c.saldoFimCarencia).toBe(1_020_100);
    expect(c.linhas[2]).toMatchObject({ amortizacao: 510_050, juros: 10_201 });
    expect(c.linhas[3].saldoFinal).toBe(0);
    expect(c.totalAmortizado).toBe(1_020_100);
  });

  it("Selic real nos meses publicados, projetada nos futuros; spread aplicado", () => {
    const tab = montarTabela([{ ano: 2025, mes: 1, taxaPct: 1 }, { ano: 2025, mes: 2, taxaPct: 2 }]);
    const c = cronogramaEmprestimoBancario({ ...base, sistema: "sac", spreadAnualPct: 6 }, tab);
    expect(c.linhas.map((l) => [l.refMes, l.selicPct, l.projetado])).toEqual([
      [1, 1, false], [2, 2, false], [3, 2, true], [4, 2, true],
    ]);
    expect(c.linhas[0].juros).toBe(Math.round(1_000_000 * taxaMensalBancaria(1, 6))); // 14.916,23 → 14.916
  });

  it("IOF e tarifas como custo de contratação; consultas por data", () => {
    const c = cronogramaEmprestimoBancario({ ...base, sistema: "sac", iofCentavos: 3_800, tarifasCentavos: 1_200 }, selic1);
    expect(c.custoContratacao).toBe(5_000);
    expect(c.valorLiquidoRecebido).toBe(995_000);
    expect(c.custoTotal).toBe(30_000);
    expect(saldoDevedorNaData(c, 1_000_000, "2025-02-14")).toBe(1_000_000);
    expect(saldoDevedorNaData(c, 1_000_000, "2025-03-15")).toBe(500_000);
    expect(jurosNoPeriodo(c, "2025-02-01", "2025-03-31")).toBe(17_500);
  });
});
