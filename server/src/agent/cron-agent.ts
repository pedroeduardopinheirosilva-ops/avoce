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
import { transitionDeal, enviarMensagemProativa, getEvolutionConfig } from "./stage-engine.js";

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
