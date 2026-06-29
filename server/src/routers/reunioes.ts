import { z }               from "zod";
import { router, authProc, publicProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { TRPCError }        from "@trpc/server";
import jwt                  from "jsonwebtoken";
import fs                   from "node:fs/promises";
import path                 from "node:path";

const UPLOADS_BASE = process.env.UPLOADS_DIR ?? "/opt/avoce/uploads";

const JITSI_HOST       = process.env.JITSI_HOST       ?? "meet.capium.com.br";
const JITSI_APP_ID     = process.env.JITSI_APP_ID     ?? "psadocs";
const JITSI_APP_SECRET = process.env.JITSI_APP_SECRET ?? "";
const APP_BASE_URL     = process.env.APP_BASE_URL     ?? "https://avoce.capium.com.br";

function gerarRoomName(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "avoce-";
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function gerarJitsiJwt(roomName: string, userName: string, moderator = true): string | null {
  if (!JITSI_APP_SECRET) return null;
  const payload = {
    iss: JITSI_APP_ID,
    aud: JITSI_APP_ID,
    sub: JITSI_HOST,
    room: roomName,
    exp: Math.floor(Date.now() / 1000) + 4 * 60 * 60,
    nbf: Math.floor(Date.now() / 1000) - 10,
    context: {
      user: { name: userName, moderator },
    },
  };
  return jwt.sign(payload, JITSI_APP_SECRET, { algorithm: "HS256" });
}

export const reunioesRouter = router({

  criar: authProc
    .input(z.object({
      titulo:       z.string(),
      dealId:       z.string().optional(),
      contatoId:    z.string().optional(),
      emitenteId:   z.string().optional(),
      agendadaPara: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const roomName = gerarRoomName();
      return prisma.sessaoReuniao.create({
        data: {
          titulo:       input.titulo,
          dealId:       input.dealId,
          contatoId:    input.contatoId,
          emitenteId:   input.emitenteId,
          empresaId:    ctx.empresaId ?? undefined,
          criadoPor:    ctx.userId ?? undefined,
          jitsiRoomName: roomName,
          agendadaPara: input.agendadaPara ? new Date(input.agendadaPara) : undefined,
        },
      });
    }),

  listar: authProc
    .input(z.object({
      dealId:     z.string().optional(),
      emitenteId: z.string().optional(),
      limit:      z.number().optional(),
    }))
    .query(async ({ input, ctx }) => {
      return prisma.sessaoReuniao.findMany({
        where: {
          ...(ctx.empresaId ? { empresaId: ctx.empresaId } : {}),
          ...(input.dealId     ? { dealId:     input.dealId }     : {}),
          ...(input.emitenteId ? { emitenteId: input.emitenteId } : {}),
        },
        include: {
          deal:    { select: { titulo: true } },
          contato: { select: { nome: true, whatsapp: true } },
        },
        orderBy: { criadaEm: "desc" },
        take: input.limit ?? 100,
      });
    }),

  get: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return prisma.sessaoReuniao.findUnique({
        where: { id: input.id },
        include: {
          deal:    { select: { titulo: true } },
          contato: { select: { nome: true, whatsapp: true } },
        },
      });
    }),

  iniciar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.sessaoReuniao.update({
        where: { id: input.id },
        data: { status: "em_andamento", iniciadaEm: new Date() },
      });
    }),

  encerrar: authProc
    .input(z.object({ id: z.string(), notas: z.string().optional() }))
    .mutation(async ({ input }) => {
      const sessao = await prisma.sessaoReuniao.findUnique({ where: { id: input.id } });
      const duracao = sessao?.iniciadaEm
        ? Math.floor((Date.now() - sessao.iniciadaEm.getTime()) / 1000)
        : undefined;
      const updated = await prisma.sessaoReuniao.update({
        where: { id: input.id },
        data: {
          status:      "encerrada",
          encerradaEm: new Date(),
          duracao,
          ...(input.notas !== undefined ? { notas: input.notas } : {}),
        },
      });

      // Auto-save transcription as .txt in deal document folder
      const transcricao = sessao?.transcricao?.trim();
      if (transcricao && sessao?.dealId) {
        try {
          const dir = path.join(UPLOADS_BASE, "deals", sessao.dealId);
          await fs.mkdir(dir, { recursive: true });
          const ts       = Date.now();
          const slug     = sessao.jitsiRoomName.replace(/[^a-z0-9]/gi, "_");
          const filename = `${ts}_transcricao_${slug}.txt`;
          const filePath = path.join(dir, filename);
          const dataFmt  = new Date(sessao.encerradaEm ?? sessao.criadaEm).toLocaleString("pt-BR");
          const conteudo = `TRANSCRIÇÃO DA REUNIÃO\n${sessao.titulo}\nData: ${dataFmt}\n${"─".repeat(60)}\n\n${transcricao}`;
          await fs.writeFile(filePath, conteudo, "utf8");
          await prisma.dealAnexo.create({
            data: {
              dealId:        sessao.dealId,
              nomeArquivo:   filename,
              mimetype:      "text/plain",
              tamanho:       Buffer.byteLength(conteudo, "utf8"),
              caminhoArquivo: filePath,
              ocrTexto:      transcricao.slice(0, 500),
              tipoDocumento: "TRANSCRICAO",
            },
          });
          console.log(`[Reunião] Transcrição salva: dealId=${sessao.dealId} arquivo=${filename}`);
        } catch (e: any) {
          console.warn(`[Reunião] Falha ao salvar transcrição: ${e.message}`);
        }
      }

      return updated;
    }),

  cancelar: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.sessaoReuniao.update({ where: { id: input.id }, data: { status: "cancelada" } });
    }),

  getJitsiUrl: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const sessao = await prisma.sessaoReuniao.findUnique({ where: { id: input.id } });
      if (!sessao) throw new TRPCError({ code: "NOT_FOUND" });

      let operatorName = "Operador";
      if (ctx.userId) {
        const u = await prisma.usuario.findUnique({ where: { id: ctx.userId }, select: { nome: true } });
        operatorName = u?.nome ?? "Operador";
      }

      const token = gerarJitsiJwt(sessao.jitsiRoomName, operatorName, true);
      const urlBase = `https://${JITSI_HOST}/${encodeURIComponent(sessao.jitsiRoomName)}`;
      const url = token ? `${urlBase}?jwt=${token}` : urlBase;
      const linkConvidado = `${APP_BASE_URL}/sala/${sessao.tokenConvidado}`;

      return { url, linkConvidado, roomName: sessao.jitsiRoomName, jitsiHost: JITSI_HOST };
    }),

  updateNotas: authProc
    .input(z.object({ id: z.string(), notas: z.string() }))
    .mutation(async ({ input }) => {
      return prisma.sessaoReuniao.update({ where: { id: input.id }, data: { notas: input.notas } });
    }),

  addTranscricaoChunk: authProc
    .input(z.object({ id: z.string(), chunk: z.string() }))
    .mutation(async ({ input }) => {
      const sessao = await prisma.sessaoReuniao.findUnique({ where: { id: input.id }, select: { transcricao: true } });
      const atual = sessao?.transcricao ?? "";
      return prisma.sessaoReuniao.update({
        where: { id: input.id },
        data: { transcricao: atual + (atual ? "\n" : "") + input.chunk },
      });
    }),

  // Cria reunião instantânea ligada a um deal e envia link por WhatsApp
  criarInstantanea: authProc
    .input(z.object({
      dealId:              z.string(),
      destinatariosExtras: z.array(z.string()).optional(), // números WhatsApp adicionais
    }))
    .mutation(async ({ input, ctx }) => {
      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: {
          contato: { select: { id: true, nome: true, whatsapp: true } },
        },
      });
      if (!deal) throw new TRPCError({ code: "NOT_FOUND" });

      const projetoId = (deal as any).projetoId as string | null ?? null;

      const roomName = gerarRoomName();
      const titulo   = `Reunião — ${deal.contato?.nome ?? deal.titulo}`;
      const sessao   = await prisma.sessaoReuniao.create({
        data: {
          titulo,
          dealId:       deal.id,
          contatoId:    deal.contato?.id,
          empresaId:    ctx.empresaId ?? undefined,
          criadoPor:    ctx.userId ?? undefined,
          jitsiRoomName: roomName,
        },
      });

      // Lookup operator details
      let operatorName = "Operador";
      let operatorWa: string | null = null;
      if (ctx.userId) {
        const u = await prisma.usuario.findUnique({ where: { id: ctx.userId }, select: { nome: true, whatsapp: true } });
        operatorName = u?.nome ?? "Operador";
        operatorWa   = u?.whatsapp ?? null;
      }
      const token    = gerarJitsiJwt(roomName, operatorName, true);
      const jitsiUrl = token
        ? `https://${JITSI_HOST}/${encodeURIComponent(roomName)}?jwt=${token}`
        : `https://${JITSI_HOST}/${encodeURIComponent(roomName)}`;
      const linkConvidado = `${APP_BASE_URL}/sala/${(sessao as any).tokenConvidado}`;

      if (projetoId) {
        try {
          const { getEvolutionConfig, sendHumanized } = await import("../agent/message-handler.js");
          const evo = await getEvolutionConfig(projetoId);
          if (evo) {
            // 1. Send to deal contact
            if (deal.contato?.whatsapp) {
              const nome  = deal.contato.nome ?? "cliente";
              const texto = `Olá, ${nome}! Segue o link de acesso à videochamada:\n\n${linkConvidado}\n\nAté logo!`;
              await sendHumanized(evo, deal.contato.whatsapp, texto, 0);
              await prisma.crmMensagemWhatsapp.create({
                data: {
                  dealId: deal.id,
                  contatoId: deal.contato.id,
                  direcao: "out",
                  personaChave: "advogado",
                  remetente: "Sistema",
                  tipo: "text",
                  conteudo: texto,
                },
              });
            }

            // 2. Send moderator link to the operator's WhatsApp
            if (operatorWa) {
              const textoAdv = `📹 Reunião iniciada!\n*${titulo}*\n\nSeu link (moderador):\n${jitsiUrl}\n\nLink do cliente:\n${linkConvidado}`;
              await sendHumanized(evo, operatorWa, textoAdv, 0).catch(() => {});
            }

            // 3. Send to extra recipients
            for (const dest of (input.destinatariosExtras ?? [])) {
              if (dest.trim()) {
                const textoExtra = `📹 Reunião: *${titulo}*\n\nLink de acesso:\n${jitsiUrl}`;
                await sendHumanized(evo, dest.trim(), textoExtra, 0).catch(() => {});
              }
            }
          }
        } catch (err) {
          console.warn("[criarInstantanea] Falha ao enviar WhatsApp:", err);
        }
      }

      return { sessaoId: sessao.id, jitsiUrl, linkConvidado, titulo };
    }),

  // Lista usuários da empresa para o dropdown de participante
  listarUsuarios: authProc
    .query(async ({ ctx }) => {
      return prisma.usuario.findMany({
        where: ctx.empresaId ? { empresaId: ctx.empresaId } : undefined,
        select: { id: true, nome: true, email: true, whatsapp: true },
        orderBy: { nome: "asc" },
      });
    }),

  // Cria reunião agendada a partir de um deal existente (SDR humana)
  // Reutiliza criarReuniaoAgente → envia confirmação + notifica advogada via WhatsApp
  // O cron enviarLembretesReuniao assume automaticamente (48h, 24h, 12h, 6h, 3h, 1h)
  criarAgendada: authProc
    .input(z.object({
      dealId:       z.string(),
      usuarioId:    z.string(),
      agendadaPara: z.string(),
    }))
    .mutation(async ({ input }) => {
      const agendadaPara = new Date(input.agendadaPara);

      const deal = await prisma.crmDeal.findUnique({
        where: { id: input.dealId },
        include: { contato: { select: { id: true, nome: true, whatsapp: true } } },
      });
      if (!deal) throw new TRPCError({ code: "NOT_FOUND" });

      const projetoId = (deal as any).projetoId as string | null;
      const contato   = deal.contato;

      const projeto = projetoId
        ? await prisma.iaProjeto.findUnique({
            where: { id: projetoId },
            select: { empresaId: true, pipelineId: true },
          })
        : null;

      const emitenteId = projeto?.empresaId
        ? (await prisma.empresaEmitente.findFirst({
            where: { empresaId: projeto.empresaId },
            select: { id: true },
          }))?.id ?? null
        : null;

      // Formata label no mesmo padrão dos AgendaSlots gerados pela secretária
      const tz        = "America/Sao_Paulo";
      const weekday   = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long" }).format(agendadaPara);
      const diaMes    = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(agendadaPara);
      const horaFmt   = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(agendadaPara);
      const horarioLabel = `${weekday.charAt(0).toUpperCase() + weekday.slice(1)} (${diaMes}) às ${horaFmt}`;

      // Cria AgendaSlot para bloquear a agenda do usuário participante
      let slotId: string | null = null;
      if (emitenteId) {
        const agendaSlot = await (prisma.agendaSlot as any).create({
          data: {
            emitenteId,
            usuarioId:    input.usuarioId,
            inicio:       agendadaPara,
            fim:          new Date(agendadaPara.getTime() + 60 * 60 * 1000),
            disponivel:   false,
            reservadoPara: input.dealId,
          },
        });
        slotId = agendaSlot.id as string;
      }

      let sessaoId: string;
      let linkConvidado: string;

      if (projetoId && contato?.whatsapp) {
        // Fluxo completo SDR: envia confirmação ao cliente + notifica advogada
        const { criarReuniaoAgente } = await import("../agent/secretaria-meeting.js");
        const slotObj = slotId
          ? { id: slotId, inicio: agendadaPara, fim: new Date(agendadaPara.getTime() + 60 * 60 * 1000), label: horarioLabel }
          : undefined;
        const reuniao = await criarReuniaoAgente(
          projetoId,
          input.dealId,
          { id: contato.id, nome: contato.nome ?? "Cliente", whatsapp: contato.whatsapp },
          horarioLabel,
          slotObj,
        );
        if (!reuniao) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Falha ao criar reunião" });
        sessaoId      = reuniao.sessaoId;
        linkConvidado = reuniao.linkConvidado;
      } else {
        // Fallback: cria SessaoReuniao diretamente sem WhatsApp
        const roomName = gerarRoomName();
        const titulo   = `Reunião com ${contato?.nome ?? deal.titulo}`;
        const sessao   = await prisma.sessaoReuniao.create({
          data: {
            titulo,
            dealId:       input.dealId,
            contatoId:    contato?.id,
            empresaId:    projeto?.empresaId ?? undefined,
            emitenteId:   emitenteId ?? undefined,
            criadoPor:    input.usuarioId,
            jitsiRoomName: roomName,
            agendadaPara,
          },
        });
        if (slotId) {
          await (prisma.agendaSlot as any).update({
            where: { id: slotId },
            data: { reuniaoId: sessao.id },
          });
        }
        sessaoId      = sessao.id;
        linkConvidado = `${APP_BASE_URL}/sala/${(sessao as any).tokenConvidado}`;
      }

      // Move deal para stage aguardando_reuniao do pipeline do projeto
      if (projeto?.pipelineId) {
        const stageAguardando = await prisma.crmStage.findFirst({
          where: { pipelineId: projeto.pipelineId, chave: "aguardando_reuniao" },
        });
        if (stageAguardando) {
          await prisma.crmDeal.update({
            where: { id: input.dealId },
            data: { stageId: stageAguardando.id, iaStageChave: "aguardando_reuniao" },
          });
        }
      }

      // Gera JWT Jitsi com o nome do usuário selecionado como participante
      const sessaoData = await prisma.sessaoReuniao.findUnique({
        where: { id: sessaoId },
        select: { jitsiRoomName: true },
      });
      const selectedUser = await prisma.usuario.findUnique({
        where: { id: input.usuarioId },
        select: { nome: true },
      });
      const jwtToken = sessaoData
        ? gerarJitsiJwt(sessaoData.jitsiRoomName, selectedUser?.nome ?? "Advogado", true)
        : null;
      const jitsiUrl = sessaoData
        ? jwtToken
          ? `https://${JITSI_HOST}/${encodeURIComponent(sessaoData.jitsiRoomName)}?jwt=${jwtToken}`
          : `https://${JITSI_HOST}/${encodeURIComponent(sessaoData.jitsiRoomName)}`
        : "";

      return {
        sessaoId,
        jitsiUrl,
        linkConvidado,
        titulo: `Reunião com ${contato?.nome ?? deal.titulo}`,
      };
    }),

  // Public — no auth — used by /sala/:token page
  getPublico: publicProc
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const sessao = await prisma.sessaoReuniao.findUnique({
        where: { tokenConvidado: input.token },
        select: { titulo: true, status: true, jitsiRoomName: true },
      });
      if (!sessao) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada" });
      if (sessao.status === "cancelada") throw new TRPCError({ code: "FORBIDDEN", message: "Esta reunião foi cancelada" });

      const urlBase = `https://${JITSI_HOST}/${encodeURIComponent(sessao.jitsiRoomName)}`;
      return { titulo: sessao.titulo, status: sessao.status, jitsiUrl: urlBase, jitsiHost: JITSI_HOST, roomName: sessao.jitsiRoomName };
    }),
});
