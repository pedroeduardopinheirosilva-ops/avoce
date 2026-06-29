/**
 * Cron Agent — Checks timeout conditions and proactively advances stages
 * Runs every 15 minutes.
 *
 * Rules (from ia_regras_transicao with condicao = "sem_resposta_Xhoras"):
 *   lead_carreteiro     → lead_sem_resposta     (24h)
 *   lead_qualificado    → lead_indeciso          (48h)
 *   lead_indeciso       → com_closer             (72h) + enviar mensagem Closer #1
 *   com_closer          → sem_resposta_closer    após 2 tentativas sem resposta
 */

import { prisma } from "../db.js";
import { transitionDeal, enviarMensagemProativa, getEvolutionConfig, respondFromDealState } from "./stage-engine.js";
import { setEngagementTag } from "./transition-engine.js";

function horaAtualBrasilia(): number {
  return parseInt(
    new Date().toLocaleString("pt-BR", { hour: "numeric", timeZone: "America/Sao_Paulo", hour12: false }),
    10,
  );
}

const _horarioCache = new Map<string, { ini: number; fim: number }>();

async function isHorarioComercial(projetoId: string): Promise<boolean> {
  if (!_horarioCache.has(projetoId)) {
    const cfgs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, chave: { in: ["horario_ini", "horario_fim"] } },
    });
    const ini = parseInt(cfgs.find(c => c.chave === "horario_ini")?.valor ?? "6", 10);
    const fim = parseInt(cfgs.find(c => c.chave === "horario_fim")?.valor ?? "22", 10);
    _horarioCache.set(projetoId, { ini, fim });
  }
  const { ini, fim } = _horarioCache.get(projetoId)!;
  const h = horaAtualBrasilia();
  return h >= ini && h < fim;
}

export function limparCacheHorario(): void {
  _horarioCache.clear();
}

