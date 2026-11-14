import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { permitir, bloqueado, registrar, _limparLimites } from "./limite.js";

beforeEach(() => { _limparLimites(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("limite", () => {
  it("permite até o máximo e bloqueia depois, por chave", () => {
    for (let i = 0; i < 3; i++) expect(permitir("a", 3, 60_000)).toBe(true);
    expect(permitir("a", 3, 60_000)).toBe(false);
    expect(permitir("b", 3, 60_000)).toBe(true);
  });
  it("libera quando a janela passa", () => {
    for (let i = 0; i < 3; i++) permitir("a", 3, 60_000);
    vi.advanceTimersByTime(60_001);
    expect(permitir("a", 3, 60_000)).toBe(true);
  });
  it("bloqueado não conta tentativa; registrar conta", () => {
    expect(bloqueado("c", 2, 60_000)).toBe(false);
    expect(bloqueado("c", 2, 60_000)).toBe(false);
    registrar("c", 60_000); registrar("c", 60_000);
    expect(bloqueado("c", 2, 60_000)).toBe(true);
  });
});
