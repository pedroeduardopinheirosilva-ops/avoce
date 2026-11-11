/**
 * Reunião marcada pelo SDR/closer, vinculada ao lead: quem conduz, quando, como, pauta e
 * anotações. Antes, o "agendou reunião" do Registrar ligação gerava só uma atividade sem
 * data (18 em 30 dias até 10/11/2026) e nada aparecia na agenda.
 */
import { TRPCError } from "@trpc/server";
import { prisma } from "../db.js";
import { canOperate, type TenantCtx } from "../routers/tenant-utils.js";
import { usuariosDoFollowup } from "../routers/crm.js";
import { resolverEmitenteId, reservarOuCriarSlot, liberarSlotDaReuniao } from "./agenda-slot.js";

export const MODALIDADES = ["video", "whatsapp", "telefone", "presencial"] as const;
export type Modalidade = (typeof MODALIDADES)[number];
export const ROTULO_MODALIDADE: Record<Modalidade, string> = {
  video: "vídeo", whatsapp: "WhatsApp", telefone: "telefone", presencial: "presencial",
};

const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
const TZ = "America/Sao_Paulo";
/** Reuniões que ainda ocupam a agenda de quem conduz. */
const STATUS_ATIVOS = ["agendada", "em_andamento"];

type Ctx = TenantCtx & { userId?: string };

// ── Regras puras ──────────────────────────────────────────────────────────────

/** true se [inicioA, inicioA+durA) cruza [inicioB, inicioB+durB). */
export function sobrepoe(inicioA: Date, durMinA: number, inicioB: Date, durMinB: number): boolean {
  const a0 = inicioA.getTime(), a1 = a0 + durMinA * 60_000;
  const b0 = inicioB.getTime(), b1 = b0 + durMinB * 60_000;
  return a0 < b1 && b0 < a1;
}

/** Só avança a etapa: reunião de pós-venda não pode devolver um cliente para "aguardando reunião". */
export function deveMoverParaEtapa(ordemAtual: number | null | undefined, ordemAlvo: number): boolean {
  return ordemAtual == null || ordemAtual < ordemAlvo;
}

/** Aviso ao cliente (confirmação + lembretes) só faz sentido com link de vídeo e WhatsApp. */
export function podeAvisarCliente(modalidade: Modalidade, temProjeto: boolean, temWhatsapp: boolean): boolean {
  return modalidade === "video" && temProjeto && temWhatsapp;
}

export function horarioLabel(d: Date): string {
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" }).format(d);
  const dm = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(d);
  const hm = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  return `${dia.charAt(0).toUpperCase() + dia.slice(1)} (${dm}) às ${hm}`;
}

// ── Acesso ────────────────────────────────────────────────────────────────────

