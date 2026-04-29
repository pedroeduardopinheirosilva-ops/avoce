import { describe, it, expect, vi } from "vitest";
import { detectPhase } from "./assistente-agents.js";

vi.mock("./persona-router.js", () => ({
  getNextDeterministicQuestion: vi.fn().mockResolvedValue(null),
}));

describe("detectPhase", () => {
  it("returns 'inicial' when no vinculos", () => {
    expect(detectPhase({}, [], false)).toBe("inicial");
  });

  it("returns 'resumo' when vinculosOk is true", () => {
    expect(detectPhase({}, [], true)).toBe("resumo");
  });

  it("returns 'vinculos_recente' when vinculos started", () => {
    const vinculos = [{ ordem: 1, empresa: "TransABC" }];
    expect(detectPhase({}, vinculos, false)).toBe("vinculos_recente");
  });

  it("returns 'vinculos_anterior' when _mais_empregos_confirmado is true", () => {
    expect(detectPhase({ _mais_empregos_confirmado: true }, [], false)).toBe("vinculos_anterior");
  });

  it("returns 'vinculos_anterior' when vinculos contains ordem > 1", () => {
    const vinculos = [{ ordem: 1, empresa: "A" }, { ordem: 2, empresa: "B" }];
    expect(detectPhase({}, vinculos, false)).toBe("vinculos_anterior");
  });

  it("vinculosOk overrides vinculos content", () => {
    const vinculos = [{ ordem: 1 }, { ordem: 2 }];
    expect(detectPhase({ _mais_empregos_confirmado: true }, vinculos, true)).toBe("resumo");
  });
});

describe("runAssistenteAgent context shape", () => {
  it("accepts minimal context without throwing", async () => {
    const { runAssistenteAgent } = await import("./assistente-agents.js");
    const ctx = {
      projetoId: "proj-1",
      merged: {},
      vinculos: [],
      vinculosOk: false,
      vinculosTodosPrescritos: false,
      empresasBloqueadas: [],
      outgoingCount: 0,
    };
    const result = await runAssistenteAgent(ctx);
    expect(result).toHaveProperty("phase");
    expect(result).toHaveProperty("systemInstructions");
    expect(result).toHaveProperty("allDone");
    expect(typeof result.systemInstructions).toBe("string");
  });
});
