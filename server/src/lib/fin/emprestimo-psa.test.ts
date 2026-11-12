import { describe, it, expect } from "vitest";
import { extratoEmprestimoPsa, saldoPsaNoMes } from "./emprestimo-psa.js";
import { montarTabela } from "./indices.js";

const selic1 = montarTabela([
  { ano: 2025, mes: 6, taxaPct: 1 },
  { ano: 2025, mes: 7, taxaPct: 1 },
  { ano: 2025, mes: 8, taxaPct: 1 },
]);

describe("extratoEmprestimoPsa", () => {
  it("aporte no meio do mês corrige pro rata (16/06 → 15/30 dias)", () => {
    const ex = extratoEmprestimoPsa([{ tipo: "aporte", data: "2025-06-16", valorCentavos: 1_000_000 }], {
      selic: selic1, ate: { ano: 2025, mes: 7 },
    });
    // junho: 10.000 × (1,01^(15/30) − 1) = 49,8756 → 49,88
    expect(ex.linhas[0]).toMatchObject({ saldoAnterior: 0, aportes: 1_000_000, correcao: 4988, amortizacoes: 0, saldoAtual: 1_004_988 });
    // julho cheio: 10.049,88 × 1% = 100,4988 → 100,50
    expect(ex.linhas[1]).toMatchObject({ saldoAnterior: 1_004_988, correcao: 10050, saldoAtual: 1_015_038, projetado: false });
    expect(ex.saldoFinal).toBe(1_015_038);
  });

  it("aporte no dia 1 corrige o mês cheio", () => {
    const ex = extratoEmprestimoPsa([{ tipo: "aporte", data: "2025-06-01", valorCentavos: 100_000 }], { selic: selic1 });
    expect(ex.linhas[0].correcao).toBe(1000);
  });

  it("amortização parcial atravessa dois aportes (FIFO)", () => {
    const ex = extratoEmprestimoPsa(
      [
        { id: "A", tipo: "aporte", data: "2025-06-01", valorCentavos: 100_000 },
        { id: "B", tipo: "aporte", data: "2025-07-01", valorCentavos: 200_000 },
        { tipo: "amortizacao", data: "2025-08-01", valorCentavos: 150_000 },
      ],
      { selic: selic1 },
    );
    // jun: A 1.000 → 1.010; jul: A 1.020,10, B 2.020,00; ago: abate A inteiro (1.020,10) + 479,90 de B
    expect(ex.linhas.map((l) => l.saldoAtual)).toEqual([101_000, 304_010, 155_550]);
    expect(ex.linhas[2]).toMatchObject({ saldoAnterior: 304_010, amortizacoes: 150_000, correcao: 1540 });
    const [a, b] = ex.lotes;
    expect(a).toMatchObject({ origemId: "A", amortizado: 102_010, saldo: 0 });
    expect(b).toMatchObject({ origemId: "B", amortizado: 47_990, saldo: 155_550 });
    for (const l of ex.linhas) expect(l.saldoAnterior + l.aportes + l.correcao - l.amortizacoes).toBe(l.saldoAtual);
    expect(ex.totalAportado - ex.totalAmortizado + ex.totalCorrecao).toBe(ex.saldoFinal);
  });

  it("amortização no meio do mês: corrige até a véspera, depois o restante", () => {
    // selic 0 em junho para isolar julho (31 dias, 1%)
    const tab = montarTabela([{ ano: 2025, mes: 7, taxaPct: 1 }]);
    const ex = extratoEmprestimoPsa(
      [
        { tipo: "aporte", data: "2025-07-01", valorCentavos: 1_000_000 },
        { tipo: "devolucao", data: "2025-07-11", valorCentavos: 500_000 },
      ],
      { selic: tab },
    );
    // 10 dias: 10.000 × (1,01^(10/31) − 1) = 32,149 → 32,15; abate 5.000 → 5.032,15;
    // 21 dias: 5.032,15 × (1,01^(21/31) − 1) = 34,034 → 34,03
    expect(ex.linhas[0]).toMatchObject({ correcao: 3215 + 3403, amortizacoes: 500_000, saldoAtual: 503_215 + 3403 });
  });

  it("mês sem Selic publicada projeta pela última e sinaliza", () => {
    const ex = extratoEmprestimoPsa([{ tipo: "aporte", data: "2025-08-01", valorCentavos: 100_000 }], {
      selic: selic1, ate: { ano: 2025, mes: 9 },
    });
    expect(ex.linhas[1]).toMatchObject({ ano: 2025, mes: 9, projetado: true, taxaPct: 1, correcao: 1010 });
  });

  it("aporte previsto entra na projeção e pode ser excluído", () => {
    const movs = [
      { tipo: "aporte" as const, data: "2025-06-01", valorCentavos: 100_000 },
      { tipo: "aporte" as const, data: "2025-07-01", valorCentavos: 100_000, previsto: true },
    ];
    const com = extratoEmprestimoPsa(movs, { selic: selic1 });
    expect(com.linhas[1].temPrevisto).toBe(true);
    expect(com.saldoFinal).toBe(102_010 + 101_000);
    expect(saldoPsaNoMes(movs, selic1, { ano: 2025, mes: 7 }, false)).toBe(102_010);
  });

  it("amortização maior que o saldo abate só o saldo e avisa", () => {
    const ex = extratoEmprestimoPsa(
      [
        { tipo: "aporte", data: "2025-06-01", valorCentavos: 100_000 },
        { tipo: "amortizacao", data: "2025-06-30", valorCentavos: 999_999 },
      ],
      { selic: montarTabela([{ ano: 2025, mes: 6, taxaPct: 0 }]) },
    );
    expect(ex.saldoFinal).toBe(0);
    expect(ex.linhas[0].amortizacoes).toBe(100_000);
    expect(ex.avisos.some((a) => a.includes("excede"))).toBe(true);
  });
});
