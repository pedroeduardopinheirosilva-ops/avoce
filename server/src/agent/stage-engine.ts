/**
 * Stage Engine — pure orchestrator for incoming WhatsApp messages.
 * Business logic lives in dedicated modules (agent/ directory).
 */

import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { detectIdentityQuestion, buildIdentityResponse, registrarEventoIdentidade } from "./identity-handler.js";
import { detectFrustration, buildFrustrationHandling, type FrustrationHandling } from "./frustration-detector.js";
import { isAskingValue, buildValueResponseInjection } from "./value-trigger.js";
import { calcularValorCausa } from "./calc-trabalhista.js";
import { buildHandoffSnapshot } from "./handoff-snapshot.js";
import { validarCPF, temDadosMinimosCalculo } from "./qualification-utils.js";
import { extractQualificacaoData, extractVinculosFromMerged } from "./qualification.js";
import { buildInstrucaoBase, detectarFaseAtualDaniela, invalidateFlowCache } from "./persona-router.js";
import {
  sendHumanized, sendHumanizedSafe, normalizarTexto, limparResposta,
  getEvolutionConfig, respondFromDealState, sendAudioIfConfigured, dispararNotificacoes,
  checkAndNotifySolicitaLigacao, type EvolutionConfig,
} from "./message-handler.js";
import { transitionDeal, checkTransitions, enviarMensagemProativa } from "./transition-engine.js";
import { criarPropostaAutomatica, resendPropostaLinks, PEDIDO_LINK_REGEX } from "./proposal-engine.js";
import { scheduleLlmRetry } from "./retry-queue.js";
import {
  splitState, atualizarMergedFlags, createInitialDeal,
  persistMergedUpdates, moveToDescarte, saveParecerValue,
} from "./deal-repository.js";
import { type EvolutionWebhookMessage } from "./webhook-parser.js";
import { normalizeInput } from "./media-processor.js";
import { processVinculos } from "./vinculos-processor.js";
import { getModoColeta, applyConversacionalMode } from "./conversational-dispatch.js";
export { applyConversacionalMode } from "./conversational-dispatch.js";
import { applyDocJsonToMerged } from "./doc-extractor.js";
import { buildSystemPrompt } from "./system-prompt-builder.js";
export type { EvolutionWebhookMessage } from "./webhook-parser.js";

// Re-exports for backward compat (cron-agent.ts, ia.ts, index.ts)
export { transitionDeal, enviarMensagemProativa, getEvolutionConfig, respondFromDealState, dispararNotificacoes, invalidateFlowCache };
export type { EvolutionConfig };

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

const DESCARTE_REGEX   = /infelizmente.{0,40}não.{0,30}(vamos conseguir|conseguimos|podemos).{0,30}atender/i;
const ACKS_REGEX       = /^(ok|certo|beleza|tá|ta|aham|combinado|opa|oi)\.?$/i;
const PARECER_KEYWORDS = /\b(parecer|estima(tiva)?|calcul(ei|amos)|valor.*recup|recup.*valor|pleite|pode recup|você pode receb|a[çc][ãa]o trabalhista|ajuiz|indeniza[çc][ãa]o)\b/i;

const HINTS_ADVOGADO = [
  { chave: "cpf",              perguntaContexto: "CPF do cliente, 11 dígitos. Formato: XXX.XXX.XXX-XX ou apenas dígitos.", tipoDado: "texto" },
  { chave: "nome_completo",    perguntaContexto: "Nome completo do cliente conforme documento (RG, CNH).", tipoDado: "texto" },
  { chave: "data_nascimento",  perguntaContexto: "Data de nascimento do cliente. Aceitar DD/MM/AAAA.", tipoDado: "texto" },
  { chave: "rg",               perguntaContexto: "Número do RG do cliente (apenas dígitos, sem pontos ou traços).", tipoDado: "texto" },
  { chave: "orgao_emissor_rg", perguntaContexto: "Órgão emissor do RG do cliente: SSP/BA, SSP/SP, Detran, etc.", tipoDado: "texto" },
  { chave: "endereco",         perguntaContexto: "Endereço residencial completo: rua, número, bairro, cidade, estado, CEP.", tipoDado: "texto" },
  { chave: "estado_civil",     perguntaContexto: "Estado civil: solteiro, casado, divorciado, viúvo, união estável.", tipoDado: "texto" },
  { chave: "profissao",        perguntaContexto: "Profissão registrada na carteira de trabalho.", tipoDado: "texto" },
];

