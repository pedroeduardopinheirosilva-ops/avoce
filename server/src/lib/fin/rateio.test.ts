import { describe, expect, it } from "vitest";
import { ErroRateio, distribuirProporcional, reescalarRateio, resolverRateio } from "./rateio.js";

describe("resolverRateio", () => {
  it("por valor: soma exata", () => {
    const r = resolverRateio(100000, [{ fonteId: "a", valor: 600 }, { fonteId: "b", valor: "400.00" }]);
    expect(r).toEqual([
      { fonteId: "a", valorCentavos: 60000, percentual: 60 },
      { fonteId: "b", valorCentavos: 40000, percentual: 40 },
    ]);
  });

  it("por valor: soma diferente do total é erro", () => {
    expect(() => resolverRateio(100000, [{ fonteId: "a", valor: 600 }, { fonteId: "b", valor: 399.99 }])).toThrow(ErroRateio);
  });

  it("por percentual: arredondamento vai para o maior item e fecha exato", () => {
    const r = resolverRateio(10000, [
      { fonteId: "a", percentual: 33.3333 },
      { fonteId: "b", percentual: 33.3333 },
      { fonteId: "c", percentual: 33.3334 },
    ]);
    expect(r.reduce((a, i) => a + i.valorCentavos, 0)).toBe(10000);
    expect(r.map((i) => i.valorCentavos).sort()).toEqual([3333, 3333, 3334]);
  });

  it("por percentual: soma != 100% é erro", () => {
    expect(() => resolverRateio(10000, [{ fonteId: "a", percentual: 50 }, { fonteId: "b", percentual: 49 }])).toThrow(/100%/);
  });

  it("misto: valor fixo + percentual do total", () => {
    const r = resolverRateio(100000, [{ fonteId: "a", valor: 250 }, { fonteId: "b", percentual: 75 }]);
    expect(r.map((i) => i.valorCentavos)).toEqual([25000, 75000]);
  });

  it("fonte repetida, vazio, item sem valor/percentual", () => {
    expect(() => resolverRateio(100, [])).toThrow(/ao menos uma/);
    expect(() => resolverRateio(100, [{ fonteId: "a", valor: 0.5 }, { fonteId: "a", valor: 0.5 }])).toThrow(/repetida/);
    expect(() => resolverRateio(100, [{ fonteId: "a" }])).toThrow(/valor ou percentual/);
  });

  it("uma fonte com 100%", () => {
    expect(resolverRateio(12345, [{ fonteId: "x", percentual: 100 }])).toEqual([{ fonteId: "x", valorCentavos: 12345, percentual: 100 }]);
  });
});

describe("distribuirProporcional / reescalarRateio", () => {
  it("maiores restos, soma exata", () => {
    expect(distribuirProporcional(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(distribuirProporcional(1001, [600, 400]).reduce((a, b) => a + b, 0)).toBe(1001);
  });

  it("reescala mantendo proporção", () => {
    const r = reescalarRateio([{ fonteId: "a", valorCentavos: 60000 }, { fonteId: "b", valorCentavos: 40000 }], 50001);
    expect(r.map((i) => i.valorCentavos)).toEqual([30001, 20000]);
    expect(r[0].percentual).toBeCloseTo(60.0008, 3);
  });
});
