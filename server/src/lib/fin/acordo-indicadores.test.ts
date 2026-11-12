import { describe, it, expect } from "vitest";
import {
  addDias, prazoAvaliacao, escolherResponsavelInicial, ehColunaAjuizado, extrairCnpj, normalizarNomeEmpresa,
  empresaReDoDeal, calcularIndicadores, indicadoresPorEmpresa, calcularExito, receitaPorTipo,
  type AcordoParaIndicador,
} from "./acordo-indicadores.js";

describe("prazo da avaliação prévia", () => {
  it("addDias atravessa mês/ano", () => {
    expect(addDias("2026-12-28", 5)).toBe("2027-01-02");
    expect(addDias("2026-03-02", -5)).toBe("2026-02-25");
  });
  it("5 dias antes da audiência; sem audiência, protocolo + 10", () => {
    expect(prazoAvaliacao({ protocolo: "2026-11-01", audiencia: "2026-12-10" })).toBe("2026-12-05");
    expect(prazoAvaliacao({ protocolo: "2026-11-01" })).toBe("2026-11-11");
    expect(prazoAvaliacao({ protocolo: "2026-11-01", audiencia: null })).toBe("2026-11-11");
  });
  it("audiência muito próxima não joga o prazo antes do protocolo", () => {
    expect(prazoAvaliacao({ protocolo: "2026-11-10", audiencia: "2026-11-12" })).toBe("2026-11-10");
  });
});

describe("responsável pela avaliação", () => {
  const d = (s: string) => new Date(s);
  it("quem tirou o card da elaboração da inicial, depois deal.responsavelId, depois o gatilho", () => {
    const logs = [
      { usuarioId: "sdr", chaveAnterior: "aguardando_docs_adicionais", chaveNova: "elaboracao_inicial", criadoEm: d("2026-10-01") },
      { usuarioId: "adv", chaveAnterior: "elaboracao_inicial", chaveNova: "ajuizado_audiencia", criadoEm: d("2026-10-05") },
    ];
    expect(escolherResponsavelInicial(logs, "resp", "gat")).toBe("adv");
    expect(escolherResponsavelInicial([{ ...logs[1], usuarioId: null }], "resp", "gat")).toBe("resp");
    expect(escolherResponsavelInicial([], null, "gat")).toBe("gat");
    expect(escolherResponsavelInicial([], null, null)).toBeNull();
  });
  it("coluna de ajuizado", () => {
    expect(ehColunaAjuizado("ajuizado_audiencia")).toBe(true);
    expect(ehColunaAjuizado("Ajuizado")).toBe(true);
    expect(ehColunaAjuizado("audiencia_feita")).toBe(false);
    expect(ehColunaAjuizado(null)).toBe(false);
  });
});

describe("empresa ré", () => {
  it("extrai CNPJ com e sem máscara", () => {
    expect(extrairCnpj("Transportes X LTDA - 12.345.678/0001-90")).toBe("12345678000190");
    expect(extrairCnpj("12345678000190")).toBe("12345678000190");
    expect(extrairCnpj("Transportes X")).toBeNull();
  });
  it("normaliza nome (acento, pontuação, sufixo societário)", () => {
    expect(normalizarNomeEmpresa("Transportes São João Ltda.")).toBe("transportes sao joao");
    expect(normalizarNomeEmpresa("TRANSPORTES SAO JOAO LTDA ME")).toBe("transportes sao joao");
    expect(normalizarNomeEmpresa("Griffi Transportes S/A")).toBe("griffi transportes");
  });
  it("ordem das fontes e chave", () => {
    expect(empresaReDoDeal({ vinculoEmpresa: " ", contatoEmpresa: "Griffi Ltda", organizacao: "Outra" }))
      .toEqual({ chave: "nome:griffi", nome: "Griffi Ltda", cnpj: null });
    expect(empresaReDoDeal({ vinculoEmpresa: "Griffi 12.345.678/0001-90" }).chave).toBe("cnpj:12345678000190");
    expect(empresaReDoDeal({}).chave).toBe("sem_empresa");
  });
});

const base = (o: Partial<AcordoParaIndicador>): AcordoParaIndicador => ({
  id: "x", tipo: "posterior", status: "em_negociacao", faseOrigem: null, valorAcordo: null, valorCausa: null,
  estimativaCondenacao: null, ajuizadoEm: null, fechadoEm: null,
  empresa: { chave: "nome:a", nome: "A", cnpj: null }, parcelas: [], ...o,
});

