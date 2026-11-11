/**
 * Instagram Direct e Messenger (Página do Facebook) como canais do CRM, ao lado do WhatsApp.
 *
 * Usa a Messenger Platform com o token da Página: o mesmo token responde as duas redes
 * (POST /me/messages, recipient = IGSID ou PSID) e manda a resposta privada a comentários
 * (recipient = { comment_id }). O webhook é um só — /api/meta/webhook — e chega com
 * object "page" (Messenger + comentários do Facebook) ou "instagram" (Direct + comentários do IG).
 *
 * A conversa vira deal no funil de entrada do projeto, com a IA desligada: o atendimento
 * no Direct é humano. A resposta automática (opcional) leva o lead para o WhatsApp, onde a
 * Ana qualifica.
 *
 * Configuração por projeto de IA (IaProjetoConfig, categoria "meta_social"):
 *   meta_social_ativo                "true" liga o processamento do webhook
 *   meta_social_page_token           token da Página (de preferência de system user, sem expiração)
 *   meta_social_app_secret           segredo do app — valida a assinatura X-Hub-Signature-256
 *   meta_social_verify_token         texto livre que o painel da Meta devolve na verificação do webhook
 *   meta_social_page_id / _ig_id     preenchidos ao conectar (GET /me)
 *   meta_social_automacoes           JSON das automações (lib/meta-automacoes.ts): gatilho + passos — o
 *                                    único motor de resposta automática de Direct, comentário e story
 *   meta_social_palavras             palavras extras só para rastrear a origem e montar links
 *   meta_social_ice_breakers         JSON [{pergunta, resposta}] — até 4 perguntas prontas no 1º contato
 *   meta_social_whatsapp_abertura    1ª mensagem no WhatsApp quando o lead manda o telefone no Direct
 *                                    (vazio = só grava o número; preenchido = a Ana assume no WhatsApp)
 *   meta_social_telefone_resposta    confirmação no Direct depois de chamar no WhatsApp
 *   meta_social_whatsapp_numero      número para montar os links wa.me na tela
 *   meta_social_ig_username          preenchido ao conectar (links ig.me)
 *
 * As chaves antigas (resposta_auto, regras, comentario_resposta/_todos/_publico, story_*, seguir_aviso)
 * viraram automações e não são mais lidas no atendimento. Sem nenhuma automação ativa, ninguém
 * recebe resposta automática (só o ice breaker com resposta própria e a confirmação do telefone).
 *
 * Novo seguidor: a Meta não documenta webhook público; o "Follow to DM" do
 * ManyChat é beta liberado pela Meta conta a conta (out/2025, só no login unificado do Instagram).
 * Se o campo chegar a este app, aparece no log como "Campo não tratado".
 *
 * Respostas automáticas aceitam botões: a última linha "[Opção 1 | Opção 2]" vira quick replies.
 * Origem do lead, nesta ordem: link com ?ref= (ig.me/m.me), menção ou resposta a story,
 * palavra-chave sozinha na mensagem, senão "Direct"/"Messenger".
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { PALAVRAS_CTA } from "../agent/lead-origem.js";
import * as aut from "./meta-automacoes.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const TIMEOUT_MS = 15_000;

export type CanalSocial = "instagram" | "messenger";

export type SocialConfig = {
  projetoId: string;
  empresaId: string | null;
  ativo: boolean;
  pageToken: string;
  appSecret: string;
  verifyToken: string;
  pageId: string;
  igId: string;
  respostaAuto: string;
  palavras: string[];
  comentarioResposta: string;
  comentarioPublico: string;
  iceBreakers: { pergunta: string; resposta: string }[];
  whatsappAbertura: string;
  telefoneResposta: string;
  igUsername: string;
  whatsappNumero: string;
  regras: RegraPalavra[];
  storyResposta: string;
  storyMencao: string;
  seguirAviso: string;
  comentarioTodos: string;
  /** Mensagem privada que nenhuma automação atendeu, de quem ainda não deu o WhatsApp: pede o número.
   *  Vazio = texto padrão; "off" = desligado. */
  pedirWhatsapp: string;
  /** Com itens, substitui regras/story/1ª resposta/comentário qualquer (lib/meta-automacoes.ts). */
  automacoes: aut.Automacao[];
};

export type RegraPalavra = { palavras: string[]; resposta: string; publico: string; posts: string[]; seguir: boolean };