const HINTS_ASSISTENTE = [
  { chave: "nome",              perguntaContexto: "Nome completo do cliente informado por ele mesmo.", tipoDado: "texto" },
  { chave: "cidade",            perguntaContexto: "Cidade onde o cliente mora ou trabalha.", tipoDado: "texto" },
  { chave: "acao_em_andamento", perguntaContexto: "O cliente já tem ação trabalhista em andamento? true = sim; false = não.", tipoDado: "booleano" },
  { chave: "interesse",         perguntaContexto: "O cliente demonstrou interesse em contratar? true = sim; false = não.", tipoDado: "booleano" },
  { chave: "vinculo_recente",   perguntaContexto: "Tipo de vínculo trabalhista mais recente: CLT/carteira assinada, autônomo, agregado, TAC.", tipoDado: "texto" },
];

// ──────────────────────────────────────────────────────────────────────────────
// Local helpers
// ──────────────────────────────────────────────────────────────────────────────

async function findOrCreateDeal(projetoId: string, msg: EvolutionWebhookMessage) {
  const phone = msg.key.remoteJid.replace(/@.*/, "");
  let contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  let deal    = contato
    ? await prisma.crmDeal.findFirst({ where: { contatoId: contato.id, projetoId, status: "aberto" }, orderBy: { criadoEm: "desc" } })
    : null;
  if (!contato) contato = await prisma.crmContato.create({ data: { nome: msg.pushName ?? `Lead ${phone}`, whatsapp: phone } });
  const isNewDeal = !deal;
  if (!deal) deal = await createInitialDeal(projetoId, contato.id, contato.nome);
  return { contato, deal, isNewDeal };
}

async function saveIncomingMessage(
  deal: { id: string }, contato: { id: string }, msg: EvolutionWebhookMessage,
  text: string | null, tipo: string, saveOnly: boolean,
): Promise<"duplicate" | "early_path" | "ok"> {
  try {
    await prisma.crmMensagemWhatsapp.create({
      data: { dealId: deal.id, contatoId: contato.id, direcao: "in", remetente: msg.key.remoteJid.replace(/@.*/, ""), tipo, conteudo: text ?? "", evolutionMessageId: msg.key.id },
    });
    return "ok";
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    if (saveOnly) { console.log(`[StageEngine] Mensagem ${msg.key.id} já processada — ignorando duplicata`); return "duplicate"; }
    if (text) await prisma.crmMensagemWhatsapp.updateMany({ where: { evolutionMessageId: msg.key.id, dealId: deal.id }, data: { conteudo: text, tipo } });
    return "early_path";
  }
}

async function handleNewDealGreeting(projetoId: string, deal: any, contato: any, phone: string) {
  if (await prisma.crmMensagemWhatsapp.count({ where: { dealId: deal.id, direcao: "out" } }) > 0) return;
  const { getGreetingStep } = await import("./flow-controller.js");
  const greetingText = await getGreetingStep(projetoId).catch(() => null);
  if (!greetingText) { await enviarMensagemProativa(projetoId, deal.id, phone, "primeira_mensagem", ""); return; }
  const evoConf = await getEvolutionConfig(projetoId);
  if (!evoConf) return;
  const h    = parseInt(new Date().toLocaleString("pt-BR", { hour: "numeric", timeZone: "America/Sao_Paulo", hour12: false }), 10);
  const saud = h >= 5 && h < 12 ? "Bom dia" : h >= 12 && h < 18 ? "Boa tarde" : "Boa noite";
  const msg  = `${saud}! ${greetingText}`;
  const qualAtual = { ...(deal.qualificacao as Record<string, unknown> ?? {}), ...((deal as any).iaFlags as Record<string, unknown> ?? {}), _saudacao_enviada: true };
  await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(qualAtual) });
  await sendHumanized(evoConf, phone, msg, 1500 + Math.random() * 1500);
  await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", tipo: "text", conteudo: msg } });
  await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
}

