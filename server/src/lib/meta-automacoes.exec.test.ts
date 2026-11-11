import { describe, it, expect, vi, beforeEach } from "vitest";

const envios: any[] = [];
let flagsDeal: any = {};
let segue: boolean | null = true;

vi.mock("../db.js", () => ({
  prisma: {
    crmDeal: {
      findUnique: vi.fn(async () => ({ iaFlags: flagsDeal })),
      update: vi.fn(async ({ data }: any) => { if (data.iaFlags) flagsDeal = data.iaFlags; return {}; }),
      count: vi.fn(async () => 0),
    },
    crmNota: { create: vi.fn(async () => ({})) },
    crmMensagemWhatsapp: { findFirst: vi.fn(async () => null) },
  },
}));

vi.mock("./meta-social.js", () => ({
  codigoDoPost: (s: string) => s,
  preencher: (t: string, n: string | null) => t.replace(/\{nome\}/g, n ?? ""),
  gravarMensagem: vi.fn(async () => true),
  enviarTextoSocial: vi.fn(async (_c: any, to: string, texto: string, botoes: any[]) => { envios.push({ via: "dm", to, texto, botoes }); return "mid"; }),
  enviarMensagemSocial: vi.fn(async (_c: any, to: string, message: any) => { envios.push({ via: "dm", to, message }); return "mid"; }),
  responderComentarioPrivado: vi.fn(async (_c: any, commentId: string, texto: string, botoes: any[]) => {
    envios.push({ via: "privado", commentId, texto, botoes });
    return { recipientId: "IGSID1", messageId: "m1", texto };
  }),
  segueOPerfil: vi.fn(async () => segue),
}));

const { lerAutomacoes, executar, continuacaoPendente } = await import("./meta-automacoes.js");

const AUTS = lerAutomacoes(JSON.stringify([
  { id: "coment", nome: "Comentário", gatilho: { tipo: "comentario", palavras: [] }, passos: [
    { tipo: "acao", acao: "nota", valor: "veio do Reel" },
    { tipo: "texto", texto: "Oi {nome}!" },
    { tipo: "audio", midia: { arquivo: "abc.m4a", nome: "explica.m4a" } },
    { tipo: "arquivo", midia: { arquivo: "def.pdf", nome: "guia.pdf" } },
  ] },
  { id: "menu", nome: "Menu", gatilho: { tipo: "dm_palavra", palavras: ["MENU"] }, passos: [
    { tipo: "texto", texto: "Escolha", botoes: [{ titulo: "Rescisão", vaiPara: "resc" }] },
    { tipo: "texto", texto: "nunca chega aqui" },
  ] },
  { id: "resc", nome: "Rescisão", gatilho: { tipo: "botao" }, passos: [
    { tipo: "condicao", se: "segue_perfil", senao: "pedir" },
    { tipo: "video", midia: { arquivo: "v.mp4", nome: "v.mp4" } },
  ] },
  { id: "pedir", nome: "Pedir follow", gatilho: { tipo: "botao" }, passos: [{ tipo: "texto", texto: "Segue a gente" }] },
]));

const cfg: any = { projetoId: "P1", empresaId: null };
const contato = { id: "C1", nome: "João" };
const deal = { id: "D1", pipelineId: "PIPE" };
const por = (id: string) => AUTS.find((a) => a.id === id)!;

beforeEach(() => { envios.length = 0; flagsDeal = {}; segue = true; });

describe("executar", () => {
  it("comentário: só uma resposta privada, com botão de continuar; o resto fica pendente", async () => {
    const abrir = vi.fn(async () => ({ contato, deal }));
    await executar({ cfg, canal: "instagram", userId: null, contato: null, deal: null, comentarioId: "CM1", abrir, nome: "João" }, AUTS, por("coment"));
    expect(envios).toHaveLength(1);
    expect(envios[0]).toMatchObject({ via: "privado", commentId: "CM1", texto: "Oi João!" });
    expect(envios[0].botoes[0].payload).toBe("AUT:coment:2");
    expect(abrir).toHaveBeenCalledWith("IGSID1");
    expect(await continuacaoPendente("D1")).toEqual({ id: "coment", passo: 2 });
  });

  it("continuação manda áudio e PDF por URL pública", async () => {
    await executar({ cfg, canal: "instagram", userId: "IGSID1", contato, deal, nome: "João" }, AUTS, por("coment"), 2);
    expect(envios.map((e) => e.message.attachment.type)).toEqual(["audio", "file"]);
    expect(envios[0].message.attachment.payload.url).toMatch(/\/api\/meta\/midia\/P1\/abc\.m4a$/);
  });

  it("texto com botões para o fluxo; o botão leva à outra automação", async () => {
    await executar({ cfg, canal: "instagram", userId: "U", contato, deal, nome: "João" }, AUTS, por("menu"));
    expect(envios).toHaveLength(1);
    expect(envios[0].botoes).toEqual([{ titulo: "Rescisão", payload: "AUT:resc:0" }]);
  });

  it("condição: segue → continua; não segue → desvia", async () => {
    await executar({ cfg, canal: "instagram", userId: "U", contato, deal, nome: "João" }, AUTS, por("resc"));
    expect(envios[0].message.attachment.type).toBe("video");
    envios.length = 0; segue = false;
    await executar({ cfg, canal: "instagram", userId: "U", contato, deal, nome: "João" }, AUTS, por("resc"));
    expect(envios).toEqual([expect.objectContaining({ texto: "Segue a gente" })]);
  });
});
