import { describe, it, expect } from "vitest";
import { splitState } from "./deal-repository.js";

describe("splitState", () => {
  it("routes non-underscore keys to qualificacao", () => {
    const { qualificacao, iaFlags } = splitState({ nome: "João", empresa_recente: "TransABC" });
    expect(qualificacao).toEqual({ nome: "João", empresa_recente: "TransABC" });
    expect(iaFlags).toEqual({});
  });

  it("routes _-prefixed keys to iaFlags", () => {
    const { qualificacao, iaFlags } = splitState({ _vinculos_ok: true, _stage: "lead" });
    expect(qualificacao).toEqual({});
    expect(iaFlags).toEqual({ _vinculos_ok: true, _stage: "lead" });
  });

  it("splits mixed keys correctly", () => {
    const { qualificacao, iaFlags } = splitState({ nome: "Ana", _vinculos_ok: false, cpf: "123", _foo: 42 });
    expect(qualificacao).toEqual({ nome: "Ana", cpf: "123" });
    expect(iaFlags).toEqual({ _vinculos_ok: false, _foo: 42 });
  });

  it("returns empty objects for empty merged", () => {
    const { qualificacao, iaFlags } = splitState({});
    expect(qualificacao).toEqual({});
    expect(iaFlags).toEqual({});
  });

  it("handles null values without throwing (malformed JSONB)", () => {
    const { qualificacao } = splitState({ nome: null, cpf: undefined });
    expect(qualificacao.nome).toBeNull();
    expect(qualificacao.cpf).toBeUndefined();
  });

  it("routes bare underscore key to iaFlags", () => {
    const { qualificacao, iaFlags } = splitState({ "_": "edge" });
    expect(iaFlags["_"]).toBe("edge");
    expect(qualificacao).toEqual({});
  });
});
