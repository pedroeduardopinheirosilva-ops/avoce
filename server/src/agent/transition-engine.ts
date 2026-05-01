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
    "Você é a Dra. Daniela Pires. O cliente {nome} parou de responder. Envie o lembrete sobre prescrição trabalhista (2 anos). Seja conciso e direto.",
  closer_tentativa_2:
    "Você é a Dra. Daniela Pires. Segunda e última tentativa com {nome}. Mencione valores que costumamos recuperar e que não há custo antecipado.",
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

// ──────────────────────────────────────────────────────────────────────────────
// Stage transitions
// ──────────────────────────────────────────────────────────────────────────────

export async function transitionDeal(
  projetoId: string,
  dealId: string,
  condicao: string,
  phone?: string
): Promise<TransitionResult> {
  const NO_TRANSITION: TransitionResult = { transitioned: false, pendingActions: [] };

  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal) return NO_TRANSITION;

  const stageAtual = deal.iaStageChave;

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

  if (regra.acaoAdicional.startsWith("trocar_persona:")) {
    if (phone) {
      const contatoTroca = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
      const nomeTroca = contatoTroca?.nome ?? "cliente";
      console.log(`[StageEngine] Deal ${dealId}: intro da nova persona agendada em 45s`);
      pendingActions.push({ type: "send_proativa", dealId, phone, motivoCron: "primeira_mensagem", nomeCliente: nomeTroca, delayMs: 45_000 });
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

  if (acao === "criar_deal_processual") {
    await criarDealProcessual(projetoId, dealId);
    const boasVindasTexto = `${nomeCliente}, ótimo! Seu caso foi registrado e vamos agendar uma reunião com o advogado responsável. Em breve entraremos em contato.`;
    const evoConfig = await getEvolutionConfig(projetoId);
    if (evoConfig) {
      await sendHumanized(evoConfig, phone, `*Dra. Daniela Pires*\n${boasVindasTexto}`, 1500);
      await prisma.crmMensagemWhatsapp.create({
        data: {
          dealId,
          contatoId: contato?.id,
          direcao: "out",
          personaChave: "advogado",
          remetente: "Dra. Daniela Pires",
          tipo: "text",
          conteudo: boasVindasTexto,
        },
      });
    }
    return { transitioned: true, pendingActions };
  }

  return { transitioned: false, pendingActions };
}

export async function checkTransitions(
  projetoId: string,
  dealId: string,
  stageAtual: string,
  clienteText: string,
  phone: string
): Promise<TransitionResult> {
  const NO_TRANSITION: TransitionResult = { transitioned: false, pendingActions: [] };

  if (stageAtual === "lead_sem_resposta" && clienteText) {
    return await transitionDeal(projetoId, dealId, "cliente_respondeu", phone);
  }

  const interestKeywords = /\b(quero|sim|pode|vamos|ok|bora|vou|claro|concordo|aceito|tô dentro|to dentro|bom|ótimo)\b/i;
  if (interestKeywords.test(clienteText)) {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
    const stage = deal?.iaStageChave;
    if (stage === "lead_qualificado" || stage === "lead_indeciso" || stage === "com_closer") {
      return await transitionDeal(projetoId, dealId, "interesse_confirmado", phone);
    }
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

    const INSTRUCAO_BASE = buildInstrucaoBase();
    let systemPrompt = persona.systemPrompt
      .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
      .replace(/\{nome_persona\}/g, persona.nomeExibicao);
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
        const hBrasilia = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false });
        const h = parseInt(hBrasilia, 10);
        const saudacao = h >= 5 && h < 12 ? "Bom dia" : h >= 12 && h < 18 ? "Boa tarde" : "Boa noite";
        mensagem = `${saudacao}! Tudo bem? ${firstQuestion}`;
      } else {
        instrucao = (MOTIVO_INSTRUCAO.primeira_mensagem ?? "")
          .replace("{nome}", nomeCliente)
          .replace("{tipoAbordagem}", tipoAbordagem);
      }
    } else {
      instrucao = (MOTIVO_INSTRUCAO[motivoCron] ?? "")
        .replace(/{nome}/g, nomeCliente)
        .replace("{tipoAbordagem}", tipoAbordagem);
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
