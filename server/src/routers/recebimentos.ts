/**
 * Recebimentos (§1.6–1.8) — appRouter.recebimentos.
 *
 * Um só modelo (FinRecebimento) para parcela de acordo (acordoId + parcelaNumero; gerada em
 * `acordos.homologar`) e recebimento avulso de execução/sentença. Cada linha carrega sua baixa,
 * seu repasse ao cliente e sua NF. Receita do escritório = honorários + sucumbência; o repasse é
 * valor de terceiro (decisão 4).
 *
 * Permissões: leitura = módulo `financeiro` ou `financeiro_editar`; mutações = `financeiro_editar`
 * (lib/fin/perm.ts). Escopo por emitente (whereRecebimentoDoTenant / assertEmitenteDoTenant).
 * Toda mutação grava FinAuditLog.
 *
 * Resposta: valores em reais (number, 2 casas); datas-calendário "YYYY-MM-DD".
 * Os blocos `totais*` vêm de `totalizarRecebimentos` e estão em CENTAVOS (campo `unidade`).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { router } from "./trpc.js";
import { prisma } from "../db.js";
import { finLeituraProc, finEdicaoProc, assertEmitenteDoTenant } from "../lib/fin/perm.js";
import { registrarAudit } from "../lib/fin/audit.js";
import { deCentavos, paraCentavos, deDataCal } from "../lib/fin/util.js";
import {
  calcularHonorarios, statusRecebimento, diasEmAtraso, totalizarRecebimentos, centavosOuNull,
  type RecebimentoResumo, type RepasseStatus, type NfStatus,
} from "../lib/fin/recebimento.js";
import { receitaPorTipo } from "../lib/fin/acordo-indicadores.js";
import { pathAnexoDoEmitente } from "../lib/fin/anexos.js";
import { hojeCal } from "../lib/fin/acordo-avaliacao.js";
import {
  zDataCal, zValor, zArquivo, centavosDe, reais, cal, dataDe, carregarDealAcessivel, resolverEmitente, empresaRe,
} from "../lib/fin/acordo-comum.js";
import {
  coletarAlertas, diasRepasseConfig, whereRecebimentoDoTenant, CFG_REPASSE_DIAS, DIAS_REPASSE_PADRAO,
} from "../lib/fin/alertas-acordos.js";

const INCLUDE_REC = {
  deal: {
    select: {
      id: true, titulo: true, numeroCnj: true, ajuizadoEm: true, organizacao: true,
      contato: { select: { id: true, nome: true, empresa: true } },
      vinculos: { orderBy: { ordem: "asc" as const }, take: 1, select: { empresa: true } },
    },
  },
  acordo: { select: { id: true, tipo: true, status: true, valorAcordo: true } },
  emitente: { select: { id: true, nome: true, nomeFantasia: true } },
} satisfies Prisma.FinRecebimentoInclude;

type RecCompleto = Prisma.FinRecebimentoGetPayload<{ include: typeof INCLUDE_REC }>;

function resumoParaTotais(r: { vencimento: Date | null; dataRecebimento: Date | null; valorPrevisto: unknown; valorBruto: unknown; valorHonorarios: unknown; valorSucumbencia: unknown; valorRepasse: unknown; repasseStatus: string; nfStatus: string }): RecebimentoResumo {
  return {
    vencimento: cal(r.vencimento),
    dataRecebimento: cal(r.dataRecebimento),
    valorPrevistoCentavos: centavosOuNull(r.valorPrevisto as any),
    valorBrutoCentavos: centavosOuNull(r.valorBruto as any),
    valorHonorariosCentavos: centavosOuNull(r.valorHonorarios as any),
    valorSucumbenciaCentavos: centavosOuNull(r.valorSucumbencia as any),
    valorRepasseCentavos: centavosOuNull(r.valorRepasse as any),
    repasseStatus: r.repasseStatus as RepasseStatus,
    nfStatus: r.nfStatus as NfStatus,
  };
}

function resposta(r: RecCompleto, hoje: string) {
  const venc = cal(r.vencimento);
  const rec = cal(r.dataRecebimento);
  return {
    id: r.id,
    emitenteId: r.emitenteId,
    emitente: r.emitente,
    dealId: r.dealId,
    acordoId: r.acordoId,
    parcelaNumero: r.parcelaNumero,
    tipo: r.tipo,
    descricao: r.descricao,
    vencimento: venc,
    valorPrevisto: reais(r.valorPrevisto),
    dataRecebimento: rec,
    valorBruto: reais(r.valorBruto),
    percHonorarios: r.percHonorarios === null ? null : Number(r.percHonorarios),
    valorHonorarios: reais(r.valorHonorarios),
    valorSucumbencia: reais(r.valorSucumbencia),
    valorRepasse: reais(r.valorRepasse),
    receitaEscritorio: rec ? reais(deCentavos(paraCentavos(r.valorHonorarios) + paraCentavos(r.valorSucumbencia))) : null,
    comprovantePath: r.comprovantePath,
    comprovanteNome: r.comprovanteNome,
    repasseStatus: r.repasseStatus,
    repasseData: cal(r.repasseData),
    repasseComprovantePath: r.repasseComprovantePath,
    repasseComprovanteNome: r.repasseComprovanteNome,
    nfStatus: r.nfStatus,
    nfValor: reais(r.nfValor),
    nfNumero: r.nfNumero,
    nfData: cal(r.nfData),
    nfAnexoPath: r.nfAnexoPath,
    nfAnexoNome: r.nfAnexoNome,
    notaFiscalId: r.notaFiscalId,
    obs: r.obs,
    status: statusRecebimento({ vencimento: venc, dataRecebimento: rec }, hoje),
    diasAtraso: diasEmAtraso({ vencimento: venc, dataRecebimento: rec }, hoje),
    deal: r.deal ? {
      id: r.deal.id, titulo: r.deal.titulo, numeroCnj: r.deal.numeroCnj, ajuizadoEm: cal(r.deal.ajuizadoEm),
      contato: r.deal.contato ? { id: r.deal.contato.id, nome: r.deal.contato.nome } : null,
      empresaRe: empresaRe({ vinculos: r.deal.vinculos, contato: r.deal.contato, organizacao: r.deal.organizacao }),
    } : null,
    acordo: r.acordo ? { id: r.acordo.id, tipo: r.acordo.tipo, status: r.acordo.status, valorAcordo: reais(r.acordo.valorAcordo) } : null,
    criadoPorId: r.criadoPorId,
    criadoEm: r.criadoEm,
    atualizadoEm: r.atualizadoEm,
  };
}

async function carregarRec(ctx: Parameters<typeof whereRecebimentoDoTenant>[0], id: string): Promise<RecCompleto> {
  const r = await prisma.finRecebimento.findFirst({ where: { AND: [{ id }, whereRecebimentoDoTenant(ctx)] }, include: INCLUDE_REC });
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Recebimento não encontrado" });
  return r;
}

const semRelacoes = (r: RecCompleto) => {
  const { deal: _d, acordo: _a, emitente: _e, ...resto } = r;
  return resto;
};

function intervalo(de?: string, ate?: string): Prisma.DateTimeNullableFilter | undefined {
  if (!de && !ate) return undefined;
  // datas gravadas às 12:00 UTC: [de 00:00 UTC, ate 23:59 UTC] cobre o dia inteiro
  return {
    ...(de ? { gte: new Date(deDataCal(de).getTime() - 12 * 3_600_000) } : {}),
    ...(ate ? { lt: new Date(deDataCal(ate).getTime() + 12 * 3_600_000) } : {}),
  };
}

const zFiltros = z.object({
  emitenteId: z.string().optional(),
  tipo: z.enum(["acordo", "execucao"]).optional(),
  status: z.enum(["prevista", "recebida", "em_atraso"]).optional(),
  repasseStatus: z.enum(["pendente", "realizado", "nao_aplicavel"]).optional(),
  nfStatus: z.enum(["a_emitir", "emitida", "nao_aplicavel"]).optional(),
  campoData: z.enum(["vencimento", "recebimento", "repasse", "nf"]).default("vencimento"),
  de: zDataCal.optional(),
  ate: zDataCal.optional(),
  dealId: z.string().optional(),
  acordoId: z.string().optional(),
  busca: z.string().max(100).optional(),
});

function montarWhere(ctx: Parameters<typeof whereRecebimentoDoTenant>[0], f: z.infer<typeof zFiltros>, hoje: string): Prisma.FinRecebimentoWhereInput {
  const and: Prisma.FinRecebimentoWhereInput[] = [whereRecebimentoDoTenant(ctx)];
  if (f.emitenteId) and.push({ emitenteId: f.emitenteId });
  if (f.tipo) and.push({ tipo: f.tipo });
  if (f.repasseStatus) and.push({ repasseStatus: f.repasseStatus });
  if (f.nfStatus) and.push({ nfStatus: f.nfStatus });
  if (f.dealId) and.push({ dealId: f.dealId });
  if (f.acordoId) and.push({ acordoId: f.acordoId });
  const hojeD = deDataCal(hoje);
  if (f.status === "recebida") and.push({ dataRecebimento: { not: null } });
  if (f.status === "em_atraso") and.push({ dataRecebimento: null, vencimento: { lt: hojeD } });
  if (f.status === "prevista") and.push({ dataRecebimento: null, OR: [{ vencimento: null }, { vencimento: { gte: hojeD } }] });
  const per = intervalo(f.de, f.ate);
  if (per) {
    const campo = { vencimento: "vencimento", recebimento: "dataRecebimento", repasse: "repasseData", nf: "nfData" }[f.campoData] as "vencimento";
    and.push({ [campo]: per });
  }
  const b = f.busca?.trim();
  if (b) and.push({ OR: [
    { descricao: { contains: b, mode: "insensitive" } },
    { nfNumero: { contains: b } },
    { deal: { titulo: { contains: b, mode: "insensitive" } } },
    { deal: { numeroCnj: { contains: b } } },
    { deal: { contato: { nome: { contains: b, mode: "insensitive" } } } },
  ] });
  return { AND: and };
}

/** Anexo (comprovante/NF) tem de ser um upload do MESMO emitente do recebimento (como em financeiro.ts). */
function exigirAnexoDoEmitente(path: string | null | undefined, emitenteId: string): void {
  if (path && !pathAnexoDoEmitente(path, emitenteId)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "anexo inválido para esta empresa emissora" });
  }
}

