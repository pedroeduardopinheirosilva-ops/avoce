import { describe, expect, it } from "vitest";
import { chaveOcorrencia, projetarRecorrencias, type OrigemRecorrente } from "./recorrencia.js";

const aluguel: OrigemRecorrente = {
  id: "o1", data: "2026-01-31", competencia: null, recorrenciaFimEm: null,
  valorCentavos: 300000, descricao: "Aluguel", categoria: "Estrutura",
  fontes: [{ fonteId: "f1", valorCentavos: 300000 }],
};

describe("projetarRecorrencias", () => {
  it("não repete o mês-base e ajusta o dia ao fim do mês", () => {
    const occ = projetarRecorrencias([aluguel], new Set(), { ano: 2026, mes: 1 }, { ano: 2026, mes: 4 });
    expect(occ.map((o) => [o.competencia, o.data])).toEqual([
      ["2026-02-01", "2026-02-28"],
      ["2026-03-01", "2026-03-31"],
      ["2026-04-01", "2026-04-30"],
    ]);
    expect(occ[0].fontes).toEqual([{ fonteId: "f1", valorCentavos: 300000 }]);
  });

  it("pula meses já lançados e respeita o fim da recorrência", () => {
    const ja = new Set([chaveOcorrencia("o1", { ano: 2026, mes: 3 })]);
    const occ = projetarRecorrencias([{ ...aluguel, recorrenciaFimEm: "2026-05-01" }], ja, { ano: 2026, mes: 1 }, { ano: 2026, mes: 12 });
    expect(occ.map((o) => o.mes)).toEqual([2, 4, 5]);
  });

  it("competência diferente da data mantém o deslocamento", () => {
    const o: OrigemRecorrente = { ...aluguel, data: "2026-11-05", competencia: "2026-10-01" };
    const occ = projetarRecorrencias([o], new Set(), { ano: 2026, mes: 11 }, { ano: 2026, mes: 12 });
    expect(occ.map((x) => [x.competencia, x.data])).toEqual([
      ["2026-11-01", "2026-12-05"],
      ["2026-12-01", "2027-01-05"],
    ]);
  });

  it("horizonte antes do início da série → nada", () => {
    expect(projetarRecorrencias([aluguel], new Set(), { ano: 2025, mes: 1 }, { ano: 2026, mes: 1 })).toEqual([]);
  });
});