// ── Puras (testadas em meta-social.test.ts) ─────────────────────────────────

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normalizar = (s: string) => semAcento(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** "Quero saber da FILA!" → "FILA". Palavra inteira; a mais longa ganha ("POR FORA" antes de "FORA"). */
export function palavraDoComentario(texto: string, palavras: string[]): string | null {
  const t = ` ${normalizar(texto)} `;
  const ordem = [...palavras].map(normalizar).filter(Boolean).sort((a, b) => b.length - a.length);
  return ordem.find((p) => t.includes(` ${p} `)) ?? null;
}

export function preencher(modelo: string, nome: string | null): string {
  const primeiro = (nome ?? "").trim().split(/\s+/)[0] ?? "";
  return modelo.replace(/\{nome\}/g, primeiro).replace(/\s+([,!?.])/g, "$1").trim();
}

/** X-Hub-Signature-256 = "sha256=" + HMAC(app_secret, corpo cru). */
export function assinaturaValida(raw: string, header: string | undefined, segredo: string): boolean {
  if (!header || !segredo) return false;
  const esperado = Buffer.from("sha256=" + createHmac("sha256", segredo).update(raw).digest("hex"));
  const veio = Buffer.from(header);
  return esperado.length === veio.length && timingSafeEqual(esperado, veio);
}

/** Tipo de mensagem do CRM a partir do anexo da Meta. */
export function tipoDoAnexo(t: string | undefined): string {
  if (t === "image") return "image";
  if (t === "audio") return "audio";
  if (t === "video") return "video";
  return "document";
}

/** `etapaChave`: coluna do funil onde o deal novo entra, se existir no pipeline (senão a de entrada). */
export type Origem = { id: string; titulo: string; etapaChave?: string };

const refDoEvento = (ev: any): string | null =>
  ev?.referral?.ref ?? ev?.message?.referral?.ref ?? ev?.postback?.referral?.ref ?? null;

/** De onde veio a conversa (ver a ordem no cabeçalho do arquivo). */
export function origemDoEvento(ev: any, canal: CanalSocial, palavras: string[]): Origem {
  const nomeCanal = canal === "instagram" ? "Instagram Direct" : "Messenger";
  const ref = refDoEvento(ev);
  if (ref) {
    const id = normalizar(String(ref)).replace(/ /g, "_").slice(0, 40) || "LINK";
    return { id, titulo: `${nomeCanal} · link ${id}` };
  }
  const m = ev?.message ?? {};
  if ((m.attachments ?? []).some((a: any) => a?.type === "story_mention")) return { id: "story_mencao", titulo: "Story · menção ao perfil" };
  if (m.reply_to?.story) return { id: "story_resposta", titulo: "Story · resposta" };
  const texto: string = m.text ?? "";
  const palavra = texto ? palavraDoComentario(texto, palavras) : null;
  if (palavra && normalizar(texto) === normalizar(palavra)) return { id: palavra, titulo: `${nomeCanal} · palavra-chave ${palavra}` };
  return { id: "direct", titulo: nomeCanal };
}

/** Celular brasileiro escrito no texto → 55 + DDD + 9 dígitos. Fixo e número sem DDD ficam de fora. */
export function telefoneNoTexto(texto: string): string | null {
  const achados = texto.match(/(?:\+?55[\s.-]*)?\(?\d{2}\)?[\s.-]*9?[\s.-]*\d{4}[\s.-]*\d{4}/g) ?? [];
  for (const a of achados) {
    let d = a.replace(/\D/g, "");
    if ((d.length === 12 || d.length === 13) && d.startsWith("55")) d = d.slice(2);
    if (d.length === 10 && /[6-9]/.test(d[2])) d = d.slice(0, 2) + "9" + d.slice(2);
    if (d.length !== 11 || d[2] !== "9") continue;
    const ddd = Number(d.slice(0, 2));
    if (ddd < 11 || ddd > 99 || d[1] === "0") continue;
    return "55" + d;
  }
  return null;
}

/** "Texto\n[Sim | Não]" → texto + botões (quick replies: até 13, título até 20 caracteres). */
export function separarOpcoes(modelo: string): { texto: string; opcoes: string[] } {
  const linhas = modelo.trimEnd().split("\n");
  const ultima = linhas[linhas.length - 1]?.trim() ?? "";
  const m = ultima.match(/^\[(.+)\]$/);
  if (!m || linhas.length < 2) return { texto: modelo.trim(), opcoes: [] };
  const opcoes = m[1].split("|").map((o) => o.trim().slice(0, 20)).filter(Boolean).slice(0, 13);
  return { texto: linhas.slice(0, -1).join("\n").trim(), opcoes };
}

export function lerRegras(json: string): RegraPalavra[] {
  try {
    const v = JSON.parse(json || "[]");
    return (Array.isArray(v) ? v : [])
      .map((x: any) => ({
        palavras: (Array.isArray(x?.palavras) ? x.palavras : String(x?.palavras ?? "").split(","))
          .map((p: any) => String(p).trim()).filter(Boolean),
        resposta: String(x?.resposta ?? "").trim(),
        publico: String(x?.publico ?? "").trim(),
        posts: (Array.isArray(x?.posts) ? x.posts : String(x?.posts ?? "").split(/[\s,]+/))
          .map((p: any) => codigoDoPost(String(p))).filter(Boolean),
        seguir: x?.seguir === true || x?.seguir === "true",
      }))
      .filter((r) => r.palavras.length && r.resposta);
  } catch { return []; }
}

/** "https://www.instagram.com/reel/DAbc12/?igsh=x" → "DAbc12". Id numérico ou do Facebook fica como está. */
export function codigoDoPost(s: string): string {
  const t = s.trim();
  const m = t.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  const fb = t.match(/(?:posts|videos|reel)\/(?:[^/]+\/)?(\d{6,})/);
  return fb ? fb[1] : t.replace(/\/+$/, "");
}

/**
 * Regra que o texto dispara. `inteiro` = só quando o texto é a própria palavra (Direct no meio da
 * conversa, para não responder no automático a quem só citou a palavra falando com o atendente).
 */
export function regraDoTexto(texto: string, regras: RegraPalavra[], inteiro: boolean): { regra: RegraPalavra; palavra: string } | null {
  if (!texto) return null;
  const todas = regras.flatMap((r) => r.palavras.map((p) => ({ regra: r, p })));
  const palavra = palavraDoComentario(texto, todas.map((x) => x.p));
  if (!palavra || (inteiro && normalizar(texto) !== palavra)) return null;
  const achada = todas.find((x) => normalizar(x.p) === palavra)!;
  return { regra: achada.regra, palavra: achada.p };
}

/** Palavras de origem/links: as genéricas mais as das regras, sem repetir. */
export function todasPalavras(cfg: Pick<SocialConfig, "palavras" | "regras"> & { automacoes?: aut.Automacao[] }): string[] {
  const vistas = new Set<string>();
  return [...cfg.palavras, ...cfg.regras.flatMap((r) => r.palavras), ...aut.palavrasDasAutomacoes(cfg.automacoes ?? [])].filter((p) => {
    const n = normalizar(p);
    if (!n || vistas.has(n)) return false;
    vistas.add(n);
    return true;
  });
}

function lerIceBreakers(json: string): { pergunta: string; resposta: string }[] {
  try {
    const v = JSON.parse(json || "[]");
    return (Array.isArray(v) ? v : [])
      .map((x: any) => ({ pergunta: String(x?.pergunta ?? "").trim().slice(0, 80), resposta: String(x?.resposta ?? "").trim() }))
      .filter((x) => x.pergunta)
      .slice(0, 4);
  } catch { return []; }
}

// ── Configuração ────────────────────────────────────────────────────────────

export async function carregarConfigs(): Promise<SocialConfig[]> {
  const rows = await prisma.iaProjetoConfig.findMany({
    where: { chave: { startsWith: "meta_social_" } },
    include: { projeto: { select: { empresaId: true } } },
  });
  const porProjeto = new Map<string, typeof rows>();
  for (const r of rows) porProjeto.set(r.projetoId, [...(porProjeto.get(r.projetoId) ?? []), r]);
  return [...porProjeto.entries()].map(([projetoId, cs]) => {
    const v = (k: string) => (cs.find((c) => c.chave === `meta_social_${k}`)?.valor ?? "").trim();
    return {
      projetoId,
      empresaId: cs[0]?.projeto?.empresaId ?? null,
      ativo: v("ativo") === "true",
      pageToken: v("page_token"),
      appSecret: v("app_secret"),
      verifyToken: v("verify_token"),
      pageId: v("page_id"),
      igId: v("ig_id"),
      respostaAuto: v("resposta_auto"),
      palavras: (v("palavras") || PALAVRAS_CTA.join(",")).split(",").map((p) => p.trim()).filter(Boolean),
      comentarioResposta: v("comentario_resposta"),
      comentarioPublico: v("comentario_publico"),
      iceBreakers: lerIceBreakers(v("ice_breakers")),
      whatsappAbertura: v("whatsapp_abertura"),
      telefoneResposta: v("telefone_resposta"),
      igUsername: v("ig_username"),
      whatsappNumero: v("whatsapp_numero").replace(/\D/g, ""),
      regras: lerRegras(v("regras")),
      storyResposta: v("story_resposta"),
      storyMencao: v("story_mencao"),
      seguirAviso: v("seguir_aviso"),
      comentarioTodos: v("comentario_todos"),
      pedirWhatsapp: v("pedir_whatsapp"),
      automacoes: aut.lerAutomacoes(v("automacoes")),
    };
  });
}

export async function configDoProjeto(projetoId: string): Promise<SocialConfig | null> {
  return (await carregarConfigs()).find((c) => c.projetoId === projetoId) ?? null;
}

// ── Graph API ───────────────────────────────────────────────────────────────

async function graph(path: string, token: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${GRAPH}${path}${sep}access_token=${encodeURIComponent(token)}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || data?.error) {
    const e = data?.error ?? {};
    const err: any = new Error(e.message ?? `Graph HTTP ${r.status}`);
    err.code = e.code;
    err.subcode = e.error_subcode;
    throw err;
  }
  return data;
}

