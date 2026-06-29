import { z }               from "zod";
import { router, authProc } from "./trpc.js";
import { prisma }           from "../db.js";
import { TRPCError }        from "@trpc/server";

const DEFAULT_ASTERISK_WSS = process.env.ASTERISK_WSS ?? "";

async function getEmitenteByDeal(dealId: string, ctxEmpresaId?: string) {
  const deal = await prisma.crmDeal.findUnique({
    where: { id: dealId },
    include: { contato: true },
  });
  if (!deal) return null;

  const pipeline = await prisma.crmPipeline.findUnique({
    where: { id: deal.pipelineId },
    select: { empresaId: true },
  });

  // pipeline.empresaId is Empresa.id — find EmpresaEmitente by that tenant
  const tenantId = pipeline?.empresaId ?? ctxEmpresaId;
  if (!tenantId) return null;

  const voipSelect = {
    id: true, voipDid: true, voipDid2: true, voipDid3: true,
    voipAsteriskWss: true, voipDid1Label: true, voipDid2Label: true, voipDid3Label: true,
  } as const;

  // Look up emitente by Empresa.id (correct path)
  let emitente = await prisma.empresaEmitente.findFirst({
    where: { empresaId: tenantId },
    select: voipSelect,
  });
  // Fallback: treat tenantId as EmpresaEmitente.id (backward compat)
  if (!emitente) {
    emitente = await prisma.empresaEmitente.findUnique({
      where: { id: tenantId },
      select: voipSelect,
    });
  }

  return { deal, emitente, emitenteId: emitente?.id };
}

