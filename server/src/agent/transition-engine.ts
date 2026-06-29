/**
 * Transition Engine — deal stage transitions, processual deal creation,
 * and proactive outbound messages.
 */

import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { getEvolutionConfig, sendHumanized, limparResposta, sendAudioIfConfigured, dispararNotificacoes } from "./message-handler.js";
import { buildInstrucaoBase } from "./persona-router.js";
import { initAdvogadoFlowIfNeeded } from "./flow-controller.js";
import { saveFlowStepData } from "./deal-repository.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PendingAction =
  | { type: "send_proativa"; dealId: string; phone: string; motivoCron: string; nomeCliente: string; delayMs: number }
  | { type: "notify"; evento: string; dealId: string };

export type TransitionResult = {
  transitioned: boolean;
  pendingActions: PendingAction[];
};

// ── Instrucao templates ───────────────────────────────────────────────────────

const MOTIVO_INSTRUCAO: Record<string, string> = {
  primeira_mensagem:
    "TIPO DE ABORDAGEM: {tipoAbordagem}\n\nEscreva APENAS a primeira mensagem para {nome}. Siga exatamente as instruções de PRIMEIRA MENSAGEM do seu system prompt para o cenário correspondente. Uma mensagem curta e natural de WhatsApp.",
  timeout_sem_resposta:
    "O cliente {nome} não respondeu há algum tempo. Envie uma mensagem de seguimento natural, sem pressão.",
  closer_tentativa_1:
    "Você é {nome_persona}. O cliente {nome} parou de responder. Envie o lembrete sobre prescrição trabalhista (2 anos). Seja conciso e direto.",
  closer_tentativa_2:
    "Você é {nome_persona}. Segunda e última tentativa com {nome}. Mencione valores que costumamos recuperar e que não há custo antecipado.",
  solicitar_documentos:
    "O cliente {nome} confirmou interesse. Solicite a CNH frente de forma natural e humana para dar início ao processo.",
  follow_up_docs_1:
    "O cliente {nome} aceitou o caso e você está aguardando os documentos (CNH, CTPS ou comprovante de endereço). Envie um lembrete amigável e direto: (1) relembre o valor estimado que ele tem a receber, (2) diga que é só mandar a CNH pelo WhatsApp mesmo, (3) ofereça ajuda se tiver dificuldade em tirar a foto. NÃO seja robótico. Máx 3 frases.",
  follow_up_docs_2:
    "O cliente {nome} não respondeu ao primeiro lembrete de documentos. Tom mais urgente mas sem pressão: (1) mencione que o processo precisa dos docs para ser protocolado, (2) reforce que quanto antes, melhor (prazo prescricional), (3) pergunte se teve algum problema para mandar. Máx 3 frases.",
  follow_up_assinatura_1:
    "O contrato e a procuração de {nome} foram enviados para assinatura digital. Envie lembrete curto: (1) diga que o link de assinatura foi enviado, (2) peça para assinar pelo celular mesmo — é rápido. Máx 2 frases.",
  follow_up_assinatura_2:
    "Segunda tentativa de lembrete de assinatura para {nome}. Tom mais direto: (1) mencione que o processo só pode ser protocolado após assinatura, (2) pergunte se teve algum problema com o link e ofereça enviar de novo. Máx 2 frases.",
  follow_up_retorno:
    "O cliente {nome} pediu para continuar depois e não retornou. Envie mensagem calorosa lembrando que o caso está pronto: (1) chame pelo nome, (2) mencione o valor estimado brevemente, (3) diga que é só falar para continuar de onde parou. Máx 2 frases. Tom leve, sem pressão.",
};