/** Fora da janela de 24h a Meta só aceita a tag HUMAN_AGENT (até 7 dias, exige a permissão). */
const foraDaJanela = (e: any) => e?.code === 10 || e?.subcode === 2018278 || e?.subcode === 2534022;

export type BotaoRapido = { titulo: string; payload?: string };

export async function enviarTextoSocial(cfg: SocialConfig, recipientId: string, texto: string, opcoes: (string | BotaoRapido)[] = []): Promise<string | null> {
  const message: any = { text: texto };
  if (opcoes.length) message.quick_replies = opcoes.map((o) => {
    const b = typeof o === "string" ? { titulo: o } : o;
    return { content_type: "text", title: b.titulo.slice(0, 20), payload: b.payload ?? `QR:${b.titulo}` };
  });
  return enviarMensagemSocial(cfg, recipientId, message);
}

/** Qualquer `message` da Send API (texto, anexo, template) para um IGSID/PSID. */
/** (#551) "Esta pessoa não está disponível": em geral o lead só comentou no post — a Meta deixa UMA
 *  resposta privada por comentário e não abre conversa até ele responder (ou ele bloqueou a Página). */
const pessoaIndisponivel = (e: any) => e?.code === 551;
export const AVISO_SO_COMENTOU =
  "A Meta não deixa mandar mensagem para este lead agora. Ele só comentou no post e ainda não respondeu a mensagem privada que já foi enviada — a Meta libera a conversa quando ele responder (aí você tem 24h). Dica: responda o comentário em público dizendo que tem mensagem no direct.";

