import { describe, it, expect } from "vitest";
import { detectFrustration } from "../../src/agent/frustration-detector.js";

// Histórico vazio para simplificar os testes unitários
const emptyHistory: any[] = [];

// ──────────────────────────────────────────────────────────────────────────────
// repeticao
// ──────────────────────────────────────────────────────────────────────────────

describe("frustration-detector — repeticao", () => {
  const repeticaoCasos = [
    "já falei isso",
    "já disse isso",
    "já informei essa empresa",
    "vc não tá lendo",
    "tá repetindo",
    "ta repetindo de novo",
    "já respondi isso",
    "já falei pra Ana",
  ];

  it.each(repeticaoCasos)("detecta repeticao: %s", (msg) => {
    const result = detectFrustration(msg, emptyHistory);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("repeticao");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// demora
// ──────────────────────────────────────────────────────────────────────────────

describe("frustration-detector — demora", () => {
  const demoraCasos = [
    "demorou demais",
    "ta demorando muito",
    "cadê a resposta?",
    "quando vão responder?",
    "estou esperando ha muito tempo",
  ];

  it.each(demoraCasos)("detecta demora: %s", (msg) => {
    const result = detectFrustration(msg, emptyHistory);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("demora");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// sem_resposta
// ──────────────────────────────────────────────────────────────────────────────

describe("frustration-detector — sem_resposta", () => {
  const semRespostaCasos = [
    "ninguém me responde",
    "ninguem responde",
    "não responderam",
  ];

  it.each(semRespostaCasos)("detecta sem_resposta: %s", (msg) => {
    const result = detectFrustration(msg, emptyHistory);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("sem_resposta");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// abandono_iminente
// ──────────────────────────────────────────────────────────────────────────────

describe("frustration-detector — abandono_iminente", () => {
  const abandonoCasos = [
    "vou desistir",
    "to desistindo",
    "esquece isso",
    "deixa pra lá",
    "não quero mais interesse",
    "cancela tudo",
    "não vai dar certo",
  ];

  it.each(abandonoCasos)("detecta abandono_iminente: %s", (msg) => {
    const result = detectFrustration(msg, emptyHistory);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("abandono_iminente");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// duvida_legitimidade
// ──────────────────────────────────────────────────────────────────────────────

describe("frustration-detector — duvida_legitimidade", () => {
  const legitimidadeCasos = [
    "vc é uma ia?",
    "você é um robô?",
    "to falando com um bot",
    "é humano?",
  ];

  it.each(legitimidadeCasos)("detecta duvida_legitimidade: %s", (msg) => {
    const result = detectFrustration(msg, emptyHistory);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("duvida_legitimidade");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Casos negativos — não devem disparar
// ──────────────────────────────────────────────────────────────────────────────

describe("frustration-detector — negativos (não dispara)", () => {
  const negativos = [
    "trabalhei na empresa X por 3 anos",
    "fui demitido sem justa causa",
    "meu CPF é 123.456.789-00",
    "bom dia",
    "quanto vou receber?",
    "ok",
    "sim",
    "não tenho mais vínculos",
    "a empresa era CLT",
    "quanto vale minha causa?",
  ];

  it.each(negativos)("não detecta frustração em: %s", (msg) => {
    const result = detectFrustration(msg, emptyHistory);
    expect(result).toBeNull();
  });
});