export async function getPersonaNomeExibicao(projetoId: string, personaChave: string): Promise<string> {
  const persona = await (prisma as any).iaPersona.findFirst({
    where: { projetoId, chave: personaChave },
    select: { nomeExibicao: true },
  });
  return (persona?.nomeExibicao as string | undefined) ?? personaChave;
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage transitions
// ──────────────────────────────────────────────────────────────────────────────

export async function transitionDeal(
  projetoId: string,
  dealId: string,
  condicao: string,
  phone?: string,
  stageChaveOverride?: string,
): Promise<TransitionResult> {
  const NO_TRANSITION: TransitionResult = { transitioned: false, pendingActions: [] };

  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal) return NO_TRANSITION;

  // Use the override when provided (e.g. stage-engine uses deal.iaStageChave ?? "lead_carreteiro"
  // but the DB may store null for new deals whose effective stage is the project default).
  const stageAtual = stageChaveOverride ?? deal.iaStageChave;

  const regra = await prisma.iaRegraTransicao.findFirst({
    where: { projetoId, stageOrigemChave: stageAtual, condicao },
    orderBy: { ordem: "asc" },
  });

  if (!regra) return NO_TRANSITION;

  const novaFase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: regra.stageDestinoChave } },
  });

  if (!novaFase) return NO_TRANSITION;

  let newStageId = deal.stageId;
  if (novaFase.pipelineId) {
    const newStage = await prisma.crmStage.findFirst({
      where: { pipelineId: novaFase.pipelineId, chave: novaFase.chave },
    });
    if (newStage) newStageId = newStage.id;
  }

  let novaPersona = novaFase.personaChave ?? deal.iaPersonaChave;
  if (regra.acaoAdicional?.startsWith("trocar_persona:")) {
    novaPersona = regra.acaoAdicional.split(":")[1];
  }

  await prisma.crmDeal.update({
    where: { id: dealId },
    data: {
      iaStageChave: regra.stageDestinoChave,
      iaPersonaChave: novaPersona,
      stageId: newStageId,
    },
  });

  await prisma.crmDealStageLog.create({
    data: {
      dealId,
      stageAnteriorId: deal.stageId,
      stageNovoId: newStageId,
      motivo: `IA: ${condicao}`,
    },
  });

  console.log(`[StageEngine] Deal ${dealId}: ${stageAtual} → ${regra.stageDestinoChave} (${condicao})`);

  const pendingActions: PendingAction[] = [
    { type: "notify", evento: `stage_entrada:${regra.stageDestinoChave}`, dealId },
  ];

  if (!regra.acaoAdicional) return { transitioned: false, pendingActions };

  // Mover o deal para o funil "Leads para Futuro - manter contato", marcar a tag
  // e desligar a IA proativa (o cron do C3 deixa de processá-lo). Reengajamento
  // posterior traz o deal de volta ao C3.
  if (regra.acaoAdicional === "mover_para_futuro") {
    await prisma.crmDeal.update({
      where: { id: dealId },
      data: { pipelineId: "pipeline_futuro_comercial", iaAtiva: false },
    });
    await addDealTag(dealId, TAG_LEAD_FUTURO);
    await setEngagementTag(dealId, false);
    console.log(`[StageEngine] Deal ${dealId}: movido para funil FUTURO (mover_para_futuro)`);
    return { transitioned: true, pendingActions };
  }

  // Ações de etiqueta genéricas: "tag:<id>" aplica, "untag:<id>" remove.
  if (regra.acaoAdicional.startsWith("tag:")) {
    await addDealTag(dealId, regra.acaoAdicional.slice(4));
    return { transitioned: true, pendingActions };
  }
  if (regra.acaoAdicional.startsWith("untag:")) {
    await removeDealTag(dealId, regra.acaoAdicional.slice(6));
    return { transitioned: true, pendingActions };
  }

  if (regra.acaoAdicional.startsWith("trocar_persona:")) {
    if (phone) {
      // Skip greeting when lead already went through the flow (_saudacao_enviada = true).
      // Firing a new greeting mid-flow (e.g. returning from lead_sem_resposta) confuses leads
      // who are already in qualification — the normal message handler resumes the conversation.
      const qualif = (deal.qualificacao as Record<string, unknown>) ?? {};
      const iaFlagsCheck = (deal.iaFlags as Record<string, unknown>) ?? {};
      const saudacaoJaEnviada = qualif._saudacao_enviada === true || qualif._saudacao_enviada === "true"
        || iaFlagsCheck._saudacao_enviada === true || iaFlagsCheck._saudacao_enviada === "true";
      if (!saudacaoJaEnviada) {
        const contatoTroca = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
        const nomeTroca = contatoTroca?.nome ?? "cliente";
        console.log(`[StageEngine] Deal ${dealId}: intro da nova persona agendada em 45s`);
        pendingActions.push({ type: "send_proativa", dealId, phone, motivoCron: "primeira_mensagem", nomeCliente: nomeTroca, delayMs: 45_000 });
      } else {
        console.log(`[StageEngine] Deal ${dealId}: saudação já enviada — retomando fluxo sem re-greeting`);
      }
      return { transitioned: true, pendingActions };
    }
    return { transitioned: false, pendingActions };
  }

  if (!phone) return { transitioned: false, pendingActions };

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  const nomeCliente = contato?.nome ?? "cliente";

  const acao = regra.acaoAdicional;

  if (acao === "solicitar_documentos") {
    await prisma.crmDeal.update({ where: { id: dealId }, data: { iaPersonaChave: novaPersona } });
    await enviarMensagemProativa(projetoId, dealId, phone, "solicitar_documentos", nomeCliente);
    return { transitioned: true, pendingActions };
  }

  if (acao === "oferecer_reuniao") {
    await oferecerSlotsReuniao(projetoId, dealId, phone, nomeCliente, contato?.id);
    return { transitioned: true, pendingActions };
  }

  if (acao === "criar_deal_processual") {
    await criarDealProcessual(projetoId, dealId);
    const boasVindasCfg = await prisma.iaProjetoConfig.findFirst({
      where: { projetoId, chave: "advogado.boas_vindas_processual" },
    });
    const boasVindasTexto = boasVindasCfg?.valor
      ? boasVindasCfg.valor.replace(/\{\{nome\}\}/gi, nomeCliente)
      : null;
    if (boasVindasTexto) {
      const evoConfig = await getEvolutionConfig(projetoId);
      if (evoConfig) {
        const personaNome = await getPersonaNomeExibicao(projetoId, "advogado");
        await sendHumanized(evoConfig, phone, `*${personaNome}*\n${boasVindasTexto}`, 1500);
        await prisma.crmMensagemWhatsapp.create({
          data: {
            dealId,
            contatoId: contato?.id,
            direcao: "out",
            personaChave: "advogado",
            remetente: personaNome,
            tipo: "text",
            conteudo: boasVindasTexto,
          },
        });
      }
    }
    return { transitioned: true, pendingActions };
  }

  return { transitioned: false, pendingActions };
}

