import { describe, it, expect } from "vitest";
import { detectIdentityQuestion } from "./identity-handler.js";

describe("detectIdentityQuestion", () => {
  it("continua pegando as perguntas de legitimidade reais", () => {
    for (const t of [
      "vocês têm cnpj?",
      "onde fica o escritório de vocês?",
      "Queria até saber de onde que vocês são. Vocês são aqui do Rio?",
      "isso é golpe?",
      "tenho medo de cair em golpe",
      "me passa o cnpj de vocês",
      "você é um robô?",
      "tô falando com uma pessoa ou com uma IA?",
    ]) expect(detectIdentityQuestion(t), t).toBe(true);
  });

  it("não dispara em conversa normal (falsos positivos do caso Carlos)", () => {
    for (const t of [
      "a gente tinha a nossa folga, a gente não tinha como combinar uma folga, tipo, não tinha como programar nada em casa",
      "como eu disse, quem abastecia os carros eram os motoristas que tinham que abastecer o carro",
      "lá dentro da garagem tinha um tanque, ele comprava o combustível e deixava lá",
      "eu tenho os discos de tacógrafo que eu apanhava para trazer para casa",
      "trabalhei oito meses, eles me mandaram embora porque perderam o contrato",
    ]) expect(detectIdentityQuestion(t), t).toBe(false);
  });
});
