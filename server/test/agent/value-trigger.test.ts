import { describe, it, expect } from "vitest";
import { isAskingValue, buildValueResponseInjection } from "../../src/agent/value-trigger.js";
import type { CalculoResultado } from "../../src/agent/calc-trabalhista.js";

const mockCalculo: CalculoResultado = {
  vinculos_considerados: 1,
  vinculos_prescritos: [],
  total_estimado_min: 45000,
  total_estimado_max: 80000,
  por_tese: [
    { tese: "Horas extras não quitadas", fundamento: "art. 59 CLT", valor_min: 30000, valor_max: 50000 },
    { tese: "Verbas rescisórias sem justa causa", fundamento: "arts. 477, 487 CLT", valor_min: 15000, valor_max: 30000 },
  ],
  resumo_textual_curto: "Sua causa pode girar entre R$ 45.000 e R$ 80.000",
  observacoes: [],
  data_calculo: new Date().toISOString(),
  disclaimer: "Estimativa preliminar",
};

const mockCalculoSemValor: CalculoResultado = {
  ...mockCalculo,
  total_estimado_min: 0,
  total_estimado_max: 0,
  por_tese: [],
  resumo_textual_curto: "Ainda não foi possível calcular",
};

describe("isAskingValue — detecta perguntas sobre valor da causa", () => {
  it.each([
    "quanto posso receber?",
    "quanto vou receber nesse processo?",
    "qual o valor da minha causa?",
    "vale a pena entrar com ação?",
    "qual a estimativa do meu caso?",
    "dá pra ganhar quanto nisso?",
    "quanto eu posso receber?",
    "tenho direito a quanto?",
    "quanto vale meu caso?",
    "qual o total que posso recuperar?",
  ])("detecta: %s", (msg) => {
    expect(isAskingValue(msg)).toBe(true);
  });

  it.each([
    "quando começa o processo?",
    "quais documentos preciso?",
    "você pode me ajudar?",
    "tudo bem, pode prosseguir",
    "meu salário era R$ 4.000",
    "trabalhei 3 anos na empresa",
  ])("não detecta: %s", (msg) => {
    expect(isAskingValue(msg)).toBe(false);
  });

  it("funciona sem acentos", () => {
    expect(isAskingValue("quanto vou receber na acao?")).toBe(true);
  });
});

describe("buildValueResponseInjection", () => {
  it("inclui os valores calculados exatos", () => {
    const inj = buildValueResponseInjection(mockCalculo, "advogado_valor");
    expect(inj).toContain("45.000");
    expect(inj).toContain("80.000");
  });

  it("inclui as teses com valores", () => {
    const inj = buildValueResponseInjection(mockCalculo, "advogado_valor");
    expect(inj).toContain("Horas extras não quitadas");
    expect(inj).toContain("Verbas rescisórias sem justa causa");
  });

  it("instrui a não pedir documentos na mesma resposta", () => {
    const inj = buildValueResponseInjection(mockCalculo, "advogado_valor");
    expect(inj).toContain("NÃO peça documentos");
  });

  it("instrui a usar números exatos", () => {
    const inj = buildValueResponseInjection(mockCalculo, "advogado_valor");
    expect(inj).toContain("números EXATOS");
  });

  it("quando sem valor, mostra mensagem de dados insuficientes", () => {
    const inj = buildValueResponseInjection(mockCalculoSemValor, "advogado_valor");
    expect(inj).toContain("dados insuficientes");
  });
});
