/**
 * Automações do Instagram Direct / Messenger no estilo ManyChat: gatilho + passos em sequência.
 *
 * Gatilhos: comentário (palavra ou qualquer, filtro por post), palavra no Direct, 1ª mensagem,
 * resposta/menção em story, link ig.me/m.me com ?ref=, e "só por botão" (chamada por outra).
 * Passos: texto (com botões que levam a outra automação), imagem, vídeo, áudio, PDF, cartões
 * (carrossel), esperar, condição, pedir WhatsApp, ação (tag, etapa do funil, nota) e ir para.
 *
 * Mora em IaProjetoConfig `meta_social_automacoes` (JSON). Com a lista preenchida, ela substitui
 * as respostas antigas (regras por palavra, story, 1ª resposta, comentário qualquer).
 *
 * Regras da Meta que moldam o motor:
 * - Comentário só admite UMA resposta privada, e nada mais até o lead responder. Então, num gatilho
 *   de comentário, roda até o 1º passo de texto (vai como resposta privada) e o resto fica pendente:
 *   continua quando o lead tocar no botão ou responder qualquer coisa (flag em deal.iaFlags).
 * - Botão rápido some depois de tocado e só vai em texto; botão de cartão pode ser link ou ação.
 * - Mídia vai por URL pública (a Meta baixa): os arquivos ficam em UPLOADS/meta-social e são
 *   servidos por GET /api/meta/midia/:projetoId/:arquivo.
 */

import { prisma } from "../db.js";
import { codigoDoPost } from "./meta-social.js";
import type { CanalSocial, SocialConfig, BotaoRapido } from "./meta-social.js";

export type BotaoAut = { titulo: string; vaiPara?: string; url?: string };
export type Midia = { arquivo: string; nome: string; mime: string };
export type Cartao = { titulo: string; subtitulo?: string; imagem?: Midia | null; botoes: BotaoAut[] };

export type Passo =
  | { tipo: "texto"; texto: string; botoes?: BotaoAut[] }
  | { tipo: "imagem" | "video" | "audio" | "arquivo"; midia: Midia }
  | { tipo: "cartoes"; cartoes: Cartao[] }
  | { tipo: "esperar"; segundos: number }
  | { tipo: "condicao"; se: Condicao; valor?: string; entao?: string; senao?: string }
  | { tipo: "pedir_whatsapp"; texto: string }
  | { tipo: "acao"; acao: "tag" | "etapa" | "nota"; valor: string }
  | { tipo: "ir_para"; automacao: string };

export type Condicao = "segue_perfil" | "tem_whatsapp" | "canal_instagram" | "tem_tag";

export type Gatilho =
  | { tipo: "comentario"; palavras: string[]; posts: string[]; publico?: string }
  | { tipo: "dm_palavra"; palavras: string[] }
  | { tipo: "dm_primeira" }
  | { tipo: "story_resposta" }
  | { tipo: "story_mencao" }
  | { tipo: "link"; ref: string }
  | { tipo: "botao" };

export type Automacao = {
  id: string;
  nome: string;
  ativo: boolean;
  canais: CanalSocial[];
  gatilho: Gatilho;
  /** No máximo uma vez a cada 24h por pessoa (comentário qualquer, story, 1ª mensagem). */
  umaVez24h: boolean;
  passos: Passo[];
};

const ESPERA_MAX_S = 600;
const PROFUNDIDADE_MAX = 8;
export const REMETENTE_AUT = "Resposta automática";

// ── Puras (testadas em meta-automacoes.test.ts) ─────────────────────────────

