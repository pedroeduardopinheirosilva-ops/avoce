/**
 * Alertas de recebimentos e acordos (query `recebimentos.alertas` e resumo diário do cron).
 *
 *  - parcela/recebimento vencido e não recebido;
 *  - repasse ao cliente pendente há mais de X dias do recebimento (Configuracao
 *    `fin_alerta_repasse_dias:<empresaId>` → `fin_alerta_repasse_dias:global` → 5);
 *  - recebido sem NF emitida (nfStatus a_emitir);
 *  - follow-up de acordo aberto vencido;
 *  - avaliação prévia sem decisão com prazo vencendo hoje ou estourado.
 *
 * O resumo diário só sai para projetos com o evento de notificação `alertas_acordos` ativo
 * (Config IA → Notificações; mesmo canal/padrão de `followups_do_dia`), uma vez por dia e só
 * se houver alerta. Variáveis do modelo: {{data}} {{total}} {{parcelasVencidas}}
 * {{repassesPendentes}} {{semNf}} {{followupsVencidos}} {{avaliacoesAtrasadas}} {{lista}} {{link}}.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { whereEmpresa, type TenantCtx } from "../../routers/tenant-utils.js";
import { deDataCal, paraDataCal, paraCentavos, deCentavos, diasEntre, type DataCal } from "./util.js";
import { addDias, STATUS_ABERTOS } from "./acordo-indicadores.js";
import { whereDealDoTenant } from "./acordo-comum.js";

export const CFG_REPASSE_DIAS = "fin_alerta_repasse_dias";
export const DIAS_REPASSE_PADRAO = 5;
export const EVENTO_ALERTAS = "alertas_acordos";

export async function diasRepasseConfig(empresaId: string | null | undefined): Promise<number> {
  const chaves = [`${CFG_REPASSE_DIAS}:${empresaId ?? "global"}`, `${CFG_REPASSE_DIAS}:global`];
  const cfgs = await prisma.configuracao.findMany({ where: { chave: { in: chaves } } });
  const cfg = cfgs.find((c) => c.chave === chaves[0]) ?? cfgs.find((c) => c.chave === chaves[1]);
  const n = cfg ? parseInt(cfg.valor, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DIAS_REPASSE_PADRAO;
}

/**
 * FinRecebimento visível ao usuário. Lista explícita de emitentes → só ela; senão os emitentes
 * das empresas do usuário (admin global: tudo). Mais estrito que `whereEmitenteFilter`, que
 * para usuário sem empresa primária não filtrava nada.
 */
export function whereRecebimentoDoTenant(ctx: TenantCtx): Prisma.FinRecebimentoWhereInput {
  const lista = ctx.emitentesAcessiveis;
  if (Array.isArray(lista)) return { emitenteId: { in: lista.length ? lista : ["__none__"] } };
  const emp = whereEmpresa(ctx) as Prisma.EmpresaEmitenteWhereInput;
  if (Object.keys(emp).length === 0) return {};
  return { emitente: emp };
}

const SEL_DEAL = { id: true, titulo: true, numeroCnj: true, contato: { select: { nome: true } } } as const;

export interface ItemAlerta {
  id: string;
  dealId: string | null;
  titulo: string;
  cliente: string | null;
  numeroCnj: string | null;
  data: DataCal | null; // vencimento / recebimento / follow-up / prazo
  dias: number; // dias de atraso
  valor: number | null; // reais
  acordoId?: string | null;
  parcelaNumero?: number | null;
}

export interface Alertas {
  diasRepasse: number;
  hoje: DataCal;
  parcelasVencidas: ItemAlerta[];
  repassesPendentes: ItemAlerta[];
  semNf: ItemAlerta[];
  followupsVencidos: ItemAlerta[];
  avaliacoesAtrasadas: ItemAlerta[];
  contagens: { parcelasVencidas: number; repassesPendentes: number; semNf: number; followupsVencidos: number; avaliacoesAtrasadas: number; total: number };
}

const reais = (v: { toString(): string } | null | undefined) => (v === null || v === undefined ? null : Number(deCentavos(paraCentavos(v))));