export async function carregarDealOperavel(ctx: Ctx, dealId: string) {
  const deal = await prisma.crmDeal.findUnique({
    where: { id: dealId },
    include: {
      contato: { select: { id: true, nome: true, whatsapp: true } },
      pipeline: { select: { empresaId: true } },
      stage: { select: { ordem: true } },
    },
  });
  if (!deal) throw new TRPCError({ code: "NOT_FOUND", message: "Lead não encontrado" });
  const empresaId = (deal as any).empresaId ?? deal.pipeline?.empresaId ?? null;
  if (!canOperate(ctx, empresaId)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso a este lead" });
  return { deal, empresaId: empresaId as string | null };
}

async function validarResponsavel(empresaId: string | null, responsavelId: string): Promise<string> {
  const u = (await usuariosDoFollowup(empresaId)).find(x => x.id === responsavelId);
  if (!u) throw new TRPCError({ code: "BAD_REQUEST", message: "Responsável não pertence à empresa do lead" });
  return u.nome;
}

/** Reuniões ativas de quem conduz que cruzam o horário pedido. */
export async function conflitosDoResponsavel(responsavelId: string, inicio: Date, duracaoMin: number, ignorarId?: string) {
  const candidatas = await prisma.sessaoReuniao.findMany({
    where: {
      responsavelId,
      status: { in: STATUS_ATIVOS },
      agendadaPara: { gte: new Date(inicio.getTime() - 8 * 3600_000), lt: new Date(inicio.getTime() + duracaoMin * 60_000) },
      ...(ignorarId ? { id: { not: ignorarId } } : {}),
    },
    select: { id: true, titulo: true, agendadaPara: true, duracaoMin: true },
  });
  return candidatas.filter(s => s.agendadaPara && sobrepoe(inicio, duracaoMin, s.agendadaPara, s.duracaoMin));
}

function erroConflito(lista: { titulo: string; agendadaPara: Date | null }[]): never {
  const txt = lista.map(s => `${s.titulo} (${s.agendadaPara ? horarioLabel(s.agendadaPara) : "?"})`).join("; ");
  throw new TRPCError({ code: "CONFLICT", message: `Horário ocupado para quem conduz: ${txt}` });
}

/** Zera os lembretes já enviados: senão uma reunião nova/remarcada herdava os flags da anterior. */
async function zerarLembretes(dealId: string) {
  const d = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: { iaFlowStepData: true } });
  const dados = (d?.iaFlowStepData ?? {}) as Record<string, unknown>;
  const chaves = Object.keys(dados).filter(k => k.startsWith("_lembrete_"));
  if (!chaves.length) return;
  for (const k of chaves) delete dados[k];
  await prisma.crmDeal.update({ where: { id: dealId }, data: { iaFlowStepData: dados as any } });
}

async function nomeUsuario(id: string | null | undefined) {
  if (!id) return null;
  return (await prisma.usuario.findUnique({ where: { id }, select: { nome: true } }))?.nome ?? null;
}

// ── Agendar ───────────────────────────────────────────────────────────────────

export interface AgendarInput {
  dealId: string;
  responsavelId: string;
  agendadaPara: string;
  duracaoMin?: number;
  modalidade?: Modalidade;
  pauta?: string | null;
  notas?: string | null;
  avisarCliente?: boolean;
  ignorarConflito?: boolean;
}