const semAcento = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
export const normalizar = (s: string) => semAcento(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

const lista = (v: unknown, sep = /[,\n]/): string[] =>
  (Array.isArray(v) ? v : String(v ?? "").split(sep)).map((x) => String(x).trim()).filter(Boolean);

function lerMidia(v: any): Midia | null {
  if (!v?.arquivo) return null;
  return { arquivo: String(v.arquivo), nome: String(v.nome ?? v.arquivo), mime: String(v.mime ?? "") };
}

function lerBotoes(v: any, max: number): BotaoAut[] {
  return (Array.isArray(v) ? v : [])
    .map((b: any) => ({
      titulo: String(b?.titulo ?? "").trim(),
      ...(b?.vaiPara ? { vaiPara: String(b.vaiPara) } : {}),
      ...(b?.url ? { url: String(b.url).trim() } : {}),
    }))
    .filter((b) => b.titulo)
    .slice(0, max);
}

function lerPasso(p: any): Passo | null {
  switch (p?.tipo) {
    case "texto": {
      const texto = String(p.texto ?? "").trim();
      return texto ? { tipo: "texto", texto, botoes: lerBotoes(p.botoes, 13) } : null;
    }
    case "imagem": case "video": case "audio": case "arquivo": {
      const midia = lerMidia(p.midia);
      return midia ? { tipo: p.tipo, midia } : null;
    }
    case "cartoes": {
      const cartoes = (Array.isArray(p.cartoes) ? p.cartoes : [])
        .map((c: any) => ({
          titulo: String(c?.titulo ?? "").trim().slice(0, 80),
          subtitulo: String(c?.subtitulo ?? "").trim().slice(0, 80),
          imagem: lerMidia(c?.imagem),
          botoes: lerBotoes(c?.botoes, 3),
        }))
        .filter((c: Cartao) => c.titulo)
        .slice(0, 10);
      return cartoes.length ? { tipo: "cartoes", cartoes } : null;
    }
    case "esperar":
      return { tipo: "esperar", segundos: Math.max(1, Math.min(ESPERA_MAX_S, Number(p.segundos) || 3)) };
    case "condicao": {
      const se = ["segue_perfil", "tem_whatsapp", "canal_instagram", "tem_tag"].includes(p.se) ? p.se as Condicao : null;
      return se ? { tipo: "condicao", se, valor: String(p.valor ?? ""), entao: String(p.entao ?? ""), senao: String(p.senao ?? "") } : null;
    }
    case "pedir_whatsapp":
      return { tipo: "pedir_whatsapp", texto: String(p.texto ?? "").trim() || "Me passa seu WhatsApp com DDD que a nossa equipe te chama por lá 📲" };
    case "acao": {
      const acao = ["tag", "etapa", "nota"].includes(p.acao) ? p.acao : null;
      const valor = String(p.valor ?? "").trim();
      return acao && valor ? { tipo: "acao", acao, valor } : null;
    }
    case "ir_para":
      return p.automacao ? { tipo: "ir_para", automacao: String(p.automacao) } : null;
  }
  return null;
}

function lerGatilho(g: any): Gatilho {
  switch (g?.tipo) {
    case "comentario":
      return { tipo: "comentario", palavras: lista(g.palavras), posts: lista(g.posts, /[\s,]+/).map(codigoDoPost).filter(Boolean), publico: String(g.publico ?? "").trim() };
    case "dm_palavra": return { tipo: "dm_palavra", palavras: lista(g.palavras) };
    case "dm_primeira": case "story_resposta": case "story_mencao": case "botao": return { tipo: g.tipo };
    case "link": return { tipo: "link", ref: normalizar(String(g.ref ?? "")).replace(/ /g, "_") };
  }
  return { tipo: "botao" };
}

export function lerAutomacoes(json: string): Automacao[] {
  try {
    const v = JSON.parse(json || "[]");
    return (Array.isArray(v) ? v : [])
      .filter((a: any) => a?.id)
      .map((a: any) => {
        const gatilho = lerGatilho(a.gatilho);
        return {
          id: String(a.id),
          nome: String(a.nome ?? "").trim() || "Automação",
          ativo: a.ativo !== false,
          canais: (lista(a.canais).filter((c) => c === "instagram" || c === "messenger") as CanalSocial[]).length
            ? lista(a.canais).filter((c) => c === "instagram" || c === "messenger") as CanalSocial[]
            : ["instagram", "messenger"],
          gatilho,
          umaVez24h: a.umaVez24h === undefined
            ? ["story_resposta", "story_mencao", "dm_primeira"].includes(gatilho.tipo) || (gatilho.tipo === "comentario" && !gatilho.palavras.length)
            : !!a.umaVez24h,
          passos: (Array.isArray(a.passos) ? a.passos : []).map(lerPasso).filter(Boolean) as Passo[],
        };
      });
  } catch { return []; }
}

/** "AUT:<id>:<passo>" — payload de botão que roda a automação a partir de um passo. */
export const payloadAut = (id: string, passo = 0) => `AUT:${id}:${passo}`;
export function lerPayloadAut(payload: string | undefined | null): { id: string; passo: number } | null {
  const m = String(payload ?? "").match(/^AUT:([^:]+):(\d+)$/);
  return m ? { id: m[1], passo: Number(m[2]) } : null;
}

/** Palavra inteira; a mais longa ganha. `inteiro` = o texto é só a palavra. */
function casaPalavra(texto: string, palavras: string[], inteiro: boolean): string | null {
  const t = normalizar(texto);
  if (!t) return null;
  const achada = palavras.map((p) => ({ p, n: normalizar(p) })).filter((x) => x.n)
    .sort((a, b) => b.n.length - a.n.length)
    .find((x) => (inteiro ? t === x.n : ` ${t} `.includes(` ${x.n} `)));
  return achada?.p ?? null;
}

export type EventoAut =
  | { tipo: "comentario"; texto: string }
  | { tipo: "mensagem"; texto: string; primeira: boolean; story?: "resposta" | "mencao"; ref?: string | null };

/**
 * Automações que o evento dispara, na ordem de preferência. Comentário: as de palavra antes das
 * de "qualquer comentário" (o filtro de posts é conferido por quem chama, porque precisa da Graph).
 * Mensagem: link → story → palavra → 1ª mensagem.
 */
export function candidatas(automacoes: Automacao[], canal: CanalSocial, ev: EventoAut): { aut: Automacao; palavra: string | null }[] {
  const ativas = automacoes.filter((a) => a.ativo && a.canais.includes(canal));
  if (ev.tipo === "comentario") {
    const com = ativas.filter((a) => a.gatilho.tipo === "comentario") as (Automacao & { gatilho: { tipo: "comentario"; palavras: string[] } })[];
    const porPalavra = com.filter((a) => a.gatilho.palavras.length)
      .map((a) => ({ aut: a as Automacao, palavra: casaPalavra(ev.texto, a.gatilho.palavras, false) }))
      .filter((x) => x.palavra);
    const qualquer = com.filter((a) => !a.gatilho.palavras.length).map((a) => ({ aut: a as Automacao, palavra: null }));
    return [...porPalavra, ...qualquer];
  }
  const out: { aut: Automacao; palavra: string | null }[] = [];
  const ref = ev.ref ? normalizar(ev.ref).replace(/ /g, "_") : "";
  if (ref) for (const a of ativas) if (a.gatilho.tipo === "link" && a.gatilho.ref === ref) out.push({ aut: a, palavra: ref });
  if (ev.story) {
    const t = ev.story === "mencao" ? "story_mencao" : "story_resposta";
    for (const a of ativas) if (a.gatilho.tipo === t) out.push({ aut: a, palavra: null });
  }
  for (const a of ativas) {
    if (a.gatilho.tipo !== "dm_palavra") continue;
    const palavra = casaPalavra(ev.texto, a.gatilho.palavras, !ev.primeira);
    if (palavra) out.push({ aut: a, palavra });
  }
  if (ev.primeira && !ev.story) for (const a of ativas) if (a.gatilho.tipo === "dm_primeira") out.push({ aut: a, palavra: null });
  return out;
}

/** Todas as palavras das automações (origem do lead e links por palavra). */
export function palavrasDasAutomacoes(automacoes: Automacao[]): string[] {
  return automacoes.flatMap((a) => (a.gatilho.tipo === "comentario" || a.gatilho.tipo === "dm_palavra" ? a.gatilho.palavras : []));
}

// ── Execução ────────────────────────────────────────────────────────────────

export type Contexto = {
  cfg: SocialConfig;
  canal: CanalSocial;
  /** IGSID/PSID; null quando ainda só existe o comentário (antes da resposta privada). */
  userId: string | null;
  /** null só no gatilho de comentário, até a resposta privada abrir a conversa. */
  contato: { id: string; nome: string | null; whatsapp?: string | null } | null;
  deal: { id: string; pipelineId: string | null } | null;
  /** Gatilho de comentário: o 1º texto vai como resposta privada a este comentário. */
  comentarioId?: string;
  /** Cria contato + deal com o id devolvido pela resposta privada (e grava o comentário). */
  abrir?: (recipientId: string) => Promise<{ contato: { id: string; nome: string | null; whatsapp?: string | null }; deal: { id: string; pipelineId: string | null } }>;
  nome: string | null;
};

const mediaBase = () => (process.env.APP_BASE_URL ?? "https://avoce.capium.com.br").replace(/\/$/, "");
export const urlDaMidia = (projetoId: string, m: Midia) => `${mediaBase()}/api/meta/midia/${projetoId}/${encodeURIComponent(m.arquivo)}`;

const TIPO_ANEXO: Record<string, string> = { imagem: "image", video: "video", audio: "audio", arquivo: "file" };
const TIPO_CRM: Record<string, string> = { imagem: "image", video: "video", audio: "audio", arquivo: "document" };

async function flags(dealId: string): Promise<Record<string, unknown>> {
  const d = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: { iaFlags: true } });
  return (d?.iaFlags && typeof d.iaFlags === "object" ? d.iaFlags : {}) as Record<string, unknown>;
}
async function setFlag(dealId: string, chave: string, valor: unknown) {
  const f = await flags(dealId);
  if (valor === undefined) delete f[chave]; else f[chave] = valor;
  await prisma.crmDeal.update({ where: { id: dealId }, data: { iaFlags: f as any } });
}

