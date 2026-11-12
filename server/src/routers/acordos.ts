/**
 * Funil de acordos (§2 do documento de ajustes) — appRouter.acordos.
 *
 * O Acordo é um registro PARALELO ao CrmDeal (decisão 11): nada aqui altera `stageId`,
 * `proximoPrazo` nem os campos de audiência do deal. A única exceção é opcional e explícita:
 * `homologar({ moverParaStageId })`, que move o card a pedido do usuário.
 *
 * Permissões: leitura = acesso ao deal (tenant); mutações = módulo `acordos` (lib/fin/perm.ts).
 * Toda mutação grava FinAuditLog (lib/fin/audit.ts).
 *
 * Convenções da resposta: valores em reais (number, 2 casas), datas-calendário "YYYY-MM-DD",
 * data+hora (audienciaEm, criadoEm) em ISO.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router, authProc } from "./trpc.js";
import { prisma } from "../db.js";
import { usuariosDoFollowup } from "./crm.js";
import { exigirModulo, assertEmitenteDoTenant } from "../lib/fin/perm.js";
import { analisarPathAnexo } from "../lib/fin/anexos.js";
import { registrarAudit } from "../lib/fin/audit.js";
import { deCentavos, paraCentavos, paraDataCal, deDataCal } from "../lib/fin/util.js";
import { gerarParcelasAcordo } from "../lib/fin/acordo-parcelas.js";
import { statusRecebimento, diasEmAtraso } from "../lib/fin/recebimento.js";
import {
  STATUS_ABERTOS, FASES, calcularIndicadores, indicadoresPorEmpresa, calcularExito,
  type AcordoParaIndicador,
} from "../lib/fin/acordo-indicadores.js";
import { garantirAvaliacaoAcordo, hojeCal, prazoDoDeal } from "../lib/fin/acordo-avaliacao.js";
import {
  zDataCal, zValor, zArquivo, centavosDe, reais, cal, dataDe, empresaDoDeal, whereDealDoTenant,
  SELECT_DEAL_RESUMO, carregarDealAcessivel, dealParaResposta, empresaRe, emitentesDoDeal, resolverEmitente,
} from "../lib/fin/acordo-comum.js";

const MOD = "acordos";
const STATUS = ["em_negociacao", "firmado", "aguardando_homologacao", "homologado", "sem_acordo"] as const;
const ABERTOS = [...STATUS_ABERTOS] as string[];
const zFase = z.enum(FASES);
const zMotivoSaida = z.enum(["empresa_recusou", "abaixo_minimo", "cliente_recusou", "sem_resposta"]);

const exigir = (ctx: Parameters<typeof exigirModulo>[0]) => exigirModulo(ctx, MOD);

const INCLUDE_ACORDO = {
  deal: { select: SELECT_DEAL_RESUMO },
  rodadas: { orderBy: [{ data: "asc" as const }, { criadoEm: "asc" as const }] },
  recebimentos: { orderBy: [{ parcelaNumero: "asc" as const }, { vencimento: "asc" as const }] },
  emitente: { select: { id: true, nome: true, nomeFantasia: true } },
} satisfies Prisma.AcordoInclude;

type AcordoCompleto = Prisma.AcordoGetPayload<{ include: typeof INCLUDE_ACORDO }>;

async function carregarAcordo(ctx: Parameters<typeof carregarDealAcessivel>[0], id: string): Promise<AcordoCompleto> {
  const a = await prisma.acordo.findUnique({ where: { id }, include: INCLUDE_ACORDO });
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "Acordo não encontrado" });
  await carregarDealAcessivel(ctx, a.dealId); // checa tenant
  return a;
}

function assertAberto(a: { status: string }) {
  if (!ABERTOS.includes(a.status)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Acordo encerrado — abra uma nova tentativa" });
  }
}

async function nomesUsuarios(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const u = [...new Set(ids.filter((x): x is string => !!x))];
  if (!u.length) return new Map();
  const rows = await prisma.usuario.findMany({ where: { id: { in: u } }, select: { id: true, nome: true } });
  return new Map(rows.map((r) => [r.id, r.nome]));
}

function acordoResumo(a: Omit<AcordoCompleto, "rodadas" | "recebimentos"> & { rodadas?: AcordoCompleto["rodadas"] }, nomes: Map<string, string>) {
  const ultima = a.rodadas?.length ? a.rodadas[a.rodadas.length - 1] : null;
  return {
    id: a.id,
    dealId: a.dealId,
    emitenteId: a.emitenteId,
    emitente: a.emitente,
    tipo: a.tipo,
    status: a.status,
    motivo: a.motivo,
    faseOrigem: a.faseOrigem,
    responsavelId: a.responsavelId,
    responsavelNome: a.responsavelId ? nomes.get(a.responsavelId) ?? null : null,
    contatoEmpresaNome: a.contatoEmpresaNome,
    contatoEmpresaPapel: a.contatoEmpresaPapel,
    contatoEmpresaFone: a.contatoEmpresaFone,
    estimativaCondenacao: reais(a.estimativaCondenacao),
    valorMinimoAutorizado: reais(a.valorMinimoAutorizado),
    autorizacaoRegistro: a.autorizacaoRegistro,
    autorizacaoAnexoPath: a.autorizacaoAnexoPath,
    autorizacaoAnexoNome: a.autorizacaoAnexoNome,
    proximoFollowupEm: cal(a.proximoFollowupEm),
    followupVencido: !!a.proximoFollowupEm && ABERTOS.includes(a.status) && paraDataCal(a.proximoFollowupEm) < hojeCal(),
    motivoSaida: a.motivoSaida,
    obsSaida: a.obsSaida,
    valorAcordo: reais(a.valorAcordo),
    percHonorarios: a.percHonorarios === null ? null : Number(a.percHonorarios),
    multaInadimplemento: reais(a.multaInadimplemento),
    multaTipo: a.multaTipo,
    enviadoExecucaoEm: cal(a.enviadoExecucaoEm),
    firmadoEm: cal(a.firmadoEm),
    homologadoEm: cal(a.homologadoEm),
    encerradoEm: cal(a.encerradoEm),
    criadoPorId: a.criadoPorId,
    criadoEm: a.criadoEm,
    atualizadoEm: a.atualizadoEm,
    deal: dealParaResposta(a.deal),
    qtdRodadas: a.rodadas?.length ?? 0,
    ultimaRodada: ultima ? { data: cal(ultima.data), autor: ultima.autor, valor: reais(ultima.valor) } : null,
  };
}

function parcelaResposta(r: AcordoCompleto["recebimentos"][number], hoje: string) {
  const venc = cal(r.vencimento);
  const rec = cal(r.dataRecebimento);
  return {
    id: r.id,
    parcelaNumero: r.parcelaNumero,
    tipo: r.tipo,
    vencimento: venc,
    valorPrevisto: reais(r.valorPrevisto),
    dataRecebimento: rec,
    valorBruto: reais(r.valorBruto),
    valorHonorarios: reais(r.valorHonorarios),
    valorRepasse: reais(r.valorRepasse),
    valorSucumbencia: reais(r.valorSucumbencia),
    status: statusRecebimento({ vencimento: venc, dataRecebimento: rec }, hoje),
    diasAtraso: diasEmAtraso({ vencimento: venc, dataRecebimento: rec }, hoje),
    repasseStatus: r.repasseStatus,
    nfStatus: r.nfStatus,
  };
}

/** Plano de parcelas informado no "firmar" (não há coluna no Acordo — fica na trilha de auditoria). */
async function planoFirmado(acordoId: string): Promise<Record<string, unknown> | null> {
  const logs = await prisma.finAuditLog.findMany({
    where: { entidade: "Acordo", entidadeId: acordoId },
    orderBy: { criadoEm: "desc" },
    take: 30,
    select: { depois: true },
  });
  for (const l of logs) {
    const d = l.depois as Record<string, unknown> | null;
    if (d && typeof d === "object" && d.planoFirmado && typeof d.planoFirmado === "object") return d.planoFirmado as Record<string, unknown>;
  }
  return null;
}

