import { describe, it, expect } from "vitest";
import {
  detectaAcaoEmAndamento,
  decidirAcaoEmAndamento,
  isDispensaPorAdvogado,
  trechoAcaoEmAndamento,
  detectaPedidoContato,
  isEmpresaPlaceholder,
  limparEmpresaPlaceholder,
} from "./sinais-lead.js";

describe("detectaAcaoEmAndamento", () => {
  it("pega a afirmação do Ledison (26/08 12:09)", () => {
    expect(detectaAcaoEmAndamento(
      "Tem o anterior, né? O outro que eu tava nele. Eu já tenho ação contra eles. Agora é isso aí não."
    )).toBe(true);
  });
  it("pega advogado já constituído", () => {
    expect(detectaAcaoEmAndamento("já tenho advogado cuidando disso")).toBe(true);
    expect(detectaAcaoEmAndamento("meu processo tá correndo lá no fórum")).toBe(true);
  });
  it("não confunde negação com afirmação", () => {
    expect(detectaAcaoEmAndamento("Não")).toBe(false);
    expect(detectaAcaoEmAndamento("não tenho ação nenhuma")).toBe(false);
    expect(detectaAcaoEmAndamento("não, não tenho advogado")).toBe(false);
    expect(detectaAcaoEmAndamento("Termos coloquiais, não, não, não, não.")).toBe(false);
  });
  it("acha a afirmação mesmo quando vem DEPOIS de uma negação na mesma mensagem", () => {
    // Robson 553195847242: nega para o emprego atual e afirma para os anteriores.
    expect(detectaAcaoEmAndamento(
      "Não, sobre esse emprego não tem nada, não entrei na justiça ainda não. Não, ainda não movi a ação não. " +
      "Eu tô trabalhando na empresa e vou ver a possibilidade deles acertarem comigo. " +
      "Eu já tenho ação com outras empresas. Eu tenho ação contra a Jaméf, trabalhei cinco anos."
    )).toBe(true);
  });
  it("continua negativo quando a mensagem inteira nega", () => {
    // Carlos 5521995367039 — o antigo detector dava falso positivo aqui.
    expect(detectaAcaoEmAndamento(
      "a pergunta que tá me perguntando é se eu tenho um advogado. Eu já falei nos outros áudios que não, " +
      "não tem advogado. Foi recente, foi mês passado que eu saí da empresa. Eu não contatei nenhum advogado ainda."
    )).toBe(false);
  });
  it("não confunde 'processo' do dia a dia do caminhoneiro com processo judicial", () => {
    // Falsos positivos reais do backfill de 30/08 (Robson 553195847242).
    expect(detectaAcaoEmAndamento("Temos um processo de transporte, por exemplo, no Brasil")).toBe(false);
    expect(detectaAcaoEmAndamento("tem um processo de carregamento demorado lá")).toBe(false);
  });
  it("aceita processo com qualificador jurídico", () => {
    expect(detectaAcaoEmAndamento("tenho um processo trabalhista lá")).toBe(true);
    expect(detectaAcaoEmAndamento("o processo tá correndo")).toBe(true);
  });
  it("não confunde intenção futura com ação existente", () => {
    expect(detectaAcaoEmAndamento("quero entrar com uma ação")).toBe(false);
    expect(detectaAcaoEmAndamento("como faço para entrar com processo?")).toBe(false);
  });
});

describe("trechoAcaoEmAndamento", () => {
  it("devolve o trecho que casou, para auditoria", () => {
    const t = trechoAcaoEmAndamento("O outro que eu tava nele. Eu já tenho ação contra eles.");
    expect(t).toContain("tenho acao");
    expect(trechoAcaoEmAndamento("não tenho nada disso")).toBeNull();
  });
});

describe("detectaPedidoContato", () => {
  it("pega o pedido de ligação do Ledison (29/08 12:31 e 12:32)", () => {
    expect(detectaPedidoContato(
      "Positivo, Isabela. Quero sim. Como é que a gente... vocês têm como ligar para mim, alguma coisa assim, para explicar direitinho?"
    )).toBe(true);
    expect(detectaPedidoContato("Qualquer hora, qualquer hora você pode ligar.")).toBe(true);
  });
  it("pega intenção de seguir", () => {
    expect(detectaPedidoContato("quero seguir com a ação")).toBe(true);
    expect(detectaPedidoContato("me liga aí")).toBe(true);
  });
  it("não dispara com recusa", () => {
    expect(detectaPedidoContato("não quero seguir")).toBe(false);
    expect(detectaPedidoContato("agora não pode ligar")).toBe(false);
    expect(detectaPedidoContato("1 ano")).toBe(false);
    expect(detectaPedidoContato("Motorista de rodotrem puxando madeira")).toBe(false);
  });
});