// ── Agenda: oferecer slots de reunião via WhatsApp ────────────────────────────

async function getEmitenteIdDoProjeto(projetoId: string): Promise<string | null> {
  const cfg = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, chave: "proposta_emitente_id" },
  });
  return cfg?.valor ?? null;
}

export async function oferecerSlotsReuniao(
  projetoId: string,
  dealId: string,
  phone: string,
  nomeCliente: string,
  contatoId?: string,
): Promise<void> {
  const emitenteId = await getEmitenteIdDoProjeto(projetoId);
  if (!emitenteId) {
    console.warn(`[Agenda] proposta_emitente_id não configurado para projeto ${projetoId}`);
    return;
  }

  const agendaUsuarioCfg = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, chave: "agenda_usuario_id" },
  });
  const agendaUsuarioId = agendaUsuarioCfg?.valor ?? null;

  const slots = await prisma.agendaSlot.findMany({
    where: {
      emitenteId,
      ...(agendaUsuarioId ? { usuarioId: agendaUsuarioId } : {}),
      disponivel: true,
      inicio: { gte: new Date() },
    },
    orderBy: { inicio: "asc" },
    take: 3,
  });

  const evo = await getEvolutionConfig(projetoId);
  if (!evo) return;

  const personaNomeSec = await getPersonaNomeExibicao(projetoId, "advogado");

  if (slots.length === 0) {
    const texto = `*${personaNomeSec}*\n${nomeCliente}, ótimo! Vou verificar a agenda e entrar em contato em breve para marcar a videochamada. 📅`;
    await sendHumanized(evo, phone, texto, 1500);
    await prisma.crmMensagemWhatsapp.create({
      data: { dealId, contatoId, direcao: "out", personaChave: "advogado", remetente: personaNomeSec, tipo: "text", conteudo: texto },
    });
    return;
  }

  const opcoes = slots.map((s, i) => {
    const label = formatSlotLabelAgent(s.inicio, s.fim);
    return `➡️ Opção ${i + 1}: ${label}`;
  }).join("\n");

  // Salva IDs dos slots oferecidos no deal para detecção posterior
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  const qualif = (deal?.qualificacao as Record<string, unknown>) ?? {};
  await prisma.crmDeal.update({
    where: { id: dealId },
    data: {
      qualificacao: {
        ...qualif,
        _slots_oferecidos: slots.map(s => ({ id: s.id, label: formatSlotLabelAgent(s.inicio, s.fim), inicio: s.inicio.toISOString(), fim: s.fim.toISOString() })),
      },
    },
  });

  const texto = `*${personaNomeSec}*\n${nomeCliente}, ótimo! Para darmos andamento ao seu caso, preciso agendar uma videochamada rápida — dura em torno de 30 minutos.\n\nTenho os seguintes horários disponíveis:\n\n${opcoes}\n\nQual desses funciona pra você?`;
  await sendHumanized(evo, phone, texto, 2000);
  await prisma.crmMensagemWhatsapp.create({
    data: { dealId, contatoId, direcao: "out", personaChave: "advogado", remetente: personaNomeSec, tipo: "text", conteudo: texto },
  });
}

function formatSlotLabelAgent(inicio: Date, fim: Date): string {
  const dias = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
  const dia  = dias[inicio.getDay()];
  const data = inicio.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  const hi   = inicio.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
  const hf   = fim.toLocaleTimeString("pt-BR",    { hour: "2-digit", minute: "2-digit", timeZone: "America/Bahia" });
  return `${dia}, ${data} — ${hi} às ${hf}`;
}

// ─────────────────────────────────────────────────────────────────────────────

function detectarEscolhaSlot(text: string, numSlots: number): number | null {
  const t = text.toLowerCase();
  if (/\b(1|um[ao]?|primeiro?|primeira?|opç[aã]o\s*1)\b/.test(t)) return 0;
  if (numSlots >= 2 && /\b(2|dois|duas|segundo?|segunda?|opç[aã]o\s*2)\b/.test(t)) return 1;
  if (numSlots >= 3 && /\b(3|tr[eê]s|terceiro?|terceira?|opç[aã]o\s*3)\b/.test(t)) return 2;
  return null;
}

