import { describe, it, expect } from "vitest";
import { detectaAdvogadoContraparte, numeroProcessoCnj } from "./sinais-lead.js";

describe("detectaAdvogadoContraparte", () => {
  it.each([
    "Boa tarde Drs., tudo bem? Sou advogada da Transportes Framento, com quem poderia falar a respeito de acordo em processo",
    "Bom dia, sou o advogado da empresa Buzin e gostaria de conversar sobre um acordo",
    "Aqui é a Dra. Fernanda, do escritório que representa a reclamada",
    "Meu nome é Carlos Souza, advogado da Tombini Transportes",
    "Represento a empresa JSL no processo do Sr. Leandro",
    "Falo em nome da Transportadora Ouro Verde, temos uma proposta",
    "Dr. Paulo Mendes OAB/SC 45.123 — gostaria de tratar do processo",
    "Sou o Dr. Ricardo, patrono da reclamada",
  ])("pega: %s", (msg) => expect(detectaAdvogadoContraparte(msg)).toBe(true));

  it.each([
    "Tira só a dúvida aí. Eu procurei até uma advogada daqui, só que eu achei ela muito fraca",
    "o advogado da empresa me ligou querendo fazer acordo",
    "É porque o advogado da OAB tá me cobrando isso aí, sendo que eu não contratei ele",
    "Esse escritório de vocês aí é onde?",
    "Boa tarde doutora, sou motorista carreteiro",
    "Meu nome é Davi Carvalho, sou advogado da RAP e colega de Dra. Daniela",
    "eu não sou advogado, só quero saber meus direitos",
    "Você foi pra advogado dar uma olhada nisso aí?",
    "a empresa quer fazer um acordo comigo, o que eu faço?",
    "Ô doutora, desculpa a ligação, eu tinha um contato com advogado, tinha um processo",
  ])("não pega: %s", (msg) => expect(detectaAdvogadoContraparte(msg)).toBe(false));
});

describe("numeroProcessoCnj", () => {
  it("extrai o número CNJ", () => {
    expect(numeroProcessoCnj("O número do processo é 0001858-73.2026.5.12.0009")).toBe("0001858-73.2026.5.12.0009");
    expect(numeroProcessoCnj("sem número")).toBeNull();
  });
});