export async function enviarMensagemSocial(cfg: SocialConfig, recipientId: string, message: any): Promise<string | null> {
  const base = { recipient: { id: recipientId }, message };
  try {
    const r = await graph("/me/messages", cfg.pageToken, { method: "POST", body: { ...base, messaging_type: "RESPONSE" } });
    return r.message_id ?? null;
  } catch (e: any) {
    if (pessoaIndisponivel(e)) throw new Error(AVISO_SO_COMENTOU);
    if (!foraDaJanela(e)) throw e;
    try {
      const r = await graph("/me/messages", cfg.pageToken, {
        method: "POST", body: { ...base, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" },
      });
      return r.message_id ?? null;
    } catch {
      throw new Error("Fora da janela de 24h da Meta: o lead precisa mandar mensagem de novo para você poder responder.");
    }
  }
}

/** Resposta automática: aplica {nome} e os botões "[A | B]" da última linha. Devolve o texto gravado. */
async function enviarAutomatica(cfg: SocialConfig, recipientId: string, modelo: string, nome: string | null) {
  const { texto, opcoes } = separarOpcoes(preencher(modelo, nome));
  const mid = await enviarTextoSocial(cfg, recipientId, texto, opcoes);
  return { mid, conteudo: opcoes.length ? `${texto}\n[${opcoes.join(" | ")}]` : texto };
}

/** Ice breakers (perguntas prontas do 1º contato) no Messenger e no Instagram. Lista vazia = remove. */
export async function sincronizarIceBreakers(cfg: SocialConfig): Promise<void> {
  for (const plataforma of ["", "instagram"]) {
    if (plataforma === "instagram" && !cfg.igId) continue;
    const q = plataforma ? "?platform=instagram" : "";
    if (!cfg.iceBreakers.length) {
      await graph(`/me/messenger_profile${q}`, cfg.pageToken, { method: "DELETE", body: { fields: ["ice_breakers"] } }).catch(() => {});
      continue;
    }
    await graph(`/me/messenger_profile${q}`, cfg.pageToken, {
      method: "POST",
      body: {
        ...(plataforma ? { platform: "instagram" } : {}),
        ice_breakers: [{
          locale: "default",
          call_to_actions: cfg.iceBreakers.map((ib, i) => ({ question: ib.pergunta, payload: `IB:${i}` })),
        }],
      },
    });
  }
}

/** Resposta privada a um comentário. Devolve o id do destinatário (IGSID/PSID) para abrir a conversa. */
export async function responderComentarioPrivado(cfg: SocialConfig, commentId: string, texto: string, opcoes: (string | BotaoRapido)[] = []) {
  const enviar = (message: any) => graph("/me/messages", cfg.pageToken, {
    method: "POST", body: { recipient: { comment_id: commentId }, message },
  });
  let r: any;
  if (!opcoes.length) r = await enviar({ text: texto });
  else {
    try {
      r = await enviar({ text: texto, quick_replies: opcoes.map((o) => {
        const b = typeof o === "string" ? { titulo: o } : o;
        return { content_type: "text", title: b.titulo.slice(0, 20), payload: b.payload ?? `QR:${b.titulo}` };
      }) });
    } catch (e: any) {
      // Se a resposta privada não aceitar botões, as opções vão escritas: a pessoa responde com a palavra.
      console.warn(`[MetaSocial] Resposta privada sem botões (${e?.message ?? e})`);
      texto = `${texto}\n\nResponda aqui: ${opcoes.map((o) => (typeof o === "string" ? o : o.titulo)).join(" ou ")}`;
      r = await enviar({ text: texto });
    }
  }
  return { recipientId: (r.recipient_id as string) ?? null, messageId: (r.message_id as string) ?? null, texto };
}

/** O lead segue o perfil? Só o Instagram informa; null = não deu para saber (não bloqueia a entrega). */
export async function segueOPerfil(cfg: SocialConfig, canal: CanalSocial, userId: string): Promise<boolean | null> {
  if (canal !== "instagram") return null;
  try {
    const p = await graph(`/${userId}?fields=is_user_follow_business`, cfg.pageToken);
    return typeof p.is_user_follow_business === "boolean" ? p.is_user_follow_business : null;
  } catch (e: any) {
    console.warn(`[MetaSocial] is_user_follow_business ${userId}: ${e?.message ?? e}`);
    return null;
  }
}

/** Link do post comentado, para conferir o filtro de posts da regra (cache: o link não muda). */
const permalinks = new Map<string, string>();
export async function permalinkDoPost(cfg: SocialConfig, canal: CanalSocial, postId: string): Promise<string> {
  if (permalinks.has(postId)) return permalinks.get(postId)!;
  const campo = canal === "instagram" ? "permalink" : "permalink_url";
  const p = await graph(`/${postId}?fields=${campo}`, cfg.pageToken).catch(() => ({}));
  const link = String(p?.[campo] ?? "");
  if (link) permalinks.set(postId, link);
  return link;
}

const postsInfo = new Map<string, { link: string; legenda: string }>();

/** Link + início da legenda do post comentado, para o atendente saber de onde veio o lead. */
export async function infoDoPost(cfg: SocialConfig, canal: CanalSocial, postId: string | undefined): Promise<{ link: string; legenda: string } | null> {
  if (!postId) return null;
  if (postsInfo.has(postId)) return postsInfo.get(postId)!;
  const campos = canal === "instagram" ? "permalink,caption" : "permalink_url,message";
  const p: any = await graph(`/${postId}?fields=${campos}`, cfg.pageToken).catch(() => null);
  if (!p) return null;
  const info = { link: String(p.permalink ?? p.permalink_url ?? ""), legenda: String(p.caption ?? p.message ?? "") };
  if (info.link) { postsInfo.set(postId, info); permalinks.set(postId, info.link); }
  return info.link || info.legenda ? info : null;
}

/** Linha "📌 Post: “legenda…”" + link, anexada à mensagem do comentário no chat. */
export function linhaDoPost(info: { link: string; legenda: string } | null): string {
  if (!info) return "";
  const leg = info.legenda.replace(/\s+/g, " ").trim();
  const curta = leg.length > 80 ? `${leg.slice(0, 80).trimEnd()}…` : leg;
  return `\n📌 Post: ${curta ? `“${curta}”` : ""}${info.link ? `${curta ? "\n" : ""}${info.link}` : ""}`;
}

async function regraValeNoPost(cfg: SocialConfig, canal: CanalSocial, regra: RegraPalavra, postId: string | undefined): Promise<boolean> {
  if (!regra.posts.length) return true;
  if (!postId) return false;
  if (regra.posts.some((c) => postId === c || postId.endsWith(`_${c}`))) return true;
  const link = await permalinkDoPost(cfg, canal, postId);
  return !!link && regra.posts.some((c) => codigoDoPost(link) === c || link.includes(`/${c}`));
}

export async function responderComentarioPublico(cfg: SocialConfig, canal: CanalSocial, commentId: string, texto: string) {
  const path = canal === "instagram" ? `/${commentId}/replies` : `/${commentId}/comments`;
  await graph(path, cfg.pageToken, { method: "POST", body: { message: texto } });
}

async function perfilDoUsuario(cfg: SocialConfig, canal: CanalSocial, id: string): Promise<{ nome: string | null; username: string | null }> {
  try {
    if (canal === "instagram") {
      const p = await graph(`/${id}?fields=name,username`, cfg.pageToken);
      return { nome: p.name || p.username || null, username: p.username ?? null };
    }
    const p = await graph(`/${id}?fields=first_name,last_name`, cfg.pageToken);
    return { nome: [p.first_name, p.last_name].filter(Boolean).join(" ") || null, username: null };
  } catch {
    return { nome: null, username: null };
  }
}

/** Valida o token e descobre a Página e o Instagram ligado a ela; assina o webhook da Página. */
export async function conectar(pageToken: string) {
  const me = await graph("/me?fields=id,name,username,instagram_business_account{id,username}", pageToken);
  if (!me?.id) throw new Error("Token sem Página associada — use o token da Página, não o do usuário.");
  await graph(`/${me.id}/subscribed_apps`, pageToken, {
    method: "POST", body: { subscribed_fields: ["messages", "message_echoes", "feed"] },
  });
  return {
    pageId: me.id as string,
    pageNome: me.name as string,
    igId: (me.instagram_business_account?.id as string) ?? "",
    igUsername: (me.instagram_business_account?.username as string) ?? "",
  };
}

// ── Contato, deal e mensagem ────────────────────────────────────────────────

const campoId = (canal: CanalSocial) => (canal === "instagram" ? "instagramId" : "messengerId");

type PerfilConhecido = { nome: string | null; username: string | null };

export async function contatoEDeal(cfg: SocialConfig, canal: CanalSocial, userId: string, origem: Origem, conhecido?: PerfilConhecido) {
  // A Meta reentrega e manda rajadas em paralelo (e o PM2 roda em cluster): sem a trava por
  // usuário, duas entregas simultâneas criavam contato e deal em dobro.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`meta_social:${canal}:${userId}`}))`;
    return contatoEDealSemTrava(tx, cfg, canal, userId, origem, conhecido);
  }, { timeout: 30_000, maxWait: 30_000 });
}

