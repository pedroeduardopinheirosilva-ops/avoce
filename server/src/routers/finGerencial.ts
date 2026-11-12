/**
 * Financeiro gerencial (appRouter.fin) — plano PLANO-AJUSTES-FINANCEIRO-ACORDOS.md, Fase 2A.
 *
 * Convenções da API:
 *  - Toda rota é por emitente (EmpresaEmitente): `emitenteId` explícito ou derivado do registro, sempre
 *    validado com `assertEmitenteDoTenant` (lista de emitentes do usuário + tenant).
 *  - Leitura exige módulo `financeiro` ou `financeiro_editar`; mutação exige `financeiro_editar`
 *    (permissões null / sem lista de módulos / role admin = acesso total). Toda mutação grava FinAuditLog.
 *  - Entrada: valores em reais (number), datas "YYYY-MM-DD", meses "YYYY-MM".
 *  - Saída: registros do Prisma vêm crus (Decimal como string, DateTime ISO); tudo que é CALCULADO
 *    (extratos, cronogramas, relatórios, painel) vem em reais (number, 2 casas) e datas "YYYY-MM-DD".
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router } from "./trpc.js";
import { prisma } from "../db.js";
import { registrarAudit } from "../lib/fin/audit.js";
import { assertEmitenteDoTenant, finEdicaoProc, finLeituraProc, type CtxPerm } from "../lib/fin/perm.js";
import { FONTES_PADRAO, TIPOS_FONTE, fontePadraoDoTipo, garantirFontesPadrao } from "../lib/fin/fontes.js";
import {
  CATEGORIAS_DESPESA, normalizarCategoriaDespesa, normalizarCategoriaReceita,
} from "../lib/fin/categorias.js";
import { INCLUDE_LANCAMENTO, calLancamento, dateDeEntrada, gravarRateio } from "../lib/fin/lancamentos.js";
import { reescalarRateio } from "../lib/fin/rateio.js";
import { chaveOcorrencia, projetarRecorrencias, type OrigemRecorrente } from "../lib/fin/recorrencia.js";
import { carregarTabelasIndices, importarIndicesBcb } from "../lib/fin/indices-sync.js";
import { type Indice, type TabelaIndice } from "../lib/fin/indices.js";
import { extratoEmprestimoPsa, type MovPsa, type TipoMovEmprestimo } from "../lib/fin/emprestimo-psa.js";
import {
  cronogramaEmprestimoBancario, jurosNoPeriodo, saldoDevedorNaData,
  type CarenciaModo, type ParamsEmprestimoBancario, type SistemaAmortizacao,
} from "../lib/fin/emprestimo-bancario.js";
import {
  custoLiquidoEmprestimo, extratoAplicacao, irSugerido, aliquotaIrRegressivo, resgatesPorFonte, saldoAplicacao,
  sugerirRendimentoMes, taxaAplicacaoMes, type IndexadorAplicacao, type MovAplicacao, type TipoMovAplicacao,
} from "../lib/fin/aplicacao.js";
import { caixaDisponivel, centavosOuNull, totalizarRecebimentos, type NfStatus, type RepasseStatus } from "../lib/fin/recebimento.js";
import { eventosDeRecebimento, montarFluxoCaixa, projetarRendimento, type EventoFluxo } from "../lib/fin/fluxo.js";
import { consumoPorFonte, montarDre, orcadoRealizado, type ItemCategoriaMes, type ItemConsumo } from "../lib/fin/relatorios.js";
import { emReais } from "../lib/fin/saida.js";
import {
  addMeses, chaveMes, compararMes, deCentavos, deDataCal, diasEntre, idxMes, mesDe, mesesEntre,
  paraCentavos, paraDataCal, paraTaxaPct, primeiroDia, ultimoDia, type Centavos, type DataCal, type MesRef,
} from "../lib/fin/util.js";

// ── Validadores / utilitários ───────────────────────────────────────────────

const zMes = z.string().regex(/^\d{4}-\d{2}$/, "mês no formato AAAA-MM");
const zDataCal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data no formato AAAA-MM-DD");
const zValor = z.number().finite().positive();
const zValorOpc = z.number().finite().min(0).nullable().optional();

const TIPOS_MOV_EMPRESTIMO = ["saldo_inicial", "aporte", "amortizacao", "devolucao", "pagamento_juros", "pagamento_parcela"] as const;
const TIPOS_PAGAMENTO_BANCO: ReadonlySet<string> = new Set(["pagamento_parcela", "pagamento_juros", "amortizacao", "devolucao"]);
const TIPOS_MOV_APLICACAO = ["aplicacao", "resgate", "rendimento", "ir"] as const;

function hoje(): DataCal {
  return paraDataCal(new Date());
}

function mesDeStr(s: string): MesRef {
  return { ano: Number(s.slice(0, 4)), mes: Number(s.slice(5, 7)) };
}

function dinheiro(v: number): string {
  return deCentavos(paraCentavos(v));
}

function dinheiroOpc(v: number | null | undefined): string | null | undefined {
  return v === undefined ? undefined : v === null ? null : dinheiro(v);
}

function naoEncontrado(o: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `${o} não encontrado(a)` });
}

/** Faixa de busca tolerante (±1 dia) para colunas DateTime; o corte fino é por DataCal em JS. */
function faixaBusca(de: MesRef, ate: MesRef): { gte: Date; lte: Date } {
  const a = deDataCal(primeiroDia(de));
  const b = deDataCal(ultimoDia(ate));
  return { gte: new Date(a.getTime() - 86_400_000), lte: new Date(b.getTime() + 86_400_000) };
}

function noIntervalo(d: DataCal, de: MesRef, ate: MesRef): boolean {
  const m = mesDe(d);
  return compararMes(m, de) >= 0 && compararMes(m, ate) <= 0;
}

async function emitenteOk(ctx: CtxPerm, emitenteId: string): Promise<void> {
  await assertEmitenteDoTenant(ctx, emitenteId);
}

async function fonteDoEmitente(ctx: CtxPerm, fonteId: string, emitenteId?: string) {
  const f = await prisma.finFonte.findUnique({ where: { id: fonteId } });
  if (!f) throw naoEncontrado("Fonte");
  await emitenteOk(ctx, f.emitenteId);
  if (emitenteId && f.emitenteId !== emitenteId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "fonte de outra empresa emissora" });
  }
  return f;
}

async function carregarEmprestimo(ctx: CtxPerm, id: string) {
  const e = await prisma.finEmprestimo.findUnique({ where: { id }, include: { movs: { orderBy: [{ data: "asc" }, { criadoEm: "asc" }] } } });
  if (!e) throw naoEncontrado("Empréstimo");
  await emitenteOk(ctx, e.emitenteId);
  return e;
}

async function carregarAplicacao(ctx: CtxPerm, id: string) {
  const a = await prisma.finAplicacao.findUnique({ where: { id }, include: { movs: { orderBy: [{ data: "asc" }, { criadoEm: "asc" }] } } });
  if (!a) throw naoEncontrado("Aplicação");
  await emitenteOk(ctx, a.emitenteId);
  return a;
}

type EmprestimoComMovs = Awaited<ReturnType<typeof carregarEmprestimo>>;
type AplicacaoComMovs = Awaited<ReturnType<typeof carregarAplicacao>>;

function movsPsa(e: EmprestimoComMovs): MovPsa[] {
  return e.movs.map((m) => ({
    id: m.id, tipo: m.tipo as TipoMovEmprestimo, data: paraDataCal(m.data),
    valorCentavos: paraCentavos(m.valor), previsto: m.previsto,
  }));
}

function principalBancario(e: EmprestimoComMovs): Centavos {
  if (e.valor !== null) return paraCentavos(e.valor);
  return e.movs.filter((m) => !m.previsto && (m.tipo === "saldo_inicial" || m.tipo === "aporte"))
    .reduce((a, m) => a + paraCentavos(m.valor), 0);
}

function paramsBancario(e: EmprestimoComMovs): ParamsEmprestimoBancario | null {
  const principal = principalBancario(e);
  if (!e.numParcelas || e.numParcelas < 1 || principal <= 0) return null;
  return {
    dataContratacao: paraDataCal(e.dataContratacao),
    valorCentavos: principal,
    carenciaMeses: e.carenciaMeses,
    carenciaModo: (e.carenciaModo as CarenciaModo | null) ?? "juros_pagos",
    sistema: (e.sistema as SistemaAmortizacao | null) ?? "sac",
    numParcelas: e.numParcelas,
    spreadAnualPct: paraTaxaPct(e.spreadAnual),
    iofCentavos: paraCentavos(e.iof),
    tarifasCentavos: paraCentavos(e.tarifas),
  };
}

function pagamentosReaisBanco(e: EmprestimoComMovs) {
  return e.movs.filter((m) => !m.previsto && TIPOS_PAGAMENTO_BANCO.has(m.tipo))
    .map((m) => ({ id: m.id, tipo: m.tipo, data: paraDataCal(m.data), valorCentavos: paraCentavos(m.valor), obs: m.obs }));
}

