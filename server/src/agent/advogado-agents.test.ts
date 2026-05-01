import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    iaFlowStep: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "../db.js";
import { detectAdvogadoPhase, getStepFaseMap } from "./advogado-agents.js";

const mockFindMany = (prisma.iaFlowStep.findMany as ReturnType<typeof vi.fn>);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the cache between tests by clearing internal module state
  mockFindMany.mockResolvedValue([]);
});

describe("detectAdvogadoPhase", () => {
  it("returns 'autoridade' when iaFlowStepChave is null", async () => {
    const phase = await detectAdvogadoPhase("proj-1", null);
    expect(phase).toBe("autoridade");
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns 'autoridade' when step has fase 'autoridade'", async () => {
    mockFindMany.mockResolvedValue([{ chave: "parecer", fase: "autoridade" }]);
    const phase = await detectAdvogadoPhase("proj-autoridade", "parecer");
    expect(phase).toBe("autoridade");
  });

  it("returns 'coleta' when step has fase 'coleta'", async () => {
    mockFindMany.mockResolvedValue([{ chave: "cpf", fase: "coleta" }]);
    const phase = await detectAdvogadoPhase("proj-coleta", "cpf");
    expect(phase).toBe("coleta");
  });

  it("returns 'autoridade' for unknown step (not in DB)", async () => {
    mockFindMany.mockResolvedValue([{ chave: "cpf", fase: "coleta" }]);
    const phase = await detectAdvogadoPhase("proj-unknown", "step_inexistente");
    expect(phase).toBe("autoridade");
  });
});

describe("getStepFaseMap cache", () => {
  it("only queries DB once for the same projetoId within TTL", async () => {
    const freshProjetoId = "proj-cache-" + Date.now();
    mockFindMany.mockResolvedValue([{ chave: "cpf", fase: "coleta" }]);

    await getStepFaseMap(freshProjetoId);
    await getStepFaseMap(freshProjetoId);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
  });

  it("returns a map with all step entries", async () => {
    const pid = "proj-map-" + Date.now();
    mockFindMany.mockResolvedValue([
      { chave: "cpf", fase: "coleta" },
      { chave: "parecer", fase: "autoridade" },
    ]);

    const map = await getStepFaseMap(pid);
    expect(map.get("cpf")).toBe("coleta");
    expect(map.get("parecer")).toBe("autoridade");
  });
});

describe("runAdvogadoAgent", () => {
  it("returns phase and systemInstructions for autoridade", async () => {
    const pid = "proj-adv-" + Date.now();
    mockFindMany.mockResolvedValue([]);
    const { runAdvogadoAgent } = await import("./advogado-agents.js");
    const result = await runAdvogadoAgent({
      projetoId: pid,
      iaFlowStepChave: null,
      merged: { nome: "João" },
      vinculos: [],
    });
    expect(result.phase).toBe("autoridade");
    expect(typeof result.systemInstructions).toBe("string");
    expect(result.systemInstructions.length).toBeGreaterThan(0);
  });
});

// P2 — valor_estimado instruction must cover all vínculos
describe("runAdvogadoAgent — P2 valor_estimado instruction", () => {
  it("mentions each vínculo separately when step is valor_estimado", async () => {
    const pid = "proj-p2-val-" + Date.now();
    mockFindMany.mockResolvedValue([{ chave: "valor_estimado", fase: "autoridade" }]);
    const { runAdvogadoAgent } = await import("./advogado-agents.js");
    const vinculos = [
      { empresa: "ABCDE Ltda", funcao: "motorista", vinculo: "CLT", tempo: "2 anos" },
      { empresa: "Transporte Azul", funcao: "motorista", vinculo: "autônomo", tempo: "1 ano" },
    ];
    const result = await runAdvogadoAgent({
      projetoId: pid,
      iaFlowStepChave: "valor_estimado",
      merged: { nome: "Pedro" },
      vinculos,
    });
    expect(result.systemInstructions).toMatch(/cada vínculo/i);
    expect(result.systemInstructions).toContain("ABCDE Ltda");
    expect(result.systemInstructions).toContain("Transporte Azul");
  });

  it("mentions total sum when multiple vínculos present", async () => {
    const pid = "proj-p2-total-" + Date.now();
    mockFindMany.mockResolvedValue([{ chave: "valor_estimado", fase: "autoridade" }]);
    const { runAdvogadoAgent } = await import("./advogado-agents.js");
    const result = await runAdvogadoAgent({
      projetoId: pid,
      iaFlowStepChave: "valor_estimado",
      merged: { nome: "Maria" },
      vinculos: [
        { empresa: "Empresa A", funcao: "op", vinculo: "CLT", tempo: "1 ano" },
        { empresa: "Empresa B", funcao: "op", vinculo: "CLT", tempo: "2 anos" },
      ],
    });
    expect(result.systemInstructions).toMatch(/total/i);
  });
});