export async function agendarReuniao(ctx: Ctx, input: AgendarInput) {
  const inicio = new Date(input.agendadaPara);
  if (Number.isNaN(inicio.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "Data inválida" });
  if (inicio.getTime() < Date.now() - 60 * 60_000) throw new TRPCError({ code: "BAD_REQUEST", message: "Data já passou" });
  const duracaoMin = input.duracaoMin ?? 60;
  const modalidade = input.modalidade ?? "video";
  const pauta = input.pauta?.trim() || null;
  const notas = input.notas?.trim() || null;

  const { deal, empresaId } = await carregarDealOperavel(ctx, input.dealId);
  const responsavelNome = await validarResponsavel(empresaId, input.responsavelId);
  if (!input.ignorarConflito) {
    const conflitos = await conflitosDoResponsavel(input.responsavelId, inicio, duracaoMin);
    if (conflitos.length) erroConflito(conflitos);
  }

  const projetoId = (deal as any).projetoId as string | null;
  const contato = deal.contato;
  const avisar = (input.avisarCliente ?? true) && podeAvisarCliente(modalidade, !!projetoId, !!contato?.whatsapp);
  const titulo = `Reunião com ${contato?.nome ?? deal.titulo}`;
  const emitenteId = await resolverEmitenteId({ empresaIdContexto: empresaId });
  const fim = new Date(inicio.getTime() + duracaoMin * 60_000);

  const slotId = await reservarOuCriarSlot({
    emitenteId, usuarioId: input.responsavelId, projetoId, dealId: deal.id, inicio, fim, titulo,
  });

  let sessaoId: string;
  if (avisar && projetoId && contato?.whatsapp) {
    // Fluxo de sempre: confirmação ao cliente com o link + aviso à equipe.
    const { criarReuniaoAgente } = await import("../agent/secretaria-meeting.js");
    const r = await criarReuniaoAgente(
      projetoId, deal.id,
      { id: contato.id, nome: contato.nome ?? "Cliente", whatsapp: contato.whatsapp },
      horarioLabel(inicio),
      slotId ? { id: slotId, inicio, fim, label: horarioLabel(inicio) } as any : undefined,
    );
    if (!r) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Falha ao criar reunião" });
    sessaoId = r.sessaoId;
  } else {
    const { randomBytes } = await import("node:crypto");
    const s = await prisma.sessaoReuniao.create({
      data: {
        titulo, dealId: deal.id, contatoId: contato?.id, empresaId: empresaId ?? undefined,
        emitenteId: emitenteId ?? undefined, jitsiRoomName: `avoce-${randomBytes(5).toString("hex")}`,
        agendadaPara: inicio,
      },
    });
    sessaoId = s.id;
    if (slotId) await prisma.agendaSlot.update({ where: { id: slotId }, data: { reuniaoId: s.id } });
  }

  const sessao = await prisma.sessaoReuniao.update({
    where: { id: sessaoId },
    data: {
      titulo, agendadaPara: inicio, empresaId: empresaId ?? undefined,
      criadoPor: ctx.userId ?? undefined, responsavelId: input.responsavelId,
      duracaoMin, modalidade, avisarCliente: avisar, pauta, notas,
    },
  });

  await zerarLembretes(deal.id);
  await moverParaAguardandoReuniao(deal.id, deal.pipelineId, deal.stage?.ordem);

  const quem = (await nomeUsuario(ctx.userId)) ?? "Equipe";
  const resumo = `${horarioLabel(inicio)} · ${duracaoMin} min · ${ROTULO_MODALIDADE[modalidade]} · com ${responsavelNome}`;
  await prisma.crmAtividade.create({
    data: {
      dealId: deal.id, tipo: "reuniao", resultado: "agendada", usuarioId: ctx.userId ?? null,
      canal: modalidade, origem: "manual", externoId: `agendada:${sessaoId}`,
      nota: pauta ? `${resumo}\nPauta: ${pauta.slice(0, 500)}` : resumo,
    },
  }).catch(() => {});
  await prisma.crmNota.create({
    data: {
      dealId: deal.id,
      conteudo: `🗓 Reunião marcada por ${quem}: ${resumo}${avisar ? " (cliente avisado pelo WhatsApp)" : ""}${pauta ? `\nPauta: ${pauta}` : ""}`,
    },
  }).catch(() => {});

  return {
    sessaoId: sessao.id,
    linkConvidado: `${APP_BASE_URL}/sala/${sessao.tokenConvidado}`,
    avisouCliente: avisar,
  };
}

async function moverParaAguardandoReuniao(dealId: string, pipelineId: string | null, ordemAtual: number | null | undefined) {
  if (!pipelineId) return;
  const alvo = await prisma.crmStage.findFirst({ where: { pipelineId, chave: "aguardando_reuniao" } });
  if (!alvo || !deveMoverParaEtapa(ordemAtual, alvo.ordem)) return;
  await prisma.crmDeal.update({ where: { id: dealId }, data: { stageId: alvo.id, iaStageChave: "aguardando_reuniao" } });
  const { marcarEntradaEtapa } = await import("../agent/lead-qualificado.js");
  void marcarEntradaEtapa(dealId, "aguardando_reuniao", "reuniao:agendada");
}

// ── Atualizar / remarcar ──────────────────────────────────────────────────────

export interface AtualizarInput {
  id: string;
  pauta?: string | null;
  notas?: string | null;
  agendadaPara?: string;
  duracaoMin?: number;
  modalidade?: Modalidade;
  responsavelId?: string;
  ignorarConflito?: boolean;
}