/** Cronograma contratual + confronto com os pagamentos reais (por mês do vencimento). Centavos. */
function cronogramaComReais(e: EmprestimoComMovs, selic: TabelaIndice, hj: DataCal) {
  const p = paramsBancario(e);
  if (!p) return null;
  const cron = cronogramaEmprestimoBancario(p, selic);
  const pagos = pagamentosReaisBanco(e);
  const porMes = new Map<string, number>();
  for (const pg of pagos) {
    const k = chaveMes(mesDe(pg.data));
    porMes.set(k, (porMes.get(k) ?? 0) + pg.valorCentavos);
  }
  const mesesCron = new Set<string>();
  const linhas = cron.linhas.map((l) => {
    const k = chaveMes(mesDe(l.vencimento));
    mesesCron.add(k);
    const vencida = l.vencimento <= hj;
    const pagoReal = porMes.get(k) ?? 0;
    return { ...l, vencida, pagoReal, diferenca: vencida ? l.prestacao - pagoReal : 0 };
  });
  const foraDoCronograma = pagos.filter((pg) => !mesesCron.has(chaveMes(mesDe(pg.data))));
  return {
    params: p,
    cron,
    linhas,
    pagamentosReais: pagos,
    foraDoCronograma,
    totalPagoReal: pagos.reduce((a, pg) => a + pg.valorCentavos, 0),
    saldoContratualHoje: saldoDevedorNaData(cron, p.valorCentavos, hj),
    proximaParcela: linhas.find((l) => !l.vencida && l.prestacao > 0) ?? null,
  };
}

function movsAplicacao(a: AplicacaoComMovs): MovAplicacao[] {
  return a.movs.map((m) => ({
    id: m.id, tipo: m.tipo as TipoMovAplicacao, data: paraDataCal(m.data), valorCentavos: paraCentavos(m.valor), fonteId: m.fonteId,
  }));
}

async function carregarEmprestimosDoEmitente(emitenteId: string, tipo?: "psa" | "bancario") {
  return prisma.finEmprestimo.findMany({
    where: { emitenteId, ...(tipo ? { tipo } : {}) },
    include: { movs: { orderBy: [{ data: "asc" }, { criadoEm: "asc" }] } },
    orderBy: [{ ativo: "desc" }, { dataContratacao: "asc" }],
  });
}

async function carregarAplicacoesDoEmitente(emitenteId: string) {
  return prisma.finAplicacao.findMany({
    where: { emitenteId },
    include: { movs: { orderBy: [{ data: "asc" }, { criadoEm: "asc" }] } },
    orderBy: [{ ativo: "desc" }, { criadoEm: "asc" }],
  });
}

function resumoRecebimento(r: {
  vencimento: Date | null; dataRecebimento: Date | null; valorPrevisto: unknown; valorBruto: unknown;
  valorHonorarios: unknown; valorSucumbencia: unknown; valorRepasse: unknown; repasseStatus: string; nfStatus: string;
}) {
  return {
    vencimento: r.vencimento ? paraDataCal(r.vencimento) : null,
    dataRecebimento: r.dataRecebimento ? paraDataCal(r.dataRecebimento) : null,
    valorPrevistoCentavos: centavosOuNull(r.valorPrevisto as never),
    valorBrutoCentavos: centavosOuNull(r.valorBruto as never),
    valorHonorariosCentavos: centavosOuNull(r.valorHonorarios as never),
    valorSucumbenciaCentavos: centavosOuNull(r.valorSucumbencia as never),
    valorRepasseCentavos: centavosOuNull(r.valorRepasse as never),
    repasseStatus: r.repasseStatus as RepasseStatus,
    nfStatus: r.nfStatus as NfStatus,
  };
}

/** Recorrências (receita/despesa) do emitente e o conjunto de meses já lançados por série. */
async function carregarRecorrencias(emitenteId: string, tipo?: "receita" | "despesa") {
  const origens = await prisma.lancamento.findMany({
    where: { emitenteId, recorrente: true, ...(tipo ? { tipo } : {}) },
    include: { fontes: true },
  });
  const ids = origens.map((o) => o.id);
  const filhos = ids.length
    ? await prisma.lancamento.findMany({
      where: { recorrenciaOrigemId: { in: ids } },
      select: { recorrenciaOrigemId: true, competencia: true, data: true },
    })
    : [];
  const ja = new Set<string>();
  for (const f of filhos) {
    ja.add(chaveOcorrencia(f.recorrenciaOrigemId!, mesDe(calLancamento(f.competencia ?? f.data))));
  }
  const conv = (o: (typeof origens)[number]): OrigemRecorrente & { tipo: string } => ({
    id: o.id,
    tipo: o.tipo,
    data: calLancamento(o.data),
    competencia: o.competencia ? calLancamento(o.competencia) : null,
    recorrenciaFimEm: o.recorrenciaFimEm ? calLancamento(o.recorrenciaFimEm) : null,
    valorCentavos: paraCentavos(o.valor),
    descricao: o.descricao,
    categoria: o.categoria,
    fontes: o.fontes.map((f) => ({ fonteId: f.fonteId, valorCentavos: paraCentavos(f.valor) })),
  });
  return { origens: origens.map(conv), jaLancados: ja, brutos: origens };
}

// ── Fontes ──────────────────────────────────────────────────────────────────

const fontesRouter = router({
  listar: finLeituraProc
    .input(z.object({ emitenteId: z.string(), incluirInativas: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      await garantirFontesPadrao(input.emitenteId);
      const fontes = await prisma.finFonte.findMany({
        where: { emitenteId: input.emitenteId, ...(input.incluirInativas ? {} : { ativo: true }) },
        orderBy: [{ ordem: "asc" }, { criadoEm: "asc" }],
        include: { _count: { select: { lancamentos: true, emprestimos: true, aplicacaoMovs: true } } },
      });
      return fontes;
    }),

  tipos: finLeituraProc.query(() => ({ tipos: TIPOS_FONTE, padrao: FONTES_PADRAO })),

  criar: finEdicaoProc
    .input(z.object({
      emitenteId: z.string(),
      nome: z.string().trim().min(1).max(120),
      tipo: z.enum(TIPOS_FONTE),
      ordem: z.number().int().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      await garantirFontesPadrao(input.emitenteId);
      return prisma.$transaction(async (tx) => {
        const f = await tx.finFonte.create({ data: { ...input, ordem: input.ordem ?? 99 } });
        await registrarAudit(tx, ctx, { emitenteId: f.emitenteId, entidade: "FinFonte", entidadeId: f.id, acao: "criar", depois: f });
        return f;
      });
    }),

  atualizar: finEdicaoProc
    .input(z.object({
      id: z.string(),
      nome: z.string().trim().min(1).max(120).optional(),
      tipo: z.enum(TIPOS_FONTE).optional(),
      ativo: z.boolean().optional(),
      ordem: z.number().int().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...data } = input;
      const antes = await fonteDoEmitente(ctx, id);
      return prisma.$transaction(async (tx) => {
        const depois = await tx.finFonte.update({ where: { id }, data });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinFonte", entidadeId: id, acao: "atualizar", antes, depois });
        return depois;
      });
    }),

  /** Só exclui fonte sem uso; com uso, desative (`atualizar({ativo:false})`). */
  excluir: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await fonteDoEmitente(ctx, input.id);
      const [l, e, m] = await Promise.all([
        prisma.finLancamentoFonte.count({ where: { fonteId: input.id } }),
        prisma.finEmprestimo.count({ where: { fonteId: input.id } }),
        prisma.finAplicacaoMov.count({ where: { fonteId: input.id } }),
      ]);
      if (l + e + m > 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Fonte em uso (lançamentos, empréstimos ou resgates): desative em vez de excluir" });
      }
      return prisma.$transaction(async (tx) => {
        await tx.finFonte.delete({ where: { id: input.id } });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinFonte", entidadeId: input.id, acao: "excluir", antes });
        return { ok: true };
      });
    }),
});

// ── Despesas: recorrência ───────────────────────────────────────────────────

const despesasRouter = router({
  /** Ocorrências projetadas (ainda não lançadas) das séries recorrentes, por mês de competência. */
  projecaoRecorrentes: finLeituraProc
    .input(z.object({ emitenteId: z.string(), de: zMes, ate: zMes, tipo: z.enum(["receita", "despesa"]).optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const de = mesDeStr(input.de), ate = mesDeStr(input.ate);
      if (compararMes(ate, de) < 0 || idxMes(ate) - idxMes(de) > 36) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "intervalo inválido (máx. 36 meses)" });
      }
      const { origens, jaLancados } = await carregarRecorrencias(input.emitenteId, input.tipo);
      const tipoPorId = new Map(origens.map((o) => [o.id, o.tipo]));
      const occ = projetarRecorrencias(origens, jaLancados, de, ate);
      return emReais(occ.map((o) => ({ ...o, tipo: tipoPorId.get(o.origemId) ?? "despesa" })));
    }),

  /**
   * Ação explícita "lançar o mês": cria os lançamentos reais (pago = false) das séries recorrentes
   * para a competência informada, com o mesmo rateio da origem. Idempotente por série × mês.
   */
  lancarRecorrencias: finEdicaoProc
    .input(z.object({ emitenteId: z.string(), competencia: zMes, origemIds: z.array(z.string()).optional() }))
    .mutation(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const ref = mesDeStr(input.competencia);
      const { origens, jaLancados, brutos } = await carregarRecorrencias(input.emitenteId);
      const filtradas = input.origemIds ? origens.filter((o) => input.origemIds!.includes(o.id)) : origens;
      const occ = projetarRecorrencias(filtradas, jaLancados, ref, ref);
      const brutoPorId = new Map(brutos.map((b) => [b.id, b]));
      const criados = await prisma.$transaction(async (tx) => {
        const out = [];
        for (const o of occ) {
          const b = brutoPorId.get(o.origemId)!;
          const novo = await tx.lancamento.create({
            data: {
              tipo: b.tipo,
              descricao: b.descricao,
              categoria: b.categoria,
              valor: deCentavos(o.valorCentavos),
              data: deDataCal(o.data),
              competencia: deDataCal(o.competencia),
              emitenteId: b.emitenteId,
              dealId: b.dealId,
              pago: false,
              obs: b.obs,
              fornecedor: b.fornecedor,
              formaPagamento: b.formaPagamento,
              recorrente: false,
              recorrenciaOrigemId: b.id,
              criadoPorId: ctx.userId ?? null,
            },
          });
          if (o.fontes.length) await gravarRateio(tx, novo.id, reescalarRateio(o.fontes, o.valorCentavos));
          const depois = await tx.lancamento.findUniqueOrThrow({ where: { id: novo.id }, include: INCLUDE_LANCAMENTO });
          await registrarAudit(tx, ctx, { emitenteId: b.emitenteId, entidade: "Lancamento", entidadeId: novo.id, acao: "criar", depois });
          out.push(depois);
        }
        return out;
      });
      return { criados: criados.length, lancamentos: criados };
    }),
});

