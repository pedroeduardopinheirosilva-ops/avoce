import { describe, it, expect } from "vitest";
import { pesoComparecimento } from "./secretaria-agenda.js";

/** Constrói um Date que, em America/Sao_Paulo, cai na hora pedida. */
function emSP(hora: number): Date {
  return new Date(Date.UTC(2026, 8, 15, hora + 3, 0, 0));  // BRT = UTC-3
}

describe("pesoComparecimento", () => {
  it("penaliza a manhã cedo, a pior faixa medida (48,8% de comparecimento)", () => {
    expect(pesoComparecimento(emSP(8))).toBeLessThan(pesoComparecimento(emSP(10)));
    expect(pesoComparecimento(emSP(9))).toBeLessThan(pesoComparecimento(emSP(19)));
  });

  it("favorece 10-12h e o fim do dia, as melhores faixas medidas", () => {
    const manha = pesoComparecimento(emSP(11));
    const noite = pesoComparecimento(emSP(19));
    const tarde = pesoComparecimento(emSP(15));
    expect(manha).toBeGreaterThan(tarde);
    expect(noite).toBeGreaterThan(tarde);
  });

  it("nunca zera nem passa de 1 — é peso de ordenação, não filtro", () => {
    for (let h = 0; h < 24; h++) {
      const p = pesoComparecimento(emSP(h));
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it("respeita o fuso: 12h UTC é 09h em SP e deve ser penalizado", () => {
    const meioDiaUtc = new Date(Date.UTC(2026, 8, 15, 12, 0, 0));
    expect(pesoComparecimento(meioDiaUtc)).toBeLessThan(0.6);
  });
});
