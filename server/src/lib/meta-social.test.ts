import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { palavraDoComentario, preencher, assinaturaValida, tipoDoAnexo, origemDoEvento, telefoneNoTexto, separarOpcoes, lerRegras, regraDoTexto, todasPalavras, codigoDoPost, decidirPedirWhatsapp, PEDIR_WHATSAPP_PADRAO, linhaDoPost } from "./meta-social.js";

const PALAVRAS = ["FILA", "POR FORA", "SAUDE", "PRAZO"];

describe("palavraDoComentario", () => {
  it("acha a palavra inteira, sem acento e em qualquer caixa", () => {
    expect(palavraDoComentario("FILA", PALAVRAS)).toBe("FILA");
    expect(palavraDoComentario("quero saber da fila!!", PALAVRAS)).toBe("FILA");
    expect(palavraDoComentario("Saúde 🙏", PALAVRAS)).toBe("SAUDE");
    expect(palavraDoComentario("recebia por fora tbm", PALAVRAS)).toBe("POR FORA");
  });
  it("não casa pedaço de palavra nem comentário sem palavra-chave", () => {
    expect(palavraDoComentario("filas enormes", PALAVRAS)).toBe(null);
    expect(palavraDoComentario("muito bom o vídeo", PALAVRAS)).toBe(null);
    expect(palavraDoComentario("", PALAVRAS)).toBe(null);
  });
});

describe("preencher", () => {
  it("usa o primeiro nome e some com o espaço quando não há nome", () => {
    expect(preencher("Oi {nome}, te chamei aqui!", "João Carlos")).toBe("Oi João, te chamei aqui!");
    expect(preencher("Oi {nome}, te chamei aqui!", null)).toBe("Oi, te chamei aqui!");
  });
});

describe("assinaturaValida", () => {
  it("confere o HMAC do corpo cru", () => {
    const raw = '{"object":"instagram","entry":[]}';
    const sig = "sha256=" + createHmac("sha256", "segredo").update(raw).digest("hex");
    expect(assinaturaValida(raw, sig, "segredo")).toBe(true);
    expect(assinaturaValida(raw + " ", sig, "segredo")).toBe(false);
    expect(assinaturaValida(raw, sig, "outro")).toBe(false);
    expect(assinaturaValida(raw, undefined, "segredo")).toBe(false);
  });
});

describe("tipoDoAnexo", () => {
  it("mapeia os tipos da Meta", () => {
    expect(tipoDoAnexo("image")).toBe("image");
    expect(tipoDoAnexo("audio")).toBe("audio");
    expect(tipoDoAnexo("file")).toBe("document");
  });
});

describe("origemDoEvento", () => {
  it("link com ref ganha de tudo", () => {
    expect(origemDoEvento({ message: { text: "oi", referral: { ref: "fila" } } }, "instagram", PALAVRAS))
      .toEqual({ id: "FILA", titulo: "Instagram Direct · link FILA" });
    expect(origemDoEvento({ postback: { title: "Começar", referral: { ref: "saude-2" } } }, "messenger", PALAVRAS).id).toBe("SAUDE_2");
  });
  it("story, palavra-chave sozinha e direct", () => {
    expect(origemDoEvento({ message: { attachments: [{ type: "story_mention" }] } }, "instagram", PALAVRAS).id).toBe("story_mencao");
    expect(origemDoEvento({ message: { text: "que isso", reply_to: { story: { id: "1" } } } }, "instagram", PALAVRAS).id).toBe("story_resposta");
    expect(origemDoEvento({ message: { text: "Fila" } }, "instagram", PALAVRAS).id).toBe("FILA");
    expect(origemDoEvento({ message: { text: "quero saber da fila" } }, "messenger", PALAVRAS)).toEqual({ id: "direct", titulo: "Messenger" });
  });
});

describe("telefoneNoTexto", () => {
  it("normaliza celular em vários formatos", () => {
    expect(telefoneNoTexto("meu zap é (77) 99983-1015")).toBe("5577999831015");
    expect(telefoneNoTexto("77 9983-1015")).toBe("5577999831015"); // sem o 9º dígito
    expect(telefoneNoTexto("+55 11 98765 4321 pode chamar")).toBe("5511987654321");
    expect(telefoneNoTexto("77999831015")).toBe("5577999831015");
  });
  it("ignora fixo, número sem DDD e outros números", () => {
    expect(telefoneNoTexto("fixo 77 3422-1234")).toBe(null);
    expect(telefoneNoTexto("99983-1015")).toBe(null);
    expect(telefoneNoTexto("trabalhei 5 anos, 200 caminhões")).toBe(null);
  });
});