export async function processarTimeoutsAgente(): Promise<void> {
  limparCacheHorario();
  const now = new Date();

  // Load all active deals with IA enabled and open status
  const deals = await prisma.crmDeal.findMany({
    where: {
      iaAtiva: true,
      status: "aberto",
      pipelineId: "pipeline_c3_comercial", // FUNIL CARRETEIROS 3.0 — IA proativa só aqui
      projetoId: { not: null },
      iaStageChave: { not: null },
    },
    select: {
      id: true, projetoId: true, iaStageChave: true, iaPersonaChave: true,
      ultimoContatoEm: true, criadoEm: true, closerTentativas: true,
      qualificacao: true, iaFlowStepData: true,
      contato: { select: { whatsapp: true, nome: true } },
    },
    orderBy: { ultimoContatoEm: "asc" },
  });

  if (!deals.length) return;
  console.log(`[CronAgent] Verificando ${deals.length} deal(s) ativos`);

  for (const deal of deals) {
    if (!deal.projetoId || !deal.iaStageChave) continue;
    const phone = deal.contato?.whatsapp;
    if (!phone) continue;

    const projetoId = deal.projetoId;
    const stageChave = deal.iaStageChave;
    const ultimoContato = deal.ultimoContatoEm ?? deal.criadoEm;
    const horasSemContato = (now.getTime() - ultimoContato.getTime()) / (1000 * 60 * 60);

    try {
      // ── Engajamento: marca "Não Respondendo" após 24h de silêncio ───────────
      // (idempotente; o inbound em stage-engine reverte para "Respondendo")
      if (horasSemContato >= 24) {
        await setEngagementTag(deal.id, false);
      }

      // ── Closer: verificar tentativas esgotadas ──────────────────────────────
      if (stageChave === "com_closer") {
        if (deal.closerTentativas >= 2) {
          await transitionDeal(projetoId, deal.id, "closer_tentativas_esgotadas");
          console.log(`[CronAgent] Deal ${deal.id}: closer esgotado → sem_resposta_closer`);
        } else if (horasSemContato >= 48 && await isHorarioComercial(projetoId)) {
          // Send next closer attempt
          const tentativa = deal.closerTentativas + 1;
          const motive = tentativa === 1 ? "closer_tentativa_1" : "closer_tentativa_2";
          await enviarMensagemProativa(projetoId, deal.id, phone, motive, deal.contato?.nome ?? "");
          await prisma.crmDeal.update({
            where: { id: deal.id },
            data: { closerTentativas: tentativa, ultimoContatoEm: now },
          });
          console.log(`[CronAgent] Deal ${deal.id}: tentativa closer #${tentativa}`);
        }
        continue;
      }

      // ── Load timeout rule for current stage ────────────────────────────────
      const regras = await prisma.iaRegraTransicao.findMany({
        where: { projetoId, stageOrigemChave: stageChave, condicao: "sem_resposta_Xhoras" },
        orderBy: { ordem: "asc" },
      });

      for (const regra of regras) {
        const horasLimite: number = (regra.parametros as any)?.horas ?? 24;
        if (horasSemContato < horasLimite) continue;

        const transitioned = await transitionDeal(projetoId, deal.id, "sem_resposta_Xhoras", phone);
        console.log(
          `[CronAgent] Deal ${deal.id}: ${stageChave} → ${regra.stageDestinoChave} (${horasSemContato.toFixed(1)}h sem resposta)`
        );

        // If transitioning to com_closer, send first closer message
        const novaDeal = await prisma.crmDeal.findUnique({ where: { id: deal.id } });
        if (novaDeal?.iaStageChave === "com_closer" && novaDeal.closerTentativas === 0 && await isHorarioComercial(projetoId)) {
          await enviarMensagemProativa(projetoId, deal.id, phone, "closer_tentativa_1", deal.contato?.nome ?? "");
          await prisma.crmDeal.update({
            where: { id: deal.id },
            data: { closerTentativas: 1, ultimoContatoEm: now },
          });
          console.log(`[CronAgent] Deal ${deal.id}: primeiro contato do Closer enviado`);
        }
        break;
      }

      // ── Timed follow-up rules (follow_up_timed) ────────────────────────────
      // Same-stage follow-ups at configurable intervals. Tracked via _follow_ups_enviados
      // in qualificacao. Does NOT update ultimoContatoEm so the timer keeps running.
      const timedRules = await prisma.iaRegraTransicao.findMany({
        where: { projetoId, stageOrigemChave: stageChave, condicao: "follow_up_timed" },
        orderBy: { ordem: "asc" },
      });

      if (timedRules.length > 0) {
        const qualif = ((deal as any).qualificacao as Record<string, unknown>) ?? {};
        const enviados: string[] = Array.isArray(qualif._follow_ups_enviados)
          ? (qualif._follow_ups_enviados as string[])
          : [];

        for (const rule of timedRules) {
          const delayHoras = (rule.parametros as any)?.delayHoras ?? 24;
          if (horasSemContato < delayHoras) continue;

          const motive = rule.acaoAdicional ?? "";
          if (!motive || enviados.includes(motive)) continue;
          if (!await isHorarioComercial(projetoId)) continue;

          await enviarMensagemProativa(projetoId, deal.id, phone, motive, deal.contato?.nome ?? "");
          await prisma.crmDeal.update({
            where: { id: deal.id },
            data: {
              qualificacao: { ...(qualif as object), _follow_ups_enviados: [...enviados, motive] } as any,
            },
          });
          console.log(`[CronAgent] Deal ${deal.id}: follow-up "${motive}" enviado (${horasSemContato.toFixed(1)}h)`);
          break;
        }
      }
    } catch (err) {
      console.error(`[CronAgent] Erro deal ${deal.id}:`, err);
    }
  }
}

/**
 * Scans for deals with unanswered client messages (last msg = "in", no "out" in 3+ min).
 * Re-triggers respondFromDealState so PM2 restarts don't silently drop pending replies.
 */