async function contatoEDealSemTrava(
  db: Prisma.TransactionClient, cfg: SocialConfig, canal: CanalSocial, userId: string, origem: Origem,
  conhecido?: PerfilConhecido,
) {
  const empresa = cfg.empresaId ? { empresaId: cfg.empresaId } : {};
  let contato = await db.crmContato.findFirst({ where: { [campoId(canal)]: userId, ...empresa } });
  let novo = false;
  if (!contato) {
    // Quem só comentou não tem perfil consultável ainda; o nome/@ do comentário serve de reserva.
    const consultado = await perfilDoUsuario(cfg, canal, userId);
    const p = { nome: consultado.nome ?? conhecido?.nome ?? null, username: consultado.username ?? conhecido?.username ?? null };
    contato = await db.crmContato.create({
      data: {
        nome: p.nome ?? (canal === "instagram" ? "Lead Instagram" : "Lead Facebook"),
        [campoId(canal)]: userId,
        ...(p.username ? { instagramUsername: p.username } : {}),
        ...empresa,
      },
    });
    novo = true;
  }

  let deal = await db.crmDeal.findFirst({
    where: { contatoId: contato.id, projetoId: cfg.projetoId, status: "aberto" },
    orderBy: { criadoEm: "desc" },
  });
  if (!deal) {
    const { pipelineId, stageId, faseChave } = await etapaDeEntrada(db, cfg, origem.etapaChave);
    deal = await db.crmDeal.create({
      data: {
        titulo: contato.nome,
        pipelineId, stageId,
        contatoId: contato.id,
        projetoId: cfg.projetoId,
        iaAtiva: false,
        // Fase de entrada da IA: se o lead for para o WhatsApp, a Ana começa do começo.
        iaStageChave: faseChave,
        status: "aberto",
        ultimoContatoEm: new Date(),
        origemPlataforma: canal === "instagram" ? "instagram" : "facebook",
        origemTipo: "organico",
        origemAnuncioId: origem.id,
        origemAnuncioTitulo: origem.titulo,
        origemEm: new Date(),
        ...empresa,
      },
    });
    console.log(`[MetaSocial] Novo deal ${deal.id} (${canal}) — ${contato.nome}`);
  }
  return { contato, deal, novo };
}

async function etapaDeEntrada(db: Prisma.TransactionClient, cfg: SocialConfig, etapaChave?: string): Promise<{ pipelineId: string; stageId: string; faseChave: string | null }> {
  const fase = await db.iaFaseFunil.findFirst({
    where: { projetoId: cfg.projetoId, ehEntrada: true, pipelineTipo: "comercial" },
    orderBy: { ordem: "asc" },
  });
  const projeto = await db.iaProjeto.findUnique({ where: { id: cfg.projetoId }, select: { pipelineId: true } });
  const pipelineId = fase?.pipelineId ?? projeto?.pipelineId ?? null;
  if (pipelineId) {
    const stage = (etapaChave ? await db.crmStage.findFirst({ where: { pipelineId, chave: etapaChave } }) : null)
      ?? await db.crmStage.findFirst({ where: { pipelineId, ehEntrada: true }, orderBy: { ordem: "asc" } })
      ?? await db.crmStage.findFirst({ where: { pipelineId }, orderBy: { ordem: "asc" } });
    if (stage) return { pipelineId, stageId: stage.id, faseChave: fase?.chave ?? null };
  }
  throw new Error(`Projeto ${cfg.projetoId} sem funil de entrada`);
}

export async function gravarMensagem(d: {
  cfg: SocialConfig; canal: CanalSocial; dealId: string; contatoId: string; direcao: "in" | "out";
  mid: string | null; tipo?: string; conteudo: string; midiaUrl?: string | null; remetente?: string | null; em?: Date;
}): Promise<boolean> {
  try {
    await prisma.crmMensagemWhatsapp.create({
      data: {
        empresaId: d.cfg.empresaId ?? undefined,
        dealId: d.dealId,
        contatoId: d.contatoId,
        direcao: d.direcao,
        canal: d.canal,
        tipo: d.tipo ?? "text",
        conteudo: d.conteudo,
        midiaUrl: d.midiaUrl ?? null,
        remetente: d.remetente ?? null,
        // O id da Meta (mid) ocupa a mesma coluna única do id do Evolution: dedupe do eco e de reentrega.
        evolutionMessageId: d.mid ?? undefined,
        ...(d.em ? { enviadaEm: d.em } : {}),
      },
    });
    return true;
  } catch (e: any) {
    if (e?.code === "P2002") return false; // já gravada (eco do que o próprio Avoce enviou)
    throw e;
  }
}

// ── Webhook ─────────────────────────────────────────────────────────────────

export async function verifyTokenValido(token: string): Promise<boolean> {
  if (!token) return false;
  return (await carregarConfigs()).some((c) => c.verifyToken && c.verifyToken === token);
}

export async function segredosDosApps(): Promise<string[]> {
  return [...new Set((await carregarConfigs()).map((c) => c.appSecret).filter(Boolean))];
}

const CAMPOS_TRATADOS = new Set(["comments", "live_comments", "feed"]);

export async function processarWebhook(body: any): Promise<void> {
  const canal: CanalSocial | null = body?.object === "instagram" ? "instagram" : body?.object === "page" ? "messenger" : null;
  if (!canal) return;
  const configs = (await carregarConfigs()).filter((c) => c.ativo && c.pageToken);

  for (const entry of body.entry ?? []) {
    // Uma linha por entrega (tipos de evento, sem conteúdo): diz o que a Meta manda mesmo quando nada é tratado.
    const tipos = [
      ...(entry.messaging ?? []).map((ev: any) => ev.message ? (ev.message.is_echo ? "eco" : "mensagem") : Object.keys(ev).find((k) => !["sender", "recipient", "timestamp"].includes(k)) ?? "?"),
      ...(entry.changes ?? []).map((ch: any) => ch.field + (ch.value?.item ? `:${ch.value.item}/${ch.value.verb ?? ""}` : "")),
    ];
    console.log(`[MetaSocial] Webhook ${canal} ${entry.id}: ${tipos.join(", ") || "vazio"}`);
    const cfg = configs.find((c) => (canal === "instagram" ? c.igId : c.pageId) === String(entry.id));
    if (!cfg) {
      console.warn(`[MetaSocial] ${canal} ${entry.id} sem projeto configurado`);
      continue;
    }
    for (const ev of entry.messaging ?? []) {
      try { await processarMensagem(cfg, canal, ev); } catch (e: any) {
        console.error(`[MetaSocial] Mensagem ${canal}: ${e?.message ?? e}`);
      }
    }
    for (const ch of entry.changes ?? []) {
      // Campo que não tratamos (ex.: o de novo seguidor, que a Meta libera em beta conta a conta e não
      // documenta): fica no log com o corpo cru, para saber o formato no dia em que chegar.
      if (!CAMPOS_TRATADOS.has(ch.field)) {
        console.log(`[MetaSocial] Campo não tratado ${canal}.${ch.field}: ${JSON.stringify(ch.value ?? {}).slice(0, 2000)}`);
        continue;
      }
      try { await processarComentario(cfg, canal, ch); } catch (e: any) {
        console.error(`[MetaSocial] Comentário ${canal}: ${e?.message ?? e}`);
      }
    }
  }
}

