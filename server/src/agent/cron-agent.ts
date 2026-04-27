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

export async function processarTimeoutsAgente(): Promise<void> {
  const now = new Date();

  // Load all active deals with IA enabled and open status
  const deals = await prisma.crmDeal.findMany({
    where: {
      iaAtiva: true,
      status: "aberto",
      projetoId: { not: null },
      iaStageChave: { not: null },
    },
    include: { contato: true },
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
      // ── Closer: verificar tentativas esgotadas ──────────────────────────────
      if (stageChave === "com_closer") {
        if (deal.closerTentativas >= 2) {
          await transitionDeal(projetoId, deal.id, "closer_tentativas_esgotadas");
          console.log(`[CronAgent] Deal ${deal.id}: closer esgotado → sem_resposta_closer`);
        } else if (horasSemContato >= 48) {
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
        if (novaDeal?.iaStageChave === "com_closer" && novaDeal.closerTentativas === 0) {
          await enviarMensagemProativa(projetoId, deal.id, phone, "closer_tentativa_1", deal.contato?.nome ?? "");
          await prisma.crmDeal.update({
            where: { id: deal.id },
            data: { closerTentativas: 1, ultimoContatoEm: now },
          });
          console.log(`[CronAgent] Deal ${deal.id}: primeiro contato do Closer enviado`);
        }
        break;
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
  const STAGES_HUMANOS = ["com_advogado", "reuniao_agendada", "fechado", "sem_resposta_closer", "lead_sem_resposta"];

  const deals = await prisma.crmDeal.findMany({
    where: {
      iaAtiva: true,
      status: "aberto",
      projetoId: { not: null },
      iaStageChave: { not: null, notIn: STAGES_HUMANOS },
    },
    include: { contato: true },
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
      if (!lastOut || lastOut.personaChave !== "assistente") continue;

      const lastMsg = await prisma.crmMensagemWhatsapp.findFirst({
        where: { dealId: deal.id },
        orderBy: { enviadaEm: "desc" },
      });
      const idadeMs = now.getTime() - (lastMsg?.enviadaEm ?? deal.criadoEm).getTime();
      if (idadeMs < 5 * 60 * 1000) continue; // menos de 5 min — aguardar setTimeout
      // No upper bound: if last out is still Ana and deal is open, Daniela never introduced herself — always send

      console.log(`[CronAgent] Intro pendente — deal ${deal.id} (persona ${deal.iaPersonaChave}) → enviando`);
      await enviarMensagemProativa(deal.projetoId, deal.id, deal.contato.whatsapp, "primeira_mensagem", deal.contato.nome ?? "");
    } catch (err) {
      console.error(`[CronAgent] Erro intro pendente deal ${deal.id}:`, err);
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