// ── Orçamento ───────────────────────────────────────────────────────────────

const zItemOrcamento = z.object({
  categoria: z.string().trim().min(1).max(120),
  ano: z.number().int().min(2000).max(2100),
  mes: z.number().int().min(1).max(12),
  valor: z.number().finite().min(0),
});

async function upsertOrcamento(ctx: CtxPerm, emitenteId: string, it: z.infer<typeof zItemOrcamento>) {
  return prisma.$transaction(async (tx) => {
    const where = { emitenteId_categoria_ano_mes: { emitenteId, categoria: it.categoria, ano: it.ano, mes: it.mes } };
    const antes = await tx.finOrcamento.findUnique({ where });
    const depois = await tx.finOrcamento.upsert({
      where,
      create: { emitenteId, categoria: it.categoria, ano: it.ano, mes: it.mes, valor: dinheiro(it.valor) },
      update: { valor: dinheiro(it.valor) },
    });
    await registrarAudit(tx, ctx, {
      emitenteId, entidade: "FinOrcamento", entidadeId: depois.id, acao: antes ? "atualizar" : "criar", antes, depois,
    });
    return depois;
  });
}

const orcamentoRouter = router({
  listar: finLeituraProc
    .input(z.object({ emitenteId: z.string(), ano: z.number().int() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      return prisma.finOrcamento.findMany({
        where: { emitenteId: input.emitenteId, ano: input.ano },
        orderBy: [{ categoria: "asc" }, { mes: "asc" }],
      });
    }),

  salvar: finEdicaoProc
    .input(zItemOrcamento.extend({ emitenteId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { emitenteId, ...it } = input;
      await emitenteOk(ctx, emitenteId);
      return upsertOrcamento(ctx, emitenteId, it);
    }),

  /** Vários de uma vez (ex.: replicar o valor nos 12 meses). Máx. 500 itens. */
  salvarLote: finEdicaoProc
    .input(z.object({ emitenteId: z.string(), itens: z.array(zItemOrcamento).min(1).max(500) }))
    .mutation(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const out = [];
      for (const it of input.itens) out.push(await upsertOrcamento(ctx, input.emitenteId, it));
      return { salvos: out.length };
    }),

  excluir: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finOrcamento.findUnique({ where: { id: input.id } });
      if (!antes) throw naoEncontrado("Orçamento");
      await emitenteOk(ctx, antes.emitenteId);
      return prisma.$transaction(async (tx) => {
        await tx.finOrcamento.delete({ where: { id: input.id } });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinOrcamento", entidadeId: input.id, acao: "excluir", antes });
        return { ok: true };
      });
    }),

  /**
   * Orçado × realizado por categoria e mês. Realizado = despesas (pagas ou não) pela competência
   * (sem competência → data), categorias antigas normalizadas para as novas.
   */
  orcadoRealizado: finLeituraProc
    .input(z.object({ emitenteId: z.string(), ano: z.number().int(), mesDe: z.number().int().min(1).max(12).optional(), mesAte: z.number().int().min(1).max(12).optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const de = { ano: input.ano, mes: input.mesDe ?? 1 };
      const ate = { ano: input.ano, mes: input.mesAte ?? 12 };
      if (compararMes(ate, de) < 0) throw new TRPCError({ code: "BAD_REQUEST", message: "intervalo inválido" });
      const meses = mesesEntre(de, ate);
      const [orcs, desp] = await Promise.all([
        prisma.finOrcamento.findMany({ where: { emitenteId: input.emitenteId, ano: input.ano, mes: { gte: de.mes, lte: ate.mes } } }),
        buscarLancamentosPorCompetencia(input.emitenteId, "despesa", de, ate),
      ]);
      const r = orcadoRealizado({
        meses,
        categoriasFixas: CATEGORIAS_DESPESA,
        orcamentos: orcs.map((o) => ({ mes: { ano: o.ano, mes: o.mes }, categoria: normalizarCategoriaDespesa(o.categoria), valorCentavos: paraCentavos(o.valor) })),
        realizados: desp.map((l) => ({ mes: mesDe(l.comp), categoria: normalizarCategoriaDespesa(l.categoria), valorCentavos: paraCentavos(l.valor) })),
      });
      return emReais({ meses, ...r });
    }),
});

async function buscarLancamentosPorCompetencia(emitenteId: string, tipo: "receita" | "despesa", de: MesRef, ate: MesRef) {
  const faixa = faixaBusca(de, ate);
  const rows = await prisma.lancamento.findMany({
    where: { emitenteId, tipo, OR: [{ competencia: faixa }, { competencia: null, data: faixa }] },
    include: { fontes: true },
  });
  return rows
    .map((l) => ({ ...l, comp: calLancamento(l.competencia ?? l.data) }))
    .filter((l) => noIntervalo(l.comp, de, ate));
}

// ── Índices ─────────────────────────────────────────────────────────────────

const zIndice = z.enum(["selic", "cdi"]);

const indicesRouter = router({
  listar: finLeituraProc
    .input(z.object({ indice: zIndice.optional(), anoDe: z.number().int().optional(), anoAte: z.number().int().optional() }))
    .query(async ({ input }) => {
      return prisma.finIndiceMensal.findMany({
        where: {
          ...(input.indice ? { indice: input.indice } : {}),
          ...(input.anoDe || input.anoAte ? { ano: { gte: input.anoDe ?? 1900, lte: input.anoAte ?? 3000 } } : {}),
        },
        orderBy: [{ indice: "asc" }, { ano: "desc" }, { mes: "desc" }],
      });
    }),

  /** Edição manual: grava com origem "manual" (o cron/importação não sobrescreve). */
  salvar: finEdicaoProc
    .input(z.object({ indice: zIndice, ano: z.number().int().min(1990).max(2100), mes: z.number().int().min(1).max(12), taxa: z.number().finite().min(-5).max(50) }))
    .mutation(async ({ input, ctx }) => {
      return prisma.$transaction(async (tx) => {
        const where = { indice_ano_mes: { indice: input.indice, ano: input.ano, mes: input.mes } };
        const antes = await tx.finIndiceMensal.findUnique({ where });
        const depois = await tx.finIndiceMensal.upsert({
          where,
          create: { indice: input.indice, ano: input.ano, mes: input.mes, taxa: input.taxa.toFixed(8), origem: "manual" },
          update: { taxa: input.taxa.toFixed(8), origem: "manual" },
        });
        await registrarAudit(tx, ctx, { emitenteId: null, entidade: "FinIndiceMensal", entidadeId: depois.id, acao: antes ? "atualizar" : "criar", antes, depois });
        return depois;
      });
    }),

  /** Devolve a linha ao BCB: origem "bcb" (a próxima importação passa a atualizá-la). */
  liberarParaBcb: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finIndiceMensal.findUnique({ where: { id: input.id } });
      if (!antes) throw naoEncontrado("Índice");
      return prisma.$transaction(async (tx) => {
        const depois = await tx.finIndiceMensal.update({ where: { id: input.id }, data: { origem: "bcb" } });
        await registrarAudit(tx, ctx, { emitenteId: null, entidade: "FinIndiceMensal", entidadeId: input.id, acao: "atualizar", antes, depois });
        return depois;
      });
    }),

  excluir: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finIndiceMensal.findUnique({ where: { id: input.id } });
      if (!antes) throw naoEncontrado("Índice");
      return prisma.$transaction(async (tx) => {
        await tx.finIndiceMensal.delete({ where: { id: input.id } });
        await registrarAudit(tx, ctx, { emitenteId: null, entidade: "FinIndiceMensal", entidadeId: input.id, acao: "excluir", antes });
        return { ok: true };
      });
    }),

  /** Botão "Importar agora" (BCB/SGS 4390 e 4391). Default: últimos 24 meses. Linhas manuais preservadas. */
  importar: finEdicaoProc
    .input(z.object({ indices: z.array(zIndice).optional(), desde: zDataCal.optional() }))
    .mutation(async ({ input, ctx }) => {
      const res = await importarIndicesBcb({ indices: input.indices as Indice[] | undefined, desde: input.desde, mesesAtras: 24 });
      await registrarAudit(prisma, ctx, {
        emitenteId: null, entidade: "FinIndiceMensal", entidadeId: "importacao_bcb", acao: "atualizar", depois: res,
      });
      return res;
    }),
});