describe("indicadores do funil", () => {
  const hoje = "2026-11-12";
  const lista = [
    base({ id: "1", tipo: "previo", status: "homologado", faseOrigem: "previo", valorAcordo: 1_000_000, valorCausa: 4_000_000, estimativaCondenacao: 2_000_000,
      ajuizadoEm: "2026-09-01", fechadoEm: "2026-09-21",
      parcelas: [
        { vencimento: "2026-10-01", dataRecebimento: "2026-10-01", valorPrevisto: 500_000 },
        { vencimento: "2026-11-01", dataRecebimento: null, valorPrevisto: 500_000 },
      ] }),
    base({ id: "2", tipo: "previo", status: "sem_acordo" }),
    base({ id: "3", tipo: "posterior", status: "aguardando_homologacao", faseOrigem: "pos_sentenca", valorAcordo: 3_000_000, valorCausa: 3_000_000,
      ajuizadoEm: "2026-01-01", fechadoEm: "2026-01-31", empresa: { chave: "cnpj:1", nome: "B", cnpj: "1" } }),
    base({ id: "4", tipo: "posterior", status: "em_negociacao" }),
  ];
  it("conversão prévio × posterior, razões, fase, tempo e inadimplência", () => {
    const r = calcularIndicadores(lista, hoje);
    expect(r.total).toBe(4);
    expect(r.fechados).toBe(2);
    expect(r.semAcordo).toBe(1);
    expect(r.taxaConversao).toBeCloseTo(2 / 3, 4);
    expect(r.porTipo.previo).toMatchObject({ total: 2, fechados: 1, semAcordo: 1, taxaConversao: 0.5 });
    expect(r.porTipo.posterior).toMatchObject({ total: 2, fechados: 1, semAcordo: 0, emAberto: 1, taxaConversao: 1 });
    expect(r.valorTotalAcordos).toBe(4_000_000);
    expect(r.acordoSobreCausa).toEqual({ qtd: 2, media: 0.625, agregada: 0.5714 });
    expect(r.acordoSobreEstimativa).toEqual({ qtd: 1, media: 0.5, agregada: 0.5 });
    expect(r.porFase).toEqual({ previo: 1, pos_sentenca: 1 });
    expect(r.tempoMedioDias).toBe(25);
    expect(r.inadimplencia).toMatchObject({ parcelasVencidas: 2, parcelasEmAtraso: 1, taxaParcelas: 0.5, acordosComParcelas: 1, acordosInadimplentes: 1, taxaAcordos: 1 });
  });
  it("lista vazia não divide por zero", () => {
    const r = calcularIndicadores([], hoje);
    expect(r.taxaConversao).toBeNull();
    expect(r.tempoMedioDias).toBeNull();
    expect(r.acordoSobreCausa.media).toBeNull();
  });
  it("agrupa por empresa ré", () => {
    const g = indicadoresPorEmpresa(lista, hoje);
    expect(g.map((x) => [x.chave, x.indicadores.total])).toEqual([["nome:a", 3], ["cnpj:1", 1]]);
    expect(g[1].cnpj).toBe("1");
  });
});

describe("êxito sem acordos", () => {
  it("exclui encerrados por acordo; 0 = improcedente; null fora da base", () => {
    const r = calcularExito([
      { id: "1", valorCondenacao: 1_000_000, valorCausa: 2_000_000, encerradoPorAcordo: false },
      { id: "2", valorCondenacao: 0, valorCausa: 1_000_000, encerradoPorAcordo: false },
      { id: "3", valorCondenacao: 5_000_000, valorCausa: 5_000_000, encerradoPorAcordo: true },
      { id: "4", valorCondenacao: null, valorCausa: 1_000_000, encerradoPorAcordo: false },
    ]);
    expect(r).toMatchObject({ excluidosPorAcordo: 1, comResultado: 2, exitos: 1, improcedentes: 1, taxaExito: 0.5, valorTotalCondenacoes: 1_000_000 });
    expect(r.condenacaoSobreCausa.media).toBe(0.5);
  });
});

describe("receita por tipo", () => {
  it("ticket médio e tempo até o 1º recebimento por processo", () => {
    const r = receitaPorTipo([
      { tipo: "acordo", dealId: "d1", dataRecebimento: "2026-03-01", receitaEscritorio: 30_000, bruto: 100_000, ajuizadoEm: "2026-01-01" },
      { tipo: "acordo", dealId: "d1", dataRecebimento: "2026-02-01", receitaEscritorio: 30_000, bruto: 100_000, ajuizadoEm: "2026-01-01" },
      { tipo: "execucao", dealId: "d2", dataRecebimento: "2026-01-11", receitaEscritorio: 90_000, bruto: 300_000, ajuizadoEm: "2026-01-01" },
      { tipo: "execucao", dealId: null, dataRecebimento: null, receitaEscritorio: 0, bruto: 0, ajuizadoEm: null },
    ]);
    expect(r.acordo).toMatchObject({ qtdRecebimentos: 2, qtdProcessos: 1, receitaEscritorio: 60_000, ticketMedioPorRecebimento: 30_000, ticketMedioPorProcesso: 60_000, tempoMedioAjuizamentoRecebimentoDias: 31 });
    expect(r.execucao).toMatchObject({ qtdRecebimentos: 1, tempoMedioAjuizamentoRecebimentoDias: 10 });
    expect(r.total.qtdProcessos).toBe(2);
  });
});