export async function coletarAlertas(args: {
  ctx: TenantCtx;
  diasRepasse: number;
  emitenteId?: string;
  hoje?: DataCal;
  limite?: number;
}): Promise<Alertas> {
  const hoje = args.hoje ?? paraDataCal(new Date());
  const limite = args.limite ?? 100;
  const hojeD = deDataCal(hoje);
  const whereRec: Prisma.FinRecebimentoWhereInput = {
    ...whereRecebimentoDoTenant(args.ctx),
    ...(args.emitenteId ? { emitenteId: args.emitenteId } : {}),
  };
  const whereDeal = whereDealDoTenant(args.ctx);
  const corteRepasse = deDataCal(addDias(hoje, -args.diasRepasse));

  const wVenc: Prisma.FinRecebimentoWhereInput = { AND: [whereRec, { dataRecebimento: null, vencimento: { lt: hojeD } }] };
  const wRep: Prisma.FinRecebimentoWhereInput = { AND: [whereRec, { dataRecebimento: { lte: corteRepasse }, repasseStatus: "pendente", valorRepasse: { gt: 0 } }] };
  const wNf: Prisma.FinRecebimentoWhereInput = { AND: [whereRec, { dataRecebimento: { not: null }, nfStatus: "a_emitir" }] };
  const wFu: Prisma.AcordoWhereInput = {
    deal: whereDeal, status: { in: [...STATUS_ABERTOS] }, proximoFollowupEm: { lt: hojeD },
    ...(args.emitenteId ? { OR: [{ emitenteId: args.emitenteId }, { emitenteId: null }] } : {}),
  };
  const wAv: Prisma.AcordoAvaliacaoWhereInput = { deal: whereDeal, decisao: null, prazoEm: { lte: hojeD } };

  const [venc, rep, nf, fu, av, cVenc, cRep, cNf, cFu, cAv] = await Promise.all([
    prisma.finRecebimento.findMany({ where: wVenc, orderBy: { vencimento: "asc" }, take: limite, include: { deal: { select: SEL_DEAL } } }),
    prisma.finRecebimento.findMany({ where: wRep, orderBy: { dataRecebimento: "asc" }, take: limite, include: { deal: { select: SEL_DEAL } } }),
    prisma.finRecebimento.findMany({ where: wNf, orderBy: { dataRecebimento: "asc" }, take: limite, include: { deal: { select: SEL_DEAL } } }),
    prisma.acordo.findMany({ where: wFu, orderBy: { proximoFollowupEm: "asc" }, take: limite, include: { deal: { select: SEL_DEAL } } }),
    prisma.acordoAvaliacao.findMany({ where: wAv, orderBy: { prazoEm: "asc" }, take: limite, include: { deal: { select: SEL_DEAL } } }),
    prisma.finRecebimento.count({ where: wVenc }),
    prisma.finRecebimento.count({ where: wRep }),
    prisma.finRecebimento.count({ where: wNf }),
    prisma.acordo.count({ where: wFu }),
    prisma.acordoAvaliacao.count({ where: wAv }),
  ]);

  const item = (o: { id: string; dealId: string | null; deal: { titulo: string; numeroCnj: string | null; contato: { nome: string } | null } | null }, data: Date | null, valor: number | null, extra: Partial<ItemAlerta> = {}): ItemAlerta => {
    const d = data ? paraDataCal(data) : null;
    return {
      id: o.id, dealId: o.dealId, titulo: o.deal?.titulo ?? "(sem processo)", cliente: o.deal?.contato?.nome ?? null,
      numeroCnj: o.deal?.numeroCnj ?? null, data: d, dias: d ? Math.max(0, diasEntre(d, hoje)) : 0, valor, ...extra,
    };
  };

  return {
    diasRepasse: args.diasRepasse,
    hoje,
    parcelasVencidas: venc.map((r) => item(r, r.vencimento, reais(r.valorPrevisto), { acordoId: r.acordoId, parcelaNumero: r.parcelaNumero })),
    repassesPendentes: rep.map((r) => item(r, r.dataRecebimento, reais(r.valorRepasse), { acordoId: r.acordoId, parcelaNumero: r.parcelaNumero })),
    semNf: nf.map((r) => item(r, r.dataRecebimento, reais(r.nfValor ?? r.valorHonorarios), { acordoId: r.acordoId, parcelaNumero: r.parcelaNumero })),
    followupsVencidos: fu.map((a) => item(a, a.proximoFollowupEm, null, { acordoId: a.id })),
    avaliacoesAtrasadas: av.map((a) => item(a, a.prazoEm, null, { acordoId: a.acordoId })),
    contagens: { parcelasVencidas: cVenc, repassesPendentes: cRep, semNf: cNf, followupsVencidos: cFu, avaliacoesAtrasadas: cAv, total: cVenc + cRep + cNf + cFu + cAv },
  };
}

