import { describe, it, expect } from "vitest";
import { canalDoCandidato, dentroDoHorario } from "./disparos.js";

const AGORA = new Date("2026-10-23T15:00:00Z");
const h = (horas: number) => new Date(AGORA.getTime() - horas * 3_600_000);
const contato = (o: object = {}) => ({ nome: "João", whatsapp: "5577999831015", instagramId: null, messengerId: null, ...o });
const F = { pipelineId: "p" };

describe("canalDoCandidato", () => {
  it("WhatsApp para quem já conversou", () => {
    expect(canalDoCandidato({ contato: contato(), ultimaIn: { enviadaEm: h(100), canal: "whatsapp" }, ultimaOut: h(100) }, F, AGORA))
      .toEqual({ canal: "whatsapp" });
  });
  it("pula contato frio, contatado recente e Instagram fora das 24h", () => {
    expect(canalDoCandidato({ contato: contato(), ultimaIn: null, ultimaOut: null }, F, AGORA)).toEqual({ pular: "nunca mandou mensagem" });
    expect(canalDoCandidato({ contato: contato(), ultimaIn: { enviadaEm: h(10), canal: "whatsapp" }, ultimaOut: h(5) }, F, AGORA))
      .toEqual({ pular: "recebeu mensagem nas últimas 72h" });
    const ig = contato({ whatsapp: null, instagramId: "1" });
    expect(canalDoCandidato({ contato: ig, ultimaIn: { enviadaEm: h(30), canal: "instagram" }, ultimaOut: null }, F, AGORA))
      .toEqual({ pular: "fora das 24h do Instagram/Messenger" });
    expect(canalDoCandidato({ contato: ig, ultimaIn: { enviadaEm: h(2), canal: "instagram" }, ultimaOut: null }, F, AGORA))
      .toEqual({ canal: "instagram" });
  });
  it("contato frio entra quando o filtro libera", () => {
    expect(canalDoCandidato({ contato: contato(), ultimaIn: null, ultimaOut: null }, { ...F, somenteQuemConversou: false }, AGORA))
      .toEqual({ canal: "whatsapp" });
  });
});

describe("dentroDoHorario", () => {
  it("seg–sáb 8h–20h em São Paulo", () => {
    expect(dentroDoHorario(new Date("2026-10-23T15:00:00Z"))).toBe(true);  // sex 12h SP
    expect(dentroDoHorario(new Date("2026-10-23T23:30:00Z"))).toBe(false); // sex 20h30 SP
    expect(dentroDoHorario(new Date("2026-10-25T15:00:00Z"))).toBe(false); // domingo
  });
});