export const ligacoesRouter = router({

  getVoipConfig: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input, ctx }) => {
      const res = await getEmitenteByDeal(input.dealId, ctx.empresaId);
      let emitente = res?.emitente ?? null;
      // Fallback: se deal não tem empresa/pipeline, usa primeiro emitente VoIP ativo
      if (!emitente) {
        emitente = await prisma.empresaEmitente.findFirst({
          where: { ativo: true, voipDid: { not: null } },
          select: { id: true, voipDid: true, voipDid2: true, voipDid3: true, voipAsteriskWss: true, voipDid1Label: true, voipDid2Label: true, voipDid3Label: true },
        }) as typeof emitente;
      }
      if (!emitente) return null;
      return {
        voipDid:         emitente.voipDid,
        voipDid2:        emitente.voipDid2,
        voipDid3:        emitente.voipDid3,
        voipAsteriskWss: emitente.voipAsteriskWss ?? DEFAULT_ASTERISK_WSS,
        voipDid1Label:   emitente.voipDid1Label ?? "DDD 1",
        voipDid2Label:   emitente.voipDid2Label ?? "DDD 2",
        voipDid3Label:   emitente.voipDid3Label ?? "DDD 3",
      };
    }),

  getVoipConfigGlobal: authProc
    .query(async ({ ctx }) => {
      let empresaId = ctx.empresaId;
      if (!empresaId && ctx.userId) {
        const user = await prisma.usuario.findUnique({
          where: { id: ctx.userId },
          select: { empresaId: true },
        });
        empresaId = user?.empresaId ?? undefined;
      }
      const voipSelect = {
        id: true, voipDid: true, voipDid2: true, voipDid3: true,
        voipAsteriskWss: true, voipDid1Label: true, voipDid2Label: true, voipDid3Label: true,
        voipSipExtension: true, voipSipPassword: true, voipSipDomain: true,
      } as const;
      let emitente = empresaId
        ? await prisma.empresaEmitente.findFirst({ where: { empresaId, ativo: true }, select: voipSelect })
        : null;
      // Fallback global admin: first active emitente with VoIP configured
      if (!emitente) {
        emitente = await prisma.empresaEmitente.findFirst({
          where: { ativo: true, voipSipExtension: { not: null } },
          select: voipSelect,
        });
      }
      if (!emitente) return null;
      return {
        emitenteId:      emitente.id,
        voipDid:         emitente.voipDid,
        voipDid2:        emitente.voipDid2,
        voipDid3:        emitente.voipDid3,
        voipAsteriskWss: emitente.voipAsteriskWss ?? DEFAULT_ASTERISK_WSS,
        voipDid1Label:   emitente.voipDid1Label ?? "DID 1",
        voipDid2Label:   emitente.voipDid2Label ?? "DID 2",
        voipDid3Label:   emitente.voipDid3Label ?? "DID 3",
        voipSipExtension: emitente.voipSipExtension,
        voipSipPassword:  emitente.voipSipPassword,
        voipSipDomain:    emitente.voipSipDomain,
      };
    }),

  iniciar: authProc
    .input(z.object({
      dealId:         z.string().optional(),
      contatoId:      z.string().optional(),
      emitenteId:     z.string().optional(),
      numeroDestino:  z.string(),
      did:            z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      let emitenteId = input.emitenteId;
      let contatoId  = input.contatoId;
      let numeroOrigem = "";
      let asteriskWss = DEFAULT_ASTERISK_WSS;

      if (input.dealId) {
        const res = await getEmitenteByDeal(input.dealId, ctx.empresaId);
        if (!res?.deal) throw new TRPCError({ code: "NOT_FOUND", message: "Deal não encontrado" });
        emitenteId = res.emitenteId ?? emitenteId;
        contatoId  = res.deal.contatoId ?? contatoId;
        const did  = input.did ?? "1";
        numeroOrigem = did === "3"
          ? (res.emitente?.voipDid3 ?? res.emitente?.voipDid ?? "")
          : did === "2"
          ? (res.emitente?.voipDid2 ?? res.emitente?.voipDid ?? "")
          : (res.emitente?.voipDid ?? "");
        asteriskWss = res.emitente?.voipAsteriskWss ?? DEFAULT_ASTERISK_WSS;
      } else {
        // Resolve emitenteId from ctx when not provided by client
        if (!emitenteId) {
          let empresaId = ctx.empresaId;
          if (!empresaId && ctx.userId) {
            const user = await prisma.usuario.findUnique({
              where: { id: ctx.userId },
              select: { empresaId: true },
            });
            empresaId = user?.empresaId ?? undefined;
          }
          if (empresaId) {
            const em = await prisma.empresaEmitente.findFirst({
              where: { empresaId, ativo: true },
              select: { id: true },
            });
            emitenteId = em?.id;
          }
          // Last resort for global admins: use first active emitente with VoIP configured
          if (!emitenteId) {
            const em = await prisma.empresaEmitente.findFirst({
              where: { ativo: true, voipSipExtension: { not: null } },
              select: { id: true },
            });
            emitenteId = em?.id;
          }
        }
        if (emitenteId) {
          const emitente = await prisma.empresaEmitente.findUnique({
            where: { id: emitenteId },
            select: { voipDid: true, voipDid2: true, voipDid3: true, voipAsteriskWss: true },
          });
          const did = input.did ?? "1";
          numeroOrigem = did === "3"
            ? (emitente?.voipDid3 ?? emitente?.voipDid ?? "")
            : did === "2"
            ? (emitente?.voipDid2 ?? emitente?.voipDid ?? "")
            : (emitente?.voipDid ?? "");
          asteriskWss = emitente?.voipAsteriskWss ?? DEFAULT_ASTERISK_WSS;
        }
      }

      if (!emitenteId) throw new TRPCError({ code: "BAD_REQUEST", message: "Empresa não identificada" });

      // We need a dealId — first try to find an existing deal for this contact number
      let dealId = input.dealId;
      if (!dealId) {
        const phone = input.numeroDestino.replace(/\D/g, "");
        if (phone.length >= 8) {
          const existingDeal = await prisma.crmDeal.findFirst({
            where: {
              titulo: { not: "_ligacoes_avulsas" },
              contato: { whatsapp: { contains: phone.slice(-8) } },
              ...(ctx.empresaId ? { empresaId: ctx.empresaId } : {}),
            },
            orderBy: { criadoEm: "desc" },
          });
          if (existingDeal) {
            dealId = existingDeal.id;
            contatoId = existingDeal.contatoId ?? contatoId;
          }
        }
      }

      if (!contatoId) {
        // Create a temp contact for standalone calls with no existing deal
        const tmpContato = await prisma.crmContato.create({
          data: { nome: input.numeroDestino, whatsapp: input.numeroDestino, ...(ctx.empresaId ? { empresaId: ctx.empresaId } : {}) },
        });
        contatoId = tmpContato.id;
      }

      if (!dealId) {
        // Fall back to the "Ligações Avulsas" catch-all deal
        const avulsaDeal = await prisma.crmDeal.findFirst({
          where: { titulo: "_ligacoes_avulsas", ...(ctx.empresaId ? { empresaId: ctx.empresaId } : {}) },
        });
        if (avulsaDeal) {
          dealId = avulsaDeal.id;
        } else {
          const pipeline = await prisma.crmPipeline.findFirst({
            where: ctx.empresaId ? { empresaId: ctx.empresaId } : {},
            include: { stages: { orderBy: { ordem: "asc" }, take: 1 } },
          });
          if (pipeline?.stages[0]) {
            const d = await prisma.crmDeal.create({
              data: {
                titulo: "_ligacoes_avulsas",
                pipelineId: pipeline.id,
                stageId: pipeline.stages[0].id,
                contatoId,
                ...(ctx.empresaId ? { empresaId: ctx.empresaId } : {}),
              },
            });
            dealId = d.id;
          }
        }
      }
      // No pipeline — skip logging and proceed with the call
      if (!dealId) return { ligacaoId: "", asteriskWss, numeroOrigem };

      const ligacao = await prisma.crmLigacao.create({
        data: {
          dealId,
          contatoId,
          emitenteId,
          usuarioId:     ctx.userId,
          numeroOrigem,
          numeroDestino: input.numeroDestino,
          did:           input.did ?? "1",
          status:        "DISCANDO",
        },
      });

      return { ligacaoId: ligacao.id, asteriskWss, numeroOrigem };
    }),

  registrarEntrante: authProc
    .input(z.object({
      numeroOrigem:    z.string(),
      did:             z.string().optional(),
      status:          z.enum(["DISCANDO", "EM_ANDAMENTO", "ENCERRADA", "FALHOU", "SEM_RESPOSTA", "OCUPADO"]).optional(),
      asteriskUniqueId: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      let empresaId = ctx.empresaId;
      if (!empresaId && ctx.userId) {
        const user = await prisma.usuario.findUnique({
          where: { id: ctx.userId },
          select: { empresaId: true },
        });
        empresaId = user?.empresaId ?? undefined;
      }
      let emitenteId: string | undefined;
      let voipDid: string | null = null;
      if (empresaId) {
        const em = await prisma.empresaEmitente.findFirst({
          where: { empresaId, ativo: true },
          select: { id: true, voipDid: true },
        });
        emitenteId = em?.id;
        voipDid = em?.voipDid ?? null;
      }
      // Last resort for global admins
      if (!emitenteId) {
        const em = await prisma.empresaEmitente.findFirst({
          where: { ativo: true, voipSipExtension: { not: null } },
          select: { id: true, voipDid: true },
        });
        emitenteId = em?.id;
        voipDid = em?.voipDid ?? null;
      }
      if (!emitenteId) throw new TRPCError({ code: "BAD_REQUEST", message: "Empresa não identificada" });

      // Find or create contact by phone number
      const phone = input.numeroOrigem.replace(/\D/g, "");
      let contato = await prisma.crmContato.findFirst({
        where: { whatsapp: { contains: phone.slice(-8) }, ...(empresaId ? { empresaId } : {}) },
      });
      if (!contato) {
        contato = await prisma.crmContato.create({
          data: { nome: input.numeroOrigem, whatsapp: input.numeroOrigem, ...(empresaId ? { empresaId } : {}) },
        });
      }

      // Find existing deal for this contact (non-avulsa) before falling back to avulsa
      let dealId: string | undefined;
      const existingDeal = await prisma.crmDeal.findFirst({
        where: {
          contatoId: contato.id,
          titulo: { not: "_ligacoes_avulsas" },
        },
        orderBy: { criadoEm: "desc" },
      });
      if (existingDeal) {
        dealId = existingDeal.id;
      } else {
        const avulsaDeal = await prisma.crmDeal.findFirst({
          where: { titulo: "_ligacoes_avulsas", ...(empresaId ? { empresaId } : {}) },
        });
        if (avulsaDeal) {
          dealId = avulsaDeal.id;
        } else {
          const pipeline = await prisma.crmPipeline.findFirst({
            where: empresaId ? { empresaId } : {},
            include: { stages: { orderBy: { ordem: "asc" }, take: 1 } },
          });
          if (pipeline?.stages[0]) {
            const d = await prisma.crmDeal.create({
              data: {
                titulo: "_ligacoes_avulsas",
                pipelineId: pipeline.id,
                stageId: pipeline.stages[0].id,
                contatoId: contato.id,
                ...(empresaId ? { empresaId } : {}),
              },
            });
            dealId = d.id;
          }
        }
      }
      // No pipeline available — can't create a deal, skip logging
      if (!dealId) return { ligacaoId: "" };

      const ligacao = await prisma.crmLigacao.create({
        data: {
          dealId,
          contatoId:     contato.id,
          emitenteId,
          usuarioId:     ctx.userId,
          numeroOrigem:  input.numeroOrigem,
          numeroDestino: voipDid ?? "",
          did:           input.did,
          status:        input.status ?? "EM_ANDAMENTO",
          asteriskUniqueId: input.asteriskUniqueId,
        },
      });
      return { ligacaoId: ligacao.id };
    }),

  atualizar: authProc
    .input(z.object({
      id:               z.string(),
      status:           z.enum(["DISCANDO", "EM_ANDAMENTO", "ENCERRADA", "FALHOU", "SEM_RESPOSTA", "OCUPADO"]).optional(),
      duracao:          z.number().optional(),
      asteriskUniqueId: z.string().optional(),
      notas:            z.string().optional(),
      resumo:           z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const data: any = {};
      if (input.status) data.status = input.status;
      if (input.duracao !== undefined) data.duracao = input.duracao;
      if (input.asteriskUniqueId) data.asteriskUniqueId = input.asteriskUniqueId;
      if (input.notas !== undefined) data.notas = input.notas;
      if (input.resumo !== undefined) data.resumo = input.resumo;
      if (input.status === "ENCERRADA" || input.status === "FALHOU" || input.status === "SEM_RESPOSTA" || input.status === "OCUPADO") {
        data.encerradaEm = new Date();
      }
      return prisma.crmLigacao.update({ where: { id: input.id }, data });
    }),

  getLigacao: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      return prisma.crmLigacao.findUnique({ where: { id: input.id } });
    }),

  listar: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input }) => {
      return prisma.crmLigacao.findMany({
        where:   { dealId: input.dealId },
        orderBy: { iniciadaEm: "desc" },
      });
    }),

  listarTodos: authProc
    .input(z.object({ limit: z.number().optional() }))
    .query(async ({ input, ctx }) => {
      return prisma.crmLigacao.findMany({
        where:   ctx.userId ? { usuarioId: ctx.userId } : {},
        orderBy: { iniciadaEm: "desc" },
        take:    input.limit ?? 50,
        include: { contato: { select: { nome: true, whatsapp: true } } },
      });
    }),
});
