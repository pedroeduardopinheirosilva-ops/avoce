/**
 * Stage Engine — 100% data-driven WhatsApp AI orchestrator
 * Zero hardcoded stage logic. Behavior comes entirely from DB tables.
 */

import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { downloadMedia, sendDocument, sendText } from "../services/evolution.js";
import { transcribeAudio, downloadAudioFromEvolution } from "../services/whisper.js";
import { detectIdentityQuestion, buildIdentityResponse, registrarEventoIdentidade } from "./identity-handler.js";
import { detectFrustration, buildFrustrationHandling, type FrustrationHandling } from "./frustration-detector.js";
import { isAskingValue, buildValueResponseInjection } from "./value-trigger.js";
import { calcularValorCausa } from "./calc-trabalhista.js";
import { buildHandoffSnapshot } from "./handoff-snapshot.js";

// ── New module imports ──────────────────────────────────────────────────────
import {
  validarCPF, temDadosMinimosCalculo, extractVinculosFromMerged,
  extractDocumentJson, extractMediaData, extractQualificacaoData,
  tryExtractVinculo, checkVinculoPrazo, syncVinculosFromFlat,
  type DocJsonResult, type VinculoEmprego,
} from "./qualification.js";
import {
  buildInstrucaoBase, detectarFaseAtualDaniela, invalidateFlowCache,
  getNextDeterministicQuestion,
} from "./persona-router.js";
import {
  sendHumanized, sendHumanizedSafe, normalizarTexto, limparResposta,
  getEvolutionConfig, respondFromDealState, sendAudioIfConfigured, dispararNotificacoes,
  type EvolutionConfig,
} from "./message-handler.js";
import {
  transitionDeal, checkTransitions, criarDealProcessual, enviarMensagemProativa,
} from "./transition-engine.js";

// Re-exports for backward compatibility (cron-agent.ts, ia.ts, index.ts)
export { transitionDeal, enviarMensagemProativa, getEvolutionConfig, respondFromDealState };
export { dispararNotificacoes };
export { invalidateFlowCache };
export type { EvolutionConfig };

// ──────────────────────────────────────────────────────────────────────────────
// Message debounce queue — coalesce rapid messages from the same deal into one LLM call
// When a message arrives, wait DEBOUNCE_MS before processing.
// If another message from the same deal arrives before the timer fires, restart the timer.
// ──────────────────────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 4000; // 4 seconds
const _debounceQueue = new Map<string, ReturnType<typeof setTimeout>>();

function debounceProcess(dealId: string, fn: () => Promise<void>): void {
  const existing = _debounceQueue.get(dealId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    _debounceQueue.delete(dealId);
    try { await fn(); } catch (err) {
      console.error(`[Debounce] Erro ao processar deal ${dealId}:`, err);
    }
  }, DEBOUNCE_MS);
  _debounceQueue.set(dealId, timer);
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM failure retry queue
// When all providers are down, we schedule a retry so the client gets a response
// once the LLMs recover. Max 4 retries with exponential backoff (60s→120s→240s→480s).
// ──────────────────────────────────────────────────────────────────────────────
const _retryQueue = new Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>();

export function scheduleLlmRetry(
  projetoId: string,
  dealId: string,
  phone: string,
  attempts = 1,
  delayMs = 60_000
): void {
  if (attempts > 4) {
    console.warn(`[RetryQueue] Deal ${dealId}: esgotadas ${attempts} tentativas — desistindo`);
    _retryQueue.delete(dealId);
    return;
  }
  const existing = _retryQueue.get(dealId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    _retryQueue.delete(dealId);
    console.log(`[RetryQueue] Tentativa ${attempts} para deal ${dealId} (phone ${phone})`);
    try {
      await respondFromDealState(projetoId, dealId, phone);
    } catch (err: any) {
      console.warn(`[RetryQueue] Tentativa ${attempts} falhou: ${err?.message}`);
      scheduleLlmRetry(projetoId, dealId, phone, attempts + 1, Math.min(delayMs * 2, 480_000));
    }
  }, delayMs);

  _retryQueue.set(dealId, { timer, attempts });
  console.log(`[RetryQueue] Deal ${dealId}: retry em ${Math.round(delayMs / 1000)}s (tentativa ${attempts})`);
}

function splitState(merged: Record<string, unknown>): { qualificacao: any; iaFlags: any } {
  const qual: Record<string, unknown> = {};
  const iaf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k.startsWith("_")) iaf[k] = v;
    else qual[k] = v;
  }
  return { qualificacao: qual as any, iaFlags: iaf as any };
}

async function atualizarMergedFlags(
  dealId: string,
  mergedAtual: Record<string, unknown>,
  flags: Record<string, unknown>
): Promise<void> {
  const novo = { ...mergedAtual, ...flags };
  await prisma.crmDeal.update({ where: { id: dealId }, data: splitState(novo) });
}

export interface EvolutionWebhookMessage {
  key: { id: string; remoteJid: string; fromMe: boolean };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text: string };
    imageMessage?: { caption?: string; url?: string };
    audioMessage?: { url?: string };
    documentMessage?: { url?: string; mimetype?: string };
  };
  messageType?: string;
  pushName?: string;
  instanceName?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point — called by webhook
// ──────────────────────────────────────────────────────────────────────────────

