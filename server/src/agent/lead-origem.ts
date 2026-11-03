/**
 * Origem do lead a partir da primeira mensagem do WhatsApp.
 *
 * Anúncio Click-to-WhatsApp da Meta chega com `contextInfo.externalAdReply`
 * (título, texto, sourceId = ID do anúncio, sourceApp = facebook/instagram, sourceUrl)
 * e `contextInfo.entryPointConversionSource` = "ctwa_ad". Link wa.me do site chega
 * como "click_to_chat_link"; busca no WhatsApp como "global_search_new_chat";
 * clique num número como "phone_number_hyperlink".
 *
 * A Evolution v2 manda `contextInfo` no topo do `data`; versões antigas dentro de
 * `message.extendedTextMessage.contextInfo`. Lemos os dois.
 */

import { prisma } from "../db.js";

export interface OrigemLead {
  plataforma: string;        // facebook | instagram | site | whatsapp | telefone | meta
  tipo: string;              // anuncio | link | organico
  anuncioId?: string | null;
  anuncioTitulo?: string | null;
  anuncioTexto?: string | null;
  url?: string | null;
  ctwaClid?: string | null;  // id do clique no anúncio — chave da Conversions API
  sourceType?: string | null; // ad | post
  entryPoint?: string | null; // entryPointConversionSource cru
}

const ENTRY_MAP: Record<string, OrigemLead> = {
  click_to_chat_link:     { plataforma: "site",     tipo: "link" },
  global_search_new_chat: { plataforma: "whatsapp", tipo: "organico" },
  phone_number_hyperlink: { plataforma: "telefone", tipo: "organico" },
};

// Referência que o hotsite injeta na 1a mensagem: "Ref. site PSA: <contexto> · <campanha>".
// Rede de segurança para quando o WhatsApp não manda entryPointConversionSource
// (acontece quando já existe conversa com o número).
const RE_REF_SITE = /Ref\.\s*site\s*PSA\s*:\s*([^\n\r]*)/i;

// Os hotsites mandam "Ref. site PSA: <slug>/<contexto> · <campanha>". O slug
// diz de QUAL site veio — sem ele, todo lead aparecia no painel como se fosse
// do hotsite de subvenções. Links antigos vêm sem slug e caem no primeiro item.
const SITES: Record<string, { nome: string; url: string }> = {
  "subvencao-icms": { nome: "Hotsite subvencoes",   url: "https://subvencaoicms.pinheirosilva.adv.br/" },
  "defesa-icms":    { nome: "Hotsite defesa ICMS",  url: "https://defesaicms.pinheirosilva.adv.br/" },
};
const SITE_PADRAO = SITES["subvencao-icms"];

function textoDaMensagem(msg: any): string {
  const m = msg?.message ?? {};
  return String(m.conversation ?? m.extendedTextMessage?.text ?? m.imageMessage?.caption ?? "");
}

// ─── Orgânico das redes ──────────────────────────────────────────────────────
// O orgânico não traz metadado: link da bio e Reels chegam como wa.me comum (ou sem nada).
// A origem vem do TEXTO da 1ª mensagem — a mensagem pronta do link da bio ("vim pelo
// Instagram") ou a palavra-chave pedida no CTA do vídeo ("manda FILA no WhatsApp").

const RE_VIM_PELO = /\b(vim|vi|cheguei|achei)\b[^.\n]{0,25}\b(instagram|insta|facebook|face|reels?)\b/i;

/** Palavras-chave dos CTAs dos vídeos (roteiros RAP #6231/#6287). Só vale com a mensagem curta. */
export const PALAVRAS_CTA = [
  "RESCISAO", "CARTEIRA", "FILA", "ACORDO", "SAIR", "SIGILO", "POR FORA",
  "SAUDE", "DESCONTO", "PRAZO", "ESTRADA", "EIXO",
  // roteiros 20–25 (plano orgânico 22/10/2026)
  "PROVA", "MENTIRA", "JORNADA", "TESTE",
];

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const normalizarPalavra = (s: string) => semAcento(String(s ?? "")).toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Palavras-chave vêm do BANCO: as das automações ativas do Instagram/Messenger
 * (`meta_social_automacoes`, gatilhos de comentário e de Direct) e a lista `meta_social_palavras`.
 * PALAVRAS_CTA acima é só a base mínima. Palavra nova num roteiro = cadastrar a automação, sem deploy.
 */