/** Continuação guardada quando a Meta não deixa seguir (resposta privada de comentário). */
export async function continuacaoPendente(dealId: string): Promise<{ id: string; passo: number } | null> {
  const p = (await flags(dealId))._metaContinuar as { id?: string; passo?: number; em?: number } | undefined;
  if (!p?.id || !p.em || Date.now() - p.em > 7 * 86_400_000) return null;
  return { id: p.id, passo: Number(p.passo ?? 0) };
}
export const limparContinuacao = (dealId: string) => setFlag(dealId, "_metaContinuar", undefined);

export async function jaRodouEm24h(dealId: string, aut: Automacao): Promise<boolean> {
  const recente = await prisma.crmMensagemWhatsapp.findFirst({
    where: { dealId, direcao: "out", remetente: `${REMETENTE_AUT} · ${aut.nome}`, enviadaEm: { gte: new Date(Date.now() - 86_400_000) } },
    select: { id: true },
  });
  return !!recente;
}

function botoesRapidos(botoes: BotaoAut[] | undefined): BotaoRapido[] {
  return (botoes ?? []).map((b) => ({ titulo: b.titulo, ...(b.vaiPara ? { payload: payloadAut(b.vaiPara, 0) } : {}) }));
}

async function avaliar(ctx: Contexto, p: Extract<Passo, { tipo: "condicao" }>): Promise<boolean> {
  const { segueOPerfil } = await import("./meta-social.js");
  switch (p.se) {
    case "segue_perfil":
      // Sem conversa aberta (só o comentário) a Meta não informa: segue o fluxo.
      return ctx.userId ? (await segueOPerfil(ctx.cfg, ctx.canal, ctx.userId)) !== false : true;
    case "tem_whatsapp": {
      if (!ctx.contato) return false;
      const c = await prisma.crmContato.findUnique({ where: { id: ctx.contato.id }, select: { whatsapp: true } });
      return !!c?.whatsapp;
    }
    case "canal_instagram": return ctx.canal === "instagram";
    case "tem_tag": {
      if (!ctx.deal) return false;
      const n = await prisma.crmDeal.count({ where: { id: ctx.deal.id, tags: { some: { nome: { equals: p.valor ?? "", mode: "insensitive" } } } } });
      return n > 0;
    }
  }
}