async function processarMensagem(cfg: SocialConfig, canal: CanalSocial, ev: any) {
  const meuId = canal === "instagram" ? cfg.igId : cfg.pageId;

  // Clique em ice breaker / botão "Começar" chega como postback; link ig.me/m.me sem
  // mensagem chega como referral solto. Os dois viram conversa como se fossem mensagem.
  if (!ev.message && (ev.postback || ev.referral)) return processarPostback(cfg, canal, ev, meuId);

  const m = ev.message;
  if (!m) {
    const tipo = Object.keys(ev).find((k) => !["sender", "recipient", "timestamp"].includes(k));
    if (tipo && !["read", "delivery", "reaction", "message_edit"].includes(tipo)) {
      console.log(`[MetaSocial] Evento não tratado ${canal}.${tipo}: ${JSON.stringify(ev).slice(0, 2000)}`);
    }
    return;
  }
  if (m.is_deleted) return;
  const eco = !!m.is_echo;
  const userId: string = eco ? ev.recipient?.id : ev.sender?.id;
  if (!userId || userId === meuId) return;

  const texto: string = m.text ?? "";
  const anexo = (m.attachments ?? [])[0];

  // Eco de quem respondeu pelo app do Instagram/Facebook: só grava se a conversa já existe.
  if (eco) {
    const contato = await prisma.crmContato.findFirst({
      where: { [campoId(canal)]: userId, ...(cfg.empresaId ? { empresaId: cfg.empresaId } : {}) },
    });
    const deal = contato && await prisma.crmDeal.findFirst({
      where: { contatoId: contato.id, projetoId: cfg.projetoId, status: "aberto" }, orderBy: { criadoEm: "desc" },
    });
    if (contato && deal) {
      await gravarMensagem({
        cfg, canal, dealId: deal.id, contatoId: contato.id, direcao: "out", mid: m.mid ?? null,
        conteudo: texto || "[anexo]", remetente: `App ${canal === "instagram" ? "Instagram" : "Facebook"}`,
      });
    }
    return;
  }

  const { contato, deal } = await contatoEDeal(cfg, canal, userId, origemDoEvento(ev, canal, todasPalavras(cfg)));
  const story = anexo?.type === "story_mention" ? "📣 Mencionou o perfil num story" : m.reply_to?.story ? "↩️ Respondeu ao story" : null;
  const gravou = await gravarMensagem({
    cfg, canal, dealId: deal.id, contatoId: contato.id, direcao: "in", mid: m.mid ?? null,
    tipo: anexo && anexo.type !== "story_mention" ? tipoDoAnexo(anexo.type) : "text",
    conteudo: [story, texto].filter(Boolean).join(": ") || (anexo ? `[${anexo.type ?? "anexo"}]` : ""),
    midiaUrl: anexo?.payload?.url ?? m.reply_to?.story?.url ?? null,
    em: ev.timestamp ? new Date(ev.timestamp) : undefined,
  });
  if (!gravou) return;
  await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });

  // Telefone no Direct: junta com o WhatsApp e, se configurado, a Ana chama lá.
  const fone = !contato.whatsapp && texto ? telefoneNoTexto(texto) : null;
  if (fone) {
    await levarParaWhatsapp(cfg, canal, userId, contato, deal, fone);
    return;
  }

  const primeira = (await prisma.crmMensagemWhatsapp.count({ where: { dealId: deal.id, canal } })) === 1;
  const payload = String(m.quick_reply?.payload ?? "");
  const storyTipo = anexo?.type === "story_mention" ? "mencao" as const : m.reply_to?.story ? "resposta" as const : undefined;
  await rodarAutomacaoDaMensagem(cfg, canal, userId, contato, deal, { payload, texto, primeira, story: storyTipo, ref: refDoEvento(ev) });
}

/**
 * Mensagem/botão com automações ligadas, nesta ordem: botão de automação (AUT:id:passo),
 * continuação pendente de comentário, gatilhos (link → story → palavra → 1ª mensagem).
 */
async function rodarAutomacaoDaMensagem(
  cfg: SocialConfig, canal: CanalSocial, userId: string, contato: any, deal: any,
  ev: { payload: string; texto: string; primeira: boolean; story?: "resposta" | "mencao"; ref?: string | null },
) {
  const ctx: aut.Contexto = { cfg, canal, userId, contato, deal, nome: contato.nome };
  const porBotao = aut.lerPayloadAut(ev.payload);
  const pendente = !porBotao ? await aut.continuacaoPendente(deal.id) : null;
  const alvo = porBotao ?? pendente;
  if (alvo) {
    const a = cfg.automacoes.find((x) => x.id === alvo.id && x.ativo);
    await aut.limparContinuacao(deal.id);
    if (a) return aut.executar(ctx, cfg.automacoes, a, alvo.passo);
  }
  for (const c of aut.candidatas(cfg.automacoes, canal, { tipo: "mensagem", texto: ev.texto, primeira: ev.primeira, story: ev.story, ref: ev.ref })) {
    if (c.aut.umaVez24h && await aut.jaRodouEm24h(deal.id, c.aut)) continue;
    console.log(`[MetaSocial] Automação "${c.aut.nome}" (${canal})`);
    return aut.executar(ctx, cfg.automacoes, c.aut);
  }
  await pedirWhatsappSeFalta(cfg, canal, userId, contato, deal);
}

export const PEDIR_WHATSAPP_PADRAO =
  "Oi, {nome}! Obrigado pela mensagem 🤝 Pra gente conversar com calma, me manda seu WhatsApp com DDD que alguém da equipe da RAP te chama por lá 📲";
export const REMETENTE_PEDIR_WHATSAPP = "Resposta automática · Pedir WhatsApp";

/**
 * Mensagem privada que nenhuma automação atendeu (ex.: o lead respondeu a resposta privada do
 * comentário): se o contato ainda não tem WhatsApp, pede o número. No máximo 1 vez a cada 24h e
 * não interrompe atendente que respondeu pela tela nas últimas 2h.
 */
export function decidirPedirWhatsapp(a: {
  config: string; temWhatsapp: boolean; pediuEm24h: boolean; humanoEm2h: boolean;
}): string | null {
  if (a.config.trim().toLowerCase() === "off") return null;
  if (a.temWhatsapp || a.pediuEm24h || a.humanoEm2h) return null;
  return a.config.trim() || PEDIR_WHATSAPP_PADRAO;
}

