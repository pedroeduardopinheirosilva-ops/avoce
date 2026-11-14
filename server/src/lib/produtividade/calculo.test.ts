import { describe, it, expect } from "vitest";
import { calcularDia } from "./calculo.js";
import type { EventoBruto, Regra } from "./tipos.js";

const ev = (bucket: EventoBruto["bucket"], hms: string, seg: number, extra: Partial<EventoBruto> = {}, dia = "2026-11-13"): EventoBruto => ({
  dispositivoId: "A", bucket, inicio: new Date(`${dia}T${hms.length === 5 ? hms + ":00" : hms}-03:00`), duracaoSeg: seg, ...extra,
});
const regra = (alvo: Regra["alvo"], padrao: string, categoria: Regra["categoria"]): Regra => ({
  alvo, padrao, categoria, cargoId: null, usuarioId: null, prioridade: 0,
});
const pessoa = { usuarioId: "u1", cargoId: null, expediente: null };
const word = regra("app", "winword", "trabalho");

describe("calcularDia", () => {
  it("ocioso não conta", () => {
    const r = calcularDia("2026-11-13", [
      ev("afk", "09:00", 3600, { afk: false }),
      ev("afk", "10:00", 1800, { afk: true }),
      ev("janela", "09:00", 5400, { app: "WINWORD.EXE" }),
    ], [word], pessoa);
    expect(r.dentro.ativo).toBe(3600);
    expect(r.dentro.trabalho).toBe(3600);
  });

  it("navegador usa o domínio da aba", () => {
    const r = calcularDia("2026-11-13", [
      ev("afk", "09:00", 600, { afk: false }),
      ev("janela", "09:00", 600, { app: "chrome.exe" }),
      ev("web", "09:00", 300, { dominio: "youtube.com" }),
      ev("web", "09:05", 300, { dominio: "pje.jus.br" }),
    ], [regra("dominio", "youtube.com", "pessoal"), regra("dominio", "pje.jus.br", "trabalho")], pessoa);
    expect(r.dentro.pessoal).toBe(300);
    expect(r.dentro.trabalho).toBe(300);
  });

  it("duas máquinas ao mesmo tempo não somam em dobro", () => {
    const r = calcularDia("2026-11-13", [
      ev("afk", "09:00", 3600, { afk: false, dispositivoId: "A" }),
      ev("afk", "09:00", 3600, { afk: false, dispositivoId: "B" }),
    ], [], pessoa);
    expect(r.dentro.ativo).toBe(3600);
  });

  it("fim do expediente divide o bloco", () => {
    const r = calcularDia("2026-11-13", [
      ev("afk", "17:30", 3600, { afk: false }),
      ev("janela", "17:30", 3600, { app: "WINWORD.EXE" }),
    ], [word], pessoa);
    expect(r.dentro.ativo).toBe(1800);
    expect(r.fora.ativo).toBe(1800);
  });

  it("sábado é todo fora do expediente", () => {
    const r = calcularDia("2026-11-14", [
      ev("afk", "09:00", 3600, { afk: false }, "2026-11-14"),
    ], [], pessoa);
    expect(r.dentro.ativo).toBe(0);
    expect(r.fora.ativo).toBe(3600);
  });

  it("evento que atravessa meia-noite só conta a parte do dia", () => {
    const r = calcularDia("2026-11-13", [
      ev("afk", "23:30", 3600, { afk: false }, "2026-11-12"),
    ], [], pessoa);
    expect(r.dentro.ativo + r.fora.ativo).toBe(1800);
  });

  it("top e blocos", () => {
    const r = calcularDia("2026-11-13", [
      ev("afk", "09:00", 600, { afk: false }),
      ev("afk", "09:10", 600, { afk: true }),
      ev("afk", "09:20", 600, { afk: false }),
      ev("janela", "09:00", 1800, { app: "chrome.exe", titulo: "Vídeo" }),
      ev("web", "09:00", 1800, { dominio: "youtube.com", titulo: "Vídeo" }),
    ], [regra("dominio", "youtube.com", "pessoal")], pessoa);
    expect(r.top.pessoal[0]).toMatchObject({ chave: "youtube.com" });
    const cats = r.blocos.map((b) => b.categoria);
    expect(cats).toContain("pausa");
    const i = cats.indexOf("pausa");
    expect(cats[i - 1]).toBe("pessoal");
    expect(cats[i + 1]).toBe("pessoal");
    expect(r.primeiroEvento).toEqual(new Date("2026-11-13T09:00:00-03:00"));
    expect(r.ultimoEvento).toEqual(new Date("2026-11-13T09:30:00-03:00"));
  });
});