export async function carregarReuniaoOperavel(ctx: Ctx, id: string) {
  const s = await prisma.sessaoReuniao.findUnique({ where: { id } });
  if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "Reunião não encontrada" });
  if (s.dealId) {
    const { empresaId } = await carregarDealOperavel(ctx, s.dealId);
    return { sessao: s, empresaId };
  }
  // Sala avulsa antiga, sem lead nem empresa: segue aberta como antes.
  if (s.empresaId && !canOperate(ctx, s.empresaId)) throw new TRPCError({ code: "FORBIDDEN", message: "Sem acesso a esta reunião" });
  return { sessao: s, empresaId: s.empresaId };
}

export async function atualizarReuniao(ctx: Ctx, input: AtualizarInput) {
  const { sessao, empresaId } = await carregarReuniaoOperavel(ctx, input.id);
  const novoInicio = input.agendadaPara ? new Date(input.agendadaPara) : null;
  if (novoInicio && Number.isNaN(novoInicio.getTime())) throw new TRPCError({ code: "BAD_REQUEST", message: "Data inválida" });
  const inicio = novoInicio ?? sessao.agendadaPara;
  const duracaoMin = input.duracaoMin ?? sessao.duracaoMin;
  const responsavelId = input.responsavelId ?? sessao.responsavelId;
  const remarcou = !!novoInicio && novoInicio.getTime() !== sessao.agendadaPara?.getTime();
  const mudouAgenda = remarcou || duracaoMin !== sessao.duracaoMin || responsavelId !== sessao.responsavelId;

  if (mudouAgenda && !STATUS_ATIVOS.includes(sessao.status)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Só reunião ainda não encerrada pode mudar de horário ou responsável" });
  }
  if (input.responsavelId) await validarResponsavel(empresaId, input.responsavelId);
  if (mudouAgenda && responsavelId && inicio && !input.ignorarConflito) {
    const conflitos = await conflitosDoResponsavel(responsavelId, inicio, duracaoMin, sessao.id);
    if (conflitos.length) erroConflito(conflitos);
  }

  const modalidade = input.modalidade ?? (sessao.modalidade as Modalidade);
  const atualizada = await prisma.sessaoReuniao.update({
    where: { id: sessao.id },
    data: {
      ...(input.pauta !== undefined ? { pauta: input.pauta?.trim() || null } : {}),
      ...(input.notas !== undefined ? { notas: input.notas?.trim() || null } : {}),
      ...(novoInicio ? { agendadaPara: novoInicio } : {}),
      duracaoMin, modalidade, responsavelId,
      // Sem link de vídeo não há o que mandar no lembrete.
      ...(modalidade !== "video" ? { avisarCliente: false } : {}),
    },
  });

  if (mudouAgenda && sessao.dealId && inicio) {
    await liberarSlotDaReuniao(sessao.id);
    const slotId = await reservarOuCriarSlot({
      emitenteId: sessao.emitenteId ?? await resolverEmitenteId({ empresaIdContexto: empresaId }),
      usuarioId: responsavelId, dealId: sessao.dealId, inicio,
      fim: new Date(inicio.getTime() + duracaoMin * 60_000), titulo: sessao.titulo,
    });
    if (slotId) await prisma.agendaSlot.update({ where: { id: slotId }, data: { reuniaoId: sessao.id } });
  }
  if (remarcou && sessao.dealId && novoInicio) {
    await zerarLembretes(sessao.dealId);
    const quem = (await nomeUsuario(ctx.userId)) ?? "Equipe";
    const de = sessao.agendadaPara ? horarioLabel(sessao.agendadaPara) : "sem data";
    await prisma.crmAtividade.create({
      data: {
        dealId: sessao.dealId, tipo: "reuniao", resultado: "remarcada", usuarioId: ctx.userId ?? null,
        canal: modalidade, origem: "manual", nota: `De ${de} para ${horarioLabel(novoInicio)}`,
      },
    }).catch(() => {});
    await prisma.crmNota.create({
      data: { dealId: sessao.dealId, conteudo: `🗓 Reunião remarcada por ${quem}: de ${de} para ${horarioLabel(novoInicio)}` },
    }).catch(() => {});
  }
  return atualizada;
}

