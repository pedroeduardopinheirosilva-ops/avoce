import { describe, it, expect } from "vitest";
import { buscarSgs, montarTabela, parseSgs, taxaDoMes, ultimoMesConhecido, urlSgs } from "./indices.js";

const SGS = [
  { data: "01/04/2025", valor: "1.06" },
  { data: "01/05/2025", valor: "1.14" },
  { data: "01/06/2025", valor: "1.10" },
  { data: "lixo", valor: "1" },
  { data: "01/07/2025" }, // sem valor
];

describe("parseSgs", () => {
  it("converte e ignora itens malformados", () => {
    expect(parseSgs(SGS, "selic")).toEqual([
      { indice: "selic", ano: 2025, mes: 4, taxaPct: 1.06 },
      { indice: "selic", ano: 2025, mes: 5, taxaPct: 1.14 },
      { indice: "selic", ano: 2025, mes: 6, taxaPct: 1.1 },
    ]);
  });
  it("erro se não for lista", () => {
    expect(() => parseSgs({ erro: "x" }, "cdi")).toThrow();
  });
});

describe("taxaDoMes", () => {
  const tab = montarTabela(parseSgs(SGS, "selic"));
  it("mês publicado", () => {
    expect(taxaDoMes(tab, 2025, 5)).toEqual({ taxaPct: 1.14, projetado: false, base: { ano: 2025, mes: 5 } });
  });
  it("mês sem taxa publicada projeta pela última conhecida", () => {
    expect(taxaDoMes(tab, 2025, 9)).toEqual({ taxaPct: 1.1, projetado: true, base: { ano: 2025, mes: 6 } });
  });
  it("antes de tudo usa a mais antiga; tabela vazia → null", () => {
    expect(taxaDoMes(tab, 2024, 1)?.base).toEqual({ ano: 2025, mes: 4 });
    expect(taxaDoMes(montarTabela([]), 2025, 1)).toBeNull();
    expect(ultimoMesConhecido(tab)).toEqual({ ano: 2025, mes: 6 });
  });
});

describe("buscarSgs", () => {
  it("monta a URL da série e faz o parse", async () => {
    expect(urlSgs("cdi", "2025-01-01", "2025-06-30")).toBe(
      "https://api.bcb.gov.br/dados/serie/bcdata.sgs.4391/dados?formato=json&dataInicial=01/01/2025&dataFinal=30/06/2025",
    );
    let url = "";
    const fake = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify(SGS), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await buscarSgs("selic", "2025-04-01", "2025-06-30", fake);
    expect(url).toContain("bcdata.sgs.4390");
    expect(r).toHaveLength(3);
  });
  it("HTTP de erro lança", async () => {
    const fake = (async () => new Response("x", { status: 503 })) as unknown as typeof fetch;
    await expect(buscarSgs("selic", "2025-04-01", "2025-06-30", fake)).rejects.toThrow("503");
  });
});

describe("apenasMesesFechados", () => {
  it("descarta o mês corrente (acumulado parcial do SGS) e futuros", async () => {
    const { apenasMesesFechados } = await import("./indices.js");
    const t = [{ ano: 2026, mes: 10, taxaPct: 1.07 }, { ano: 2026, mes: 11, taxaPct: 0.36 }, { ano: 2026, mes: 12, taxaPct: 1 }];
    expect(apenasMesesFechados(t, "2026-11-12")).toEqual([{ ano: 2026, mes: 10, taxaPct: 1.07 }]);
    expect(apenasMesesFechados(t, "2026-12-01").map((x) => x.mes)).toEqual([10, 11]);
    expect(apenasMesesFechados(t, "2027-01-01").length).toBe(3);
  });
});
