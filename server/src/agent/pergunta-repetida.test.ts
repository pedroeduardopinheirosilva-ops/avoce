import { describe, it, expect } from "vitest";
import { mesmaPergunta, assinaturaPergunta } from "./pergunta-repetida.js";

describe("mesmaPergunta", () => {
  it("pega as variantes reais do caso Carlos (acao_andamento_rec × _ant)", () => {
    expect(mesmaPergunta(
      "Você já tem advogado cuidando desse caso ou alguma ação trabalhista em andamento sobre esse emprego?",
      "Você já tem advogado ou alguma ação trabalhista em andamento sobre esse emprego?",
    )).toBe(true);
    expect(mesmaPergunta(
      "Você já tem advogado cuidando desse caso ou alguma ação trabalhista em andamento sobre esse emprego?",
      "E sobre esse emprego, você já tem advogado ou alguma ação trabalhista em andamento?",
    )).toBe(true);
  });

  it("pega as variantes reais do caso Keylla (função lá × função na empresa)", () => {
    expect(mesmaPergunta(
      "Qual era sua função lá?",
      "Qual era sua função na Eureka transportadora?",
    )).toBe(true);
    expect(mesmaPergunta(
      "E na Eureka transportadora, qual era a sua função?",
      "Qual era sua função na Eureka transportadora?",
    )).toBe(true);
  });

  it("não confunde perguntas diferentes do mesmo fluxo", () => {
    expect(mesmaPergunta(
      "Qual era sua função lá?",
      "Qual era o nome da empresa onde você trabalhava?",
    )).toBe(false);
    expect(mesmaPergunta(
      "Você já tem advogado cuidando desse caso?",
      "Como foi o desligamento — foi demitido, pediu demissão ou ainda está lá?",
    )).toBe(false);
    expect(mesmaPergunta(
      "Você fazia hora extra? E recebia por elas ou entrava tudo na comissão?",
      "Recebia algum valor fora do holerite, como Pix ou dinheiro em mãos?",
    )).toBe(false);
    expect(mesmaPergunta(
      "Nessa empresa você tinha carteira assinada, trabalhava sem registro ou era autônomo?",
      "Você tem ideia de quantos caminhões a empresa tinha?",
    )).toBe(false);
  });

  it("ignora prefixo de persona e placeholders", () => {
    expect(assinaturaPergunta("*Isabella*\nQual era sua função na {{empresa}}?"))
      .toBe(assinaturaPergunta("Qual era sua função?"));
  });
});

// ── Caso Cigano 558296386688 (04/11/2026) ────────────────────────────────────
import { ehReenvioDoLead, leadRespondeuDepois, respostaJaFazPergunta, type MsgHist } from "./pergunta-repetida.js";

const t = (hms: string) => new Date(`2026-11-04T${hms}-03:00`);
const inn = (hms: string, conteudo: string, id?: string): MsgHist => ({ direcao: "in", conteudo, enviadaEm: t(hms), evolutionMessageId: id ?? hms });
const out = (hms: string, conteudo: string): MsgHist => ({ direcao: "out", conteudo, enviadaEm: t(hms) });

describe("respostaJaFazPergunta — segunda bolha duplicada", () => {
  it("detecta que o LLM já perguntou sobre advogado/ação com outras palavras", () => {
    expect(respostaJaFazPergunta(
      "Você já tem alguma ação trabalhista em andamento ou advogado cuidando desse caso?",
      "Você já tem advogado cuidando desse caso ou alguma ação trabalhista em andamento sobre esse emprego?",
    )).toBe(true);
  });
  it("detecta a pergunta no fim de uma resposta com comentário antes", () => {
    expect(respostaJaFazPergunta(
      "Poxa, FGTS sem depósito é sério. Você já tem advogado ou alguma ação trabalhista em andamento?",
      "Você já tem advogado cuidando desse caso ou alguma ação trabalhista em andamento sobre esse emprego?",
    )).toBe(true);
  });
  it("não bloqueia quando o LLM respondeu outra coisa", () => {
    expect(respostaJaFazPergunta(
      "Entendi, isso de pagar parte por fora é bem comum. Quanto tempo de casa você tem?",
      "Você já tem advogado cuidando desse caso ou alguma ação trabalhista em andamento sobre esse emprego?",
    )).toBe(false);
    expect(respostaJaFazPergunta("Entendi! Vou anotar aqui.", "Você fazia hora extra?")).toBe(false);
  });
});

describe("ehReenvioDoLead", () => {
  it("'Mas de 200' repetido no segundo em que a IA respondeu é reenvio", () => {
    const hist = [
      inn("22:57:29", "Mas de 200", "B"),
      out("22:57:29", "Antes de trabalhar lá, você trabalhou em outro lugar nos últimos 2 anos?"),
      inn("22:57:21", "Mas de 200", "A"),
      out("22:57:17", "Quantos caminhões a empresa tem mais ou menos?"),
    ];
    expect(ehReenvioDoLead(hist, "B")).toBe(true);
  });
  it("mesma palavra para duas perguntas diferentes, com tempo de leitura, NÃO é reenvio", () => {
    const hist = [
      inn("22:56:20", "Não", "B"),
      out("22:56:16", "Você fazia hora extra?"),
      inn("22:56:06", "Não", "A"),
      out("22:55:51", "Você já tem advogado cuidando desse caso?"),
    ];
    expect(ehReenvioDoLead(hist, "B")).toBe(false);
  });
  it("se a primeira ainda não teve resposta (lote pendente), a segunda dispara", () => {
    const hist = [inn("22:57:29", "Mas de 200", "B"), inn("22:57:21", "Mas de 200", "A")];
    expect(ehReenvioDoLead(hist, "B")).toBe(false);
  });
  it("textos diferentes não são reenvio", () => {
    const hist = [inn("22:58:31", "Na Tombini", "B"), out("22:58:14", "Registrei tudo"), inn("22:57:52", "Sim na Tombini", "A")];
    expect(ehReenvioDoLead(hist, "B")).toBe(false);
  });
});

describe("leadRespondeuDepois", () => {
  const pergunta = out("22:57:29", "Antes de trabalhar lá, você trabalhou em outro lugar nos últimos 2 anos?");
  it("mensagem que chega junto com a pergunta (reenvio) não é resposta", () => {
    const hist = [inn("22:57:29", "Mas de 200", "B"), pergunta, inn("22:57:21", "Mas de 200", "A")];
    expect(leadRespondeuDepois(hist, pergunta)).toBe(false);
  });
  it("resposta real depois da pergunta conta", () => {
    const hist = [inn("22:57:52", "Sim na Tombini"), pergunta, inn("22:57:21", "Mas de 200")];
    expect(leadRespondeuDepois(hist, pergunta)).toBe(true);
  });
});
