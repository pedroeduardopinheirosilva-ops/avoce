/**
 * Disparo segmentado: uma mensagem para um recorte do funil (etapas, etiquetas, origem),
 * enviada DEVAGAR pelo cron — o número do escritório já foi bloqueado por rajada de envio.
 *
 * Travas de segurança (todas no servidor, a tela só escolhe dentro delas):
 *  - 1 mensagem por tick do cron, respeitando `intervaloSeg` (mín. 30 s) entre envios;
 *  - teto diário `limiteDia` (máx. 300) somando TODOS os disparos do projeto no dia;
 *  - só seg–sáb, 8h–20h (São Paulo);
 *  - por padrão só quem já mandou mensagem alguma vez (contato frio é o que gera denúncia);
 *  - pula quem recebeu mensagem nossa nas últimas `pularContatadosHoras` horas;
 *  - Instagram/Messenger só dentro das 24 h da última mensagem do lead (regra da Meta).
 */

import { prisma } from "../db.js";
import { preencher, enviarManualSocial } from "./meta-social.js";

export type FiltroDisparo = {
  pipelineId: string;
  stageIds?: string[];
  tagIds?: string[];
  origemTipos?: string[];        // anuncio | organico | link | sem
  palavras?: string[];           // origemAnuncioId (palavra-chave / vídeo)
  somenteQuemConversou?: boolean; // padrão true
  pularContatadosHoras?: number;  // padrão 72
};

export const INTERVALO_MIN_SEG = 30;
export const LIMITE_DIA_MAX = 300;
const H24 = 24 * 3_600_000;

type Candidato = {
  id: string; titulo: string; projetoId: string | null; empresaId: string | null;
  contato: { nome: string; whatsapp: string | null; instagramId: string | null; messengerId: string | null } | null;
  ultimaIn: { enviadaEm: Date; canal: string } | null;
  ultimaOut: Date | null;
};

/** Canal do envio, ou o motivo de pular. Pura (testada em disparos.test.ts). */
export function canalDoCandidato(c: Pick<Candidato, "contato" | "ultimaIn" | "ultimaOut">, f: FiltroDisparo, agora = new Date()):
  { canal: "whatsapp" | "instagram" | "messenger" } | { pular: string } {
  if (!c.contato) return { pular: "sem contato" };
  if ((f.somenteQuemConversou ?? true) && !c.ultimaIn) return { pular: "nunca mandou mensagem" };
  const horas = f.pularContatadosHoras ?? 72;
  if (horas > 0 && c.ultimaOut && agora.getTime() - c.ultimaOut.getTime() < horas * 3_600_000) {
    return { pular: `recebeu mensagem nas últimas ${horas}h` };
  }
  if (c.contato.whatsapp) return { canal: "whatsapp" };
  const social = c.ultimaIn && (c.ultimaIn.canal === "instagram" || c.ultimaIn.canal === "messenger") ? c.ultimaIn.canal as "instagram" | "messenger" : null;
  if (social) {
    if (agora.getTime() - c.ultimaIn!.enviadaEm.getTime() > H24) return { pular: "fora das 24h do Instagram/Messenger" };
    return { canal: social };
  }
  return { pular: "sem canal" };
}

/** Seg–sáb, 8h–20h em São Paulo. */
export function dentroDoHorario(agora = new Date()): boolean {
  const sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return sp.getDay() !== 0 && sp.getHours() >= 8 && sp.getHours() < 20;
}

export async function candidatos(f: FiltroDisparo, whereEmpresa: object): Promise<Candidato[]> {
  const origemOr: any[] = [];
  for (const t of f.origemTipos ?? []) origemOr.push(t === "sem" ? { origemTipo: null } : { origemTipo: t });
  const deals = await prisma.crmDeal.findMany({
    where: {
      ...whereEmpresa,
      pipelineId: f.pipelineId,
      status: "aberto",
      ...(f.stageIds?.length ? { stageId: { in: f.stageIds } } : {}),
      ...(f.tagIds?.length ? { tags: { some: { id: { in: f.tagIds } } } } : {}),
      ...(origemOr.length ? { OR: origemOr } : {}),
      ...(f.palavras?.length ? { origemAnuncioId: { in: f.palavras } } : {}),
    },
    select: {
      id: true, titulo: true, projetoId: true, empresaId: true,
      contato: { select: { nome: true, whatsapp: true, instagramId: true, messengerId: true } },
    },
    take: 5000,
  });
  if (!deals.length) return [];
  const ids = deals.map((d) => d.id);
  const [ins, outs] = await Promise.all([
    prisma.$queryRaw<{ dealId: string; enviadaEm: Date; canal: string }[]>`
      SELECT DISTINCT ON ("dealId") "dealId", "enviadaEm", canal FROM "CrmMensagemWhatsapp"
      WHERE "dealId" = ANY(${ids}) AND direcao = 'in' ORDER BY "dealId", "enviadaEm" DESC`,
    prisma.$queryRaw<{ dealId: string; enviadaEm: Date }[]>`
      SELECT "dealId", MAX("enviadaEm") AS "enviadaEm" FROM "CrmMensagemWhatsapp"
      WHERE "dealId" = ANY(${ids}) AND direcao = 'out' GROUP BY "dealId"`,
  ]);
  const mIn = new Map(ins.map((r) => [r.dealId, r]));
  const mOut = new Map(outs.map((r) => [r.dealId, r.enviadaEm]));
  return deals.map((d) => ({
    ...d,
    ultimaIn: mIn.get(d.id) ? { enviadaEm: mIn.get(d.id)!.enviadaEm, canal: mIn.get(d.id)!.canal } : null,
    ultimaOut: mOut.get(d.id) ?? null,
  }));
}

