/**
 * Conversions API for Business Messaging — devolve à Meta o "lead qualificado" do SDR,
 * atribuído ao clique do anúncio Click-to-WhatsApp pelo ctwa_clid.
 *
 * Consome a fila MetaConversaoEvento (gravada por agent/lead-qualificado.ts). Não conhece
 * conversa nem funil: só lê a fila, envia e anota o resultado na própria linha.
 *
 * Configuração por projeto de IA (IaProjetoConfig, categoria "meta_capi"):
 *   meta_capi_ativo              "true" liga o envio. Qualquer outra coisa = desligado (padrão).
 *   meta_capi_dataset_id         dataset vinculado à WABA (POST /{waba_id}/dataset)
 *   meta_capi_waba_id            WhatsApp Business Account do número dos anúncios
 *   meta_capi_mkt_projeto_id     MktProjeto cujo meta_access_token (system user) é usado
 *   meta_capi_test_event_code    opcional; se presente vai em todo envio (validação no Events Manager)
 *
 * Fora de produção só envia com test_event_code — nunca polui o dataset real.
 * A Meta NÃO deduplica eventos de Business Messaging: a idempotência é o eventId único da fila
 * mais o claim atômico abaixo.
 */

import { createDecipheriv } from "node:crypto";
import { prisma } from "../db.js";

const GRAPH = "https://graph.facebook.com/v21.0";
const LOTE = 50;
const MAX_TENTATIVAS = 8;
const BACKOFF_BASE_MS = 60_000;          // 1, 2, 4, 8... min
const BACKOFF_MAX_MS = 6 * 3_600_000;    // teto de 6 h
// Evento com mais de 7 dias não é aceito como conversão recente; não adianta insistir.
const JANELA_MAX_MS = 7 * 86_400_000;
const TIMEOUT_MS = 15_000;
const ENVIANDO_PRESO_MS = 10 * 60_000;

export type CapiConfig = {
  ativo: boolean;
  datasetId: string | null;
  wabaId: string | null;
  mktProjetoId: string | null;
  testEventCode: string | null;
};

export type EventoFila = {
  eventId: string;
  eventName: string;
  ctwaClid: string | null;
  ocorridoEm: Date;
};

// ── Puras (testadas em meta-capi.test.ts) ───────────────────────────────────

export function montarEvento(ev: EventoFila, wabaId: string) {
  return {
    event_name: ev.eventName,
    event_time: Math.floor(ev.ocorridoEm.getTime() / 1000),
    event_id: ev.eventId,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: {
      whatsapp_business_account_id: wabaId,
      ctwa_clid: ev.ctwaClid,
    },
  };
}

export function montarCorpo(ev: EventoFila, wabaId: string, testEventCode: string | null) {
  return {
    data: [montarEvento(ev, wabaId)],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

export function proximoAtraso(tentativas: number, aleatorio = Math.random()): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, tentativas - 1), BACKOFF_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * aleatorio)); // ±20% para não sincronizar reenvios
}

/** Decide o que fazer com a resposta: sucesso, tentar de novo ou desistir. */
export function classificarResposta(
  httpStatus: number | null,
  corpo: any,
): "enviado" | "retry" | "permanente" {
  if (httpStatus === null) return "retry"; // rede / timeout
  if (httpStatus >= 200 && httpStatus < 300 && !corpo?.error) return "enviado";
  const code = Number(corpo?.error?.code);
  // limites de taxa e indisponibilidade temporária da Graph API
  if (httpStatus === 429 || httpStatus >= 500 || [1, 2, 4, 17, 32, 341, 613].includes(code) || corpo?.error?.is_transient) {
    return "retry";
  }
  return "permanente"; // parâmetro inválido, token sem permissão, dataset errado...
}

export function podeEnviarNoAmbiente(nodeEnv: string | undefined, testEventCode: string | null): boolean {
  return nodeEnv === "production" || !!testEventCode;
}

// ── Config ──────────────────────────────────────────────────────────────────

export async function carregarConfigCapi(projetoId: string): Promise<CapiConfig> {
  const rows = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, chave: { startsWith: "meta_capi_" } },
    select: { chave: true, valor: true },
  });
  const v = (k: string) => rows.find((r) => r.chave === k)?.valor?.trim() || null;
  return {
    ativo: v("meta_capi_ativo") === "true",
    datasetId: v("meta_capi_dataset_id"),
    wabaId: v("meta_capi_waba_id"),
    mktProjetoId: v("meta_capi_mkt_projeto_id"),
    testEventCode: v("meta_capi_test_event_code"),
  };
}

