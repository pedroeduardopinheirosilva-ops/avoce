import { describe, it, expect } from "vitest";
import { lerAutomacoes, candidatas, payloadAut, lerPayloadAut, palavrasDasAutomacoes } from "./meta-automacoes.js";

const AUTS = lerAutomacoes(JSON.stringify([
  { id: "fila", nome: "FILA", gatilho: { tipo: "dm_palavra", palavras: "FILA, espera" },
    passos: [{ tipo: "texto", texto: "Oi {nome}" }, { tipo: "audio", midia: { arquivo: "a.m4a", nome: "a.m4a" } }, { tipo: "esperar", segundos: 9999 }] },
  { id: "coment_fila", nome: "FILA (comentário)", gatilho: { tipo: "comentario", palavras: ["FILA"], posts: "https://www.instagram.com/reel/X1/ abc" }, passos: [{ tipo: "texto", texto: "oi" }] },
  { id: "coment_todos", nome: "Comentário", gatilho: { tipo: "comentario", palavras: [] }, passos: [{ tipo: "texto", texto: "oi" }] },
  { id: "primeira", nome: "1ª", gatilho: { tipo: "dm_primeira" }, passos: [{ tipo: "texto", texto: "oi" }] },
  { id: "story", nome: "Story", canais: ["instagram"], gatilho: { tipo: "story_resposta" }, passos: [{ tipo: "texto", texto: "oi" }] },
  { id: "link", nome: "Link", gatilho: { tipo: "link", ref: "reel fila" }, passos: [{ tipo: "texto", texto: "oi" }] },
  { id: "off", nome: "Desligada", ativo: false, gatilho: { tipo: "dm_primeira" }, passos: [{ tipo: "texto", texto: "x" }] },
  { nome: "sem id é descartada" },
]));

describe("lerAutomacoes", () => {
  it("normaliza gatilhos, passos e limites", () => {
    expect(AUTS).toHaveLength(7);
    const fila = AUTS[0];
    expect(fila.gatilho).toEqual({ tipo: "dm_palavra", palavras: ["FILA", "espera"] });
    expect(fila.passos.map((p) => p.tipo)).toEqual(["texto", "audio", "esperar"]);
    expect((fila.passos[2] as any).segundos).toBe(600);
    expect((AUTS[1].gatilho as any).posts).toEqual(["X1", "abc"]);
    expect(AUTS[5].gatilho).toEqual({ tipo: "link", ref: "REEL_FILA" });
  });
  it("uma vez a cada 24h por padrão só em story, 1ª mensagem e comentário qualquer", () => {
    const por = Object.fromEntries(AUTS.map((a) => [a.id, a.umaVez24h]));
    expect(por).toMatchObject({ fila: false, coment_fila: false, coment_todos: true, primeira: true, story: true });
  });
  it("descarta passo incompleto sem quebrar o resto", () => {
    const [a] = lerAutomacoes(JSON.stringify([{ id: "x", passos: [{ tipo: "imagem" }, { tipo: "texto", texto: "  " }, { tipo: "acao", acao: "tag", valor: "Reel" }] }]));
    expect(a.passos).toEqual([{ tipo: "acao", acao: "tag", valor: "Reel" }]);
  });
});

describe("candidatas", () => {
  it("comentário: palavra antes de qualquer comentário", () => {
    expect(candidatas(AUTS, "instagram", { tipo: "comentario", texto: "quero a FILA!" }).map((c) => c.aut.id)).toEqual(["coment_fila", "coment_todos"]);
    expect(candidatas(AUTS, "instagram", { tipo: "comentario", texto: "😂" }).map((c) => c.aut.id)).toEqual(["coment_todos"]);
  });
  it("Direct: palavra em qualquer parte só na 1ª mensagem; depois, só a palavra sozinha", () => {
    expect(candidatas(AUTS, "instagram", { tipo: "mensagem", texto: "me fala da espera", primeira: true }).map((c) => c.aut.id)).toEqual(["fila", "primeira"]);
    expect(candidatas(AUTS, "instagram", { tipo: "mensagem", texto: "me fala da espera", primeira: false })).toEqual([]);
    expect(candidatas(AUTS, "instagram", { tipo: "mensagem", texto: "Espera", primeira: false }).map((c) => c.aut.id)).toEqual(["fila"]);
  });
  it("link e story; story só no canal configurado; desligada nunca", () => {
    expect(candidatas(AUTS, "messenger", { tipo: "mensagem", texto: "", primeira: true, ref: "reel_fila" }).map((c) => c.aut.id)).toEqual(["link", "primeira"]);
    expect(candidatas(AUTS, "instagram", { tipo: "mensagem", texto: "top", primeira: true, story: "resposta" }).map((c) => c.aut.id)).toEqual(["story"]);
    expect(candidatas(AUTS, "messenger", { tipo: "mensagem", texto: "top", primeira: false, story: "resposta" })).toEqual([]);
  });
});

describe("payload de botão", () => {
  it("ida e volta", () => {
    expect(lerPayloadAut(payloadAut("fila", 2))).toEqual({ id: "fila", passo: 2 });
    expect(lerPayloadAut("QR:Sim")).toBe(null);
    expect(lerPayloadAut(undefined)).toBe(null);
  });
});

describe("palavrasDasAutomacoes", () => {
  it("junta as palavras dos gatilhos de comentário e Direct", () => {
    expect(palavrasDasAutomacoes(AUTS)).toEqual(expect.arrayContaining(["FILA", "espera"]));
  });
});