export async function recuperarMensagensPerdidas(): Promise<void> {
  const MINUTOS = 3;
  const limiteMs = MINUTOS * 60 * 1000;
  const now = new Date();

  // Stages that require human action — skip them
  const STAGES_HUMANOS = ["com_advogado", "reuniao_agendada", "fechado", "sem_resposta_closer", "lead_sem_resposta", "lead_desqualificado"];

  const deals = await prisma.crmDeal.findMany({
    where: {
      iaAtiva: true,
      status: "aberto",
      pipelineId: "pipeline_c3_comercial", // FUNIL CARRETEIROS 3.0 — IA proativa só aqui
      projetoId: { not: null },
      iaStageChave: { not: null, notIn: STAGES_HUMANOS },
    },
    select: {
      id: true, projetoId: true, iaStageChave: true, iaPersonaChave: true,
      ultimoContatoEm: true, criadoEm: true, closerTentativas: true,
      qualificacao: true, iaFlowStepData: true,
      contato: { select: { whatsapp: true, nome: true } },
    },
  });

  if (!deals.length) return;

  // ── Check for pending persona intro (5-min delay after Ana→Daniela transition) ──
  // A deal needs an intro when: iaPersonaChave="advogado" but last out message is from "assistente"
  // AND at least 5 min passed since the last message (in or out)
  for (const deal of deals) {
    if (!deal.projetoId || !deal.contato?.whatsapp) continue;
    if (deal.iaPersonaChave !== "advogado" && deal.iaPersonaChave !== "closer") continue;
    try {
      const lastOut = await prisma.crmMensagemWhatsapp.findFirst({
        where: { dealId: deal.id, direcao: "out" },
        orderBy: { enviadaEm: "desc" },
      });
      if (!lastOut || (lastOut.personaChave !== "assistente" && lastOut.personaChave !== "secretaria")) continue;

      const lastMsg = await prisma.crmMensagemWhatsapp.findFirst({
        where: { dealId: deal.id },
        orderBy: { enviadaEm: "desc" },
      });
      const idadeMs = now.getTime() - (lastMsg?.enviadaEm ?? deal.criadoEm).getTime();
      if (idadeMs < 5 * 60 * 1000) continue; // menos de 5 min — aguardar setTimeout
      if (!await isHorarioComercial(deal.projetoId)) continue;
      // No upper bound: if last out is still Ana and deal is open, Daniela never introduced herself — always send

      console.log(`[CronAgent] Intro pendente — deal ${deal.id} (persona ${deal.iaPersonaChave}) → enviando`);
      await enviarMensagemProativa(deal.projetoId, deal.id, deal.contato.whatsapp, "primeira_mensagem", deal.contato.nome ?? "");
    } catch (err) {
      console.error(`[CronAgent] Erro intro pendente deal ${deal.id}:`, err);
    }
  }

  // ── Follow-up: last message was outgoing (bot asked) and no reply in 60min ──
  // Covers two failure modes:
  //   1. Evolution API drops the client's reply webhook (LID addressing bug)
  //   2. PM2 OOM restart kills the 15s debounce before message is processed
  // After 60min of silence, re-asks the pending question via respondFromDealState.
  // Applies to ALL personas (Ana + Daniela).
  //
  // Limit: max MAX_FOLLOWUPS_CONSECUTIVOS "out" messages since the last "in".
  // FOLLOWUP_MAX_MS was removed — it was dead code because every respondFromDealState
  // resets ultimaMsgDeal.enviadaEm, so idadeMs never grew past 12h.
  const FOLLOWUP_MIN_MS = 90 * 60 * 1000;        // 1.5h before first follow-up
  const MAX_FOLLOWUPS_CONSECUTIVOS = 2;           // give up after 2 unanswered follow-ups
  const DAILY_OUTGOING_CAP = 5;                  // max bot-initiated messages per deal per 24h
  for (const deal of deals) {
    if (!deal.projetoId || !deal.contato?.whatsapp) continue;

    try {
      const ultimaMsgDeal = await prisma.crmMensagemWhatsapp.findFirst({
        where: { dealId: deal.id },
        orderBy: { enviadaEm: "desc" },
      });
      if (!ultimaMsgDeal || ultimaMsgDeal.direcao !== "out") continue; // last msg is inbound — normal flow handles it
      const idadeMs = now.getTime() - ultimaMsgDeal.enviadaEm.getTime();
      if (idadeMs < FOLLOWUP_MIN_MS) continue;

      // Count "out" messages since the last "in" — limits total follow-ups per unanswered question.
      const ultimaInMsg = await prisma.crmMensagemWhatsapp.findFirst({
        where: { dealId: deal.id, direcao: "in" },
        orderBy: { enviadaEm: "desc" },
      });
      const outsSinceLastIn = await prisma.crmMensagemWhatsapp.count({
        where: {
          dealId: deal.id,
          direcao: "out",
          enviadaEm: { gt: ultimaInMsg?.enviadaEm ?? new Date(0) },
        },
      });
      if (outsSinceLastIn >= MAX_FOLLOWUPS_CONSECUTIVOS) continue; // gave up — let stage-timeout cron handle it

      // Hard daily cap: never send more than DAILY_OUTGOING_CAP bot messages in 24h
      const outgoing24h = await prisma.crmMensagemWhatsapp.count({
        where: { dealId: deal.id, direcao: "out", enviadaEm: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
      });
      if (outgoing24h >= DAILY_OUTGOING_CAP) continue;

      // Only follow up once per 90min window (avoid spamming every 15-min cron tick)
      const jaEnviouNessaJanela = await prisma.crmMensagemWhatsapp.findFirst({
        where: {
          dealId: deal.id,
          direcao: "out",
          enviadaEm: { gte: new Date(now.getTime() - FOLLOWUP_MIN_MS) },
        },
      });
      if (jaEnviouNessaJanela) continue; // already sent a follow-up in this 90min window
      if (!await isHorarioComercial(deal.projetoId)) continue;

      const persona = deal.iaPersonaChave ?? "assistente";
      console.log(`[CronAgent] Follow-up [${persona}] — deal ${deal.id} (${Math.round(idadeMs / 60000)}min sem resposta, ${outsSinceLastIn + 1}/${MAX_FOLLOWUPS_CONSECUTIVOS}) → re-enviando pergunta`);
      await respondFromDealState(deal.projetoId, deal.id, deal.contato.whatsapp);
    } catch (err) {
      console.error(`[CronAgent] Erro follow-up deal ${deal.id}:`, err);
    }
  }

  let recuperados = 0;
  for (const deal of deals) {
    if (!deal.projetoId || !deal.contato?.whatsapp) continue;

    try {
      // Get last 2 messages for this deal
      const ultimas = await prisma.crmMensagemWhatsapp.findMany({
        where: { dealId: deal.id },
        orderBy: { enviadaEm: "desc" },
        take: 2,
      });

      if (!ultimas.length) continue;

      const ultima = ultimas[0];
      // Only act if last message is inbound ("in") and old enough
      if (ultima.direcao !== "in") continue;
      const idadeMs = now.getTime() - ultima.enviadaEm.getTime();
      if (idadeMs < limiteMs) continue;
      // Don't retry messages older than 4 hours (stale)
      if (idadeMs > 4 * 60 * 60 * 1000) continue;
      // Skip if gate step returned silence — waiting for human response, no LLM loop
      const gateStepSilenciado =
        ((deal.iaFlowStepData ?? {}) as Record<string, unknown>)._gate_silenciado === true;
      if (gateStepSilenciado) {
        console.log(`[CronAgent] Deal ${deal.id}: gate silenciado — aguardando resposta humana`);
        continue;
      }

      console.log(`[CronAgent] Mensagem perdida detectada — deal ${deal.id} (${Math.round(idadeMs / 60000)}min sem resposta) → recuperando`);
      await respondFromDealState(deal.projetoId, deal.id, deal.contato.whatsapp);
      recuperados++;
    } catch (err) {
      console.error(`[CronAgent] Erro ao recuperar deal ${deal.id}:`, err);
    }
  }

  if (recuperados > 0) {
    console.log(`[CronAgent] Recuperadas ${recuperados} mensagem(ns) perdida(s)`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Sprint 4 — Cron de handoffs atrasados (roda a cada 5 min via cron.ts)
// ──────────────────────────────────────────────────────────────────────────────

export async function processarHandoffsAtrasados(): Promise<void> {
  const now = new Date();

  const deals = await prisma.crmDeal.findMany({
    where: {
      iaPersonaChave: "advogado",
      iaAtiva: true,
      status: "aberto",
      pipelineId: "pipeline_c3_comercial", // FUNIL CARRETEIROS 3.0 — IA proativa só aqui
      projetoId: { not: null },
    },
    include: {
      contato: true,
      mensagens: {
        orderBy: { enviadaEm: "desc" },
        take: 1,
      },
    },
  });

  for (const deal of deals) {
    if (!deal.projetoId || !deal.contato?.whatsapp) continue;

    try {
      const ultimaMsg = deal.mensagens[0];
      if (!ultimaMsg) continue;

      const minutosDesde = (now.getTime() - ultimaMsg.enviadaEm.getTime()) / 60000;
      const personaTrocadaSemIntro =
        ultimaMsg.direcao === "out" &&
        ultimaMsg.personaChave === "assistente" &&
        minutosDesde >= 10;

      if (!personaTrocadaSemIntro) continue;

      // Alerta crítico se passou de 1h
      if (minutosDesde >= 60) {
        console.warn(`[CronAgent] HANDOFF CRÍTICO — deal ${deal.id} travado há ${Math.floor(minutosDesde)}min sem intro Daniela`);
      }

      console.log(`[CronAgent] Handoff atrasado — deal ${deal.id} (${Math.floor(minutosDesde)}min) → enviando intro Daniela`);
      await enviarMensagemProativa(
        deal.projetoId!,
        deal.id,
        deal.contato.whatsapp,
        "primeira_mensagem",
        deal.contato.nome ?? ""
      );
    } catch (err) {
      console.error(`[CronAgent] Erro ao recuperar handoff deal ${deal.id}:`, err);
    }
  }
}