// ── Empréstimos ─────────────────────────────────────────────────────────────

const zEmprestimoCampos = {
  nome: z.string().trim().min(1).max(160),
  dataContratacao: zDataCal,
  valor: zValorOpc,
  carenciaMeses: z.number().int().min(0).max(120).optional(),
  spreadAnual: z.number().finite().min(0).max(100).optional(),
  numParcelas: z.number().int().min(1).max(600).nullable().optional(),
  sistema: z.enum(["sac", "price"]).nullable().optional(),
  carenciaModo: z.enum(["juros_pagos", "capitalizados"]).nullable().optional(),
  iof: zValorOpc,
  tarifas: zValorOpc,
  fonteId: z.string().nullable().optional(),
  ativo: z.boolean().optional(),
  obs: z.string().max(2000).nullable().optional(),
};

function validarBancario(d: { tipo: string; valor?: number | null; numParcelas?: number | null }): void {
  if (d.tipo !== "bancario") return;
  if (!d.valor || d.valor <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "empréstimo bancário precisa do valor contratado" });
  if (!d.numParcelas) throw new TRPCError({ code: "BAD_REQUEST", message: "empréstimo bancário precisa do número de parcelas" });
}

function resumoEmprestimo(e: EmprestimoComMovs, selic: TabelaIndice, hj: DataCal) {
  if (e.tipo === "psa") {
    const ex = extratoEmprestimoPsa(movsPsa(e), { selic, ate: mesDe(hj), incluirPrevistos: false });
    const previstos = e.movs.filter((m) => m.previsto).reduce((a, m) => a + paraCentavos(m.valor), 0);
    return emReais({
      saldoDevedor: ex.linhas.length ? ex.saldoFinal : 0,
      totalAportado: ex.totalAportado,
      totalCorrecao: ex.totalCorrecao,
      totalAmortizado: ex.totalAmortizado,
      aportesPrevistos: previstos,
    });
  }
  const c = cronogramaComReais(e, selic, hj);
  if (!c) return { configurado: false as const };
  return {
    configurado: true as const,
    ...emReais({
      saldoDevedor: c.saldoContratualHoje,
      principal: c.params.valorCentavos,
      totalPagoReal: c.totalPagoReal,
      custoTotalPrevisto: c.cron.custoTotal,
      proximaParcela: c.proximaParcela ? { vencimento: c.proximaParcela.vencimento, prestacao: c.proximaParcela.prestacao, projetado: c.proximaParcela.projetado } : null,
    }),
  };
}

const emprestimosRouter = router({
  listar: finLeituraProc
    .input(z.object({ emitenteId: z.string(), tipo: z.enum(["psa", "bancario"]).optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const [lista, tab] = await Promise.all([carregarEmprestimosDoEmitente(input.emitenteId, input.tipo), carregarTabelasIndices()]);
      const hj = hoje();
      return lista.map(({ movs, ...e }) => ({ ...e, qtdMovs: movs.length, resumo: resumoEmprestimo({ ...e, movs }, tab.selic, hj) }));
    }),

  obter: finLeituraProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const e = await carregarEmprestimo(ctx, input.id);
      const fonte = e.fonteId ? await prisma.finFonte.findUnique({ where: { id: e.fonteId }, select: { id: true, nome: true, tipo: true } }) : null;
      return { ...e, fonte };
    }),

  criar: finEdicaoProc
    .input(z.object({ emitenteId: z.string(), tipo: z.enum(["psa", "bancario"]), ...zEmprestimoCampos }))
    .mutation(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      validarBancario(input);
      let fonteId = input.fonteId ?? null;
      if (fonteId) await fonteDoEmitente(ctx, fonteId, input.emitenteId);
      else fonteId = (await fontePadraoDoTipo(input.emitenteId, input.tipo === "psa" ? "emprestimo_psa" : "emprestimo_bancario"))?.id ?? null;
      return prisma.$transaction(async (tx) => {
        const e = await tx.finEmprestimo.create({
          data: {
            emitenteId: input.emitenteId,
            tipo: input.tipo,
            nome: input.nome,
            dataContratacao: deDataCal(input.dataContratacao),
            valor: dinheiroOpc(input.valor) ?? null,
            carenciaMeses: input.carenciaMeses ?? 0,
            spreadAnual: (input.spreadAnual ?? 6).toFixed(4),
            numParcelas: input.numParcelas ?? null,
            sistema: input.sistema ?? (input.tipo === "bancario" ? "sac" : null),
            carenciaModo: input.carenciaModo ?? (input.tipo === "bancario" ? "juros_pagos" : null),
            iof: dinheiroOpc(input.iof) ?? null,
            tarifas: dinheiroOpc(input.tarifas) ?? null,
            fonteId,
            ativo: input.ativo ?? true,
            obs: input.obs ?? null,
            criadoPorId: ctx.userId ?? null,
          },
        });
        await registrarAudit(tx, ctx, { emitenteId: e.emitenteId, entidade: "FinEmprestimo", entidadeId: e.id, acao: "criar", depois: e });
        return e;
      });
    }),

  atualizar: finEdicaoProc
    .input(z.object({ id: z.string(), ...Object.fromEntries(Object.entries(zEmprestimoCampos).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof zEmprestimoCampos]: z.ZodOptional<(typeof zEmprestimoCampos)[K]>
    } }))
    .mutation(async ({ input, ctx }) => {
      const { movs: _m, ...antes } = await carregarEmprestimo(ctx, input.id);
      void _m;
      const valorFinal = input.valor !== undefined ? input.valor : antes.valor !== null ? Number(antes.valor) : null;
      const parcFinal = input.numParcelas !== undefined ? input.numParcelas : antes.numParcelas;
      validarBancario({ tipo: antes.tipo, valor: valorFinal, numParcelas: parcFinal });
      if (input.fonteId) await fonteDoEmitente(ctx, input.fonteId, antes.emitenteId);
      const data: Record<string, unknown> = {};
      if (input.nome !== undefined) data.nome = input.nome;
      if (input.dataContratacao !== undefined) data.dataContratacao = deDataCal(input.dataContratacao);
      if (input.valor !== undefined) data.valor = dinheiroOpc(input.valor);
      if (input.carenciaMeses !== undefined) data.carenciaMeses = input.carenciaMeses;
      if (input.spreadAnual !== undefined) data.spreadAnual = input.spreadAnual.toFixed(4);
      if (input.numParcelas !== undefined) data.numParcelas = input.numParcelas;
      if (input.sistema !== undefined) data.sistema = input.sistema;
      if (input.carenciaModo !== undefined) data.carenciaModo = input.carenciaModo;
      if (input.iof !== undefined) data.iof = dinheiroOpc(input.iof);
      if (input.tarifas !== undefined) data.tarifas = dinheiroOpc(input.tarifas);
      if (input.fonteId !== undefined) data.fonteId = input.fonteId;
      if (input.ativo !== undefined) data.ativo = input.ativo;
      if (input.obs !== undefined) data.obs = input.obs;
      return prisma.$transaction(async (tx) => {
        const depois = await tx.finEmprestimo.update({ where: { id: input.id }, data });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinEmprestimo", entidadeId: input.id, acao: "atualizar", antes, depois });
        return depois;
      });
    }),

  /** Exclui o empréstimo e os movimentos (cascade). */
  excluir: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await carregarEmprestimo(ctx, input.id);
      return prisma.$transaction(async (tx) => {
        await tx.finEmprestimo.delete({ where: { id: input.id } });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinEmprestimo", entidadeId: input.id, acao: "excluir", antes });
        return { ok: true };
      });
    }),

  criarMov: finEdicaoProc
    .input(z.object({
      emprestimoId: z.string(),
      tipo: z.enum(TIPOS_MOV_EMPRESTIMO),
      data: zDataCal,
      valor: zValor,
      previsto: z.boolean().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const e = await carregarEmprestimo(ctx, input.emprestimoId);
      if (input.previsto && e.tipo !== "psa") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "movimento previsto só no empréstimo PSA" });
      }
      return prisma.$transaction(async (tx) => {
        const m = await tx.finEmprestimoMov.create({
          data: {
            emprestimoId: e.id, tipo: input.tipo, data: deDataCal(input.data), valor: dinheiro(input.valor),
            previsto: input.previsto ?? false, obs: input.obs ?? null, criadoPorId: ctx.userId ?? null,
          },
        });
        await registrarAudit(tx, ctx, { emitenteId: e.emitenteId, entidade: "FinEmprestimoMov", entidadeId: m.id, acao: "criar", depois: m });
        return m;
      });
    }),

  atualizarMov: finEdicaoProc
    .input(z.object({
      id: z.string(),
      tipo: z.enum(TIPOS_MOV_EMPRESTIMO).optional(),
      data: zDataCal.optional(),
      valor: zValor.optional(),
      previsto: z.boolean().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finEmprestimoMov.findUnique({ where: { id: input.id }, include: { emprestimo: { select: { emitenteId: true, tipo: true } } } });
      if (!antes) throw naoEncontrado("Movimento");
      await emitenteOk(ctx, antes.emprestimo.emitenteId);
      if (input.previsto && antes.emprestimo.tipo !== "psa") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "movimento previsto só no empréstimo PSA" });
      }
      return prisma.$transaction(async (tx) => {
        const depois = await tx.finEmprestimoMov.update({
          where: { id: input.id },
          data: {
            tipo: input.tipo,
            data: input.data ? deDataCal(input.data) : undefined,
            valor: input.valor !== undefined ? dinheiro(input.valor) : undefined,
            previsto: input.previsto,
            obs: input.obs,
          },
        });
        const { emprestimo: _e, ...antesSemRel } = antes;
        void _e;
        await registrarAudit(tx, ctx, { emitenteId: antes.emprestimo.emitenteId, entidade: "FinEmprestimoMov", entidadeId: input.id, acao: "atualizar", antes: antesSemRel, depois });
        return depois;
      });
    }),

  excluirMov: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finEmprestimoMov.findUnique({ where: { id: input.id }, include: { emprestimo: { select: { emitenteId: true } } } });
      if (!antes) throw naoEncontrado("Movimento");
      await emitenteOk(ctx, antes.emprestimo.emitenteId);
      return prisma.$transaction(async (tx) => {
        await tx.finEmprestimoMov.delete({ where: { id: input.id } });
        const { emprestimo: _e, ...antesSemRel } = antes;
        void _e;
        await registrarAudit(tx, ctx, { emitenteId: antes.emprestimo.emitenteId, entidade: "FinEmprestimoMov", entidadeId: input.id, acao: "excluir", antes: antesSemRel });
        return { ok: true };
      });
    }),

  /** Extrato mensal do empréstimo PSA (por aporte, FIFO). `ate` default: mês atual (ou último movimento, se depois). */
  extratoPsa: finLeituraProc
    .input(z.object({ id: z.string(), ate: zMes.optional(), incluirPrevistos: z.boolean().optional() }))
    .query(async ({ input, ctx }) => {
      const e = await carregarEmprestimo(ctx, input.id);
      if (e.tipo !== "psa") throw new TRPCError({ code: "BAD_REQUEST", message: "extrato PSA só para empréstimo do tipo psa" });
      const { selic } = await carregarTabelasIndices();
      const movs = movsPsa(e);
      const incluirPrevistos = input.incluirPrevistos ?? true;
      let ate = input.ate ? mesDeStr(input.ate) : mesDe(hoje());
      if (!input.ate) {
        const ult = movs.filter((m) => incluirPrevistos || !m.previsto).map((m) => m.data).sort().pop();
        if (ult && compararMes(mesDe(ult), ate) > 0) ate = mesDe(ult);
      }
      return emReais(extratoEmprestimoPsa(movs, { selic, ate, incluirPrevistos }));
    }),

  /** Cronograma do bancário (real + projetado) confrontado com os pagamentos registrados. */
  cronogramaBancario: finLeituraProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => {
      const e = await carregarEmprestimo(ctx, input.id);
      if (e.tipo !== "bancario") throw new TRPCError({ code: "BAD_REQUEST", message: "cronograma só para empréstimo bancário" });
      const { selic } = await carregarTabelasIndices();
      const hj = hoje();
      const c = cronogramaComReais(e, selic, hj);
      if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: "configure valor e número de parcelas do empréstimo" });
      const { linhas: _l, ...totaisCron } = c.cron;
      void _l;
      return emReais({
        linhas: c.linhas,
        ...totaisCron,
        pagamentosReais: c.pagamentosReais,
        pagamentosForaDoCronograma: c.foraDoCronograma,
        totalPagoReal: c.totalPagoReal,
        saldoContratualHoje: c.saldoContratualHoje,
        jurosIncorridosAteHoje: jurosNoPeriodo(c.cron, "0000-01-01", hj),
        proximaParcela: c.proximaParcela,
      });
    }),
});