describe("separarOpcoes", () => {
  it("última linha entre colchetes vira botões", () => {
    expect(separarOpcoes("Você tem carteira assinada?\n[Sim | Não | Não sei]"))
      .toEqual({ texto: "Você tem carteira assinada?", opcoes: ["Sim", "Não", "Não sei"] });
    expect(separarOpcoes("Sem botões aqui")).toEqual({ texto: "Sem botões aqui", opcoes: [] });
  });
});

describe("regras por palavra-chave", () => {
  const regras = lerRegras(JSON.stringify([
    { palavras: "FILA, espera", resposta: "Sobre a fila\n[RESCISÃO | Já saí]", publico: "", posts: "https://www.instagram.com/reel/DAbc12/?igsh=x", seguir: true },
    { palavras: "Rescisão", resposta: "Sobre a rescisão", publico: "", posts: "", seguir: false },
    { palavras: "", resposta: "sem palavra é descartada" },
  ]));
  it("lê palavras, posts (link → código) e descarta regra incompleta", () => {
    expect(regras).toHaveLength(2);
    expect(regras[0].palavras).toEqual(["FILA", "espera"]);
    expect(regras[0].posts).toEqual(["DAbc12"]);
    expect(regras[0].seguir).toBe(true);
  });
  it("comentário: palavra em qualquer parte; Direct no meio da conversa: só a palavra", () => {
    expect(regraDoTexto("quero saber da ESPERA!", regras, false)?.regra).toBe(regras[0]);
    expect(regraDoTexto("quero saber da espera", regras, true)).toBe(null);
    expect(regraDoTexto("rescisao", regras, true)?.palavra).toBe("Rescisão");
    expect(regraDoTexto("bom dia", regras, false)).toBe(null);
  });
  it("todasPalavras junta as genéricas e as das regras sem repetir", () => {
    expect(todasPalavras({ palavras: ["FILA", "PRAZO"], regras })).toEqual(["FILA", "PRAZO", "espera", "Rescisão"]);
  });
  it("codigoDoPost entende link do Instagram e do Facebook", () => {
    expect(codigoDoPost("https://www.instagram.com/p/C9xYz_1/")).toBe("C9xYz_1");
    expect(codigoDoPost("https://www.facebook.com/rapadv/posts/1234567890")).toBe("1234567890");
    expect(codigoDoPost("17890000000000001")).toBe("17890000000000001");
  });
});

describe("decidirPedirWhatsapp", () => {
  const base = { config: "", temWhatsapp: false, pediuEm24h: false, humanoEm2h: false };
  it("pede com o texto padrão quando falta WhatsApp", () => {
    expect(decidirPedirWhatsapp(base)).toBe(PEDIR_WHATSAPP_PADRAO);
  });
  it("usa o texto configurado", () => {
    expect(decidirPedirWhatsapp({ ...base, config: "Manda o zap {nome}" })).toBe("Manda o zap {nome}");
  });
  it("não pede se já tem WhatsApp, se já pediu em 24h, se atendente respondeu ou se está off", () => {
    expect(decidirPedirWhatsapp({ ...base, temWhatsapp: true })).toBeNull();
    expect(decidirPedirWhatsapp({ ...base, pediuEm24h: true })).toBeNull();
    expect(decidirPedirWhatsapp({ ...base, humanoEm2h: true })).toBeNull();
    expect(decidirPedirWhatsapp({ ...base, config: "OFF" })).toBeNull();
  });
});

describe("linhaDoPost", () => {
  it("legenda curta + link", () => {
    expect(linhaDoPost({ link: "https://www.instagram.com/p/ABC/", legenda: "Tempo de espera\nconta como jornada" }))
      .toBe("\n📌 Post: “Tempo de espera conta como jornada”\nhttps://www.instagram.com/p/ABC/");
  });
  it("corta legenda longa e aceita só link", () => {
    expect(linhaDoPost({ link: "", legenda: "x".repeat(100) })).toBe(`\n📌 Post: “${"x".repeat(80)}…”`);
    expect(linhaDoPost({ link: "https://fb.com/1", legenda: "" })).toBe("\n📌 Post: https://fb.com/1");
    expect(linhaDoPost(null)).toBe("");
  });
});
