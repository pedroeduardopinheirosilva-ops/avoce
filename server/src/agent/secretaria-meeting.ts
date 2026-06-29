/**
 * Secretaria Meeting — creates a SessaoReuniao when the secretaria persona
 * collects the lead's preferred meeting time, sends the guest link, and
 * reserves the AgendaSlot if one was matched.
 */

import { prisma } from "../db.js";
import { getEvolutionConfig } from "./message-handler.js";
import type { SlotDisponivel } from "./secretaria-agenda.js";

interface CriarReuniaoResult {
  sessaoId: string;
  linkConvidado: string;
}

export async function criarReuniaoAgente(
  projetoId: string,
  dealId: string,
  contato: { id: string; nome: string; whatsapp: string },
  horarioTexto: string,
  slot?: SlotDisponivel,
): Promise<CriarReuniaoResult | null> {
  try {
    const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";

    const roomName = `avoce-${Math.random().toString(36).slice(2, 10)}`;
    const titulo = `Reunião com ${contato.nome}`;

    // Resolve empresaId so the meeting appears in the Reuniões list (filtered by empresaId)
    const projeto = await prisma.iaProjeto.findUnique({ where: { id: projetoId }, select: { empresaId: true } });
    const empresaId = projeto?.empresaId ?? null;
    const emitente = empresaId
      ? await prisma.empresaEmitente.findFirst({ where: { empresaId }, select: { id: true } })
      : null;

    const sessao = await prisma.sessaoReuniao.create({
      data: {
        titulo,
        dealId,
        contatoId:   contato.id,
        empresaId:   empresaId ?? undefined,
        emitenteId:  emitente?.id ?? undefined,
        jitsiRoomName: roomName,
        agendadaPara: slot?.inicio ?? null,
      },
    });

    // Reserve the matched agenda slot
    if (slot) {
      const { reservarSlot } = await import("./secretaria-agenda.js");
      await reservarSlot(slot.id, dealId, sessao.id);
    }

    const linkConvidado = `${APP_BASE_URL}/sala/${(sessao as any).tokenConvidado}`;

    const horarioLabel = slot ? slot.label : horarioTexto;

    // Save note with full details
    await prisma.crmNota.create({
      data: {
        dealId,
        conteudo: `[IA] Reunião criada pela Ana | Horário: "${horarioLabel}"${slot ? ` | Slot ID: ${slot.id}` : ""} | Link convidado: ${linkConvidado}`,
      },
    }).catch(() => {});

    // Send guest link to lead
    const evo = await getEvolutionConfig(projetoId);
    const confirmacaoCfg = await prisma.iaProjetoConfig.findFirst({
      where: { projetoId, chave: "secretaria.confirmacao_reuniao" },
    });
    if (evo && confirmacaoCfg?.valor) {
      const { sendText } = await import("../services/evolution.js");
      const personaCfg = await (prisma as any).iaPersona.findFirst({
        where: { projetoId, chave: "secretaria" },
        select: { nomeExibicao: true },
      });
      const personaNome = (personaCfg?.nomeExibicao as string | undefined) ?? "secretaria";
      const textoLead = confirmacaoCfg.valor
        .replace(/\{\{horario\}\}/gi, horarioLabel)
        .replace(/\{\{link\}\}/gi, linkConvidado);
      await sendText(evo, contato.whatsapp, textoLead).catch(() => {});
      await prisma.crmMensagemWhatsapp.create({
        data: {
          dealId,
          contatoId: contato.id,
          direcao: "out",
          personaChave: "secretaria",
          remetente: personaNome,
          tipo: "text",
          conteudo: textoLead,
        },
      }).catch(() => {});

      // Notify advogada via WhatsApp if configured
      const advWhatsappCfg = await prisma.iaProjetoConfig.findFirst({
        where: { projetoId, chave: "secretaria.advogada_whatsapp" },
      });
      if (advWhatsappCfg?.valor) {
        const JITSI_HOST = process.env.JITSI_HOST ?? "meet.capium.com.br";
        const linkAdv = `https://${JITSI_HOST}/${encodeURIComponent(roomName)}`;
        const textoAdv =
          `📋 Nova reunião agendada!\n` +
          `*${contato.nome}* — ${horarioLabel}\n` +
          `Telefone: ${contato.whatsapp}\n\n` +
          `Seu link (moderador):\n${linkAdv}\n\n` +
          `Link do cliente:\n${linkConvidado}`;
        await sendText(evo, advWhatsappCfg.valor, textoAdv).catch(() => {});
      }
    }

    // Briefing para o SDR humano — reunião marcada é o momento de ligar para garantir presença.
    try {
      const { buildLeadBriefing } = await import("./lead-briefing.js");
      const { dispararNotificacoes } = await import("./message-handler.js");
      const briefing = await buildLeadBriefing(dealId, {
        titulo: "🗓 REUNIÃO AGENDADA",
        acao: `Ligar antes da reunião (${horarioLabel}) para confirmar presença e quebrar objeções`,
      });
      dispararNotificacoes(projetoId, "reuniao_agendada", {
        nome: contato.nome, telefone: contato.whatsapp, horario: horarioLabel,
        link: linkConvidado, briefing, dealId,
      }).catch(() => {});
    } catch { /* notificação é best-effort */ }

    console.log(`[SecretariaMeeting] dealId=${dealId} reunião criada sessaoId=${sessao.id} slot=${slot?.id ?? "sem slot"}`);
    return { sessaoId: sessao.id, linkConvidado };
  } catch (e: any) {
    console.error(`[SecretariaMeeting] Erro ao criar reunião: ${e.message}`);
    return null;
  }
}