async function confirmarSlotReuniao(
  projetoId: string,
  dealId: string,
  phone: string,
  slot: { id: string; label: string; inicio: string; fim?: string },
): Promise<void> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal) return;

  const contato = deal.contatoId
    ? await prisma.crmContato.findUnique({ where: { id: deal.contatoId } })
    : null;
  const nomeCliente = contato?.nome ?? "cliente";

  const roomName = `avoce-${Math.random().toString(36).slice(2, 10)}`;
  const emitenteId = await getEmitenteIdDoProjeto(projetoId);
  const sessao = await prisma.sessaoReuniao.create({
    data: {
      titulo:       `Reunião — ${nomeCliente}`,
      dealId,
      contatoId:    deal.contatoId ?? undefined,
      emitenteId:   emitenteId ?? undefined,
      jitsiRoomName: roomName,
      agendadaPara: new Date(slot.inicio),
    },
  });

  await prisma.agendaSlot.update({
    where: { id: slot.id },
    data: { disponivel: false, reservadoPara: dealId, reuniaoId: sessao.id },
  }).catch(() => {});

  const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
  const linkConvidado = `${APP_BASE_URL}/sala/${(sessao as any).tokenConvidado}`;

  const evo = await getEvolutionConfig(projetoId);
  const confirmacaoCfg = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, chave: "advogado.confirmacao_reuniao" },
  });
  if (evo && confirmacaoCfg?.valor) {
    const textoCorpo = confirmacaoCfg.valor
      .replace(/\{\{nome\}\}/gi, nomeCliente)
      .replace(/\{\{horario\}\}/gi, slot.label)
      .replace(/\{\{link\}\}/gi, linkConvidado);
    const personaNome = await getPersonaNomeExibicao(projetoId, "advogado");
    const texto = `*${personaNome}*\n${textoCorpo}`;
    await sendHumanized(evo, phone, texto, 1500);
    await prisma.crmMensagemWhatsapp.create({
      data: { dealId, contatoId: deal.contatoId ?? undefined, direcao: "out", personaChave: "advogado", remetente: personaNome, tipo: "text", conteudo: textoCorpo },
    });
  }

  // Clear offered slots from qualificacao
  const qualif = (deal.qualificacao as Record<string, unknown>) ?? {};
  const { _slots_oferecidos: _removed, ...qualifSemSlots } = qualif;
  await prisma.crmDeal.update({ where: { id: dealId }, data: { qualificacao: qualifSemSlots as object } });
}

// ── Tags: helpers de aplicação ────────────────────────────────────────────────

/** IDs fixos das tags de engajamento/funil (criadas no banco avoce). */
const TAG_SDR_RESPONDENDO = "tag_sdr_respondendo";
const TAG_SDR_NAO_RESPONDENDO = "tag_sdr_nao_respondendo";
const TAG_LEAD_FUTURO = "tag_lead_futuro";

async function addDealTag(dealId: string, tagId: string): Promise<void> {
  await prisma.$executeRaw`INSERT INTO "_DealTags" ("A", "B") VALUES (${dealId}, ${tagId}) ON CONFLICT DO NOTHING`;
}