const TZ = "America/Sao_Paulo";

/** Resumo diário (cron). Uma mensagem por projeto/dia, só se houver alerta e o evento estiver ativo. */
export async function enviarResumoAlertasAcordos(): Promise<void> {
  const eventos = await prisma.iaNotificacaoEvento.findMany({
    where: { evento: EVENTO_ALERTAS, ativo: true },
    select: { projetoId: true },
    distinct: ["projetoId"],
  });
  if (!eventos.length) return;
  const { dispararNotificacoes } = await import("../../agent/message-handler.js");
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const inicio = new Date(`${hoje}T00:00:00-03:00`);

  for (const { projetoId } of eventos) {
    try {
      const jaFoi = await prisma.iaNotificacaoLog.count({ where: { projetoId, evento: EVENTO_ALERTAS, enviadaEm: { gte: inicio } } });
      if (jaFoi) continue;
      const projeto = await prisma.iaProjeto.findUnique({ where: { id: projetoId }, select: { empresaId: true } });
      if (!projeto?.empresaId) continue; // sem empresa não há como isolar o tenant
      const ctx: TenantCtx = { empresaId: projeto.empresaId, empresaIds: [projeto.empresaId], role: "user", emitentesAcessiveis: null };
      const a = await coletarAlertas({ ctx, diasRepasse: await diasRepasseConfig(projeto.empresaId), limite: 5 });
      if (!a.contagens.total) continue;

      const brl = (v: number | null) => (v === null ? "" : ` — R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      const bloco = (titulo: string, n: number, itens: ItemAlerta[], fmt: (i: ItemAlerta) => string) =>
        n ? `*${titulo} (${n})*\n${itens.map((i) => `• ${fmt(i)}`).join("\n")}${n > itens.length ? `\n… e mais ${n - itens.length}` : ""}` : "";
      const lista = [
        bloco("Parcelas vencidas", a.contagens.parcelasVencidas, a.parcelasVencidas, (i) => `${i.cliente ?? i.titulo} — ${i.dias}d${brl(i.valor)}`),
        bloco(`Repasses pendentes há +${a.diasRepasse}d`, a.contagens.repassesPendentes, a.repassesPendentes, (i) => `${i.cliente ?? i.titulo} — ${i.dias}d${brl(i.valor)}`),
        bloco("Recebidos sem NF", a.contagens.semNf, a.semNf, (i) => `${i.cliente ?? i.titulo}${brl(i.valor)}`),
        bloco("Follow-ups de acordo vencidos", a.contagens.followupsVencidos, a.followupsVencidos, (i) => `${i.cliente ?? i.titulo} — ${i.dias}d`),
        bloco("Avaliações prévias de acordo sem decisão", a.contagens.avaliacoesAtrasadas, a.avaliacoesAtrasadas, (i) => `${i.cliente ?? i.titulo} — prazo ${i.data?.slice(8, 10)}/${i.data?.slice(5, 7)}`),
      ].filter(Boolean).join("\n\n");

      await dispararNotificacoes(projetoId, EVENTO_ALERTAS, {
        data: `${hoje.slice(8, 10)}/${hoje.slice(5, 7)}`,
        total: String(a.contagens.total),
        parcelasVencidas: String(a.contagens.parcelasVencidas),
        repassesPendentes: String(a.contagens.repassesPendentes),
        semNf: String(a.contagens.semNf),
        followupsVencidos: String(a.contagens.followupsVencidos),
        avaliacoesAtrasadas: String(a.contagens.avaliacoesAtrasadas),
        lista,
        link: `${process.env.APP_BASE_URL ?? "https://avoce.capium.com.br"}/recebimentos`,
      });
    } catch (err: any) {
      console.error(`[AlertasAcordos] erro projeto=${projetoId}: ${err?.message ?? err}`);
    }
  }
}
