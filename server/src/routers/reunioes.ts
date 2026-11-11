import { z }               from "zod";
import { router, authProc, publicProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { resolverEmitenteId, reservarOuCriarSlot, liberarSlotDaReuniao } from "../lib/agenda-slot.js";
import { TRPCError }        from "@trpc/server";
import { whereEmpresa }     from "./tenant-utils.js";
import {
  MODALIDADES, RESULTADOS_REUNIAO, agendarReuniao, atualizarReuniao, cancelarReuniao, reunioesDoLead, agendaDoPeriodo,
  registrarResultadoReuniao,
} from "../lib/reuniao-agenda.js";
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

async function resolverProjetoId(dealId?: string | null): Promise<string | null> {
  if (dealId) {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: { projetoId: true } as any });
    if ((deal as any)?.projetoId) return (deal as any).projetoId;
  }
  const proj = await prisma.iaProjeto.findFirst({ select: { id: true } });
  return proj?.id ?? null;
}

function formatarChunks(chunks: { speakerRole: string; speakerNome: string | null; conteudo: string }[]): string {
  return chunks
    .map(c => `${c.speakerNome ?? (c.speakerRole === "convidado" ? "Cliente" : "Operador")}: ${c.conteudo}`)
    .join("\n");
}

const COPILOTO_SYSTEM = `Você é um copiloto jurídico assistindo um advogado DURANTE uma reunião com cliente, em tempo real.
Com base no trecho de transcrição fornecido, retorne de 2 a 4 sugestões CURTAS e acionáveis, uma por linha, iniciadas por "• ".
Tipos de sugestão: pergunta importante ainda não feita, documento a solicitar, ponto de atenção jurídico, esclarecimento a pedir.
Não repita sugestões óbvias já cobertas na conversa. Responda APENAS as sugestões, sem preâmbulo.`;

const RELATORIO_SYSTEM = `Você é assistente jurídico. A partir da transcrição de uma reunião entre advogado e cliente, redija um RELATÓRIO DA REUNIÃO em português, formato markdown, com as seções:
## Resumo
## Dados relevantes do caso
## Documentos e pendências
## Próximos passos
Seja objetivo e fiel à transcrição — não invente fatos. Se a transcrição for curta ou inconclusiva, diga isso no resumo.`;