async function removeDealTag(dealId: string, tagId: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "_DealTags" WHERE "A" = ${dealId} AND "B" = ${tagId}`;
}

/**
 * Marca o engajamento do lead com o SDR como tag, mutuamente exclusiva:
 *   respondendo=true  → "Contato com SDR - Respondendo"
 *   respondendo=false → "Contato com SDR - Não Respondendo"
 * O deal NÃO muda de coluna — a etiqueta apenas reflete o estado de conversa.
 */
export async function setEngagementTag(dealId: string, respondendo: boolean): Promise<void> {
  try {
    if (respondendo) {
      await addDealTag(dealId, TAG_SDR_RESPONDENDO);
      await removeDealTag(dealId, TAG_SDR_NAO_RESPONDENDO);
    } else {
      await addDealTag(dealId, TAG_SDR_NAO_RESPONDENDO);
      await removeDealTag(dealId, TAG_SDR_RESPONDENDO);
    }
  } catch (err) {
    console.warn(`[EngagementTag] erro deal ${dealId}:`, err);
  }
}

/**
 * Move o deal para outra coluna do MESMO pipeline (resolve o stageId pela chave),
 * opcionalmente trocando a persona. Idempotente: no-op se já estiver na coluna.
 * Usado pelos auto-avanços do funil (proposta enviada, assinatura concluída).
 */
export async function moverDealParaStage(
  dealId: string,
  chaveDestino: string,
  novaPersonaChave?: string,
): Promise<void> {
  try {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
    if (!deal) return;
    if (deal.iaStageChave === chaveDestino) return;
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: deal.pipelineId, chave: chaveDestino },
    });
    await prisma.crmDeal.update({
      where: { id: dealId },
      data: {
        iaStageChave: chaveDestino,
        ...(stage ? { stageId: stage.id } : {}),
        ...(novaPersonaChave ? { iaPersonaChave: novaPersonaChave } : {}),
      },
    });
    if (stage && stage.id !== deal.stageId) {
      await prisma.crmDealStageLog.create({
        data: { dealId, stageAnteriorId: deal.stageId, stageNovoId: stage.id, motivo: `IA: auto → ${chaveDestino}` },
      });
    }
    console.log(`[StageMove] Deal ${dealId}: → ${chaveDestino}`);
  } catch (err) {
    console.warn(`[StageMove] erro deal ${dealId}:`, err);
  }
}

// ── Motor de auto-tagging ─────────────────────────────────────────────────────

export async function applyAutoTags(
  projetoId: string,
  dealId: string,
  qualificacao: Record<string, unknown>,
): Promise<void> {
  const rules = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "tag_auto" },
  });
  for (const rule of rules) {
    try {
      const cfg = JSON.parse(rule.valor ?? "{}") as {
        tagId?: string;
        campo?: string;
        operador?: string;
        valor?: string;
      };
      const { tagId, campo, operador = "truthy", valor } = cfg;
      if (!tagId || !campo) continue;

      const fieldValue = qualificacao[campo];
      let conditionMet = false;
      if (operador === "truthy")   conditionMet = fieldValue != null && fieldValue !== "" && fieldValue !== false;
      else if (operador === "falsy")   conditionMet = !fieldValue;
      else if (operador === "equals")  conditionMet = String(fieldValue ?? "") === String(valor ?? "");
      else if (operador === "contains") conditionMet = typeof fieldValue === "string" && fieldValue.toLowerCase().includes(String(valor ?? "").toLowerCase());
      else if (operador === "contains_any") {
        const fv = typeof fieldValue === "string" ? fieldValue.toLowerCase() : "";
        conditionMet = String(valor ?? "")
          .split("|")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean)
          .some((tok) => fv.includes(tok));
      }

      if (!conditionMet) continue;

      const exists = await prisma.$queryRaw<{ exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM "_DealTags" WHERE "A" = ${dealId} AND "B" = ${tagId}) as exists
      `;
      if (exists[0]?.exists) continue;

      await prisma.$executeRaw`
        INSERT INTO "_DealTags" ("A", "B") VALUES (${dealId}, ${tagId}) ON CONFLICT DO NOTHING
      `;
      console.log(`[AutoTag] tag=${tagId} → deal=${dealId} (rule=${rule.chave})`);
    } catch (err) {
      console.warn(`[AutoTag] erro na regra ${rule.chave}:`, err);
    }
  }
}

// ── Classificação de resposta motorista ───────────────────────────────────────

async function classificarRespostaMotorista(
  projetoId: string,
  dealId: string,
  texto: string,
): Promise<"confirmou" | "negou" | "inconclusivo"> {
  try {
    const systemPrompt = `Classificador JSON. O lead está sendo perguntado se é motorista profissional empregado (CLT) — carreteiro, caminhoneiro, motorista de ônibus, van ou transporte de carga/passageiros com carteira assinada.
Responda APENAS com: {"c":"confirmou"} | {"c":"negou"} | {"c":"inconclusivo"}
- confirmou: foi motorista profissional de carga/caminhão/ônibus/van para uma empresa em QUALQUER regime (CLT, sem registro, MEI, PJ, agregado, autônomo, dono do caminhão) — o vínculo é avaliado depois
- negou: NÃO era motorista de carga/caminhão/ônibus empregado por empresa — exemplos: motorista de app de PASSAGEIROS (Uber/99/InDrive/táxi), entregador de app (iFood/Rappi), outra profissão, ou nunca foi motorista de caminhão/carga
- inconclusivo: genuinamente ambíguo ou off-topic (saudações, perguntas sem relação, resposta vazia)
ATENÇÃO: taxista, motorista de app de passageiros e entregador são "negou". Caminhoneiro/carreteiro/motorista de carga é "confirmou" mesmo sendo autônomo, MEI, PJ ou dono do caminhão (o vínculo é avaliado depois).`;
    const result = await callLlm({
      projetoId, dealId, systemPrompt,
      messages: [{ role: "user", content: texto }],
      maxTokens: 20,
    });
    const parsed = JSON.parse(result.content.trim());
    const c = parsed.c as string;
    if (c === "confirmou" || c === "negou") return c;
    return "inconclusivo";
  } catch {
    return "inconclusivo";
  }
}

// ── Campanha ativa: handler de primeira resposta ──────────────────────────────