let cachePalavras: { em: number; lista: string[] } | null = null;
export async function palavrasCta(): Promise<string[]> {
  if (cachePalavras && Date.now() - cachePalavras.em < 60_000) return cachePalavras.lista;
  const set = new Set(PALAVRAS_CTA.map(normalizarPalavra));
  try {
    const rows = await prisma.iaProjetoConfig.findMany({
      where: { chave: { in: ["meta_social_palavras", "meta_social_automacoes"] } },
      select: { chave: true, valor: true },
    });
    for (const r of rows) {
      const valor = String(r.valor ?? "");
      if (r.chave === "meta_social_palavras") { valor.split(",").forEach(p => set.add(normalizarPalavra(p))); continue; }
      try {
        const lista = JSON.parse(valor || "[]");
        for (const a of Array.isArray(lista) ? lista : []) {
          const g = a?.gatilho;
          if (a?.ativo === false || !(g?.tipo === "comentario" || g?.tipo === "dm_palavra")) continue;
          for (const p of Array.isArray(g.palavras) ? g.palavras : []) set.add(normalizarPalavra(p));
        }
      } catch { /* JSON inválido: fica a base */ }
    }
  } catch (err: any) {
    console.warn(`[Origem] Falha ao ler palavras do banco: ${err?.message ?? err}`);
    if (cachePalavras) return cachePalavras.lista;
  }
  set.delete("");
  cachePalavras = { em: Date.now(), lista: [...set] };
  return cachePalavras.lista;
}

function origemPeloTexto(texto: string, palavras: string[] = PALAVRAS_CTA): OrigemLead | null {
  const t = texto.trim();
  if (!t) return null;

  const vim = RE_VIM_PELO.exec(t);
  if (vim) {
    const rede = vim[2].toLowerCase().startsWith("f") ? "facebook" : "instagram";
    return { plataforma: rede, tipo: "organico", anuncioId: "perfil", anuncioTitulo: `Perfil ${rede === "facebook" ? "Facebook" : "Instagram"} (bio/post)` };
  }

  // "FILA", "fila!", "#fila", "Fila 👍" — mas não "quero sair da empresa"
  const limpo = normalizarPalavra(t);
  const palavra = palavras.find(p => limpo === normalizarPalavra(p));
  if (palavra) {
    return { plataforma: "social", tipo: "organico", anuncioId: palavra, anuncioTitulo: `Vídeo · palavra-chave ${palavra}` };
  }
  return null;
}

function origemPelaReferencia(msg: any): OrigemLead | null {
  const texto = textoDaMensagem(msg);
  const achou = RE_REF_SITE.exec(texto);
  if (!achou) return null;

  const partes = achou[1].split("\u00b7").map((s: string) => s.trim()).filter(Boolean);
  let contexto = partes[0] || "";
  const campanha = partes[1] || "";

  let site = SITE_PADRAO;
  if (contexto.includes("/")) {
    const [slug, ...resto] = contexto.split("/");
    const achouSite = SITES[slug.trim().toLowerCase()];
    if (achouSite) {
      site = achouSite;
      contexto = resto.join("/").trim();
    }
  }

  return {
    plataforma: "site",
    tipo: campanha ? "anuncio" : "link",
    anuncioId: campanha || null,
    anuncioTitulo: campanha ? `${site.nome} — ${campanha}` : site.nome,
    anuncioTexto: contexto ? `clique: ${contexto}` : null,
    url: site.url,
  };
}

/**
 * `lerTexto` liga a leitura do texto (bio/palavra-chave). Só faz sentido na chegada do lead:
 * no meio da conversa, um "acordo" ou "prazo" solto não diz nada sobre a origem.
 */