async function acao(ctx: Contexto, p: Extract<Passo, { tipo: "acao" }>) {
  if (!ctx.deal) return;
  if (p.acao === "nota") {
    await prisma.crmNota.create({ data: { dealId: ctx.deal.id, conteudo: `[Automação] ${p.valor}` } });
  } else if (p.acao === "tag") {
    const empresaId = ctx.cfg.empresaId;
    const tag = await prisma.crmTag.findFirst({ where: { nome: { equals: p.valor, mode: "insensitive" }, ...(empresaId ? { empresaId } : {}) } })
      ?? await prisma.crmTag.create({ data: { nome: p.valor, ...(empresaId ? { empresaId } : {}) } });
    await prisma.crmDeal.update({ where: { id: ctx.deal.id }, data: { tags: { connect: { id: tag.id } } } });
  } else if (p.acao === "etapa" && ctx.deal.pipelineId) {
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: ctx.deal.pipelineId, OR: [{ chave: p.valor }, { nome: { equals: p.valor, mode: "insensitive" } }] },
    });
    if (stage) await prisma.crmDeal.update({ where: { id: ctx.deal.id }, data: { stageId: stage.id } });
    else console.warn(`[MetaAut] etapa "${p.valor}" não existe no funil do deal ${ctx.deal.id}`);
  }
}

