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
const HOTSITE_URL = "https://subvencaoicms.pinheirosilva.adv.br/";

function origemPelaReferencia(msg: any): OrigemLead | null {
  const m = msg?.message ?? {};
  const texto = m.conversation
    ?? m.extendedTextMessage?.text
    ?? m.imageMessage?.caption
    ?? "";
  const achou = RE_REF_SITE.exec(String(texto));
  if (!achou) return null;

  const partes = achou[1].split("\u00b7").map((s: string) => s.trim()).filter(Boolean);
  const contexto = partes[0] || "";
  const campanha = partes[1] || "";
  return {
    plataforma: "site",
    tipo: campanha ? "anuncio" : "link",
    anuncioId: campanha || null,
    anuncioTitulo: campanha ? `Hotsite subvencoes — ${campanha}` : "Hotsite subvencoes",
    anuncioTexto: contexto ? `clique: ${contexto}` : null,
    url: HOTSITE_URL,
  };
}

export function extrairOrigem(msg: any): OrigemLead | null {
  const ctx = msg?.contextInfo
    ?? msg?.message?.extendedTextMessage?.contextInfo
    ?? msg?.message?.conversation?.contextInfo
    ?? null;
  if (!ctx || typeof ctx !== "object") return origemPelaReferencia(msg);

  const ad = ctx.externalAdReply;
  const entry: string = ctx.entryPointConversionSource ?? ctx.conversionSource ?? "";

  if (ad && (ad.sourceId || ad.title || entry === "ctwa_ad")) {
    const app = String(ad.sourceApp ?? ctx.entryPointConversionApp ?? "").toLowerCase();
    return {
      plataforma: app === "facebook" || app === "instagram" ? app : "meta",
      tipo: "anuncio",
      anuncioId: ad.sourceId ? String(ad.sourceId) : null,
      anuncioTitulo: ad.title ? String(ad.title).slice(0, 200) : null,
      anuncioTexto: ad.body ? String(ad.body).slice(0, 500) : null,
      url: ad.sourceUrl ? String(ad.sourceUrl).slice(0, 500) : null,
    };
  }
  if (entry === "ctwa_ad") return { plataforma: "meta", tipo: "anuncio" };
  if (ENTRY_MAP[entry]) return { ...ENTRY_MAP[entry] };
  return origemPelaReferencia(msg);
}

/**
 * Grava a origem no deal se ainda não tiver. A origem só vem na PRIMEIRA mensagem
 * do lead; mensagens seguintes não trazem o metadado, por isso nunca sobrescreve.
 */
export async function registrarOrigemDeal(deal: { id: string; origemEm?: Date | null }, msg: any): Promise<OrigemLead | null> {
  if (deal.origemEm) return null;
  const o = extrairOrigem(msg);
  if (!o) return null;
  try {
    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: {
        origemPlataforma: o.plataforma, origemTipo: o.tipo,
        origemAnuncioId: o.anuncioId ?? null, origemAnuncioTitulo: o.anuncioTitulo ?? null,
        origemAnuncioTexto: o.anuncioTexto ?? null, origemUrl: o.url ?? null, origemEm: new Date(),
      },
    });
    console.log(`[Origem] Deal ${deal.id}: ${o.plataforma}/${o.tipo}${o.anuncioId ? " ad=" + o.anuncioId : ""}`);
  } catch (err: any) {
    console.warn(`[Origem] Falha ao gravar origem do deal ${deal.id}: ${err?.message ?? err}`);
  }
  return o;
}
