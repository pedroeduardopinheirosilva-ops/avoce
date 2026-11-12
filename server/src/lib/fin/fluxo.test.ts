import { describe, expect, it } from "vitest";
import { eventosDeRecebimento, montarFluxoCaixa, projetarRendimento, type EventoFluxo } from "./fluxo.js";

describe("montarFluxoCaixa", () => {
  const hoje = "2026-11-12";

  it("separa realizado/projetado, terceiros fora do líquido do escritório, saldo acumulado", () => {
    const eventos: EventoFluxo[] = [
      { data: "2026-10-05", linha: "despesas", valorCentavos: 1000, realizado: true },
      { data: "2026-10-20", linha: "honorarios_recebimentos", valorCentavos: 5000, realizado: true },
      { data: "2026-10-20", linha: "terceiros_entrada", valorCentavos: 7000, realizado: true },
      { data: "2026-11-30", linha: "terceiros_saida", valorCentavos: 7000, realizado: false },
      { data: "2026-12-10", linha: "despesas_recorrentes", valorCentavos: 1000, realizado: false },
      { data: "2026-12-15", linha: "aportes_psa", valorCentavos: 20000, realizado: false },
    ];
    const f = montarFluxoCaixa({ eventos, de: { ano: 2026, mes: 10 }, meses: 3, hoje, saldoInicialCentavos: 100 });
    const [out, nov, dez] = f.meses;
    expect(out.situacao).toBe("passado");
    expect(nov.situacao).toBe("corrente");
    expect(dez.situacao).toBe("futuro");
    expect(out.liquidoEscritorio).toBe(4000);
    expect(out.liquidoTerceiros).toBe(7000);
    expect(out.saldoFinal).toBe(100 + 4000 + 7000);
    expect(nov.liquidoTerceiros).toBe(-7000);
    expect(nov.liquidoEscritorio).toBe(0);
    expect(dez.linhas.aportes_psa.projetado).toBe(20000);
    expect(dez.liquidoEscritorio).toBe(19000);
    expect(dez.saldoFinal).toBe(100 + 4000 + 19000);
    expect(f.totais.despesas.realizado).toBe(1000);
  });

  it("previsto vencido vai para o mês corrente (atrasados); fora do horizonte é ignorado", () => {
    const eventos: EventoFluxo[] = [
      { data: "2026-08-10", linha: "honorarios_recebimentos", valorCentavos: 3000, realizado: false },
      { data: "2026-08-10", linha: "despesas", valorCentavos: 500, realizado: true },
      { data: "2028-01-01", linha: "despesas", valorCentavos: 1, realizado: false },
    ];
    const f = montarFluxoCaixa({ eventos, de: { ano: 2026, mes: 11 }, meses: 12, hoje });
    expect(f.meses[0].linhas.honorarios_recebimentos.projetado).toBe(3000);
    expect(f.meses[0].atrasados).toBe(3000);
    expect(f.ignorados).toBe(2);
    expect(f.meses).toHaveLength(12);
  });
});

describe("eventosDeRecebimento", () => {
  const hoje = "2026-11-12";

  it("recebido com repasse pendente: honorários realizados, saída de terceiros projetada hoje", () => {
    const { eventos } = eventosDeRecebimento({
      dataRecebimento: "2026-11-01", valorBrutoCentavos: 10000, valorHonorariosCentavos: 3000, valorRepasseCentavos: 7000,
      valorSucumbenciaCentavos: 500, repasseStatus: "pendente",
    }, hoje);
    expect(eventos).toEqual([
      { data: "2026-11-01", linha: "honorarios_recebimentos", valorCentavos: 3500, realizado: true },
      { data: "2026-11-01", linha: "terceiros_entrada", valorCentavos: 7000, realizado: true },
      { data: hoje, linha: "terceiros_saida", valorCentavos: 7000, realizado: false },
    ]);
  });

  it("previsto com % de honorários divide escritório × terceiros no vencimento", () => {
    const { eventos, semPercentual } = eventosDeRecebimento({
      vencimento: "2027-01-10", valorPrevistoCentavos: 10000, percHonorarios: "30.00", repasseStatus: "pendente",
    }, hoje);
    expect(semPercentual).toBe(false);
    expect(eventos.map((e) => [e.linha, e.valorCentavos])).toEqual([
      ["honorarios_recebimentos", 3000], ["terceiros_entrada", 7000], ["terceiros_saida", 7000],
    ]);
  });

  it("previsto sem % e sem honorários: conservador (tudo terceiros) e sinaliza", () => {
    const r = eventosDeRecebimento({ vencimento: "2027-01-10", valorPrevistoCentavos: 10000, repasseStatus: "pendente" }, hoje);
    expect(r.semPercentual).toBe(true);
    expect(r.eventos.find((e) => e.linha === "honorarios_recebimentos")).toBeUndefined();
  });

  it("nao_aplicavel: todo o bruto é do escritório", () => {
    const { eventos } = eventosDeRecebimento({ vencimento: "2027-01-10", valorPrevistoCentavos: 10000, repasseStatus: "nao_aplicavel" }, hoje);
    expect(eventos).toEqual([{ data: "2027-01-10", linha: "honorarios_recebimentos", valorCentavos: 10000, realizado: false }]);
  });
});

describe("projetarRendimento", () => {
  it("capitaliza mês a mês", () => {
    expect(projetarRendimento(100000, [1, 1])).toEqual([1000, 1010]);
    expect(projetarRendimento(0, [1])).toEqual([0]);
  });
});