async function pedirWhatsappSeFalta(cfg: SocialConfig, canal: CanalSocial, userId: string, contato: any, deal: any) {
  const agora = Date.now();
  const [pediu, humano] = await Promise.all([
    prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId: deal.id, direcao: "out", remetente: REMETENTE_PEDIR_WHATSAPP, enviadaEm: { gte: new Date(agora - 86_400_000) } },
      select: { id: true },
    }),
    prisma.crmMensagemWhatsapp.findFirst({
      where: {
        dealId: deal.id, direcao: "out", enviadaEm: { gte: new Date(agora - 2 * 3_600_000) },
        NOT: [{ remetente: { startsWith: aut.REMETENTE_AUT } }, { remetente: null }],
      },
      select: { id: true },
    }),
  ]);
  const modelo = decidirPedirWhatsapp({ config: cfg.pedirWhatsapp, temWhatsapp: !!contato.whatsapp, pediuEm24h: !!pediu, humanoEm2h: !!humano });
  if (!modelo) return;
  const texto = preencher(modelo, contato.nome);
  try {
    const mid = await enviarTextoSocial(cfg, userId, texto);
    await gravarMensagem({ cfg, canal, dealId: deal.id, contatoId: contato.id, direcao: "out", mid, conteudo: texto, remetente: REMETENTE_PEDIR_WHATSAPP });
    console.log(`[MetaSocial] Pediu WhatsApp (${canal}) deal ${deal.id}`);
  } catch (e: any) {
    console.warn(`[MetaSocial] Pedir WhatsApp falhou (${canal}) deal ${deal.id}: ${e?.message ?? e}`);
  }
}

/** Comentário com automações ligadas: a 1ª que casa (palavra antes de "qualquer", filtro de posts). */
async function rodarAutomacaoDoComentario(cfg: SocialConfig, canal: CanalSocial, ch: any, commentId: string, texto: string, postId: string | undefined) {
  const v = ch.value ?? {};
  for (const c of aut.candidatas(cfg.automacoes, canal, { tipo: "comentario", texto })) {
    const g = c.aut.gatilho as Extract<aut.Gatilho, { tipo: "comentario" }>;
    if (g.posts.length && !(await regraValeNoPost(cfg, canal, { palavras: [], resposta: "", publico: "", posts: g.posts, seguir: false }, postId))) continue;
    if (c.aut.umaVez24h && await recebeuAutomaticaRecente(cfg, canal, v.from?.id)) continue;

    const nomeAutor: string | null = v.from?.name ?? v.from?.username ?? null;
    const rede = canal === "instagram" ? "Instagram" : "Facebook";
    const onde = ch.field === "live_comments" ? "Live" : "Comentário";
    const origemId = c.palavra ? normalizar(c.palavra) : "comentario";
    const ctx: aut.Contexto = {
      cfg, canal, userId: null, contato: null, deal: null, comentarioId: commentId, nome: nomeAutor,
      abrir: async (recipientId) => {
        const { contato, deal } = await contatoEDeal(cfg, canal, recipientId,
          { id: origemId, titulo: `${onde} ${rede} · ${origemId}`, etapaChave: ETAPA_PRE_QUALIFICACAO },
          { nome: nomeAutor, username: canal === "instagram" ? v.from?.username ?? null : null });
        await gravarMensagem({
          cfg, canal, dealId: deal.id, contatoId: contato.id, direcao: "in", mid: `comentario:${commentId}`,
          conteudo: `💬 ${ch.field === "live_comments" ? "Comentou no Live" : "Comentou no post"}: "${texto}"${linhaDoPost(await infoDoPost(cfg, canal, postId))}`,
        });
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
        return { contato, deal };
      },
    };
    console.log(`[MetaSocial] Automação "${c.aut.nome}" no comentário (${canal})`);
    await aut.executar(ctx, cfg.automacoes, c.aut);
    if (g.publico) {
      responderComentarioPublico(cfg, canal, commentId, preencher(g.publico, nomeAutor))
        .catch((e) => console.warn(`[MetaSocial] Resposta pública falhou: ${e?.message ?? e}`));
    }
    return;
  }
}

export const ETAPA_PRE_QUALIFICACAO = "pre_qualificacao";

async function processarPostback(cfg: SocialConfig, canal: CanalSocial, ev: any, meuId: string) {
  const userId: string = ev.sender?.id;
  if (!userId || userId === meuId) return;
  const pb = ev.postback ?? {};
  const payload: string = pb.payload ?? "";
  const ib = payload.startsWith("IB:") ? cfg.iceBreakers[Number(payload.slice(3))] : undefined;
  const titulo: string = pb.title || ib?.pergunta || "";
  const ref = refDoEvento(ev);

  const origem = origemDoEvento(ev, canal, todasPalavras(cfg));
  const { contato, deal } = await contatoEDeal(cfg, canal, userId, origem);
  const conteudo = titulo ? `🔘 ${titulo}` : ref ? `🔗 Abriu a conversa pelo link ${origem.id}` : "🔘 Começar";
  const gravou = await gravarMensagem({
    cfg, canal, dealId: deal.id, contatoId: contato.id, direcao: "in",
    mid: pb.mid ?? `pb:${userId}:${ev.timestamp ?? Date.now()}`, conteudo,
    em: ev.timestamp ? new Date(ev.timestamp) : undefined,
  });
  if (!gravou) return;
  await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });

  // Ice breaker com resposta própria responde direto; o resto (botões, links, "Começar") vai pras automações.
  if (ib?.resposta) {
    const r = await enviarAutomatica(cfg, userId, ib.resposta, contato.nome);
    await gravarMensagem({ cfg, canal, dealId: deal.id, contatoId: contato.id, direcao: "out", mid: r.mid, conteudo: r.conteudo, remetente: "Resposta automática" });
    return;
  }
  const primeira = (await prisma.crmMensagemWhatsapp.count({ where: { dealId: deal.id, canal, direcao: "out" } })) === 0;
  await rodarAutomacaoDaMensagem(cfg, canal, userId, contato, deal, { payload, texto: titulo, primeira, ref });
}

/**
 * O lead mandou o celular no Direct. Se já existe contato com esse WhatsApp, a conversa do
 * Direct passa para ele (um lead só, histórico junto); senão o número entra no próprio contato.
 * Com `whatsapp_abertura` configurada, o Avoce chama no WhatsApp e liga a IA no deal — quando
 * o lead responder lá, a Ana continua a partir da fase de entrada.
 */