export async function processIncomingMessage(
  projetoId: string,
  msg: EvolutionWebhookMessage,
  saveOnly = false   // when true: only save to DB, skip LLM (for intermediate debounce messages)
): Promise<void> {
  const phone = msg.key.remoteJid.replace(/@.*/, "");
  if (msg.key.fromMe) return;

  // Deduplication: skip if this exact Evolution message was already processed.
  // Uses a unique constraint on evolutionMessageId — the INSERT below is the atomic guard.
  // Any duplicate webhook fires will hit the unique violation (P2002) and be silently dropped.

  let text = extractText(msg);
  let documentosEnviados = false; // set to true when OCR extraction succeeds — for documentos_pessoais trigger
  let docJsonDireto: DocJsonResult | null = null; // resultado estruturado direto do Groq Vision JSON
  const isAudio = msg.messageType === "audioMessage" || !!msg.message?.audioMessage;
  const tipo = isAudio ? "audio" : (msg.messageType ?? "text");

  // Skip status messages
  if (msg.key.remoteJid.endsWith("@broadcast") || msg.key.remoteJid.endsWith("@g.us")) return;

  // ── Transcrição de áudio ─────────────────────────────────────────────────
  if (isAudio) {
    try {
      const audioConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId, categoria: "audio" },
      });
      const getAudio = (k: string) => audioConfigs.find((c) => c.chave === k)?.valor ?? "";
      const audioApiKey = getAudio("audio_api_key");
      const audioModel  = getAudio("audio_model")  || "whisper-large-v3-turbo";
      const audioProvider = (getAudio("audio_provider") || "groq") as "groq" | "openai";

      if (audioApiKey) {
        // Buscar config Evolution para download do áudio
        const waConfigs = await prisma.iaProjetoConfig.findMany({
          where: { projetoId, categoria: "whatsapp" },
        });
        const getWa = (k: string) => waConfigs.find((c) => c.chave === k)?.valor ?? "";
        const evoConfig = {
          baseUrl: getWa("evolution_api_url").replace(/\/$/, ""),
          apiKey:  getWa("evolution_api_key"),
          instancia: getWa("evolution_instancia"),
        };

        if (evoConfig.baseUrl && evoConfig.apiKey) {
          const audio = await downloadAudioFromEvolution(
            evoConfig.baseUrl, evoConfig.apiKey, evoConfig.instancia, msg
          );
          if (audio) {
            const result = await transcribeAudio(
              audio.buffer, audio.mimetype, audioApiKey, audioModel, audioProvider
            );
            if (result.ok && result.text) {
              text = result.text;
              console.log(`[Audio] Transcrito (${audioProvider}): "${text.slice(0, 80)}"`);
            } else {
              console.warn(`[Audio] Falha na transcrição: ${result.error}`);
            }
          }
        }
      }
    } catch (e: any) {
      console.error(`[Audio] Erro ao transcrever: ${e.message}`);
    }
  }

  // ── Extração de dados de documentos e imagens ──────────────────────────────
  // When client sends a CNH, CTPS, PDF contract, or any other document/image,
  // extract qualification data via Anthropic Vision and populate deal fields.
  const isDocument = msg.messageType === "documentMessage" || !!msg.message?.documentMessage;
  const isImage = !isAudio && (msg.messageType === "imageMessage" || !!msg.message?.imageMessage);

  if (isDocument || isImage) {
    try {
      const waConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId, categoria: "whatsapp" },
      });
      const getWa = (k: string) => waConfigs.find((c) => c.chave === k)?.valor ?? "";
      const docEvoConfig: EvolutionConfig = {
        baseUrl: getWa("evolution_api_url").replace(/\/$/, ""),
        apiKey:  getWa("evolution_api_key"),
        instancia: getWa("evolution_instancia"),
      };

      if (docEvoConfig.baseUrl && docEvoConfig.apiKey) {
        const mediaBuffer = await downloadMedia(docEvoConfig, msg.key.id);

        const mimetype = msg.message?.documentMessage?.mimetype
          ?? (isImage ? "image/jpeg" : "application/octet-stream");

        // Load OCR provider keys
        const ocrConfigs = await prisma.iaProjetoConfig.findMany({
          where: { projetoId, categoria: "ocr" },
        });
        let mistralKey = ocrConfigs.find((c) => c.chave === "ocr_mistral_api_key")?.valor ?? "";

        // Auto-create OCR config entries so they appear in Config IA
        if (!ocrConfigs.length) {
          prisma.iaProjetoConfig.createMany({
            data: [
              { projetoId, categoria: "ocr", chave: "ocr_mistral_api_key", valor: "", descricao: "API Key Mistral (OCR — PDFs escaneados e imagens)" },
            ],
            skipDuplicates: true,
          }).catch(() => {});
        }

        // Groq key: prefer LLM provider, fallback to audio key
        const groqLlmRow = await prisma.iaLlmProvedor.findFirst({
          where: { projetoId, ativo: true, provider: "groq" },
          orderBy: { ordem: "asc" },
        });
        let groqKey = groqLlmRow?.apiKey ?? "";
        if (!groqKey) {
          const audioConfigs = await prisma.iaProjetoConfig.findMany({
            where: { projetoId, categoria: "audio" },
          });
          groqKey = audioConfigs.find((c) => c.chave === "audio_api_key")?.valor ?? "";
        }

        // Anthropic key: used by Python extractor (Claude Vision Strategy 3 — optional)
        const anthropicLlmRow = await prisma.iaLlmProvedor.findFirst({
          where: { projetoId, ativo: true, provider: "anthropic" },
          orderBy: { ordem: "asc" },
        });
        const anthropicKey = anthropicLlmRow?.apiKey ?? "";

        // Roda extração de texto (para mensagem) e JSON estruturado (para campos) em paralelo
        const [extracted, _docJsonDireto] = await Promise.all([
          extractMediaData({ groqKey, mistralKey }, mediaBuffer, mimetype).catch(() => null),
          extractDocumentJson({ groqKey, mistralKey, anthropicKey }, mediaBuffer, mimetype).catch(() => null),
        ]);
        docJsonDireto = _docJsonDireto; // assign to outer scoped variable (avoids shadowing)

        // Armazena resultado estruturado para usar no passo 7a2 (sem passar por extractJson)
        if (docJsonDireto) {
          console.log(`[DocExtract] JSON direto: tipo=${docJsonDireto.tipo_documento} cpf=${docJsonDireto.cpf} rg=${docJsonDireto.rg} orgao=${docJsonDireto.orgao_emissor_rg}`);
        }

        // documentosEnviados=true whenever a doc/image arrives — so the system prompt
        // always guides the LLM correctly (whether or not OCR succeeded).
        documentosEnviados = true;
        if (extracted) {
          text = `[Documento recebido — dados extraídos]\n${extracted}`;
          console.log(`[DocExtract] OCR texto ok:\n${extracted.slice(0, 300)}`);
        } else {
          text = isDocument ? "[Cliente enviou um documento — leitura automática falhou]" : "[Cliente enviou uma foto/imagem — leitura automática falhou]";
        }
      }
    } catch (e: any) {
      console.warn(`[DocExtract] Falha ao extrair ${isDocument ? "documento" : "imagem"}: ${e?.message}`);
      documentosEnviados = true; // still guide the LLM
      if (!text) {
        text = isDocument ? "[Cliente enviou um documento — leitura automática falhou]" : "[Cliente enviou uma foto/imagem — leitura automática falhou]";
      }
    }
  }

  // 1. Find or create contact + deal
  let contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  let deal = contato
    ? await prisma.crmDeal.findFirst({
        where: { contatoId: contato.id, projetoId, status: "aberto" },
        orderBy: { criadoEm: "desc" },
      })
    : null;

  if (!contato) {
    const nome = msg.pushName ?? `Lead ${phone}`;
    contato = await prisma.crmContato.create({ data: { nome, whatsapp: phone } });
  }

  const isNewDeal = !deal;
  if (!deal) {
    deal = await createInitialDeal(projetoId, contato.id, contato.nome);
  }

  // 2. Save incoming message — atomic dedup guard via unique(evolutionMessageId).
  // If the same webhook fires twice, the second INSERT throws P2002 and we bail out.
  try {
    await prisma.crmMensagemWhatsapp.create({
      data: {
        dealId: deal.id,
        contatoId: contato.id,
        direcao: "in",
        remetente: phone,
        tipo,
        conteudo: text ?? "",
        evolutionMessageId: msg.key.id,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      console.log(`[StageEngine] Mensagem ${msg.key.id} já processada — ignorando duplicata`);
      return;
    }
    throw err;
  }

  // 2b. saveOnly mode — just save to DB, no LLM processing (intermediate debounce messages)
  if (saveOnly) return;

  // 2c. New deal → greet and stop.
  // Prefer the configured saudação step; fall back to LLM-generated greeting.
  if (isNewDeal) {
    // Race condition / duplicate webhook guard: if the deal already has an outgoing message, bail out.
    const alreadyGreeted = await prisma.crmMensagemWhatsapp.count({ where: { dealId: deal.id, direcao: "out" } });
    if (alreadyGreeted > 0) return;

    const { getGreetingStep } = await import("./flow-controller.js");
    const greetingStepText = await getGreetingStep(projetoId).catch(() => null);

    if (greetingStepText) {
      const horaStr = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo", hour12: false });
      const hora = parseInt(horaStr.split(":")[0], 10);
      const saudacaoWord = hora >= 5 && hora < 12 ? "Bom dia" : hora >= 12 && hora < 18 ? "Boa tarde" : "Boa noite";
      const saudacaoFull = `${saudacaoWord}! ${greetingStepText}`;

      const qualAtual = {
        ...(deal.qualificacao as Record<string, unknown> ?? {}),
        ...((deal as any).iaFlags as Record<string, unknown> ?? {}),
        _saudacao_enviada: true,
      };
      await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(qualAtual) });

      const evoConf = await getEvolutionConfig(projetoId);
      if (evoConf) {
        const delayMs = 1500 + Math.random() * 1500;
        await sendHumanized(evoConf, phone, saudacaoFull, delayMs);
        await prisma.crmMensagemWhatsapp.create({
          data: { dealId: deal.id, contatoId: contato.id, direcao: "out", tipo: "text", conteudo: saudacaoFull },
        });
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
      }
    } else {
      await enviarMensagemProativa(projetoId, deal.id, phone, "primeira_mensagem", "");
    }
    return;
  }

  // 3. IA paused — human took over
  if (!deal.iaAtiva) return;

  // 4. Update contact name
  if (msg.pushName && contato.nome.startsWith("Lead ")) {
    await prisma.crmContato.update({ where: { id: contato.id }, data: { nome: msg.pushName } });
    contato = { ...contato, nome: msg.pushName };
  }

  // 5. Load stage & persona
  const stageChave = deal.iaStageChave ?? "lead_carreteiro";
  const fase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: stageChave } },
  });

  if (!fase || fase.requerAcaoHumana) return;

  const personaChave = deal.iaPersonaChave ?? fase.personaChave ?? "assistente";
  const persona = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChave } },
  });

  if (!persona) return;

  // 6. Load last 20 messages as context
  const history = await prisma.crmMensagemWhatsapp.findMany({
    where: { dealId: deal.id },
    orderBy: { enviadaEm: "desc" },
    take: 20,
  });
  history.reverse();

  // 7. Load qualification questions for basic fields (nome, cidade, interesse, etc.)
  //    Employment links are handled separately via the vinculos array loop below.
  const perguntas = await prisma.iaPerguntaQualificacao.findMany({
    where: { projetoId, stageColeta: stageChave, ativo: true },
    orderBy: { ordem: "asc" },
  });

  let merged: Record<string, unknown> = {
    ...(deal.qualificacao as Record<string, unknown> ?? {}),
    ...((deal as any).iaFlags as Record<string, unknown> ?? {}),
  };

  // ── Early returns: identidade e frustração (antes de qualquer LLM) ──────────

  const mensagemNormalizada = normalizarTexto(text ?? "");

  // Sprint 1.1 — P2: pergunta de identidade tem precedência absoluta
  if (text && detectIdentityQuestion(mensagemNormalizada)) {
    const respostaIdentidade = await buildIdentityResponse({ id: projetoId }, persona);
    const evoConf = await getEvolutionConfig(projetoId);
    if (evoConf) {
      await sendHumanizedSafe(evoConf, phone, respostaIdentidade, 2000, { deal, persona, projetoId });
      await prisma.crmMensagemWhatsapp.create({
        data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: respostaIdentidade },
      });
    }
    await registrarEventoIdentidade(deal.id, text, respostaIdentidade);
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
    return;
  }

  // Sprint 1.2 — P6: frustração categorizada
  let frustrationHandling: FrustrationHandling | null = null;
  if (text) {
    const frustration = detectFrustration(mensagemNormalizada, history);
    if (frustration) {
      // Para duvida_legitimidade precisamos do texto de identidade
      let identityText: string | undefined;
      if (frustration.type === "duvida_legitimidade") {
        identityText = await buildIdentityResponse({ id: projetoId }, persona);
      }

      // Para abandono_iminente busca texto de retenção do DB
      let retencaoText: string | undefined;
      if (frustration.type === "abandono_iminente") {
        const retencaoConfig = await prisma.iaProjetoConfig.findFirst({
          where: { projetoId, chave: "comportamento.mensagem_retencao" },
        });
        retencaoText = retencaoConfig?.valor ?? undefined;
      }

      frustrationHandling = buildFrustrationHandling(frustration, deal, merged, persona, identityText, retencaoText);

      if (frustrationHandling.escalateToHuman) {
        dispararNotificacoes(projetoId, `frustracao_${frustration.type}`, {
          dealId: deal.id,
          mensagem: text,
          triggerPhrase: frustration.triggerPhrase,
          nome: String(merged.nome ?? contato.nome ?? ""),
          telefone: phone,
        }).catch(() => {});
      }

      if (frustrationHandling.forceResponseText) {
        const evoConf = await getEvolutionConfig(projetoId);
        if (evoConf) {
          await sendHumanizedSafe(evoConf, phone, frustrationHandling.forceResponseText, 2000, { deal, persona, projetoId });
          await prisma.crmMensagemWhatsapp.create({
            data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: frustrationHandling.forceResponseText },
          });
          await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
        }
        return;
      }
      // Se só tem injectIntoSystemPrompt: continua o flow com a injeção (frustrationHandling está set)
    }
  }

  // ── Fim dos early returns ────────────────────────────────────────────────────

  // Sprint 2 — Gatilho de valor (Daniela, após dados mínimos disponíveis)
  if (
    text &&
    personaChave === "advogado" &&
    isAskingValue(mensagemNormalizada) &&
    temDadosMinimosCalculo(merged)
  ) {
    const vinculosCalculo = extractVinculosFromMerged(merged);
    const calculo = calcularValorCausa(vinculosCalculo);
    const faseAtual = detectarFaseAtualDaniela(deal);
    const injecao = buildValueResponseInjection(calculo, faseAtual);

    const llmHistory = history.map((m) => ({
      role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
      content: m.conteudo ?? "",
    }));

    let respostaValor = "";
    try {
      const baseSystem = persona.systemPrompt.replace("{INSTRUÇÃO BASE}", buildInstrucaoBase()).replace(/\{nome_persona\}/g, persona.nomeExibicao);
      const result = await callLlm({
        projetoId,
        dealId: deal.id,
        systemPrompt: baseSystem + "\n\n" + injecao,
        messages: llmHistory.slice(-10),
        personaChave,
        personaLlmChave: (persona as any).llmProviderChave ?? null,
        stageChave,
        maxTokens: 1024,
      });
      respostaValor = limparResposta(result.content.trim(), persona.nomeExibicao);
    } catch { /* fallback: segue flow normal */ }

    if (respostaValor) {
      const evoConf = await getEvolutionConfig(projetoId);
      if (evoConf) {
        await sendHumanizedSafe(evoConf, phone, respostaValor, 2000, { deal, persona, projetoId });
        await prisma.crmMensagemWhatsapp.create({
          data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: respostaValor },
        });
      }
      // Marca que valor foi apresentado e atualiza timestamp
      await atualizarMergedFlags(deal.id, merged, { _valor_apresentado: true, _valor_apresentado_em: new Date().toISOString() });
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
      return;
    }
  }

  // 7a. Extract basic qualification fields from recent history.
  //     Sprint 3: também extrai campos pessoais quando persona é advogado (CPF, nome, etc.)
  //     Sprint 3: lazy — skip se mensagem é ACK curto sem dados.
  const HINTS_ADVOGADO = [
    { chave: "cpf", perguntaContexto: "CPF do cliente, 11 dígitos. Formato: XXX.XXX.XXX-XX ou apenas dígitos.", tipoDado: "texto" },
    { chave: "nome_completo", perguntaContexto: "Nome completo do cliente conforme documento (RG, CNH).", tipoDado: "texto" },
    { chave: "data_nascimento", perguntaContexto: "Data de nascimento do cliente. Aceitar DD/MM/AAAA.", tipoDado: "texto" },
    { chave: "endereco", perguntaContexto: "Endereço residencial completo: rua, número, bairro, cidade, estado, CEP.", tipoDado: "texto" },
    { chave: "estado_civil", perguntaContexto: "Estado civil: solteiro, casado, divorciado, viúvo, união estável.", tipoDado: "texto" },
    { chave: "profissao", perguntaContexto: "Profissão registrada na carteira de trabalho.", tipoDado: "texto" },
  ];

  // "sim"/"nao" are explicit yes/no answers — NOT acks. Remove them so extraction runs.
  const ACKS_REGEX = /^(ok|certo|beleza|tá|ta|aham|combinado|opa|oi)\.?$/i;
  const charsUteis = (text ?? "").replace(/\s/g, "").length;
  // Threshold 2 (not 3): "sp", "rj", etc. are valid 2-char answers. ACKS_REGEX already blocks "ok","ta","oi".
  const mensagemTemDados = charsUteis >= 2 && !ACKS_REGEX.test((text ?? "").trim());

  const todosOsPendentes = perguntas.filter((p) => merged[p.chave] === undefined || merged[p.chave] === null);

  // Para advogado, adiciona hints de campos pessoais não coletados
  if (personaChave === "advogado") {
    for (const hint of HINTS_ADVOGADO) {
      if (merged[hint.chave] === undefined || merged[hint.chave] === null) {
        if (!todosOsPendentes.find(p => p.chave === hint.chave)) {
          todosOsPendentes.push(hint as any);
        }
      }
    }
  }

  // Para assistente: extrai campos hardcoded de getNextDeterministicQuestion que não estão em IaPerguntaQualificacao
  if (personaChave === "assistente") {
    const HINTS_ASSISTENTE = [
      { chave: "acao_em_andamento", perguntaContexto: "O cliente já tem ação trabalhista em andamento ou advogado cuidando do caso? true = sim tem; false = não tem.", tipoDado: "booleano" },
      { chave: "interesse", perguntaContexto: "O cliente demonstrou interesse em entender o caso, contratar ou avançar? true = sim; false = não.", tipoDado: "booleano" },
      { chave: "vinculo_recente", perguntaContexto: "Tipo de vínculo trabalhista mais recente do carreteiro: CLT/carteira assinada, autônomo, agregado, TAC. Só preenche se explicitamente mencionado.", tipoDado: "texto" },
    ];
    for (const hint of HINTS_ASSISTENTE) {
      if ((merged[hint.chave] === undefined || merged[hint.chave] === null) && !todosOsPendentes.find(p => p.chave === hint.chave)) {
        todosOsPendentes.push(hint as any);
      }
    }
  }

  if (todosOsPendentes.length > 0 && mensagemTemDados) {
    const textoParaExtrair = history
      .slice(-16)
      .map((m) => `${m.direcao === "out" ? "Bot" : "Cliente"}: ${m.conteudo ?? ""}`)
      .filter((l) => l.length > 6)
      .join("\n");
    const extracted = await extractQualificacaoData(projetoId, textoParaExtrair || `Cliente: ${text ?? ""}`, todosOsPendentes, merged).catch(() => null);
    if (extracted) {
      const novos: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(extracted)) {
        if (v !== null && v !== undefined && (merged[k] === undefined || merged[k] === null)) {
          merged[k] = v;
          novos[k] = v;
        }
      }
      if (Object.keys(novos).length > 0) {
        await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
        prisma.crmNota.create({
          data: { dealId: deal.id, conteudo: `[IA] Qualificação:\n${Object.entries(novos).map(([k, v]) => `${k}: ${v}`).join("\n")}` },
        }).catch(() => {});
        if (novos.nome && typeof novos.nome === "string") {
          const nomeCapturado = novos.nome.trim();
          await prisma.crmContato.update({ where: { id: contato.id }, data: { nome: nomeCapturado } });
          await prisma.crmDeal.update({ where: { id: deal.id }, data: { titulo: nomeCapturado } });
          contato = { ...contato, nome: nomeCapturado };
        }
        // Sync redundant field pairs: empresa_recente → empresa_principal, frota_recente → frota
        const syncMap: Array<[string, string]> = [
          ["empresa_recente", "empresa_principal"],
          ["frota_recente", "frota"],
        ];
        for (const [src, dst] of syncMap) {
          if (merged[src] && !merged[dst]) {
            merged[dst] = merged[src];
            await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
          }
        }
      }
    }
  }

  // 7a2. Document field extraction — usa docJsonDireto (Groq Vision JSON) que já vem com
  //      campos corretamente mapeados pelo rótulo visual no documento.
  //      Também limpa CPF inválido que possa estar em merged de extração anterior.
  if (documentosEnviados) {
    // Limpar CPF inválido salvo anteriormente (de extrações erradas antes desta fix)
    if (merged.cpf && typeof merged.cpf === "string" && !validarCPF(merged.cpf as string)) {
      console.warn(`[DocExtract] CPF em merged inválido ("${merged.cpf}") — limpando`);
      delete merged.cpf;
    }

    if (docJsonDireto && docJsonDireto.tipo_documento !== "OUTRO") {
      try {
        // Guardar tipo e subtipo do documento para uso no system prompt
        merged._ultimo_doc_tipo   = docJsonDireto.tipo_documento;
        merged._ultimo_doc_subtipo = docJsonDireto.subtipo ?? null;

        // Validação matemática de CPF — detecta CPF/RG invertidos
        let cpfExtraido = docJsonDireto.cpf ?? null;
        let rgExtraido  = docJsonDireto.rg  ?? null;

        if (cpfExtraido && !validarCPF(cpfExtraido)) {
          if (rgExtraido && validarCPF(rgExtraido)) {
            console.warn(`[DocExtract] CPF inválido ("${cpfExtraido}") e RG parece CPF válido ("${rgExtraido}") — invertendo`);
            [cpfExtraido, rgExtraido] = [rgExtraido, cpfExtraido];
            docJsonDireto.cpf = cpfExtraido;
            docJsonDireto.rg  = rgExtraido;
          } else {
            console.warn(`[DocExtract] CPF extraído inválido: "${cpfExtraido}" — descartando`);
            cpfExtraido = null;
            docJsonDireto.cpf = null;
          }
        }

        // Campos que SEMPRE sobrescrevem quando vêm de extração confiável (CNH_E ou CNH_FOTO).
        // Isso corrige dados errados de extrações anteriores (ex: RG errado de run antes da fix).
        const isCnhConfiavel = docJsonDireto.subtipo === "CNH_E" || docJsonDireto.subtipo === "CNH_FOTO";
        const camposSempre = isCnhConfiavel
          ? new Set(["rg", "orgao_emissor_rg", "uf_emissor_rg", "nome", "data_nascimento", "local_nascimento", "filiacao_pai", "filiacao_mae"])
          : new Set<string>();

        // Campos de endereço do comprovante sempre sobrescrevem (mais confiável que o auto-declarado)
        const isComprovante = docJsonDireto.tipo_documento === "COMPROVANTE_ENDERECO";
        const camposEndereco = new Set(["endereco", "bairro", "cidade", "uf", "cep"]);

        const novosDocFields: Record<string, unknown> = {};
        const todosCampos = [
          "rg", "orgao_emissor_rg", "uf_emissor_rg", "cpf", "nome",
          "data_nascimento", "local_nascimento", "naturalidade",
          "filiacao_pai", "filiacao_mae",
          "pis", "numero_ctps", "serie_ctps",
          "endereco", "bairro", "cidade", "uf", "cep",
          "estado_civil", "regime_bens",
        ] as const;

        for (const campo of todosCampos) {
          const val = (docJsonDireto as Record<string, unknown>)[campo];
          if (val) {
            // CPF: sempre sobrescreve se matematicamente válido
            if (campo === "cpf" && validarCPF(val as string)) {
              if (merged.cpf !== val) {
                merged.cpf = val;
                novosDocFields.cpf = val;
              }
            } else if (camposSempre.has(campo) || (isComprovante && camposEndereco.has(campo))) {
              // CNH_E: campos de identidade sempre sobrescrevem
              // COMPROVANTE_ENDERECO: campos de endereço sempre sobrescrevem (corrige cidade auto-declarada errada)
              if (merged[campo] !== val) {
                merged[campo] = val;
                novosDocFields[campo] = val;
              }
            } else if (!merged[campo]) {
              merged[campo] = val;
              novosDocFields[campo] = val;
            }
          }
        }

        if (Object.keys(novosDocFields).length > 0) {
          await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
          prisma.crmNota.create({
            data: { dealId: deal.id, conteudo: `[IA] Dados do documento (${docJsonDireto.tipo_documento}):\n${Object.entries(novosDocFields).map(([k, v]) => `${k}: ${v}`).join("\n")}` },
          }).catch(() => {});
          console.log(`[DocExtract] tipo=${docJsonDireto.tipo_documento} campos salvos: ${Object.keys(novosDocFields).join(", ")}`);
        } else {
          console.log(`[DocExtract] tipo=${docJsonDireto.tipo_documento} — nenhum campo novo`);
        }
      } catch (e: any) {
        console.warn(`[DocExtract] Falha ao salvar campos: ${e?.message}`);
      }
    } else {
      console.log(`[DocExtract] docJsonDireto=${docJsonDireto?.tipo_documento ?? "null"} — ignorado`);
    }
  }

  // 7b. Vinculos array loop — collect all employment links within the 2-year prescription window.
  //
  //  Prescription rule (CLT art. 11):
  //  - Worker has 2 years from termination to file. Can recover up to 5 years back.
  //  - If the MOST RECENT job is prescribed (> 2 years ago), ALL previous ones are too
  //    (they were terminated even earlier). No point investigating anteriores.
  //  - If most recent is within 2 years, keep asking about previous jobs until one is outside
  //    the 2-year window or the person confirms there are no more.
  //
  //  State stored in qualificacao:
  //    vinculos[]              — array of collected employment objects
  //    _vinculos_ok            — true when the loop is finished (all within 2y collected)
  //    _vinculos_todos_prescritos — true when even the most recent job is prescribed

  let vinculos: VinculoEmprego[] = Array.isArray(merged.vinculos)
    ? (merged.vinculos as VinculoEmprego[])
    : [];
  let vinculosOk              = merged._vinculos_ok === true;
  let vinculosTodosPrescritos = merged._vinculos_todos_prescritos === true;

  // If vinculos is empty but flat fields already have empresa info (collected via pre-vinculos
  // extractQualificacaoData), seed vinculos[0] so the loop doesn't re-ask for the company.
  if (vinculos.length === 0 && !vinculosOk && !vinculosTodosPrescritos) {
    const empresaSeed = (merged.empresa_principal ?? merged.empresa_recente) as string | undefined;
    if (empresaSeed) {
      const seeded: VinculoEmprego = {
        ordem: 1,
        empresa: empresaSeed,
        funcao:         (merged.funcao_recente as string | undefined)   ?? undefined,
        vinculo:        (merged.vinculo_recente as string | undefined)  ?? undefined,
        saida:          (merged.saida_recente as string | undefined)    ?? undefined,
        tempo:          (merged.tempo_recente as string | undefined)    ?? undefined,
        data_saida:     (merged.data_saida_recente as string | undefined) ?? undefined,
        horas_extras:   undefined,
        pagamento_fora: undefined,
        injustica:      undefined,
        frota:          merged.frota_recente != null
          ? String(merged.frota_recente)
          : merged.frota != null ? String(merged.frota) : undefined,
      };
      merged.vinculos = [seeded];
      vinculos = [seeded];
      prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }).catch(() => {});
      console.log(`[VinculosSeed] dealId=${deal.id} semeou vinculos[0] a partir dos campos planos: empresa=${empresaSeed}`);
    }
  }

  // Sync flat merged fields → vinculos entries to avoid re-asking already-answered questions.
  // Runs on every turn so incremental flat-field updates are always reflected.
  if (vinculos.length > 0 && !vinculosOk) {
    const sync = syncVinculosFromFlat(vinculos, merged);
    if (sync.changed) {
      vinculos = sync.vinculos;
      merged.vinculos = vinculos;
      prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }).catch(() => {});
      console.log(`[VinculosSync] dealId=${deal.id} campos planos → vinculos sincronizados`);
    }
  }

  if (!vinculosOk && text) {
    try {
      const historiaTexto = history
        .slice(-20)
        .map((m) => `${m.direcao === "out" ? "Ana" : "Cliente"}: ${m.conteudo ?? ""}`)
        .join("\n");

      // semMaisEmpregos only valid when bot explicitly asked about previous employers in last message
      const ultimaMsgBot = history.filter(m => m.direcao === "out").slice(-1)[0]?.conteudo ?? "";
      const maisEmpregosPerguntado = /outro lugar|outra empresa|mais emprego|trabalhou antes|emprego anterior|antes dis[st]/i.test(ultimaMsgBot);

      const extraido = await tryExtractVinculo(projetoId, text, vinculos, historiaTexto, merged._mais_empregos_confirmado === true, maisEmpregosPerguntado);

      console.log(`[VinculosLoop] dealId=${deal.id} result: semMaisEmpregos=${extraido.semMaisEmpregos} novoVinculo=${extraido.vinculo?.empresa ?? "null"} updatedCount=${extraido.updatedVinculos.length} vinculosBefore=${vinculos.length} vinculos=${JSON.stringify(extraido.updatedVinculos.map(v => ({ empresa: v.empresa, faltando: ["empresa","funcao","vinculo","saida","horas_extras","pagamento_fora","injustica"].filter(k => !v[k as keyof typeof v]) })))}`);

      // 1. Apply enrichments to existing vinculos (fields filled in by LLM from history)
      const vinculosEnriquecidos = extraido.updatedVinculos;
      const foiEnriquecido = JSON.stringify(vinculosEnriquecidos) !== JSON.stringify(vinculos);
      if (foiEnriquecido) {
        merged.vinculos = vinculosEnriquecidos;
        prisma.crmNota.create({
          data: {
            dealId: deal.id,
            conteudo: `[IA] Vínculos enriquecidos com dados da conversa: ${vinculosEnriquecidos.map((v) => v.empresa ?? "?").join(", ")}`,
          },
        }).catch(() => {});
      }

      // Use the enriched array going forward
      const vinculosAtuais = vinculosEnriquecidos;

      // Helper: check if all required fields are filled for all collected vinculos
      const CAMPOS_REQ: Array<keyof VinculoEmprego> = ["empresa", "funcao", "vinculo", "saida", "horas_extras", "pagamento_fora", "injustica"];
      const todosVinculosCompletos = (arr: VinculoEmprego[]) =>
        arr.length > 0 && arr.every(v => CAMPOS_REQ.every(k => v[k] !== undefined && v[k] !== null && v[k] !== ""));

      if (extraido.semMaisEmpregos) {
        // Person confirmed no more jobs — only close loop if all fields are complete
        if (todosVinculosCompletos(vinculosAtuais)) {
          // 24-month rule: if the most recent job lasted < 24 months, a previous employer
          // may still be within the 2-year prescription window (Art. 11 CLT) and must be investigated
          const v0 = vinculosAtuais[0];
          const parseMesesTempo = (s: string): number => {
            let t = 0;
            const ma = s.match(/(\d+)\s*an/i); if (ma) t += parseInt(ma[1]) * 12;
            const mm = s.match(/(\d+)\s*m[eê]/i); if (mm) t += parseInt(mm[1]);
            return t;
          };
          const tempoMeses: number =
            ((v0 as any).tempo_meses_estimado as number | undefined) ??
            (v0?.tempo ? parseMesesTempo(v0.tempo) : 0);
          const deveInvestigarAnterior = tempoMeses > 0 && tempoMeses < 24 && !maisEmpregosPerguntado;
          if (deveInvestigarAnterior) {
            console.log(`[VinculosLoop] dealId=${deal.id} semMaisEmpregos bloqueado — ${tempoMeses}m < 24m → forçar pergunta mais_empregos`);
          } else {
            merged._vinculos_ok = true;
          }
        }
        // If fields are missing or 24-month gate fired, keep _vinculos_ok false so Ana keeps collecting
        merged.vinculos = vinculosAtuais;
        await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
      } else if (extraido.vinculo) {
        const dentroPrazo = await checkVinculoPrazo(projetoId, extraido.vinculo);

        if (!dentroPrazo) {
          if (vinculosAtuais.length === 0) {
            // First (most recent) job is already prescribed → ALL are → end
            merged._vinculos_ok = true;
            merged._vinculos_todos_prescritos = true;
          } else {
            // A subsequent job is outside the window → 2-year boundary reached
            // Only close if all collected vinculos are complete
            if (todosVinculosCompletos(vinculosAtuais)) {
              merged._vinculos_ok = true;
            }
          }
          merged.vinculos = vinculosAtuais;
        } else {
          // Within 2 years — add to array and keep asking
          vinculosAtuais.push({ ...extraido.vinculo, ordem: vinculosAtuais.length + 1 });
          merged.vinculos = vinculosAtuais;
          delete merged._mais_empregos_confirmado; // new vínculo added — clear "waiting for empresa" flag
          prisma.crmNota.create({
            data: {
              dealId: deal.id,
              conteudo: `[IA] Vínculo ${vinculosAtuais.length}: ${extraido.vinculo.empresa ?? "?"} — ${extraido.vinculo.funcao ?? "?"} — saída: ${extraido.vinculo.saida ?? extraido.vinculo.data_saida ?? "?"}`,
            },
          }).catch(() => {});
        }
        await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
      } else if (extraido.confirmouMaisEmpregos && !extraido.semMaisEmpregos) {
        // User confirmed there are more employers but didn't name the company yet
        merged._mais_empregos_confirmado = true;
        merged.vinculos = vinculosAtuais;
        await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
        console.log(`[VinculosLoop] dealId=${deal.id} confirmou mais empregos — aguardando nome da empresa`);
      } else if (foiEnriquecido) {
        // No new vínculo and no semMaisEmpregos signal, but existing vinculos were enriched.
        // If vinculos[0] now has data_saida, run prescricao check retroactively.
        const v0 = vinculosAtuais[0];
        if (v0?.data_saida && !vinculosOk && !merged._vinculos_todos_prescritos) {
          const dentroPrazaEnriq = await checkVinculoPrazo(projetoId, v0);
          if (!dentroPrazaEnriq) {
            merged._vinculos_ok = true;
            merged._vinculos_todos_prescritos = true;
            console.log(`[VinculosLoop] dealId=${deal.id} data_saida enriquecida → prescrito`);
          }
        }
        await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
      }
    } catch (err: any) {
      console.warn("[VinculosLoop] Erro na extração de vínculos — Ana responde normalmente sem atualizar vínculos:", err?.message ?? err);
      // Non-blocking: extraction failure does not abort the response
    }

    // Refresh local vars from merged (extraction may have updated merged.vinculos / flags)
    vinculos = Array.isArray(merged.vinculos) ? (merged.vinculos as VinculoEmprego[]) : vinculos;
    vinculosOk = merged._vinculos_ok === true;
    vinculosTodosPrescritos = merged._vinculos_todos_prescritos === true;
  }

  // 7c. Sync vinculos[] → flat fields once the vinculos loop is done.
  //     vinculos[0] = emprego mais recente → campos *_recente
  //     vinculos[1] = emprego anterior      → campos emprego_anterior_*
  //     This ensures the flat qualification fields are populated for reporting/filtering,
  //     even though the actual data lives in vinculos[].
  if (merged._vinculos_ok === true && vinculos.length > 0) {
    const v0 = vinculos[0];
    const v1 = vinculos[1];
    const syncFlat: Record<string, unknown> = {};

    if (v0) {
      if (!merged.empresa_recente && v0.empresa)         syncFlat.empresa_recente         = v0.empresa;
      if (!merged.funcao_recente  && v0.funcao)          syncFlat.funcao_recente          = v0.funcao;
      if (!merged.vinculo_recente && v0.vinculo)         syncFlat.vinculo_recente         = v0.vinculo;
      if (!merged.tempo_recente   && v0.tempo)           syncFlat.tempo_recente           = v0.tempo;
      if (!merged.saida_recente   && (v0.saida ?? v0.data_saida)) syncFlat.saida_recente  = v0.saida ?? v0.data_saida;
      if (!merged.frota_recente   && v0.frota)           syncFlat.frota_recente           = v0.frota;
      const isNull = (x: unknown) => x === undefined || x === null;
      if (isNull(merged.horas_extras_recentes)   && !isNull(v0.horas_extras))     syncFlat.horas_extras_recentes   = v0.horas_extras;
      if (isNull(merged.pagamento_fora_recente)  && !isNull(v0.pagamento_fora))   syncFlat.pagamento_fora_recente  = v0.pagamento_fora;
      if (isNull(merged.injustica_recente)       && !isNull(v0.injustica))        syncFlat.injustica_recente       = v0.injustica;
    }
    if (v1) {
      const isNull = (x: unknown) => x === undefined || x === null;
      if (isNull(merged.emprego_anterior_empresa)        && v1.empresa)              syncFlat.emprego_anterior_empresa        = v1.empresa;
      if (isNull(merged.emprego_anterior_funcao)         && v1.funcao)               syncFlat.emprego_anterior_funcao         = v1.funcao;
      if (isNull(merged.emprego_anterior_vinculo)        && v1.vinculo)              syncFlat.emprego_anterior_vinculo        = v1.vinculo;
      if (isNull(merged.emprego_anterior_tempo)          && v1.tempo)                syncFlat.emprego_anterior_tempo          = v1.tempo;
      if (isNull(merged.emprego_anterior_saida)          && (v1.saida ?? v1.data_saida)) syncFlat.emprego_anterior_saida      = v1.saida ?? v1.data_saida;
      if (isNull(merged.emprego_anterior_horas_extras)   && !isNull(v1.horas_extras))   syncFlat.emprego_anterior_horas_extras   = v1.horas_extras;
      if (isNull(merged.emprego_anterior_pagamento_fora) && !isNull(v1.pagamento_fora)) syncFlat.emprego_anterior_pagamento_fora = v1.pagamento_fora;
      if (isNull(merged.emprego_anterior_injustica)      && v1.injustica)               syncFlat.emprego_anterior_injustica      = v1.injustica;
    }

    if (Object.keys(syncFlat).length > 0) {
      Object.assign(merged, syncFlat);
      await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
      prisma.crmNota.create({
        data: { dealId: deal.id, conteudo: `[IA] Sync vínculos→flat:\n${Object.entries(syncFlat).map(([k, v]) => `${k}: ${v}`).join("\n")}` },
      }).catch(() => {});
    }
  }

  // 7d. Load qualificacao_completa transition rule (used for allAnswered check and prescription gate)
  const regraQualificacao = await prisma.iaRegraTransicao.findFirst({
    where: { projetoId, stageOrigemChave: stageChave, condicao: "qualificacao_completa" },
  });

  // 7d2. Load empresas bloqueadas and compute deterministic next question (must be before allAnswered)
  const empresasBloqueadasConfig = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, chave: "empresas_bloqueadas" },
  });
  const empresasBloqueadas: string[] = empresasBloqueadasConfig?.valor
    ? empresasBloqueadasConfig.valor.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  // Load collection mode — default "sequencial" (existing behavior)
  const modoColetaConf = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId, categoria: "comportamento", chave: "modo_coleta" },
  });
  const modoColeta: "sequencial" | "conversacional" =
    modoColetaConf?.valor === "conversacional" ? "conversacional" : "sequencial";

  const outgoingCount = history.filter(m => m.direcao === "out").length;
  let nextQDeterministico: string | null = null;
  let conversationalResult: import("./conversational-router.js").ConversationalResult | null = null;
  let advFlowStepType: string | null = null;
  let advFlowNextStepChave: string | null = null;
  if (personaChave === "assistente") {
    if (modoColeta === "conversacional") {
      const { getConversationalSystemInstructions } = await import("./conversational-router.js");
      conversationalResult = await getConversationalSystemInstructions(
        projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount,
      );
    } else {
      nextQDeterministico = await getNextDeterministicQuestion(projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount);
    }
  } else if (personaChave === "advogado" && deal.iaAtiva) {
    const { handleAdvogadoFlow } = await import("./flow-controller.js");
    const advFlow = await handleAdvogadoFlow(
      projetoId,
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
      text ?? "",
      outgoingCount,
    );
    nextQDeterministico = advFlow.nextQuestion;
    advFlowStepType = advFlow.stepType ?? null;
    advFlowNextStepChave = advFlow.nextStepChave ?? null;
  }

  // 7d3. allAnswered: flow controller is sole source of truth.
  //      If it has no more questions AND vinculos loop is done, qualification is complete.
  const perguntasPendentes = perguntas.filter((p) => merged[p.chave] === undefined || merged[p.chave] === null);
  const allAnswered = personaChave === "assistente" &&
    (modoColeta === "conversacional"
      ? conversationalResult?.isDone === true
      : nextQDeterministico === null
    ) &&
    (merged._vinculos_ok === true);

  // 7e. Detect client insisting on a phone call → notify SDR/Closer via WhatsApp
  //     Keywords come from IaProjetoConfig (categoria: "comportamento", chave: "solicita_ligacao_palavras")
  //     Value: comma-separated list of phrases. Configurable in Config IA > Comportamento.
  if (text) {
    const DEFAULT_LIGACAO_PALAVRAS = "me liga,pode ligar,ligue pra mim,ligue para mim,quero ligacao,quero uma ligacao,preciso de ligacao,prefiro falar por telefone,falar por telefone,quando voces ligam,quando vocês ligam,aguardando a ligacao,espero a ligacao,manda o telefone,qual o telefone,numero de telefone";

    // Load from DB (upsert default on first access so it appears in the UI)
    let ligacaoPalavrasConfig = await prisma.iaProjetoConfig.findFirst({
      where: { projetoId, categoria: "comportamento", chave: "solicita_ligacao_palavras" },
    });
    if (!ligacaoPalavrasConfig) {
      ligacaoPalavrasConfig = await prisma.iaProjetoConfig.create({
        data: {
          projetoId,
          categoria: "comportamento",
          chave: "solicita_ligacao_palavras",
          valor: DEFAULT_LIGACAO_PALAVRAS,
        },
      }).catch(() => null);
    }

    const palavras = (ligacaoPalavrasConfig?.valor ?? DEFAULT_LIGACAO_PALAVRAS)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const normalizado = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const pedidoLigacao = palavras.some((p) => {
      const pNorm = p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return normalizado.includes(pNorm);
    });

    if (pedidoLigacao) {
      // Cooldown: notify at most once every 2 hours per deal
      const ultimaNotif = merged._notif_ligacao_at as string | undefined;
      const cooldownMs = 2 * 60 * 60 * 1000;
      const devNotificar = !ultimaNotif || (Date.now() - new Date(ultimaNotif).getTime() > cooldownMs);

      if (devNotificar) {
        const nomeCliente = String(merged.nome ?? contato.nome ?? "");
        const empresa = String(merged.empresa_recente ?? (Array.isArray(merged.vinculos) && (merged.vinculos as any[])[0]?.empresa) ?? "");
        const cidade = String(merged.cidade ?? "");
        dispararNotificacoes(projetoId, "solicita_ligacao", {
          nome:     nomeCliente,
          telefone: phone,
          empresa,
          cidade,
          stage:    stageChave,
          mensagem: text,
        }).catch(() => {});

        merged._notif_ligacao_at = new Date().toISOString();
        prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }).catch(() => {});
        console.log(`[StageEngine] Cliente ${phone} pediu ligação — notificação disparada`);
      }
    }
  }

  // 8. Build system prompt
  const INSTRUCAO_BASE = buildInstrucaoBase();
  let userSystem = persona.systemPrompt
    .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
    .replace(/\{nome_persona\}/g, persona.nomeExibicao);
  // Garante injeção mesmo quando o placeholder não existe na persona do DB
  if (!userSystem.includes("DATA E HORA ATUAL")) {
    userSystem = INSTRUCAO_BASE + "\n\n" + userSystem;
  }

  // REGRA GLOBAL — nunca incluir nome no início da mensagem
  userSystem +=
    `\n\nREGRA — IDENTIDADE: Você é ${persona.nomeExibicao}. NUNCA escreva seu nome no início da resposta.` +
    ` Escreva APENAS o conteúdo da mensagem, sem nenhum cabeçalho, sem nome, sem asteriscos.`;

  // Ana-specific: perguntar mais, responder menos, não pular fases
  if (personaChave === "assistente") {
    if (modoColeta === "conversacional") {
      userSystem +=
        `\n\nINSTRUÇÕES PARA ANA — MODO CONVERSACIONAL:` +
        `\n- Você pode combinar 2-3 campos RELACIONADOS em UMA única mensagem natural (ex: empresa + tipo de contrato + função num só turno).` +
        `\n- Máximo 3 frases curtas por mensagem. Seja direta — não escreva parágrafos.` +
        `\n- PROIBIDO usar "Entendi", "Certo", "Ok", "Que situação", "Que bom" ou qualquer validação. Só as perguntas.` +
        `\n- PROIBIDO soar como formulário. Fale como pessoa real do escritório.` +
        `\n- Se o cliente já respondeu um campo espontaneamente, NÃO repita a pergunta — prossiga para o próximo.` +
        `\n- REGRA DO CAMINHÃO: SÓ pergunte sobre caminhão se o cliente for autônomo/agregado/TAC. CLT → pule direto para horas extras.` +
        `\n- REGRA DE ENCERRAMENTO: PROIBIDO dizer "Anotei tudo" ou "Vou passar pro time" enquanto houver CAMPO A COLETAR listado neste prompt.` +
        `\n- EMPREGOS ANTERIORES: Se o emprego mais recente durou MENOS de 2 anos OU o cliente saiu há menos de 2 anos, OBRIGATÓRIO perguntar sobre empregos anteriores antes de encerrar.` +
        `\n- EXCEÇÃO DE FRUSTRAÇÃO: Se o cliente reclamar de perguntas repetidas, faça: 1 frase de desculpa + campo pendente. Ex: "Peço desculpas! [pergunta]".`;
    } else {
      userSystem +=
        `\n\nINSTRUÇÕES CRÍTICAS PARA ANA — SIGA RIGOROSAMENTE:` +
        `\n- MENSAGEM = 1 PERGUNTA APENAS. Nada mais.` +
        `\n- TAMANHO MÁXIMO: 1 frase curta de no máximo 15 palavras.` +
        `\n- PROIBIDO resumir, repetir ou comentar o que o cliente disse. Vá direto à próxima pergunta.` +
        `\n- PROIBIDO usar "Entendi", "Certo", "Ok", "Que situação difícil", "Isso é importante" ou qualquer frase de validação. Só a pergunta.` +
        `\n- PROIBIDO explicar por que está perguntando ou dar contexto jurídico.` +
        `\n- EXEMPLO CORRETO: "Recebia algum valor fora do holerite, como Pamcard ou dinheiro?"` +
        `\n- EXEMPLO ERRADO: "Entendi. Isso significa que você trabalhava muitas horas. Recebia algum valor fora do holerite?"` +
        `\n- Siga RIGOROSAMENTE a ordem das perguntas de qualificação. NUNCA pule etapas.` +
        `\n- REGRA DO CAMINHÃO: A pergunta "O caminhão era seu ou da empresa?" SÓ pode ser feita se o cliente disse ser autônomo, agregado ou TAC. Se o cliente mencionou CLT, carteira assinada, ou sem registro formal — PROIBIDO perguntar sobre caminhão. Para CLT, pule direto para horas extras.` +
        `\n- REGRA DE ENCERRAMENTO: PROIBIDO dizer "Anotei tudo" ou "Vou passar pro time" enquanto houver uma PERGUNTA OBRIGATÓRIA neste prompt. Só encerre quando não houver mais PERGUNTA OBRIGATÓRIA A FAZER AGORA.` +
        `\n- EMPREGOS ANTERIORES: Se o emprego mais recente durou MENOS de 2 anos OU se o cliente saiu há menos de 2 anos, OBRIGATÓRIO perguntar sobre empregos anteriores antes de encerrar.` +
        `\n- EXCEÇÃO DE FRUSTRAÇÃO: Se o cliente reclamar especificamente de PERGUNTAS REPETIDAS ou idiota (ex: "pergunta idiota", "você já me perguntou isso", "por que fica repetindo", "já disse isso"), faça APENAS: 1 frase curta pedindo desculpas + a pergunta obrigatória pendente. Ex: "Peço desculpas! [pergunta]". ATENÇÃO: Se o cliente perguntar sobre outra pessoa (ex: "cadê a Daniela?", "quem vai me atender?") ou sobre o processo em geral — responda a pergunta dele normalmente, NÃO trate como frustração.`;
    }
  }

  // REGRA GLOBAL — links nunca devem aparecer nas respostas do LLM.
  // Links de proposta, contrato e procuração são enviados automaticamente
  // pelo sistema como mensagens separadas após o LLM responder.
  // Se o cliente pedir para reenviar links, a IA deve dizer que o sistema
  // vai enviar novamente em instantes — nunca fabricar ou incluir URLs.
  userSystem +=
    `\n\nREGRA ABSOLUTA — LINKS: Nunca inclua links, URLs ou placeholders de link` +
    ` (como "[LINK AQUI]", "[URL]", etc.) em nenhuma resposta.` +
    ` Links de assinatura, contrato e procuração são enviados automaticamente pelo sistema em mensagens separadas.` +
    ` Se o cliente pedir para reenviar links, diga apenas: "Vou solicitar que o sistema reenvie agora, aguarde um instante."`;

  // When the client just sent a document (CNH, CTPS, etc.), guide the LLM precisely.
  // Build dynamic instruction based on what was actually extracted — avoids hallucinated placeholders.
  if (documentosEnviados) {
    // Detectar tipo de documento pelo que foi extraído
    const tipoDoc = (merged._ultimo_doc_tipo as string | undefined) || null;
    const isEndereco = tipoDoc === "COMPROVANTE_ENDERECO";
    const isCtps     = tipoDoc === "CTPS";

    // CRÍTICO: o link de assinatura é enviado automaticamente pelo sistema
    // em mensagens separadas logo após. O LLM NUNCA deve incluir links na resposta.
    const instrucaoLink =
      `\nIMPORTANTE: O link de assinatura do contrato e da procuração será enviado AUTOMATICAMENTE` +
      ` pelo sistema na próxima mensagem. NÃO inclua nenhum link, URL ou placeholder de link na sua resposta.` +
      ` Diga apenas que o contrato e a procuração serão enviados em instantes.`;

    if (isEndereco) {
      // Comprovante de endereço
      const endExtraido = (merged.endereco as string | undefined) || null;
      const cidadeExtraida = (merged.cidade as string | undefined) || null;
      const extraidos = [
        endExtraido   ? `endereço: ${endExtraido}` : null,
        cidadeExtraida ? `cidade: ${cidadeExtraida}` : null,
      ].filter(Boolean) as string[];

      if (extraidos.length > 0) {
        userSystem +=
          `\n\nCOMPROVANTE DE ENDEREÇO recebido — dados extraídos: ${extraidos.join(", ")}.` +
          `\nAgradeça o envio e confirme o endereço com o cliente.` +
          instrucaoLink;
      } else {
        userSystem +=
          `\n\nCOMPROVANTE DE ENDEREÇO recebido — não conseguimos ler o endereço automaticamente.` +
          `\nAgradeça o envio e peça que o cliente informe o endereço completo com CEP.` +
          instrucaoLink;
      }
    } else if (isCtps) {
      // CTPS digital
      const pisExtraido = (merged.pis as string | undefined) || null;
      const nomeExtraido = (merged.nome as string | undefined) || null;
      const extraidos = [
        nomeExtraido ? `nome: ${nomeExtraido}` : null,
        pisExtraido  ? `PIS/NIS: ${pisExtraido}` : null,
      ].filter(Boolean) as string[];

      if (extraidos.length > 0) {
        userSystem +=
          `\n\nCTPS recebida — dados extraídos: ${extraidos.join(", ")}.` +
          `\nAgradeça o envio e confirme os dados.` +
          instrucaoLink;
      } else {
        userSystem +=
          `\n\nCTPS recebida — não conseguimos ler os dados automaticamente.` +
          `\nAgradeça o envio e continue o atendimento normalmente.` +
          instrucaoLink;
      }
    } else {
      // CNH ou RG — fluxo principal de identidade
      const docNome  = (merged.nome  as string | undefined) || null;
      const docCpf   = (merged.cpf   as string | undefined) || null;
      const docRg    = (merged.rg    as string | undefined) || null;
      const docOrgao = (merged.orgao_emissor_rg as string | undefined) || null;
      const docSubtipo = (merged._ultimo_doc_subtipo as string | undefined) || null;

      // Rótulo do tipo de documento para o LLM
      const rotuloDoc = docSubtipo === "CNH_E"
        ? "CNH-e digital (documento Gov.br)"
        : docSubtipo === "CNH_FOTO"
        ? "foto da CNH física"
        : "documento de identidade";

      const extraidos = [
        docNome  ? `nome: ${docNome}`   : null,
        docCpf   ? `CPF: ${docCpf}`    : null,
        docRg    ? `RG: ${docRg}${docOrgao ? ` ${docOrgao}` : ""}` : null,
      ].filter(Boolean) as string[];

      const faltando = [
        !docNome ? "nome completo"                                  : null,
        !docCpf  ? "CPF"                                           : null,
        !docRg   ? "RG (número de identidade, não de habilitação)" : null,
      ].filter(Boolean) as string[];

      // Proibição absoluta de linguagem técnica — vale para TODOS os casos (com ou sem dados)
      const proibicaoTecnica =
        `\nREGRA ABSOLUTA DE LINGUAGEM: JAMAIS use as palavras "sistema", "extração", "leitura automática",` +
        ` "não consegui", "não foi possível", "erro", "falha" ou qualquer palavra técnica.` +
        ` JAMAIS peça que o cliente "digite" — use "pode me confirmar", "qual é seu", "me fala".` +
        ` Fale como uma atendente humana que está olhando o documento na tela.`;

      if (extraidos.length > 0) {
        userSystem +=
          `\n\n${rotuloDoc.toUpperCase()} recebido — dados confirmados: ${extraidos.join(", ")}.` +
          `\nAgradeça o envio de forma natural e confirme exatamente estes dados com o cliente.` +
          (faltando.length
            ? `\nPreciso ainda de: ${faltando.join(", ")}. Peça de forma conversacional e natural.`
            : "") +
          `\nNÃO mencione nem peça: número de registro CNH, categoria (A/B/C/D/E), validade da CNH, foto do verso da CNH.` +
          `\nA frente da CNH já contém todos os dados necessários — não há informação adicional no verso.` +
          proibicaoTecnica +
          instrucaoLink;
      } else {
        userSystem +=
          `\n\n${rotuloDoc.toUpperCase()} recebido.` +
          `\nAgradeça o envio de forma natural. Em seguida, peça de forma conversacional o CPF e o RG.` +
          `\nExemplo de resposta natural: "Recebi sua CNH! Pode me confirmar seu CPF e o número do RG para fecharmos o contrato?"` +
          `\nNÃO mencione nem peça: número de registro CNH, categoria, validade da habilitação, foto do verso da CNH.` +
          `\nA frente da CNH já contém todos os dados necessários.` +
          proibicaoTecnica +
          instrucaoLink;
      }
    }
  }

  // Show pending basic questions (interest, contact time, etc.)
  if (perguntasPendentes.length > 0 && !vinculosTodosPrescritos) {
    const questCtx = perguntasPendentes
      .slice(0, 2)
      .map((p) => `- ${p.perguntaContexto}${p.exemploAbordagem ? ` (ex: ${p.exemploAbordagem})` : ""}`)
      .join("\n");
    userSystem += `\n\nINFORMAÇÕES AINDA NÃO COLETADAS:\n${questCtx}`;
  }

  // Vinculos collection state context — drives what Ana asks next
  if (!vinculosOk && !vinculosTodosPrescritos && vinculos.length > 0) {
    // Build a detailed view of each vínculo showing which fields are still missing
    const CAMPOS_OBRIGATORIOS: Array<{ key: keyof typeof vinculos[0]; label: string }> = [
      { key: "empresa",        label: "empresa" },
      { key: "funcao",         label: "função" },
      { key: "vinculo",        label: "tipo de vínculo (CLT/autônomo/avulso)" },
      { key: "saida",          label: "como e quando saiu (ou se ainda está empregado)" },
      { key: "horas_extras",   label: "se havia horas extras não pagas" },
      { key: "pagamento_fora", label: "se recebia valor fora do holerite (Pamcard, Pix, dinheiro)" },
      { key: "injustica",      label: "irregularidades sofridas (pressão, desconto, jornada excessiva)" },
    ];

    const listaDetalhada = vinculos.map((v, i) => {
      const faltando = CAMPOS_OBRIGATORIOS.filter(c => !v[c.key]).map(c => c.label);
      const status = faltando.length === 0 ? "✓ completo" : `FALTANDO: ${faltando.join(", ")}`;
      return `  ${i + 1}. ${v.empresa ?? "?"} (${v.funcao ?? "?"}) — ${status}`;
    }).join("\n");

    userSystem += `\n\nCOLETA DE VÍNCULOS TRABALHISTAS — REGRA ABSOLUTA: NÃO avance para "tem mais empregos?" enquanto houver campos faltando em qualquer vínculo.\nVínculos registrados (${vinculos.length}):\n${listaDetalhada}`;
  }

  // Show next question / collection instruction in system prompt
  if (modoColeta === "conversacional" && conversationalResult && !conversationalResult.isDone) {
    userSystem += `\n\n${conversationalResult.systemSuffix}\nVEJA OS "DADOS BÁSICOS COLETADOS" ABAIXO — se esse campo já está preenchido, NÃO repita a pergunta e passe para o próximo campo pendente.`;
  } else if (nextQDeterministico) {
    if (advFlowStepType === "llm_generated") {
      userSystem += `\n\n⚠️ TAREFA OBRIGATÓRIA AGORA — IGNORE QUALQUER OUTRA INSTRUÇÃO DE COLETA DE DADOS:\n${nextQDeterministico}\nElabore com base nos dados reais do lead. NÃO peça documentos, NÃO colete dados pessoais nesta resposta.`;
    } else {
      userSystem += `\n\nINFORMAÇÃO A COLETAR AGORA (formule a pergunta de forma natural e conversacional, verifique o histórico antes — se o cliente JÁ respondeu isso, pule e colete a próxima informação pendente): ${nextQDeterministico}`;
    }
  }

  if (vinculosOk && vinculos.length > 0) {
    userSystem += `\n\nVÍNCULOS COLETADOS (${vinculos.length}):\n${vinculos.map((v, i) => `${i + 1}. ${v.empresa ?? "?"} — ${v.funcao ?? "?"} — saída: ${v.saida ?? "?"}`).join("\n")}`;
  }

  if (vinculosTodosPrescritos) {
    userSystem += `\n\nATENÇÃO — PRAZO PRESCRICIONAL VENCIDO: O emprego mais recente do cliente foi encerrado há mais de 2 anos. Pelo art. 11 da CLT, o prazo de 2 anos para ajuizar ação trabalhista já expirou. Como o vínculo mais recente está prescrito, todos os anteriores também estão — foram encerrados ainda antes. Informe o cliente com empatia que, infelizmente, não é mais possível ajuizar ação referente a esses empregos. Encerre a conversa de forma acolhedora, sem prometer nada.`;
  }

  if (Object.keys(merged).filter(k => !k.startsWith("_") && k !== "vinculos").length > 0) {
    const dadosBasicos = Object.fromEntries(
      Object.entries(merged).filter(([k]) => !k.startsWith("_") && k !== "vinculos")
    );
    userSystem += `\n\nDADOS BÁSICOS COLETADOS:\n${JSON.stringify(dadosBasicos, null, 2)}`;

    // Se CPF já está confirmado em merged (válido matematicamente), instruir o LLM
    // a não questionar nem mencionar outras leituras do documento.
    const cpfConfirmado = typeof merged.cpf === "string" && validarCPF(merged.cpf as string)
      ? merged.cpf as string : null;
    if (cpfConfirmado) {
      userSystem +=
        `\n\nIMPORTANTE — CPF CONFIRMADO: O CPF do cliente é ${cpfConfirmado} (já registrado e validado).` +
        ` NÃO questione este CPF, NÃO mencione outros números que possam ter aparecido no documento.` +
        ` Trate este CPF como definitivo.`;
    }
  }

  const nomeInformado = typeof merged.nome === "string" ? merged.nome : null;
  if (nomeInformado) {
    userSystem += `\n\nNome do cliente: ${nomeInformado}`;
  }

  // Sprint 1: injeção de frustração no system prompt
  if (frustrationHandling?.injectIntoSystemPrompt) {
    userSystem += "\n\n" + frustrationHandling.injectIntoSystemPrompt;
  }

  // Sprint 3: handoff snapshot — injeta dados da Ana no prompt da Daniela em TODA chamada
  if (personaChave === "advogado") {
    const snapshot = buildHandoffSnapshot(merged);
    userSystem = snapshot + "\n\n" + userSystem;
  }

  // 9. Build LLM messages (Sprint 3: histórico limitado ao período da persona atual)
  const personaTrocadaEm = (deal as any).iaPersonaTrocadaEm as Date | null | undefined;
  let llmMensagensBase = history;
  if (personaChave === "advogado" && personaTrocadaEm) {
    llmMensagensBase = history.filter(m => m.enviadaEm >= personaTrocadaEm);
    if (llmMensagensBase.length === 0) llmMensagensBase = history.slice(-5);
  }
  const llmMessages = llmMensagensBase.map((m) => ({
    role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
    content: m.conteudo ?? "",
  }));

  // 10. Call LLM (up to 3 attempts to get humanized response)
  let resposta = "";
  try {
    for (let attempts = 0; attempts < 3; attempts++) {
      const result = await callLlm({
        projetoId,
        dealId: deal.id,
        systemPrompt: userSystem,
        messages: llmMessages,
        personaChave,
        personaLlmChave: (persona as any).llmProviderChave ?? null,
        stageChave,
        maxTokens: 2048,
      });
      resposta = result.content.trim();

      // Count sentences: split on . ! ? followed by space or end
      const sentencas = resposta.split(/[.!?](?:\s|$)/).filter(s => s.trim().length > 0).length;
      const muitoLonga = resposta.length > 420 || sentencas > 3;

      if (isHumanized(resposta) && !muitoLonga) break;

      llmMessages.push({ role: "assistant", content: resposta });
      if (muitoLonga) {
        llmMessages.push({ role: "user", content: "INSTRUÇÃO INTERNA: Mensagem longa demais. Reescreva em no máximo 2 frases curtas e simples. Mantenha apenas a pergunta principal." });
      } else {
        llmMessages.push({ role: "user", content: "INSTRUÇÃO INTERNA: Reescreva sem padrões robóticos." });
      }
    }
  } catch (err: any) {
    console.warn(`[StageEngine] Todos os LLMs falharam para deal ${deal.id} — agendando retry`);
    scheduleLlmRetry(projetoId, deal.id, phone);
    return;
  }

  if (!resposta) return;

  // 10b. Deterministic question override (assistente + advogado with flow controller)
  // Replaces LLM response with the exact next question from the deterministic flow.
  // Skipped for llm_generated steps — LLM elaborates the content, no hard override.
  // Skipped when frustration handling requests skipDeterministicOverride (ex: repeticao, demora).
  const shouldOverrideDeterministic =
    modoColeta !== "conversacional" &&  // conversacional mode lets the LLM phrase freely
    (personaChave === "assistente" || personaChave === "advogado") &&
    nextQDeterministico &&
    advFlowStepType !== "llm_generated" &&
    !frustrationHandling?.skipDeterministicOverride;

  if (shouldOverrideDeterministic) {
    // Greeting exchange: saudacao step not yet sent — prepend time-based word and mark as sent
    if (!merged._saudacao_enviada) {
      const horaStr = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo", hour12: false });
      const hora = parseInt(horaStr.split(":")[0], 10);
      const saudacaoWord = hora >= 5 && hora < 12 ? "Bom dia" : hora >= 12 && hora < 18 ? "Boa tarde" : "Boa noite";
      resposta = `${saudacaoWord}! ${nextQDeterministico}`;
      merged._saudacao_enviada = true;
      prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }).catch(() => {});
      console.log(`[DeterministicQ] dealId=${deal.id} greeting="${resposta.slice(0, 60)}"`);
    } else {
      // Never override disqualification/closure messages (blocked company, prescribed, ethical conflict)
      const isDisqualification = /não vamos conseguir|ética profissional|finalizar o atendimento|prazo já passou|prazo expirou|não podemos assumir|infelizmente.*prazo|obrigad.*contato/i.test(resposta ?? "");

      if (!isDisqualification) {
        // Keep LLM answer when client asked something that deserves a real reply,
        // then append the flow question. Otherwise replace entirely with the flow question.
        const clienteIsLegal = /\?/.test(text ?? "") && /quanto|direito|valor|prazo|receber|pagar|calculo|cálculo|estimativa|ação|processo|processual|advogad/i.test(text ?? "");
        const clienteAsksMeta = /que (dia|horas?|hora)|hoje[^\w]|que horas|qual (a data|o dia|a hora)|agora (s[aã]o|é)|quantos anos|sou eu|quem é você|quem és|é robo|é ia|é bot|é humano|é pessoa/i.test(text ?? "");
        if (clienteIsLegal || clienteAsksMeta) {
          resposta = `${resposta.trim()}\n\n${nextQDeterministico}`;
        } else {
          resposta = nextQDeterministico!;
        }
        console.log(`[DeterministicQ] dealId=${deal.id} nextQ="${nextQDeterministico}" isLegal=${clienteIsLegal}`);
      } else {
        console.log(`[DeterministicQ] dealId=${deal.id} override skipped — disqualification/closure detected`);
      }
    }
  }

  // Conversacional mode: mark greeting as sent on first outbound message
  // (sequential mode does this inside shouldOverrideDeterministic block above)
  if (modoColeta === "conversacional" && !merged._saudacao_enviada) {
    merged._saudacao_enviada = true;
    prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }).catch(() => {});
  }

  // 11. Transition logic
  //   allAnswered = basic required questions done + vinculos loop finished
  //   requerPrescricaoAtiva = only fire when there is at least one valid vinculation (not all prescribed)
  const temVinculoValido = vinculos.length > 0 && !vinculosTodosPrescritos;
  const prescricaoGate = !regraQualificacao?.requerPrescricaoAtiva || temVinculoValido;

  if (allAnswered && regraQualificacao && prescricaoGate) {
    // Send Ana's farewell (which mentions Dra. Daniela) BEFORE transitioning.
    // The LLM already generated `resposta` guided by the conversational-router isDone instruction.
    {
      const evoFarewell = await getEvolutionConfig(projetoId);
      if (evoFarewell && resposta) {
        const textoFarewell = limparResposta(resposta, persona.nomeExibicao);
        const comportFarewell = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "comportamento" } });
        const getC = (k: string, d: number) => { const v = comportFarewell.find(c => c.chave === k)?.valor; const n = v ? Number(v) : NaN; return isNaN(n) ? d : n; };
        const readDelayFarewell = (getC("resposta_delay_min", 20) + Math.random() * (getC("resposta_delay_max", 40) - getC("resposta_delay_min", 20))) * 1000;
        await sendHumanizedSafe(evoFarewell, phone, `*${persona.nomeExibicao}*\n${textoFarewell}`, readDelayFarewell, { deal, persona, projetoId });
        await prisma.crmMensagemWhatsapp.create({
          data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: textoFarewell },
        });
      }
    }
    const qualDados = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v ?? "")]));
    dispararNotificacoes(projetoId, "qualificacao_completa", {
      ...qualDados,
      telefone: phone,
      stage: stageChave,
    }).catch(() => {});
    const transitioned = await transitionDeal(projetoId, deal.id, "qualificacao_completa", phone);
    if (transitioned) return;

    // Auto-proposal trigger for qualificacao_completa moment
    const evoForProposta = await getEvolutionConfig(projetoId);
    if (evoForProposta) {
      criarPropostaAutomatica(projetoId, evoForProposta, phone, deal.id, "qualificacao_completa").catch(() => {});
    }
  }

  // 12. Check transitions based on client reply
  const transitioned = await checkTransitions(projetoId, deal.id, stageChave, text ?? "", phone);
  if (transitioned) return; // transition sent its own message

  // 13. Load Evolution config and send response
  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) {
    console.error("[StageEngine] Evolution API não configurada");
    return;
  }

  // Load comportamento configs for configurable delays
  const comportConfigs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "comportamento" },
  });
  const getComport = (k: string, def: number) => {
    const v = comportConfigs.find((c) => c.chave === k)?.valor;
    const n = v ? Number(v) : NaN;
    return isNaN(n) ? def : n;
  };
  const delayMin = getComport("resposta_delay_min", 20) * 1000;
  const delayMax = getComport("resposta_delay_max", 40) * 1000;
  const readDelay = delayMin + Math.random() * (delayMax - delayMin);

  // 13b. Intercept descarte signal BEFORE sending — replace with hold message, notify SDR
  const DESCARTE_REGEX = /infelizmente.{0,40}não.{0,30}(vamos conseguir|conseguimos|podemos).{0,30}atender/i;
  let isDescarte = false;
  if (DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {
    isDescarte = true;
    // Replace rejection message with neutral hold so lead doesn't get discouraged yet
    resposta = "Aguarda um momento aqui, vou verificar com a equipe e já retorno pra você, tá?";
  }

  const textoLimpo = limparResposta(resposta, persona.nomeExibicao);

  // Dedup guard: prevents sending the same (or very similar) question twice in quick succession.
  // This covers two cases:
  //   1. Exact match — identical text sent in last 2 minutes (cluster race or delayed webhooks)
  //   2. Semantic overlap — last outgoing message already contained the key fragment of this response
  //      e.g. if we already asked "Além da TransABC..." don't ask it again even with minor rewording
  {
    const doisMinAgo = new Date(Date.now() - 120_000);
    // Check exact duplicate
    const jaMandado = await prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId: deal.id, direcao: "out", conteudo: textoLimpo, enviadaEm: { gte: doisMinAgo } },
    });
    if (jaMandado) {
      console.log(`[StageEngine] Dedup exato: "${textoLimpo.slice(0, 60)}..." já enviado — ignorando`);
      return;
    }
    // Check semantic overlap: if last outgoing message has significant fragment overlap with this one
    const ultimaOut = await prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId: deal.id, direcao: "out", enviadaEm: { gte: doisMinAgo } },
      orderBy: { enviadaEm: "desc" },
    });
    if (ultimaOut) {
      const normalizar = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
      const fragmento = normalizar(textoLimpo).slice(0, 60); // first 60 chars as fingerprint
      if (normalizar(ultimaOut.conteudo).includes(fragmento)) {
        console.log(`[StageEngine] Dedup semântico: fragmento "${fragmento}" já presente na última mensagem — ignorando`);
        return;
      }
    }
  }

  const respostaWA = `*${persona.nomeExibicao}*\n${textoLimpo}`;
  await sendHumanizedSafe(evoConfig, phone, respostaWA, readDelay, { deal, persona, projetoId });

  // 14. Save outgoing message — store clean text (no asterisks); frontend shows sender name separately
  await prisma.crmMensagemWhatsapp.create({
    data: {
      dealId: deal.id,
      contatoId: contato.id,
      direcao: "out",
      personaChave,
      remetente: persona.nomeExibicao,
      tipo: "text",
      conteudo: textoLimpo,
    },
  });

  // 14b. Post-send descarte handling — move deal + notify SDR
  if (isDescarte) {
    const [faseFunil, crmStageDescartado] = await Promise.all([
      prisma.iaFaseFunil.findUnique({ where: { projetoId_chave: { projetoId, chave: "descartado" } } }),
      prisma.crmStage.findFirst({ where: { chave: "descartado" } }),
    ]);

    if (faseFunil) {
      // 1. Move deal to descartado — SDR will review
      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: {
          iaStageChave: "descartado",
          ...(crmStageDescartado ? { stageId: crmStageDescartado.id } : {}),
        },
      });

      // 2. Record justification as note
      const justificativa = vinculosTodosPrescritos
        ? "Prescrição trabalhista: vínculo mais recente encerrado há mais de 2 anos."
        : "Empresa/caso fora do perfil de atuação do escritório (filtro silencioso ativado).";
      await prisma.crmNota.create({
        data: {
          dealId: deal.id,
          conteudo: `[IA] Descarte pendente revisão humana — ${justificativa}`,
        },
      });

      // 3. Notify human SDR for review
      const nomeContato = String(merged.nome ?? contato.nome ?? "");
      const empresa = String(
        merged.empresa_recente ??
        (Array.isArray(merged.vinculos) && (merged.vinculos as any[])[0]?.empresa) ?? ""
      );
      dispararNotificacoes(projetoId, "descarte_revisao_humana", {
        nome:          nomeContato,
        telefone:      phone,
        cidade:        String(merged.cidade ?? ""),
        empresa,
        justificativa,
      }).catch(() => {});

      console.log(`[StageEngine] Deal ${deal.id} → descartado (revisão SDR) — ${justificativa}`);
    }
    return; // skip parecer/proposal logic for discarded leads
  }

  // 14c. If Daniela sent a parecer with a value estimate, persist it on the deal + send TTS audio.
  //      Detect: response contains a BRL value (R$ X.XXX,XX) and keywords indicating an assessment.
  if (personaChave === "daniela" || personaChave?.includes("closer")) {
    const PARECER_KEYWORDS = /\b(parecer|estima(tiva)?|calcul(ei|amos)|valor.*recup|recup.*valor|pleite|pode recup|você pode receb|a[çc][ãa]o trabalhista|ajuiz|indeniza[çc][ãa]o)\b/i;
    const VALOR_REGEX = /R\$\s*([\d.,]+)/g;

    if (PARECER_KEYWORDS.test(resposta)) {
      // Send audio for parecer (non-blocking, TTS failure won't affect text flow)
      sendAudioIfConfigured(projetoId, evoConfig, phone, resposta, personaChave, "parecer", deal.id).catch(() => {});
      const valores: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = VALOR_REGEX.exec(resposta)) !== null) {
        const v = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
        if (!isNaN(v) && v > 1000) valores.push(v);
      }

      if (valores.length > 0) {
        const maiorValor = Math.max(...valores);
        await prisma.crmDeal.update({
          where: { id: deal.id },
          data: {
            parecer: resposta,
            valorEstimado: maiorValor,
          },
        });
        await prisma.crmNota.create({
          data: {
            dealId: deal.id,
            conteudo: `[Parecer Daniela] Valor estimado: ${maiorValor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
          },
        });
        console.log(`[StageEngine] Parecer salvo no deal ${deal.id} — valorEstimado: ${maiorValor}`);

        // Auto-proposal: trigger if configured for "parecer_enviado"
        criarPropostaAutomatica(projetoId, evoConfig, phone, deal.id, "parecer_enviado").catch(() => {});
      }
    }
  }

  // 14c. Auto-proposal + SDR notification for documentos_pessoais moment
  if (documentosEnviados) {
    criarPropostaAutomatica(projetoId, evoConfig, phone, deal.id, "documentos_pessoais").catch(() => {});
    dispararNotificacoes(projetoId, "documentos_pessoais", {
      nome:     String(merged.nome ?? contato.nome ?? ""),
      telefone: phone,
      cidade:   String(merged.cidade ?? ""),
    }).catch(() => {});
  }

  // 14d. Auto-proposal trigger when Daniela's flow advances to envio_contrato (all personal data collected)
  if (advFlowNextStepChave === "envio_contrato") {
    criarPropostaAutomatica(projetoId, evoConfig, phone, deal.id, "dados_coletados").catch(() => {});
  }

  // 14e. SDR notification when Daniela's flow completes (reunião agendada / lead pronto)
  if (advFlowNextStepChave === "__done__") {
    dispararNotificacoes(projetoId, "fluxo_concluido", {
      nome:     String(merged.nome ?? contato.nome ?? ""),
      telefone: phone,
      cidade:   String(merged.cidade ?? ""),
      cpf:      String(merged.cpf ?? contato.cpf ?? ""),
    }).catch(() => {});
  }

  // 15. Update last contact time
  await prisma.crmDeal.update({
    where: { id: deal.id },
    data: { ultimoContatoEm: new Date() },
  });
}

function extractText(msg: EvolutionWebhookMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    null
  );
}

async function createInitialDeal(projetoId: string, contatoId: string, nome: string) {
  const faseEntrada = await prisma.iaFaseFunil.findFirst({
    where: { projetoId, ehEntrada: true, pipelineTipo: "comercial" },
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

  if (!stageId) {
    const pipeline = await prisma.crmPipeline.findFirst({
      where: { tipo: "comercial", ativo: true },
      include: { stages: { where: { ehEntrada: true }, take: 1 } },
    });
    if (pipeline?.stages[0]) {
      stageId = pipeline.stages[0].id;
      pipelineId = pipeline.id;
    }
  }

  if (!stageId || !pipelineId) throw new Error("Nenhum pipeline comercial configurado");

  return prisma.crmDeal.create({
    data: {
      titulo: `${nome} — WhatsApp`,
      pipelineId,
      stageId,
      contatoId,
      projetoId,
      iaAtiva: true,
      iaStageChave: faseEntrada?.chave ?? "lead_carreteiro",
      iaPersonaChave: faseEntrada?.personaChave ?? "assistente",
      fonteLead: "whatsapp",
    },
  });
}

async function criarPropostaAutomatica(
  projetoId: string,
  evoConfig: EvolutionConfig,
  phone: string,
  dealId: string,
  momento: string,
): Promise<void> {
  try {
    // 1. Load proposta configs
    const propostaConfigs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, categoria: "proposta" },
    });
    const getProp = (k: string) => propostaConfigs.find((c) => c.chave === k)?.valor ?? "";

    if (getProp("proposta_ativo") !== "true") return;
    if (getProp("proposta_momento") !== momento) return;

    const emitenteId = getProp("proposta_emitente_id");
    if (!emitenteId) {
      console.warn("[Proposta] proposta_emitente_id não configurado — proposta não gerada");
      return;
    }

    // 2. Load deal + contato
    const deal = await prisma.crmDeal.findUnique({
      where: { id: dealId },
      include: { contato: true },
    });
    if (!deal) return;

    const merged = (deal.qualificacao ?? {}) as Record<string, unknown>;
    const nomeCliente      = String(merged.nome ?? deal.contato?.nome ?? "Cliente");
    const cpfCliente       = String(merged.cpf ?? deal.contato?.cpf ?? "");
    const emailCliente     = String(merged.email ?? deal.contato?.email ?? "");
    const rgCliente        = String(merged.rg ?? "");
    const orgaoEmissorRg   = String(merged.orgao_emissor_rg ?? "");
    const dataNascimento   = merged.data_nascimento ? new Date(String(merged.data_nascimento).split("/").reverse().join("-")) : null;

    if (!cpfCliente) {
      console.warn(`[Proposta] CPF não disponível para deal ${dealId} — proposta não gerada`);
      return;
    }

    // Trava: campos obrigatórios para geração do contrato
    const rgCliente2          = String(merged.rg ?? "").trim();
    const enderecoCliente     = String(merged.endereco ?? "").trim();
    const estadoCivilCliente  = String(merged.estado_civil ?? "").trim();
    const camposFaltando: string[] = [];
    if (!rgCliente2)         camposFaltando.push("RG (enviar CNH)");
    if (!enderecoCliente)    camposFaltando.push("comprovante de endereço");
    if (!estadoCivilCliente) camposFaltando.push("estado civil");
    if (camposFaltando.length > 0) {
      console.warn(`[Proposta] Qualificação incompleta para deal ${dealId} — faltam: ${camposFaltando.join(", ")} — proposta não gerada`);
      return;
    }

    // 3. Find or create Tomador — update identity fields if already exists
    let tomador = await prisma.tomador.findUnique({ where: { cpfCnpj: cpfCliente.replace(/\D/g, "") } });
    const tomadorData = {
      nome:           nomeCliente,
      email:          emailCliente || null,
      telefone:       phone || null,
      cidade:         String(merged.cidade ?? "") || null,
      ...(rgCliente     ? { rg: rgCliente }                : {}),
      ...(orgaoEmissorRg ? { rgOrgaoEmissor: orgaoEmissorRg } : {}),
      ...(dataNascimento && !isNaN(dataNascimento.getTime()) ? { dataNascimento } : {}),
    };
    if (!tomador) {
      tomador = await prisma.tomador.create({
        data: { cpfCnpj: cpfCliente.replace(/\D/g, ""), ...tomadorData },
      });
      console.log(`[Proposta] Tomador criado: ${tomador.id} (${nomeCliente})`);
    } else if (rgCliente || orgaoEmissorRg) {
      // Update identity fields if we have new data from the document
      await prisma.tomador.update({
        where: { id: tomador.id },
        data:  tomadorData as any,
      });
    }

    // 4. Load body template HTML
    const corpoTemplateId = getProp("proposta_template_corpo_id");
    let textoHtml = "";
    if (corpoTemplateId) {
      const tmpl = await (prisma as any).templateDocumento.findUnique({ where: { id: corpoTemplateId } });
      textoHtml = tmpl?.textoHtml ?? "";
    }
    if (!textoHtml) {
      // Fallback: use first hardcoded template (assessoria)
      const { TEMPLATES_PROPOSTA } = await import("../routers/propostas.js");
      textoHtml = TEMPLATES_PROPOSTA[0].html;
    }

    // 5. Load emitente for variable substitution
    const emitente = await prisma.empresaEmitente.findUnique({ where: { id: emitenteId } });
    if (!emitente) {
      console.warn(`[Proposta] Emitente ${emitenteId} não encontrado`);
      return;
    }

    // 6. Substitute variables in template
    const hoje = new Date();
    const validadeDias = parseInt(getProp("proposta_validade_dias") || "30", 10);
    const validadeAte = new Date(hoje.getTime() + validadeDias * 24 * 60 * 60 * 1000);
    const honorariosTipo = getProp("proposta_honorarios_tipo") || "exito";
    const honorariosPerc = getProp("proposta_honorarios_perc") || "30";
    const descricaoServico = getProp("proposta_descricao_servico") || "Ação trabalhista";

    const valorEstimado = deal.valorEstimado ? Number(deal.valorEstimado) : null;
    const valorStr = valorEstimado
      ? (valorEstimado / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
      : "a definir";

    const fmtData = (d: Date) => d.toLocaleDateString("pt-BR");
    const localidade = [emitente.cidade, emitente.uf].filter(Boolean).join("/");

    textoHtml = textoHtml
      .replace(/\{\{emitente\}\}/gi,   emitente.nomeFantasia || emitente.nome)
      .replace(/\{\{tomador\}\}/gi,    nomeCliente)
      .replace(/\{\{cnpj\}\}/gi,       emitente.cnpj)
      .replace(/\{\{cidade\}\}/gi,     localidade)
      .replace(/\{\{endereco\}\}/gi,   emitente.endereco || "")
      .replace(/\{\{servico\}\}/gi,    descricaoServico)
      .replace(/\{\{valor\}\}/gi,      valorStr)
      .replace(/\{\{diaVencimento\}\}/gi,      getProp("proposta_dia_vencimento") || "5")
      .replace(/\{\{validadeAte\}\}/gi,         fmtData(validadeAte))
      .replace(/\{\{dataAtual\}\}/gi,           fmtData(hoje))
      .replace(/\{\{honorariosExito\}\}/gi,     `${honorariosPerc}%`)
      .replace(/\{\{honorariosExitoPerc\}\}/gi, honorariosPerc);

    // 7. Collect template IDs for contract/procuracao generation
    const templatesGerar: string[] = [];
    const contratoTemplateId  = getProp("proposta_template_contrato_id");
    const procuracaoTemplateId = getProp("proposta_template_procuracao_id");
    if (contratoTemplateId)   templatesGerar.push(contratoTemplateId);
    if (procuracaoTemplateId) templatesGerar.push(procuracaoTemplateId);

    // 8. Create Proposta record
    const titulo = `Proposta — ${nomeCliente}`;
    const proposta = await prisma.proposta.create({
      data: {
        emitenteId,
        tomadorId:     tomador.id,
        titulo,
        textoHtml,
        valorEstimado: valorEstimado ? Math.round(valorEstimado) : null,
        validadeAte,
        status:        "ACEITA",
        contratoDiaVencimento:     parseInt(getProp("proposta_dia_vencimento") || "5", 10),
        contratoMetodoCobr:        (getProp("proposta_metodo_cobr") as any) || "PIX_BOLETO",
        contratoTipoContrato:      (getProp("proposta_tipo_contrato") as any) || "RECORRENTE",
        contratoEmitirNfseAuto:    false,
        contratoGerarCobrancaAuto: true,
        contratoIssRetido:         false,
        contratoDescricao:         descricaoServico,
        templatesGerar:            templatesGerar.length > 0 ? JSON.stringify(templatesGerar) : null,
      } as any,
    });
    console.log(`[Proposta] Proposta criada: ${proposta.id} para deal ${dealId}`);

    // Link note
    prisma.crmNota.create({
      data: { dealId, conteudo: `[IA] Proposta criada automaticamente: ${proposta.id} | ${titulo}` },
    }).catch(() => {});

    // 9. Generate documents (contrato + procuração)
    if (templatesGerar.length > 0) {
      try {
        const { gerarDocumentosProposta } = await import("../routers/templateDocumentos.js");
        await gerarDocumentosProposta(proposta.id);
        console.log(`[Proposta] Documentos gerados para proposta ${proposta.id}`);
      } catch (e) {
        console.error("[Proposta] Falha ao gerar documentos:", e);
      }
    }

    // 9b. Converter proposta em contrato imediatamente (sem precisar do aceite do cliente)
    try {
      const { autoConverterEmContrato } = await import("../routers/propostas.js");
      await autoConverterEmContrato(proposta.id);
      console.log(`[Proposta] Contrato criado automaticamente para proposta ${proposta.id}`);
    } catch (e) {
      console.error("[Proposta] Falha ao criar contrato automaticamente:", e);
    }

    // 10. Upload docs to PAKT and collect sign URLs
    const baseUrl    = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
    const paktApiKey = process.env.PAKT_API_KEY;
    const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
    const { existsSync } = await import("node:fs");
    const { readFile }   = await import("node:fs/promises");

    type PaktDoc = { titulo: string; signUrl: string; documentId: string };
    const paktDocs: PaktDoc[] = [];

    // PAKT: upload sempre que houver documentos, independente de ter e-mail do cliente
    // Link de assinatura é enviado via WhatsApp — nunca por e-mail
    if (paktApiKey && templatesGerar.length > 0) {
      try {
        const docs = await (prisma as any).documentoGerado.findMany({
          where: { propostaId: proposta.id },
          orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }],
        });

        // Usar e-mail do cliente ou placeholder — PAKT exige o campo mas não enviamos e-mail
        const signerEmail = emailCliente || "assinar@avoce.com.br";

        for (const doc of docs) {
          if (!doc.pdfPath || !existsSync(doc.pdfPath)) continue;
          try {
            const pdfBuf = await readFile(doc.pdfPath);
            const filename = `${doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`;
            const form = new FormData();
            form.append("file", new Blob([pdfBuf as unknown as BlobPart], { type: "application/pdf" }), filename);
            form.append("metadata", JSON.stringify({
              nome:      doc.titulo,
              mensagem:  `Documento de ${emitente.nomeFantasia || emitente.nome} para assinatura.`,
              expiresAt: validadeAte.toISOString(),
              signers:   [{ nome: nomeCliente, email: signerEmail, countryCode: "BR" }],
            }));

            const createRes = await fetch(`${paktBaseUrl}/api/v1/documents`, {
              method: "POST",
              headers: { Authorization: `Bearer ${paktApiKey}` },
              body: form,
            });
            if (createRes.ok) {
              const paktDoc = await createRes.json() as { id: string; signers: Array<{ signUrl: string }> };
              const signUrl = paktDoc.signers[0]?.signUrl;
              if (signUrl) {
                paktDocs.push({ titulo: doc.titulo, signUrl, documentId: paktDoc.id });
                // NÃO chamar /send — notificação é feita via WhatsApp, nunca por e-mail
              }
            }
          } catch (e) {
            console.error(`[Proposta] PAKT falhou para doc ${doc.id}:`, e);
          }
        }

        if (paktDocs.length > 0) {
          await prisma.proposta.update({
            where: { id: proposta.id },
            data: {
              paktSignUrl:    paktDocs[0].signUrl,
              paktDocumentId: JSON.stringify(paktDocs.map(d => d.documentId)),
            } as any,
          });
        }
      } catch (e) {
        console.error("[Proposta] Falha no PAKT:", e);
      }
    }

    // 11. Send WhatsApp messages with proposal text + signing links
    // Convert HTML body to readable plain text for WhatsApp
    const textoPlano = textoHtml
      .replace(/<h[1-6][^>]*>/gi, "\n*")
      .replace(/<\/h[1-6]>/gi, "*\n")
      .replace(/<p[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "*$1*")
      .replace(/<b[^>]*>(.*?)<\/b>/gi, "*$1*")
      .replace(/<em[^>]*>(.*?)<\/em>/gi, "_$1_")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/li>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Send proposal text first (max 3000 chars to avoid WA limits)
    const textoEnviar = textoPlano.length > 3000 ? textoPlano.slice(0, 2997) + "..." : textoPlano;
    if (textoEnviar) {
      await sendText(evoConfig, phone, textoEnviar);
      // Small pause between messages
      await new Promise(r => setTimeout(r, 1500));
    }

    if (paktDocs.length > 0) {
      // Has PAKT signing links — send each doc link
      const linhasAssinatura = paktDocs
        .map((d, i) => `${i + 1}. ${d.titulo}:\n${d.signUrl}`)
        .join("\n\n");
      const msgAssinatura = `Para assinar digitalmente, acesse os links abaixo:\n\n${linhasAssinatura}`;
      await sendText(evoConfig, phone, msgAssinatura);
    } else {
      // No PAKT — send contract/procuração PDFs directly via WhatsApp
      if (templatesGerar.length > 0) {
        try {
          const docs = await (prisma as any).documentoGerado.findMany({
            where: { propostaId: proposta.id },
            orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }],
          });
          const { readFile } = await import("node:fs/promises");
          const { existsSync }  = await import("node:fs");
          for (const doc of docs) {
            if (!doc.pdfPath || !existsSync(doc.pdfPath)) continue;
            try {
              const pdfBuf = await readFile(doc.pdfPath);
              const pdfBase64 = pdfBuf.toString("base64");
              const fileName  = `${doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`;
              await sendDocument(evoConfig, phone, pdfBase64, fileName, doc.titulo);
              console.log(`[Proposta] PDF enviado via WhatsApp: ${doc.titulo}`);
              await new Promise(r => setTimeout(r, 1500));
            } catch (e) {
              console.error(`[Proposta] Falha ao enviar PDF ${doc.id}:`, e);
            }
          }
        } catch (e) {
          console.error("[Proposta] Falha ao enviar PDFs via WhatsApp:", e);
        }
      }
    }

    // Log outgoing message
    prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        direcao: "out",
        personaChave: "sistema",
        tipo: "text",
        conteudo: `[Proposta automática] ${proposta.id} | Contrato gerado e enviado para assinatura`,
      },
    }).catch(() => {});

    console.log(`[Proposta] Proposta ${proposta.id} enviada via WhatsApp para ${phone}`);
  } catch (err: any) {
    console.error(`[Proposta] Erro em criarPropostaAutomatica: ${err?.message ?? err}`);
  }
}

