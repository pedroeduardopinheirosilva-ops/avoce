import { describe, it, expect } from "vitest";
import { detectIdentityQuestion } from "../../src/agent/identity-handler.js";

describe("identity-handler — detectIdentityQuestion", () => {
  // Variações positivas — devem retornar true
  const positivos = [
    "vc é uma ia?",
    "você é um robô?",
    "voce e uma IA?",
    "Vc eh bot",
    "estou falando com uma pessoa?",
    "to falando com um robo",
    "é de verdade?",
    "você não é advogada",
    "é um robo?",
    "isso é real?",
    "é automatizado?",
    "sistema automatico?",
    "vc e ia ou pessoa",
    "é chatgpt isso?",
    "você é uma inteligência artificial",
    "conversando com um bot",
    "estou falando com uma IA",
    "vc e claude",
    "isso é sério?",
    "é real isso aqui?",
  ];

  it.each(positivos)("detecta: %s", (msg) => {
    expect(detectIdentityQuestion(msg)).toBe(true);
  });

  // Variações negativas — não devem disparar
  const negativos = [
    "qual meu direito trabalhista?",
    "quanto vou receber?",
    "meu cpf é 123.456.789-00",
    "trabalhei na empresa X por 3 anos",
    "fui demitido sem justa causa",
    "tenho direito a horas extras?",
    "quando o processo termina?",
    "bom dia",
    "ok",
    "sim",
  ];

  it.each(negativos)("não detecta: %s", (msg) => {
    expect(detectIdentityQuestion(msg)).toBe(false);
  });
});