const zNegociacao = {
  responsavelId: z.string().nullable().optional(),
  contatoEmpresaNome: z.string().max(200).nullable().optional(),
  contatoEmpresaPapel: z.enum(["preposto", "advogado"]).nullable().optional(),
  contatoEmpresaFone: z.string().max(40).nullable().optional(),
  estimativaCondenacao: zValor.nullable().optional(),
  valorMinimoAutorizado: zValor.nullable().optional(),
  autorizacaoRegistro: z.string().max(2000).nullable().optional(),
  autorizacaoAnexoPath: zArquivo.nullable().optional(),
  autorizacaoAnexoNome: z.string().max(300).nullable().optional(),
  proximoFollowupEm: zDataCal.nullable().optional(),
  emitenteId: z.string().nullable().optional(),
};

type InputNegociacao = { [K in keyof typeof zNegociacao]?: z.infer<(typeof zNegociacao)[K]> };

function dataNegociacao(i: InputNegociacao): Prisma.AcordoUncheckedUpdateInput {
  const d: Prisma.AcordoUncheckedUpdateInput = {};
  if (i.responsavelId !== undefined) d.responsavelId = i.responsavelId;
  if (i.contatoEmpresaNome !== undefined) d.contatoEmpresaNome = i.contatoEmpresaNome?.trim() || null;
  if (i.contatoEmpresaPapel !== undefined) d.contatoEmpresaPapel = i.contatoEmpresaPapel;
  if (i.contatoEmpresaFone !== undefined) d.contatoEmpresaFone = i.contatoEmpresaFone?.trim() || null;
  if (i.estimativaCondenacao !== undefined) d.estimativaCondenacao = i.estimativaCondenacao === null ? null : deCentavos(centavosDe(i.estimativaCondenacao));
  if (i.valorMinimoAutorizado !== undefined) d.valorMinimoAutorizado = i.valorMinimoAutorizado === null ? null : deCentavos(centavosDe(i.valorMinimoAutorizado));
  if (i.autorizacaoRegistro !== undefined) d.autorizacaoRegistro = i.autorizacaoRegistro?.trim() || null;
  if (i.autorizacaoAnexoPath !== undefined) d.autorizacaoAnexoPath = i.autorizacaoAnexoPath;
  if (i.autorizacaoAnexoNome !== undefined) d.autorizacaoAnexoNome = i.autorizacaoAnexoNome;
  if (i.proximoFollowupEm !== undefined) d.proximoFollowupEm = dataDe(i.proximoFollowupEm);
  return d;
}

/** Anexo da autorização: upload válido (fin/{emitente}/…) de um emitente acessível ao usuário. */
async function validarAnexoAutorizacao(ctx: Parameters<typeof assertEmitenteDoTenant>[0], path: string | null | undefined) {
  if (!path) return;
  const info = analisarPathAnexo(path);
  if (!info) throw new TRPCError({ code: "BAD_REQUEST", message: "Anexo da autorização inválido" });
  await assertEmitenteDoTenant(ctx, info.emitenteId);
}

async function validarResponsavel(responsavelId: string | null | undefined, deal: Parameters<typeof empresaDoDeal>[0]) {
  if (!responsavelId) return;
  const ok = (await usuariosDoFollowup(empresaDoDeal(deal))).some((u) => u.id === responsavelId);
  if (!ok) throw new TRPCError({ code: "BAD_REQUEST", message: "Responsável não pertence à empresa do processo" });
}

