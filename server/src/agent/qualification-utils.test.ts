import { describe, it, expect } from "vitest";
import { validarCPF, syncVinculosFromFlat, temDadosMinimosCalculo, parseBrNumber } from "./qualification-utils.js";
import type { VinculoEmprego } from "./types.js";

// ── validarCPF ────────────────────────────────────────────────────────────────

describe("validarCPF", () => {
  it("accepts a valid CPF with mask", () => {
    expect(validarCPF("529.982.247-25")).toBe(true);
  });

  it("accepts a valid CPF as plain digits", () => {
    expect(validarCPF("52998224725")).toBe(true);
  });

  it("accepts a valid CPF with spaces instead of separators", () => {
    expect(validarCPF("529 982 247 25")).toBe(true);
  });

  it("rejects all-same-digit CPF", () => {
    expect(validarCPF("111.111.111-11")).toBe(false);
  });

  it("rejects wrong check digit", () => {
    // 529.982.247-26 — last digit off by one
    expect(validarCPF("529.982.247-26")).toBe(false);
  });

  it("rejects too-short string", () => {
    expect(validarCPF("123.456")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validarCPF("")).toBe(false);
  });
});

// ── temDadosMinimosCalculo ────────────────────────────────────────────────────

describe("temDadosMinimosCalculo", () => {
  it("returns true when flat empresa + salario present", () => {
    expect(temDadosMinimosCalculo({ empresa_recente: "TransABC", salario_holerite: 3000 })).toBe(true);
  });

  it("returns false when empresa present but no salary", () => {
    expect(temDadosMinimosCalculo({ empresa_recente: "TransABC" })).toBe(false);
  });

  it("returns true when vinculos array has empresa + salary", () => {
    expect(temDadosMinimosCalculo({
      vinculos: [{ empresa: "TransABC", salario_holerite: 3000 }],
    })).toBe(true);
  });

  it("returns false when vinculos array has empresa but no salary", () => {
    expect(temDadosMinimosCalculo({
      vinculos: [{ empresa: "TransABC" }],
    })).toBe(false);
  });

  it("returns false for empty merged", () => {
    expect(temDadosMinimosCalculo({})).toBe(false);
  });
});

// ── parseBrNumber ─────────────────────────────────────────────────────────────

describe("parseBrNumber", () => {
  it("2.000 → 2000",        () => expect(parseBrNumber("2.000")).toBe(2000));
  it("1.500,50 → 1500.5",   () => expect(parseBrNumber("1.500,50")).toBe(1500.5));
  it("number passthrough",   () => expect(parseBrNumber(2000)).toBe(2000));
  it("null → 0",             () => expect(parseBrNumber(null)).toBe(0));
  it("R$ 3.200 → 3200",     () => expect(parseBrNumber("R$ 3.200")).toBe(3200));
  it("plain 1200 → 1200",    () => expect(parseBrNumber("1200")).toBe(1200));
  it("1.200,99 → 1200.99",  () => expect(parseBrNumber("1.200,99")).toBe(1200.99));
  it("undefined → 0",        () => expect(parseBrNumber(undefined)).toBe(0));
  it("empty string → 0",     () => expect(parseBrNumber("")).toBe(0));
});

// ── syncVinculosFromFlat ──────────────────────────────────────────────────────

describe("syncVinculosFromFlat", () => {
  const base: VinculoEmprego = { ordem: 1, empresa: "TransABC" };

  it("returns unchanged when vinculos is empty", () => {
    const result = syncVinculosFromFlat([], { funcao_recente: "Motorista" });
    expect(result.changed).toBe(false);
    expect(result.vinculos).toHaveLength(0);
  });

  it("fills missing funcao from flat field", () => {
    const result = syncVinculosFromFlat([base], { funcao_recente: "Motorista" });
    expect(result.changed).toBe(true);
    expect(result.vinculos[0].funcao).toBe("Motorista");
  });

  it("does not overwrite existing funcao", () => {
    const v: VinculoEmprego = { ...base, funcao: "Ajudante" };
    const result = syncVinculosFromFlat([v], { funcao_recente: "Motorista" });
    expect(result.changed).toBe(false);
    expect(result.vinculos[0].funcao).toBe("Ajudante");
  });

  it("falls back to empresa_principal when empresa_recente absent", () => {
    const v: VinculoEmprego = { ordem: 1 };
    const result = syncVinculosFromFlat([v], { empresa_principal: "TucoBR" });
    expect(result.vinculos[0].empresa).toBe("TucoBR");
  });
});
