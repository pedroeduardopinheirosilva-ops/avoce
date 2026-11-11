/**
 * Caso Cigano 558296386688 (04/11/2026): lead respondeu "Sim na Tombini" e a coleta fechou com
 * a Tombini só com o nome — mais_empregos_rec estava em _q_skipped pelo guard anti-repetição.
 * Regra: todo emprego citado é qualificado antes de fechar a coleta.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./qualification.js", () => ({
  tryExtractVinculo: vi.fn(),
  checkVinculoPrazo: vi.fn(),
  deriveDataSaida: vi.fn(() => null),
  deriveDataSaidaFromText: vi.fn(() => null),
}));
vi.mock("./persona-router.js", () => ({ vinculoComCampoPendente: vi.fn() }));

import { processVinculos } from "./vinculos-processor.js";
import { tryExtractVinculo, checkVinculoPrazo } from "./qualification.js";
import { vinculoComCampoPendente } from "./persona-router.js";

const mockExtract = tryExtractVinculo as ReturnType<typeof vi.fn>;
const mockPrazo = checkVinculoPrazo as ReturnType<typeof vi.fn>;
const mockPendente = vinculoComCampoPendente as ReturnType<typeof vi.fn>;

const buzin = {
  ordem: 1, empresa: "Buzin", funcao: "motorista carreteiro", vinculo: "CLT",
  saida: "ainda trabalha lá, pensando em sair", tempo: "desde março desse ano", frota: "mais de 200",
  horas_extras: "não", pagamento_fora: "parte no PIX", injustica: "FGTS sem depósito",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrazo.mockResolvedValue(true);
});

describe("processVinculos — todos os empregos qualificados", () => {
  it("'Sim na Tombini' com mais_empregos em _q_skipped NÃO fecha a coleta", async () => {
    mockExtract.mockResolvedValue({
      semMaisEmpregos: false, confirmouMaisEmpregos: false,
      vinculo: { empresa: "Tombini" }, updatedVinculos: [buzin],
    });
    mockPendente.mockResolvedValue({ pendente: true, passoChave: "conta_caso_ant", empresa: "Tombini" });

    const r = await processVinculos({
      projetoId: "p", text: "Sim na Tombini", history: [], maisEmpregosPerguntado: true,
      merged: { vinculos: [buzin], tem_emprego_anterior: true, _q_skipped: ["frota_rec", "mais_empregos_rec"] },
    });

    expect(r.state.vinculosOk).toBe(false);
    expect(r.mergedUpdates._mais_empregos_negado).toBeUndefined();
    expect(r.state.vinculos.map(v => v.empresa)).toEqual(["Buzin", "Tombini"]);
  });

  it("lead nega outros empregos mas o recente tem campo pendente → mantém aberto", async () => {
    const parcial = { ordem: 1, empresa: "Buzin", vinculo: "CLT", saida: "ainda trabalha" };
    mockExtract.mockResolvedValue({
      semMaisEmpregos: true, confirmouMaisEmpregos: false, vinculo: null, updatedVinculos: [parcial],
    });
    mockPendente.mockResolvedValue({ pendente: true, passoChave: "tempo_rec", empresa: "Buzin" });

    const r = await processVinculos({
      projetoId: "p", text: "não, só lá", history: [], maisEmpregosPerguntado: true,
      merged: { vinculos: [parcial] },
    });

    expect(r.state.vinculosOk).toBe(false);
    expect(r.mergedUpdates._mais_empregos_negado).toBe(true); // a negação continua registrada
  });

  it("sem campo pendente, a negação fecha normalmente", async () => {
    mockExtract.mockResolvedValue({
      semMaisEmpregos: true, confirmouMaisEmpregos: false, vinculo: null, updatedVinculos: [buzin],
    });
    mockPendente.mockResolvedValue({ pendente: false, passoChave: null, empresa: null });

    const r = await processVinculos({
      projetoId: "p", text: "não, só lá", history: [], maisEmpregosPerguntado: true,
      merged: { vinculos: [buzin] },
    });

    expect(r.state.vinculosOk).toBe(true);
  });

  it("todos os vínculos prescritos fecha mesmo sem qualificar", async () => {
    mockPrazo.mockResolvedValue(false);
    mockExtract.mockResolvedValue({
      semMaisEmpregos: false, confirmouMaisEmpregos: false,
      vinculo: { empresa: "Velha", data_saida: "2019-01" }, updatedVinculos: [],
    });
    mockPendente.mockResolvedValue({ pendente: true, passoChave: "x", empresa: "Velha" });

    const r = await processVinculos({ projetoId: "p", text: "trabalhei na Velha até 2019", history: [], maisEmpregosPerguntado: false, merged: {} });
    expect(r.state.vinculosOk).toBe(true);
    expect(mockPendente).not.toHaveBeenCalled();
  });
});