export const acordosRouter = router({
  // ── Avaliação prévia (§2.1) ────────────────────────────────────────────────

  /** Tarefas de avaliação prévia. `escopo: "minhas"` = responsavelId do usuário. */
  avaliacoes: authProc
    .input(z.object({
      escopo: z.enum(["minhas", "todas"]).default("todas"),
      situacao: z.enum(["pendentes", "decididas", "todas"]).default("pendentes"),
      pipelineId: z.string().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const i = input ?? { escopo: "todas" as const, situacao: "pendentes" as const };
      const where: Prisma.AcordoAvaliacaoWhereInput = {
        deal: { ...whereDealDoTenant(ctx), ...(i.pipelineId ? { pipelineId: i.pipelineId } : {}) },
        ...(i.escopo === "minhas" ? { responsavelId: ctx.userId ?? "__none__" } : {}),
        ...(i.situacao === "pendentes" ? { decisao: null } : i.situacao === "decididas" ? { decisao: { not: null } } : {}),
      };
      const rows = await prisma.acordoAvaliacao.findMany({
        where,
        orderBy: [{ prazoEm: "asc" }, { criadoEm: "asc" }],
        take: 500,
        include: { deal: { select: SELECT_DEAL_RESUMO } },
      });
      const nomes = await nomesUsuarios(rows.flatMap((r) => [r.responsavelId, r.decididoPorId]));
      const hoje = hojeCal();
      return rows.map((r) => ({
        id: r.id,
        dealId: r.dealId,
        responsavelId: r.responsavelId,
        responsavelNome: r.responsavelId ? nomes.get(r.responsavelId) ?? null : null,
        prazoEm: cal(r.prazoEm),
        atrasada: !r.decisao && !!r.prazoEm && paraDataCal(r.prazoEm) < hoje,
        venceHoje: !r.decisao && !!r.prazoEm && paraDataCal(r.prazoEm) === hoje,
        decisao: r.decisao,
        justificativa: r.justificativa,
        decididoEm: r.decididoEm,
        decididoPorId: r.decididoPorId,
        decididoPorNome: r.decididoPorId ? nomes.get(r.decididoPorId) ?? null : null,
        acordoId: r.acordoId,
        criadoEm: r.criadoEm,
        deal: dealParaResposta(r.deal),
      }));
    }),

  /**
   * Cria a tarefa manualmente (processos ajuizados antes do gatilho existir). Idempotente.
   * Exige deal de funil processual. Preenche ajuizadoEm (hoje) se vazio.
   */
  criarAvaliacao: authProc
    .input(z.object({ dealId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      if (deal.pipeline?.tipo !== "processual") throw new TRPCError({ code: "BAD_REQUEST", message: "Só processos do funil processual" });
      const id = await garantirAvaliacaoAcordo(input.dealId, { gatilho: "manual", usuarioId: ctx.userId });
      if (!id) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Não foi possível criar a avaliação" });
      return prisma.acordoAvaliacao.findUniqueOrThrow({ where: { id } });
    }),

  /** Decisão obrigatória com justificativa. "tentar" abre um Acordo tipo prévio e liga acordoId. */
  decidirAvaliacao: authProc
    .input(z.object({
      avaliacaoId: z.string(),
      decisao: z.enum(["tentar", "nao_tentar"]),
      justificativa: z.string().trim().min(3).max(500),
      responsavelId: z.string().nullable().optional(), // do acordo aberto (default: responsável da avaliação)
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const av = await prisma.acordoAvaliacao.findUnique({ where: { id: input.avaliacaoId } });
      if (!av) throw new TRPCError({ code: "NOT_FOUND", message: "Avaliação não encontrada" });
      const deal = await carregarDealAcessivel(ctx, av.dealId);
      if (av.decisao) throw new TRPCError({ code: "BAD_REQUEST", message: "Avaliação já decidida" });
      await validarResponsavel(input.responsavelId, deal);

      return prisma.$transaction(async (tx) => {
        let acordoId: string | null = null;
        if (input.decisao === "tentar") {
          const aberto = await tx.acordo.findFirst({ where: { dealId: av.dealId, status: { in: ABERTOS } }, select: { id: true } });
          if (aberto) {
            acordoId = aberto.id; // já havia negociação aberta: só liga
          } else {
            const a = await tx.acordo.create({
              data: {
                dealId: av.dealId, tipo: "previo", status: "em_negociacao", faseOrigem: "previo",
                motivo: input.justificativa, responsavelId: input.responsavelId ?? av.responsavelId ?? ctx.userId ?? null,
                criadoPorId: ctx.userId ?? null,
              },
            });
            acordoId = a.id;
            await registrarAudit(tx, ctx, { entidade: "Acordo", entidadeId: a.id, acao: "criar", depois: a });
          }
        }
        const novo = await tx.acordoAvaliacao.update({
          where: { id: av.id },
          data: { decisao: input.decisao, justificativa: input.justificativa, decididoEm: new Date(), decididoPorId: ctx.userId ?? null, acordoId },
        });
        await registrarAudit(tx, ctx, { entidade: "AcordoAvaliacao", entidadeId: av.id, acao: "atualizar", antes: av, depois: novo });
        return { avaliacao: novo, acordoId };
      });
    }),

  /** Ajusta a data do protocolo (ajuizadoEm) do deal; recalcula o prazo da avaliação pendente. */
  definirAjuizadoEm: authProc
    .input(z.object({ dealId: z.string(), data: zDataCal.nullable() }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      const ajuizadoEm = input.data ? deDataCal(input.data) : null;
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ajuizadoEm } });
      await registrarAudit(prisma, ctx, { entidade: "CrmDeal", entidadeId: deal.id, acao: "atualizar", antes: { ajuizadoEm: deal.ajuizadoEm }, depois: { ajuizadoEm } });
      const av = await prisma.acordoAvaliacao.findUnique({ where: { dealId: deal.id } });
      if (av && !av.decisao) {
        await prisma.acordoAvaliacao.update({ where: { id: av.id }, data: { prazoEm: prazoDoDeal({ audienciaEm: deal.audienciaEm, ajuizadoEm }) } });
      }
      return { ok: true, ajuizadoEm: input.data };
    }),

  // ── Tentativa de acordo (§2.2) ─────────────────────────────────────────────

  /** Abre uma tentativa em qualquer fase. No máximo um acordo em aberto por deal. */
  abrir: authProc
    .input(z.object({
      dealId: z.string(),
      motivo: z.string().trim().min(3).max(2000),
      faseOrigem: zFase,
      tipo: z.enum(["previo", "posterior"]).optional(), // default: previo se faseOrigem = previo
      ...zNegociacao,
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      await validarResponsavel(input.responsavelId, deal);
      await validarAnexoAutorizacao(ctx, input.autorizacaoAnexoPath);
      const emitenteId = input.emitenteId ? await resolverEmitente(ctx, deal, input.emitenteId) : null;
      return prisma.$transaction(async (tx) => {
        const aberto = await tx.acordo.findFirst({ where: { dealId: deal.id, status: { in: ABERTOS } }, select: { id: true } });
        if (aberto) throw new TRPCError({ code: "CONFLICT", message: "Já existe um acordo em aberto para este processo" });
        const a = await tx.acordo.create({
          data: {
            ...(dataNegociacao(input) as unknown as Partial<Prisma.AcordoUncheckedCreateInput>),
            dealId: deal.id,
            emitenteId,
            tipo: input.tipo ?? (input.faseOrigem === "previo" ? "previo" : "posterior"),
            status: "em_negociacao",
            motivo: input.motivo,
            faseOrigem: input.faseOrigem,
            responsavelId: input.responsavelId ?? ctx.userId ?? null,
            criadoPorId: ctx.userId ?? null,
          },
        });
        await registrarAudit(tx, ctx, { emitenteId, entidade: "Acordo", entidadeId: a.id, acao: "criar", depois: a });
        return a;
      });
    }),

  /** Edita os dados da negociação (só enquanto aberto). */
  atualizar: authProc
    .input(z.object({
      id: z.string(),
      motivo: z.string().trim().min(3).max(2000).optional(),
      faseOrigem: zFase.optional(),
      tipo: z.enum(["previo", "posterior"]).optional(),
      ...zNegociacao,
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const a = await carregarAcordo(ctx, input.id);
      assertAberto(a);
      await validarResponsavel(input.responsavelId, a.deal);
      await validarAnexoAutorizacao(ctx, input.autorizacaoAnexoPath);
      const data = dataNegociacao(input);
      if (input.motivo !== undefined) data.motivo = input.motivo;
      if (input.faseOrigem !== undefined) data.faseOrigem = input.faseOrigem;
      if (input.tipo !== undefined) data.tipo = input.tipo;
      if (input.emitenteId !== undefined) data.emitenteId = input.emitenteId ? await resolverEmitente(ctx, a.deal, input.emitenteId) : null;
      const { deal: _d, rodadas: _r, recebimentos: _rc, emitente: _e, ...antes } = a;
      const novo = await prisma.acordo.update({ where: { id: a.id }, data });
      await registrarAudit(prisma, ctx, { emitenteId: novo.emitenteId, entidade: "Acordo", entidadeId: a.id, acao: "atualizar", antes, depois: novo });
      return novo;
    }),

  // ── Rodadas ────────────────────────────────────────────────────────────────

  rodadaCriar: authProc
    .input(z.object({
      acordoId: z.string(),
      data: zDataCal,
      autor: z.enum(["escritorio", "empresa"]),
      valor: zValor.nullable().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const a = await carregarAcordo(ctx, input.acordoId);
      assertAberto(a);
      const r = await prisma.acordoRodada.create({
        data: {
          acordoId: a.id, data: deDataCal(input.data), autor: input.autor,
          valor: input.valor === null || input.valor === undefined ? null : deCentavos(centavosDe(input.valor)),
          obs: input.obs?.trim() || null, criadoPorId: ctx.userId ?? null,
        },
      });
      await registrarAudit(prisma, ctx, { emitenteId: a.emitenteId, entidade: "AcordoRodada", entidadeId: r.id, acao: "criar", depois: r });
      return r;
    }),

  rodadaAtualizar: authProc
    .input(z.object({
      id: z.string(),
      data: zDataCal.optional(),
      autor: z.enum(["escritorio", "empresa"]).optional(),
      valor: zValor.nullable().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const r = await prisma.acordoRodada.findUnique({ where: { id: input.id } });
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Rodada não encontrada" });
      const a = await carregarAcordo(ctx, r.acordoId);
      assertAberto(a);
      const novo = await prisma.acordoRodada.update({
        where: { id: r.id },
        data: {
          ...(input.data !== undefined ? { data: deDataCal(input.data) } : {}),
          ...(input.autor !== undefined ? { autor: input.autor } : {}),
          ...(input.valor !== undefined ? { valor: input.valor === null ? null : deCentavos(centavosDe(input.valor)) } : {}),
          ...(input.obs !== undefined ? { obs: input.obs?.trim() || null } : {}),
        },
      });
      await registrarAudit(prisma, ctx, { emitenteId: a.emitenteId, entidade: "AcordoRodada", entidadeId: r.id, acao: "atualizar", antes: r, depois: novo });
      return novo;
    }),

  rodadaExcluir: authProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const r = await prisma.acordoRodada.findUnique({ where: { id: input.id } });
      if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Rodada não encontrada" });
      const a = await carregarAcordo(ctx, r.acordoId);
      assertAberto(a);
      await prisma.acordoRodada.delete({ where: { id: r.id } });
      await registrarAudit(prisma, ctx, { emitenteId: a.emitenteId, entidade: "AcordoRodada", entidadeId: r.id, acao: "excluir", antes: r });
      return { ok: true };
    }),

  // ── Saídas (§2.3) ──────────────────────────────────────────────────────────

  /** Retorno ao fluxo normal: status sem_acordo, histórico mantido; pode abrir outro depois. */
  encerrarSemAcordo: authProc
    .input(z.object({ id: z.string(), motivoSaida: zMotivoSaida, obsSaida: z.string().max(2000).nullable().optional() }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const a = await carregarAcordo(ctx, input.id);
      assertAberto(a);
      const novo = await prisma.acordo.update({
        where: { id: a.id },
        data: { status: "sem_acordo", motivoSaida: input.motivoSaida, obsSaida: input.obsSaida?.trim() || null, encerradoEm: new Date(), proximoFollowupEm: null },
      });
      await registrarAudit(prisma, ctx, { emitenteId: a.emitenteId, entidade: "Acordo", entidadeId: a.id, acao: "atualizar", antes: { status: a.status, motivoSaida: a.motivoSaida }, depois: novo });
      return novo;
    }),

  /**
   * Acordo firmado: grava valor, % honorários e multa; status → aguardando_homologacao
   * (ou "firmado", se `aguardarHomologacao: false`). O plano de parcelas (numParcelas,
   * entrada, 1º vencimento) não tem coluna no Acordo: vai para a trilha de auditoria e volta
   * em `detalhe.planoFirmado` para pré-preencher a homologação.
   */
  firmar: authProc
    .input(z.object({
      id: z.string(),
      valorAcordo: zValor,
      numParcelas: z.number().int().min(0).max(360),
      percHonorarios: z.number().min(0).max(100).nullable().optional(),
      multaInadimplemento: zValor.nullable().optional(),
      multaTipo: z.enum(["percentual", "valor"]).nullable().optional(),
      firmadoEm: zDataCal.optional(), // default hoje
      aguardarHomologacao: z.boolean().default(true),
      entrada: z.object({ valor: zValor, vencimento: zDataCal }).nullable().optional(),
      primeiroVencimento: zDataCal.nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const a = await carregarAcordo(ctx, input.id);
      if (!["em_negociacao", "firmado", "aguardando_homologacao"].includes(a.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Só acordos em negociação podem ser firmados" });
      }
      const valor = centavosDe(input.valorAcordo);
      if (valor <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Valor do acordo deve ser positivo" });
      if (input.multaTipo === "percentual" && input.multaInadimplemento != null && centavosDe(input.multaInadimplemento) > 100_00) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Multa percentual acima de 100%" });
      }
      const novo = await prisma.acordo.update({
        where: { id: a.id },
        data: {
          status: input.aguardarHomologacao ? "aguardando_homologacao" : "firmado",
          valorAcordo: deCentavos(valor),
          percHonorarios: input.percHonorarios === undefined ? undefined : input.percHonorarios === null ? null : input.percHonorarios.toFixed(2),
          multaInadimplemento: input.multaInadimplemento === undefined ? undefined : input.multaInadimplemento === null ? null : deCentavos(centavosDe(input.multaInadimplemento)),
          multaTipo: input.multaTipo === undefined ? undefined : input.multaTipo,
          firmadoEm: deDataCal(input.firmadoEm ?? hojeCal()),
          proximoFollowupEm: null,
        },
      });
      const plano = {
        numParcelas: input.numParcelas,
        entrada: input.entrada ? { valor: Number(deCentavos(centavosDe(input.entrada.valor))), vencimento: input.entrada.vencimento } : null,
        primeiroVencimento: input.primeiroVencimento ?? null,
      };
      await registrarAudit(prisma, ctx, {
        emitenteId: a.emitenteId, entidade: "Acordo", entidadeId: a.id, acao: "atualizar",
        antes: { status: a.status, valorAcordo: a.valorAcordo }, depois: { ...novo, planoFirmado: plano },
      });
      return { ...novo, planoFirmado: plano };
    }),

  /**
   * Homologação: gera as parcelas (FinRecebimento tipo "acordo", entrada = parcela 0) com
   * `gerarParcelasAcordo`, grava deal.valorAcordo e fecha o acordo — tudo numa transação.
   * Mover o card é opcional (`moverParaStageId`, coluna do MESMO funil do deal).
   */
  homologar: authProc
    .input(z.object({
      id: z.string(),
      emitenteId: z.string().optional(),
      homologadoEm: zDataCal.optional(), // default hoje
      valorAcordo: zValor.optional(), // default: o do "firmar"
      percHonorarios: z.number().min(0).max(100).nullable().optional(), // default: o do "firmar"
      numParcelas: z.number().int().min(0).max(360),
      primeiroVencimento: zDataCal,
      intervaloMeses: z.number().int().min(1).max(12).default(1),
      entrada: z.object({ valor: zValor, vencimento: zDataCal }).nullable().optional(),
      valores: z.array(zValor.nullable()).max(360).optional(), // índice 0 = parcela 1; null = automático
      vencimentos: z.array(zDataCal.nullable()).max(360).optional(),
      semRepasse: z.boolean().default(false), // tudo do escritório (repasseStatus nao_aplicavel)
      moverParaStageId: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const a = await carregarAcordo(ctx, input.id);
      if (!["firmado", "aguardando_homologacao"].includes(a.status)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Firme o acordo antes de homologar" });
      }
      const emitenteId = await resolverEmitente(ctx, a.deal, input.emitenteId ?? a.emitenteId);
      const valorTotal = input.valorAcordo !== undefined ? centavosDe(input.valorAcordo) : paraCentavos(a.valorAcordo);
      const perc = input.percHonorarios !== undefined ? input.percHonorarios : a.percHonorarios;

      let parcelas;
      try {
        parcelas = gerarParcelasAcordo({
          valorTotalCentavos: valorTotal,
          numParcelas: input.numParcelas,
          primeiroVencimento: input.primeiroVencimento,
          intervaloMeses: input.intervaloMeses,
          entrada: input.entrada ? { valorCentavos: centavosDe(input.entrada.valor), vencimento: input.entrada.vencimento } : null,
          valores: input.valores?.map((v) => (v === null ? null : centavosDe(v))),
          vencimentos: input.vencimentos,
          percHonorarios: perc ?? null,
        });
      } catch (e: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Parcelas inválidas" });
      }

      let destino: { id: string; pipelineId: string } | null = null;
      if (input.moverParaStageId) {
        destino = await prisma.crmStage.findUnique({ where: { id: input.moverParaStageId }, select: { id: true, pipelineId: true } });
        if (!destino || destino.pipelineId !== a.deal.pipelineId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Coluna de destino não pertence ao funil do processo" });
        }
      }

      const homologadoEm = deDataCal(input.homologadoEm ?? hojeCal());
      return prisma.$transaction(async (tx) => {
        const ja = await tx.finRecebimento.count({ where: { acordoId: a.id } });
        if (ja) throw new TRPCError({ code: "CONFLICT", message: "Este acordo já tem parcelas geradas" });

        const linhas = parcelas.parcelas.map((p) => ({
          emitenteId,
          dealId: a.dealId,
          acordoId: a.id,
          parcelaNumero: p.numero,
          tipo: "acordo",
          descricao: p.numero === 0 ? "Entrada do acordo" : `Parcela ${p.numero}/${input.numParcelas} do acordo`,
          vencimento: deDataCal(p.vencimento),
          valorPrevisto: deCentavos(p.valorCentavos),
          percHonorarios: input.semRepasse ? "100.00" : perc === null || perc === undefined ? null : Number(perc).toFixed(2),
          valorHonorarios: deCentavos(input.semRepasse ? p.valorCentavos : p.honorariosCentavos),
          valorRepasse: deCentavos(input.semRepasse ? 0 : p.repasseCentavos),
          repasseStatus: input.semRepasse || p.repasseCentavos === 0 ? "nao_aplicavel" : "pendente",
          nfStatus: "a_emitir",
          nfValor: deCentavos(input.semRepasse ? p.valorCentavos : p.honorariosCentavos),
          criadoPorId: ctx.userId ?? null,
        }));
        await tx.finRecebimento.createMany({ data: linhas });

        const novo = await tx.acordo.update({
          where: { id: a.id },
          data: {
            status: "homologado", homologadoEm, encerradoEm: new Date(), emitenteId,
            valorAcordo: deCentavos(valorTotal),
            percHonorarios: perc === null || perc === undefined ? null : Number(perc).toFixed(2),
            proximoFollowupEm: null,
          },
        });
        await tx.crmDeal.update({ where: { id: a.dealId }, data: { valorAcordo: deCentavos(valorTotal) } });

        if (destino && destino.id !== a.deal.stageId) {
          await tx.crmDealStageLog.create({
            data: { dealId: a.dealId, stageAnteriorId: a.deal.stageId, stageNovoId: destino.id, usuarioId: ctx.userId ?? null, motivo: "Acordo homologado" },
          });
          await tx.crmDeal.update({ where: { id: a.dealId }, data: { stageId: destino.id } });
        }

        await registrarAudit(tx, ctx, {
          emitenteId, entidade: "Acordo", entidadeId: a.id, acao: "atualizar",
          antes: { status: a.status, valorAcordo: a.valorAcordo }, depois: { ...novo, parcelas: parcelas.parcelas },
        });
        await registrarAudit(tx, ctx, {
          emitenteId, entidade: "CrmDeal", entidadeId: a.dealId, acao: "atualizar",
          antes: { valorAcordo: a.deal.valorAcordo, stageId: a.deal.stageId },
          depois: { valorAcordo: deCentavos(valorTotal), stageId: destino?.id ?? a.deal.stageId },
        });
        return {
          acordo: novo,
          parcelas: parcelas.parcelas.map((p) => ({ ...p, valor: Number(deCentavos(p.valorCentavos)), honorarios: Number(deCentavos(p.honorariosCentavos)), repasse: Number(deCentavos(p.repasseCentavos)) })),
          totalHonorarios: Number(deCentavos(parcelas.totalHonorarios)),
          totalRepasse: Number(deCentavos(parcelas.totalRepasse)),
        };
      });
    }),

  /** Simula as parcelas sem gravar (mesmos parâmetros da homologação). */
  simularParcelas: authProc
    .input(z.object({
      valorAcordo: zValor,
      percHonorarios: z.number().min(0).max(100).nullable().optional(),
      numParcelas: z.number().int().min(0).max(360),
      primeiroVencimento: zDataCal,
      intervaloMeses: z.number().int().min(1).max(12).default(1),
      entrada: z.object({ valor: zValor, vencimento: zDataCal }).nullable().optional(),
      valores: z.array(zValor.nullable()).max(360).optional(),
      vencimentos: z.array(zDataCal.nullable()).max(360).optional(),
    }))
    .query(({ input }) => {
      try {
        const r = gerarParcelasAcordo({
          valorTotalCentavos: centavosDe(input.valorAcordo),
          numParcelas: input.numParcelas,
          primeiroVencimento: input.primeiroVencimento,
          intervaloMeses: input.intervaloMeses,
          entrada: input.entrada ? { valorCentavos: centavosDe(input.entrada.valor), vencimento: input.entrada.vencimento } : null,
          valores: input.valores?.map((v) => (v === null ? null : centavosDe(v))),
          vencimentos: input.vencimentos,
          percHonorarios: input.percHonorarios ?? null,
        });
        return {
          ok: true as const,
          parcelas: r.parcelas.map((p) => ({ numero: p.numero, vencimento: p.vencimento, manual: p.manual, valor: Number(deCentavos(p.valorCentavos)), honorarios: Number(deCentavos(p.honorariosCentavos)), repasse: Number(deCentavos(p.repasseCentavos)) })),
          total: Number(deCentavos(r.totalCentavos)),
          totalHonorarios: Number(deCentavos(r.totalHonorarios)),
          totalRepasse: Number(deCentavos(r.totalRepasse)),
        };
      } catch (e: any) {
        return { ok: false as const, erro: e?.message ?? "Parâmetros inválidos" };
      }
    }),

  /** Marca (ou desmarca, com null) o envio do acordo para execução. */
  marcarEnviadoExecucao: authProc
    .input(z.object({ id: z.string(), data: zDataCal.nullable().optional() }))
    .mutation(async ({ input, ctx }) => {
      exigir(ctx);
      const a = await carregarAcordo(ctx, input.id);
      const enviadoExecucaoEm = input.data === null ? null : deDataCal(input.data ?? hojeCal());
      const novo = await prisma.acordo.update({ where: { id: a.id }, data: { enviadoExecucaoEm } });
      await registrarAudit(prisma, ctx, { emitenteId: a.emitenteId, entidade: "Acordo", entidadeId: a.id, acao: "atualizar", antes: { enviadoExecucaoEm: a.enviadoExecucaoEm }, depois: { enviadoExecucaoEm } });
      return novo;
    }),

  // ── Listagens ──────────────────────────────────────────────────────────────

  /** Quadro por status. Encerrados (homologado/sem_acordo) só dos últimos `diasEncerrados`. */
  quadro: authProc
    .input(z.object({
      pipelineId: z.string().optional(),
      emitenteId: z.string().optional(),
      responsavelId: z.string().optional(),
      tipo: z.enum(["previo", "posterior"]).optional(),
      busca: z.string().max(100).optional(),
      diasEncerrados: z.number().int().min(0).max(3650).default(90),
    }).optional())
    .query(async ({ input, ctx }) => {
      const i = input ?? { diasEncerrados: 90 };
      const corte = new Date(Date.now() - (i.diasEncerrados ?? 90) * 86_400_000);
      const busca = i.busca?.trim();
      const rows = await prisma.acordo.findMany({
        where: {
          deal: {
            ...whereDealDoTenant(ctx),
            ...(i.pipelineId ? { pipelineId: i.pipelineId } : {}),
            ...(busca ? { AND: [{ OR: [
              { titulo: { contains: busca, mode: "insensitive" } },
              { numeroCnj: { contains: busca } },
              { contato: { nome: { contains: busca, mode: "insensitive" } } },
            ] }] } : {}),
          },
          ...(i.emitenteId ? { emitenteId: i.emitenteId } : {}),
          ...(i.responsavelId ? { responsavelId: i.responsavelId } : {}),
          ...(i.tipo ? { tipo: i.tipo } : {}),
          OR: [{ status: { in: ABERTOS } }, { atualizadoEm: { gte: corte } }],
        },
        orderBy: [{ proximoFollowupEm: { sort: "asc", nulls: "last" } }, { atualizadoEm: "desc" }],
        take: 1000,
        include: { deal: { select: SELECT_DEAL_RESUMO }, rodadas: { orderBy: { data: "asc" } }, emitente: { select: { id: true, nome: true, nomeFantasia: true } } },
      });
      const nomes = await nomesUsuarios(rows.map((r) => r.responsavelId));
      const itens = rows.map((r) => acordoResumo(r, nomes));
      return {
        colunas: STATUS.map((status) => ({ status, itens: itens.filter((x) => x.status === status) })),
        total: itens.length,
      };
    }),

  /** Detalhe da negociação: acordo, rodadas, parcelas, deal, contato, empresa ré, avaliação, plano firmado. */
  detalhe: authProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const a = await carregarAcordo(ctx, input.id);
      const hoje = hojeCal();
      const nomes = await nomesUsuarios([a.responsavelId, a.criadoPorId, ...a.rodadas.map((r) => r.criadoPorId)]);
      const avaliacao = await prisma.acordoAvaliacao.findUnique({ where: { dealId: a.dealId } });
      return {
        ...acordoResumo(a, nomes),
        rodadas: a.rodadas.map((r) => ({
          id: r.id, data: cal(r.data), autor: r.autor, valor: reais(r.valor), obs: r.obs,
          criadoPorId: r.criadoPorId, criadoPorNome: r.criadoPorId ? nomes.get(r.criadoPorId) ?? null : null, criadoEm: r.criadoEm,
        })),
        parcelas: a.recebimentos.map((r) => parcelaResposta(r, hoje)),
        avaliacao: avaliacao ? { id: avaliacao.id, decisao: avaliacao.decisao, justificativa: avaliacao.justificativa, prazoEm: cal(avaliacao.prazoEm), decididoEm: avaliacao.decididoEm } : null,
        planoFirmado: await planoFirmado(a.id),
        emitentesOpcoes: (await emitentesDoDeal(ctx, a.deal)),
      };
    }),

  /** Histórico de acordos do deal + avaliação + se pode abrir nova tentativa (modal do deal). */
  doDeal: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input, ctx }) => {
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      const [acordos, avaliacao] = await Promise.all([
        prisma.acordo.findMany({
          where: { dealId: deal.id },
          orderBy: { criadoEm: "desc" },
          include: { deal: { select: SELECT_DEAL_RESUMO }, rodadas: { orderBy: { data: "asc" } }, emitente: { select: { id: true, nome: true, nomeFantasia: true } } },
        }),
        prisma.acordoAvaliacao.findUnique({ where: { dealId: deal.id } }),
      ]);
      const nomes = await nomesUsuarios([...acordos.map((a) => a.responsavelId), avaliacao?.responsavelId]);
      const lista = acordos.map((a) => acordoResumo(a, nomes));
      const aberto = lista.find((a) => ABERTOS.includes(a.status)) ?? null;
      return {
        deal: dealParaResposta(deal),
        acordos: lista,
        aberto,
        podeAbrir: !aberto,
        encerradoPorAcordo: lista.some((a) => a.status === "homologado"),
        avaliacao: avaliacao ? {
          id: avaliacao.id, decisao: avaliacao.decisao, justificativa: avaliacao.justificativa, prazoEm: cal(avaliacao.prazoEm),
          responsavelId: avaliacao.responsavelId, responsavelNome: avaliacao.responsavelId ? nomes.get(avaliacao.responsavelId) ?? null : null,
          acordoId: avaliacao.acordoId, decididoEm: avaliacao.decididoEm,
        } : null,
      };
    }),

  /** Follow-ups de acordos abertos: vencidos (antes de hoje), hoje e próximos `dias`. */
  followups: authProc
    .input(z.object({ dias: z.number().int().min(1).max(90).default(7), escopo: z.enum(["minhas", "todas"]).default("todas") }).optional())
    .query(async ({ input, ctx }) => {
      const dias = input?.dias ?? 7;
      const hoje = hojeCal();
      const ate = new Date(deDataCal(hoje).getTime() + dias * 86_400_000);
      const rows = await prisma.acordo.findMany({
        where: {
          deal: whereDealDoTenant(ctx), status: { in: ABERTOS }, proximoFollowupEm: { lte: ate },
          ...(input?.escopo === "minhas" ? { responsavelId: ctx.userId ?? "__none__" } : {}),
        },
        orderBy: { proximoFollowupEm: "asc" },
        take: 500,
        include: { deal: { select: SELECT_DEAL_RESUMO }, rodadas: { orderBy: { data: "asc" } }, emitente: { select: { id: true, nome: true, nomeFantasia: true } } },
      });
      const nomes = await nomesUsuarios(rows.map((r) => r.responsavelId));
      const itens = rows.map((r) => acordoResumo(r, nomes));
      return {
        vencidos: itens.filter((x) => x.proximoFollowupEm! < hoje),
        hoje: itens.filter((x) => x.proximoFollowupEm === hoje),
        proximos: itens.filter((x) => x.proximoFollowupEm! > hoje),
      };
    }),

  /** Emitentes possíveis para o deal (homologação/recebimentos) e a sugestão automática. */
  emitentesDoDeal: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input, ctx }) => {
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      return emitentesDoDeal(ctx, deal);
    }),

  /**
   * Busca de processos para os seletores (nova avaliação prévia, recebimento avulso): título,
   * nome do cliente ou número CNJ (com ou sem pontuação). Inclui encerrados (ganho/perdido) —
   * execução/sentença costuma ser lançada em processo já fechado. Isolado por tenant
   * (`whereDealDoTenant`, mesma regra de `carregarDealAcessivel`).
   */
  buscarDeals: authProc
    .input(z.object({
      busca: z.string().trim().min(2).max(100),
      limite: z.number().int().min(1).max(50).default(30),
      pipelineId: z.string().optional(),
      somenteProcessual: z.boolean().default(true),
    }))
    .query(async ({ input, ctx }) => {
      const busca = input.busca;
      const digitos = busca.replace(/\D/g, "");
      // CNJ gravado com ou sem máscara: compara só os dígitos (lista curta de ids, depois o filtro de tenant).
      const idsCnj = digitos.length >= 4
        ? (await prisma.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM "CrmDeal"
             WHERE "numeroCnj" IS NOT NULL
               AND regexp_replace("numeroCnj", '[^0-9]', '', 'g') LIKE ${"%" + digitos + "%"}
             LIMIT 500`).map((r) => r.id)
        : [];
      const rows = await prisma.crmDeal.findMany({
        where: {
          AND: [
            whereDealDoTenant(ctx),
            input.pipelineId ? { pipelineId: input.pipelineId } : {},
            input.somenteProcessual ? { pipeline: { tipo: "processual" } } : {},
            { OR: [
              { titulo: { contains: busca, mode: "insensitive" } },
              { contato: { nome: { contains: busca, mode: "insensitive" } } },
              { numeroCnj: { contains: busca } },
              ...(idsCnj.length ? [{ id: { in: idsCnj } }] : []),
            ] },
          ],
        },
        orderBy: [{ status: "asc" }, { atualizadoEm: "desc" }],
        take: input.limite,
        select: {
          id: true, titulo: true, numeroCnj: true, status: true,
          contato: { select: { nome: true } },
          stage: { select: { nome: true } },
          pipeline: { select: { id: true, nome: true } },
        },
      });
      return rows.map((d) => ({
        id: d.id, titulo: d.titulo, numeroCnj: d.numeroCnj, status: d.status,
        cliente: d.contato?.nome ?? null, stage: d.stage?.nome ?? null,
        pipelineId: d.pipeline?.id ?? null, pipeline: d.pipeline?.nome ?? null,
      }));
    }),

  /** Usuários que podem ser responsáveis pelo acordo (mesma regra do follow-up do CRM). */
  responsaveis: authProc
    .input(z.object({ dealId: z.string() }))
    .query(async ({ input, ctx }) => {
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      return usuariosDoFollowup(empresaDoDeal(deal));
    }),

  // ── Indicadores (§2.4) ─────────────────────────────────────────────────────

  /**
   * Indicadores do funil (geral + por empresa ré) e êxito judicial sem os encerrados por acordo.
   * Período (`de`/`ate`) = data de abertura do acordo; no êxito, data do ajuizamento.
   * Valores em centavos dentro de `geral`/`porEmpresa`/`exito` (ver lib/fin/acordo-indicadores.ts).
   */
  indicadores: authProc
    .input(z.object({
      de: zDataCal.optional(),
      ate: zDataCal.optional(),
      pipelineId: z.string().optional(),
      emitenteId: z.string().optional(),
    }).optional())
    .query(async ({ input, ctx }) => {
      const i = input ?? {};
      const hoje = hojeCal();
      const periodo = (i.de || i.ate) ? {
        ...(i.de ? { gte: new Date(deDataCal(i.de).getTime() - 12 * 3_600_000) } : {}),
        ...(i.ate ? { lt: new Date(deDataCal(i.ate).getTime() + 12 * 3_600_000) } : {}),
      } : undefined;
      const whereDeal: Prisma.CrmDealWhereInput = { ...whereDealDoTenant(ctx), ...(i.pipelineId ? { pipelineId: i.pipelineId } : {}) };

      const acordos = await prisma.acordo.findMany({
        where: { deal: whereDeal, ...(i.emitenteId ? { emitenteId: i.emitenteId } : {}), ...(periodo ? { criadoEm: periodo } : {}) },
        select: {
          id: true, tipo: true, status: true, faseOrigem: true, valorAcordo: true, estimativaCondenacao: true,
          firmadoEm: true, homologadoEm: true,
          deal: { select: { valorCausaAjuizada: true, valorEstimado: true, ajuizadoEm: true, organizacao: true, vinculos: { orderBy: { ordem: "asc" }, take: 1, select: { empresa: true } }, contato: { select: { empresa: true } } } },
          recebimentos: { select: { vencimento: true, dataRecebimento: true, valorPrevisto: true } },
        },
      });
      const lista: AcordoParaIndicador[] = acordos.map((a) => ({
        id: a.id, tipo: a.tipo, status: a.status, faseOrigem: a.faseOrigem,
        valorAcordo: a.valorAcordo === null ? null : paraCentavos(a.valorAcordo),
        valorCausa: a.deal.valorCausaAjuizada !== null ? paraCentavos(a.deal.valorCausaAjuizada) : a.deal.valorEstimado !== null ? paraCentavos(a.deal.valorEstimado) : null,
        estimativaCondenacao: a.estimativaCondenacao === null ? null : paraCentavos(a.estimativaCondenacao),
        ajuizadoEm: cal(a.deal.ajuizadoEm),
        fechadoEm: cal(a.homologadoEm ?? a.firmadoEm),
        empresa: empresaRe({ vinculos: a.deal.vinculos, contato: a.deal.contato, organizacao: a.deal.organizacao }),
        parcelas: a.recebimentos.map((r) => ({ vencimento: cal(r.vencimento), dataRecebimento: cal(r.dataRecebimento), valorPrevisto: r.valorPrevisto === null ? null : paraCentavos(r.valorPrevisto) })),
      }));

      const [avaliacoes, dealsExito] = await Promise.all([
        prisma.acordoAvaliacao.groupBy({
          by: ["decisao"],
          where: { deal: whereDeal, ...(periodo ? { criadoEm: periodo } : {}) },
          _count: { _all: true },
        }),
        prisma.crmDeal.findMany({
          where: { ...whereDeal, pipeline: { tipo: "processual" }, ...(periodo ? { ajuizadoEm: periodo } : {}) },
          select: { id: true, valorCondenacao: true, valorCausaAjuizada: true, valorEstimado: true, valorAcordo: true, acordos: { where: { status: "homologado" }, select: { id: true }, take: 1 } },
        }),
      ]);
      const contAv = Object.fromEntries(avaliacoes.map((g) => [g.decisao ?? "pendente", g._count._all]));
      const atrasadas = await prisma.acordoAvaliacao.count({ where: { deal: whereDeal, decisao: null, prazoEm: { lt: deDataCal(hoje) } } });

      return {
        geral: calcularIndicadores(lista, hoje),
        porEmpresa: indicadoresPorEmpresa(lista, hoje),
        avaliacoesPrevias: {
          total: Object.values(contAv).reduce((x, y) => x + y, 0),
          pendentes: contAv.pendente ?? 0,
          tentar: contAv.tentar ?? 0,
          naoTentar: contAv.nao_tentar ?? 0,
          atrasadas,
        },
        exito: calcularExito(dealsExito.map((d) => ({
          id: d.id,
          valorCondenacao: d.valorCondenacao === null ? null : paraCentavos(d.valorCondenacao),
          valorCausa: d.valorCausaAjuizada !== null ? paraCentavos(d.valorCausaAjuizada) : d.valorEstimado !== null ? paraCentavos(d.valorEstimado) : null,
          encerradoPorAcordo: d.acordos.length > 0 || d.valorAcordo !== null,
        }))),
        unidade: "centavos" as const,
      };
    }),
});
