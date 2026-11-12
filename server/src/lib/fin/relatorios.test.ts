import { describe, expect, it } from "vitest";
import { agruparCategoriaMes, consumoPorFonte, montarDre, orcadoRealizado } from "./relatorios.js";
import { normalizarCategoriaDespesa } from "./categorias.js";
import { emReais } from "./saida.js";
import { analisarPathAnexo, nomeArquivoSeguro, pathAnexoDoEmitente } from "./anexos.js";
import { temModulo } from "./perm.js";
import { calLancamento } from "./lancamentos.js";

const jan = { ano: 2026, mes: 1 }, fev = { ano: 2026, mes: 2 };

describe("relatórios", () => {
  it("agrupa por categoria × mês e ignora fora do período", () => {
    const r = agruparCategoriaMes([
      { mes: jan, categoria: "Folha", valorCentavos: 100 },
      { mes: fev, categoria: "Folha", valorCentavos: 50 },
      { mes: fev, categoria: "Sistemas", valorCentavos: 10 },
      { mes: { ano: 2026, mes: 3 }, categoria: "Folha", valorCentavos: 999 },
    ], [jan, fev]);
    expect(r).toEqual([
      { categoria: "Folha", valores: [100, 50], total: 150 },
      { categoria: "Sistemas", valores: [0, 10], total: 10 },
    ]);
  });

  it("DRE: operacional + financeiro", () => {
    const d = montarDre({
      meses: [jan],
      receitas: [{ mes: jan, categoria: "Honorários — acordos", valorCentavos: 1000 }],
      despesas: [{ mes: jan, categoria: "Folha", valorCentavos: 400 }],
      financeiro: [{ mes: jan, categoria: "Juros empréstimo bancário", valorCentavos: -50 }],
    });
    expect(d.resultadoOperacional).toEqual([600]);
    expect(d.resultadoLiquido).toEqual([550]);
  });

  it("orçado × realizado com categorias fixas e estouro", () => {
    const r = orcadoRealizado({
      meses: [jan],
      categoriasFixas: ["Folha", "Marketing"],
      orcamentos: [{ mes: jan, categoria: "Folha", valorCentavos: 1000 }],
      realizados: [{ mes: jan, categoria: "Folha", valorCentavos: 1200 }, { mes: jan, categoria: "Outros", valorCentavos: 5 }],
    });
    expect(r.linhas.map((l) => l.categoria)).toEqual(["Folha", "Marketing", "Outros"]);
    expect(r.linhas[0].meses[0]).toEqual({ orcado: 1000, realizado: 1200, diferenca: -200, percentual: 120 });
    expect(r.linhas[2].total.percentual).toBeNull();
    expect(r.total.realizado).toBe(1205);
  });

  it("consumo por fonte × categoria", () => {
    const r = consumoPorFonte([
      { mes: jan, fonteId: "psa", categoria: "Folha", valorCentavos: 700 },
      { mes: jan, fonteId: "banco", categoria: "Folha", valorCentavos: 300 },
      { mes: fev, fonteId: "psa", categoria: "Sistemas", valorCentavos: 100 },
    ], [jan, fev]);
    expect(r.total).toBe(1100);
    expect(r.fontes[0]).toMatchObject({ fonteId: "psa", total: 800, porMes: [700, 100] });
    expect(r.totalPorMes).toEqual([1000, 100]);
  });

  it("normaliza categorias antigas", () => {
    expect(normalizarCategoriaDespesa("Pessoal")).toBe("Folha");
    expect(normalizarCategoriaDespesa("Software")).toBe("Sistemas");
    expect(normalizarCategoriaDespesa("")).toBe("Sem categoria");
    expect(normalizarCategoriaDespesa("Comissões")).toBe("Comissões");
  });
});

describe("emReais", () => {
  it("converte dinheiro e preserva chaves não monetárias", () => {
    expect(emReais({ ano: 2026, mes: 1, saldo: 12345, taxaPct: 1.1, qtdEmAtraso: 3, valores: [100, -50], percentual: 33.3, d: "x", ok: true, n: null }))
      .toEqual({ ano: 2026, mes: 1, saldo: 123.45, taxaPct: 1.1, qtdEmAtraso: 3, valores: [1, -0.5], percentual: 33.3, d: "x", ok: true, n: null });
    expect(emReais({ fontes: [{ fonteId: "f", valorCentavos: 150 }] })).toEqual({ fontes: [{ fonteId: "f", valor: 1.5 }] });
  });
});

describe("anexos", () => {
  it("aceita só fin/{emitente}/{AAAA-MM}/{arquivo}", () => {
    expect(analisarPathAnexo("fin/cm123/2026-11/1_abc_nota.pdf")).toMatchObject({ emitenteId: "cm123" });
    for (const p of ["fin/../x/2026-11/a.pdf", "/fin/a/2026-11/a.pdf", "fin/a/2026-11/../b.pdf", "fin/a/2026-11", "deals/a/2026-11/a.pdf", "fin/a/xx/a.pdf", "fin/a/2026-11/a b.pdf", "fin\\a\\2026-11\\a.pdf"]) {
      expect(analisarPathAnexo(p)).toBeNull();
    }
    expect(pathAnexoDoEmitente("fin/e1/2026-11/a.pdf", "e1")).toBe(true);
    expect(pathAnexoDoEmitente("fin/e1/2026-11/a.pdf", "e2")).toBe(false);
  });

  it("nome seguro", () => {
    expect(nomeArquivoSeguro("../../Comprovante Pix ção.PDF", "1_x")).toBe("1_x_Comprovante_Pix_cao.pdf");
  });
});

describe("permissões", () => {
  it("null/sem lista/admin = tudo; lista restringe", () => {
    expect(temModulo({ permissoes: null }, "financeiro_editar")).toBe(true);
    expect(temModulo({ permissoes: { emitentes: ["e"] } }, "financeiro_editar")).toBe(true);
    expect(temModulo({ role: "admin", permissoes: { modulos: [] } }, "financeiro_editar")).toBe(true);
    expect(temModulo({ permissoes: { modulos: ["financeiro"] } }, "financeiro_editar")).toBe(false);
    expect(temModulo({ permissoes: { modulos: ["financeiro"] } }, "financeiro_editar", "financeiro")).toBe(true);
  });
});

describe("calLancamento", () => {
  it("00:00 UTC (gravação antiga) vale o dia UTC; 12:00 UTC é o mesmo dia", () => {
    expect(calLancamento(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01");
    expect(calLancamento(new Date("2026-11-01T12:00:00.000Z"))).toBe("2026-11-01");
    expect(calLancamento(new Date("2026-11-01T02:00:00.000Z"))).toBe("2026-10-31");
  });
});
