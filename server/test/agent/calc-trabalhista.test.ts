import { describe, it, expect } from "vitest";
import { calcularValorCausa, type VinculoCalculo } from "../../src/agent/calc-trabalhista.js";

const REF = new Date("2025-01-01");

function clt(overrides: Partial<VinculoCalculo> = {}): VinculoCalculo {
  return {
    empresa: "Transportadora XYZ",
    funcao: "Motorista",
    vinculo: "CLT",
    data_admissao: "2021-01-01",
    data_saida: "2023-12-31",
    salario_holerite: 4000,
    modalidade_saida: "demitido_sem_justa_causa",
    ...overrides,
  };
}

describe("calcularValorCausa", () => {
  it("retorna zero teses e mensagem sem dados quando vinculo vazio", () => {
    const r = calcularValorCausa([], REF);
    expect(r.vinculos_considerados).toBe(0);
    expect(r.total_estimado_min).toBe(0);
    expect(r.resumo_textual_curto).toContain("não foi possível calcular");
  });

  it("calcula horas extras para CLT com jornada longa", () => {
    const v = clt({ jornada_inicio: "05:00", jornada_fim: "18:00", intervalo_minutos: 60 });
    const r = calcularValorCausa([v], REF);
    expect(r.total_estimado_max).toBeGreaterThan(0);
    const he = r.por_tese.find(t => t.tese.includes("extra"));
    expect(he).toBeDefined();
    expect(he!.valor_max).toBeGreaterThan(0);
  });

  it("usa fallback de 12h para carreteiro sem jornada informada", () => {
    const v = clt({ jornada_inicio: undefined, jornada_fim: undefined });
    const r = calcularValorCausa([v], REF);
    expect(r.observacoes.some(o => o.includes("12h/dia"))).toBe(true);
    expect(r.total_estimado_max).toBeGreaterThan(0);
  });

  it("soma holerite + por_fora no salário base", () => {
    const vSemExtra = clt({ salario_holerite: 3000, salario_por_fora: undefined });
    const vComExtra = clt({ salario_holerite: 3000, salario_por_fora: 1000 });
    const rSem = calcularValorCausa([vSemExtra], REF);
    const rCom = calcularValorCausa([vComExtra], REF);
    expect(rCom.total_estimado_max).toBeGreaterThan(rSem.total_estimado_max);
  });

  it("marca vínculo prescrito quando encerrado há mais de 5 anos", () => {
    const v = clt({ data_saida: "2018-01-01" });
    const r = calcularValorCausa([v], REF);
    expect(r.vinculos_prescritos.length).toBe(1);
    expect(r.vinculos_considerados).toBe(0);
    expect(r.total_estimado_max).toBe(0);
  });

  it("aplica prescrição parcial para admissão > 5 anos atrás", () => {
    const vLongo = clt({ data_admissao: "2015-01-01", data_saida: "2023-12-31" });
    // curto: admissão 3 anos antes de REF (2025) → sem truncamento
    const vCurto = clt({ data_admissao: "2022-01-01", data_saida: "2023-12-31" });
    const rLongo = calcularValorCausa([vLongo], REF);
    const rCurto = calcularValorCausa([vCurto], REF);
    // Longo deveria ter observação de truncamento
    expect(rLongo.observacoes.some(o => o.includes("truncado"))).toBe(true);
    // Mas ainda calcula (5 anos máximo)
    expect(rLongo.total_estimado_max).toBeGreaterThan(0);
    // Curto não tem truncamento
    expect(rCurto.observacoes.some(o => o.includes("truncado"))).toBe(false);
  });

  it("pedido de demissão: sem verbas mas inclui tese de rescisão indireta", () => {
    const v = clt({ modalidade_saida: "pedido_demissao" });
    const r = calcularValorCausa([v], REF);
    const tese = r.por_tese.find(t => t.tese.includes("rescisão indireta"));
    expect(tese).toBeDefined();
  });

  it("ainda_trabalha: sem verbas rescisórias e observação", () => {
    const v = clt({ modalidade_saida: "ainda_trabalha", data_saida: undefined });
    const r = calcularValorCausa([v], REF);
    expect(r.observacoes.some(o => o.includes("desligamento"))).toBe(true);
  });

  it("detecta tese de dano moral por assédio", () => {
    const v = clt({ injustica_relatada: "pressao excessiva do gestor" });
    const r = calcularValorCausa([v], REF);
    const dm = r.por_tese.find(t => t.tese.includes("moral"));
    expect(dm).toBeDefined();
  });

  it("detecta tese de integração de pagamento por fora", () => {
    const v = clt({ salario_por_fora: 500 });
    const r = calcularValorCausa([v], REF);
    const integ = r.por_tese.find(t => t.tese.includes("por fora"));
    expect(integ).toBeDefined();
  });

  it("soma dois vínculos corretamente", () => {
    const v1 = clt({ empresa: "Empresa A", data_admissao: "2021-01-01", data_saida: "2022-12-31" });
    const v2 = clt({ empresa: "Empresa B", data_admissao: "2023-01-01", data_saida: "2024-01-01" });
    const r1 = calcularValorCausa([v1], REF);
    const r2 = calcularValorCausa([v2], REF);
    const rJunto = calcularValorCausa([v1, v2], REF);
    expect(rJunto.vinculos_considerados).toBe(2);
    expect(rJunto.total_estimado_max).toBeGreaterThanOrEqual(r1.total_estimado_max + r2.total_estimado_max - 1);
  });

  it("não calcula horas extras para vínculo PJ", () => {
    const v = clt({ vinculo: "PJ" });
    const r = calcularValorCausa([v], REF);
    const he = r.por_tese.find(t => t.tese.includes("extra"));
    expect(he).toBeUndefined();
  });

  it("usa tempo_meses_estimado quando não há datas", () => {
    const v: VinculoCalculo = {
      empresa: "Transportes", funcao: "Motorista", vinculo: "CLT",
      tempo_meses_estimado: 24, salario_holerite: 4000,
      modalidade_saida: "demitido_sem_justa_causa",
    };
    const r = calcularValorCausa([v], REF);
    expect(r.total_estimado_max).toBeGreaterThan(0);
    expect(r.observacoes.some(o => o.includes("estimado pelo cliente"))).toBe(true);
  });

  it("resumo textual menciona valores e tese principal", () => {
    const v = clt({ jornada_inicio: "05:00", jornada_fim: "18:00" });
    const r = calcularValorCausa([v], REF);
    expect(r.resumo_textual_curto).toMatch(/R\$\s[\d.,]+/);
    expect(r.resumo_textual_curto).toContain("sua causa");
  });

  it("retorna disclaimer em todos os resultados", () => {
    const r = calcularValorCausa([clt()], REF);
    expect(r.disclaimer).toContain("Estimativa preliminar");
  });
});
