/**
 * Transition Engine — deal stage transitions, processual deal creation,
 * and proactive outbound messages.
 */

import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { getEvolutionConfig, sendHumanized, limparResposta, sendAudioIfConfigured, dispararNotificacoes } from "./message-handler.js";
import { buildInstrucaoBase } from "./persona-router.js";

// ──────────────────────────────────────────────────────────────────────────────
// Stage transitions
// ──────────────────────────────────────────────────────────────────────────────

export async function transitionDeal(
  projetoId: string,
  dealId: string,
  condicao: string,
  phone?: string
): Promise<boolean> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal) return false;

  const stageAtual = deal.iaStageChave;

  const regra = await prisma.iaRegraTransicao.findFirst({
    where: { projetoId, stageOrigemChave: stageAtual, condicao },
    orderBy: { ordem: "asc" },
  });

  if (!regra) return false;

  const novaFase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: regra.stageDestinoChave } },
  });

  if (!novaFase) return false;

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

  {
    const contatoNotif = await prisma.crmContato.findFirst({ where: { deals: { some: { id: dealId } } } });
    const qual = (deal.qualificacao as Record<string, unknown>) ?? {};
    dispararNotificacoes(projetoId, `stage_entrada:${regra.stageDestinoChave}`, {
      nome:     String(contatoNotif?.nome ?? ""),
      cidade:   String(qual.cidade ?? ""),
      telefone: contatoNotif?.whatsapp ?? "",
      stage:    regra.stageDestinoChave,
    }).catch(() => {});
  }

  if (!regra.acaoAdicional) return false;

  if (regra.acaoAdicional.startsWith("trocar_persona:")) {
    if (phone) {
      const contatoTroca = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
      const nomeTroca = contatoTroca?.nome ?? "cliente";
      const DELAY_PERSONA_MS = 45_000; // 45 seconds — feels like Daniela was just notified
      console.log(`[StageEngine] Deal ${dealId}: intro da nova persona agendada em 45s`);
      setTimeout(async () => {
        try {
          await enviarMensagemProativa(projetoId, dealId, phone, "primeira_mensagem", nomeTroca);
        } catch (err) {
          console.warn(`[StageEngine] Falha ao enviar intro de persona (será recuperada pelo cron): ${err instanceof Error ? err.message : err}`);
        }
      }, DELAY_PERSONA_MS);
      return true;
    }
    return false;
  }

  if (!phone) return false;

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  const nomeCliente = contato?.nome ?? "cliente";

  const acao = regra.acaoAdicional;

  if (acao === "solicitar_documentos") {
    await prisma.crmDeal.update({ where: { id: dealId }, data: { iaPersonaChave: novaPersona } });
    await enviarMensagemProativa(projetoId, dealId, phone, "solicitar_documentos", nomeCliente);
    return true;
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
    return true;
  }

  return false;
}

export async function checkTransitions(
  projetoId: string,
  dealId: string,
  stageAtual: string,
  clienteText: string,
  phone: string
): Promise<boolean> {
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

  return false;
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
      const firstStep = await prisma.iaFlowStep.findFirst({
        where: { projetoId, personaChave: "advogado", fase: "advogado", ativo: true },
        orderBy: { ordem: "asc" },
      });
      if (firstStep?.pergunta) {
        mensagem = String(firstStep.pergunta);
        await prisma.crmDeal.update({
          where: { id: dealId },
          data: { iaFlowStepChave: firstStep.chave, iaFlowStepData: {} },
        });
      } else {
        instrucao = `TIPO DE ABORDAGEM: ${tipoAbordagem}\n\nEscreva APENAS a primeira mensagem para ${nomeCliente}. Siga exatamente as instruções de PRIMEIRA MENSAGEM do seu system prompt para o cenário correspondente. Uma mensagem curta e natural de WhatsApp.`;
      }
    } else if (motivoCron === "primeira_mensagem") {
      instrucao = `TIPO DE ABORDAGEM: ${tipoAbordagem}\n\nEscreva APENAS a primeira mensagem para ${nomeCliente}. Siga exatamente as instruções de PRIMEIRA MENSAGEM do seu system prompt para o cenário correspondente. Uma mensagem curta e natural de WhatsApp.`;
    } else if (motivoCron === "timeout_sem_resposta") {
      instrucao = `O cliente ${nomeCliente} não respondeu há algum tempo. Envie uma mensagem de seguimento natural, sem pressão.`;
    } else if (motivoCron === "closer_tentativa_1") {
      instrucao = `Você é a Dra. Daniela Pires. O cliente ${nomeCliente} parou de responder. Envie o lembrete sobre prescrição trabalhista (2 anos). Seja conciso e direto.`;
    } else if (motivoCron === "closer_tentativa_2") {
      instrucao = `Você é a Dra. Daniela Pires. Segunda e última tentativa com ${nomeCliente}. Mencione valores que costumamos recuperar e que não há custo antecipado.`;
    } else if (motivoCron === "solicitar_documentos") {
      instrucao = `O cliente ${nomeCliente} confirmou interesse. Solicite a CNH frente de forma natural e humana para dar início ao processo.`;
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