async function handleCampanhaResponse(
  projetoId: string,
  dealId: string,
  phone: string,
  campanhaId: string,
): Promise<void> {
  const [deal, campanha] = await Promise.all([
    prisma.crmDeal.findUnique({ where: { id: dealId }, include: { contato: true } }),
    (prisma as any).crmCampanhaReengajamento.findUnique({ where: { id: campanhaId } }),
  ]);
  if (!deal || !campanha) return;

  // 1. Determinar stage destino com base no stage de origem do lead
  const stageOrigem: string = (deal.camposCustom as any)?.ia_stage_origem ?? deal.iaStageChave ?? "default";
  const destMap = (campanha.destStageMap as Record<string, string>) ?? {};
  const destStageChave: string = destMap[stageOrigem] ?? destMap["default"] ?? "lead_nao_motorista";
  const destPipelineId: string = campanha.destPipelineId ?? "pipeline_c3_comercial";

  // 2. Gerar resumo histórico via LLM
  const evoConfig = await getEvolutionConfig(projetoId);
  if (evoConfig && campanha.promptHistorico) {
    const qualif = (deal.qualificacao as Record<string, unknown>) ?? {};
    const nome = deal.contato?.nome ?? (qualif.nome as string) ?? "cliente";
    const contexto = Object.entries(qualif)
      .filter(([k, v]) => !k.startsWith("_") && v != null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");

    const promptHistorico = (campanha.promptHistorico as string)
      .replace(/\{nome\}/g, nome)
      .replace(/\{contexto\}/g, contexto || "sem dados anteriores registrados");

    try {
      const personaNome = await getPersonaNomeExibicao(projetoId, "assistente");
      const result = await callLlm({
        projetoId, dealId,
        systemPrompt: `Você é ${personaNome}, assistente jurídica. Responda APENAS com a mensagem WhatsApp, sem prefixo, sem aspas.`,
        messages: [{ role: "user", content: promptHistorico }],
        maxTokens: 400,
      });
      const resumo = result.content.trim();
      if (resumo) {
        await sendHumanized(evoConfig, phone, `*${personaNome}*\n${resumo}`, 2000);
        await prisma.crmMensagemWhatsapp.create({
          data: {
            dealId, contatoId: deal.contatoId ?? undefined,
            direcao: "out", personaChave: "assistente", remetente: personaNome,
            tipo: "text", conteudo: resumo,
          },
        });
      }
    } catch (err) {
      console.warn(`[Campanha] Erro ao gerar histórico para deal ${dealId}:`, err);
    }
  }

  // 3. Migrar deal para C3
  const destStage = await prisma.crmStage.findFirst({
    where: { pipelineId: destPipelineId, chave: destStageChave },
  });

  if (!destStage) {
    console.warn(`[Campanha] Stage ${destStageChave} não encontrado no pipeline ${destPipelineId}`);
    return;
  }

  const prevStageId = deal.stageId;
  await prisma.crmDeal.update({
    where: { id: dealId },
    data: {
      pipelineId: destPipelineId,
      stageId: destStage.id,
      iaStageChave: destStageChave,
      projetoId: projetoId,
      iaAtiva: true,
      iaPersonaChave: "assistente",
      iaFlowStepChave: null,
      iaFlowStepData: {},
      iaFlags: {},
      camposCustom: {
        ...(deal.camposCustom as object ?? {}),
        ia_campanha_migrado_de: campanhaId,
        ia_campanha_id: null,
        ia_mensagem_personalizada: null,
      },
      ultimoContatoEm: new Date(),
    },
  });

  await prisma.crmDealStageLog.create({
    data: {
      dealId,
      stageAnteriorId: prevStageId,
      stageNovoId: destStage.id,
      motivo: `Campanha: respondeu → migrado para ${destStageChave}`,
    },
  });

  console.log(`[Campanha] Deal ${dealId}: migrado de ${stageOrigem} → ${destStageChave} (campanha=${campanhaId})`);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function checkTransitions(
  projetoId: string,
  dealId: string,
  stageAtual: string,
  clienteText: string,
  phone: string
): Promise<TransitionResult> {
  const NO_TRANSITION: TransitionResult = { transitioned: false, pendingActions: [] };

  if (stageAtual === "lead_nao_motorista" && clienteText) {
    const motoristClassif = await classificarRespostaMotorista(projetoId, dealId, clienteText);
    if (motoristClassif === "confirmou") return await transitionDeal(projetoId, dealId, "confirmou_ser_motorista", phone);
    if (motoristClassif === "negou")     return await transitionDeal(projetoId, dealId, "negou_ser_motorista",     phone);
  }

  // Campanha ativa: quando lead responde msg_enviada, verifica se é de campanha e migra para C3
  if (stageAtual === "reeng_msg_enviada" && clienteText) {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId }, select: { camposCustom: true } });
    const campanhaId = (deal?.camposCustom as any)?.ia_campanha_id as string | undefined;
    if (campanhaId) {
      // Resposta à campanha: gerar histórico + migrar (fire-and-forget para não bloquear resposta)
      handleCampanhaResponse(projetoId, dealId, phone, campanhaId).catch(err =>
        console.error(`[Campanha] handleCampanhaResponse falhou para deal ${dealId}:`, err)
      );
      return { transitioned: true, pendingActions: [] };
    }
    // Lead normal (não-campanha): fluxo reengajamento padrão
    return await transitionDeal(projetoId, dealId, "cliente_respondeu", phone);
  }

  if (stageAtual === "aguardando_reuniao" && clienteText) {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
    type SlotOferecido = { id: string; label: string; inicio: string; fim?: string };
    const slotsOferecidos = ((deal?.qualificacao as any)?._slots_oferecidos ?? []) as SlotOferecido[];
    if (slotsOferecidos.length > 0) {
      const escolha = detectarEscolhaSlot(clienteText, slotsOferecidos.length);
      if (escolha !== null) {
        await confirmarSlotReuniao(projetoId, dealId, phone, slotsOferecidos[escolha]);
        return await transitionDeal(projetoId, dealId, "reuniao_agendada", phone);
      }
    }
  }

  if (stageAtual === "lead_sem_resposta" && clienteText) {
    return await transitionDeal(projetoId, dealId, "cliente_respondeu", phone);
  }

  const interestKeywords = /\b(quero|sim|pode|vamos|ok|bora|vou|claro|concordo|aceito|tô dentro|to dentro|bom|ótimo)\b/i;
  if (interestKeywords.test(clienteText)) {
    // transitionDeal is a no-op when no DB rule exists for (stageAtual, "interesse_confirmado").
    // DB rules currently cover: lead_indeciso, com_closer.
    // lead_qualificado was removed — the inline flow switch + reuniao_agendada rule handle that transition.
    return await transitionDeal(projetoId, dealId, "interesse_confirmado", phone);
  }

  return NO_TRANSITION;
}

