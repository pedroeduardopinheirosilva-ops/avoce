import { z }            from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }        from "../db.js";
import { TRPCError }     from "@trpc/server";

export const agendaRouter = router({

  listar: authProc
    .input(z.object({
      emitenteId:        z.string().optional(),
      usuarioId:         z.string().optional(),
      projetoId:         z.string().optional(),
      apenasDisponiveis: z.boolean().optional(),
      de:                z.string().optional(),
      ate:               z.string().optional(),
    }))
    .query(async ({ input, ctx }) => {
      const slots = await prisma.agendaSlot.findMany({
        where: {
          ...(input.emitenteId        ? { emitenteId: input.emitenteId } : {}),
          ...(input.usuarioId         ? { usuarioId:  input.usuarioId }  : {}),
          ...(input.projetoId         ? { projetoId:  input.projetoId }  : {}),
          ...(input.apenasDisponiveis ? { disponivel: true }             : {}),
          ...(input.de  ? { inicio: { gte: new Date(input.de)  } } : { inicio: { gte: new Date() } }),
          ...(input.ate ? { fim:    { lte: new Date(input.ate) } } : {}),
        },
        include: {
          usuario: { select: { id: true, nome: true } },
        },
        orderBy: { inicio: "asc" },
        take: 200,
      });

      const dealIds = [...new Set(slots.map(s => s.reservadoPara).filter(Boolean))] as string[];
      const deals = dealIds.length > 0
        ? await prisma.crmDeal.findMany({ where: { id: { in: dealIds } }, select: { id: true, titulo: true } })
        : [];
      const dealMap = Object.fromEntries(deals.map(d => [d.id, d.titulo]));

      return slots.map(s => ({
        ...s,
        dealTitulo: s.reservadoPara ? (dealMap[s.reservadoPara] ?? null) : null,
      }));
    }),

  criar: authProc
    .input(z.object({
      emitenteId: z.string(),
      usuarioId:  z.string().optional(),
      projetoId:  z.string().optional(),
      titulo:     z.string().optional(),
      inicio:     z.string(),
      fim:        z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      return prisma.agendaSlot.create({
        data: {
          emitenteId: input.emitenteId,
          usuarioId:  input.usuarioId ?? ctx.userId ?? undefined,
          projetoId:  input.projetoId,
          titulo:     input.titulo,
          inicio:     new Date(input.inicio),
          fim:        new Date(input.fim),
        },
      });
    }),

  criarLote: authProc
    .input(z.object({
      emitenteId: z.string(),
      usuarioId:  z.string().optional(),
      projetoId:  z.string().optional(),
      slots: z.array(z.object({
        inicio: z.string(),
        fim:    z.string(),
        titulo: z.string().optional(),
      })),
    }))
    .mutation(async ({ input, ctx }) => {
      return prisma.agendaSlot.createMany({
        data: input.slots.map(s => ({
          emitenteId: input.emitenteId,
          usuarioId:  input.usuarioId ?? ctx.userId ?? undefined,
          projetoId:  input.projetoId,
          inicio:     new Date(s.inicio),
          fim:        new Date(s.fim),
          titulo:     s.titulo,
        })),
        skipDuplicates: true,
      });
    }),

  deletar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const slot = await prisma.agendaSlot.findUnique({ where: { id: input.id } });
      if (!slot) throw new TRPCError({ code: "NOT_FOUND" });
      if (slot.reuniaoId) throw new TRPCError({ code: "FORBIDDEN", message: "Slot já reservado por cliente" });
      return prisma.agendaSlot.delete({ where: { id: input.id } });
    }),

  // Fecha slot manualmente (indisponível para SDR, mas mantém no histórico)
  fechar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const slot = await prisma.agendaSlot.findUnique({ where: { id: input.id } });
      if (!slot) throw new TRPCError({ code: "NOT_FOUND" });
      if (slot.reuniaoId) throw new TRPCError({ code: "FORBIDDEN", message: "Slot reservado por cliente — cancele a reunião para liberar" });
      return prisma.agendaSlot.update({ where: { id: input.id }, data: { disponivel: false } });
    }),

  // Reabre slot fechado manualmente
  reabrir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const slot = await prisma.agendaSlot.findUnique({ where: { id: input.id } });
      if (!slot) throw new TRPCError({ code: "NOT_FOUND" });
      if (slot.reuniaoId) throw new TRPCError({ code: "FORBIDDEN", message: "Slot reservado por cliente" });
      return prisma.agendaSlot.update({ where: { id: input.id }, data: { disponivel: true } });
    }),

  // Cria slots recorrentes para N semanas (mesmo padrão semanal)
  criarRecorrente: authProc
    .input(z.object({
      emitenteId:  z.string(),
      usuarioId:   z.string().optional(),
      projetoId:   z.string().optional(),
      diasSemana:  z.array(z.number().min(0).max(6)), // 0=dom…6=sab
      horarios:    z.array(z.object({ hora: z.string(), durMin: z.number() })),
      semanas:     z.number().min(1).max(52).default(4),
    }))
    .mutation(async ({ input, ctx }) => {
      const slots: Array<{ emitenteId: string; usuarioId?: string; projetoId?: string; inicio: Date; fim: Date }> = [];
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const fim = new Date(hoje.getTime() + input.semanas * 7 * 24 * 60 * 60 * 1000);

      let d = new Date(hoje.getTime() + 86400000); // começa amanhã
      while (d < fim) {
        if (input.diasSemana.includes(d.getDay())) {
          for (const h of input.horarios) {
            const [hh, mm] = h.hora.split(":").map(Number);
            const inicio = new Date(d);
            inicio.setHours(hh, mm, 0, 0);
            const fimSlot = new Date(inicio.getTime() + h.durMin * 60000);
            slots.push({
              emitenteId: input.emitenteId,
              usuarioId:  input.usuarioId ?? ctx.userId ?? undefined,
              projetoId:  input.projetoId,
              inicio,
              fim: fimSlot,
            });
          }
        }
        d = new Date(d.getTime() + 86400000);
      }

      if (!slots.length) return { count: 0 };
      const result = await prisma.agendaSlot.createMany({ data: slots, skipDuplicates: true });
      return { count: result.count };
    }),

  // Retorna os próximos N slots disponíveis formatados para WhatsApp
  getProximosDisponiveis: authProc
    .input(z.object({
      emitenteId: z.string(),
      usuarioId:  z.string().optional(),
      projetoId:  z.string().optional(),
      quantidade: z.number().default(3),
    }))
    .query(async ({ input }) => {
      const slots = await prisma.agendaSlot.findMany({
        where: {
          emitenteId: input.emitenteId,
          ...(input.usuarioId ? { usuarioId: input.usuarioId } : {}),
          ...(input.projetoId ? { projetoId: input.projetoId } : {}),
          disponivel: true,
          inicio: { gte: new Date() },
        },
        orderBy: { inicio: "asc" },
        take: input.quantidade,
      });
      return slots.map(s => ({
        id:     s.id,
        label:  formatSlotLabel(s.inicio, s.fim),
        inicio: s.inicio.toISOString(),
        fim:    s.fim.toISOString(),
      }));
    }),

  // Reserva um slot e cria SessaoReuniao → retorna link do convidado
  reservar: authProc
    .input(z.object({
      slotId:      z.string(),
      dealId:      z.string(),
      contatoId:   z.string().optional(),
      emitenteId:  z.string().optional(),
      nomeCliente: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const slot = await prisma.agendaSlot.findUnique({ where: { id: input.slotId } });
      if (!slot)            throw new TRPCError({ code: "NOT_FOUND",  message: "Slot não encontrado" });
      if (!slot.disponivel) throw new TRPCError({ code: "CONFLICT",  message: "Slot já reservado" });

      const roomName = `avoce-${Math.random().toString(36).slice(2, 10)}`;

      const sessao = await prisma.sessaoReuniao.create({
        data: {
          titulo:        `Reunião — ${input.nomeCliente}`,
          dealId:        input.dealId,
          contatoId:     input.contatoId,
          emitenteId:    input.emitenteId ?? slot.emitenteId,
          empresaId:     ctx.empresaId ?? undefined,
          criadoPor:     slot.usuarioId ?? ctx.userId ?? undefined,
          jitsiRoomName: roomName,
          agendadaPara:  slot.inicio,
        },
      });

      await prisma.agendaSlot.update({
        where: { id: input.slotId },
        data: {
          disponivel:    false,
          reservadoPara: input.dealId,
          reuniaoId:     sessao.id,
        },
      });

      const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
      const linkConvidado = `${APP_BASE_URL}/sala/${(sessao as any).tokenConvidado}`;

      // Send meeting link to the slot owner (lawyer's WhatsApp) if available
      if (slot.usuarioId) {
        try {
          const usuario = await prisma.usuario.findUnique({ where: { id: slot.usuarioId }, select: { whatsapp: true, nome: true } });
          if (usuario?.whatsapp) {
            // Find projetoId from deal to get Evolution config
            const deal = await prisma.crmDeal.findUnique({ where: { id: input.dealId }, select: { projetoId: true } });
            if (deal?.projetoId) {
              const { getEvolutionConfig, sendHumanized } = await import("../agent/message-handler.js");
              const evo = await getEvolutionConfig(deal.projetoId);
              if (evo) {
                const linkAdv = `https://${process.env.JITSI_HOST ?? "meet.capium.com.br"}/${encodeURIComponent(roomName)}`;
                const texto = `📹 Reunião agendada!\n*${input.nomeCliente}* — ${formatSlotLabel(slot.inicio, slot.fim)}\n\nLink de entrada:\n${linkAdv}`;
                await sendHumanized(evo, usuario.whatsapp, texto, 0).catch(() => {});
              }
            }
          }
        } catch { /* best-effort */ }
      }

      return { sessao, linkConvidado, label: formatSlotLabel(slot.inicio, slot.fim) };
    }),
});

function formatSlotLabel(inicio: Date, fim: Date): string {
  const dias = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const dia  = dias[inicio.getDay()];
  const data = inicio.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const hi   = inicio.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const hf   = fim.toLocaleTimeString("pt-BR",    { hour: "2-digit", minute: "2-digit" });
  return `${dia}, ${data} — ${hi} às ${hf}`;
}
