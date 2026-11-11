import { describe, it, expect } from "vitest";
import { classificarPersona, mesesDeCasa, frotaAte30, dentroDoPrazo, sinaisDaConversa } from "./persona-icp.js";

const REF = new Date(2026, 9, 22); // 22/10/2026

describe("mesesDeCasa", () => {
  it("lê anos e meses por extenso ou em número", () => {
    expect(mesesDeCasa("2 anos e 9 meses")).toBe(33);
    expect(mesesDeCasa("oito meses")).toBe(8);
    expect(mesesDeCasa("quase dois anos")).toBe(24);
    expect(mesesDeCasa("cerca de 1 ano a 1 ano e meio")).toBe(18);
    expect(mesesDeCasa("de 2008 até 2019")).toBe(132);
    expect(mesesDeCasa("desde 1993 até hoje", REF)).toBe(33 * 12);
    expect(mesesDeCasa("um ano mais ou menos")).toBe(12);
  });
});

describe("frotaAte30", () => {
  it("só confirma quando o texto garante", () => {
    expect(frotaAte30("mais de 200 caminhões")).toBe(true);
    expect(frotaAte30("50 a 200")).toBe(true);
    expect(frotaAte30("menos de 50")).toBe(null);
    expect(frotaAte30("7 carretas")).toBe(false);
    expect(frotaAte30("não sabe")).toBe(null);
    expect(frotaAte30("caminhão da empresa")).toBe(null);
  });
});

describe("dentroDoPrazo", () => {
  it("ainda na empresa, data de saída e 'há N anos'", () => {
    expect(dentroDoPrazo("ainda trabalha na empresa", "", REF)).toBe(true);
    expect(dentroDoPrazo("ainda empregado, afastado pelo inss", "", REF)).toBe(true);
    expect(dentroDoPrazo("demitido sem justa causa", "07/2026", REF)).toBe(true);
    expect(dentroDoPrazo("mandaram embora na pandemia", "12/2019", REF)).toBe(false);
    expect(dentroDoPrazo("demitido há cerca de quatro anos", "", REF)).toBe(false);
    expect(dentroDoPrazo("demitido sem justa causa há 9-10 meses", "", REF)).toBe(true);
    expect(dentroDoPrazo("trabalhou até 2015", "", REF)).toBe(false);
    expect(dentroDoPrazo("demitido", "", REF)).toBe(null);
  });
});

describe("classificarPersona", () => {
  it("ideal: carreteiro CLT no prazo com agravante", () => {
    const p = classificarPersona({
      e_carreteiro: true,
      vinculos: [{ ordem: 1, funcao: "motorista carreteiro", vinculo: "CLT", saida: "ainda trabalha", tempo: "5 anos", frota: "menos de 50" }],
    }, REF);
    expect(p.faixa).toBe("ideal");
  });
  it("parcial: carreteiro CLT no prazo sem agravante", () => {
    const p = classificarPersona({
      e_carreteiro: true,
      vinculos: [{ ordem: 1, vinculo: "CLT", saida: "ainda trabalha", tempo: "8 meses", pagamento_fora: "não" }],
    }, REF);
    expect(p.faixa).toBe("parcial");
  });
  it("fora: sem registro, prescrito ou não carreteiro", () => {
    expect(classificarPersona({ e_carreteiro: true, vinculos: [{ ordem: 1, vinculo: "informal/sem registro" }] }, REF).faixa).toBe("fora");
    expect(classificarPersona({ e_carreteiro: true, vinculos: [{ ordem: 1, vinculo: "CLT", saida: "x", data_saida: "12/2019" }] }, REF).faixa).toBe("fora");
    expect(classificarPersona({ e_carreteiro: false }, REF).faixa).toBe("fora");
  });
  it("sem dados quando a conversa não disse se é carreteiro", () => {
    expect(classificarPersona(null, REF).faixa).toBe("sem_dados");
    expect(classificarPersona({ nome: "João" }, REF).faixa).toBe("sem_dados");
  });
  it("usa os campos planos (_recente) quando não há lista de vínculos", () => {
    const p = classificarPersona({ e_carreteiro: true, vinculo_recente: "CLT", saida_recente: "ainda trabalha", pagamento_fora_recente: "comissão" }, REF);
    expect(p.faixa).toBe("ideal");
  });
});

describe("conversa do lead (quando a IA não extraiu)", () => {
  it("lê sinais fortes do texto do lead", () => {
    const s = sinaisDaConversa("Boa tarde, sou motorista de carreta, carteira assinada, ainda trabalho lá. Recebo diária no pix");
    expect(s).toEqual({ carreteiro: true, clt: true, noPrazo: true, porFora: true });
    expect(sinaisDaConversa("trabalhei sem carteira assinada").clt).toBe(false);
    expect(sinaisDaConversa("Oi, bom dia").carreteiro).toBe(null);
  });
  it("preenche só o que a IA deixou em branco", () => {
    const p = classificarPersona({ vinculos: [{ ordem: 1, empresa: "JBS" }] }, REF, "sou carreteiro registrado, ainda trabalho, ganho comissão por fora");
    expect(p.faixa).toBe("ideal");
    const q = classificarPersona({ e_carreteiro: false }, REF, "dirijo carreta");
    expect(q.faixa).toBe("fora"); // a extração da IA vale mais que o texto
  });
});