export async function previa(f: FiltroDisparo, whereEmpresa: object) {
  const cs = await candidatos(f, whereEmpresa);
  const porCanal: Record<string, number> = {};
  const pulos: Record<string, number> = {};
  const exemplos: { titulo: string; canal: string }[] = [];
  for (const c of cs) {
    const r = canalDoCandidato(c, f);
    if ("pular" in r) { pulos[r.pular] = (pulos[r.pular] ?? 0) + 1; continue; }
    porCanal[r.canal] = (porCanal[r.canal] ?? 0) + 1;
    if (exemplos.length < 8) exemplos.push({ titulo: c.contato?.nome ?? c.titulo, canal: r.canal });
  }
  return { total: cs.length, enviar: Object.values(porCanal).reduce((a, b) => a + b, 0), porCanal, pulos, exemplos };
}

export async function criarDisparo(d: {
  projetoId: string; empresaId: string | null; nome: string; mensagem: string; filtro: FiltroDisparo;
  intervaloSeg: number; limiteDia: number; criadoPor: string | null; whereEmpresa: object;
}) {
  const cs = await candidatos(d.filtro, d.whereEmpresa);
  const itens = cs.map((c) => {
    const r = canalDoCandidato(c, d.filtro);
    return "pular" in r
      ? { dealId: c.id, canal: "-", status: "pulado", erro: r.pular }
      : { dealId: c.id, canal: r.canal, status: "pendente", erro: null };
  });
  return prisma.crmDisparo.create({
    data: {
      projetoId: d.projetoId, empresaId: d.empresaId, nome: d.nome, mensagem: d.mensagem,
      filtro: d.filtro as any, criadoPor: d.criadoPor,
      intervaloSeg: Math.max(INTERVALO_MIN_SEG, d.intervaloSeg),
      limiteDia: Math.min(LIMITE_DIA_MAX, Math.max(1, d.limiteDia)),
      total: itens.filter((i) => i.status === "pendente").length,
      pulados: itens.filter((i) => i.status === "pulado").length,
      itens: { create: itens },
    },
  });
}

function inicioDoDiaSp(agora = new Date()): Date {
  const sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  return new Date(agora.getTime() - (sp.getHours() * 3600 + sp.getMinutes() * 60 + sp.getSeconds()) * 1000);
}

/** Chamado a cada minuto pelo cron: no máximo 1 envio por disparo ativo. */
export async function processarDisparos(): Promise<void> {
  const ativos = await prisma.crmDisparo.findMany({ where: { status: "enviando" } });
  if (!ativos.length || !dentroDoHorario()) return;
  const hoje = inicioDoDiaSp();

  for (const disp of ativos) {
    try {
      const ultimo = await prisma.crmDisparoItem.findFirst({
        where: { disparoId: disp.id, enviadoEm: { not: null } }, orderBy: { enviadoEm: "desc" }, select: { enviadoEm: true },
      });
      if (ultimo?.enviadoEm && Date.now() - ultimo.enviadoEm.getTime() < disp.intervaloSeg * 1000) continue;
      const enviadosHoje = await prisma.crmDisparoItem.count({
        where: { status: "enviado", enviadoEm: { gte: hoje }, disparo: { projetoId: disp.projetoId } },
      });
      if (enviadosHoje >= disp.limiteDia) continue;

      const item = await prisma.crmDisparoItem.findFirst({ where: { disparoId: disp.id, status: "pendente" } });
      if (!item) {
        await prisma.crmDisparo.update({ where: { id: disp.id }, data: { status: "concluido" } });
        console.log(`[Disparo] "${disp.nome}" concluído`);
        continue;
      }
      await enviarItem(disp, item);
    } catch (e: any) {
      console.error(`[Disparo] ${disp.id}: ${e?.message ?? e}`);
    }
  }
}

async function enviarItem(disp: { id: string; mensagem: string; criadoPor: string | null }, item: { id: string; dealId: string; canal: string }) {
  const deal = await prisma.crmDeal.findUnique({
    where: { id: item.dealId },
    select: { id: true, status: true, projetoId: true, empresaId: true, contatoId: true,
      contato: { select: { nome: true, whatsapp: true, instagramId: true, messengerId: true } } },
  });
  const marcar = async (status: string, erro: string | null) => {
    await prisma.crmDisparoItem.update({ where: { id: item.id }, data: { status, erro, enviadoEm: new Date() } });
    const campo = status === "enviado" ? "enviados" : status === "falha" ? "falhas" : "pulados";
    await prisma.crmDisparo.update({ where: { id: disp.id }, data: { [campo]: { increment: 1 } } });
  };
  if (!deal || deal.status !== "aberto" || !deal.contato) return marcar("pulado", "lead fechado ou sem contato");

  const texto = preencher(disp.mensagem, deal.contato.nome);
  try {
    const { remetenteDoDeal, enviarTextoParaDeal } = await import("../services/whatsapp-deal.js");
    const remetente = await remetenteDoDeal(disp.criadoPor);
    if (item.canal === "whatsapp") {
      await enviarTextoParaDeal(deal.id, texto, remetente);
    } else {
      const canal = item.canal as "instagram" | "messenger";
      const mid = await enviarManualSocial(deal, deal.contato, canal, `${remetente}\n${texto}`);
      await prisma.crmMensagemWhatsapp.create({
        data: { dealId: deal.id, contatoId: deal.contatoId, direcao: "out", canal, tipo: "text",
          conteudo: `*${remetente}*\n${texto}`, remetente, evolutionMessageId: mid ?? undefined,
          ...(deal.empresaId ? { empresaId: deal.empresaId } : {}) },
      });
    }
    await marcar("enviado", null);
  } catch (e: any) {
    await marcar("falha", String(e?.message ?? e).slice(0, 300));
  }
}
