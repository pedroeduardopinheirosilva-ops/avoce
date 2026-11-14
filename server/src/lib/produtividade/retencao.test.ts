import { describe, it, expect } from "vitest";
import { corteRetencao, limiteRetencao, DIA_MS } from "./retencao.js";

describe("limiteRetencao", () => {
  it("é o primeiro dia cuja janela de cálculo (véspera inclusa) ainda está retida", () => {
    // 2026-11-13 12:00-03:00 → corte = 2026-08-15 12:00-03:00
    const agora = new Date("2026-11-13T12:00:00-03:00").getTime();
    expect(new Date(corteRetencao(agora)).toISOString()).toBe("2026-08-15T15:00:00.000Z");
    // 08-16 começa depois do corte, mas sua véspera (08-15 00:00) não: o limite é 08-17
    expect(limiteRetencao(agora)).toBe("2026-08-17");
  });

  it("no dia do limite, a janela inteira está depois do corte; no anterior, não", () => {
    for (const h of [0, 1, 2, 3, 6, 12, 20, 23]) {
      const agora = new Date(`2026-11-13T${String(h).padStart(2, "0")}:30:00-03:00`).getTime();
      const corte = corteRetencao(agora);
      const lim = limiteRetencao(agora);
      const ini = (d: string) => new Date(`${d}T00:00:00-03:00`).getTime();
      expect(ini(lim) - DIA_MS).toBeGreaterThanOrEqual(corte);
      expect(ini(lim) - 2 * DIA_MS).toBeLessThan(corte);
    }
  });
});
