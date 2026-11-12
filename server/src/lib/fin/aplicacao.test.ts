import { describe, it, expect } from "vitest";
import {
  aliquotaIrRegressivo, custoLiquidoEmprestimo, extratoAplicacao, irSugerido, resgatesPorFonte,
  saldoAplicacao, sugerirRendimentoMes, type MovAplicacao,
} from "./aplicacao.js";
import { montarTabela } from "./indices.js";

const movs: MovAplicacao[] = [
  { tipo: "aplicacao", data: "2025-05-10", valorCentavos: 1_000_000 },
  { tipo: "rendimento", data: "2025-05-31", valorCentavos: 10_000 },
  { tipo: "ir", data: "2025-05-31", valorCentavos: 2_250 },
  { tipo: "resgate", data: "2025-06-10", valorCentavos: 300_000, fonteId: "f1" },
];
const tabelas = {
  selic: montarTabela([{ ano: 2025, mes: 6, taxaPct: 1.1 }]),
  cdi: montarTabela([{ ano: 2025, mes: 6, taxaPct: 1 }]),
};

describe("aplicação", () => {
  it("saldo e totais", () => {
    expect(saldoAplicacao(movs)).toEqual({
      saldo: 707_750, aplicado: 1_000_000, resgatado: 300_000, rendimentoBruto: 10_000, ir: 2_250, rendimentoLiquido: 7_750,
    });
    expect(saldoAplicacao(movs, "2025-05-31").saldo).toBe(1_007_750);
  });

  it("rendimento sugerido: saldo no início do mês × 102% do CDI", () => {
    const r = sugerirRendimentoMes({ movs, indexador: "cdi", percentualIndexador: 102, tabelas, ano: 2025, mes: 6 });
    // 10.077,50 × 1,02% = 102,7905 → 102,79
    expect(r).toMatchObject({ saldoBase: 1_007_750, taxaPct: 1.02, projetado: false, valorCentavos: 10_279 });
    const s = sugerirRendimentoMes({ movs, indexador: "selic", percentualIndexador: 100, tabelas, ano: 2025, mes: 7 });
    expect(s.projetado).toBe(true);
  });

  it("IR regressivo", () => {
    expect(aliquotaIrRegressivo(100)).toBe(22.5);
    expect(aliquotaIrRegressivo(181)).toBe(20);
    expect(aliquotaIrRegressivo(721)).toBe(15);
    expect(irSugerido(10_000, 30)).toBe(2_250);
  });

  it("resgates por fonte e extrato mensal", () => {
    expect(resgatesPorFonte([...movs, { tipo: "resgate", data: "2025-06-20", valorCentavos: 100 }])).toEqual({ f1: 300_000, sem_fonte: 100 });
    const ex = extratoAplicacao(movs);
    expect(ex.map((l) => [l.mes, l.saldoAnterior, l.saldoAtual])).toEqual([[5, 0, 1_007_750], [6, 1_007_750, 707_750]]);
  });

  it("custo líquido do empréstimo = juros − rendimento líquido de IR", () => {
    expect(custoLiquidoEmprestimo({ jurosIncorridosCentavos: 25_000, rendimentoBrutoCentavos: 10_000, irCentavos: 2_250 }))
      .toEqual({ jurosIncorridos: 25_000, rendimentoBruto: 10_000, ir: 2_250, rendimentoLiquido: 7_750, custoLiquido: 17_250 });
  });
});
