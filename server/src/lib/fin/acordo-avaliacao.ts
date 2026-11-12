/**
 * Tarefa de avaliação prévia de acordo (§2.1) — gatilho chamado pelos pontos que movem o card
 * (crm.moveDeal) ou gravam o CNJ (crm.updateDeal), e recálculo do prazo quando a audiência
 * é marcada (audiencia.salvar).
 *
 * Regras:
 *  - só deals de funil `tipo: "processual"`;
 *  - gatilho "coluna": a coluna ATUAL do deal tem chave contendo `ajuizado` (a chave é lida da
 *    própria stage do deal — nunca se busca stage por chave sem pipelineId);
 *  - gatilho "cnj": quem chama garante que é a primeira vez (CNJ estava vazio);
 *  - idempotente por dealId (AcordoAvaliacao.dealId @unique);
 *  - preenche `deal.ajuizadoEm` se vazio (data de hoje, America/Bahia);
 *  - nunca lança: erro só é logado, a operação principal segue.
 */
import { prisma } from "../../db.js";
import { registrarAudit } from "./audit.js";
import { deDataCal, paraDataCal } from "./util.js";
import { ehColunaAjuizado, escolherResponsavelInicial, prazoAvaliacao } from "./acordo-indicadores.js";

export type GatilhoAvaliacao = "coluna" | "cnj" | "manual";

export function hojeCal(): string {
  return paraDataCal(new Date());
}

/** Calcula o prazoEm a partir do deal (audiência − 5 dias; senão protocolo + 10). */
export function prazoDoDeal(deal: { audienciaEm: Date | null; ajuizadoEm: Date | null }): Date {
  const protocolo = deal.ajuizadoEm ? paraDataCal(deal.ajuizadoEm) : hojeCal();
  const audiencia = deal.audienciaEm ? paraDataCal(deal.audienciaEm) : null;
  return deDataCal(prazoAvaliacao({ protocolo, audiencia }));
}

/**
 * Cria a AcordoAvaliacao do deal se ele acabou de ser ajuizado. Retorna o id da avaliação
 * (nova ou existente) ou null quando não se aplica / deu erro.
 */
export async function garantirAvaliacaoAcordo(
  dealId: string,
  opts: { gatilho: GatilhoAvaliacao; usuarioId?: string | null },
): Promise<string | null> {
  try {
    const deal = await prisma.crmDeal.findUnique({
      where: { id: dealId },
      select: {
        id: true, numeroCnj: true, audienciaEm: true, ajuizadoEm: true, responsavelId: true,
        stage: { select: { chave: true } },
        pipeline: { select: { tipo: true } },
        acordoAvaliacao: { select: { id: true, decisao: true } },
      },
    });
    if (!deal || deal.pipeline?.tipo !== "processual") return null;
    if (opts.gatilho === "coluna" && !ehColunaAjuizado(deal.stage?.chave)) return null;
    if (opts.gatilho === "cnj" && !deal.numeroCnj?.trim()) return null;

    let ajuizadoEm = deal.ajuizadoEm;
    if (!ajuizadoEm) {
      ajuizadoEm = deDataCal(hojeCal());
      await prisma.crmDeal.update({ where: { id: dealId }, data: { ajuizadoEm } });
      await registrarAudit(prisma, { userId: opts.usuarioId ?? undefined }, {
        entidade: "CrmDeal", entidadeId: dealId, acao: "atualizar",
        antes: { ajuizadoEm: null }, depois: { ajuizadoEm, via: `avaliacao:${opts.gatilho}` },
      });
    }

    if (deal.acordoAvaliacao) return deal.acordoAvaliacao.id;

    const logs = await prisma.crmDealStageLog.findMany({
      where: { dealId },
      orderBy: { criadoEm: "desc" },
      take: 50,
      select: { usuarioId: true, stageAnteriorId: true, stageNovoId: true, criadoEm: true },
    });
    const ids = [...new Set(logs.flatMap((l) => [l.stageAnteriorId, l.stageNovoId]).filter((x): x is string => !!x))];
    const chaves = new Map(
      (await prisma.crmStage.findMany({ where: { id: { in: ids } }, select: { id: true, chave: true } })).map((s) => [s.id, s.chave]),
    );
    const responsavelId = escolherResponsavelInicial(
      logs.map((l) => ({
        usuarioId: l.usuarioId,
        chaveAnterior: l.stageAnteriorId ? chaves.get(l.stageAnteriorId) ?? null : null,
        chaveNova: chaves.get(l.stageNovoId) ?? null,
        criadoEm: l.criadoEm,
      })),
      deal.responsavelId,
      opts.usuarioId,
    );

    const av = await prisma.acordoAvaliacao.create({
      data: { dealId, responsavelId, prazoEm: prazoDoDeal({ audienciaEm: deal.audienciaEm, ajuizadoEm }) },
    });
    await registrarAudit(prisma, { userId: opts.usuarioId ?? undefined }, {
      entidade: "AcordoAvaliacao", entidadeId: av.id, acao: "criar", depois: { ...av, gatilho: opts.gatilho },
    });
    return av.id;
  } catch (err: any) {
    if (err?.code === "P2002") {
      const av = await prisma.acordoAvaliacao.findUnique({ where: { dealId }, select: { id: true } }).catch(() => null);
      return av?.id ?? null;
    }
    console.warn(`[AcordoAvaliacao] falha ao criar avaliação deal=${dealId}: ${err?.message ?? err}`);
    return null;
  }
}

/** Audiência marcada/alterada depois: recalcula o prazo se ainda não houver decisão. Nunca lança. */
export async function recalcularPrazoAvaliacao(dealId: string): Promise<void> {
  try {
    const av = await prisma.acordoAvaliacao.findUnique({
      where: { dealId },
      select: { id: true, decisao: true, prazoEm: true, deal: { select: { audienciaEm: true, ajuizadoEm: true } } },
    });
    if (!av || av.decisao) return;
    const novo = prazoDoDeal(av.deal);
    if (av.prazoEm && av.prazoEm.getTime() === novo.getTime()) return;
    await prisma.acordoAvaliacao.update({ where: { id: av.id }, data: { prazoEm: novo } });
  } catch (err: any) {
    console.warn(`[AcordoAvaliacao] falha ao recalcular prazo deal=${dealId}: ${err?.message ?? err}`);
  }
}