describe("placeholder de empresa", () => {
  it("reconhece o que o LLM inventa quando não sabe o nome", () => {
    for (const s of ["não identificada", "nao informada", "não especificada", "não declarada",
                     "não sei", "desconhecida", "N/A", "?", "-", "  "]) {
      expect(isEmpresaPlaceholder(s)).toBe(true);
    }
    expect(isEmpresaPlaceholder(null)).toBe(true);
  });
  it("preserva nome real de empresa", () => {
    expect(limparEmpresaPlaceholder("Serrana Logs")).toBe("Serrana Logs");
    expect(limparEmpresaPlaceholder("  Bracell  ")).toBe("Bracell");
    expect(limparEmpresaPlaceholder("não identificada")).toBeUndefined();
  });
});

describe("detector só em primeira pessoa", () => {
  it("ignora advogado de terceiro e pedido de falar com advogado", () => {
    expect(detectaAcaoEmAndamento("ele tem dois cunhados, ele tem advogado")).toBe(false);
    expect(detectaAcaoEmAndamento("tem como falar com um advogado?")).toBe(false);
    expect(detectaAcaoEmAndamento("tenho que falar com advogado")).toBe(false);
    expect(detectaAcaoEmAndamento("Temos que terá um direito de advogado")).toBe(false);
  });
});

describe("decidirAcaoEmAndamento", () => {
  const perg = ["Você já tem advogado cuidando desse caso ou alguma ação trabalhista em andamento sobre esse emprego?"];
  const outra = ["Você fazia hora extra?"];
  const base = { valorAtual: undefined, confirmada: false };
  it("José Olívio 09/11: fala do patrão sem pergunta direta é só suspeita", () => {
    expect(decidirAcaoEmAndamento({ ...base, texto: "ele disse que quem quiser pôr no pau pode colocar porque eu tenho advogado pra isso", saidasIa: outra })).toBe("suspeita");
  });
  it("extração LLM sem pergunta direta é só suspeita", () => {
    expect(decidirAcaoEmAndamento({ ...base, valorAtual: true, texto: "como está o meu processo", saidasIa: outra })).toBe("suspeita");
  });
  it("Sim à pergunta direta confirma", () => {
    expect(decidirAcaoEmAndamento({ ...base, valorAtual: true, texto: "Sim", saidasIa: perg })).toBe("confirmar");
    expect(decidirAcaoEmAndamento({ ...base, texto: "já tenho advogado cuidando disso", saidasIa: perg })).toBe("confirmar");
  });
  it("Não à pergunta direta nunca confirma, mesmo com extração true", () => {
    expect(decidirAcaoEmAndamento({ ...base, valorAtual: true, texto: "Não tenho mais", saidasIa: perg })).toBe("suspeita");
  });
  it("desmentido desfaz registro anterior", () => {
    expect(decidirAcaoEmAndamento({ valorAtual: true, confirmada: true, texto: "Não tem advogado nenhum mexendo nesse assunto", saidasIa: outra })).toBe("negou");
    expect(decidirAcaoEmAndamento({ valorAtual: true, confirmada: true, texto: "nao existe advogado cuidando", saidasIa: outra })).toBe("negou");
  });
  it("sem menção nada muda", () => {
    expect(decidirAcaoEmAndamento({ ...base, valorAtual: false, texto: "Não", saidasIa: perg })).toBe("manter");
  });
});

describe("isDispensaPorAdvogado", () => {
  it("reconhece a dispensa e não a pergunta", () => {
    expect(isDispensaPorAdvogado("Como esse caso já foi resolvido na Justiça com outro advogado, por ética não podemos assumir.")).toBe(true);
    expect(isDispensaPorAdvogado("Você já tem advogado cuidando desse caso?")).toBe(false);
  });
});
