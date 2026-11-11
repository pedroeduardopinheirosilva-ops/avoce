/**
 * Reserva de AgendaSlot para reuniões criadas fora do fluxo de slots.
 *
 * Motivo: `reunioes.criarAgendada` (agendamento manual pela SDR humana) criava o AgendaSlot
 * apenas quando conseguia derivar um `emitenteId` do projeto — e nunca preenchia `projetoId`.
 * Resultado: a reunião existia, mas não aparecia na agenda de disponibilidade da advogada
 * (caso Douglas 8385). O horário seguia "livre" e podia ser oferecido de novo a outro lead.
 */

import { prisma } from "../db.js";

const DURACAO_PADRAO_MS = 60 * 60 * 1000;

/**
 * Resolve o emitente a usar no slot, tentando na ordem: o informado → o do projeto →
 * o da empresa do contexto → qualquer um. Devolve null só quando não existe emitente algum.
 */
export async function resolverEmitenteId(opts: {
  emitenteId?: string | null;
  empresaIdProjeto?: string | null;
  empresaIdContexto?: string | null;
}): Promise<string | null> {
  if (opts.emitenteId) return opts.emitenteId;

  for (const empresaId of [opts.empresaIdProjeto, opts.empresaIdContexto]) {
    if (!empresaId) continue;
    const e = await prisma.empresaEmitente.findFirst({ where: { empresaId }, select: { id: true } });
    if (e) return e.id;
  }

  const qualquer = await prisma.empresaEmitente.findFirst({ select: { id: true } });
  return qualquer?.id ?? null;
}

/**
 * Ocupa a agenda para uma reunião.
 *
 * Reaproveita um slot livre que já cubra o horário (o normal quando a advogada publicou a
 * disponibilidade); se não houver, cria um slot já reservado, para o horário ficar visivelmente
 * ocupado em vez de continuar sendo oferecido.
 *
 * Devolve o id do slot, ou null quando não há emitente cadastrado (aí não há agenda para ocupar).
 */
export async function reservarOuCriarSlot(opts: {
  emitenteId: string | null;
  usuarioId?: string | null;
  projetoId?: string | null;
  dealId: string;
  inicio: Date;
  fim?: Date;
  titulo?: string | null;
  reuniaoId?: string | null;
}): Promise<string | null> {
  if (!opts.emitenteId) {
    console.warn(`[AgendaSlot] deal=${opts.dealId} — sem emitente; reunião criada sem ocupar agenda`);
    return null;
  }

  const inicio = opts.inicio;
  const fim = opts.fim ?? new Date(inicio.getTime() + DURACAO_PADRAO_MS);

  // Slot já publicado que cubra o horário (o caso normal: a advogada abriu a disponibilidade).
  const existente = await prisma.agendaSlot.findFirst({
    where: {
      emitenteId: opts.emitenteId,
      disponivel: true,
      inicio: { lte: inicio },
      fim: { gt: inicio },
      ...(opts.usuarioId ? { usuarioId: opts.usuarioId } : {}),
    },
    orderBy: { inicio: "desc" },
  });

  if (existente) {
    await prisma.agendaSlot.update({
      where: { id: existente.id },
      data: {
        disponivel: false,
        reservadoPara: opts.dealId,
        ...(opts.reuniaoId ? { reuniaoId: opts.reuniaoId } : {}),
        ...(existente.projetoId ? {} : { projetoId: opts.projetoId ?? undefined }),
      },
    });
    return existente.id;
  }

  const criado = await prisma.agendaSlot.create({
    data: {
      emitenteId: opts.emitenteId,
      usuarioId: opts.usuarioId ?? undefined,
      // Sem projetoId o slot some da agenda quando a tela filtra por projeto.
      projetoId: opts.projetoId ?? undefined,
      titulo: opts.titulo ?? undefined,
      inicio,
      fim,
      disponivel: false,
      reservadoPara: opts.dealId,
      reuniaoId: opts.reuniaoId ?? undefined,
    },
  });
  return criado.id;
}

/** Libera o slot de uma reunião cancelada, devolvendo o horário à agenda. */
export async function liberarSlotDaReuniao(reuniaoId: string): Promise<void> {
  await prisma.agendaSlot.updateMany({
    where: { reuniaoId },
    data: { disponivel: true, reservadoPara: null, reuniaoId: null },
  });
}