// ── Aplicações ──────────────────────────────────────────────────────────────

async function fonteResgate(ctx: CtxPerm, emitenteId: string, fonteId?: string | null): Promise<string> {
  if (fonteId) {
    await fonteDoEmitente(ctx, fonteId, emitenteId);
    return fonteId;
  }
  const f = await fontePadraoDoTipo(emitenteId, "emprestimo_bancario");
  if (!f) throw new TRPCError({ code: "BAD_REQUEST", message: "resgate exige a fonte que recebe o dinheiro (nenhuma fonte de empréstimo bancário ativa)" });
  return f.id;
}

const aplicacoesRouter = router({
  listar: finLeituraProc
    .input(z.object({ emitenteId: z.string() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const lista = await carregarAplicacoesDoEmitente(input.emitenteId);
      const hj = hoje();
      return lista.map(({ movs, ...a }) => ({ ...a, qtdMovs: movs.length, resumo: emReais(saldoAplicacao(movsAplicacao({ ...a, movs }), hj)) }));
    }),

  obter: finLeituraProc
    .input(z.object({ id: z.string() }))
    .query(async ({ input, ctx }) => carregarAplicacao(ctx, input.id)),

  criar: finEdicaoProc
    .input(z.object({
      emitenteId: z.string(),
      nome: z.string().trim().min(1).max(160),
      produto: z.string().max(80).nullable().optional(),
      indexador: z.enum(["selic", "cdi"]).optional(),
      percentualIndexador: z.number().finite().min(0).max(1000).optional(),
      ativo: z.boolean().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      return prisma.$transaction(async (tx) => {
        const a = await tx.finAplicacao.create({
          data: {
            emitenteId: input.emitenteId, nome: input.nome, produto: input.produto ?? null,
            indexador: input.indexador ?? "cdi", percentualIndexador: (input.percentualIndexador ?? 100).toFixed(2),
            ativo: input.ativo ?? true, obs: input.obs ?? null,
          },
        });
        await registrarAudit(tx, ctx, { emitenteId: a.emitenteId, entidade: "FinAplicacao", entidadeId: a.id, acao: "criar", depois: a });
        return a;
      });
    }),

  atualizar: finEdicaoProc
    .input(z.object({
      id: z.string(),
      nome: z.string().trim().min(1).max(160).optional(),
      produto: z.string().max(80).nullable().optional(),
      indexador: z.enum(["selic", "cdi"]).optional(),
      percentualIndexador: z.number().finite().min(0).max(1000).optional(),
      ativo: z.boolean().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { movs: _m, ...antes } = await carregarAplicacao(ctx, input.id);
      void _m;
      const { id, percentualIndexador, ...rest } = input;
      return prisma.$transaction(async (tx) => {
        const depois = await tx.finAplicacao.update({
          where: { id },
          data: { ...rest, ...(percentualIndexador !== undefined ? { percentualIndexador: percentualIndexador.toFixed(2) } : {}) },
        });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinAplicacao", entidadeId: id, acao: "atualizar", antes, depois });
        return depois;
      });
    }),

  excluir: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await carregarAplicacao(ctx, input.id);
      return prisma.$transaction(async (tx) => {
        await tx.finAplicacao.delete({ where: { id: input.id } });
        await registrarAudit(tx, ctx, { emitenteId: antes.emitenteId, entidade: "FinAplicacao", entidadeId: input.id, acao: "excluir", antes });
        return { ok: true };
      });
    }),

  /** Resgate exige fonte: se não vier, usa a fonte "emprestimo_bancario" do emitente. */
  criarMov: finEdicaoProc
    .input(z.object({
      aplicacaoId: z.string(),
      tipo: z.enum(TIPOS_MOV_APLICACAO),
      data: zDataCal,
      valor: zValor,
      fonteId: z.string().nullable().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const a = await carregarAplicacao(ctx, input.aplicacaoId);
      let fonteId: string | null = null;
      if (input.tipo === "resgate") fonteId = await fonteResgate(ctx, a.emitenteId, input.fonteId);
      else if (input.fonteId) fonteId = (await fonteDoEmitente(ctx, input.fonteId, a.emitenteId)).id;
      return prisma.$transaction(async (tx) => {
        const m = await tx.finAplicacaoMov.create({
          data: {
            aplicacaoId: a.id, tipo: input.tipo, data: deDataCal(input.data), valor: dinheiro(input.valor),
            fonteId, obs: input.obs ?? null, criadoPorId: ctx.userId ?? null,
          },
        });
        await registrarAudit(tx, ctx, { emitenteId: a.emitenteId, entidade: "FinAplicacaoMov", entidadeId: m.id, acao: "criar", depois: m });
        return m;
      });
    }),

  atualizarMov: finEdicaoProc
    .input(z.object({
      id: z.string(),
      tipo: z.enum(TIPOS_MOV_APLICACAO).optional(),
      data: zDataCal.optional(),
      valor: zValor.optional(),
      fonteId: z.string().nullable().optional(),
      obs: z.string().max(2000).nullable().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finAplicacaoMov.findUnique({ where: { id: input.id }, include: { aplicacao: { select: { emitenteId: true } } } });
      if (!antes) throw naoEncontrado("Movimento");
      const emitenteId = antes.aplicacao.emitenteId;
      await emitenteOk(ctx, emitenteId);
      const tipoFinal = input.tipo ?? antes.tipo;
      let fonteId: string | null | undefined = input.fonteId;
      if (tipoFinal === "resgate") {
        fonteId = await fonteResgate(ctx, emitenteId, input.fonteId !== undefined ? input.fonteId : antes.fonteId);
      } else if (input.fonteId) {
        await fonteDoEmitente(ctx, input.fonteId, emitenteId);
      }
      return prisma.$transaction(async (tx) => {
        const depois = await tx.finAplicacaoMov.update({
          where: { id: input.id },
          data: {
            tipo: input.tipo,
            data: input.data ? deDataCal(input.data) : undefined,
            valor: input.valor !== undefined ? dinheiro(input.valor) : undefined,
            fonteId,
            obs: input.obs,
          },
        });
        const { aplicacao: _a, ...antesSemRel } = antes;
        void _a;
        await registrarAudit(tx, ctx, { emitenteId, entidade: "FinAplicacaoMov", entidadeId: input.id, acao: "atualizar", antes: antesSemRel, depois });
        return depois;
      });
    }),

  excluirMov: finEdicaoProc
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const antes = await prisma.finAplicacaoMov.findUnique({ where: { id: input.id }, include: { aplicacao: { select: { emitenteId: true } } } });
      if (!antes) throw naoEncontrado("Movimento");
      await emitenteOk(ctx, antes.aplicacao.emitenteId);
      return prisma.$transaction(async (tx) => {
        await tx.finAplicacaoMov.delete({ where: { id: input.id } });
        const { aplicacao: _a, ...antesSemRel } = antes;
        void _a;
        await registrarAudit(tx, ctx, { emitenteId: antes.aplicacao.emitenteId, entidade: "FinAplicacaoMov", entidadeId: input.id, acao: "excluir", antes: antesSemRel });
        return { ok: true };
      });
    }),

  /** Rendimento sugerido do mês (saldo no dia 1 × taxa do indexador) + IR regressivo sugerido. Editável na tela. */
  rendimentoSugerido: finLeituraProc
    .input(z.object({ aplicacaoId: z.string(), competencia: zMes }))
    .query(async ({ input, ctx }) => {
      const a = await carregarAplicacao(ctx, input.aplicacaoId);
      const ref = mesDeStr(input.competencia);
      const tabelas = await carregarTabelasIndices();
      const movs = movsAplicacao(a);
      const s = sugerirRendimentoMes({
        movs, indexador: a.indexador as IndexadorAplicacao, percentualIndexador: paraTaxaPct(a.percentualIndexador),
        tabelas, ano: ref.ano, mes: ref.mes,
      });
      const primeira = movs.filter((m) => m.tipo === "aplicacao").map((m) => m.data).sort()[0];
      const prazoDias = primeira ? Math.max(diasEntre(primeira, ultimoDia(ref)), 0) : 0;
      const ir = irSugerido(s.valorCentavos, prazoDias);
      return emReais({ ...s, prazoDias, aliquotaIr: aliquotaIrRegressivo(prazoDias), irSugerido: ir, rendimentoLiquido: s.valorCentavos - ir });
    }),

  extrato: finLeituraProc
    .input(z.object({ aplicacaoId: z.string(), de: zMes.optional(), ate: zMes.optional() }))
    .query(async ({ input, ctx }) => {
      const a = await carregarAplicacao(ctx, input.aplicacaoId);
      const movs = movsAplicacao(a);
      return emReais({
        linhas: extratoAplicacao(movs, input.de ? mesDeStr(input.de) : undefined, input.ate ? mesDeStr(input.ate) : undefined),
        saldo: saldoAplicacao(movs),
      });
    }),

  /**
   * Indicadores: custo líquido do empréstimo bancário (juros incorridos − rendimento líquido de IR das
   * aplicações) no período, e consumo do empréstimo bancário (resgates vinculados à fonte do bancário).
   * Período default: desde o início até hoje.
   */
  indicadores: finLeituraProc
    .input(z.object({ emitenteId: z.string(), de: zDataCal.optional(), ate: zDataCal.optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const hj = hoje();
      const de = input.de ?? "0000-01-01";
      const ate = input.ate ?? hj;
      const [emps, apls, tab] = await Promise.all([
        carregarEmprestimosDoEmitente(input.emitenteId, "bancario"),
        carregarAplicacoesDoEmitente(input.emitenteId),
        carregarTabelasIndices(),
      ]);
      let juros = 0;
      let contratado = 0, liquido = 0;
      const fontesBanco = new Set<string>();
      for (const e of emps) {
        if (e.fonteId) fontesBanco.add(e.fonteId);
        const c = cronogramaComReais(e, tab.selic, hj);
        if (!c) continue;
        juros += jurosNoPeriodo(c.cron, de, ate);
        contratado += c.params.valorCentavos;
        liquido += c.cron.valorLiquidoRecebido;
      }
      if (!fontesBanco.size) {
        const f = await fontePadraoDoTipo(input.emitenteId, "emprestimo_bancario");
        if (f) fontesBanco.add(f.id);
      }
      let rend = 0, ir = 0, resgatesBanco = 0;
      for (const a of apls) {
        const movs = movsAplicacao(a).filter((m) => m.data >= de && m.data <= ate);
        const s = saldoAplicacao(movs);
        rend += s.rendimentoBruto;
        ir += s.ir;
        const porFonte = resgatesPorFonte(movsAplicacao(a), undefined, ate);
        for (const fid of fontesBanco) resgatesBanco += porFonte[fid] ?? 0;
      }
      const despesasFonte = fontesBanco.size
        ? await prisma.finLancamentoFonte.findMany({
          where: { fonteId: { in: [...fontesBanco] }, lancamento: { tipo: "despesa", emitenteId: input.emitenteId } },
          select: { valor: true },
        })
        : [];
      const despesasPagas = despesasFonte.reduce((a, d) => a + paraCentavos(d.valor), 0);
      return emReais({
        periodo: { de: input.de ?? null, ate },
        custoLiquido: custoLiquidoEmprestimo({ jurosIncorridosCentavos: juros, rendimentoBrutoCentavos: rend, irCentavos: ir }),
        consumoEmprestimoBancario: {
          fonteIds: [...fontesBanco],
          valorContratado: contratado,
          valorLiquidoRecebido: liquido,
          resgatesParaFonte: resgatesBanco, // "consumido" = resgatado da aplicação para a fonte do bancário
          despesasPagasPelaFonte: despesasPagas,
          saldoNaoConsumido: liquido - resgatesBanco,
          percentualConsumido: liquido > 0 ? Math.round((resgatesBanco / liquido) * 10000) / 100 : null,
        },
      });
    }),
});

// ── Relatórios ──────────────────────────────────────────────────────────────

async function eventosFluxo(emitenteId: string, de: MesRef, ate: MesRef, hj: DataCal) {
  const atual = mesDe(hj);
  const faixa = faixaBusca(de, ate);
  const [lancs, recs, emps, apls, tab, recorr] = await Promise.all([
    prisma.lancamento.findMany({
      where: { emitenteId, OR: [{ data: faixa }, { pago: false, data: { lt: faixa.gte } }] },
      select: { tipo: true, valor: true, data: true, pago: true },
    }),
    prisma.finRecebimento.findMany({ where: { emitenteId } }),
    carregarEmprestimosDoEmitente(emitenteId),
    carregarAplicacoesDoEmitente(emitenteId),
    carregarTabelasIndices(),
    carregarRecorrencias(emitenteId),
  ]);
  const eventos: EventoFluxo[] = [];
  const avisos: string[] = [];

  for (const l of lancs) {
    const d = calLancamento(l.data);
    eventos.push({
      data: d,
      linha: l.tipo === "receita" ? "receitas_lancamentos" : "despesas",
      valorCentavos: paraCentavos(l.valor),
      realizado: l.pago && d <= hj,
    });
  }

  // recorrências: só do mês corrente em diante (mês passado não lançado não foi pago)
  const iniRec = compararMes(de, atual) > 0 ? de : atual;
  if (compararMes(ate, iniRec) >= 0) {
    const tipoPorId = new Map(recorr.origens.map((o) => [o.id, o.tipo]));
    for (const o of projetarRecorrencias(recorr.origens, recorr.jaLancados, iniRec, ate)) {
      const rec = tipoPorId.get(o.origemId) === "receita";
      eventos.push({ data: o.data, linha: rec ? "receitas_lancamentos" : "despesas_recorrentes", valorCentavos: o.valorCentavos, realizado: false });
    }
  }

  let semPct = 0;
  for (const r of recs) {
    const res = eventosDeRecebimento({
      vencimento: r.vencimento ? paraDataCal(r.vencimento) : null,
      dataRecebimento: r.dataRecebimento ? paraDataCal(r.dataRecebimento) : null,
      valorPrevistoCentavos: centavosOuNull(r.valorPrevisto),
      valorBrutoCentavos: centavosOuNull(r.valorBruto),
      percHonorarios: r.percHonorarios,
      valorHonorariosCentavos: centavosOuNull(r.valorHonorarios),
      valorSucumbenciaCentavos: centavosOuNull(r.valorSucumbencia),
      valorRepasseCentavos: centavosOuNull(r.valorRepasse),
      repasseStatus: r.repasseStatus as RepasseStatus,
      repasseData: r.repasseData ? paraDataCal(r.repasseData) : null,
    }, hj);
    eventos.push(...res.eventos);
    if (res.semPercentual) semPct++;
  }
  if (semPct) avisos.push(`${semPct} recebimento(s) previsto(s) sem % de honorários: projetados inteiros como valores de terceiros`);

  for (const e of emps) {
    if (e.tipo === "psa") {
      for (const m of e.movs) {
        if (m.tipo === "saldo_inicial") continue; // saldo migrado, não é caixa
        const d = paraDataCal(m.data);
        const entrada = m.tipo === "aporte";
        eventos.push({
          data: d,
          linha: entrada ? "aportes_psa" : "devolucoes_psa",
          valorCentavos: paraCentavos(m.valor),
          realizado: !m.previsto && d <= hj,
        });
      }
      continue;
    }
    const c = cronogramaComReais(e, tab.selic, hj);
    if (c) {
      const dc = c.params.dataContratacao;
      eventos.push({ data: dc, linha: "emprestimo_bancario", valorCentavos: c.cron.valorLiquidoRecebido, realizado: dc <= hj });
      const mesesComPagamento = new Set(c.pagamentosReais.map((p) => chaveMes(mesDe(p.data))));
      for (const p of c.pagamentosReais) {
        eventos.push({ data: p.data, linha: "parcelas_emprestimo", valorCentavos: p.valorCentavos, realizado: p.data <= hj });
      }
      for (const l of c.linhas) {
        if (l.prestacao <= 0) continue;
        const m = mesDe(l.vencimento);
        if (compararMes(m, atual) < 0) continue; // passado: vale o pagamento real
        if (mesesComPagamento.has(chaveMes(m))) continue;
        eventos.push({ data: l.vencimento, linha: "parcelas_emprestimo", valorCentavos: l.prestacao, realizado: false });
      }
    } else if (e.ativo) {
      avisos.push(`empréstimo bancário "${e.nome}" sem parâmetros completos: fora da projeção`);
    }
  }

  for (const a of apls) {
    const movs = movsAplicacao(a);
    const temRendMesAtual = movs.some((m) => m.tipo === "rendimento" && compararMes(mesDe(m.data), atual) === 0);
    for (const m of movs) {
      if (m.tipo !== "rendimento" && m.tipo !== "ir") continue;
      eventos.push({
        data: m.data, linha: "rendimento_aplicacao",
        valorCentavos: m.tipo === "rendimento" ? m.valorCentavos : -m.valorCentavos,
        realizado: m.data <= hj,
      });
    }
    if (!a.ativo) continue;
    const iniProj = temRendMesAtual ? addMeses(atual, 1) : atual;
    const iniP = compararMes(de, iniProj) > 0 ? de : iniProj;
    if (compararMes(ate, iniP) < 0) continue;
    const saldo = saldoAplicacao(movs, hj).saldo;
    if (saldo <= 0) continue;
    // meses entre o atual e o início do horizonte também capitalizam
    const mesesProj = mesesEntre(iniProj, ate);
    const taxas = mesesProj.map((r) => taxaAplicacaoMes(a.indexador as IndexadorAplicacao, paraTaxaPct(a.percentualIndexador), tab, r.ano, r.mes)?.taxaPct ?? 0);
    const rend = projetarRendimento(saldo, taxas);
    mesesProj.forEach((r, i) => {
      if (compararMes(r, iniP) < 0) return;
      eventos.push({ data: ultimoDia(r), linha: "rendimento_aplicacao", valorCentavos: rend[i], realizado: false });
    });
  }
  return { eventos, avisos };
}

const relatoriosRouter = router({
  /**
   * Fluxo de caixa mês a mês: passado = realizado; mês corrente = realizado + pendente (inclui vencidos
   * não pagos/recebidos, em `atrasados`); futuro = projetado. Escopo: contas + aplicações (aplicação/resgate
   * são transferências internas). Valores de terceiros em linhas próprias, fora de `liquidoEscritorio`.
   */
  fluxoCaixa: finLeituraProc
    .input(z.object({
      emitenteId: z.string(),
      de: zMes.optional(), // default: mês atual
      meses: z.number().int().min(1).max(36).default(12),
      saldoInicial: z.number().finite().optional(), // saldo de abertura (reais); default 0
    }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const hj = hoje();
      const de = input.de ? mesDeStr(input.de) : mesDe(hj);
      const ate = addMeses(de, input.meses - 1);
      const { eventos, avisos } = await eventosFluxo(input.emitenteId, de, ate, hj);
      const fluxo = montarFluxoCaixa({
        eventos, de, meses: input.meses, hoje: hj,
        saldoInicialCentavos: input.saldoInicial !== undefined ? paraCentavos(input.saldoInicial) : 0,
      });
      return { ...emReais(fluxo), hoje: hj, avisos };
    }),

  /**
   * DRE gerencial mensal (competência). Receita do escritório = honorários + sucumbência dos
   * FinRecebimento recebidos (pela data do recebimento) + Lancamento receita; nunca valores de terceiros.
   * Resultado financeiro: juros do bancário (por vencimento), IOF/tarifas, correção do PSA, rendimento/IR.
   */
  dre: finLeituraProc
    .input(z.object({ emitenteId: z.string(), ano: z.number().int().optional(), de: zMes.optional(), ate: zMes.optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const hj = hoje();
      const ano = input.ano ?? mesDe(hj).ano;
      const de = input.de ? mesDeStr(input.de) : { ano, mes: 1 };
      const ate = input.ate ? mesDeStr(input.ate) : { ano, mes: 12 };
      if (compararMes(ate, de) < 0 || idxMes(ate) - idxMes(de) > 35) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "intervalo inválido (máx. 36 meses)" });
      }
      const meses = mesesEntre(de, ate);
      const faixa = faixaBusca(de, ate);
      const [receitasL, despesasL, recs, emps, apls, tab] = await Promise.all([
        buscarLancamentosPorCompetencia(input.emitenteId, "receita", de, ate),
        buscarLancamentosPorCompetencia(input.emitenteId, "despesa", de, ate),
        prisma.finRecebimento.findMany({ where: { emitenteId: input.emitenteId, dataRecebimento: faixa } }),
        carregarEmprestimosDoEmitente(input.emitenteId),
        carregarAplicacoesDoEmitente(input.emitenteId),
        carregarTabelasIndices(),
      ]);
      const receitas: ItemCategoriaMes[] = receitasL.map((l) => ({
        mes: mesDe(l.comp), categoria: normalizarCategoriaReceita(l.categoria), valorCentavos: paraCentavos(l.valor),
      }));
      for (const r of recs) {
        const d = paraDataCal(r.dataRecebimento!);
        if (!noIntervalo(d, de, ate)) continue;
        const t = totalizarRecebimentos([resumoRecebimento(r)], hj);
        const honor = t.receitaEscritorio - t.sucumbencia;
        const rotulo = r.tipo === "acordo" ? "Honorários — acordos" : "Honorários — execução/sentença";
        if (honor) receitas.push({ mes: mesDe(d), categoria: rotulo, valorCentavos: honor });
        if (t.sucumbencia) receitas.push({ mes: mesDe(d), categoria: "Honorários de sucumbência", valorCentavos: t.sucumbencia });
      }
      const despesas: ItemCategoriaMes[] = despesasL.map((l) => ({
        mes: mesDe(l.comp), categoria: normalizarCategoriaDespesa(l.categoria), valorCentavos: paraCentavos(l.valor),
      }));
      const financeiro: ItemCategoriaMes[] = [];
      for (const e of emps) {
        if (e.tipo === "psa") {
          const ex = extratoEmprestimoPsa(movsPsa(e), { selic: tab.selic, ate, incluirPrevistos: false });
          for (const l of ex.linhas) {
            if (l.correcao) financeiro.push({ mes: { ano: l.ano, mes: l.mes }, categoria: "Correção empréstimo PSA (Selic)", valorCentavos: -l.correcao });
          }
          continue;
        }
        const c = cronogramaComReais(e, tab.selic, hj);
        if (!c) continue;
        for (const l of c.cron.linhas) {
          if (l.juros) financeiro.push({ mes: mesDe(l.vencimento), categoria: "Juros empréstimo bancário", valorCentavos: -l.juros });
        }
        if (c.cron.custoContratacao) {
          financeiro.push({ mes: mesDe(c.params.dataContratacao), categoria: "IOF e tarifas do empréstimo", valorCentavos: -c.cron.custoContratacao });
        }
      }
      for (const a of apls) {
        for (const m of movsAplicacao(a)) {
          if (m.tipo === "rendimento") financeiro.push({ mes: mesDe(m.data), categoria: "Rendimento de aplicações", valorCentavos: m.valorCentavos });
          else if (m.tipo === "ir") financeiro.push({ mes: mesDe(m.data), categoria: "IR sobre aplicações", valorCentavos: -m.valorCentavos });
        }
      }
      const dre = montarDre({ meses, receitas, despesas, financeiro });
      return emReais({ meses, ...dre });
    }),

  /** Consumo de recursos por fonte × categoria (despesas pela competência), acumulado e por mês. */
  consumoPorFonte: finLeituraProc
    .input(z.object({ emitenteId: z.string(), de: zMes.optional(), ate: zMes.optional() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const hj = hoje();
      const ano = mesDe(hj).ano;
      const de = input.de ? mesDeStr(input.de) : { ano, mes: 1 };
      const ate = input.ate ? mesDeStr(input.ate) : { ano, mes: 12 };
      if (compararMes(ate, de) < 0 || idxMes(ate) - idxMes(de) > 35) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "intervalo inválido (máx. 36 meses)" });
      }
      const meses = mesesEntre(de, ate);
      await garantirFontesPadrao(input.emitenteId);
      const [desp, fontes] = await Promise.all([
        buscarLancamentosPorCompetencia(input.emitenteId, "despesa", de, ate),
        prisma.finFonte.findMany({ where: { emitenteId: input.emitenteId }, select: { id: true, nome: true, tipo: true, ativo: true } }),
      ]);
      const itens: ItemConsumo[] = [];
      for (const l of desp) {
        const categoria = normalizarCategoriaDespesa(l.categoria);
        const mes = mesDe(l.comp);
        if (!l.fontes.length) {
          itens.push({ mes, fonteId: "sem_fonte", categoria, valorCentavos: paraCentavos(l.valor) });
          continue;
        }
        for (const f of l.fontes) itens.push({ mes, fonteId: f.fonteId, categoria, valorCentavos: paraCentavos(f.valor) });
      }
      const r = consumoPorFonte(itens, meses);
      const porId = new Map(fontes.map((f) => [f.id, f]));
      return emReais({
        meses,
        ...r,
        fontes: r.fontes.map((f) => ({
          ...f,
          nome: f.fonteId === "sem_fonte" ? "Sem fonte informada" : porId.get(f.fonteId)?.nome ?? "(fonte removida)",
          tipo: f.fonteId === "sem_fonte" ? null : porId.get(f.fonteId)?.tipo ?? null,
        })),
      });
    }),

  /**
   * Painel: saldo devedor PSA (fim do mês corrente, sem previstos), saldo devedor banco (contratual hoje),
   * saldo aplicado, saldo das contas bancárias (banking), valores de terceiros (repasse pendente) e
   * caixa disponível = contas − repasse pendente.
   */
  painel: finLeituraProc
    .input(z.object({ emitenteId: z.string() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const hj = hoje();
      const atual = mesDe(hj);
      const [emps, apls, tab, contas, recs, despMes, orcMes] = await Promise.all([
        carregarEmprestimosDoEmitente(input.emitenteId),
        carregarAplicacoesDoEmitente(input.emitenteId),
        carregarTabelasIndices(),
        prisma.bankAccount.findMany({
          where: { emitenteId: input.emitenteId, isActive: true },
          select: { id: true, name: true, provider: true, currentBalance: true, balanceDate: true, isDefault: true },
        }),
        prisma.finRecebimento.findMany({ where: { emitenteId: input.emitenteId } }),
        buscarLancamentosPorCompetencia(input.emitenteId, "despesa", atual, atual),
        prisma.finOrcamento.findMany({ where: { emitenteId: input.emitenteId, ano: atual.ano, mes: atual.mes }, select: { valor: true } }),
      ]);
      let saldoPsa = 0, saldoBanco = 0;
      const emprestimos = [];
      for (const e of emps) {
        if (!e.ativo) continue;
        if (e.tipo === "psa") {
          const ex = extratoEmprestimoPsa(movsPsa(e), { selic: tab.selic, ate: atual, incluirPrevistos: false });
          const s = ex.linhas.length ? ex.saldoFinal : 0;
          saldoPsa += s;
          emprestimos.push({ id: e.id, nome: e.nome, tipo: e.tipo, saldoDevedor: s, proximaParcela: null as null | { vencimento: string; prestacao: number } });
        } else {
          const c = cronogramaComReais(e, tab.selic, hj);
          const s = c ? c.saldoContratualHoje : principalBancario(e);
          saldoBanco += s;
          emprestimos.push({
            id: e.id, nome: e.nome, tipo: e.tipo, saldoDevedor: s,
            proximaParcela: c?.proximaParcela ? { vencimento: c.proximaParcela.vencimento, prestacao: c.proximaParcela.prestacao } : null,
          });
        }
      }
      let saldoAplicado = 0;
      for (const a of apls) saldoAplicado += saldoAplicacao(movsAplicacao(a), hj).saldo;
      const saldoContas = contas.reduce((acc, c) => acc + paraCentavos(c.currentBalance), 0);
      const totRec = totalizarRecebimentos(recs.map(resumoRecebimento), hj);
      return {
        hoje: hj,
        contas: contas.map((c) => ({ ...c, currentBalance: Number(deCentavos(paraCentavos(c.currentBalance))) })),
        emprestimos: emReais(emprestimos),
        ...emReais({
          saldoDevedorPsa: saldoPsa,
          saldoDevedorBanco: saldoBanco,
          saldoAplicado,
          saldoContas,
          valoresTerceiros: totRec.repassePendente,
          caixaDisponivel: caixaDisponivel(saldoContas, totRec.repassePendente),
          caixaDisponivelComAplicacoes: caixaDisponivel(saldoContas + saldoAplicado, totRec.repassePendente),
          recebimentos: {
            previstoAReceber: totRec.previstoAReceber,
            emAtraso: totRec.emAtraso,
            qtdEmAtraso: totRec.qtdEmAtraso,
            qtdSemNf: totRec.qtdSemNf,
          },
          mesAtual: {
            despesas: despMes.reduce((a, l) => a + paraCentavos(l.valor), 0),
            despesasPagas: despMes.filter((l) => l.pago).reduce((a, l) => a + paraCentavos(l.valor), 0),
            orcado: orcMes.reduce((a, o) => a + paraCentavos(o.valor), 0),
          },
        }),
      };
    }),
});

