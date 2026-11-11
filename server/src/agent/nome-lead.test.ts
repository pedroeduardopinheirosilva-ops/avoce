import { describe, it, expect } from "vitest";
import { sanitizeNomeLead, isNomePlaceholder } from "./nome-lead.js";

const casos: [string, string | null][] = [
  // casos reais que quebraram
  ["What the me oftension da Cunha de Maceió", null],
  ["What", null],
  ["Marcell | 7227", "Marcell"],
  ["Alinor | 3470", "Alinor"],
  ["Cacildo aparecido Guedes santos | 5212", "Cacildo Aparecido Guedes"],
  ["Lead 42988918385", null],
  ["~Junior 😎", "Junior"],
  ["Cliente", null],
  // casos bons que precisam continuar passando
  ["Keylla", "Keylla"],
  ["Bom dia nome Carlos Alberto Rodrigues", "Carlos Alberto Rodrigues"],
  ["Tarcísio Valeriano", "Tarcísio Valeriano"],
  ["Edson Leandro da Rosa", "Edson Leandro da Rosa"],
  ["meu nome é João da Silva", "João da Silva"],
  ["oi, sou o Edgar", "Edgar"],
  ["", null],
];

describe("sanitizeNomeLead", () => {
  for (const [entrada, esperado] of casos) {
    it(`${JSON.stringify(entrada)} → ${JSON.stringify(esperado)}`, () => {
      expect(sanitizeNomeLead(entrada)).toBe(esperado);
    });
  }
});

describe("isNomePlaceholder", () => {
  it("detecta placeholders", () => {
    expect(isNomePlaceholder("Lead 5582990")).toBe(true);
    expect(isNomePlaceholder("Cliente")).toBe(true);
    expect(isNomePlaceholder(null)).toBe(true);
    expect(isNomePlaceholder("Keylla")).toBe(false);
  });
});