// Gera o relatório IA pós-reunião (fire-and-forget no encerrar)
async function gerarRelatorioReuniao(sessaoId: string): Promise<void> {
  const sessao = await prisma.sessaoReuniao.findUnique({
    where: { id: sessaoId },
    select: { id: true, dealId: true, titulo: true, transcricao: true },
  });
  if (!sessao?.transcricao || sessao.transcricao.length < 200) return;

  const projetoId = await resolverProjetoId(sessao.dealId);
  if (!projetoId) return;

  const { callLlm } = await import("../agent/llm.js");
  const res = await callLlm({
    projetoId,
    dealId: sessao.dealId ?? undefined,
    systemPrompt: RELATORIO_SYSTEM,
    // maxTokens alto: DeepSeek v4 é modelo de raciocínio e consome budget "pensando"
    messages: [{ role: "user", content: sessao.transcricao.slice(0, 60_000) }],
    maxTokens: 4096,
    stageChave: "relatorio_reuniao",
  });
  const relatorio = res.content?.trim();
  if (!relatorio) return;

  await prisma.sessaoReuniao.update({ where: { id: sessaoId }, data: { resumoIa: relatorio } });
  if (sessao.dealId) {
    await prisma.crmNota.create({
      data: { dealId: sessao.dealId, conteudo: `📋 Relatório IA — ${sessao.titulo}\n\n${relatorio}` },
    }).catch(() => {});
  }
  console.log(`[Reunião] Relatório IA gerado sessaoId=${sessaoId} chars=${relatorio.length}`);
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

      // Monta a transcrição final a partir dos chunks rotulados: "[MM:SS] Nome: fala"
      const chunks = await prisma.reuniaoTranscricaoChunk.findMany({
        where: { sessaoId: input.id },
        orderBy: { criadaEm: "asc" },
      });
      let transcricaoFinal = sessao?.transcricao ?? null; // legado (sessões antigas sem chunks)
      if (chunks.length > 0) {
        const base = (sessao?.iniciadaEm ?? chunks[0].criadaEm).getTime();
        const mmss = (d: Date) => {
          const s = Math.max(0, Math.floor((d.getTime() - base) / 1000));
          return `[${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
        };
        transcricaoFinal = chunks
          .map(c => `${mmss(c.criadaEm)} ${c.speakerNome ?? (c.speakerRole === "convidado" ? "Cliente" : "Operador")}: ${c.conteudo}`)
          .join("\n");
      }

      const updated = await prisma.sessaoReuniao.update({
        where: { id: input.id },
        data: {
          status:      "encerrada",
          encerradaEm: new Date(),
          duracao,
          ...(transcricaoFinal !== null ? { transcricao: transcricaoFinal } : {}),
          ...(input.notas !== undefined ? { notas: input.notas } : {}),
        },
      });

      // Reunião feita na sala do Avoce: já entra no registro do lead; a equipe só completa o resumo.
      if (sessao?.dealId && sessao.iniciadaEm) {
        await prisma.crmAtividade.create({
          data: {
            dealId: sessao.dealId, tipo: "reuniao", resultado: "realizada", canal: "video", origem: "automatica",
            externoId: `reuniao:${sessao.id}`, duracaoSeg: duracao ?? null, criadoEm: sessao.iniciadaEm,
          },
        }).catch(() => {}); // externoId único: encerrar duas vezes não duplica
      }

      // Auto-save transcription as .txt in deal document folder
      const transcricao = transcricaoFinal?.trim();
      if (transcricao && sessao?.dealId) {
        try {
          const dir = path.join(UPLOADS_BASE, "deals", sessao.dealId);
          await fs.mkdir(dir, { recursive: true });
          const ts       = Date.now();
          const slug     = sessao.jitsiRoomName.replace(/[^a-z0-9]/gi, "_");
          const filename = `${ts}_transcricao_${slug}.txt`;
          const filePath = path.join(dir, filename);
          const dataFmt  = new Date(updated.encerradaEm ?? sessao.criadaEm).toLocaleString("pt-BR");
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

      // Relatório IA pós-reunião — assíncrono, não bloqueia o encerramento
      gerarRelatorioReuniao(input.id).catch(e =>
        console.warn(`[Reunião] Falha ao gerar relatório IA: ${e.message}`));

      return updated;
    }),

  // Copiloto IA — sugestões em tempo real para o operador durante a reunião
  copiloto: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const sessao = await prisma.sessaoReuniao.findUnique({
        where: { id: input.id },
        select: { dealId: true, status: true },
      });
      if (!sessao || sessao.status !== "em_andamento") return { sugestoes: null };

      // Janela recente da conversa (últimos ~40 chunks)
      const chunks = await prisma.reuniaoTranscricaoChunk.findMany({
        where: { sessaoId: input.id },
        orderBy: { criadaEm: "desc" },
        take: 40,
        select: { speakerRole: true, speakerNome: true, conteudo: true },
      });
      if (chunks.length < 3) return { sugestoes: null };

      const projetoId = await resolverProjetoId(sessao.dealId);
      if (!projetoId) return { sugestoes: null };

      const { callLlm } = await import("../agent/llm.js");
      try {
        const res = await callLlm({
          projetoId,
          dealId: sessao.dealId ?? undefined,
          systemPrompt: COPILOTO_SYSTEM,
          // maxTokens alto: DeepSeek v4 é modelo de raciocínio e consome budget "pensando"
          messages: [{ role: "user", content: formatarChunks(chunks.reverse()).slice(-8000) }],
          maxTokens: 4096,
          stageChave: "copiloto_reuniao",
        });
        return { sugestoes: res.content?.trim() || null };
      } catch (e: any) {
        console.warn(`[Reunião] Copiloto falhou: ${e.message}`);
        return { sugestoes: null };
      }
    }),

  cancelar: authProc
    .input(z.object({ id: z.string(), motivo: z.string().max(500).optional() }))
    .mutation(async ({ input, ctx }) => {
      // Devolve o horário à agenda e registra o cancelamento no lead.
      return cancelarReuniao(ctx as any, input.id, input.motivo);
    }),

  /** SDR/closer marca reunião do lead: quem conduz, quando, como, pauta e anotações. */
  agendar: authProc
    .input(z.object({
      dealId:          z.string(),
      responsavelId:   z.string(),
      agendadaPara:    z.string(),
      duracaoMin:      z.number().int().min(10).max(480).default(60),
      modalidade:      z.enum(MODALIDADES).default("video"),
      pauta:           z.string().max(5000).optional(),
      notas:           z.string().max(20000).optional(),
      avisarCliente:   z.boolean().default(true),
      ignorarConflito: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => agendarReuniao(ctx as any, input)),

  /** Pauta, anotações, remarcar, trocar quem conduz ou a modalidade. */
  atualizar: authProc
    .input(z.object({
      id:              z.string(),
      pauta:           z.string().max(5000).nullable().optional(),
      notas:           z.string().max(20000).nullable().optional(),
      agendadaPara:    z.string().optional(),
      duracaoMin:      z.number().int().min(10).max(480).optional(),
      modalidade:      z.enum(MODALIDADES).optional(),
      responsavelId:   z.string().optional(),
      ignorarConflito: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => atualizarReuniao(ctx as any, input)),

  /** Resultado de uma reunião agendada: realizada, não compareceu, remarcada ou cancelada. */
  registrarResultado: authProc
    .input(z.object({
      id:              z.string(),
      resultado:       z.enum(RESULTADOS_REUNIAO),
      canal:           z.enum(MODALIDADES).optional(),
      duracaoMin:      z.number().min(0).max(600).optional(),
      nota:            z.string().max(20000).optional(),
      em:              z.string().optional(),
      novaData:        z.string().optional(),
      ignorarConflito: z.boolean().default(false),
    }))
    .mutation(async ({ input, ctx }) => registrarResultadoReuniao(ctx as any, input)),

  /** Reuniões do lead (todas as empresas que o usuário opera, não só a principal). */
  doLead: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input, ctx }) => reunioesDoLead(ctx as any, input.dealId)),

  /** Reuniões com data no período, para a agenda. */
  agendaPeriodo: authProc
    .input(z.object({
      de:                 z.string(),
      ate:                z.string(),
      responsavelId:      z.string().optional(),
      incluirCanceladas:  z.boolean().default(false),
    }))
    .query(async ({ input, ctx }) => agendaDoPeriodo(ctx as any, {
      ...whereEmpresa(ctx as any),
      agendadaPara: { gte: new Date(input.de), lt: new Date(input.ate) },
      ...(input.responsavelId ? { responsavelId: input.responsavelId } : {}),
      ...(input.incluirCanceladas ? {} : { status: { not: "cancelada" } }),
    })),

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

  // Transcrição ao vivo — chunks rotulados por interlocutor, em ordem de chegada
  getTranscricao: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const [sessao, chunks] = await Promise.all([
        prisma.sessaoReuniao.findUnique({ where: { id: input.id }, select: { iniciadaEm: true } }),
        prisma.reuniaoTranscricaoChunk.findMany({
          where: { sessaoId: input.id },
          orderBy: { criadaEm: "asc" },
          select: { id: true, speakerRole: true, speakerNome: true, conteudo: true, criadaEm: true },
        }),
      ]);
      const base = (sessao?.iniciadaEm ?? chunks[0]?.criadaEm)?.getTime();
      return chunks.map(c => ({
        id:      c.id,
        role:    c.speakerRole,
        nome:    c.speakerNome ?? (c.speakerRole === "convidado" ? "Cliente" : "Operador"),
        texto:   c.conteudo,
        segundos: base ? Math.max(0, Math.floor((c.criadaEm.getTime() - base) / 1000)) : 0,
      }));
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
    .mutation(async ({ input, ctx }) => {
      // Compatibilidade: a mesma regra do `agendar` (quem marcou, conflito, atividade, etapa).
      const r = await agendarReuniao(ctx as any, {
        dealId: input.dealId, responsavelId: input.usuarioId, agendadaPara: input.agendadaPara,
      });
      const sessao = await prisma.sessaoReuniao.findUnique({ where: { id: r.sessaoId }, select: { jitsiRoomName: true, titulo: true } });
      const usuario = await prisma.usuario.findUnique({ where: { id: input.usuarioId }, select: { nome: true } });
      const base = sessao ? `https://${JITSI_HOST}/${encodeURIComponent(sessao.jitsiRoomName)}` : "";
      const token = sessao ? gerarJitsiJwt(sessao.jitsiRoomName, usuario?.nome ?? "Advogado", true) : null;
      return { sessaoId: r.sessaoId, jitsiUrl: token ? `${base}?jwt=${token}` : base, linkConvidado: r.linkConvidado, titulo: sessao?.titulo ?? "Reunião" };
    }),

  // Public — no auth — used by /sala/:token page
  getPublico: publicProc
    .input(z.object({ token: z.string() }))
    .query(async ({ input }) => {
      const sessao = await prisma.sessaoReuniao.findUnique({
        where: { tokenConvidado: input.token },
        select: { id: true, titulo: true, status: true, jitsiRoomName: true, contato: { select: { nome: true } } },
      });
      if (!sessao) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada" });
      if (sessao.status === "cancelada") throw new TRPCError({ code: "FORBIDDEN", message: "Esta reunião foi cancelada" });

      const urlBase = `https://${JITSI_HOST}/${encodeURIComponent(sessao.jitsiRoomName)}`;
      return {
        id: sessao.id,
        titulo: sessao.titulo,
        status: sessao.status,
        jitsiUrl: urlBase,
        jitsiHost: JITSI_HOST,
        roomName: sessao.jitsiRoomName,
        contatoNome: sessao.contato?.nome ?? null,
      };
    }),
});