export function extrairOrigem(msg: any, lerTexto = true, palavras: string[] = PALAVRAS_CTA): OrigemLead | null {
  const ctx = msg?.contextInfo
    ?? msg?.message?.extendedTextMessage?.contextInfo
    ?? msg?.message?.conversation?.contextInfo
    ?? null;
  const porTexto = () => origemPelaReferencia(msg) ?? (lerTexto ? origemPeloTexto(textoDaMensagem(msg), palavras) : null);
  if (!ctx || typeof ctx !== "object") return porTexto();

  const ad = ctx.externalAdReply;
  const entry: string = ctx.entryPointConversionSource ?? ctx.conversionSource ?? "";

  const entryPoint = entry ? String(entry).slice(0, 60) : null;

  if (ad && (ad.sourceId || ad.title || ad.ctwaClid || entry === "ctwa_ad")) {
    const app = String(ad.sourceApp ?? ctx.entryPointConversionApp ?? "").toLowerCase();
    // Botão de WhatsApp de um post NÃO impulsionado: chega igual a anúncio, mas sem clique pago.
    const postOrganico = String(ad.sourceType ?? "").toLowerCase() === "post" && entry !== "ctwa_ad" && !ad.ctwaClid;
    return {
      plataforma: app === "facebook" || app === "instagram" ? app : "meta",
      tipo: postOrganico ? "organico" : "anuncio",
      anuncioId: ad.sourceId ? String(ad.sourceId) : null,
      anuncioTitulo: ad.title ? String(ad.title).slice(0, 200) : null,
      anuncioTexto: ad.body ? String(ad.body).slice(0, 500) : null,
      url: ad.sourceUrl ? String(ad.sourceUrl).slice(0, 500) : null,
      ctwaClid: typeof ad.ctwaClid === "string" && ad.ctwaClid.trim() ? ad.ctwaClid.trim().slice(0, 1000) : null,
      sourceType: ad.sourceType ? String(ad.sourceType).slice(0, 40) : null,
      entryPoint,
    };
  }
  if (entry === "ctwa_ad") return { plataforma: "meta", tipo: "anuncio", entryPoint };
  // wa.me da bio ou de um post também chega como click_to_chat_link: o texto diz de onde veio.
  const t = porTexto();
  if (t) return { ...t, entryPoint };
  if (ENTRY_MAP[entry]) return { ...ENTRY_MAP[entry], entryPoint };
  return null;
}

/**
 * Grava a origem no deal se ainda não tiver. A origem só vem na PRIMEIRA mensagem
 * do lead; mensagens seguintes não trazem o metadado, por isso nunca sobrescreve.
 */
export async function registrarOrigemDeal(
  deal: { id: string; origemEm?: Date | null; criadoEm?: Date | null; origemAnuncioId?: string | null },
  msg: any,
): Promise<OrigemLead | null> {
  const chegando = !deal.criadoEm || Date.now() - new Date(deal.criadoEm).getTime() < 15 * 60_000;
  // Quem vem do Reel abre o WhatsApp pelo link da bio ("vim pelo Instagram") e só depois digita
  // a palavra-chave do vídeo: nesse caso a palavra-chave substitui a origem genérica do perfil.
  const refinarPerfil = !!deal.origemEm && deal.origemAnuncioId === "perfil" && chegando;
  if (deal.origemEm && !refinarPerfil) return null;
  const palavras = chegando ? await palavrasCta() : PALAVRAS_CTA;
  const o = refinarPerfil ? origemPeloTexto(textoDaMensagem(msg), palavras) : extrairOrigem(msg, chegando, palavras);
  if (!o || (refinarPerfil && o.anuncioId === "perfil")) return null;
  try {
    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: {
        origemPlataforma: o.plataforma, origemTipo: o.tipo,
        origemAnuncioId: o.anuncioId ?? null, origemAnuncioTitulo: o.anuncioTitulo ?? null,
        origemAnuncioTexto: o.anuncioTexto ?? null, origemUrl: o.url ?? null, origemEm: new Date(),
        origemCtwaClid: o.ctwaClid ?? null, origemSourceType: o.sourceType ?? null, origemEntryPoint: o.entryPoint ?? null,
      },
    });
    console.log(`[Origem] Deal ${deal.id}: ${o.plataforma}/${o.tipo}${o.anuncioId ? " ad=" + o.anuncioId : ""}${o.ctwaClid ? " ctwa" : ""}`);
  } catch (err: any) {
    console.warn(`[Origem] Falha ao gravar origem do deal ${deal.id}: ${err?.message ?? err}`);
  }
  return o;
}