// ── Auditoria ───────────────────────────────────────────────────────────────

const auditoriaRouter = router({
  /** Log paginado. `incluirGlobais` traz também os registros sem emitente (índices Selic/CDI). */
  listar: finLeituraProc
    .input(z.object({
      emitenteId: z.string(),
      entidade: z.string().optional(),
      entidadeId: z.string().optional(),
      usuarioId: z.string().optional(),
      acao: z.enum(["criar", "atualizar", "excluir"]).optional(),
      de: zDataCal.optional(),
      ate: zDataCal.optional(),
      incluirGlobais: z.boolean().optional(),
      pagina: z.number().int().min(1).default(1),
      porPagina: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const criadoEm: Record<string, Date> = {};
      if (input.de) criadoEm.gte = new Date(deDataCal(input.de).getTime() - 12 * 3_600_000 + 3 * 3_600_000); // 00:00 Bahia
      if (input.ate) criadoEm.lt = new Date(deDataCal(input.ate).getTime() + 12 * 3_600_000 + 3 * 3_600_000); // 24:00 Bahia
      const where = {
        // "globais" = só os índices Selic/CDI (tabela global). Outros logs sem emitente (Acordo,
        // AcordoAvaliacao, CrmDeal, Configuracao) são de algum tenant e não podem vazar para os demais.
        ...(input.incluirGlobais
          ? { OR: [{ emitenteId: input.emitenteId }, { emitenteId: null, entidade: "FinIndiceMensal" }] }
          : { emitenteId: input.emitenteId }),
        ...(input.entidade ? { entidade: input.entidade } : {}),
        ...(input.entidadeId ? { entidadeId: input.entidadeId } : {}),
        ...(input.usuarioId ? { usuarioId: input.usuarioId } : {}),
        ...(input.acao ? { acao: input.acao } : {}),
        ...(input.de || input.ate ? { criadoEm } : {}),
      };
      const [total, itens] = await Promise.all([
        prisma.finAuditLog.count({ where }),
        prisma.finAuditLog.findMany({
          where, orderBy: { criadoEm: "desc" },
          skip: (input.pagina - 1) * input.porPagina, take: input.porPagina,
        }),
      ]);
      const uids = [...new Set(itens.map((i) => i.usuarioId).filter((x): x is string => !!x))];
      const usuarios = uids.length ? await prisma.usuario.findMany({ where: { id: { in: uids } }, select: { id: true, nome: true, email: true } }) : [];
      const porId = new Map(usuarios.map((u) => [u.id, u]));
      return {
        total,
        pagina: input.pagina,
        porPagina: input.porPagina,
        totalPaginas: Math.max(1, Math.ceil(total / input.porPagina)),
        itens: itens.map((i) => ({ ...i, usuario: i.usuarioId ? porId.get(i.usuarioId) ?? null : null })),
      };
    }),

  entidades: finLeituraProc
    .input(z.object({ emitenteId: z.string() }))
    .query(async ({ input, ctx }) => {
      await emitenteOk(ctx, input.emitenteId);
      const rows = await prisma.finAuditLog.findMany({ where: { emitenteId: input.emitenteId }, distinct: ["entidade"], select: { entidade: true } });
      return rows.map((r) => r.entidade).sort();
    }),
});

export const finGerencialRouter = router({
  fontes: fontesRouter,
  despesas: despesasRouter,
  orcamento: orcamentoRouter,
  indices: indicesRouter,
  emprestimos: emprestimosRouter,
  aplicacoes: aplicacoesRouter,
  relatorios: relatoriosRouter,
  auditoria: auditoriaRouter,
});