/**
 * Roda a automação a partir de `inicio`. Grava no CRM tudo o que envia. Erro de envio de um passo
 * interrompe a automação (não adianta seguir mandando para quem a Meta recusou).
 */
export async function executar(ctx: Contexto, automacoes: Automacao[], aut: Automacao, inicio = 0, profundidade = 0): Promise<void> {
  if (profundidade > PROFUNDIDADE_MAX) { console.warn(`[MetaAut] laço de automações parado em "${aut.nome}"`); return; }
  const ms = await import("./meta-social.js");
  const { cfg, canal } = ctx;
  const remetente = `${REMETENTE_AUT} · ${aut.nome}`;
  const porId = (id?: string) => (id ? automacoes.find((a) => a.id === id && a.ativo) : undefined);
  const gravar = (mid: string | null, conteudo: string, tipo = "text", midiaUrl: string | null = null) =>
    ms.gravarMensagem({ cfg, canal, dealId: ctx.deal!.id, contatoId: ctx.contato!.id, direcao: "out", mid, conteudo, tipo, midiaUrl, remetente });
  const acoesAdiadas: Extract<Passo, { tipo: "acao" }>[] = [];

  for (let i = inicio; i < aut.passos.length; i++) {
    const p = aut.passos[i];

    // Só o comentário, sem conversa: o 1º texto vira resposta privada; o resto espera o lead responder.
    if (!ctx.userId) {
      if (p.tipo !== "texto" && p.tipo !== "pedir_whatsapp" && p.tipo !== "acao" && p.tipo !== "condicao") {
        // Mídia/cartão/espera antes do 1º texto: não dá para mandar ainda — pula para o primeiro texto.
        continue;
      }
      if (p.tipo === "acao") { acoesAdiadas.push(p); continue; }
      if (p.tipo === "condicao") {
        if (await avaliar(ctx, p)) { const alvo = porId(p.entao); if (alvo) return executar(ctx, automacoes, alvo, 0, profundidade + 1); continue; }
        const alvo = porId(p.senao); if (alvo) return executar(ctx, automacoes, alvo, 0, profundidade + 1); return;
      }
      const texto = ms.preencher(p.texto, ctx.nome);
      const resto = i + 1 < aut.passos.length;
      let botoes = p.tipo === "texto" ? botoesRapidos(p.botoes) : [];
      // Sem botão próprio e com passos depois: um botão para continuar (e qualquer resposta continua).
      if (!botoes.length && resto) botoes = [{ titulo: "Quero ver 👇", payload: payloadAut(aut.id, i + 1) }];
      const r = await ms.responderComentarioPrivado(cfg, ctx.comentarioId!, texto, botoes);
      if (!r.recipientId || !ctx.abrir) return;
      ctx.userId = r.recipientId;
      const aberto = await ctx.abrir(r.recipientId);
      ctx.contato = aberto.contato;
      ctx.deal = aberto.deal;
      for (const a of acoesAdiadas) await acao(ctx, a);
      await gravar(r.messageId, botoes.length ? `${r.texto}\n[${botoes.map((b) => b.titulo).join(" | ")}]` : r.texto);
      if (resto && !(p.tipo === "texto" && p.botoes?.length)) await setFlag(ctx.deal!.id, "_metaContinuar", { id: aut.id, passo: i + 1, em: Date.now() });
      return;
    }

    switch (p.tipo) {
      case "texto":
      case "pedir_whatsapp": {
        const texto = ms.preencher(p.texto, ctx.nome);
        const botoes = p.tipo === "texto" ? botoesRapidos(p.botoes) : [];
        const mid = await ms.enviarTextoSocial(cfg, ctx.userId, texto, botoes);
        await gravar(mid, botoes.length ? `${texto}\n[${botoes.map((b) => b.titulo).join(" | ")}]` : texto);
        // Botões esperam a escolha do lead: o fluxo continua pela automação do botão.
        if (botoes.length) return;
        break;
      }
      case "imagem": case "video": case "audio": case "arquivo": {
        const url = urlDaMidia(cfg.projetoId, p.midia);
        const mid = await ms.enviarMensagemSocial(cfg, ctx.userId, { attachment: { type: TIPO_ANEXO[p.tipo], payload: { url, is_reusable: true } } });
        await gravar(mid, p.tipo === "arquivo" ? `📄 ${p.midia.nome}` : `[${p.tipo}] ${p.midia.nome}`, TIPO_CRM[p.tipo], url);
        break;
      }
      case "cartoes": {
        const elements = p.cartoes.map((c) => ({
          title: c.titulo,
          ...(c.subtitulo ? { subtitle: c.subtitulo } : {}),
          ...(c.imagem ? { image_url: urlDaMidia(cfg.projetoId, c.imagem) } : {}),
          ...(c.botoes.length ? {
            buttons: c.botoes.map((b) => (b.url
              ? { type: "web_url", url: b.url, title: b.titulo.slice(0, 20) }
              : { type: "postback", title: b.titulo.slice(0, 20), payload: b.vaiPara ? payloadAut(b.vaiPara, 0) : `QR:${b.titulo}` })),
          } : {}),
        }));
        const mid = await ms.enviarMensagemSocial(cfg, ctx.userId, { attachment: { type: "template", payload: { template_type: "generic", elements } } });
        await gravar(mid, p.cartoes.map((c) => `🗂 ${c.titulo}${c.botoes.length ? ` [${c.botoes.map((b) => b.titulo).join(" | ")}]` : ""}`).join("\n"));
        if (p.cartoes.some((c) => c.botoes.some((b) => !b.url))) return;
        break;
      }
      case "esperar":
        await new Promise((r) => setTimeout(r, p.segundos * 1000));
        break;
      case "condicao": {
        const ok = await avaliar(ctx, p);
        const alvo = porId(ok ? p.entao : p.senao);
        if (alvo) return executar(ctx, automacoes, alvo, 0, profundidade + 1);
        if (!ok) return;
        break;
      }
      case "acao":
        await acao(ctx, p);
        break;
      case "ir_para": {
        const alvo = porId(p.automacao);
        if (alvo) return executar(ctx, automacoes, alvo, 0, profundidade + 1);
        return;
      }
    }
  }
}