async function levarParaWhatsapp(cfg: SocialConfig, canal: CanalSocial, userId: string, contato: any, deal: any, fone: string) {
  const { variantesTelefone } = await import("../agent/projeto-resolver.js");
  const empresa = cfg.empresaId ? { empresaId: cfg.empresaId } : {};
  const existente = await prisma.crmContato.findFirst({
    where: { whatsapp: { in: variantesTelefone(fone) }, id: { not: contato.id }, ...empresa },
  });

  let alvo = { contatoId: contato.id as string, dealId: deal.id as string };
  if (existente) {
    const campo = campoId(canal);
    await prisma.crmContato.update({ where: { id: contato.id }, data: { [campo]: null } });
    await prisma.crmContato.update({
      where: { id: existente.id },
      data: { [campo]: userId, ...(contato.instagramUsername ? { instagramUsername: contato.instagramUsername } : {}) },
    });
    const dealWa = await prisma.crmDeal.findFirst({
      where: { contatoId: existente.id, projetoId: cfg.projetoId, status: "aberto" }, orderBy: { criadoEm: "desc" },
    });
    if (dealWa) {
      await prisma.crmMensagemWhatsapp.updateMany({ where: { dealId: deal.id }, data: { dealId: dealWa.id, contatoId: existente.id } });
      // O deal do Direct acabou de nascer e não tem mais nada; se tiver (atividade, tag), só arquiva.
      await prisma.crmDeal.delete({ where: { id: deal.id } }).catch(() =>
        prisma.crmDeal.update({ where: { id: deal.id }, data: { status: "perdido", motivoPerda: "Unificado com a conversa do WhatsApp" } }));
      alvo = { contatoId: existente.id, dealId: dealWa.id };
    } else {
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { contatoId: existente.id } });
      await prisma.crmMensagemWhatsapp.updateMany({ where: { dealId: deal.id }, data: { contatoId: existente.id } });
      alvo = { contatoId: existente.id, dealId: deal.id };
    }
    await prisma.crmContato.delete({ where: { id: contato.id } }).catch(() => {});
    console.log(`[MetaSocial] ${canal} ${userId} unificado com o WhatsApp ${existente.whatsapp} (deal ${alvo.dealId})`);
  } else {
    await prisma.crmContato.update({ where: { id: contato.id }, data: { whatsapp: fone } });
    console.log(`[MetaSocial] ${canal} ${userId} informou o WhatsApp ${fone}`);
  }

  if (!cfg.whatsappAbertura || existente) return;
  try {
    const { enviarTextoParaDeal, REMETENTE_PADRAO } = await import("../services/whatsapp-deal.js");
    await enviarTextoParaDeal(alvo.dealId, preencher(cfg.whatsappAbertura, contato.nome), REMETENTE_PADRAO);
    await prisma.crmDeal.update({ where: { id: alvo.dealId }, data: { iaAtiva: true, ultimoContatoEm: new Date() } });
    const confirmacao = cfg.telefoneResposta || "Perfeito! Acabei de te chamar no WhatsApp 👍";
    const r = await enviarAutomatica(cfg, userId, confirmacao, contato.nome);
    await gravarMensagem({ cfg, canal, dealId: alvo.dealId, contatoId: alvo.contatoId, direcao: "out", mid: r.mid, conteudo: r.conteudo, remetente: "Resposta automática" });
  } catch (e: any) {
    console.warn(`[MetaSocial] Não deu para chamar ${fone} no WhatsApp: ${e?.message ?? e}`);
  }
}

async function processarComentario(cfg: SocialConfig, canal: CanalSocial, ch: any) {
  const v = ch.value ?? {};
  let commentId: string | undefined, texto: string, autorId: string | undefined;
  if (canal === "instagram") {
    // live_comments: comentário durante o Live — mesmo formato, resposta privada só enquanto o Live dura.
    if (ch.field !== "comments" && ch.field !== "live_comments") return;
    commentId = v.id; texto = v.text ?? ""; autorId = v.from?.id;
  } else {
    if (ch.field !== "feed" || v.item !== "comment" || v.verb !== "add") return;
    commentId = v.comment_id; texto = v.message ?? ""; autorId = v.from?.id;
  }
  if (!commentId || !texto || autorId === cfg.igId || autorId === cfg.pageId) return;
  const postId: string | undefined = canal === "instagram" ? v.media?.id : v.post_id;
  return rodarAutomacaoDoComentario(cfg, canal, ch, commentId, texto, postId);
}

/**
 * Quem comenta muito não recebe um privado por comentário: com mensagem automática nas últimas
 * 24h, o comentário sem palavra-chave fica sem resposta. Só o Instagram manda no comentário o
 * mesmo id da conversa (IGSID); no Facebook o id do autor é outro e a trava não se aplica.
 */
export async function recebeuAutomaticaRecente(cfg: SocialConfig, canal: CanalSocial, autorId: string | undefined): Promise<boolean> {
  if (canal !== "instagram" || !autorId) return false;
  const recente = await prisma.crmMensagemWhatsapp.findFirst({
    where: {
      canal, direcao: "out", remetente: { startsWith: "Resposta automática" },
      enviadaEm: { gte: new Date(Date.now() - 86_400_000) },
      contato: { instagramId: autorId, ...(cfg.empresaId ? { empresaId: cfg.empresaId } : {}) },
    },
    select: { id: true },
  });
  return !!recente;
}

/** Canal da conversa do deal: o da última mensagem recebida; sem nenhuma, o que o contato tiver. */
export async function canalDoDeal(dealId: string, contato: { whatsapp?: string | null; instagramId?: string | null; messengerId?: string | null }) {
  const ultima = await prisma.crmMensagemWhatsapp.findFirst({
    where: { dealId, direcao: "in" }, orderBy: { enviadaEm: "desc" }, select: { canal: true },
  });
  const c = ultima?.canal ?? (contato.whatsapp ? "whatsapp" : contato.instagramId ? "instagram" : contato.messengerId ? "messenger" : "whatsapp");
  return c as "whatsapp" | CanalSocial;
}

/** Envio manual pela tela de conversas (canal social). Devolve o mid para gravar a mensagem. */
export async function enviarManualSocial(
  deal: { projetoId: string | null; empresaId: string | null },
  contato: { instagramId?: string | null; messengerId?: string | null },
  canal: CanalSocial, texto: string,
): Promise<string | null> {
  const configs = (await carregarConfigs()).filter((c) => c.pageToken);
  const cfg = configs.find((c) => c.projetoId === deal.projetoId)
    ?? configs.find((c) => deal.empresaId && c.empresaId === deal.empresaId);
  if (!cfg) throw new Error("Instagram/Facebook não conectado neste projeto (Config IA → Instagram e Facebook).");
  const destino = canal === "instagram" ? contato.instagramId : contato.messengerId;
  if (!destino) throw new Error(`Contato sem id do ${canal === "instagram" ? "Instagram" : "Messenger"}`);
  return enviarTextoSocial(cfg, destino, texto);
}