async function validarNotaFiscal(notaFiscalId: string, emitenteId: string) {
  const nf = await prisma.notaFiscal.findUnique({ where: { id: notaFiscalId }, select: { id: true, emitenteId: true, numero: true, emitidoEm: true, valor: true } });
  if (!nf || nf.emitenteId !== emitenteId) throw new TRPCError({ code: "BAD_REQUEST", message: "Nota fiscal não encontrada para esta empresa emissora" });
  return nf;
}

export const recebimentosRouter = router({
  /** Lista com filtros + totais (centavos) geral, por tipo e valores de terceiros. */
  listar: finLeituraProc
    .input(zFiltros.extend({ limite: z.number().int().min(1).max(2000).default(500) }).optional())
    .query(async ({ input, ctx }) => {
      const f = input ?? zFiltros.extend({ limite: z.number().default(500) }).parse({});
      const hoje = hojeCal();
      const where = montarWhere(ctx, f, hoje);
      const rows = await prisma.finRecebimento.findMany({
        where,
        orderBy: [{ vencimento: { sort: "asc", nulls: "last" } }, { parcelaNumero: "asc" }, { criadoEm: "asc" }],
        take: f.limite,
        include: INCLUDE_REC,
      });
      // Totais sobre TODOS os registros do filtro (não só a página)
      const todos = await prisma.finRecebimento.findMany({
        where,
        select: { tipo: true, vencimento: true, dataRecebimento: true, valorPrevisto: true, valorBruto: true, valorHonorarios: true, valorSucumbencia: true, valorRepasse: true, repasseStatus: true, nfStatus: true },
      });
      const res = todos.map((r) => ({ tipo: r.tipo, ...resumoParaTotais(r) }));
      return {
        itens: rows.map((r) => resposta(r, hoje)),
        total: todos.length,
        totais: totalizarRecebimentos(res, hoje),
        totaisPorTipo: {
          acordo: totalizarRecebimentos(res.filter((r) => r.tipo === "acordo"), hoje),
          execucao: totalizarRecebimentos(res.filter((r) => r.tipo === "execucao"), hoje),
        },
        unidade: "centavos" as const,
      };
    }),

  obter: finLeituraProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => resposta(await carregarRec(ctx, input.id), hojeCal())),

  /** Recebimento avulso (execução/sentença) ou parcela extra de acordo, vinculado ao deal. */
  criar: finEdicaoProc
    .input(z.object({
      dealId: z.string(),
      emitenteId: z.string().optional(), // default: único emitente ativo da empresa do deal
      tipo: z.enum(["execucao", "acordo"]),
      acordoId: z.string().optional(),
      parcelaNumero: z.number().int().min(0).max(999).optional(),
      descricao: z.string().max(500).nullable().optional(),
      vencimento: zDataCal.nullable().optional(),
      valorPrevisto: zValor.nullable().optional(),
      percHonorarios: z.number().min(0).max(100).nullable().optional(),
      semRepasse: z.boolean().default(false), // ex.: sucumbência/honorário puro
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const deal = await carregarDealAcessivel(ctx, input.dealId);
      const emitenteId = await resolverEmitente(ctx, deal, input.emitenteId);
      if (input.acordoId) {
        const a = await prisma.acordo.findUnique({ where: { id: input.acordoId }, select: { dealId: true } });
        if (!a || a.dealId !== deal.id) throw new TRPCError({ code: "BAD_REQUEST", message: "Acordo não pertence a este processo" });
        if (input.tipo !== "acordo") throw new TRPCError({ code: "BAD_REQUEST", message: "Recebimento ligado a acordo deve ser do tipo acordo" });
      }
      if (input.parcelaNumero !== undefined && !input.acordoId) throw new TRPCError({ code: "BAD_REQUEST", message: "parcelaNumero só com acordoId" });
      const prevC = input.valorPrevisto === null || input.valorPrevisto === undefined ? null : centavosDe(input.valorPrevisto);
      let hon: number | null = null, rep: number | null = null;
      if (prevC !== null) {
        const c = calcularHonorarios({ valorBrutoCentavos: prevC, percHonorarios: input.percHonorarios ?? null, repasseStatus: input.semRepasse ? "nao_aplicavel" : "pendente" });
        hon = c.honorarios; rep = c.repasse;
      }
      try {
        const r = await prisma.finRecebimento.create({
          data: {
            emitenteId, dealId: deal.id, acordoId: input.acordoId ?? null, parcelaNumero: input.parcelaNumero ?? null,
            tipo: input.tipo, descricao: input.descricao?.trim() || null,
            vencimento: dataDe(input.vencimento) ?? null,
            valorPrevisto: prevC === null ? null : deCentavos(prevC),
            percHonorarios: input.semRepasse ? "100.00" : input.percHonorarios == null ? null : input.percHonorarios.toFixed(2),
            valorHonorarios: hon === null ? null : deCentavos(hon),
            valorRepasse: rep === null ? null : deCentavos(rep),
            repasseStatus: input.semRepasse ? "nao_aplicavel" : "pendente",
            nfValor: hon === null ? null : deCentavos(hon),
            obs: input.obs?.trim() || null,
            criadoPorId: ctx.userId ?? null,
          },
          include: INCLUDE_REC,
        });
        await registrarAudit(prisma, ctx, { emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "criar", depois: semRelacoes(r) });
        return resposta(r, hojeCal());
      } catch (e: any) {
        if (e?.code === "P2002") throw new TRPCError({ code: "CONFLICT", message: "Já existe esta parcela no acordo" });
        throw e;
      }
    }),

  /** Edita dados previstos (descrição, vencimento, valor previsto, %, obs). */
  atualizar: finEdicaoProc
    .input(z.object({
      id: z.string(),
      descricao: z.string().max(500).nullable().optional(),
      vencimento: zDataCal.nullable().optional(),
      valorPrevisto: zValor.nullable().optional(),
      percHonorarios: z.number().min(0).max(100).nullable().optional(),
      valorSucumbencia: zValor.optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const r = await carregarRec(ctx, input.id);
      const data: Prisma.FinRecebimentoUncheckedUpdateInput = {};
      if (input.descricao !== undefined) data.descricao = input.descricao?.trim() || null;
      if (input.vencimento !== undefined) data.vencimento = dataDe(input.vencimento);
      if (input.obs !== undefined) data.obs = input.obs?.trim() || null;
      if (input.valorSucumbencia !== undefined) data.valorSucumbencia = deCentavos(centavosDe(input.valorSucumbencia));
      if (input.percHonorarios !== undefined) data.percHonorarios = input.percHonorarios === null ? null : input.percHonorarios.toFixed(2);
      if (input.valorPrevisto !== undefined) data.valorPrevisto = input.valorPrevisto === null ? null : deCentavos(centavosDe(input.valorPrevisto));
      // Ainda não recebido: recalcula honorários/repasse previstos
      if (!r.dataRecebimento && (input.valorPrevisto !== undefined || input.percHonorarios !== undefined)) {
        const prev = input.valorPrevisto !== undefined ? (input.valorPrevisto === null ? null : centavosDe(input.valorPrevisto)) : centavosOuNull(r.valorPrevisto);
        const perc = input.percHonorarios !== undefined ? input.percHonorarios : r.percHonorarios;
        if (prev !== null) {
          const c = calcularHonorarios({ valorBrutoCentavos: prev, percHonorarios: perc, repasseStatus: r.repasseStatus as RepasseStatus });
          data.valorHonorarios = deCentavos(c.honorarios);
          data.valorRepasse = deCentavos(c.repasse);
          if (r.nfStatus === "a_emitir") data.nfValor = deCentavos(c.honorarios);
        }
      }
      const novo = await prisma.finRecebimento.update({ where: { id: r.id }, data, include: INCLUDE_REC });
      await registrarAudit(prisma, ctx, { emitenteId: r.emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "atualizar", antes: semRelacoes(r), depois: semRelacoes(novo) });
      return resposta(novo, hojeCal());
    }),

  /** Exclui. Bloqueado se já recebido (estorne a baixa antes) ou com NF emitida. */
  excluir: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const r = await carregarRec(ctx, input.id);
      if (r.dataRecebimento) throw new TRPCError({ code: "BAD_REQUEST", message: "Recebimento já baixado — estorne a baixa antes de excluir" });
      if (r.nfStatus === "emitida") throw new TRPCError({ code: "BAD_REQUEST", message: "Há NF emitida para este recebimento" });
      await prisma.finRecebimento.delete({ where: { id: r.id } });
      await registrarAudit(prisma, ctx, { emitenteId: r.emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "excluir", antes: semRelacoes(r) });
      return { ok: true };
    }),

  /**
   * Baixa: data, valor bruto efetivamente recebido, comprovante. Honorários = bruto × %
   * (ou `honorarios` informado); repasse = bruto − honorários; sucumbência à parte (sem repasse).
   * NF sugerida = honorários + sucumbência (só o que é do escritório) se a NF ainda não foi emitida.
   */
  baixar: finEdicaoProc
    .input(z.object({
      id: z.string(),
      dataRecebimento: zDataCal,
      valorBruto: zValor,
      percHonorarios: z.number().min(0).max(100).nullable().optional(), // default: o gravado
      honorarios: zValor.nullable().optional(), // valor informado prevalece sobre o %
      valorSucumbencia: zValor.optional(),
      semRepasse: z.boolean().optional(),
      comprovantePath: zArquivo.nullable().optional(),
      comprovanteNome: z.string().max(300).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const r = await carregarRec(ctx, input.id);
      exigirAnexoDoEmitente(input.comprovantePath, r.emitenteId);
      if (r.repasseStatus === "realizado") throw new TRPCError({ code: "BAD_REQUEST", message: "Repasse já realizado — estorne o repasse antes de refazer a baixa" });
      const perc = input.percHonorarios !== undefined ? input.percHonorarios : r.percHonorarios;
      const semRepasse = input.semRepasse ?? r.repasseStatus === "nao_aplicavel";
      let c;
      try {
        c = calcularHonorarios({
          valorBrutoCentavos: centavosDe(input.valorBruto),
          percHonorarios: perc,
          honorariosInformadosCentavos: input.honorarios === null || input.honorarios === undefined ? null : centavosDe(input.honorarios),
          valorSucumbenciaCentavos: input.valorSucumbencia !== undefined ? centavosDe(input.valorSucumbencia) : paraCentavos(r.valorSucumbencia),
          repasseStatus: semRepasse ? "nao_aplicavel" : "pendente",
        });
      } catch (e: any) {
        throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Valores inválidos" });
      }
      if (c.bruto < 0 || c.honorarios < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Valores negativos" });
      const novo = await prisma.finRecebimento.update({
        where: { id: r.id },
        data: {
          dataRecebimento: deDataCal(input.dataRecebimento),
          valorBruto: deCentavos(c.bruto),
          percHonorarios: semRepasse ? "100.00" : perc === null || perc === undefined ? null : Number(perc).toFixed(2),
          valorHonorarios: deCentavos(c.honorarios),
          valorRepasse: deCentavos(c.repasse),
          valorSucumbencia: deCentavos(c.sucumbencia),
          repasseStatus: semRepasse || c.repasse === 0 ? "nao_aplicavel" : "pendente",
          ...(input.comprovantePath !== undefined ? { comprovantePath: input.comprovantePath } : {}),
          ...(input.comprovanteNome !== undefined ? { comprovanteNome: input.comprovanteNome } : {}),
          ...(r.nfStatus === "a_emitir" ? { nfValor: deCentavos(c.nfValorSugerido) } : {}),
        },
        include: INCLUDE_REC,
      });
      await registrarAudit(prisma, ctx, { emitenteId: r.emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "atualizar", antes: semRelacoes(r), depois: { ...semRelacoes(novo), calculo: c } });
      return { ...resposta(novo, hojeCal()), calculo: {
        bruto: reais(deCentavos(c.bruto)), honorarios: reais(deCentavos(c.honorarios)), repasse: reais(deCentavos(c.repasse)),
        sucumbencia: reais(deCentavos(c.sucumbencia)), receitaEscritorio: reais(deCentavos(c.receitaEscritorio)), nfValorSugerido: reais(deCentavos(c.nfValorSugerido)),
      } };
    }),

  /** Desfaz a baixa (volta a prevista/em atraso). Bloqueado com repasse realizado ou NF emitida. */
  estornarBaixa: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const r = await carregarRec(ctx, input.id);
      if (!r.dataRecebimento) throw new TRPCError({ code: "BAD_REQUEST", message: "Recebimento não está baixado" });
      if (r.repasseStatus === "realizado") throw new TRPCError({ code: "BAD_REQUEST", message: "Repasse já realizado" });
      if (r.nfStatus === "emitida") throw new TRPCError({ code: "BAD_REQUEST", message: "NF já emitida" });
      const prev = centavosOuNull(r.valorPrevisto);
      // A baixa marca "nao_aplicavel" também quando o repasse calculado deu 0 (honorários = bruto).
      // Só é "sem repasse" de verdade quando o % gravado é 100 (semRepasse grava "100.00").
      const repasseStatus: RepasseStatus = r.repasseStatus === "nao_aplicavel" && (r.percHonorarios === null || Number(r.percHonorarios) < 100)
        ? "pendente" : r.repasseStatus as RepasseStatus;
      const c = prev !== null ? calcularHonorarios({ valorBrutoCentavos: prev, percHonorarios: r.percHonorarios, repasseStatus }) : null;
      const novo = await prisma.finRecebimento.update({
        where: { id: r.id },
        data: {
          dataRecebimento: null, valorBruto: null, comprovantePath: null, comprovanteNome: null,
          valorHonorarios: c ? deCentavos(c.honorarios) : null, valorRepasse: c ? deCentavos(c.repasse) : null,
          nfValor: c ? deCentavos(c.honorarios) : null,
          // a sucumbência informada na baixa era do recebimento desfeito: não pode seguir projetada no fluxo
          valorSucumbencia: "0",
          repasseStatus,
        },
        include: INCLUDE_REC,
      });
      await registrarAudit(prisma, ctx, { emitenteId: r.emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "atualizar", antes: semRelacoes(r), depois: semRelacoes(novo) });
      return resposta(novo, hojeCal());
    }),

  /** Repasse ao cliente: pendente | realizado (data + comprovante) | nao_aplicavel. */
  repasse: finEdicaoProc
    .input(z.object({
      id: z.string(),
      status: z.enum(["pendente", "realizado", "nao_aplicavel"]),
      data: zDataCal.nullable().optional(), // default hoje quando realizado
      comprovantePath: zArquivo.nullable().optional(),
      comprovanteNome: z.string().max(300).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const r = await carregarRec(ctx, input.id);
      exigirAnexoDoEmitente(input.comprovantePath, r.emitenteId);
      if (input.status === "realizado" && !r.dataRecebimento) throw new TRPCError({ code: "BAD_REQUEST", message: "Dê baixa no recebimento antes do repasse" });
      if (input.status === "nao_aplicavel" && paraCentavos(r.valorRepasse) > 0 && r.dataRecebimento) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Há valor a repassar — refaça a baixa sem repasse para marcar como não aplicável" });
      }
      const novo = await prisma.finRecebimento.update({
        where: { id: r.id },
        data: {
          repasseStatus: input.status,
          repasseData: input.status === "realizado" ? deDataCal(input.data ?? hojeCal()) : null,
          ...(input.comprovantePath !== undefined ? { repasseComprovantePath: input.comprovantePath } : {}),
          ...(input.comprovanteNome !== undefined ? { repasseComprovanteNome: input.comprovanteNome } : {}),
          ...(input.status !== "realizado" ? { repasseComprovantePath: null, repasseComprovanteNome: null } : {}),
        },
        include: INCLUDE_REC,
      });
      await registrarAudit(prisma, ctx, { emitenteId: r.emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "atualizar", antes: semRelacoes(r), depois: semRelacoes(novo) });
      return resposta(novo, hojeCal());
    }),

  /**
   * NF do recebimento: a_emitir | emitida | nao_aplicavel. Valor = só o que é do escritório
   * (honorários + sucumbência). `notaFiscalId` liga a uma NotaFiscal do Avoce do MESMO emitente
   * (número/data vêm dela se não informados).
   */
  nf: finEdicaoProc
    .input(z.object({
      id: z.string(),
      status: z.enum(["a_emitir", "emitida", "nao_aplicavel"]),
      valor: zValor.nullable().optional(),
      numero: z.string().max(60).nullable().optional(),
      data: zDataCal.nullable().optional(),
      anexoPath: zArquivo.nullable().optional(),
      anexoNome: z.string().max(300).nullable().optional(),
      notaFiscalId: z.string().nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const r = await carregarRec(ctx, input.id);
      exigirAnexoDoEmitente(input.anexoPath, r.emitenteId);
      const data: Prisma.FinRecebimentoUncheckedUpdateInput = { nfStatus: input.status };
      if (input.notaFiscalId !== undefined) {
        data.notaFiscalId = input.notaFiscalId;
        if (input.notaFiscalId) {
          const nf = await validarNotaFiscal(input.notaFiscalId, r.emitenteId);
          if (input.numero === undefined && nf.numero) data.nfNumero = nf.numero;
          if (input.data === undefined && nf.emitidoEm) data.nfData = deDataCal(cal(nf.emitidoEm)!);
          if (input.valor === undefined) data.nfValor = deCentavos(nf.valor); // NotaFiscal.valor em centavos (Int)
        }
      }
      if (input.valor !== undefined) data.nfValor = input.valor === null ? null : deCentavos(centavosDe(input.valor));
      if (input.numero !== undefined) data.nfNumero = input.numero?.trim() || null;
      if (input.data !== undefined) data.nfData = dataDe(input.data);
      if (input.anexoPath !== undefined) data.nfAnexoPath = input.anexoPath;
      if (input.anexoNome !== undefined) data.nfAnexoNome = input.anexoNome;
      if (input.status === "emitida" && input.data === undefined && !r.nfData && data.nfData === undefined) data.nfData = deDataCal(hojeCal());
      const novo = await prisma.finRecebimento.update({ where: { id: r.id }, data, include: INCLUDE_REC });
      await registrarAudit(prisma, ctx, { emitenteId: r.emitenteId, entidade: "FinRecebimento", entidadeId: r.id, acao: "atualizar", antes: semRelacoes(r), depois: semRelacoes(novo) });
      return resposta(novo, hojeCal());
    }),

  /** NotaFiscal do emitente para vincular ao recebimento (mais recentes primeiro). */
  notasDisponiveis: finLeituraProc
    .input(z.object({ emitenteId: z.string(), busca: z.string().max(60).optional() }))
    .query(async ({ input, ctx }) => {
      await assertEmitenteDoTenant(ctx, input.emitenteId);
      const b = input.busca?.trim();
      const notas = await prisma.notaFiscal.findMany({
        where: { emitenteId: input.emitenteId, ...(b ? { OR: [{ numero: { contains: b } }, { competencia: { contains: b } }] } : {}) },
        orderBy: { criadoEm: "desc" },
        take: 50,
        select: { id: true, numero: true, competencia: true, valor: true, status: true, emitidoEm: true, contrato: { select: { id: true } } },
      });
      return notas.map((n) => ({ ...n, valor: Number(deCentavos(n.valor)), emitidoEm: cal(n.emitidoEm) }));
    }),

  /** Valores de terceiros: repasses pendentes (passivo; sai do caixa disponível). */
  valoresTerceiros: finLeituraProc
    .input(z.object({ emitenteId: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const hoje = hojeCal();
      const rows = await prisma.finRecebimento.findMany({
        where: { AND: [whereRecebimentoDoTenant(ctx), input?.emitenteId ? { emitenteId: input.emitenteId } : {}, { dataRecebimento: { not: null }, repasseStatus: "pendente" }] },
        orderBy: { dataRecebimento: "asc" },
        take: 1000,
        include: INCLUDE_REC,
      });
      const total = rows.reduce((a, r) => a + paraCentavos(r.valorRepasse), 0);
      return { total: Number(deCentavos(total)), qtd: rows.length, itens: rows.map((r) => resposta(r, hoje)) };
    }),

  /**
   * Relatório acordo × execução no período (data do recebimento) + receita por tipo com ticket
   * médio e tempo médio ajuizamento → 1º recebimento (§1.9). Valores em centavos.
   */
  relatorio: finLeituraProc
    .input(z.object({ de: zDataCal.optional(), ate: zDataCal.optional(), emitenteId: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const hoje = hojeCal();
      const per = intervalo(input?.de, input?.ate);
      const base: Prisma.FinRecebimentoWhereInput = { AND: [whereRecebimentoDoTenant(ctx), input?.emitenteId ? { emitenteId: input.emitenteId } : {}] };
      const [recebidos, previstos] = await Promise.all([
        prisma.finRecebimento.findMany({
          where: { AND: [base, { dataRecebimento: per ?? { not: null } }] },
          select: { tipo: true, dealId: true, vencimento: true, dataRecebimento: true, valorPrevisto: true, valorBruto: true, valorHonorarios: true, valorSucumbencia: true, valorRepasse: true, repasseStatus: true, nfStatus: true, deal: { select: { ajuizadoEm: true } } },
        }),
        prisma.finRecebimento.findMany({
          where: { AND: [base, { dataRecebimento: null }, per ? { vencimento: per } : {}] },
          select: { tipo: true, vencimento: true, dataRecebimento: true, valorPrevisto: true, valorBruto: true, valorHonorarios: true, valorSucumbencia: true, valorRepasse: true, repasseStatus: true, nfStatus: true },
        }),
      ]);
      const tot = (tipo: string) => totalizarRecebimentos(
        [...recebidos, ...previstos].filter((r) => r.tipo === tipo).map(resumoParaTotais), hoje,
      );
      return {
        acordo: tot("acordo"),
        execucao: tot("execucao"),
        geral: totalizarRecebimentos([...recebidos, ...previstos].map(resumoParaTotais), hoje),
        receitaPorTipo: receitaPorTipo(recebidos.map((r) => ({
          tipo: r.tipo, dealId: r.dealId, dataRecebimento: cal(r.dataRecebimento),
          receitaEscritorio: r.repasseStatus === "nao_aplicavel"
            ? paraCentavos(r.valorBruto ?? r.valorPrevisto) + paraCentavos(r.valorSucumbencia)
            : paraCentavos(r.valorHonorarios) + paraCentavos(r.valorSucumbencia),
          bruto: paraCentavos(r.valorBruto ?? r.valorPrevisto),
          ajuizadoEm: cal(r.deal?.ajuizadoEm),
        }))),
        unidade: "centavos" as const,
      };
    }),

  /** Alertas (parcela vencida, repasse pendente há +X dias, sem NF, follow-up vencido, avaliação prévia). */
  alertas: finLeituraProc
    .input(z.object({ emitenteId: z.string().optional(), diasRepasse: z.number().int().min(0).max(365).optional(), limite: z.number().int().min(1).max(500).default(100) }).optional())
    .query(async ({ input, ctx }) => {
      const dias = input?.diasRepasse ?? (await diasRepasseConfig(ctx.empresaId));
      return coletarAlertas({ ctx, diasRepasse: dias, emitenteId: input?.emitenteId, limite: input?.limite ?? 100 });
    }),

  /** X dias do alerta de repasse pendente (Configuracao por empresa; default 5). */
  configAlertas: finLeituraProc.query(async ({ ctx }) => ({
    diasRepasse: await diasRepasseConfig(ctx.empresaId),
    padrao: DIAS_REPASSE_PADRAO,
  })),

  salvarConfigAlertas: finEdicaoProc
    .input(z.object({ diasRepasse: z.number().int().min(0).max(365) }))
    .mutation(async ({ input, ctx }) => {
      const chave = `${CFG_REPASSE_DIAS}:${ctx.empresaId ?? "global"}`;
      if (!ctx.empresaId && ctx.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Sem empresa" });
      const antes = await prisma.configuracao.findUnique({ where: { chave } });
      const cfg = await prisma.configuracao.upsert({ where: { chave }, create: { chave, valor: String(input.diasRepasse) }, update: { valor: String(input.diasRepasse) } });
      await registrarAudit(prisma, ctx, { entidade: "Configuracao", entidadeId: chave, acao: antes ? "atualizar" : "criar", antes, depois: cfg });
      return { diasRepasse: input.diasRepasse };
    }),
});