async function extractAndApplyQual(
  projetoId: string, deal: any, contato: any,
  merged: Record<string, unknown>, history: any[], perguntas: any[],
  personaChave: string, text: string | null,
): Promise<{ merged: Record<string, unknown>; contato: any }> {
  const charsUteis = (text ?? "").replace(/\s/g, "").length;
  if (charsUteis < 2 || ACKS_REGEX.test((text ?? "").trim())) return { merged, contato };
  const pendentes = perguntas.filter(p => merged[p.chave] === undefined || merged[p.chave] === null);
  if (personaChave === "advogado") {
    for (const h of HINTS_ADVOGADO) { if (merged[h.chave] == null && !pendentes.find((p: any) => p.chave === h.chave)) pendentes.push(h as any); }
  }
  if (personaChave === "assistente") {
    for (const h of HINTS_ASSISTENTE) { if (merged[h.chave] == null && !pendentes.find((p: any) => p.chave === h.chave)) pendentes.push(h as any); }
  }
  if (!pendentes.length) return { merged, contato };
  const texto     = history.slice(-16).map(m => `${m.direcao === "out" ? "Bot" : "Cliente"}: ${m.conteudo ?? ""}`).filter(l => l.length > 6).join("\n");
  const extracted = await extractQualificacaoData(projetoId, texto || `Cliente: ${text ?? ""}`, pendentes, merged).catch(() => null);
  if (!extracted) return { merged, contato };
  const novos: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extracted)) {
    if (v != null && (merged[k] === undefined || merged[k] === null)) { merged[k] = v; novos[k] = v; }
  }
  if (!Object.keys(novos).length) return { merged, contato };
  await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
  prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] Qualificação:\n${Object.entries(novos).map(([k, v]) => `${k}: ${v}`).join("\n")}` } }).catch(() => {});
  if (novos.nome && typeof novos.nome === "string") {
    const nome = novos.nome.trim();
    await prisma.crmContato.update({ where: { id: contato.id }, data: { nome } });
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { titulo: nome } });
    contato = { ...contato, nome };
  }
  for (const [src, dst] of [["empresa_recente", "empresa_principal"], ["frota_recente", "frota"]] as [string, string][]) {
    if (merged[src] && !merged[dst]) { merged[dst] = merged[src]; await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }); }
  }
  return { merged, contato };
}

async function callLlmWithRetry(
  projetoId: string, dealId: string, systemPrompt: string,
  messages: { role: "user" | "assistant"; content: string }[],
  personaChave: string, llmChave: string | null, stageChave: string,
): Promise<string> {
  const msgs = [...messages];
  let last   = "";
  for (let i = 0; i < 3; i++) {
    const r  = (await callLlm({ projetoId, dealId, systemPrompt, messages: msgs, personaChave, personaLlmChave: llmChave, stageChave, maxTokens: 2048 })).content.trim();
    last     = r;
    const sentencas  = r.split(/[.!?](?:\s|$)/).filter(s => s.trim().length > 0).length;
    const muitoLonga = r.length > 420 || sentencas > 3;
    if (isHumanized(r) && !muitoLonga) return r;
    msgs.push({ role: "assistant", content: r });
    msgs.push({ role: "user", content: muitoLonga
      ? "INSTRUÇÃO INTERNA: Mensagem longa demais. Reescreva em no máximo 2 frases curtas e simples. Mantenha apenas a pergunta principal."
      : "INSTRUÇÃO INTERNA: Reescreva sem padrões robóticos." });
  }
  return last;
}

function applyDeterministicOverride(
  resposta: string, nextQ: string, merged: Record<string, unknown>, text: string | null, dealId: string,
): string {
  if (!merged._saudacao_enviada) {
    const h    = parseInt(new Date().toLocaleString("pt-BR", { hour: "numeric", timeZone: "America/Sao_Paulo", hour12: false }), 10);
    const saud = h >= 5 && h < 12 ? "Bom dia" : h >= 12 && h < 18 ? "Boa tarde" : "Boa noite";
    console.log(`[DeterministicQ] dealId=${dealId} greeting`);
    return `${saud}! ${nextQ}`;
  }
  const isDisqualification = /não vamos conseguir|ética profissional|finalizar o atendimento|prazo já passou|prazo expirou|não podemos assumir|infelizmente.*prazo|obrigad.*contato/i.test(resposta);
  if (isDisqualification) { console.log(`[DeterministicQ] dealId=${dealId} override skipped — disqualification`); return resposta; }
  const clienteIsLegal  = /\?/.test(text ?? "") && /quanto|direito|valor|prazo|receber|pagar|calculo|cálculo|estimativa|ação|processo|processual|advogad/i.test(text ?? "");
  const clienteAsksMeta = /que (dia|horas?|hora)|hoje[^\w]|que horas|qual (a data|o dia|a hora)|agora (s[aã]o|é)|quantos anos|sou eu|quem é você|é robo|é ia|é bot|é humano/i.test(text ?? "");
  console.log(`[DeterministicQ] dealId=${dealId} nextQ="${nextQ.slice(0, 60)}" isLegal=${clienteIsLegal}`);
  return (clienteIsLegal || clienteAsksMeta) ? `${resposta.trim()}\n\n${nextQ}` : nextQ;
}

async function dedupAndSend(
  projetoId: string, evoConfig: EvolutionConfig,
  deal: { id: string }, contato: { id: string }, phone: string,
  persona: { nomeExibicao: string }, personaChave: string,
  textoLimpo: string, readDelay: number,
): Promise<boolean> {
  const since = new Date(Date.now() - 120_000);
  const exact = await prisma.crmMensagemWhatsapp.findFirst({ where: { dealId: deal.id, direcao: "out", conteudo: textoLimpo, enviadaEm: { gte: since } } });
  if (exact) { console.log(`[StageEngine] Dedup exato: "${textoLimpo.slice(0, 60)}..." — ignorando`); return false; }
  const last  = await prisma.crmMensagemWhatsapp.findFirst({ where: { dealId: deal.id, direcao: "out", enviadaEm: { gte: since } }, orderBy: { enviadaEm: "desc" } });
  if (last) {
    const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    if (norm(last.conteudo ?? "").includes(norm(textoLimpo).slice(0, 60))) { console.log(`[StageEngine] Dedup semântico — ignorando`); return false; }
  }
  await sendHumanizedSafe(evoConfig, phone, `*${persona.nomeExibicao}*\n${textoLimpo}`, readDelay, { deal, persona: { chave: personaChave, nomeExibicao: persona.nomeExibicao }, projetoId });
  await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: textoLimpo } });
  return true;
}

// Deduplicates send_proativa actions by dealId before scheduling to prevent
// double-sending when both transitionDeal and checkTransitions return actions.
function scheduleProativasDeduped(
  actions: import("./transition-engine.js").PendingAction[],
  projetoId: string,
): void {
  const scheduled = new Set<string>();
  for (const a of actions) {
    if (a.type !== "send_proativa") continue;
    if (scheduled.has(a.dealId)) {
      console.log(`[StageEngine] Dedup proativa: dealId=${a.dealId} motivo=${a.motivoCron} — já agendado`);
      continue;
    }
    scheduled.add(a.dealId);
    setTimeout(() => enviarMensagemProativa(projetoId, a.dealId, a.phone, a.motivoCron, a.nomeCliente).catch(() => {}), a.delayMs);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point — called by webhook
// ──────────────────────────────────────────────────────────────────────────────

export async function processIncomingMessage(
  projetoId: string,
  msg: EvolutionWebhookMessage,
  saveOnly = false,
): Promise<void> {
  const phone = msg.key.remoteJid.replace(/@.*/, "");
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid.endsWith("@broadcast") || msg.key.remoteJid.endsWith("@g.us")) return;

  // B1: normalize input (audio transcription / OCR)
  const { text, documentosEnviados, docJsonDireto, tipo } = await normalizeInput(projetoId, msg);

  // B2: find or create contact + deal
  const { contato: c0, deal: d0, isNewDeal } = await findOrCreateDeal(projetoId, msg);
  let contato = c0, deal = d0;

  // B3: save incoming (atomic dedup guard via unique evolutionMessageId)
  const saveResult = await saveIncomingMessage(deal, contato, msg, text, tipo, saveOnly);
  if (saveResult === "duplicate" || saveOnly) return;

  // B4: new deal → greet and stop
  if (isNewDeal) { await handleNewDealGreeting(projetoId, deal, contato, phone); return; }

  // B5: guards
  if (!deal.iaAtiva) return;
  if (msg.pushName && contato.nome.startsWith("Lead ")) {
    await prisma.crmContato.update({ where: { id: contato.id }, data: { nome: msg.pushName } });
    contato = { ...contato, nome: msg.pushName };
  }

  // B6: load stage, persona, history, questions
  const stageChave   = deal.iaStageChave ?? "lead_carreteiro";
  const fase         = await prisma.iaFaseFunil.findUnique({ where: { projetoId_chave: { projetoId, chave: stageChave } } });
  if (!fase || fase.requerAcaoHumana) return;
  const personaChave = deal.iaPersonaChave ?? fase.personaChave ?? "assistente";
  const persona      = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave: personaChave } } });
  if (!persona) return;
  const historyRaw   = await prisma.crmMensagemWhatsapp.findMany({ where: { dealId: deal.id }, orderBy: { enviadaEm: "desc" }, take: 20 });
  const history      = historyRaw.reverse();
  const perguntas    = await prisma.iaPerguntaQualificacao.findMany({ where: { projetoId, stageColeta: stageChave, ativo: true }, orderBy: { ordem: "asc" } });
  let merged: Record<string, unknown> = { ...(deal.qualificacao as Record<string, unknown> ?? {}), ...((deal as any).iaFlags as Record<string, unknown> ?? {}) };
  const outgoingCount = history.filter(m => m.direcao === "out").length;

  // B7: early returns — identity + frustration
  const msgNorm = normalizarTexto(text ?? "");
  if (text && detectIdentityQuestion(msgNorm)) {
    const resp = await buildIdentityResponse({ id: projetoId }, persona);
    const evo  = await getEvolutionConfig(projetoId);
    if (evo) {
      await sendHumanizedSafe(evo, phone, resp, 2000, { deal, persona, projetoId });
      await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: resp } });
    }
    await registrarEventoIdentidade(deal.id, text, resp);
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
    return;
  }

  let frustrationHandling: FrustrationHandling | null = null;
  if (text) {
    const frustration = detectFrustration(msgNorm, history);
    if (frustration) {
      let identityText: string | undefined;
      if (frustration.type === "duvida_legitimidade") identityText = await buildIdentityResponse({ id: projetoId }, persona);
      let retencaoText: string | undefined;
      if (frustration.type === "abandono_iminente") {
        const cfg = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "comportamento.mensagem_retencao" } });
        retencaoText = cfg?.valor ?? undefined;
      }
      frustrationHandling = buildFrustrationHandling(frustration, deal, merged, persona, identityText, retencaoText);
      if (frustrationHandling.escalateToHuman) {
        dispararNotificacoes(projetoId, `frustracao_${frustration.type}`, {
          dealId: deal.id, mensagem: text, triggerPhrase: frustration.triggerPhrase,
          nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone,
        }).catch(() => {});
      }
      if (frustrationHandling.forceResponseText) {
        const evo = await getEvolutionConfig(projetoId);
        if (evo) {
          await sendHumanizedSafe(evo, phone, frustrationHandling.forceResponseText, 2000, { deal, persona, projetoId });
          await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: frustrationHandling.forceResponseText } });
          await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
        }
        return;
      }
    }
  }

  // B8: value trigger (Daniela + minimum data available)
  // Merge iaFlowStepData so salary/jornada collected by Daniela's flow steps are visible to calculator
  const mergedComFlow = { ...merged, ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}) };
  if (text && personaChave === "advogado" && isAskingValue(msgNorm) && temDadosMinimosCalculo(mergedComFlow)) {
    const calculo  = calcularValorCausa(extractVinculosFromMerged(mergedComFlow));
    const injecao  = buildValueResponseInjection(calculo, detectarFaseAtualDaniela(deal));
    const instrBase = buildInstrucaoBase();
    const baseSys  = persona.systemPrompt.replace("{INSTRUÇÃO BASE}", instrBase).replace(/\{nome_persona\}/g, persona.nomeExibicao);
    let respostaValor = "";
    try {
      const r = await callLlm({
        projetoId, dealId: deal.id, systemPrompt: baseSys + "\n\n" + injecao, stageChave, maxTokens: 1024,
        messages: history.slice(-10).map(m => ({ role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant", content: m.conteudo ?? "" })),
        personaChave, personaLlmChave: (persona as any).llmProviderChave ?? null,
      });
      respostaValor = limparResposta(r.content.trim(), persona.nomeExibicao);
    } catch { /* fallback to normal flow */ }
    if (respostaValor) {
      const evo = await getEvolutionConfig(projetoId);
      if (evo) {
        await sendHumanizedSafe(evo, phone, respostaValor, 2000, { deal, persona, projetoId });
        await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: respostaValor } });
      }
      await atualizarMergedFlags(deal.id, merged, { _valor_apresentado: true, _valor_apresentado_em: new Date().toISOString() });
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
      return;
    }
  }

  // B9a: extract + apply qualification fields
  ({ merged, contato } = await extractAndApplyQual(projetoId, deal, contato, merged, history, perguntas, personaChave, text));

  // B9b: apply document fields from structured OCR output
  if (documentosEnviados) {
    if (merged.cpf && typeof merged.cpf === "string" && !validarCPF(merged.cpf as string)) {
      delete merged.cpf; // clear invalid CPF from prior extractions
    }
    if (docJsonDireto && docJsonDireto.tipo_documento !== "OUTRO") {
      const { updatedMerged, novosDocFields } = applyDocJsonToMerged(docJsonDireto, merged);
      merged = updatedMerged;
      if (Object.keys(novosDocFields).length > 0) {
        await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
        prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] Dados do documento (${docJsonDireto.tipo_documento}):\n${Object.entries(novosDocFields).map(([k, v]) => `${k}: ${v}`).join("\n")}` } }).catch(() => {});
        console.log(`[DocExtract] tipo=${docJsonDireto.tipo_documento} campos salvos: ${Object.keys(novosDocFields).join(", ")}`);
      } else {
        console.log(`[DocExtract] tipo=${docJsonDireto.tipo_documento} — nenhum campo novo`);
      }
    } else {
      console.log(`[DocExtract] docJsonDireto=${docJsonDireto?.tipo_documento ?? "null"} — ignorado`);
    }
  }

  // B9c: vinculos loop
  const ultimaMsgBot       = history.filter(m => m.direcao === "out").slice(-1)[0]?.conteudo ?? "";
  const maisEmpregosPerguntado =
    merged._mais_empregos_perguntado === true ||
    /outro lugar|outra empresa|mais emprego|trabalhou antes|emprego anterior|antes dis[st]/i.test(ultimaMsgBot);
  const vinculosResult     = await processVinculos({ projetoId, merged, text, history, maisEmpregosPerguntado });
  if (Object.keys(vinculosResult.mergedUpdates).length > 0) {
    merged = { ...merged, ...vinculosResult.mergedUpdates };
    await persistMergedUpdates(deal.id, merged, vinculosResult.mergedUpdates);
    for (const nota of vinculosResult.notasParaCriar) prisma.crmNota.create({ data: { dealId: deal.id, conteudo: nota } }).catch(() => {});
  }
  const { vinculos, vinculosOk, todosPrescritosFlag: vinculosTodosPrescritos } = vinculosResult.state;

  // B10a: agent routing
  const [regraQualificacao, empresasBloqueadasCfg] = await Promise.all([
    prisma.iaRegraTransicao.findFirst({ where: { projetoId, stageOrigemChave: stageChave, condicao: "qualificacao_completa" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "empresas_bloqueadas" } }),
  ]);
  const empresasBloqueadas = empresasBloqueadasCfg?.valor?.split(",").map(s => s.trim()).filter(Boolean) ?? [];

  let nextQDeterministico: string | null = null;
  let assistenteAgentResult: import("./assistente-agents.js").AgentResult | null = null;
  let advFlowStepType: string | null = null;
  let advFlowNextStepChave: string | null = null;
  let advFlowCampoColetar: string | null = null;

  if (personaChave === "assistente") {
    const { runAssistenteAgent } = await import("./assistente-agents.js");
    assistenteAgentResult = await runAssistenteAgent({ projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount });
    nextQDeterministico   = assistenteAgentResult.deterministicQuestion;
    console.log(`[AssistenteAgent] dealId=${deal.id} phase="${assistenteAgentResult.phase}" nextQ="${nextQDeterministico?.slice(0, 60) ?? "null"}" allDone=${assistenteAgentResult.allDone}`);

    const modoColeta = await getModoColeta(projetoId);
    const conv = await applyConversacionalMode({
      modoColeta, personaChave,
      agentResult: assistenteAgentResult,
      currentNextQ: nextQDeterministico,
      convParams: { projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount },
    });
    assistenteAgentResult = conv.agentResult as import("./assistente-agents.js").AgentResult;
    nextQDeterministico   = conv.nextQDeterministico;
  } else if (personaChave === "advogado" && deal.iaAtiva) {
    const { handleAdvogadoFlow } = await import("./flow-controller.js");
    const advFlow = await handleAdvogadoFlow(
      projetoId,
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
      text ?? "", outgoingCount, history,
    );
    nextQDeterministico  = advFlow.nextQuestion;
    advFlowStepType      = advFlow.stepType ?? null;
    advFlowNextStepChave = advFlow.nextStepChave ?? null;
    advFlowCampoColetar  = advFlow.campoColetar ?? null;
  }

  const perguntasPendentes = perguntas.filter(p => merged[p.chave] === undefined || merged[p.chave] === null);
  const allAnswered        = personaChave === "assistente" && assistenteAgentResult?.allDone === true;

  // B10b: ligação detection + cooldown-guarded notification
  if (text) {
    const { notificado, timestamp } = await checkAndNotifySolicitaLigacao(projetoId, deal.id, merged, text, phone, stageChave);
    if (notificado && timestamp) {
      merged._notif_ligacao_at = timestamp;
      await atualizarMergedFlags(deal.id, merged, { _notif_ligacao_at: timestamp });
    }
  }

  // B11: build system prompt
  const instrBase = buildInstrucaoBase();
  let valueInjection: string | null = null;
  if (advFlowNextStepChave === "valor_estimado" && temDadosMinimosCalculo(mergedComFlow)) {
    valueInjection = buildValueResponseInjection(calcularValorCausa(extractVinculosFromMerged(mergedComFlow)), detectarFaseAtualDaniela(deal));
  }
  let advogadoInstrucoes = "";
  if (personaChave === "advogado") {
    const { runAdvogadoAgent } = await import("./advogado-agents.js");
    // Use the step the flow just advanced TO (advFlowNextStepChave), not the stale DB value.
    // Without this, runAdvogadoAgent generates instructions for the previous step — e.g.
    // "parecer" instructions when the LLM actually needs to generate "valor_estimado".
    const effectiveStepChave = advFlowNextStepChave ?? (deal as any).iaFlowStepChave ?? null;
    const advResult = await runAdvogadoAgent({ projetoId, iaFlowStepChave: effectiveStepChave, merged, vinculos });
    advogadoInstrucoes = advResult.systemInstructions;
    console.log(`[AdvogadoAgent] dealId=${deal.id} phase="${advResult.phase}" step="${effectiveStepChave ?? "null"}"`);
  }
  const perguntasDeterministicas = perguntasPendentes.slice(0, 2).map(p => `- ${p.perguntaContexto}${p.exemploAbordagem ? ` (ex: ${p.exemploAbordagem})` : ""}`);
  const personaTrocadaEm = (deal as any).iaPersonaTrocadaEm as Date | null | undefined;
  let llmMsgsBase = history;
  if (personaChave === "advogado" && personaTrocadaEm) {
    llmMsgsBase = history.filter(m => m.enviadaEm >= personaTrocadaEm);
    if (!llmMsgsBase.length) llmMsgsBase = history.slice(-5);
  }
  const systemPrompt = buildSystemPrompt({
    personaChave, personaNome: persona.nomeExibicao,
    personaInstrucoes: personaChave === "assistente" ? (assistenteAgentResult?.systemInstructions ?? "") : advogadoInstrucoes,
    personaFase: personaChave === "assistente" ? (assistenteAgentResult?.phase ?? "") : "",
    instrucaoComportamento: persona.systemPrompt, instrucaoBase: instrBase,
    perguntasDeterministicas, camposBloqueados: [],
    merged: { ...merged, ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}) },
    vinculos, vinculosOk, vinculosTodosPrescritos,
    iaFlowStepChave: (deal as any).iaFlowStepChave ?? null,
    iaFlowStepData: (deal as any).iaFlowStepData as Record<string, unknown> ?? {},
    documentosEnviados, nextQDeterministico, advFlowStepType, advFlowNextStepChave, advFlowCampoColetar,
    valueInjection, handoffSnapshot: personaChave === "advogado" ? buildHandoffSnapshot(merged) : null,
    frustrationInjection: frustrationHandling?.injectIntoSystemPrompt ?? null,
    outgoingCount, nomeCliente: typeof merged.nome === "string" ? merged.nome : null,
    cidadeCliente: typeof merged.cidade === "string" ? merged.cidade : null,
  });
  const llmMessages = llmMsgsBase.map(m => ({ role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant", content: m.conteudo ?? "" }));

  // B12: call LLM (up to 3 humanization attempts)
  let resposta = "";
  try {
    resposta = await callLlmWithRetry(projetoId, deal.id, systemPrompt, llmMessages, personaChave, (persona as any).llmProviderChave ?? null, stageChave);
  } catch {
    console.warn(`[StageEngine] Todos os LLMs falharam para deal ${deal.id} — agendando retry`);
    scheduleLlmRetry(projetoId, deal.id, phone);
    return;
  }
  if (!resposta) return;

  // B13: deterministic question override
  const shouldOverride =
    (personaChave === "assistente" || personaChave === "advogado") &&
    !!nextQDeterministico &&
    advFlowStepType !== "llm_generated" &&
    !frustrationHandling?.skipDeterministicOverride;
  if (shouldOverride) {
    resposta = applyDeterministicOverride(resposta, nextQDeterministico!, merged, text, deal.id);
  }
  if (!merged._saudacao_enviada) {
    merged._saudacao_enviada = true;
    await atualizarMergedFlags(deal.id, merged, { _saudacao_enviada: true });
  }

  // B14: transition logic — allAnswered handoff + stage transitions
  const temVinculoValido = (vinculosOk || vinculos.length > 0) && !vinculosTodosPrescritos;
  const prescricaoGate   = !regraQualificacao?.requerPrescricaoAtiva || temVinculoValido;
  if (allAnswered && regraQualificacao && prescricaoGate) {
    const evoFarewell = await getEvolutionConfig(projetoId);
    if (evoFarewell && resposta) {
      const textoFarewell = limparResposta(resposta, persona.nomeExibicao);
      const comportFarewell = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "comportamento" } });
      const getC = (k: string, d: number) => { const v = comportFarewell.find(c => c.chave === k)?.valor; const n = v ? Number(v) : NaN; return isNaN(n) ? d : n; };
      const rd   = (getC("resposta_delay_min", 20) + Math.random() * (getC("resposta_delay_max", 40) - getC("resposta_delay_min", 20))) * 1000;
      await sendHumanizedSafe(evoFarewell, phone, `*${persona.nomeExibicao}*\n${textoFarewell}`, rd, { deal, persona, projetoId });
      await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: textoFarewell } });
    }
    const qualDados = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v ?? "")]));
    dispararNotificacoes(projetoId, "qualificacao_completa", { ...qualDados, telefone: phone, stage: stageChave }).catch(() => {});
    const { transitioned: t1, pendingActions: t1Actions } = await transitionDeal(projetoId, deal.id, "qualificacao_completa", phone);
    scheduleProativasDeduped(t1Actions, projetoId);
    if (t1) return;
    criarPropostaAutomatica(projetoId, deal.id, phone, "qualificacao_completa").catch(() => {});
  }
  const { transitioned, pendingActions: t2Actions } = await checkTransitions(projetoId, deal.id, stageChave, text ?? "", phone);
  scheduleProativasDeduped(t2Actions, projetoId);
  if (transitioned) return;

  // B15: load delays + intercept descarte + dedup + send
  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) { console.error("[StageEngine] Evolution API não configurada"); return; }
  const comportConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "comportamento" } });
  const getC  = (k: string, d: number) => { const v = comportConfigs.find(c => c.chave === k)?.valor; const n = v ? Number(v) : NaN; return isNaN(n) ? d : n; };
  const delay = (getC("resposta_delay_min", 20) + Math.random() * (getC("resposta_delay_max", 40) - getC("resposta_delay_min", 20))) * 1000;

  let isDescarte = false;
  if (DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {
    isDescarte = true;
    resposta   = "Aguarda um momento aqui, vou verificar com a equipe e já retorno pra você, tá?";
  }

  const textoLimpo = limparResposta(resposta, persona.nomeExibicao);
  const sent = await dedupAndSend(projetoId, evoConfig, deal, contato, phone, persona, personaChave, textoLimpo, delay);
  if (!sent) return;

  // B16: post-send actions
  // Set _mais_empregos_perguntado when Ana just sent the mais_empregos question
  if (personaChave === "assistente" && merged._mais_empregos_perguntado !== true) {
    const MAIS_EMPREGOS_SENT_RE = /outro lugar|outra empresa|mais emprego|trabalhou antes|emprego anterior/i;
    if (MAIS_EMPREGOS_SENT_RE.test(textoLimpo)) {
      merged._mais_empregos_perguntado = true;
      await persistMergedUpdates(deal.id, merged, { _mais_empregos_perguntado: true });
    }
  }

  // Mark llm_generated flow step as sent so next message advances the step.
  // Use advFlowNextStepChave (the step just advanced to) instead of deal.iaFlowStepChave
  // (stale start-of-request value) — critical when advancing from parecer→valor_estimado
  // so valor_estimado_enviado is set, not parecer_enviado again.
  if (advFlowStepType === "llm_generated" && (advFlowNextStepChave ?? (deal as any).iaFlowStepChave)) {
    const chave = (advFlowNextStepChave ?? (deal as any).iaFlowStepChave) as string;
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { iaFlowStepData: { ...((deal as any).iaFlowStepData ?? {}), [`${chave}_enviado`]: true } } });
  }

  if (PEDIDO_LINK_REGEX.test(text ?? "") && (personaChave === "advogado" || personaChave === "assistente")) {
    resendPropostaLinks(deal.id, projetoId, evoConfig, phone).catch(() => {});
  }

  if (isDescarte) {
    const { moved, justificativa } = await moveToDescarte(projetoId, deal.id, vinculosTodosPrescritos);
    if (moved) {
      const empresa = String(merged.empresa_recente ?? (Array.isArray(merged.vinculos) && (merged.vinculos as any[])[0]?.empresa) ?? "");
      dispararNotificacoes(projetoId, "descarte_revisao_humana", {
        nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone,
        cidade: String(merged.cidade ?? ""), empresa, justificativa,
      }).catch(() => {});
      console.log(`[StageEngine] Deal ${deal.id} → descartado — ${justificativa}`);
    }
    return;
  }

  if ((personaChave === "daniela" || personaChave?.includes("closer") || personaChave === "advogado") && PARECER_KEYWORDS.test(resposta)) {
    sendAudioIfConfigured(projetoId, evoConfig, phone, resposta, personaChave, "parecer", deal.id).catch(() => {});
    const valores: number[] = [];
    let m: RegExpExecArray | null;
    const valorRx = /R\$\s*([\d.,]+)/g;
    while ((m = valorRx.exec(resposta)) !== null) {
      const v = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
      if (!isNaN(v) && v > 1000) valores.push(v);
    }
    if (valores.length > 0) {
      const maiorValor = Math.max(...valores);
      await saveParecerValue(deal.id, resposta, maiorValor);
      criarPropostaAutomatica(projetoId, deal.id, phone, "parecer_enviado").catch(() => {});
      console.log(`[StageEngine] Parecer salvo no deal ${deal.id} — valorEstimado: ${maiorValor}`);
    }
  }

  if (documentosEnviados) {
    criarPropostaAutomatica(projetoId, deal.id, phone, "documentos_pessoais").catch(() => {});
    dispararNotificacoes(projetoId, "documentos_pessoais", { nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone, cidade: String(merged.cidade ?? "") }).catch(() => {});
  }
  if (advFlowNextStepChave === "envio_contrato") criarPropostaAutomatica(projetoId, deal.id, phone, "dados_coletados").catch(() => {});
  if (advFlowNextStepChave === "__done__") {
    dispararNotificacoes(projetoId, "fluxo_concluido", { nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone, cidade: String(merged.cidade ?? ""), cpf: String(merged.cpf ?? (contato as any).cpf ?? "") }).catch(() => {});
  }

  await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
}
