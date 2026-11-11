/**
 * Message Handler — utilities for sending WhatsApp messages, managing retries,
 * and dispatching notifications. Pure I/O layer with no business logic.
 */

import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { sendText, sendTyping, sendWhatsAppAudio, isTestNumber } from "../services/evolution.js";
import { textToSpeech } from "../services/elevenlabs.js";
import { assertSendable, handleBlockedSend, PromptLeakError, type SendableContext } from "./output-guard.js";
import { buildInstrucaoBase } from "./persona-router.js";
import { getCurrentStepQuestion } from "./flow-controller.js";

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instancia: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Response cleanup
// ──────────────────────────────────────────────────────────────────────────────

const EMOJI_REGEX = /[\u{1F300}-\u{1FFFF}\u{2600}-\u{27FF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{25AA}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

export function normalizarTexto(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function limparResposta(text: string, nomePersona: string): string {
  const escaped = nomePersona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const semPrefixo = text
    .replace(new RegExp(`^\\*?${escaped}[^\\S\\n]*\\*?[:\\n\\s]\\s*`, ""), "")
    .trim();
  return semPrefixo.replace(EMOJI_REGEX, "").replace(/[^\S\n]{2,}/g, " ").trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Humanized message sending
// ──────────────────────────────────────────────────────────────────────────────

export async function sendHumanized(
  evoConfig: EvolutionConfig,
  phone: string,
  text: string,
  readDelayMs = 0
): Promise<void> {
  if (readDelayMs > 0) {
    await new Promise(r => setTimeout(r, readDelayMs));
  }

  const typingMs = Math.min(Math.max(Math.floor(text.length / 60) * 1000, 2000), 8000);
  try {
    await sendTyping(evoConfig, phone, typingMs);
  } catch {
    // typing indicator is best-effort
  }
  await new Promise(r => setTimeout(r, typingMs));
  try {
    await sendText(evoConfig, phone, text);
  } catch (err) {
    console.error(`[sendHumanized] sendText falhou para ${phone}:`, err);
    throw err;
  }
}

export async function sendHumanizedSafe(
  evoConfig: EvolutionConfig,
  phone: string,
  text: string,
  readDelayMs = 0,
  guardCtx: { deal: { id: string }; persona: { chave: string; nomeExibicao: string }; projetoId: string; currentStep?: { stepType: string; pergunta: string; chave: string } | null }
): Promise<boolean> {
  const ctx: SendableContext = {
    text,
    currentStep: guardCtx.currentStep ?? null,
    persona: { chave: guardCtx.persona.chave, nomeExibicao: guardCtx.persona.nomeExibicao },
    dealId: guardCtx.deal.id,
    projetoId: guardCtx.projetoId,
  };

  try {
    assertSendable(ctx);
  } catch (err) {
    if (err instanceof PromptLeakError) {
      const outcome = await handleBlockedSend(err, ctx);
      if (outcome.fallbackText) {
        await sendHumanized(evoConfig, phone, outcome.fallbackText, readDelayMs);
      }
      return false;
    }
    throw err;
  }

  await sendHumanized(evoConfig, phone, text, readDelayMs);
  return true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Audio or text send — uses ElevenLabs when persona.usarAudio is enabled
// ──────────────────────────────────────────────────────────────────────────────

export async function sendHumanizedOrAudio(
  projetoId: string,
  evoConfig: EvolutionConfig,
  phone: string,
  text: string,
  readDelayMs: number,
  persona: { nomeExibicao: string; usarAudio?: boolean; ttsVoiceId?: string | null },
  guardCtx: { deal: { id: string }; persona: { chave: string; nomeExibicao: string }; projetoId: string },
): Promise<{ sent: boolean; tipoEnvio: "audio" | "text" }> {
  if (persona.usarAudio && persona.ttsVoiceId) {
    const keyCfg = await prisma.iaProjetoConfig.findFirst({
      where: { projetoId, chave: "tts_api_key" },
    });
    const apiKey = keyCfg?.valor ?? null;
    if (apiKey) {
      try {
        if (readDelayMs > 0) await new Promise(r => setTimeout(r, readDelayMs));
        const audioBuffer = await textToSpeech(apiKey, persona.ttsVoiceId, text);
        const audioBase64 = audioBuffer.toString("base64");
        await sendWhatsAppAudio(evoConfig, phone, audioBase64, "audio/ogg");
        return { sent: true, tipoEnvio: "audio" };
      } catch (err) {
        console.warn(`[sendHumanizedOrAudio] ElevenLabs falhou — fallback para texto:`, err);
      }
    }
  }
  const sent = await sendHumanizedSafe(evoConfig, phone, text, readDelayMs, guardCtx);
  return { sent, tipoEnvio: "text" };
}

// ──────────────────────────────────────────────────────────────────────────────
// Evolution config loader
// ──────────────────────────────────────────────────────────────────────────────

export async function getEvolutionConfig(projetoId: string): Promise<EvolutionConfig | null> {
  const configs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "whatsapp" },
  });
  const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
  const baseUrl = get("evolution_api_url");
  const apiKey = get("evolution_api_key");
  const instancia = get("evolution_instancia");
  if (!baseUrl || !apiKey || !instancia) return null;
  return { baseUrl, apiKey, instancia };
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM retry fallback — re-generates and sends when all providers were unavailable
// ──────────────────────────────────────────────────────────────────────────────

export async function respondFromDealState(projetoId: string, dealId: string, phone: string): Promise<void> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal || !deal.iaAtiva) return;

  const stageChave = deal.iaStageChave ?? "lead_carreteiro";
  const fase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: stageChave } },
  });
  const AUTONOMOUS_PERSONAS = new Set(["coleta_docs", "secretaria", "advogado"]);
  const autonomousPersonaOverride = !!deal.iaPersonaChave && AUTONOMOUS_PERSONAS.has(deal.iaPersonaChave);
  if (!fase || (fase.requerAcaoHumana && !autonomousPersonaOverride)) return;

  const personaChave = deal.iaPersonaChave ?? fase.personaChave ?? "assistente";
  const persona = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChave } },
  });
  if (!persona) return;
  // Persona desligada em Config IA → a conversa é da equipe. O cron de "mensagem perdida"
  // passava por aqui e respondia em nome dela mesmo assim (ex.: Daniela desativada falando).
  if (!persona.ativo) {
    console.log(`[RespondFromDealState] dealId=${dealId} — persona "${personaChave}" desativada; nada enviado`);
    return;
  }

  // ── Deterministic flow step re-send ──────────────────────────────────────
  // When the deal is in an active flow step, re-send the step's pergunta directly
  // instead of letting the LLM hallucinate a response.
  const flowStepChave = (deal as any).iaFlowStepChave as string | null | undefined;
  const FLOW_DONE = new Set(["__done__", "__discarded__"]);
  if (flowStepChave && !FLOW_DONE.has(flowStepChave)) {
    const personaFase =
      personaChave === "coleta_docs"
        ? { personaChave: "coleta_docs", fase: "coleta_docs" }
        : personaChave === "advogado"
          ? { personaChave: "advogado", fase: "advogado" }
          : personaChave === "secretaria"
            ? { personaChave: "secretaria", fase: "secretaria" }
            : null;

    if (personaFase) {
      const { pergunta, stepType } = await getCurrentStepQuestion(projetoId, flowStepChave, personaFase);
      if (pergunta && stepType !== "llm_generated") {
        const evoConfig = await getEvolutionConfig(projetoId);
        if (!evoConfig) return;

        const textoLimpo = limparResposta(
          pergunta.replace(/\{nome_persona\}/g, persona.nomeExibicao),
          persona.nomeExibicao
        );
        const respostaWA = `*${persona.nomeExibicao}*\n${textoLimpo}`;
        await sendHumanized(evoConfig, phone, respostaWA, 3000);

        const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
        if (contato) {
          await prisma.crmMensagemWhatsapp.create({
            data: {
              dealId,
              contatoId: contato.id,
              direcao: "out",
              remetente: persona.nomeExibicao,
              personaChave,
              tipo: "text",
              conteudo: textoLimpo,
            },
          });
        }
        return;
      }
    }
  }
  // ─────────────────────────────────────────────────────────────────────────

  // For assistente persona: re-send the last outgoing message instead of a free LLM call.
  // A free LLM call here has no flow context and generates wrong follow-up questions
  // (e.g. jumping to "cidade" instead of repeating the pending "Me conta tudo").
  if (personaChave === "assistente") {
    const ultimaOut = await prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId, direcao: "out" },
      orderBy: { enviadaEm: "desc" },
    });
    if (!ultimaOut?.conteudo) return;

    const evoConfig = await getEvolutionConfig(projetoId);
    if (!evoConfig) return;

    await sendHumanized(evoConfig, phone, `*${persona.nomeExibicao}*\n${ultimaOut.conteudo}`, 3000);

    const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
    if (contato) {
      await (prisma.crmMensagemWhatsapp as any).create({
        data: {
          dealId,
          contatoId: contato.id,
          direcao: "out",
          remetente: persona.nomeExibicao,
          personaChave,
          tipo: "text",
          conteudo: ultimaOut.conteudo,
        },
      });
    }
    return;
  }

  const history = await prisma.crmMensagemWhatsapp.findMany({
    where: { dealId },
    orderBy: { enviadaEm: "desc" },
    take: 20,
  });
  history.reverse();

  const llmMessages = history.map((m) => ({
    role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
    content: m.conteudo ?? "",
  }));

  const { getPersonaNomeExibicao: getPN } = await import("./transition-engine.js");
  const [advNomeMH, secNomeMH, assistNomeMH] = await Promise.all([
    getPN(projetoId, "advogado"),
    getPN(projetoId, "secretaria"),
    getPN(projetoId, "assistente"),
  ]);
  const INSTRUCAO_BASE = buildInstrucaoBase(advNomeMH);
  let userSystem = persona.systemPrompt
    .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
    .replace(/\{nome_persona\}/g, persona.nomeExibicao)
    .replace(/\{nome_advogado\}/g, advNomeMH)
    .replace(/\{nome_secretaria\}/g, secNomeMH)
    .replace(/\{nome_assistente\}/g, assistNomeMH);
  if (!userSystem.includes("REGRAS INVIOLÁVEIS DE COMUNICAÇÃO")) {
    userSystem = INSTRUCAO_BASE + "\n\n" + userSystem;
  }

  // Inject step context for llm_generated steps
  if (flowStepChave && !FLOW_DONE.has(flowStepChave)) {
    userSystem += `\n\nO lead está aguardando resposta no passo "${flowStepChave}" do fluxo. Responda de acordo com esse contexto sem pular etapas.`;
  }

  const result = await callLlm({
    projetoId,
    dealId,
    systemPrompt: userSystem,
    messages: llmMessages,
    personaChave,
    personaLlmChave: (persona as any).llmProviderChave ?? null,
    stageChave,
    maxTokens: 2048,
  });
  const resposta = result.content.trim();
  if (!resposta) return;

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  const textoLimpo = limparResposta(resposta, persona.nomeExibicao);
  const respostaWA = `*${persona.nomeExibicao}*\n${textoLimpo}`;
  await sendHumanized(evoConfig, phone, respostaWA, 3000);

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  if (contato) {
    await prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        contatoId: contato.id,
        direcao: "out",
        remetente: persona.nomeExibicao,
        personaChave,
        tipo: "text",
        conteudo: textoLimpo,
      },
    });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// TTS audio sender