export async function cancelarReuniao(ctx: Ctx, id: string, motivo?: string | null) {
  const { sessao } = await carregarReuniaoOperavel(ctx, id);
  await liberarSlotDaReuniao(sessao.id);
  const r = await prisma.sessaoReuniao.update({ where: { id: sessao.id }, data: { status: "cancelada" } });
  if (sessao.dealId && sessao.status === "agendada") {
    const quando = sessao.agendadaPara ? horarioLabel(sessao.agendadaPara) : "sem data";
    await prisma.crmAtividade.create({
      data: {
        dealId: sessao.dealId, tipo: "reuniao", resultado: "cancelada", usuarioId: ctx.userId ?? null,
        canal: sessao.modalidade, origem: "manual", nota: `Reunião de ${quando} cancelada${motivo ? ` — ${motivo}` : ""}`,
      },
    }).catch(() => {});
  }
  return r;
}

// ── Leitura (agenda e lead) ───────────────────────────────────────────────────

const INCLUDE_LISTA = {
  deal: {
    select: {
      id: true, titulo: true,
      pipeline: { select: { nome: true, cor: true } },
      stage: { select: { nome: true } },
    },
  },
  contato: { select: { nome: true, whatsapp: true } },
} as const;

/** Anexa os nomes de quem conduz e de quem marcou. */
export async function comNomes<T extends { responsavelId: string | null; criadoPor: string | null }>(lista: T[]) {
  const ids = [...new Set(lista.flatMap(s => [s.responsavelId, s.criadoPor]).filter((x): x is string => !!x))];
  const us = ids.length ? await prisma.usuario.findMany({ where: { id: { in: ids } }, select: { id: true, nome: true } }) : [];
  const nome = new Map(us.map(u => [u.id, u.nome]));
  return lista.map(s => ({
    ...s,
    responsavelNome: s.responsavelId ? nome.get(s.responsavelId) ?? null : null,
    marcadaPorNome: s.criadoPor ? nome.get(s.criadoPor) ?? null : null,
  }));
}

export async function reunioesDoLead(ctx: Ctx, dealId: string) {
  await carregarDealOperavel(ctx, dealId);
  const lista = await prisma.sessaoReuniao.findMany({
    where: { dealId },
    include: INCLUDE_LISTA,
    orderBy: [{ agendadaPara: { sort: "desc", nulls: "last" } }, { criadaEm: "desc" }],
    take: 50,
  });
  return comNomes(lista);
}

export async function agendaDoPeriodo(ctx: Ctx, where: Record<string, unknown>) {
  const lista = await prisma.sessaoReuniao.findMany({
    where,
    include: INCLUDE_LISTA,
    orderBy: { agendadaPara: "asc" },
    take: 500,
  });
  return comNomes(lista);
}

// ── Registrar o resultado de uma reunião agendada ─────────────────────────────

export const RESULTADOS_REUNIAO = ["realizada", "no_show", "remarcada", "cancelada"] as const;
export type ResultadoReuniao = (typeof RESULTADOS_REUNIAO)[number];

/** Status da SessaoReuniao para cada resultado registrado (remarcada continua agendada). */
export function statusDoResultado(resultado: ResultadoReuniao): string {
  return resultado === "realizada" ? "encerrada" : resultado === "no_show" ? "no_show" : resultado === "cancelada" ? "cancelada" : "agendada";
}

/** Junta o resumo registrado às anotações que já existiam, sem perder nada. */
export function anexarAnotacao(atuais: string | null | undefined, rotulo: string, texto: string | null | undefined): string | null {
  const t = texto?.trim();
  if (!t) return atuais ?? null;
  const bloco = `${rotulo}: ${t}`;
  return atuais?.trim() ? `${atuais.trim()}\n\n${bloco}` : bloco;
}