// ──────────────────────────────────────────────────────────────────────────────
// Processual deal creation
// ──────────────────────────────────────────────────────────────────────────────

export async function criarDealProcessual(projetoId: string, dealComercialId: string): Promise<void> {
  const dealComercial = await prisma.crmDeal.findUnique({
    where: { id: dealComercialId },
    include: { contato: true },
  });
  if (!dealComercial) return;

  const faseEntrada = await prisma.iaFaseFunil.findFirst({
    where: { projetoId, ehEntrada: true, pipelineTipo: "processual" },
    orderBy: { ordem: "asc" },
  });

  let stageId: string | undefined;
  let pipelineId: string | undefined;

  if (faseEntrada?.pipelineId) {
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: faseEntrada.pipelineId, chave: faseEntrada.chave },
    });
    stageId = stage?.id;
    pipelineId = faseEntrada.pipelineId;
  }

  if (!stageId || !pipelineId) {
    console.warn("[StageEngine] Nenhum pipeline processual configurado");
    return;
  }

  await prisma.crmDeal.update({
    where: { id: dealComercialId },
    data: { status: "ganho", iaAtiva: false },
  });

  await prisma.crmDeal.create({
    data: {
      titulo: `${dealComercial.contato?.nome ?? "Cliente"} — Processo`,
      pipelineId,
      stageId,
      contatoId: dealComercial.contatoId,
      projetoId,
      iaAtiva: false,
      iaStageChave: faseEntrada?.chave,
      fonteLead: "crm_comercial",
      qualificacao: dealComercial.qualificacao as any,
    },
  });

  console.log(`[StageEngine] Deal processual criado para deal comercial ${dealComercialId}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Proactive outbound message sender — called by cron or after transition
// ──────────────────────────────────────────────────────────────────────────────

export async function enviarMensagemProativa(
  projetoId: string,
  dealId: string,
  phone: string,
  motivoCron: string,
  nomeCliente: string
): Promise<void> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal?.iaAtiva) return;

  const stageChave = deal.iaStageChave ?? "lead_carreteiro";
  const personaChave = deal.iaPersonaChave ?? "assistente";

  // Universal atomic lock: must run BEFORE initAdvogadoFlowIfNeeded, which resets iaFlowStepData
  // and would wipe any flag written after it. Using $executeRaw ensures only ONE concurrent
  // caller proceeds — the other sees locked===0 and returns immediately.
  if (motivoCron === "primeira_mensagem" && personaChave === "advogado") {
    const flagKey = "apresentacao_enviado";
    const locked: number = await prisma.$executeRaw`
      UPDATE "CrmDeal"
      SET "iaFlowStepData" = COALESCE("iaFlowStepData", '{}'::jsonb)
        || jsonb_build_object(${flagKey}::text, true::boolean)
      WHERE id = ${dealId}
        AND NOT (COALESCE("iaFlowStepData", '{}'::jsonb) ? ${flagKey})
    `;
    if (locked === 0) {
      console.log(`[Proativa] apresentacao já enviada para deal ${dealId} — ignorando`);
      return;
    }
  }

  const persona = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChave } },
  });
  if (!persona) return;

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  const templateChave = `${stageChave}_${motivoCron}`;
  const template = await prisma.iaMensagemTemplate.findFirst({
    where: { projetoId, chave: templateChave, ativo: true },
  });

  let mensagem = "";

  if (template) {
    mensagem = template.template
      .replace(/\{nome\}/g, nomeCliente)
      .replace(/\{nome_persona\}/g, persona.nomeExibicao);
  } else {
    const history = await prisma.crmMensagemWhatsapp.findMany({
      where: { dealId },
      orderBy: { enviadaEm: "desc" },
      take: 10,
    });
    history.reverse();

    const advNomeProativa = await getPersonaNomeExibicao(projetoId, "advogado");
    const INSTRUCAO_BASE = buildInstrucaoBase(advNomeProativa);
    let systemPrompt = persona.systemPrompt
      .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
      .replace(/\{nome_persona\}/g, persona.nomeExibicao)
      .replace(/\{nome_advogado\}/g, advNomeProativa)
      .replace(/\{nome_secretaria\}/g, await getPersonaNomeExibicao(projetoId, "secretaria"))
      .replace(/\{nome_assistente\}/g, await getPersonaNomeExibicao(projetoId, "assistente"));
    if (!systemPrompt.includes("DATA E HORA ATUAL")) {
      systemPrompt = INSTRUCAO_BASE + "\n\n" + systemPrompt;
    }
    if (nomeCliente) {
      systemPrompt += `\n\nNome do cliente: ${nomeCliente}`;
    }

    const temHistorico = history.some((m) => m.direcao === "out");
    const tipoAbordagem = temHistorico ? "reengajamento com histórico" : "novo";

    let instrucao = "";

    if (motivoCron === "primeira_mensagem" && personaChave === "advogado") {
      // Lock already acquired above — initAdvogadoFlowIfNeeded is safe to call here.
      const { message: firstQuestion, firstStepChave } = await initAdvogadoFlowIfNeeded(projetoId, dealId);
      if (firstQuestion && firstStepChave) {
        mensagem = firstQuestion;
      } else {
        instrucao = (MOTIVO_INSTRUCAO.primeira_mensagem ?? "")
          .replace("{nome}", nomeCliente)
          .replace("{tipoAbordagem}", tipoAbordagem);
      }
    } else {
      instrucao = (MOTIVO_INSTRUCAO[motivoCron] ?? "")
        .replace(/{nome}/g, nomeCliente)
        .replace("{tipoAbordagem}", tipoAbordagem)
        .replace(/{nome_persona}/g, persona.nomeExibicao);
    }

    if (!mensagem && instrucao) {
      const llmMessages = [
        ...history.map((m) => ({
          role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
          content: m.conteudo ?? "",
        })),
        { role: "user" as const, content: `INSTRUÇÃO INTERNA: ${instrucao}` },
      ];

      for (let attempts = 0; attempts < 3; attempts++) {
        const result = await callLlm({
          projetoId,
          dealId,
          systemPrompt,
          messages: llmMessages,
          personaChave,
          personaLlmChave: (persona as any).llmProviderChave ?? null,
          stageChave,
          maxTokens: 2048,
        });
        mensagem = result.content.trim();
        if (isHumanized(mensagem)) break;
      }
    }
  }

  if (!mensagem) return;

  const proativaTextoLimpo = limparResposta(mensagem, persona.nomeExibicao);

  const proativaConfigs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "comportamento" },
  });
  const getPComport = (k: string, def: number) => {
    const v = proativaConfigs.find((c) => c.chave === k)?.valor;
    const n = v ? Number(v) : NaN;
    return isNaN(n) ? def : n;
  };
  // Send persona intro media (photo/video) before the first message from this persona
  if (motivoCron === "primeira_mensagem" && (persona as any).midiaApresentacaoPath) {
    const { sendImage: sendImg, sendVideo: sendVid } = await import("../services/evolution.js");
    const mediaUrl = `${process.env.APP_BASE_URL ?? "https://avoce.capium.com.br"}/api/ia-persona-midia/${persona.id}`;
    try {
      if ((persona as any).midiaApresentacaoTipo === "video") {
        await sendVid(evoConfig, phone, mediaUrl);
      } else {
        await sendImg(evoConfig, phone, mediaUrl);
      }
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.warn("[Proativa] Erro ao enviar mídia da persona:", err);
    }
  }

  const pDelayMin = getPComport("resposta_delay_min", 20) * 1000;
  const pDelayMax = getPComport("resposta_delay_max", 40) * 1000;
  const proativaReadDelay = pDelayMin + Math.random() * (pDelayMax - pDelayMin);
  await sendHumanized(evoConfig, phone, `*${persona.nomeExibicao}*\n${proativaTextoLimpo}`, proativaReadDelay);

  sendAudioIfConfigured(projetoId, evoConfig, phone, mensagem, personaChave, motivoCron, dealId).catch(() => {});

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  await prisma.crmMensagemWhatsapp.create({
    data: {
      dealId,
      contatoId: contato?.id,
      direcao: "out",
      personaChave,
      remetente: persona.nomeExibicao,
      tipo: "text",
      conteudo: proativaTextoLimpo,
    },
  });

  await prisma.crmDeal.update({
    where: { id: dealId },
    data: { ultimoContatoEm: new Date() },
  });
}