// ──────────────────────────────────────────────────────────────────────────────

export async function sendAudioIfConfigured(
  projetoId: string,
  evoConfig: EvolutionConfig,
  phone: string,
  text: string,
  personaChave: string,
  momento: string,
  dealId: string,
): Promise<void> {
  try {
    const ttsConfigs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, categoria: "tts" },
    });
    const getTts = (k: string) => ttsConfigs.find((c) => c.chave === k)?.valor ?? "";

    const apiKey  = getTts("tts_api_key");
    const model   = getTts("tts_model") || "eleven_multilingual_v2";
    const momentos = getTts("tts_momentos_audio")
      .split(",").map((m) => m.trim()).filter(Boolean);

    if (!apiKey || !momentos.includes(momento)) return;

    const persona = await prisma.iaPersona.findUnique({
      where: { projetoId_chave: { projetoId, chave: personaChave } },
    });
    const voiceId = (persona as any)?.ttsVoiceId as string | undefined;
    if (!voiceId) return;

    const audioBuffer = await textToSpeech(apiKey, voiceId, text, model);
    await sendWhatsAppAudio(evoConfig, phone, audioBuffer.toString("base64"));

    prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        direcao: "out",
        personaChave,
        tipo: "audio",
        conteudo: text,
      },
    }).catch(() => {});

    console.log(`[TTS] Áudio enviado para ${phone} (${personaChave}/${momento})`);
  } catch (err: any) {
    console.warn(`[TTS] Falha ao enviar áudio — ${err?.message ?? err}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Notification dispatcher
// ──────────────────────────────────────────────────────────────────────────────

export async function dispararNotificacoes(
  projetoId: string,
  evento: string,
  dados: Record<string, string>
): Promise<void> {
  console.log(`[Notificação] evento="${evento}" projetoId=${projetoId}`);
  // Lead de QA (prefixo 5500990000): o envio ao lead já é no-op, mas o aviso ia para o
  // grupo real da equipe (teste de 24/10 avisou "lead qualificado" fictício).
  if (dados.telefone && isTestNumber(dados.telefone)) {
    console.log(`[Notificação] TEST ${dados.telefone} — evento "${evento}" não enviado`);
    return;
  }
  const notifs = await prisma.iaNotificacaoEvento.findMany({
    where: { projetoId, evento, ativo: true },
  });
  if (!notifs.length) {
    console.log(`[Notificação] nenhuma notif configurada para evento="${evento}"`);
    return;
  }

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) {
    console.log(`[Notificação] evoConfig null — Evolution não configurado para projetoId=${projetoId}`);
    return;
  }

  for (const notif of notifs) {
    try {
      const texto = notif.mensagem.replace(/\{\{(\w+)\}\}/g, (_, k) => dados[k] ?? "");
      console.log(`[Notificação] enviando para ${notif.destino} (${texto.length} chars)`);
      await sendText(evoConfig, notif.destino, texto);
      console.log(`[Notificação] enviado OK para ${notif.destino}`);
      await prisma.iaNotificacaoLog.create({
        data: {
          projetoId,
          dealId: dados.dealId || null,
          evento,
          destino: notif.destino,
          mensagem: texto,
          nomeLead: dados.nome || null,
        },
      });
    } catch (err) {
      console.error(`[Notificação] Falha ao enviar para ${notif.destino}:`, err);
    }
  }
}

const DEFAULT_LIGACAO_PALAVRAS = "me liga,pode ligar,ligue pra mim,ligue para mim,quero ligacao,quero uma ligacao,preciso de ligacao,prefiro falar por telefone,falar por telefone,quando voces ligam,quando vocês ligam,aguardando a ligacao,espero a ligacao,manda o telefone,qual o telefone,numero de telefone";

export async function checkAndNotifySolicitaLigacao(
  projetoId: string,
  dealId: string,
  merged: Record<string, unknown>,
  text: string,
  phone: string,
  stageChave: string,
): Promise<{ notificado: boolean; timestamp?: string }> {
  let config = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, categoria: "comportamento", chave: "solicita_ligacao_palavras" } });
  if (!config) config = await prisma.iaProjetoConfig.create({ data: { projetoId, categoria: "comportamento", chave: "solicita_ligacao_palavras", valor: DEFAULT_LIGACAO_PALAVRAS } }).catch(() => null);
  const palavras = (config?.valor ?? DEFAULT_LIGACAO_PALAVRAS).split(",").map(p => p.trim()).filter(Boolean);
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  if (!palavras.some(p => norm(text).includes(norm(p)))) return { notificado: false };
  const ultimaNotif = merged._notif_ligacao_at as string | undefined;
  if (ultimaNotif && (Date.now() - new Date(ultimaNotif).getTime() < 2 * 60 * 60 * 1000)) return { notificado: false };
  const { buildLeadBriefing } = await import("./lead-briefing.js");
  const briefingLigacao = await buildLeadBriefing(dealId, {
    titulo: "📞 LEAD PEDIU LIGAÇÃO",
    acao: `Ligar agora — ele pediu: "${text.slice(0, 80)}"`,
  }).catch(() => "");
  dispararNotificacoes(projetoId, "solicita_ligacao", {
    nome: String(merged.nome ?? ""), telefone: phone, stage: stageChave, mensagem: text,
    empresa: String(merged.empresa_recente ?? (Array.isArray(merged.vinculos) && (merged.vinculos as any[])[0]?.empresa) ?? ""),
    cidade: String(merged.cidade ?? ""), briefing: briefingLigacao, dealId,
  }).catch(() => {});
  console.log(`[StageEngine] Cliente ${phone} pediu ligação — notificação disparada`);
  return { notificado: true, timestamp: new Date().toISOString() };
}