export interface RegistrarResultadoInput {
  id: string;
  resultado: ResultadoReuniao;
  canal?: Modalidade;
  duracaoMin?: number;
  nota?: string | null;
  em?: string;
  novaData?: string;
  ignorarConflito?: boolean;
}

export async function registrarResultadoReuniao(ctx: Ctx, input: RegistrarResultadoInput) {
  const { sessao } = await carregarReuniaoOperavel(ctx, input.id);
  if (!sessao.dealId) throw new TRPCError({ code: "BAD_REQUEST", message: "Reunião sem lead vinculado" });
  const dealId = sessao.dealId;
  const nota = input.nota?.trim() || null;

  if (input.resultado === "remarcada") {
    if (!input.novaData) throw new TRPCError({ code: "BAD_REQUEST", message: "Informe a nova data" });
    const antes = new Date();
    await atualizarReuniao(ctx, { id: sessao.id, agendadaPara: input.novaData, ignorarConflito: input.ignorarConflito });
    if (nota) {
      // atualizarReuniao já registrou a atividade "remarcada"; o motivo vai junto nela.
      const atv = await prisma.crmAtividade.findFirst({
        where: { dealId, tipo: "reuniao", resultado: "remarcada", criadoEm: { gte: antes } },
        orderBy: { criadoEm: "desc" },
      });
      if (atv) await prisma.crmAtividade.update({ where: { id: atv.id }, data: { nota: `${atv.nota ?? ""} — ${nota}` } });
      await prisma.sessaoReuniao.update({ where: { id: sessao.id }, data: { notas: anexarAnotacao(sessao.notas, "Remarcação", nota) } });
    }
    return { ok: true };
  }

  const quando = input.em ? new Date(input.em) : null;
  if (quando && (Number.isNaN(quando.getTime()) || quando.getTime() > Date.now() + 5 * 60_000)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Data/hora inválida ou no futuro" });
  }
  const rotulo = input.resultado === "realizada" ? "Resumo" : input.resultado === "no_show" ? "Não compareceu" : "Cancelamento";
  await prisma.sessaoReuniao.update({
    where: { id: sessao.id },
    data: {
      status: statusDoResultado(input.resultado),
      notas: anexarAnotacao(sessao.notas, rotulo, nota),
      ...(input.resultado === "realizada" && !sessao.encerradaEm ? { encerradaEm: quando ?? new Date() } : {}),
      ...(input.resultado === "realizada" && sessao.duracao == null && input.duracaoMin != null ? { duracao: Math.round(input.duracaoMin * 60) } : {}),
    },
  });
  if (input.resultado === "cancelada") await liberarSlotDaReuniao(sessao.id);

  // Mesma chave da atividade automática da sala (encerrar): completa a dela em vez de duplicar.
  const externoId = `reuniao:${sessao.id}`;
  const canal = input.canal ?? (sessao.modalidade as Modalidade);
  const existente = await prisma.crmAtividade.findUnique({ where: { externoId } });
  const dados = {
    resultado: input.resultado,
    nota,
    canal,
    usuarioId: ctx.userId ?? existente?.usuarioId ?? null,
    ...(existente?.duracaoSeg == null && input.duracaoMin != null ? { duracaoSeg: Math.round(input.duracaoMin * 60) } : {}),
  };
  if (existente) {
    await prisma.crmAtividade.update({ where: { id: existente.id }, data: { ...dados, ...(quando ? { criadoEm: quando } : {}) } });
  } else {
    await prisma.crmAtividade.create({
      data: {
        dealId, tipo: "reuniao", origem: "manual", externoId, ...dados,
        criadoEm: quando ?? (sessao.agendadaPara && sessao.agendadaPara.getTime() < Date.now() ? sessao.agendadaPara : new Date()),
      },
    });
  }
  return { ok: true };
}
