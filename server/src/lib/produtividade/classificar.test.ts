import { describe, it, expect } from "vitest";
import { classificar, dominioDaUrl } from "./classificar.js";
import type { Regra, Item } from "./tipos.js";

const r = (p: Partial<Regra> & Pick<Regra, "alvo" | "padrao" | "categoria">): Regra => ({
  cargoId: null, usuarioId: null, prioridade: 0, ...p,
});
const item = (p: Partial<Item>): Item => ({ app: null, dominio: null, titulo: null, ...p });

describe("classificar", () => {
  it("regra de pessoa vence a de cargo", () => {
    const regras = [
      r({ alvo: "app", padrao: "whatsapp", categoria: "neutro", cargoId: "adv" }),
      r({ alvo: "app", padrao: "whatsapp", categoria: "trabalho", usuarioId: "u1" }),
    ];
    expect(classificar(item({ app: "WhatsApp" }), regras, { usuarioId: "u1", cargoId: "adv" })).toBe("trabalho");
  });

  it("regra de cargo vence a geral", () => {
    const regras = [
      r({ alvo: "dominio", padrao: "instagram.com", categoria: "pessoal" }),
      r({ alvo: "dominio", padrao: "instagram.com", categoria: "trabalho", cargoId: "mkt" }),
    ];
    const i = item({ dominio: "instagram.com" });
    expect(classificar(i, regras, { usuarioId: "u1", cargoId: "mkt" })).toBe("trabalho");
    expect(classificar(i, regras, { usuarioId: "u1", cargoId: "adv" })).toBe("pessoal");
  });

  it("regra de outra pessoa é ignorada", () => {
    const regras = [r({ alvo: "app", padrao: "slack", categoria: "trabalho", usuarioId: "u2" })];
    expect(classificar(item({ app: "slack" }), regras, { usuarioId: "u1", cargoId: null })).toBe("neutro");
  });

  it("domínio casa subdomínio mas não sufixo solto", () => {
    const regras = [r({ alvo: "dominio", padrao: "youtube.com", categoria: "pessoal" })];
    const p = { usuarioId: "u1", cargoId: null };
    expect(classificar(item({ dominio: "m.youtube.com" }), regras, p)).toBe("pessoal");
    expect(classificar(item({ dominio: "notyoutube.com" }), regras, p)).toBe("neutro");
  });

  it("desempata por prioridade e depois por padrão mais longo", () => {
    const p = { usuarioId: "u1", cargoId: null };
    const a = [
      r({ alvo: "titulo", padrao: "excel", categoria: "pessoal", prioridade: 1 }),
      r({ alvo: "titulo", padrao: "excel", categoria: "trabalho", prioridade: 5 }),
    ];
    expect(classificar(item({ titulo: "Excel" }), a, p)).toBe("trabalho");
    const b = [
      r({ alvo: "titulo", padrao: "ex", categoria: "pessoal" }),
      r({ alvo: "titulo", padrao: "excel", categoria: "trabalho" }),
    ];
    expect(classificar(item({ titulo: "Excel" }), b, p)).toBe("trabalho");
  });
});

describe("dominioDaUrl", () => {
  it("tira www. e devolve null para URL inválida", () => {
    expect(dominioDaUrl("https://www.youtube.com/x")).toBe("youtube.com");
    expect(dominioDaUrl("não é url")).toBeNull();
  });
});
