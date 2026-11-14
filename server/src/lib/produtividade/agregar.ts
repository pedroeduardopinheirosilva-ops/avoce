import { prisma } from "../../db.js";
import { calcularDia, dataLocal } from "./calculo.js";
import { DIA_MS, corteRetencao, limiteRetencao } from "./retencao.js";
import type { EventoBruto, Expediente, Regra, ResultadoDia } from "./tipos.js";

export type EntradasDia = {
  eventos: EventoBruto[];
  regras: Regra[];
  pessoa: { usuarioId: string; cargoId: string | null; expediente: Expediente | null };
};

/** Carrega eventos brutos (com folga de 1 dia antes e 2 depois), regras aplicáveis, cargo e expediente do usuário. */
export async function carregarEntradasDia(usuarioId: string, data: string): Promise<EntradasDia> {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { monitorCargoId: true, monitorExpediente: true },
  });
  const cargoId = usuario?.monitorCargoId ?? null;

  const dispositivos = await prisma.monitorDispositivo.findMany({ where: { usuarioId }, select: { id: true } });

  const inicioDia = new Date(`${data}T00:00:00-03:00`).getTime();
  const eventosDb = dispositivos.length
    ? await prisma.monitorEvento.findMany({
        where: {
          dispositivoId: { in: dispositivos.map((d) => d.id) },
          inicio: { gte: new Date(inicioDia - DIA_MS), lt: new Date(inicioDia + 2 * DIA_MS) },
        },
      })
    : [];
  const eventos: EventoBruto[] = eventosDb.map((e) => ({
    dispositivoId: e.dispositivoId,
    bucket: e.bucket as EventoBruto["bucket"],
    inicio: e.inicio,
    duracaoSeg: e.duracaoSeg,
    app: e.app,
    titulo: e.titulo,
    url: e.url,
    dominio: e.dominio,
    afk: e.afk,
  }));

  const regrasDb = await prisma.monitorRegra.findMany({
    where: {
      OR: [
        { cargoId: null, usuarioId: null },
        ...(cargoId ? [{ cargoId }] : []),
        { usuarioId },
      ],
    },
  });
  const regras: Regra[] = regrasDb.map((r) => ({
    alvo: r.alvo as Regra["alvo"],
    padrao: r.padrao,
    categoria: r.categoria as Regra["categoria"],
    cargoId: r.cargoId,
    usuarioId: r.usuarioId,
    prioridade: r.prioridade,
  }));

  const expediente = (usuario?.monitorExpediente as Expediente | null | undefined) ?? null;
  return { eventos, regras, pessoa: { usuarioId, cargoId, expediente } };
}

/**
 * Calcula o dia do usuário a partir dos eventos brutos e grava o agregado em MonitorDia (sujo=false).
 * Dias anteriores ao limite de retenção não têm mais todos os eventos brutos: o total gravado é
 * permanente e nunca é sobrescrito — só se limpa `sujo` e devolve null.
 */
export async function recalcularDia(usuarioId: string, data: string): Promise<ResultadoDia | null> {
  if (data < limiteRetencao()) {
    await prisma.monitorDia.updateMany({ where: { usuarioId, data, sujo: true }, data: { sujo: false } });
    return null;
  }
  const { eventos, regras, pessoa } = await carregarEntradasDia(usuarioId, data);
  const r = calcularDia(data, eventos, regras, pessoa);

  const campos = {
    segAtivo: Math.round(r.dentro.ativo),
    segTrabalho: Math.round(r.dentro.trabalho),
    segPessoal: Math.round(r.dentro.pessoal),
    segNeutro: Math.round(r.dentro.neutro),
    segAtivoFora: Math.round(r.fora.ativo),
    segTrabalhoFora: Math.round(r.fora.trabalho),
    segPessoalFora: Math.round(r.fora.pessoal),
    segNeutroFora: Math.round(r.fora.neutro),
    primeiroEvento: r.primeiroEvento,
    ultimoEvento: r.ultimoEvento,
    topJson: r.top as object,
    sujo: false,
    calculadoEm: new Date(),
  };
  await prisma.monitorDia.upsert({
    where: { usuarioId_data: { usuarioId, data } },
    create: { usuarioId, data, ...campos },
    update: campos,
  });
  return r;
}

/** Marca "hoje" sujo para quem está sendo monitorado e recalcula até `limite` dias sujos. */
export async function recalcularSujos(limite = 200): Promise<number> {
  const hoje = dataLocal(new Date());
  const monitorados = await prisma.usuario.findMany({
    where: { monitorado: true, monitorDispositivos: { some: { ativo: true } } },
    select: { id: true },
  });
  for (const u of monitorados) {
    await prisma.monitorDia.upsert({
      where: { usuarioId_data: { usuarioId: u.id, data: hoje } },
      create: { usuarioId: u.id, data: hoje, sujo: true },
      update: { sujo: true },
    });
  }

  const sujos = await prisma.monitorDia.findMany({
    where: { sujo: true },
    orderBy: { data: "desc" },
    take: limite,
    select: { usuarioId: true, data: true },
  });
  let n = 0;
  for (const s of sujos) {
    try {
      await recalcularDia(s.usuarioId, s.data);
      n++;
    } catch (err) {
      console.error(`[PRODUTIVIDADE] Falha ao recalcular ${s.usuarioId} ${s.data}:`, err);
    }
  }
  return n;
}

/**
 * Marca como sujos (para o cron recalcular) os dias ainda recalculáveis — `data >= limiteRetencao()` —
 * das pessoas monitoradas no escopo: `usuarioId` → só ela; `cargoId` → quem tem o cargo; nenhum → todas.
 * Usado quando regras, cargo ou expediente mudam.
 */
export async function sujarDias(escopo: { usuarioId?: string | null; cargoId?: string | null }): Promise<number> {
  const usuario = escopo.usuarioId
    ? { id: escopo.usuarioId, monitorado: true }
    : escopo.cargoId
      ? { monitorCargoId: escopo.cargoId, monitorado: true }
      : { monitorado: true };
  const r = await prisma.monitorDia.updateMany({
    where: { data: { gte: limiteRetencao() }, sujo: false, usuario },
    data: { sujo: true },
  });
  return r.count;
}

/** Retenção de eventos brutos: 90 dias. MonitorDia é permanente. */
export async function apagarEventosAntigos(): Promise<number> {
  const corte = new Date(corteRetencao());
  const r = await prisma.monitorEvento.deleteMany({ where: { inicio: { lt: corte } } });
  return r.count;
}
