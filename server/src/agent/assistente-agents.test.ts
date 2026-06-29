import { describe, it, expect, vi } from "vitest";

// runAssistenteAgent agora também usa parseTempToMeses e getMaisEmpregosAnteriorQuestion
// do persona-router — partial mock mantém o parser real e mocka só as funções com I/O.
vi.mock("./persona-router.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getNextDeterministicQuestion: vi.fn().mockResolvedValue(null),
    getMaisEmpregosAnteriorQuestion: vi.fn().mockResolvedValue("Você trabalhou em outra empresa antes?"),
  };
});

// runAssistenteAgent consulta o DB (getPersonaNomeExibicao, getMesesMinimoProjeto, iaGateSdr) —
// mock determinístico para não depender do banco local.
vi.mock("../db.js", () => ({
  prisma: {
    iaPersona: { findFirst: vi.fn().mockResolvedValue({ nomeExibicao: "Dra. Daniela" }) },
    iaGateSdr: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
    iaEmpresaBloqueada: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { detectPhase } from "./assistente-agents.js";

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
    const compOk = { salario_holerite: "3000", jornada_inicio: "06:00", jornada_fim: "18:00", fgts_ok: "sim" };
    const vinculos = [{ ordem: 1, ...compOk }, { ordem: 2, ...compOk }];
    expect(detectPhase({ _mais_empregos_confirmado: true }, vinculos, true)).toBe("resumo");
  });

  it("vinculosOk with only vinculos[0] missing comp → resumo (Daniela handles it)", () => {
    const vinculos = [{ ordem: 1 }]; // vinculos[0] without comp — Daniela covers it
    expect(detectPhase({}, vinculos, true)).toBe("resumo");
  });

  it("vinculosOk with vinculos[1] missing comp → resumo (fase comp_vinculos foi removida)", () => {
    // A fase "comp_vinculos" não existe mais: vinculosOk=true sempre leva a "resumo".
    // Os campos complementares (salário/jornada) migraram para o fluxo da Daniela.
    const vinculos = [{ ordem: 1 }, { ordem: 2 }]; // vinculos[1] without comp
    expect(detectPhase({}, vinculos, true)).toBe("resumo");
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

  it("Bug B regression — allDone=true when vinculosOk=true even if _vinculos_ok absent from merged", async () => {
    const { runAssistenteAgent } = await import("./assistente-agents.js");
    // getNextDeterministicQuestion is mocked to return null (all questions answered)
    const ctx = {
      projetoId: "proj-1",
      merged: {}, // _vinculos_ok NOT in merged (simulates DB lag)
      vinculos: [{ ordem: 1, empresa: "TransABC", funcao: "Motorista", vinculo: "CLT",
        saida: "demitido", tempo: "2 anos", horas_extras: "sim", pagamento_fora: "nao", injustica: "nao",
        salario_holerite: "3000", jornada_inicio: "06:00", jornada_fim: "18:00", fgts_ok: "sim" }],
      vinculosOk: true, // in-memory state from processVinculos
      vinculosTodosPrescritos: false,
      empresasBloqueadas: [],
      outgoingCount: 5,
    };
    const result = await runAssistenteAgent(ctx);
    expect(result.allDone).toBe(true);
    expect(result.phase).toBe("resumo");
  });

  it("cenário 3 — buildResumoInstructions não contém 'Dra. Daniela' quando allDone=false", async () => {
    const { runAssistenteAgent } = await import("./assistente-agents.js");
    const { getNextDeterministicQuestion } = await import("./persona-router.js");
    const mockNextQ = getNextDeterministicQuestion as ReturnType<typeof vi.fn>;
    mockNextQ.mockResolvedValueOnce("Você gostaria de entender o que seria possível recuperar?");

    const ctx = {
      projetoId: "proj-1",
      merged: {},
      vinculos: [{ ordem: 1, empresa: "TransABC" }],
      vinculosOk: true,
      vinculosTodosPrescritos: false,
      empresasBloqueadas: [],
      outgoingCount: 5,
    };
    const result = await runAssistenteAgent(ctx);
    // When there's still a pending question, LLM instructions must NOT announce handoff
    expect(result.allDone).toBe(false);
    expect(result.systemInstructions).not.toContain("passe para a Dra.");
  });
});
