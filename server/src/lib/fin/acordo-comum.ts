/**
 * Peças comuns de routers/acordos.ts e routers/recebimentos.ts: acesso ao deal (tenant),
 * resolução do emitente, conversões de dinheiro/data para a resposta e validadores zod.
 *
 * Emitente de um deal/acordo: não há vínculo direto CrmDeal → EmpresaEmitente. Regra:
 *  - informado → validado com `assertEmitenteDoTenant` (2A);
 *  - não informado → o único emitente ATIVO da empresa do deal acessível ao usuário;
 *    se houver 0 ou vários, BAD_REQUEST pedindo para informar.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { canAccessEmitente, canOperate, whereEmpresa, type TenantCtx } from "../../routers/tenant-utils.js";
import { assertEmitenteDoTenant, type CtxPerm } from "./perm.js";
import { deCentavos, paraCentavos, paraDataCal, deDataCal, type Numerico } from "./util.js";
import { empresaReDoDeal } from "./acordo-indicadores.js";

// ── Validadores ──────────────────────────────────────────────────────────────

export const zDataCal = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "data no formato AAAA-MM-DD");
/** Valor em reais: número (1234.56) ou string ("1234.56" / "1234,56"). */
export const zValor = z.union([z.number().finite(), z.string().trim().min(1).max(20)]);
/** Caminho/nome de arquivo devolvido pelo endpoint de upload (2A). Sem "..". */
export const zArquivo = z.string().max(1000).refine((s) => !s.includes(".."), "caminho inválido");

export function centavosDe(v: z.infer<typeof zValor>): number {
  try {
    return paraCentavos(v);
  } catch {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Valor inválido: ${v}` });
  }
}

/** Decimal/num → number em reais com 2 casas (para a resposta). */
export function reais(v: Numerico | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number(deCentavos(paraCentavos(v)));
}

export function reaisDeCentavos(c: number): number {
  return Number(deCentavos(c));
}

export function cal(d: Date | null | undefined): string | null {
  return d ? paraDataCal(d) : null;
}

export function dataDe(s: string | null | undefined): Date | null | undefined {
  if (s === undefined) return undefined;
  if (s === null) return null;
  return deDataCal(s);
}

// ── Deal / tenant ────────────────────────────────────────────────────────────

/** Deal importado nasce com empresaId nulo: o dono é a empresa do pipeline (mesma regra do crm.ts). */
export const empresaDoDeal = (deal: { empresaId?: string | null; pipeline?: { empresaId: string | null } | null } | null) =>
  deal?.empresaId ?? deal?.pipeline?.empresaId ?? null;

/** Filtro de CrmDeal visível ao usuário (empresa do deal ou, se nula, a do pipeline). */
export function whereDealDoTenant(ctx: TenantCtx): Prisma.CrmDealWhereInput {
  const w = whereEmpresa(ctx) as Prisma.CrmDealWhereInput;
  if (Object.keys(w).length === 0) return {};
  return { OR: [w, { empresaId: null, pipeline: whereEmpresa(ctx) as Prisma.CrmPipelineWhereInput }] };
}

export const SELECT_DEAL_RESUMO = {
  id: true, titulo: true, empresaId: true, pipelineId: true, stageId: true, numeroCnj: true, responsavelId: true,
  valorCausaAjuizada: true, valorEstimado: true, valorCondenacao: true, valorAcordo: true,
  ajuizadoEm: true, audienciaEm: true, organizacao: true, status: true,
  pipeline: { select: { id: true, nome: true, empresaId: true, tipo: true } },
  stage: { select: { id: true, nome: true, chave: true } },
  contato: { select: { id: true, nome: true, whatsapp: true, cpf: true, empresa: true } },
  vinculos: { orderBy: { ordem: "asc" as const }, take: 1, select: { empresa: true, funcao: true } },
} satisfies Prisma.CrmDealSelect;

export type DealResumo = Prisma.CrmDealGetPayload<{ select: typeof SELECT_DEAL_RESUMO }>;

export async function carregarDealAcessivel(ctx: TenantCtx, dealId: string): Promise<DealResumo> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: SELECT_DEAL_RESUMO });
  if (!deal) throw new TRPCError({ code: "NOT_FOUND", message: "Processo não encontrado" });
  if (!canOperate(ctx, empresaDoDeal(deal))) throw new TRPCError({ code: "FORBIDDEN", message: "Processo não pertence à sua empresa" });
  return deal;
}

export function empresaRe(deal: {
  vinculos?: Array<{ empresa: string | null }> | null;
  contato?: { empresa: string | null } | null;
  organizacao?: string | null;
}) {
  return empresaReDoDeal({
    vinculoEmpresa: deal.vinculos?.[0]?.empresa,
    contatoEmpresa: deal.contato?.empresa,
    organizacao: deal.organizacao,
  });
}

/** Forma do deal nas respostas (valores em reais, datas DataCal). */
export function dealParaResposta(d: DealResumo) {
  return {
    id: d.id,
    titulo: d.titulo,
    numeroCnj: d.numeroCnj,
    status: d.status,
    pipeline: d.pipeline ? { id: d.pipeline.id, nome: d.pipeline.nome, tipo: d.pipeline.tipo } : null,
    stage: d.stage,
    contato: d.contato,
    responsavelId: d.responsavelId,
    empresaRe: empresaRe(d),
    valorCausa: reais(d.valorCausaAjuizada ?? d.valorEstimado),
    valorCausaAjuizada: reais(d.valorCausaAjuizada),
    valorEstimado: reais(d.valorEstimado),
    valorCondenacao: reais(d.valorCondenacao),
    valorAcordo: reais(d.valorAcordo),
    ajuizadoEm: cal(d.ajuizadoEm),
    audienciaEm: d.audienciaEm, // data e hora (ISO)
  };
}

// ── Emitente ─────────────────────────────────────────────────────────────────

/** Emitentes ativos da empresa do deal acessíveis ao usuário + sugestão (único). */
export async function emitentesDoDeal(ctx: TenantCtx, deal: { empresaId: string | null; pipeline: { empresaId: string | null } | null }) {
  const empresaId = empresaDoDeal(deal);
  const lista = empresaId
    ? await prisma.empresaEmitente.findMany({
        where: { empresaId, ativo: true },
        select: { id: true, nome: true, nomeFantasia: true, cnpj: true },
        orderBy: { nome: "asc" },
      })
    : [];
  const acessiveis = lista.filter((e) => canAccessEmitente(ctx, e.id));
  return { emitentes: acessiveis, sugerido: acessiveis.length === 1 ? acessiveis[0].id : null };
}

export async function resolverEmitente(
  ctx: CtxPerm,
  deal: { empresaId: string | null; pipeline: { empresaId: string | null } | null } | null,
  emitenteId: string | null | undefined,
): Promise<string> {
  if (emitenteId) {
    await assertEmitenteDoTenant(ctx, emitenteId);
    return emitenteId;
  }
  if (deal) {
    const { sugerido } = await emitentesDoDeal(ctx, deal);
    if (sugerido) return sugerido;
  }
  throw new TRPCError({ code: "BAD_REQUEST", message: "Informe a empresa emissora (emitenteId)" });
}