async function tokenMeta(mktProjetoId: string): Promise<string | null> {
  const cfg = await prisma.mktConfig.findUnique({
    where: { projetoId_chave: { projetoId: mktProjetoId, chave: "meta_access_token" } },
  });
  if (!cfg?.valor) return null;
  if (!cfg.valorEncrypted) return cfg.valor;
  // Mesmo formato de routers/marketingAutopilot.ts (iv 12 | tag 16 | dados), chave CRYPT_KEY_HEX.
  const key = Buffer.from(process.env.CRYPT_KEY_HEX ?? "", "hex");
  if (key.length !== 32) throw new Error("meta_access_token criptografado e CRYPT_KEY_HEX ausente");
  const buf = Buffer.from(cfg.valor, "base64");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

// ── Envio ───────────────────────────────────────────────────────────────────

async function postarEvento(datasetId: string, token: string, corpo: unknown): Promise<{ status: number | null; json: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // Token no corpo, não na URL: a URL costuma parar em log de proxy.
    const res = await fetch(`${GRAPH}/${datasetId}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(corpo as object), access_token: token }),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } catch (err: any) {
    return { status: null, json: { erro_rede: err?.name === "AbortError" ? "timeout" : String(err?.message ?? err) } };
  } finally {
    clearTimeout(timer);
  }
}

const _avisados = new Set<string>();
function avisarUmaVez(chave: string, msg: string) {
  if (_avisados.has(chave)) return;
  _avisados.add(chave);
  console.warn(msg);
}

export async function processarFilaMetaCapi(): Promise<{ enviados: number; falhas: number }> {
  let enviados = 0, falhas = 0;
  const agora = new Date();

  // Linha que ficou "enviando" porque o processo caiu no meio: volta para a fila.
  await prisma.metaConversaoEvento.updateMany({
    where: { status: "enviando", atualizadoEm: { lt: new Date(agora.getTime() - ENVIANDO_PRESO_MS) } },
    data: { status: "falhou", erro: "processo interrompido durante o envio" },
  });

  const projetos = await prisma.iaProjetoConfig.findMany({
    where: { chave: "meta_capi_ativo", valor: "true" },
    select: { projetoId: true },
  });

  for (const { projetoId } of projetos) {
    const cfg = await carregarConfigCapi(projetoId);
    if (!cfg.datasetId || !cfg.wabaId || !cfg.mktProjetoId) {
      avisarUmaVez(`cfg:${projetoId}`, `[MetaCAPI] projeto ${projetoId} ativo mas sem dataset/waba/mkt_projeto — nada enviado`);
      continue;
    }
    if (!podeEnviarNoAmbiente(process.env.NODE_ENV, cfg.testEventCode)) {
      avisarUmaVez(`env:${projetoId}`, `[MetaCAPI] NODE_ENV=${process.env.NODE_ENV} sem meta_capi_test_event_code — envio bloqueado fora de produção`);
      continue;
    }
    let token: string | null;
    try { token = await tokenMeta(cfg.mktProjetoId); } catch (err: any) {
      avisarUmaVez(`tok:${projetoId}`, `[MetaCAPI] projeto ${projetoId}: ${err?.message}`);
      continue;
    }
    if (!token) { avisarUmaVez(`tok:${projetoId}`, `[MetaCAPI] projeto ${projetoId}: MktProjeto sem meta_access_token`); continue; }

    const limiteJanela = new Date(agora.getTime() - JANELA_MAX_MS);

    // O ctwa_clid pode ter sido preenchido depois (backfill): promove para a fila.
    const semCtwa = await prisma.metaConversaoEvento.findMany({
      where: { projetoId, status: "sem_ctwa", ocorridoEm: { gte: limiteJanela } },
      select: { id: true, deal: { select: { origemCtwaClid: true } } },
      take: 200,
    });
    for (const s of semCtwa) {
      if (s.deal.origemCtwaClid) {
        await prisma.metaConversaoEvento.updateMany({
          where: { id: s.id, status: "sem_ctwa" },
          data: { status: "pendente", ctwaClid: s.deal.origemCtwaClid, proximaTentativaEm: agora },
        });
      }
    }

    await prisma.metaConversaoEvento.updateMany({
      where: { projetoId, status: { in: ["pendente", "falhou"] }, ocorridoEm: { lt: limiteJanela } },
      data: { status: "expirado", erro: "mais de 7 dias entre a qualificação e o envio" },
    });

    const lote = await prisma.metaConversaoEvento.findMany({
      where: { projetoId, status: { in: ["pendente", "falhou"] }, proximaTentativaEm: { lte: agora } },
      orderBy: { proximaTentativaEm: "asc" },
      take: LOTE,
    });

    for (const ev of lote) {
      // Claim atômico: só um processo passa daqui com a mesma linha.
      const claim = await prisma.metaConversaoEvento.updateMany({
        where: { id: ev.id, status: ev.status, proximaTentativaEm: { lte: agora } },
        data: { status: "enviando" },
      });
      if (claim.count !== 1) continue;
      if (!ev.ctwaClid) {
        await prisma.metaConversaoEvento.update({ where: { id: ev.id }, data: { status: "sem_ctwa" } });
        continue;
      }

      const corpo = montarCorpo(ev, cfg.wabaId, cfg.testEventCode);
      const { status, json } = await postarEvento(cfg.datasetId, token, corpo);
      const decisao = classificarResposta(status, json);
      const tentativas = ev.tentativas + 1;
      const base = { tentativas, payload: corpo as any, resposta: { http: status, ...json }, testEventCode: cfg.testEventCode };

      if (decisao === "enviado") {
        enviados++;
        await prisma.metaConversaoEvento.update({
          where: { id: ev.id },
          data: { ...base, status: "enviado", enviadoEm: new Date(), erro: null },
        });
        console.log(`[MetaCAPI] enviado deal=${ev.dealId} event_id=${ev.eventId.slice(0, 12)}…${cfg.testEventCode ? " (TESTE)" : ""} resp=${JSON.stringify(json).slice(0, 200)}`);
      } else {
        falhas++;
        const erro = String(json?.error?.message ?? json?.erro_rede ?? `HTTP ${status}`).slice(0, 500);
        const morto = decisao === "permanente" || tentativas >= MAX_TENTATIVAS;
        await prisma.metaConversaoEvento.update({
          where: { id: ev.id },
          data: {
            ...base, erro,
            status: morto ? "morto" : "falhou",
            proximaTentativaEm: new Date(Date.now() + proximoAtraso(tentativas)),
          },
        });
        console.warn(`[MetaCAPI] ${morto ? "MORTO" : "falhou"} deal=${ev.dealId} tentativa=${tentativas} http=${status} erro=${erro}`);
      }
    }
  }
  return { enviados, falhas };
}
