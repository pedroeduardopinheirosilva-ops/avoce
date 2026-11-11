import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({ prisma: {} }));
vi.mock("../routers/crm.js", () => ({ usuariosDoFollowup: vi.fn() }));
vi.mock("./agenda-slot.js", () => ({ resolverEmitenteId: vi.fn(), reservarOuCriarSlot: vi.fn(), liberarSlotDaReuniao: vi.fn() }));

const { sobrepoe, deveMoverParaEtapa, podeAvisarCliente, horarioLabel } = await import("./reuniao-agenda.js");

const t = (hhmm: string) => new Date(`2026-11-12T${hhmm}:00-03:00`);

describe("sobrepoe", () => {
  it("reuniões que se cruzam conflitam", () => {
    expect(sobrepoe(t("14:00"), 60, t("14:30"), 60)).toBe(true);
    expect(sobrepoe(t("14:30"), 30, t("14:00"), 60)).toBe(true);
  });
  it("encostadas não conflitam", () => {
    expect(sobrepoe(t("14:00"), 60, t("15:00"), 60)).toBe(false);
    expect(sobrepoe(t("15:00"), 30, t("14:00"), 60)).toBe(false);
  });
});

describe("deveMoverParaEtapa", () => {
  it("só avança: cliente de pós-venda não volta para aguardando reunião", () => {
    expect(deveMoverParaEtapa(2, 4)).toBe(true);
    expect(deveMoverParaEtapa(7, 4)).toBe(false);
    expect(deveMoverParaEtapa(4, 4)).toBe(false);
    expect(deveMoverParaEtapa(null, 4)).toBe(true);
  });
});

describe("podeAvisarCliente", () => {
  it("só vídeo com projeto e WhatsApp", () => {
    expect(podeAvisarCliente("video", true, true)).toBe(true);
    expect(podeAvisarCliente("telefone", true, true)).toBe(false);
    expect(podeAvisarCliente("video", false, true)).toBe(false);
    expect(podeAvisarCliente("video", true, false)).toBe(false);
  });
});

describe("horarioLabel", () => {
  it("usa o fuso de Brasília", () => {
    expect(horarioLabel(new Date("2026-11-12T17:30:00Z"))).toBe("Quinta-feira (12/11) às 14:30");
  });
});

const { statusDoResultado, anexarAnotacao } = await import("./reuniao-agenda.js");

describe("statusDoResultado", () => {
  it("mapeia o registro para o status da reunião", () => {
    expect(statusDoResultado("realizada")).toBe("encerrada");
    expect(statusDoResultado("no_show")).toBe("no_show");
    expect(statusDoResultado("cancelada")).toBe("cancelada");
    expect(statusDoResultado("remarcada")).toBe("agendada");
  });
});

describe("anexarAnotacao", () => {
  it("não apaga as anotações de quem marcou", () => {
    expect(anexarAnotacao("Levar o cálculo", "Resumo", "Fechou contrato")).toBe("Levar o cálculo\n\nResumo: Fechou contrato");
    expect(anexarAnotacao(null, "Resumo", "ok")).toBe("Resumo: ok");
    expect(anexarAnotacao("x", "Resumo", "  ")).toBe("x");
  });
});
