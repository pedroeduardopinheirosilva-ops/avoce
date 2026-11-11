/**
 * Stage Engine — pure orchestrator for incoming WhatsApp messages.
 * Business logic lives in dedicated modules (agent/ directory).
 */

import { prisma } from "../db.js";
import { callLlm } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { detectIdentityQuestion, buildIdentityResponse, registrarEventoIdentidade } from "./identity-handler.js";
import { detectFrustration, buildFrustrationHandling, type FrustrationHandling } from "./frustration-detector.js";
import { buildHandoffSnapshot } from "./handoff-snapshot.js";
import { validarCPF } from "./qualification-utils.js";
import { extractQualificacaoData, extractVinculosFromMerged } from "./qualification.js";
import { buildInstrucaoBase, invalidateFlowCache } from "./persona-router.js";
import { atualizarFotoPerfilEmSegundoPlano, fotoPerfilEstaFresca } from "../services/foto-perfil.js";
import { registrarOrigemDeal } from "./lead-origem.js";
import { variantesTelefone } from "./projeto-resolver.js";
import {
  sendHumanized, sendHumanizedSafe, sendHumanizedOrAudio, normalizarTexto, limparResposta,
  getEvolutionConfig, respondFromDealState, sendAudioIfConfigured, dispararNotificacoes,
  checkAndNotifySolicitaLigacao, type EvolutionConfig,
} from "./message-handler.js";
import { transitionDeal, checkTransitions, enviarMensagemProativa, getPersonaNomeExibicao, applyAutoTags, setEngagementTag } from "./transition-engine.js";
import { sanitizeNomeLead, isNomePlaceholder } from "./nome-lead.js";
import { jaPerguntouEFoiRespondida, ehReenvioDoLead, respostaJaFazPergunta } from "./pergunta-repetida.js";
import { decidirAcaoEmAndamento, isDispensaPorAdvogado, detectaPedidoContato, trechoAdvogadoContraparte, numeroProcessoCnj } from "./sinais-lead.js";
import { classificarConfirmacao, marcarConfirmacao } from "./confirmacao-reuniao.js";
import { criarPropostaAutomatica, resendPropostaLinks, PEDIDO_LINK_REGEX } from "./proposal-engine.js";
import { scheduleLlmRetry } from "./retry-queue.js";
import {
  splitState, atualizarMergedFlags, createInitialDeal, adotarDealSemProjeto, dealGanhoDoContato,
  persistMergedUpdates, moveToDescarte, saveParecerValue,
} from "./deal-repository.js";
import { type EvolutionWebhookMessage, extractText, extractCitacao } from "./webhook-parser.js";
import { normalizeInput } from "./media-processor.js";
import { processVinculos } from "./vinculos-processor.js";
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
  { chave: "vinculo_recente",   perguntaContexto: "Tipo de vínculo trabalhista mais recente: CLT/carteira assinada; informal (motorista subordinado da empresa SEM carteira, ou PJ/MEI forçado — reconhecimento de vínculo, qualifica); autônomo/agregado/TAC (dono do próprio caminhão p/ vários clientes); avulso; cooperado.", tipoDado: "texto" },
];

// ──────────────────────────────────────────────────────────────────────────────
// Local helpers
// ──────────────────────────────────────────────────────────────────────────────

async function findOrCreateDeal(projetoId: string, msg: EvolutionWebhookMessage) {
  const phone = msg.key.remoteJid.replace(/@.*/, "");
  // O telefone pode estar em mais de um contato (contador e empresa cliente
  // dividem o celular) e gravado com ou sem o 9º dígito. Primeiro procura, entre
  // todos eles, o que já tem deal aberto NESTE projeto; só depois cai no primeiro.
  const contatosDoFone = await prisma.crmContato.findMany({
    where: { whatsapp: { in: variantesTelefone(phone) } },
    orderBy: { criadoEm: "asc" },
  });
  let deal = contatosDoFone.length
    ? await prisma.crmDeal.findFirst({
        where: { contatoId: { in: contatosDoFone.map((c) => c.id) }, projetoId, status: "aberto" },
        orderBy: [{ ultimoContatoEm: { sort: "desc", nulls: "last" } }, { criadoEm: "desc" }],
      })
    : null;
  let contato = (deal && contatosDoFone.find((c) => c.id === deal!.contatoId))
    ?? contatosDoFone.find((c) => c.whatsapp === phone)
    ?? contatosDoFone[0]
    ?? null;
  if (!contato) {
    const nomeInicial = sanitizeNomeLead(msg.pushName) ?? `Lead ${phone}`;
    contato = await prisma.crmContato.create({ data: { nome: nomeInicial, whatsapp: phone } });
  }
  // Sem card deste projeto: antes de criar, adota o card aberto sem projeto do mesmo
  // lead (importado/cadastrado à mão). Sem mensagem nenhuma ainda, conta como novo
  // para a saudação; com histórico, a conversa só continua.
  let isNewDeal = !deal;
  if (!deal) {
    const ganho = await dealGanhoDoContato(projetoId, contatosDoFone.map((c) => c.id));
    if (ganho) {
      deal = ganho;
      contato = contatosDoFone.find((c) => c.id === ganho.contatoId) ?? contato;
      isNewDeal = false;
      console.log(`[StageEngine] dealId=${ganho.id} — cliente ganho voltou a falar (${phone}); mensagem no card ganho, sem IA`);
    }
  }
  if (!deal) {
    const adotado = await adotarDealSemProjeto(projetoId, contatosDoFone.map((c) => c.id));
    if (adotado) {
      deal = adotado;
      contato = contatosDoFone.find((c) => c.id === adotado.contatoId) ?? contato;
      isNewDeal = (await prisma.crmMensagemWhatsapp.count({ where: { dealId: adotado.id } })) === 0;
      console.log(`[StageEngine] dealId=${adotado.id} — card sem projeto adotado para ${phone}`);
    }
  }
  if (!deal) deal = await createInitialDeal(projetoId, contato.id, contato.nome);
  return { contato, deal, isNewDeal };
}

async function saveIncomingMessage(
  deal: { id: string }, contato: { id: string }, msg: EvolutionWebhookMessage,
  text: string | null, tipo: string, saveOnly: boolean,
): Promise<"duplicate" | "early_path" | "ok"> {
  try {
    await prisma.crmMensagemWhatsapp.create({
      data: { dealId: deal.id, contatoId: contato.id, direcao: "in", remetente: msg.key.remoteJid.replace(/@.*/, ""), tipo, conteudo: text ?? "", evolutionMessageId: msg.key.id, ...(extractCitacao(msg) ?? {}) },
    });
    // Toda mensagem recebida é contato — inclusive quando a IA está pausada e quem responde é
    // um atendente pelo celular. Sem isso o deal fica com ultimoContatoEm congelado, afunda na
    // ordenação da caixa de conversas e a mensagem some do painel mesmo estando gravada.
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
    return "ok";
  } catch (err: any) {
    if (err?.code !== "P2002") throw err;
    if (saveOnly) { console.log(`[StageEngine] Mensagem ${msg.key.id} já processada — ignorando duplicata`); return "duplicate"; }
    if (text) await prisma.crmMensagemWhatsapp.updateMany({ where: { evolutionMessageId: msg.key.id, dealId: deal.id }, data: { conteudo: text, tipo } });
    // Duplicate webhook: only allow re-processing if no reply was sent in last 120s
    const recentReply = await prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId: deal.id, direcao: "out", enviadaEm: { gte: new Date(Date.now() - 120_000) } },
      orderBy: { enviadaEm: "desc" },
    });
    if (recentReply) {
      console.log(`[StageEngine] Mensagem ${msg.key.id} duplicada — resposta já enviada em ${recentReply.enviadaEm.toISOString()} — ignorando`);
      return "duplicate";
    }
    return "early_path";
  }
}

/** Só nos projetos com `detectar_advogado_contraparte`=true: em funil de empresa (subvenção,
 *  contadores) o advogado da empresa pode ser justamente o lead. Cache de 5 min. */
const _contraparteCache = new Map<string, { v: boolean; em: number }>();
async function detectaContraparteLigado(projetoId: string): Promise<boolean> {
  const c = _contraparteCache.get(projetoId);
  if (c && Date.now() - c.em < 300_000) return c.v;
  const cfg = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "detectar_advogado_contraparte" } });
  const v = cfg?.valor === "true";
  _contraparteCache.set(projetoId, { v, em: Date.now() });
  return v;
}

/**
 * Advogado da parte contrária: pausa a IA, marca o card (etiqueta + flag + nota) e avisa a
 * equipe (evento `advogado_contraparte`). Nenhuma mensagem automática vai para ele.
 */
async function tratarAdvogadoContraparte(projetoId: string, deal: any, contato: any, phone: string, texto: string, trecho: string) {
  const flags = { ...((deal.iaFlags as Record<string, unknown>) ?? {}), _contraparte: true };
  const processo = numeroProcessoCnj(texto);
  const empresaId = deal.empresaId ?? null;
  const NOME_TAG = "Advogado (acordo)";
  const tag = await prisma.crmTag.findFirst({ where: { nome: NOME_TAG, empresaId } })
    ?? await prisma.crmTag.create({ data: { nome: NOME_TAG, empresaId, cor: "#b45309" } });
  await prisma.crmDeal.update({
    where: { id: deal.id },
    data: { iaAtiva: false, iaPausadaEm: new Date(), iaFlags: flags as any, tags: { connect: { id: tag.id } } },
  });
  await prisma.crmNota.create({
    data: {
      dealId: deal.id,
      conteudo: `[IA] Advogado(a) da outra parte — não é lead. IA pausada, sem resposta automática.\nTrecho: "${trecho}"${processo ? `\nProcesso: ${processo}` : ""}`,
    },
  });
  console.log(`[StageEngine] dealId=${deal.id} — advogado da parte contrária (${phone}): "${trecho.slice(0, 80)}"`);
  dispararNotificacoes(projetoId, "advogado_contraparte", {
    dealId: deal.id, nome: contato?.nome ?? "", telefone: phone,
    mensagem: texto.slice(0, 500), processo: processo ?? "não informado",
  }).catch((err) => console.warn(`[StageEngine] aviso advogado_contraparte falhou: ${err?.message ?? err}`));
}

async function handleNewDealGreeting(projetoId: string, deal: any, contato: any, phone: string) {
  if (await prisma.crmMensagemWhatsapp.count({ where: { dealId: deal.id, direcao: "out" } }) > 0) return;
  const { getGreetingStep } = await import("./flow-controller.js");
  const modoSdr = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "modo_sdr" } });
  const greetingFase = modoSdr?.valor === "simples" ? "sdr_simples"
    : modoSdr?.valor === "triagem" ? "triagem"
    : "pre_vinculos";
  const greetingText = await getGreetingStep(projetoId, greetingFase).catch(() => null);
  if (!greetingText) { await enviarMensagemProativa(projetoId, deal.id, phone, "primeira_mensagem", ""); return; }
  const evoConf = await getEvolutionConfig(projetoId);
  if (!evoConf) return;

  // Send persona intro media (photo/video) before greeting text if configured
  const personaChaveInicial = deal.iaPersonaChave ?? "assistente";
  const personaMediaData = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChaveInicial } },
    select: { id: true, midiaApresentacaoPath: true, midiaApresentacaoTipo: true },
  });
  if (personaMediaData?.midiaApresentacaoPath) {
    const { sendImage: sendImg, sendVideo: sendVid } = await import("../services/evolution.js");
    const mediaUrl = `${process.env.APP_BASE_URL ?? "https://avoce.capium.com.br"}/api/ia-persona-midia/${personaMediaData.id}`;
    try {
      if (personaMediaData.midiaApresentacaoTipo === "video") {
        await sendVid(evoConf, phone, mediaUrl);
      } else {
        await sendImg(evoConf, phone, mediaUrl);
      }
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.warn("[Greeting] Erro ao enviar mídia da persona:", err);
    }
  }

  // Resolve persona name placeholders in the greeting text
  const [greetPersonaNome, greetAdvNome, greetSecNome, greetAssistNome] = await Promise.all([
    getPersonaNomeExibicao(projetoId, personaChaveInicial),
    getPersonaNomeExibicao(projetoId, "advogado"),
    getPersonaNomeExibicao(projetoId, "secretaria"),
    getPersonaNomeExibicao(projetoId, "assistente"),
  ]);
  let resolvedGreeting = greetingText
    .replace(/\{nome_persona\}/g, greetPersonaNome)
    .replace(/\{nome_advogado\}/g, greetAdvNome)
    .replace(/\{nome_secretaria\}/g, greetSecNome)
    .replace(/\{nome_assistente\}/g, greetAssistNome);
  const h    = parseInt(new Date().toLocaleString("pt-BR", { hour: "numeric", timeZone: "America/Sao_Paulo", hour12: false }), 10);
  const saud = h >= 5 && h < 12 ? "Bom dia" : h >= 12 && h < 18 ? "Boa tarde" : "Boa noite";
  const msg  = `*${greetPersonaNome}*\n${saud}! ${resolvedGreeting}`;
  const qualAtual = { ...(deal.qualificacao as Record<string, unknown> ?? {}), ...((deal as any).iaFlags as Record<string, unknown> ?? {}), _saudacao_enviada: true };
  await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(qualAtual) });
  await sendHumanized(evoConf, phone, msg, 1500 + Math.random() * 1500);
  await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", tipo: "text", conteudo: msg } });
  await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
}

async function extractAndApplyQual(
  projetoId: string, deal: any, contato: any,
  merged: Record<string, unknown>, history: any[], perguntas: any[],
  personaChave: string, text: string | null, personaLlmChave: string | null = null,
): Promise<{ merged: Record<string, unknown>; contato: any; dadosNovos: number; ack: boolean }> {
  const charsUteis = (text ?? "").replace(/\s/g, "").length;
  if (charsUteis < 2 || ACKS_REGEX.test((text ?? "").trim())) return { merged, contato, dadosNovos: 0, ack: true };

  // Regex pre-check for e_carreteiro: detect taxi/autonomous drivers before LLM extraction.
  // The LLM returns null for ambiguous cases (taxi *can* be CLT), so this hardcoded check
  // ensures the nao_carreteiro gate fires immediately for known non-qualifying driver types.
  if ((merged.e_carreteiro === undefined || merged.e_carreteiro === null) && text) {
    const textNorm = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    // Perfis TERMINAIS — não são motoristas profissionais de carga/passageiro. Descarta por perfil
    // (gate nao_carreteiro dispara de imediato). "de frete" é exceção: caminhoneiro por app de frete.
    const NAO_CARRETEIRO_RE = /\b(taxista|taxi|motorista\s+de\s+taxi|mototaxi|motoboy|entregador\s+(ifood|rappi|motoboy|de\s+aplicativo)|ifood\b|rappi\b|carro\s+proprio|dono\s+de\s+frota|dono\s+da\s+frota|proprietario\s+de\s+frota)\b/i;
    // Motoristas de app de passageiro (Uber/99/inDriver/"motorista de aplicativo"): SÃO motoristas,
    // porém autônomos. NÃO descarta por perfil — marca e_clt=false para o fluxo investigar um CLT
    // carreteiro anterior (pivot mais_empregos) antes do gate vinculo_invalido decidir. (BUG-002/A4)
    const APP_AUTONOMO_RE = /\b(uber|99\s*(driver|app)?|indriver|motorista\s+de\s+aplicativo(?!\s+de\s+frete))\b/i;
    if (NAO_CARRETEIRO_RE.test(textNorm)) {
      merged.e_carreteiro = false;
      await persistMergedUpdates(deal.id, merged, { e_carreteiro: false });
    } else if (APP_AUTONOMO_RE.test(textNorm)) {
      // Motorista de app é motorista (não descarta por perfil). Marca flag para o gate
      // nao_carreteiro NÃO disparar mesmo que o LLM classifique e_carreteiro=false — a eventual
      // desqualificação é por vínculo (vinculo_invalido), após investigar um CLT anterior.
      const patch: Record<string, unknown> = { _app_autonomo_recente: true };
      merged._app_autonomo_recente = true;
      if (merged.e_clt === undefined || merged.e_clt === null) { merged.e_clt = false; patch.e_clt = false; }
      await persistMergedUpdates(deal.id, merged, patch);
    }
  }

  const pendentes = perguntas.filter(p => merged[p.chave] === undefined || merged[p.chave] === null);
  if (personaChave === "advogado") {
    for (const h of HINTS_ADVOGADO) { if (merged[h.chave] == null && !pendentes.find((p: any) => p.chave === h.chave)) pendentes.push(h as any); }
  }
  if (personaChave === "assistente") {
    for (const h of HINTS_ASSISTENTE) { if (merged[h.chave] == null && !pendentes.find((p: any) => p.chave === h.chave)) pendentes.push(h as any); }
  }
  if (!pendentes.length) return { merged, contato, dadosNovos: 0, ack: false };
  const texto     = history.slice(-16).map(m => `${m.direcao === "out" ? "Bot" : "Cliente"}: ${m.conteudo ?? ""}`).filter(l => l.length > 6).join("\n");
  const extracted = await extractQualificacaoData(projetoId, texto || `Cliente: ${text ?? ""}`, pendentes, merged, personaLlmChave).catch(() => null);
  if (!extracted) return { merged, contato, dadosNovos: 0, ack: false };
  const novos: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extracted)) {
    if (v != null && (merged[k] === undefined || merged[k] === null)) { merged[k] = v; novos[k] = v; }
  }
  // Clear emprego_anterior_* if lead has no previous job
  const semAnterior = merged.tem_emprego_anterior;
  if (semAnterior === false || semAnterior === "false" || semAnterior === "não" || semAnterior === "nao" || semAnterior === "no") {
    for (const k of Object.keys(merged)) {
      if (k.startsWith("emprego_anterior_")) { delete merged[k]; delete novos[k]; }
    }
  }
  if (!Object.keys(novos).length) return { merged, contato, dadosNovos: 0, ack: false };
  await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) });
  prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] Qualificação:\n${Object.entries(novos).map(([k, v]) => `${k}: ${v}`).join("\n")}` } }).catch(() => {});
  if (novos.nome && typeof novos.nome === "string") {
    // Nunca gravar o nome cru da extração: ASR quebrado já transformou
    // "What the me oftension da Cunha de Maceió" em um contato chamado "What".
    const nome = sanitizeNomeLead(novos.nome);
    if (nome) {
      await prisma.crmContato.update({ where: { id: contato.id }, data: { nome } });
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { titulo: nome } });
      contato = { ...contato, nome };
    } else {
      console.log(`[Nome] dealId=${deal.id} — descartado ${JSON.stringify(novos.nome)} (não parece nome)`);
      delete merged.nome;                                  // deixa o campo pendente → repergunta
      await prisma.$executeRaw`UPDATE "CrmDeal" SET qualificacao = qualificacao - 'nome' WHERE id = ${deal.id}`;
    }
  }
  for (const [src, dst] of [["empresa_recente", "empresa_principal"], ["frota_recente", "frota"]] as [string, string][]) {
    if (merged[src] && !merged[dst]) { merged[dst] = merged[src]; await prisma.crmDeal.update({ where: { id: deal.id }, data: splitState(merged) }); }
  }
  return { merged, contato, dadosNovos: Object.keys(novos).length, ack: false };
}

async function callLlmWithRetry(
  projetoId: string, dealId: string, systemPrompt: string,
  messages: { role: "user" | "assistant"; content: string }[],
  personaChave: string, llmChave: string | null, stageChave: string,
  allowLong = false,
  // modo_sdr "generico": o lead pede explicação (serviço, currículo, programa) e a
  // resposta precisa caber. O corte de 3 frases/420 chars é do carreteiro e, com a
  // ordem "mantenha apenas a pergunta principal", transformava a explicação em pergunta.
  generico = false,
): Promise<string> {
  const msgs = [...messages];
  let last   = "";
  for (let i = 0; i < 3; i++) {
    const r  = (await callLlm({ projetoId, dealId, systemPrompt, messages: msgs, personaChave, personaLlmChave: llmChave, stageChave, maxTokens: 2048 })).content.trim();
    last     = r;
    if (allowLong) {
      if (isHumanized(r)) return r;
      msgs.push({ role: "assistant", content: r });
      msgs.push({ role: "user", content: "Reescreva sem padrões robóticos. Mantenha todos os blocos." });
      continue;
    }
    const sentencas  = r.split(/[.!?](?:\s|$)/).filter(s => s.trim().length > 0).length;
    const muitoLonga = generico ? (r.length > 900 || sentencas > 7) : (r.length > 420 || sentencas > 3);
    if (isHumanized(r) && !muitoLonga) return r;
    msgs.push({ role: "assistant", content: r });
    msgs.push({ role: "user", content: muitoLonga
      ? (generico
          ? "Mensagem longa demais. Reescreva em até 5 linhas, mantendo a resposta ao que o lead perguntou ou pediu."
          : "Mensagem longa demais. Reescreva em no máximo 2 frases curtas e simples. Mantenha apenas a pergunta principal.")
      : "Reescreva sem padrões robóticos." });
  }
  return last;
}

function applyDeterministicOverride(
  resposta: string, nextQ: string, merged: Record<string, unknown>, text: string | null, dealId: string,
  personaNome: string = "",
  extraSubstitutions: Record<string, string> = {},
): string {
  // Resolve {nome} placeholder with first name from merged
  const nome = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
  let resolvedNextQ = (nome
    ? nextQ.replace(/\{nome\}/g, nome)
    : nextQ.replace(/\{nome\},?\s*/g, ""))
    .replace(/\{nome_persona\}/g, personaNome);
  for (const [k, v] of Object.entries(extraSubstitutions)) {
    resolvedNextQ = resolvedNextQ.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  }

  if (!merged._saudacao_enviada) {
    const h    = parseInt(new Date().toLocaleString("pt-BR", { hour: "numeric", timeZone: "America/Sao_Paulo", hour12: false }), 10);
    const saud = h >= 5 && h < 12 ? "Bom dia" : h >= 12 && h < 18 ? "Boa tarde" : "Boa noite";
    console.log(`[DeterministicQ] dealId=${dealId} greeting`);
    return `${saud}! ${resolvedNextQ}`;
  }
  const isDisqualification = /não vamos conseguir|ética profissional|finalizar o atendimento|prazo já passou|prazo expirou|não podemos assumir|infelizmente.*prazo|obrigad.*contato/i.test(resposta);
  if (isDisqualification) { console.log(`[DeterministicQ] dealId=${dealId} override skipped — disqualification`); return resposta; }
  console.log(`[DeterministicQ] dealId=${dealId} nextQ="${resolvedNextQ.slice(0, 60)}"`);
  // Always use the deterministic question — never mix with LLM response.
  // LLM response mixing caused hallucinated questions (e.g. plataforma_anuncio) to appear
  // alongside legitimate deterministic questions when the lead's message contained legal keywords.
  return resolvedNextQ;
}

async function dedupAndSend(
  projetoId: string, evoConfig: EvolutionConfig,
  deal: { id: string }, contato: { id: string }, phone: string,
  persona: { nomeExibicao: string; usarAudio?: boolean; ttsVoiceId?: string | null }, personaChave: string,
  textoLimpo: string, readDelay: number,
): Promise<boolean> {
  const since = new Date(Date.now() - 120_000);
  const exact = await prisma.crmMensagemWhatsapp.findFirst({ where: { dealId: deal.id, direcao: "out", conteudo: textoLimpo, enviadaEm: { gte: since } } });
  if (exact) {
    // Allow re-send if the lead replied after we sent this message (they deserve a response).
    const incomingAfter = await prisma.crmMensagemWhatsapp.findFirst({
      where: { dealId: deal.id, direcao: "in", enviadaEm: { gt: exact.enviadaEm } },
    });
    if (!incomingAfter) { console.log(`[StageEngine] Dedup exato: "${textoLimpo.slice(0, 60)}..." — ignorando`); return false; }
  }
  const last  = await prisma.crmMensagemWhatsapp.findFirst({ where: { dealId: deal.id, direcao: "out", enviadaEm: { gte: since } }, orderBy: { enviadaEm: "desc" } });
  if (last) {
    const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    if (norm(last.conteudo ?? "").includes(norm(textoLimpo).slice(0, 60))) {
      // Same check: allow if lead replied after
      const incomingAfterSemantic = await prisma.crmMensagemWhatsapp.findFirst({
        where: { dealId: deal.id, direcao: "in", enviadaEm: { gt: last.enviadaEm } },
      });
      if (!incomingAfterSemantic) { console.log(`[StageEngine] Dedup semântico — ignorando`); return false; }
    }
  }

  // Áudio ElevenLabs: envia um único áudio (ignora split por "---")
  if (persona.usarAudio && persona.ttsVoiceId) {
    const { sent: audioSent, tipoEnvio } = await sendHumanizedOrAudio(
      projetoId, evoConfig, phone, textoLimpo, readDelay,
      persona, { deal, persona: { chave: personaChave, nomeExibicao: persona.nomeExibicao }, projetoId },
    );
    if (!audioSent) return false;
    await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: tipoEnvio, conteudo: textoLimpo } });
    return true;
  }

  // Multi-message support: "---" (with any surrounding whitespace) splits into sequential WhatsApp bubbles
  const multiParts = textoLimpo.split(/\s+---\s+|\n\s*---\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  if (multiParts.length > 1) {
    for (let i = 0; i < multiParts.length; i++) {
      const part = multiParts[i];
      const delay = i === 0 ? readDelay : 0;
      const sent = await sendHumanizedSafe(evoConfig, phone, `*${persona.nomeExibicao}*\n${part}`, delay, { deal, persona: { chave: personaChave, nomeExibicao: persona.nomeExibicao }, projetoId });
      if (!sent && i === 0) return false;
      if (sent) await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: part } });
    }
    return true;
  }
  const sent = await sendHumanizedSafe(evoConfig, phone, `*${persona.nomeExibicao}*\n${textoLimpo}`, readDelay, { deal, persona: { chave: personaChave, nomeExibicao: persona.nomeExibicao }, projetoId });
  if (!sent) return false;
  await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: textoLimpo } });
  return true;
}

// proximaPersonaChave só vale se a persona de destino existir e estiver ativa em Config IA.
// Sem isso o deal era entregue a uma persona desligada (ex.: Daniela) e a conversa morria
// no meio, ou o cron respondia no nome dela.
async function proximaPersonaAtiva(projetoId: string, chave: string | null | undefined): Promise<boolean> {
  if (!chave) return false;
  const p = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave } }, select: { ativo: true } });
  if (!p?.ativo) {
    console.log(`[StageEngine] proximaPersonaChave="${chave}" desativada/inexistente — sem handoff`);
    return false;
  }
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

// Per-deal processing lock: prevents duplicate LLM calls when Evolution API
// sends two webhooks for the same audio message (common with LID addressingMode).
// Complements the per-phone debounce in index.ts.
const _dealProcessingSet = new Set<string>();

export async function processIncomingMessage(
  projetoId: string,
  msg: EvolutionWebhookMessage,
  saveOnly = false,
): Promise<void> {
  const phone = msg.key.remoteJid.replace(/@.*/, "");
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid.endsWith("@broadcast") || msg.key.remoteJid.endsWith("@g.us")) return;

  // /reset command: clears deal state for testing without deleting contact or CRM history
  const rawText = extractText(msg)?.trim() ?? "";
  if (rawText === "/reset") {
    const { deal: resetDeal } = await findOrCreateDeal(projetoId, msg);
    await prisma.crmMensagemWhatsapp.deleteMany({ where: { dealId: resetDeal.id } });
    await prisma.crmDeal.update({
      where: { id: resetDeal.id },
      data: {
        qualificacao: {},
        iaStageChave: null,
        iaPersonaChave: null,
        iaAtiva: true,
        iaFlowStepChave: null,
        iaFlowStepData: {},
        iaFlags: {},
        closerTentativas: 0,
        docsConfirmados: false,
      },
    });
    const evo = await getEvolutionConfig(projetoId);
    if (evo) {
      const { sendText } = await import("../services/evolution.js");
      await sendText(evo, phone, "✅ Conversa resetada. Mande uma mensagem para começar do zero.");
    }
    console.log(`[Reset] dealId=${resetDeal.id} phone=${phone}`);
    return;
  }

  // B1: normalize input (audio transcription / OCR)
  const { text, documentosEnviados, docJsonDireto, tipo, isDocAnalitico, mediaBuffer, mediaMimetype, mediaOriginalName, midiaUrl } = await normalizeInput(projetoId, msg);

  // B2: find or create contact + deal
  const { contato: c0, deal: d0, isNewDeal } = await findOrCreateDeal(projetoId, msg);
  let contato = c0, deal = d0;

  // Origem (anúncio/plataforma) — só existe na 1ª mensagem; grava uma vez por deal.
  if (!(deal as any).origemEm || (deal as any).origemAnuncioId === "perfil") await registrarOrigemDeal(deal, msg);

  // Foto de perfil do WhatsApp — em segundo plano, nunca atrasa a resposta ao lead.
  if (!fotoPerfilEstaFresca(contato.fotoPerfilEm)) {
    getEvolutionConfig(projetoId)
      .then((evo) => atualizarFotoPerfilEmSegundoPlano(contato, evo))
      .catch(() => {});
  }

  // B2b: per-deal lock — prevents two parallel processings when Evolution sends
  // duplicate webhooks for the same audio (different IDs, same content — LID mode).
  // Mensagens distintas que chegam durante o processamento NÃO podem ser descartadas
  // (lead digitando rápido perdia mensagens — nem persistidas ficavam): espera a vez.
  let aguardouLock = false;
  if (_dealProcessingSet.has(deal.id)) {
    const LOCK_WAIT_MS = 500, LOCK_TIMEOUT_MS = 90_000;
    let waited = 0;
    while (_dealProcessingSet.has(deal.id) && waited < LOCK_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, LOCK_WAIT_MS));
      waited += LOCK_WAIT_MS;
    }
    if (_dealProcessingSet.has(deal.id)) {
      // Lock não liberou — pelo menos persiste a mensagem para não perder histórico.
      console.log(`[StageEngine] dealId=${deal.id} — lock não liberou em ${LOCK_TIMEOUT_MS}ms; salvando msg sem processar`);
      await saveIncomingMessage(deal, contato, msg, text, tipo, true);
      return;
    }
    aguardouLock = true;
  }
  // Claim ANTES de qualquer await — entre o fim do while e esta linha não há ponto de
  // suspensão, então dois waiters não podem reivindicar o lock ao mesmo tempo.
  _dealProcessingSet.add(deal.id);
  if (aguardouLock) {
    // Estado do deal pode ter mudado enquanto esperava (stage/persona/qualificacao) — recarrega.
    const freshDeal = await prisma.crmDeal.findUnique({ where: { id: deal.id } });
    if (freshDeal) deal = freshDeal as typeof deal;
  }

  try {

  // B3: save incoming (atomic dedup guard via unique evolutionMessageId)
  const saveResult = await saveIncomingMessage(deal, contato, msg, text, tipo, saveOnly);
  if (saveResult === "duplicate" || saveOnly) { _dealProcessingSet.delete(deal.id); return; }

  // B3b: persist midiaUrl for audio playback (always upsert so early-path messages also get it)
  if (midiaUrl && msg.key.id) {
    await prisma.crmMensagemWhatsapp.updateMany({
      where: { evolutionMessageId: msg.key.id, dealId: deal.id },
      data: { midiaUrl },
    });
  }

  // B3c: arquivar documento/foto recebido — ANTES de qualquer guard.
  // Ficava lá embaixo, depois de `if (!deal.iaAtiva) return`, do `isNewDeal` e do guard de
  // fase que exige ação humana: com a IA pausada (atendimento humano) ou no primeiro contato,
  // a foto do cliente era baixada, passava pelo OCR e ia pro lixo. Só 20 de 171 mídias de 30
  // dias viraram DealAnexo. O anexo guarda ocrTexto + dadosExtraidos, então o coleta_docs
  // recupera os campos depois via loadColetaDocsContext, mesmo do que chegou fora do fluxo.
  if (documentosEnviados) {
    if (mediaBuffer && mediaBuffer.length > 0) {
      import("./deal-anexos.js").then(({ salvarAnexoDeal }) => {
        const ocrFull = typeof text === "string" && text.startsWith("[Documento recebido") ? text : null;
        salvarAnexoDeal(deal.id, mediaBuffer!, mediaMimetype ?? "application/octet-stream", mediaOriginalName, ocrFull, docJsonDireto)
          .catch((err: unknown) => console.warn(`[DealAnexo] Erro ao salvar dealId=${deal.id}: ${(err as any)?.message}`));
      }).catch((err: unknown) => console.warn(`[DealAnexo] Import falhou: ${(err as any)?.message}`));
    } else {
      console.warn(`[DealAnexo] Skipped dealId=${deal.id} — mediaBuffer ausente (download falhou ou Evolution API sem mídia)`);
    }
  }

  // B3c2: advogado da outra parte (empresa/reclamada) se apresentando para tratar de acordo.
  // Não é lead: a IA não saúda nem qualifica — o card fica com a IA pausada, etiqueta e aviso
  // no grupo da equipe. Vale em qualquer mensagem enquanto a IA está ligada (às vezes o
  // "boa tarde" vem antes e a apresentação na 2ª mensagem).
  if (deal.status === "aberto" && deal.iaAtiva && !((deal as any).iaFlags as any)?._contraparte
      && await detectaContraparteLigado(projetoId)) {
    const trechoAdv = trechoAdvogadoContraparte(text);
    if (trechoAdv) {
      await tratarAdvogadoContraparte(projetoId, deal, contato, phone, text ?? "", trechoAdv);
      return;
    }
  }

  // B3d: reenvio do lead — o mesmo texto de novo, segundos depois, quando a IA já respondeu o
  // primeiro. Fica salvo no histórico, mas não gera resposta: senão a IA refaz a pergunta que
  // acabou de mandar (caso Cigano 04/11: "Mas de 200" ×2 → "Anotado, mais de 200. E antes da Buzin...").
  if (!isNewDeal && !documentosEnviados && (text ?? "").trim().length > 0) {
    const recentes = await prisma.crmMensagemWhatsapp.findMany({
      where: { dealId: deal.id },
      orderBy: { enviadaEm: "desc" },
      take: 8,
      select: { direcao: true, conteudo: true, transcricao: true, enviadaEm: true, evolutionMessageId: true },
    });
    if (ehReenvioDoLead(recentes, msg.key.id)) {
      console.log(`[StageEngine] dealId=${deal.id} — lead reenviou a mesma mensagem ("${(text ?? "").slice(0, 40)}"); sem nova resposta`);
      return;
    }
  }

  // B4: new deal → greet and stop
  if (isNewDeal) { await handleNewDealGreeting(projetoId, deal, contato, phone); return; }

  // B5: guards
  // Na coleta de documentos, "assumir a conversa" é ajuda pontual, não handoff:
  // o atendente entra para explicar como tirar o comprovante, o cliente manda o
  // documento — e antes disto o fluxo ficava morto até alguém lembrar de clicar
  // em reativar. A chegada do documento é sinal inequívoco de que o cliente fez
  // o que foi pedido, então a máquina retoma sozinha. Mensagem de texto NÃO
  // retoma: enquanto o atendente conversa, o bot continua calado.
  if (!deal.iaAtiva && deal.status === "aberto" && deal.iaPersonaChave === "coleta_docs" && documentosEnviados) {
    await prisma.crmDeal.update({
      where: { id: deal.id },
      data: { iaAtiva: true, iaPausadaEm: null, iaPausadaPor: null },
    });
    deal = { ...deal, iaAtiva: true } as typeof deal;
    console.log(`[ColetaDocs] dealId=${deal.id} — documento recebido durante intervenção manual; coleta retomada`);
  }
  if (!deal.iaAtiva) return;
  // pushName do WhatsApp também é palpite: vem como "Marcell | 7227", "~Junior 😎", "Cliente".
  if (msg.pushName && isNomePlaceholder(contato.nome)) {
    const nomePush = sanitizeNomeLead(msg.pushName);
    if (nomePush) {
      await prisma.crmContato.update({ where: { id: contato.id }, data: { nome: nomePush } });
      contato = { ...contato, nome: nomePush };
    }
  }

  // B6: load stage, persona, history, questions
  const stageChave   = deal.iaStageChave || "lead_carreteiro";
  const fase         = await prisma.iaFaseFunil.findUnique({ where: { projetoId_chave: { projetoId, chave: stageChave } } });
  // Flow-controlled personas (secretaria, advogado, coleta_docs) are fully autonomous even
  // when the stage has requerAcaoHumana=true. The deal.iaPersonaChave being set means a flow
  // is in progress and must finish regardless of the stage's human-action flag.
  // Example: aguardando_reuniao has requerAcaoHumana=true but secretaria/advogado must still run.
  const AUTONOMOUS_PERSONAS = new Set(["coleta_docs", "secretaria", "advogado"]);
  const autonomousPersonaOverride = !!deal.iaPersonaChave && AUTONOMOUS_PERSONAS.has(deal.iaPersonaChave);
  if (!fase || (fase.requerAcaoHumana && !autonomousPersonaOverride)) return;
  let personaChave = deal.iaPersonaChave || fase.personaChave || "assistente";
  let persona      = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave: personaChave } } });
  if (!persona) return;
  // Persona desligada em Config IA → Personas: ela não fala mais sozinha. O deal
  // continua vivo e a conversa fica com a equipe. É o desligamento por persona,
  // e não do projeto inteiro, que ficaria grosso demais.
  if (!persona.ativo) {
    console.log(`[StageEngine] dealId=${deal.id} — persona "${personaChave}" desativada; IA não responde`);
    return;
  }
  const historyRaw   = await prisma.crmMensagemWhatsapp.findMany({ where: { dealId: deal.id }, orderBy: { enviadaEm: "desc" }, take: 20 });
  const history      = historyRaw.reverse();
  // modo_sdr "generico": a etapa não anda pelo fluxo (fica em lead_novo / em_contato), então
  // filtrar as perguntas pela etapa deixava a extração vazia — e-mail e horário nunca gravavam.
  // Nesses funis toda pergunta do projeto vale em qualquer etapa.
  const modoSdrExtracao = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "modo_sdr" }, select: { valor: true } });
  const extracaoGenerica = modoSdrExtracao?.valor === "generico";
  const perguntas    = await prisma.iaPerguntaQualificacao.findMany({
    where: { projetoId, ativo: true, ...(extracaoGenerica ? {} : { stageColeta: stageChave }) },
    orderBy: { ordem: "asc" },
  });
  // GARANTIA DE IDEMPOTÊNCIA: `merged` é sempre construído a partir do banco
  // (deal.qualificacao + deal.iaFlags persistidos). Isso garante que
  // getNextDeterministicQuestion nunca repergunta um campo já persistido,
  // mesmo que a resposta tenha chegado por áudio em uma mensagem anterior.
  let merged: Record<string, unknown> = { ...(deal.qualificacao as Record<string, unknown> ?? {}), ...((deal as any).iaFlags as Record<string, unknown> ?? {}) };
  const outgoingCount = history.filter(m => m.direcao === "out").length;

  // Silenciar mensagens curtas após reunião confirmada — evita que "ok"/"aguardo"/"blz" etc.
  // gerem respostas de Ana/Daniela antes da cadeia proativa iniciar.
  // Exceção: coleta_docs responde perguntas curtas (e.g. "casado", "motorista").
  if (merged._reuniao_criada === true && personaChave !== "coleta_docs") {
    const txtSilencio = (text ?? "").trim();
    const isCancelamento = /cancelar|cancela|desmarcar|desmarca|reagendar|remarcar|n[aã]o\s+(vou|consigo|virei|posso)\s+(ir|comparecer|participar)/i.test(txtSilencio);
    if (txtSilencio.length < 30 && !txtSilencio.includes("?") && !isCancelamento) {
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
      console.log(`[StageEngine] dealId=${deal.id} — mensagem curta silenciada após reunião confirmada`);
      return;
    }
    // Se é cancelamento, deixar passar para o LLM responder naturalmente E avisar o SDR humano
    // imediatamente — uma ligação nesse momento segura a reunião melhor que qualquer mensagem.
    if (isCancelamento && merged._notif_remarcar_at == null) {
      const { buildLeadBriefing } = await import("./lead-briefing.js");
      const briefingRemarcar = await buildLeadBriefing(deal.id, {
        titulo: "⚠ QUER REMARCAR/CANCELAR REUNIÃO",
        acao: "LIGAR AGORA para segurar a reunião ou reagendar por voz",
      }).catch(() => "");
      dispararNotificacoes(projetoId, "reuniao_remarcar", {
        nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone, briefing: briefingRemarcar, dealId: deal.id,
      }).catch(() => {});
      merged._notif_remarcar_at = Date.now();
      await atualizarMergedFlags(deal.id, merged, { _notif_remarcar_at: merged._notif_remarcar_at });
    }
  }

  // B7: early returns — identity + frustration
  const msgNorm = normalizarTexto(text ?? "");
  // Complex question (contains "?"): don't return early — inject identity data into system
  // prompt so the LLM can answer BOTH the legitimacy concern AND the original question.
  // Simple identity statement (no "?"): respond directly with factual template.
  // Pergunta REAL do lead = só quando há um marcador interrogativo claro. Um "?" sozinho não
  // basta: "ainda tô na empresa, né? tô querendo sair" tem "?" mas NÃO é pergunta (é tag retórica
  // no meio da frase). O caminho determinístico é o PADRÃO; o LLM só assume quando o lead realmente
  // pergunta algo (ou objeção real, tratada pelo frustration-detector). Sem isso, o "né?" do lead
  // ativava o modo "LLM responde + anexa próxima pergunta" e duplicava a próxima pergunta.
  const _qNorm = (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const _temInterrogativo = /\b(qual|quais|quanto|quantos|quanta|quantas|quando|como|onde|aonde|quem|por\s*que|porque|pra\s*que|para\s*que|o\s*que|cade|sera|posso|pode|podem|poderia|poderiam|teria|tem\s|tem\s+como|tem\s+que|da\s+pra|da\s+para|e\s+possivel|consigo|conseguem?|vai\s|vao\s|vou\s|preciso|precisa|precisam|quanto\s+tempo|e\s+se|e\s+quando|e\s+como|e\s+quanto|que\s+horas|vcs?\s+(vao|podem|tem|cobram)|voces?\s+(vao|podem|tem|cobram)|cobra|cobram|custa|custo)\b/.test(_qNorm);
  const isPerguntaComplexa = !!text && text.includes("?") && text.trim().length > 8 && _temInterrogativo;
  // Objeção/receio do lead (mesmo SEM "?"): custo, golpe, medo, demora, procrastinação, recusa de reunião.
  // Sem isto, objeções sem interrogação eram ignoradas e a próxima pergunta era enviada verbatim.
  // Regex focada para NÃO colidir com respostas de qualificação (ex.: "não tenho advogado" ≠ "já tenho advogado").
  const isObjecao = !!text && /\b(nao\s+quero\s+(reuniao|marcar|conversa)|sem\s+reuniao|resolver?\s+(por|pelo)\s+aqui|so\s+(pelo|por)\s+(whats|zap|aqui)|pelo\s+whats(app)?\s+mesmo|muito\s+caro|caro\s+demais|nao\s+tenho\s+dinheiro|sem\s+dinheiro|nao\s+posso\s+pagar|e\s+golpe|sera\s+que\s+e\s+golpe|isso\s+e\s+serio|nao\s+confio|desconfi|nao\s+conheco\s+(o\s+)?escritorio|sao\s+confiave|demora\s+(anos|muito)|nao\s+vale\s+a\s+pena|nao\s+(vai|da)\s+(dar\s+)?em\s+nada|perda\s+de\s+tempo|vou\s+pensar|pensar\s+melhor|depois\s+eu\s+(vejo|falo|penso|retorno)|falar\s+com\s+(a\s+)?(minha\s+)?(esposa|mulher|marido|familia|patroa)|tenho\s+medo|to\s+com\s+medo|medo\s+(de|da\s+empresa)|represalia|retalia|lista\s+negra|queimar\s+meu\s+nome|ja\s+tenho\s+advogado|ja\s+falei\s+com\s+outro|outro\s+(escritorio|advogado))\b/.test(_qNorm);
  let identityContextInject: string | null = null;
  if (text && detectIdentityQuestion(msgNorm)) {
    const identityResp = await buildIdentityResponse({ id: projetoId }, persona);
    if (!isPerguntaComplexa) {
      const evo = await getEvolutionConfig(projetoId);
      if (evo) {
        await sendHumanizedSafe(evo, phone, `*${persona.nomeExibicao}*\n${identityResp}`, 2000, { deal, persona, projetoId });
        await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: identityResp } });
      }
      await registrarEventoIdentidade(deal.id, text, identityResp);
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
      return;
    }
    // Complex question: pass identity data as LLM context, don't short-circuit
    identityContextInject = identityResp;
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
          await sendHumanizedSafe(evo, phone, `*${persona.nomeExibicao}*\n${frustrationHandling.forceResponseText}`, 2000, { deal, persona, projetoId });
          await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: frustrationHandling.forceResponseText } });
          await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
        }
        return;
      }
    }
  }

  // B8: merge flow step data for downstream use
  const mergedComFlow = { ...merged, ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}) };

  // B9a: extract + apply qualification fields
  const qualResult = await extractAndApplyQual(projetoId, deal, contato, merged, history, perguntas, personaChave, text, (persona as any).llmProviderChave ?? null);
  ({ merged, contato } = qualResult);
  // Turno em que o lead falou algo substantivo mas NADA foi extraído: ele não respondeu a
  // pergunta (mudou de assunto, pediu outra coisa, ou o áudio veio embolado). Não gastar a
  // tentativa do passo nem despejar o próximo template — deixar o LLM tratar o que ele disse.
  // Caso Tarcísio 553183987227: pediu 4× "responde por áudio" e o fluxo avançou 3 fases
  // como se ele tivesse confirmado ser motorista e citado uma empresa.
  const turnoSemResposta = !qualResult.ack && qualResult.dadosNovos === 0 && (text ?? "").trim().length >= 8;

  // B9a-bis: sinais determinísticos — a extração LLM só preenche campos AINDA NULOS,
  // então "não" na primeira pergunta congelava acao_em_andamento=false e o lead podia
  // dizer depois "eu já tenho ação contra eles" sem que nada mudasse (Ledison 26/08 12:09).
  // A dispensa por ética só vale para quem respondeu à pergunta direta. Menção solta, ou extração
  // LLM sem pergunta, vira suspeita: limpa o campo para o fluxo perguntar (José Olívio 09/11).
  {
    let idxSaida = history.length - 1;
    while (idxSaida >= 0 && history[idxSaida].direcao === "in") idxSaida--;
    const saidasIa: string[] = [];
    for (; idxSaida >= 0 && history[idxSaida].direcao === "out" && saidasIa.length < 3; idxSaida--) {
      saidasIa.push(history[idxSaida].conteudo ?? "");
    }
    const decisaoAcao = decidirAcaoEmAndamento({
      valorAtual: merged.acao_em_andamento,
      confirmada: merged._acao_confirmada === true,
      texto: text,
      saidasIa,
    });
    const relato = (text ?? "").trim().slice(0, 300);
    if (decisaoAcao === "confirmar") {
      merged.acao_em_andamento = true;
      merged._acao_confirmada = true;
      merged.acao_em_andamento_relato = relato;
      await persistMergedUpdates(deal.id, merged, { acao_em_andamento: true, _acao_confirmada: true, acao_em_andamento_relato: relato });
      prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] ⚠️ Lead confirmou ação/advogado já existente: "${relato}"` } }).catch(() => {});
      console.warn(`[StageEngine] dealId=${deal.id} — acao_em_andamento confirmada na resposta à pergunta direta`);
    } else if (decisaoAcao === "suspeita" || decisaoAcao === "negou") {
      const negou = decisaoAcao === "negou";
      const primeiraSuspeita = !merged._acao_suspeita_em;
      // Depois de perguntar uma vez, um "não" gravado continua valendo: não pergunta em loop.
      if (negou || merged.acao_em_andamento === true || primeiraSuspeita) {
        const updates: Record<string, unknown> = {
          acao_em_andamento: negou ? false : null,
          _acao_confirmada: false,
          _acao_suspeita_em: merged._acao_suspeita_em ?? new Date().toISOString(),
          _acao_suspeita_relato: relato,
        };
        if (Array.isArray(merged._q_skipped)) {
          updates._q_skipped = (merged._q_skipped as string[]).filter(c => !c.startsWith("acao_andamento"));
        }
        Object.assign(merged, updates);
        await persistMergedUpdates(deal.id, merged, updates);
        if (negou || primeiraSuspeita) {
          prisma.crmNota.create({ data: {
            dealId: deal.id,
            conteudo: negou
              ? `[IA] Lead negou ter advogado/ação: "${relato}"`
              : `[IA] Menção a advogado/ação, sem confirmar. A IA vai perguntar: "${relato}"`,
          } }).catch(() => {});
        }
      }
      // Dispensado por engano: volta para a esteira em vez de ficar parado em desqualificado.
      if (stageChave === "lead_desqualificado"
        && history.some(m => m.direcao === "out" && isDispensaPorAdvogado(m.conteudo))) {
        const crmStageVolta = await prisma.crmStage.findFirst({ where: { chave: "lead_carreteiro" } });
        await prisma.crmDeal.update({
          where: { id: deal.id },
          data: { iaStageChave: "lead_carreteiro", ...(crmStageVolta ? { stageId: crmStageVolta.id } : {}) },
        });
        console.log(`[StageEngine] dealId=${deal.id} — dispensa por advogado revertida`);
      }
    }
  }

  // Lead com reunião marcada: registrar se ele confirmou presença ou pediu para remarcar.
  // 34,7% dos agendados não atendiam a ligação e ninguém sabia antes da hora.
  if (stageChave === "aguardando_reuniao" && text) {
    const sinal = classificarConfirmacao(text);
    if (sinal !== "nenhum") {
      marcarConfirmacao(deal.id, sinal).catch(() => {});
      console.log(`[Confirmação] dealId=${deal.id} lead ${sinal} a presença na reunião`);
    }
  }
  applyAutoTags(projetoId, deal.id, merged).catch(() => {});
  // Lead respondeu → marca engajamento "Respondendo" (remove "Não Respondendo")
  setEngagementTag(deal.id, true).catch(() => {});

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

  // B9c: vinculos loop — skipped in SDR simplificado (modo_sdr: "simples") e triagem (modo_sdr: "triagem")
  const modoSdrCfg  = await prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "modo_sdr" } });
  const isSdrSimples  = modoSdrCfg?.valor === "simples"  && personaChave === "assistente";
  const isSdrTriagem  = modoSdrCfg?.valor === "triagem"  && personaChave === "assistente";
  // SDR genérico (modo_sdr: "generico"): funis que não são de carreteiro — contadores,
  // subvenção, defesa de ICMS. Sem vínculos de emprego, sem o agente de fases do
  // carreteiro e sem as orientações fixas da assistente da RAP (system-prompt-builder):
  // quem conduz a conversa é o systemPrompt da persona. Extração e gates seguem valendo.
  const isSdrGenerico = modoSdrCfg?.valor === "generico" && personaChave === "assistente";

  let vinculos: import("./types.js").VinculoEmprego[] = [];
  let vinculosOk             = false;
  let vinculosTodosPrescritos = false;

  if (!isSdrSimples && !isSdrTriagem && !isSdrGenerico) {
    const ultimaMsgBot       = history.filter(m => m.direcao === "out").slice(-1)[0]?.conteudo ?? "";
    const maisEmpregosPerguntado =
      merged._mais_empregos_perguntado === true ||
      /outro lugar|outra empresa|outra transportadora|mais emprego|trabalhou antes|emprego anterior|antes dis[st]|últimos\s+2\s+anos|nos\s+últimos|trabalhou em outra|outro[s]?\s*v[íi]nculo|vamos investigar/i.test(ultimaMsgBot);
    const vinculosResult     = await processVinculos({ projetoId, merged, text, history, maisEmpregosPerguntado, personaLlmChave: (persona as any).llmProviderChave ?? null });
    if (Object.keys(vinculosResult.mergedUpdates).length > 0) {
      merged = { ...merged, ...vinculosResult.mergedUpdates };
      await persistMergedUpdates(deal.id, merged, vinculosResult.mergedUpdates);
      for (const nota of vinculosResult.notasParaCriar) prisma.crmNota.create({ data: { dealId: deal.id, conteudo: nota } }).catch(() => {});
    }
    vinculos             = vinculosResult.state.vinculos;
    vinculosOk           = vinculosResult.state.vinculosOk;
    vinculosTodosPrescritos = vinculosResult.state.todosPrescritosFlag;
  } else {
    vinculosOk = true; // SDR simplificado não faz coleta de vínculos
  }


  // B9c: acao_em_andamento — notificar equipe se lead já tem ação trabalhista (BUG-032).
  // Uma vez por deal: o campo é sticky, e sem a flag a equipe recebia o alerta a cada
  // mensagem seguinte do lead.
  if (personaChave === "assistente" && merged.acao_em_andamento === true && !merged._notif_acao_at) {
    dispararNotificacoes(projetoId, "acao_em_andamento", {
      dealId: deal.id, nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone,
      mensagem: String(merged.acao_em_andamento_relato ?? ""),
    }).catch(() => {});
    await atualizarMergedFlags(deal.id, merged, { _notif_acao_at: new Date().toISOString() });
    merged._notif_acao_at = new Date().toISOString();
    console.warn(`[StageEngine] ALERTA: dealId=${deal.id} — lead tem ação em andamento (acao_em_andamento=true)`);
  }

  // B10a: agent routing
  const [regraQualificacao, empresasBloqueadasRows] = await Promise.all([
    prisma.iaRegraTransicao.findFirst({ where: { projetoId, stageOrigemChave: stageChave, condicao: "qualificacao_completa" } }),
    (prisma as any).iaEmpresaBloqueada.findMany({ where: { projetoId, ativo: true }, select: { nomeNorm: true } }),
  ]);
  const empresasBloqueadas: string[] = (empresasBloqueadasRows as Array<{ nomeNorm: string }>)
    .map(e => e.nomeNorm).filter(Boolean);

  // B10a-bis: intenção explícita do lead ("pode ligar", "quero sim") encerra a coleta.
  // Sem isso a fila de perguntas atropelava o sinal de compra: o Ledison pediu ligação
  // 29/08 12:31, informou o melhor horário, e a resposta seguinte foi mais uma pergunta
  // de qualificação — o lead ficou parado em lead_carreteiro sem ninguém acionado.
  // Só encerra com vínculo aproveitável: sem isso o allDone entrega lixo para a advogada
  // (ou pior, dispara descarte) só porque o lead pediu ligação.
  if (
    text && personaChave === "assistente" && !isSdrSimples && !isSdrTriagem &&
    !vinculosOk && vinculos.length > 0 && !vinculosTodosPrescritos &&
    detectaPedidoContato(text)
  ) {
    const { getMesesMinimoProjeto: getMesesMinIntencao } = await import("./gate-evaluator.js");
    const { temVinculoValidoSdr } = await import("./assistente-agents.js");
    const normIntencao = (x: string | null | undefined) =>
      (x ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const isBlockedIntencao = (empresa: string | null | undefined) =>
      !!empresa && empresasBloqueadas.some(b => normIntencao(empresa).includes(normIntencao(b)));
    const mesesMinIntencao = await getMesesMinIntencao(projetoId);
    if (temVinculoValidoSdr(vinculos, merged, mesesMinIntencao, isBlockedIntencao)) {
      vinculosOk = true;
      merged._vinculos_ok = true;
      merged._coleta_encerrada_por_intencao = true;
      await atualizarMergedFlags(deal.id, merged, {
        _vinculos_ok: true,
        _coleta_encerrada_por_intencao: true,
      });
      prisma.crmNota.create({ data: {
        dealId: deal.id,
        conteudo: `[IA] Coleta encerrada por intenção explícita do lead: "${text.trim().slice(0, 160)}"`,
      } }).catch(() => {});
      console.log(`[StageEngine] dealId=${deal.id} — pedido de contato detectado → coleta encerrada, handoff`);
    } else {
      console.log(`[StageEngine] dealId=${deal.id} — pedido de contato detectado, mas sem vínculo válido → segue coletando`);
    }
  }

  // Reabertura pós-descarte: lead desqualificado que informa DEPOIS um vínculo CLT válido
  // (tempo >= mínimo, empresa não bloqueada, dentro do prazo) volta para a esteira.
  // Sem isso o descarte era irreversível mesmo com caso bom chegando na sequência.
  if ((stageChave === "lead_desqualificado" || stageChave === "descartado") && vinculos.length > 0) {
    const { getMesesMinimoProjeto } = await import("./gate-evaluator.js");
    const { parseTempToMeses: parseTempoReopen } = await import("./persona-router.js");
    const { deriveDataSaida: deriveSaidaReopen } = await import("./qualification.js");
    const mesesMinReopen = await getMesesMinimoProjeto(projetoId);
    const normReopen = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const dentroPrazoReopen = (v: { data_saida?: string | null; saida?: string | null; tempo?: string | null }) => {
      const d = deriveSaidaReopen(v);
      if (!d) return true; // sem data conhecida → não bloqueia a reabertura
      const [mmR, yyyyR] = d.split("/").map(Number);
      const agoraR = new Date();
      return (agoraR.getFullYear() - yyyyR) * 12 + (agoraR.getMonth() + 1 - mmR) <= 24;
    };
    const vinculoValidoReopen = vinculos.find(v =>
      !!v.empresa && /clt|carteira/i.test(String(v.vinculo ?? "")) &&
      !!v.tempo && parseTempoReopen(String(v.tempo)) >= mesesMinReopen &&
      !empresasBloqueadas.some(b => b && normReopen(String(v.empresa)).includes(normReopen(b))) &&
      dentroPrazoReopen(v)
    );
    if (vinculoValidoReopen) {
      const crmStageReopen = await prisma.crmStage.findFirst({ where: { chave: "lead_carreteiro" } });
      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: { iaStageChave: "lead_carreteiro", ...(crmStageReopen ? { stageId: crmStageReopen.id } : {}) },
      });
      // Limpa a prescrição agregada — o vínculo novo está dentro do prazo.
      vinculosTodosPrescritos = false;
      merged._vinculos_todos_prescritos = false;
      await atualizarMergedFlags(deal.id, merged, { _vinculos_todos_prescritos: false });
      await prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] Lead reaberto pós-descarte — vínculo CLT válido informado: ${vinculoValidoReopen.empresa}` } });
      dispararNotificacoes(projetoId, "lead_reaberto_pos_descarte", {
        dealId: deal.id, nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone, empresa: String(vinculoValidoReopen.empresa ?? ""),
      }).catch(() => {});
      console.log(`[StageEngine] dealId=${deal.id} reaberto pós-descarte (vínculo válido: ${vinculoValidoReopen.empresa})`);
    }
  }

  // Lead das redes (comentário) espera em "Pré-qualificação" até confirmar o vínculo de motorista;
  // confirmado, vai para a coluna da fase em que está (Lead Carreteiro). Descarte e qualificação
  // continuam movendo pelas regras de sempre.
  if (deal.stageId && vinculos.some(v => !!v.empresa && /clt|carteira|informal/i.test(String(v.vinculo ?? "")))) {
    const { ETAPA_PRE_QUALIFICACAO } = await import("../lib/meta-social.js");
    const preQ = await prisma.crmStage.findFirst({ where: { id: deal.stageId, chave: ETAPA_PRE_QUALIFICACAO } });
    const destino = preQ && await prisma.crmStage.findFirst({ where: { pipelineId: preQ.pipelineId, chave: stageChave } });
    if (destino) {
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { stageId: destino.id } });
      await prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] Vínculo de motorista confirmado — saiu da pré-qualificação para "${destino.nome}"` } });
      console.log(`[StageEngine] dealId=${deal.id} pré-qualificação → ${destino.nome}`);
    }
  }

  let nextQDeterministico: string | null = null;
  let assistenteAgentResult: import("./assistente-agents.js").AgentResult | null = null;
  let advFlowStepType: string | null = null;
  let advFlowNextStepChave: string | null = null;
  let advFlowCampoColetar: string | null = null;
  let advFlowProativo = false;
  let advFlowSilentReturn = false;
  let triagemPostPhaseRoute: { toStage: string; motivo: string } | null = null;
  let secretariaInstrucoes = "";

  // ── Gate evaluation (nao_carreteiro, vinculo_invalido, prescricao, tempo_minimo) ──
  if (personaChave === "assistente" && !isSdrSimples && !isSdrTriagem) {
    const { evaluateGates } = await import("./gate-evaluator.js");
    const nomeCliente = typeof merged.nome === "string" ? merged.nome : null;
    const gateFired = await evaluateGates(projetoId, merged, vinculos, vinculosTodosPrescritos, nomeCliente);
    if (gateFired) {
      // Lead já descartado por este gate e mensagem já enviada: não repete o descarte a cada
      // mensagem nova do lead (parecia bot travado mandando a mesma despedida em loop).
      if (stageChave === gateFired.stageDestino) {
        const jaEnviada = history.some(m => m.direcao === "out" && (m.conteudo ?? "").includes(gateFired.mensagem.slice(0, 80)));
        if (jaEnviada) {
          console.log(`[StageEngine] dealId=${deal.id} gate "${gateFired.tipo}" já aplicado — supresso re-envio do descarte`);
          return;
        }
      }
      // Move para o stage configurado no gate (stageDestino), não hardcoded para "descartado"
      const crmStageGate = await prisma.crmStage.findFirst({ where: { chave: gateFired.stageDestino } });
      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: {
          iaStageChave: gateFired.stageDestino,
          ...(crmStageGate ? { stageId: crmStageGate.id } : {}),
          ultimoContatoEm: new Date(),
        },
      });
      await prisma.crmNota.create({ data: { dealId: deal.id, conteudo: `[IA] Gate "${gateFired.tipo}" disparado — ${gateFired.motivoChave}` } });
      const evoGate = await getEvolutionConfig(projetoId);
      if (evoGate) {
        await sendHumanizedSafe(evoGate, phone, `*${persona.nomeExibicao}*\n${gateFired.mensagem}`, 2500, { deal, persona, projetoId });
        await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: gateFired.mensagem } });
      }
      return;
    }
  }

  if (personaChave === "assistente" && !isSdrSimples && !isSdrGenerico) {
    const qAskedAtBefore = JSON.stringify(merged._q_asked_at ?? {});
    const { runAssistenteAgent } = await import("./assistente-agents.js");
    assistenteAgentResult = await runAssistenteAgent({ projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount });
    nextQDeterministico   = assistenteAgentResult.deterministicQuestion;
    console.log(`[AssistenteAgent] dealId=${deal.id} phase="${assistenteAgentResult.phase}" nextQ="${nextQDeterministico?.slice(0, 60) ?? "null"}" allDone=${assistenteAgentResult.allDone} forceDescarte=${assistenteAgentResult.forceDescarte ?? false}`);
    if (assistenteAgentResult.forceDescarte) {
      // Usa lead_desqualificado (igual aos outros gates) em vez do stage "descartado"
      const crmStageDesq = await prisma.crmStage.findFirst({ where: { chave: "lead_desqualificado" } });
      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: { iaStageChave: "lead_desqualificado", ...(crmStageDesq ? { stageId: crmStageDesq.id } : {}), ultimoContatoEm: new Date() },
      });
      await prisma.crmNota.create({ data: { dealId: deal.id, conteudo: "[IA] Empresa bloqueada — lead desqualificado" } });
      // Enviar mensagem de descarte diretamente — sem LLM para evitar resposta errada
      const msgDescarte = assistenteAgentResult.deterministicQuestion;
      if (msgDescarte) {
        const evoConf = await getEvolutionConfig(projetoId);
        if (evoConf) {
          await sendHumanizedSafe(evoConf, phone, `*${persona.nomeExibicao}*\n${msgDescarte}`, 2500, { deal, persona, projetoId });
          await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: msgDescarte } });
        }
      }
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
      return;
    }

    // Persist _q_asked_at if getNextDeterministicQuestion marked a new calc field as asked.
    // This must be persisted immediately so the repeat guard works on the next turn.
    if (JSON.stringify(merged._q_asked_at ?? {}) !== qAskedAtBefore) {
      // Off-flow question (client asked a side question, not answering the flow step):
      // restore _q_asked_at so the same unanswered question is returned again on this
      // turn's --- append and on the next turn, instead of advancing prematurely.
      if ((isPerguntaComplexa || turnoSemResposta) && !frustrationHandling) {
        merged._q_asked_at = JSON.parse(qAskedAtBefore);
        const { runAssistenteAgent: runAgentRestore } = await import("./assistente-agents.js");
        const restored = await runAgentRestore({ projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount });
        nextQDeterministico  = restored.deterministicQuestion;
        assistenteAgentResult = restored;
      } else {
        await atualizarMergedFlags(deal.id, merged, { _q_asked_at: merged._q_asked_at });
      }
    }
    // Persist _mais_empregos_perguntado so vinculos-processor knows the question was asked this turn.
    // This prevents premature semMaisEmpregos closure on subsequent turns before the lead answers.
    if (
      nextQDeterministico &&
      !merged._mais_empregos_perguntado &&
      /outro lugar|outra empresa|outra transportadora|mais emprego|trabalhou antes|emprego anterior|nos últimos|últimos.*anos|trabalhou em outra|outro[s]?\s*v[íi]nculo|vamos investigar/i.test(nextQDeterministico)
    ) {
      merged._mais_empregos_perguntado = true;
      await atualizarMergedFlags(deal.id, merged, { _mais_empregos_perguntado: true });
    }
    // Track vinculos step attempts: if the same step is asked 2+ times without answer,
    // add it to _q_skipped so the next turn skips it and advances.
    // Off-flow questions don't count as unanswered attempts — client is asking a side question,
    // not refusing to answer the flow step. Skip counter only increments on real answer attempts.
    if (personaChave === "assistente" && !((isPerguntaComplexa || turnoSemResposta) && !frustrationHandling)) {
      const { getLastVinculoStepChave, getMaxTentativasPasso } = await import("./persona-router.js");
      const currentStepChave = getLastVinculoStepChave();
      // Detecção por step chave — mais confiável que regex de texto.
      // Cobre pivots cujo texto não bate nos padrões do regex (ex: "Vamos investigar outro vínculo?").
      if (currentStepChave?.startsWith("mais_empregos") && !merged._mais_empregos_perguntado) {
        merged._mais_empregos_perguntado = true;
        await atualizarMergedFlags(deal.id, merged, { _mais_empregos_perguntado: true });
      }
      // B2: ACKs ("ok", "beleza") e mensagens curtas NÃO contam como tentativas fracassadas.
      // Antes, 2 ACKs consecutivos adicionavam o step ao _q_skipped permanentemente.
      const isAck = ACKS_REGEX.test((text ?? "").trim()) || (text?.replace(/\s/g, "").length ?? 0) < 2;
      if (currentStepChave && nextQDeterministico && !isAck) {
        // Contagem ACUMULADA por step. Antes só o último step era contado (`_last_dq`), então
        // alternar entre `acao_andamento_rec` e `acao_andamento_ant` — que fazem a MESMA
        // pergunta em fases diferentes — zerava o contador e a pergunta voltava para sempre
        // (Carlos 5521995367039 levou 4×). `_last_dq` continua escrito por compatibilidade.
        const dqCount = (merged._dq_count && typeof merged._dq_count === "object")
          ? { ...(merged._dq_count as Record<string, number>) } : {};
        const newCount = (dqCount[currentStepChave] ?? 0) + 1;
        dqCount[currentStepChave] = newCount;
        merged._dq_count = dqCount;
        const maxTentativas = await getMaxTentativasPasso(projetoId, currentStepChave);
        if (newCount >= maxTentativas && !((merged._q_skipped as string[] | undefined)?.includes(currentStepChave))) {
          const qSkipped = Array.isArray(merged._q_skipped)
            ? [...(merged._q_skipped as string[]), currentStepChave]
            : [currentStepChave];
          merged._q_skipped = qSkipped;
          merged._last_dq = null;
          await atualizarMergedFlags(deal.id, merged, { _q_skipped: qSkipped, _last_dq: null, _dq_count: dqCount });
          console.log(`[StageEngine] Step "${currentStepChave}" asked ${newCount}× without answer → skipped`);
          // Re-run to get the NEXT question (skip takes effect immediately on this turn).
          const { runAssistenteAgent: runAgentRerun } = await import("./assistente-agents.js");
          const rerun = await runAgentRerun({ projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount });
          nextQDeterministico = rerun.deterministicQuestion;
          assistenteAgentResult = rerun;
          // Re-check forceDescarte from rerun — first check (line ~652) was for original call
          if (rerun.forceDescarte) {
            const crmStageDesqRr = await prisma.crmStage.findFirst({ where: { chave: "lead_desqualificado" } });
            await prisma.crmDeal.update({ where: { id: deal.id }, data: { iaStageChave: "lead_desqualificado", ...(crmStageDesqRr ? { stageId: crmStageDesqRr.id } : {}), ultimoContatoEm: new Date() } });
            await prisma.crmNota.create({ data: { dealId: deal.id, conteudo: "[IA] Empresa bloqueada — lead desqualificado (skip-rerun)" } });
            if (rerun.deterministicQuestion) {
              const evoRr = await getEvolutionConfig(projetoId);
              if (evoRr) {
                await sendHumanizedSafe(evoRr, phone, `*${persona.nomeExibicao}*\n${rerun.deterministicQuestion}`, 2500, { deal, persona, projetoId });
                await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: rerun.deterministicQuestion } });
              }
            }
            return;
          }
        } else {
          merged._last_dq = { chave: currentStepChave, count: newCount };
          await atualizarMergedFlags(deal.id, merged, { _last_dq: { chave: currentStepChave, count: newCount }, _dq_count: dqCount });
        }
      }
    }

    // Persist internal flags set by flow-controller (campoColetar starting with "_").
    // Example: _conta_caso_enviada is set when conta_caso step is returned.
    // Persists ALL new flags at once (not one at a time) to avoid turn-to-turn race conditions.
    const existingIaFlags = ((deal as any).iaFlags as Record<string, unknown> | null) ?? {};
    const EXCLUDED_FLAGS = new Set(["_q_asked_at", "_dq_count", "_saudacao_enviada", "_vinculos_ok", "_vinculos_todos_prescritos", "_mais_empregos_negado", "_mais_empregos_confirmado", "_pos_vinculos_fase", "_valor_apresentado"]);
    const newFlags: Record<string, unknown> = {};
    for (const k of Object.keys(merged)) {
      if (k.startsWith("_") && !EXCLUDED_FLAGS.has(k) && merged[k] === true && existingIaFlags[k] !== true) {
        newFlags[k] = true;
      }
    }
    if (Object.keys(newFlags).length > 0) {
      console.log(`[StageEngine] Persistindo flags internas: ${Object.keys(newFlags).join(", ")}`);
      await atualizarMergedFlags(deal.id, merged, newFlags);
    }
  } else if (personaChave === "assistente" && isSdrSimples) {
    // SDR simplificado: usa o flow-controller sequencial (igual a Daniela) com fase "sdr_simples"
    const { advanceAdvogadoFlow } = await import("./flow-controller.js");
    const sdrFlow = await advanceAdvogadoFlow(
      projetoId,
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
      text ?? "", outgoingCount, history,
      { personaChave: "assistente", fase: "sdr_simples" },
    );
    nextQDeterministico  = sdrFlow.nextQuestion;
    advFlowStepType      = sdrFlow.stepType ?? null;
    advFlowNextStepChave = sdrFlow.nextStepChave ?? null;
    advFlowCampoColetar  = sdrFlow.campoColetar ?? null;
    console.log(`[SdrSimples] dealId=${deal.id} step="${advFlowNextStepChave ?? "null"}" nextQ="${nextQDeterministico?.slice(0, 60) ?? "null"}"`);
  } else if (personaChave === "assistente" && isSdrTriagem) {
    const { runTriagemFlow } = await import("./triagem-router.js");
    const triagem = await runTriagemFlow(
      projetoId,
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
      text ?? "", outgoingCount, history, merged,
    );
    nextQDeterministico   = triagem.nextQuestion;
    advFlowStepType       = triagem.stepType;
    advFlowNextStepChave  = triagem.nextStepChave;
    advFlowCampoColetar   = triagem.campoColetar;
    triagemPostPhaseRoute = triagem.postPhaseRoute;
    console.log(`[SdrTriagem] dealId=${deal.id} stage="${stageChave}" step="${advFlowNextStepChave ?? "null"}" nextQ="${nextQDeterministico?.slice(0, 60) ?? "null"}" route="${triagem.postPhaseRoute?.toStage ?? "null"}"`);
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
    advFlowProativo      = advFlow.proativo === true;
    advFlowSilentReturn  = advFlow.silentReturn === true;

    if (advFlow.firedNotify) {
      const nd = merged.nome ? String(merged.nome) : (contato.nome ?? "");
      dispararNotificacoes(projetoId, advFlow.firedNotify, { nome: nd, telefone: phone, stage: stageChave }).catch(() => {});
    }

    // When advogado flow ends → hand off to next persona (configured via persona.proximaPersonaChave).
    // Reset iaFlowStepData so the next flow starts clean.
    if (advFlowNextStepChave === "__done__") {
      const nextPersonaChave = (persona as any).proximaPersonaChave as string | null ?? null;
      if (nextPersonaChave) {
        await (prisma.crmDeal as any).update({
          where: { id: deal.id },
          data: { iaPersonaChave: nextPersonaChave, iaFlowStepChave: null, iaPersonaTrocadaEm: new Date(), iaFlowStepData: {} },
        });
        console.log(`[StageEngine] advogado done → ${nextPersonaChave} para deal ${deal.id}`);

        // Switch persona inline so THIS turn generates the next persona's opening.
        // For secretaria: pre-load slots. For other personas: just switch prompt.
        const nextInlinePersona = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave: nextPersonaChave } } });
        if (nextInlinePersona) {
          personaChave = nextPersonaChave;
          persona = nextInlinePersona;

          if (nextPersonaChave === "secretaria") {
            const { getSlotsDisponiveis: fetchSlots, buildSlotsInstrucoes: buildSlotInstr, renderHorarios: renderHorariosInline } = await import("./secretaria-agenda.js");
            const slotsDanielaDone = await fetchSlots(projetoId);
            const advNomeInline = await getPersonaNomeExibicao(projetoId, "advogado");
            secretariaInstrucoes = buildSlotInstr(slotsDanielaDone, advNomeInline);

            // Advance secretaria flow (sec_apresentacao init) on this same turn so the
            // LLM gets the real slot instruction instead of a blank/generic response.
            const { advanceAdvogadoFlow: advSecInline } = await import("./flow-controller.js");
            const inlineSecFlow = await advSecInline(
              projetoId,
              { id: deal.id, iaFlowStepChave: null, iaFlowStepData: {}, qualificacao: deal.qualificacao },
              text ?? "", outgoingCount, history,
              { personaChave: "secretaria", fase: "secretaria" },
            );
            nextQDeterministico  = inlineSecFlow.nextQuestion;
            advFlowStepType      = inlineSecFlow.stepType ?? null;
            advFlowNextStepChave = inlineSecFlow.nextStepChave ?? null;
            advFlowCampoColetar  = inlineSecFlow.campoColetar ?? null;

            if (nextQDeterministico) {
              nextQDeterministico = await renderHorariosInline(projetoId, nextQDeterministico, slotsDanielaDone);
            }
            if (nextQDeterministico) {
              const { renderNomePlaceholder } = await import("./gate-evaluator.js");
              const nomeLead = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
              nextQDeterministico = renderNomePlaceholder(nextQDeterministico, nomeLead);
            }

            console.log(`[StageEngine] Secretaria inline — ${slotsDanielaDone.length} slots, step="${advFlowNextStepChave}" para deal ${deal.id}`);
          }
        }
      } else {
        // No next persona: advogado flow is done, stay in free-form Daniela mode
        console.log(`[StageEngine] advogado done → livre (sem proximaPersonaChave) para deal ${deal.id}`);
        await (prisma.crmDeal as any).update({ where: { id: deal.id }, data: { iaFlowStepChave: null, iaFlowStepData: {} } });
        nextQDeterministico = null;
        advFlowStepType = null;
        advFlowNextStepChave = null;
        advFlowCampoColetar = null;
      }
    }
  } else if (personaChave === "secretaria" && deal.iaAtiva) {
    // Fetch available agenda slots for this project (used for system prompt + meeting creation)
    const { getSlotsDisponiveis, buildSlotsInstrucoes, encontrarSlotPorTexto, buildEscaladaAgendamento, renderHorarios } = await import("./secretaria-agenda.js");
    const slotsDisponiveis = await getSlotsDisponiveis(projetoId);
    const advNomeSec = await getPersonaNomeExibicao(projetoId, "advogado");
    secretariaInstrucoes = buildSlotsInstrucoes(slotsDisponiveis, advNomeSec);

    // Step antes do avanço: distingue "oferta dos horários" (sec_apresentacao recém-iniciado)
    // de "lead respondendo à oferta" (já estava em sec_apresentacao) — usado abaixo para não
    // emitir o "Reunião marcada!" quando o lead respondeu sem escolher um horário válido.
    const secStepAntes = (deal as any).iaFlowStepChave ?? null;

    const { advanceAdvogadoFlow } = await import("./flow-controller.js");
    const secFlow = await advanceAdvogadoFlow(
      projetoId,
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
      text ?? "", outgoingCount, history,
      { personaChave: "secretaria", fase: "secretaria" },
    );
    nextQDeterministico  = secFlow.nextQuestion;
    advFlowStepType      = secFlow.stepType ?? null;
    advFlowNextStepChave = secFlow.nextStepChave ?? null;
    advFlowCampoColetar  = secFlow.campoColetar ?? null;
    advFlowSilentReturn  = secFlow.silentReturn === true;

    // Substitute {horarios} whenever the placeholder is present (including step already init'd)
    if (nextQDeterministico) {
      nextQDeterministico = await renderHorarios(projetoId, nextQDeterministico, slotsDisponiveis);
    }
    if (nextQDeterministico) {
      const { renderNomePlaceholder } = await import("./gate-evaluator.js");
      const nomeLead = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
      nextQDeterministico = renderNomePlaceholder(nextQDeterministico, nomeLead);
    }

    // Reload iaFlowStepData after secFlow — saveFlowStepData writes to DB mid-execution
    // so deal.iaFlowStepData is stale for the same turn horario_reuniao is first extracted.
    const freshSecDeal = await (prisma as any).crmDeal.findUnique({ where: { id: deal.id }, select: { iaFlowStepData: true } });
    const freshSecStepData = (freshSecDeal?.iaFlowStepData as Record<string, unknown>) ?? {};

    // When secretaria collects horario_reuniao → create meeting + send link
    const horarioReuniaoVal = (merged.horario_reuniao as string | undefined)
      ?? (freshSecStepData.horario_reuniao as string | undefined)
      ?? (mergedComFlow.horario_reuniao as string | undefined);
    const reuniaoJaCriada = merged._reuniao_criada || freshSecStepData._reuniao_criada;

    if (!reuniaoJaCriada && contato.whatsapp) {
      // Primary: match via stored horario_reuniao value
      // Fallback: match directly from incoming text (handles case where llm_generated step
      // confirmed the slot but extractJson ran against "obrigado" on the next turn → null stored)
      let matchedSlot = horarioReuniaoVal
        ? await encontrarSlotPorTexto(projetoId, horarioReuniaoVal, slotsDisponiveis)
        : null;
      if (!matchedSlot && text) {
        matchedSlot = await encontrarSlotPorTexto(projetoId, text, slotsDisponiveis);
      }

      const horarioFinal = horarioReuniaoVal ?? matchedSlot?.label;

      if (horarioFinal && matchedSlot) {
        const { criarReuniaoAgente } = await import("./secretaria-meeting.js");
        const reuniao = await criarReuniaoAgente(
          projetoId, deal.id,
          { id: contato.id, nome: contato.nome, whatsapp: contato.whatsapp },
          horarioFinal,
          matchedSlot,
        );
        if (reuniao) {
          await atualizarMergedFlags(deal.id, merged, { _reuniao_criada: true, _reuniao_link: reuniao.linkConvidado });
          merged._reuniao_criada = true;
          merged._reuniao_link = reuniao.linkConvidado;
          // Suppress slot re-offer: criarReuniaoAgente already sent the confirmation message.
          // If the step wasn't advanced (e.g. "7" is non-substantive), nextQDeterministico
          // still holds the slot intro — clearing it prevents a duplicate send.
          nextQDeterministico = null;
          // Force __done__ so the handoff check below (advFlowNextStepChave === "__done__")
          // triggers and transitions iaPersonaChave → advogado (Daniela). Without this,
          // advanceAdvogadoFlow returns "sec_conclusao" (the end step) instead of "__done__",
          // and Daniela's proactive setTimeout is never scheduled.
          advFlowNextStepChave = "__done__";
          // Avança o stage para aguardando_reuniao, parando os follow_up_timed de lead_qualificado
          const { pendingActions: raPending } = await transitionDeal(projetoId, deal.id, "reuniao_agendada", phone, stageChave);
          scheduleProativasDeduped(raPending, projetoId);
        }
      } else if (secStepAntes === "sec_apresentacao" && slotsDisponiveis.length > 0) {
        // Lead respondeu à oferta de horários, mas NÃO escolheu um slot válido — pode ser uma
        // objeção ("não quero reunião", "resolve por aqui"), uma dúvida, ou um horário fora da agenda.
        // O step sec_apresentacao é do tipo "saudacao" e auto-avançou para sec_conclusao ("Reunião
        // marcada!") sem que nenhuma reunião tenha sido criada — isso geraria uma confirmação FALSA.
        // Correção: volta para sec_apresentacao e deixa a LLM responder com o contexto da secretaria
        // (lista de horários + OBJECTIONS_BLOCK), tratando a objeção e re-oferecendo o agendamento.
        await prisma.$executeRaw`UPDATE "CrmDeal" SET qualificacao = qualificacao - 'horario_reuniao' WHERE id = ${deal.id}`;
        await (prisma as any).crmDeal.update({
          where: { id: deal.id },
          data: { iaFlowStepChave: "sec_apresentacao", iaFlowStepData: {} },
        });
        merged.horario_reuniao = undefined;
        nextQDeterministico  = null;                 // suprime o "Reunião marcada!" falso — LLM gera a resposta
        advFlowStepType      = null;
        advFlowNextStepChave = "sec_apresentacao";   // NÃO __done__ → sem handoff prematuro p/ advogado
        advFlowCampoColetar  = null;

        // Persistência: conta as recusas no agendamento para ESCALAR os argumentos de venda a cada "não".
        // Política: o SDR NUNCA capitula sozinho — só "desiste" quando o lead some/bloqueia (sem mais webhooks).
        const recusasAnt = Number((merged as any)._sched_objections ?? 0);
        const recusas = recusasAnt + 1;
        await atualizarMergedFlags(deal.id, merged, { _sched_objections: recusas });
        (merged as any)._sched_objections = recusas;
        secretariaInstrucoes += "\n\n" + buildEscaladaAgendamento(recusas);
        console.log(`[StageEngine] secretaria: lead recusou agendamento (recusa #${recusas}) — escalando argumentos, sem capitular dealId=${deal.id}`);
      }
    }

    // When secretaria flow ends → hand off to next persona (configured via persona.proximaPersonaChave)
    if (advFlowNextStepChave === "__done__" && await proximaPersonaAtiva(projetoId, (persona as any).proximaPersonaChave)) {
      const nextChaveAfterSec = (persona as any).proximaPersonaChave as string;
      await (prisma.crmDeal as any).update({
        where: { id: deal.id },
        data: { iaPersonaChave: nextChaveAfterSec, iaFlowStepChave: null, iaFlowStepData: {}, iaPersonaTrocadaEm: new Date() },
      });
      console.log(`[StageEngine] secretaria done → ${nextChaveAfterSec} (iaFlowStepChave=null) para deal ${deal.id}`);

      // Let the secretaria (Ana) respond to this message (e.g. "obrigado") naturally.
      // The next persona (advogado/Daniela) sends her first block proactively via setTimeout,
      // so she never appears to "respond" to an acknowledgement.
      nextQDeterministico = null;
      advFlowStepType = null;
      advFlowNextStepChave = null;
      advFlowCampoColetar = null;
      advFlowProativo = false;

      if (nextChaveAfterSec === "advogado") {
        const proativoDelay = 15000 + Math.random() * 10000; // 15–25 s after Ana's farewell
        setTimeout(() => runProativoNextStep(projetoId, deal.id, phone).catch(() => {}), proativoDelay);
        console.log(`[StageEngine] Advogado proativo agendado em ${Math.round(proativoDelay / 1000)}s para deal ${deal.id}`);
      }
    }
  }

  // B10a2: coleta_docs flow (post-reunion document collection → auto-generate proposal)
  if (personaChave === "coleta_docs" && deal.iaAtiva) {
    // When a document arrives, force context re-extraction so new doc fields are always reflected
    if (documentosEnviados) merged._context_loaded = false;

    // Refresh doc flags + extract fields (_pf_*) from all DealAnexo + meeting transcripts
    const { loadColetaDocsContext } = await import("./coleta-docs-context.js");
    await loadColetaDocsContext(projetoId, deal.id, merged);

    const { advanceAdvogadoFlow } = await import("./flow-controller.js");
    const cdFlow = await advanceAdvogadoFlow(
      projetoId,
      // Pass `merged` (not deal.qualificacao) so _pf_* fields from OCR/transcription are visible to flow-controller
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: merged },
      text ?? "", outgoingCount, history,
      { personaChave: "coleta_docs", fase: "coleta_docs" },
    );
    nextQDeterministico  = cdFlow.nextQuestion;
    advFlowStepType      = cdFlow.stepType ?? null;
    advFlowNextStepChave = cdFlow.nextStepChave ?? null;
    advFlowCampoColetar  = cdFlow.campoColetar ?? null;
    advFlowSilentReturn  = cdFlow.silentReturn === true;

    // When all data collected → auto-generate proposal + docs
    // Confirmation should be the last step in the coleta_docs IaFlowStep (llm_generated or gate type)
    if (advFlowNextStepChave === "__done__" || advFlowNextStepChave === "cd_envio_contrato") {
      criarPropostaAutomatica(projetoId, deal.id, phone, "dados_coletados").catch(() => {});
      dispararNotificacoes(projetoId, "coleta_docs_concluida", {
        dealId: deal.id,
        nome: String(merged.nome ?? contato.nome ?? ""),
        telefone: phone,
      }).catch(() => {});
      console.log(`[ColetaDocs] dealId=${deal.id} — todos os dados coletados, disparando geração automática`);
    }
  }

  // A3: Concurrency lock — cron ganhou a corrida e já enviou esta mensagem; silenciar webhook
  if (advFlowNextStepChave === "__concurrency_lock__") {
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
    return;
  }

  // Step proativo ativo — silenciar completamente (sem LLM, sem _enviado, sem resposta)
  // Evita que "ok"/"aguardo" gere LLM livre ou marque o step como enviado antes do proativo
  if (advFlowSilentReturn) {
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });
    console.log(`[StageEngine] dealId=${deal.id} — step proativo ativo, silenciando webhook`);
    return;
  }


  const perguntasPendentes = perguntas.filter(p => merged[p.chave] === undefined || merged[p.chave] === null);
  let allAnswered =
    (personaChave === "assistente" && !isSdrSimples && !isSdrTriagem && assistenteAgentResult?.allDone === true) ||
    (isSdrSimples && advFlowNextStepChave === "__done__") ||
    (isSdrTriagem && triagemPostPhaseRoute?.toStage === "lead_qualificado");

  // B10b: ligação detection + cooldown-guarded notification
  if (text) {
    const { notificado, timestamp } = await checkAndNotifySolicitaLigacao(projetoId, deal.id, merged, text, phone, stageChave);
    if (notificado && timestamp) {
      merged._notif_ligacao_at = timestamp;
      await atualizarMergedFlags(deal.id, merged, { _notif_ligacao_at: timestamp });
    }
  }

  // B11: build system prompt — load all persona names for cross-persona placeholder substitution
  const [advNomeGlobal, secNomeGlobal, assistNomeGlobal, escritorioNomeCfg] = await Promise.all([
    getPersonaNomeExibicao(projetoId, "advogado"),
    getPersonaNomeExibicao(projetoId, "secretaria"),
    getPersonaNomeExibicao(projetoId, "assistente"),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "comportamento.escritorio_nome" } }),
  ]);
  const escritorioNomeGlobal = escritorioNomeCfg?.valor ?? "";
  const instrBase = buildInstrucaoBase(advNomeGlobal);
  let valueInjection: string | null = null;
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

  // B11a: calculo flow — DB-driven questions (IaFlowStep fase="calculo") + LLM calc via systemPrompt
  if (personaChave === "calculo" && deal.iaAtiva) {
    const { advanceAdvogadoFlow } = await import("./flow-controller.js");
    const calcFlow = await advanceAdvogadoFlow(
      projetoId,
      { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
      text ?? "", outgoingCount, history,
      { personaChave: "calculo", fase: "calculo" },
    );
    nextQDeterministico  = calcFlow.nextQuestion;
    advFlowStepType      = calcFlow.stepType ?? null;
    advFlowNextStepChave = calcFlow.nextStepChave ?? null;
    advFlowCampoColetar  = calcFlow.campoColetar ?? null;

    const { buildCalculoInjection } = await import("./calculo-agents.js");
    advogadoInstrucoes = buildCalculoInjection(merged, vinculos);
    console.log(`[CalculoAgent] dealId=${deal.id} step="${advFlowNextStepChave ?? "null"}" nextQ="${nextQDeterministico?.slice(0,50) ?? "null"}"`);

    // When calculo flow ends → hand off to next persona (configured via persona.proximaPersonaChave).
    if (advFlowNextStepChave === "__done__") {
      const nextPersonaChave = (persona as any).proximaPersonaChave as string | null ?? null;
      if (nextPersonaChave) {
        await (prisma.crmDeal as any).update({
          where: { id: deal.id },
          data: { iaPersonaChave: nextPersonaChave, iaFlowStepChave: null, iaPersonaTrocadaEm: new Date(), iaFlowStepData: {} },
        });
        console.log(`[StageEngine] calculo done → ${nextPersonaChave} para deal ${deal.id}`);
        const nextInlinePersona = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave: nextPersonaChave } } });
        if (nextInlinePersona) {
          personaChave = nextPersonaChave;
          persona = nextInlinePersona;
        }
      } else {
        console.log(`[StageEngine] calculo done → livre (sem proximaPersonaChave) para deal ${deal.id}`);
        await (prisma.crmDeal as any).update({ where: { id: deal.id }, data: { iaFlowStepChave: null, iaFlowStepData: {} } });
        nextQDeterministico  = null;
        advFlowStepType      = null;
        advFlowNextStepChave = null;
      }
    }
  }

  // Suppress "INFORMAÇÕES AINDA NÃO COLETADAS" for triagem mode (flow-controller drives the questions).
  const perguntasDeterministicas = isSdrTriagem
    ? []
    : perguntasPendentes.slice(0, 2).map(p => `- ${p.perguntaContexto}${p.exemploAbordagem ? ` (ex: ${p.exemploAbordagem})` : ""}`);
  const personaTrocadaEm = (deal as any).iaPersonaTrocadaEm as Date | null | undefined;
  let llmMsgsBase = history;
  if ((personaChave === "advogado" || personaChave === "secretaria" || personaChave === "coleta_docs" || personaChave === "calculo") && personaTrocadaEm) {
    llmMsgsBase = history.filter(m => m.enviadaEm >= personaTrocadaEm);
    if (!llmMsgsBase.length) llmMsgsBase = history.slice(-5);
  }
  const advNomeHandoff = personaChave === "advogado" ? await getPersonaNomeExibicao(projetoId, "advogado") : "";

  // Detect saida contradiction: lead previously said they left, now saying still employed.
  // Override frustrationHandling so the LLM asks for clarification instead of advancing the flow.
  if (!frustrationHandling && personaChave === "assistente" && text && vinculos.length > 0) {
    const saidaAtual = vinculos[0]?.saida;
    if (saidaAtual) {
      const msgNFD = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const indicaAindaEmpregado =
        /ainda\s+(est[aa]|trabalh|empregad|nao\s+sa[ii])|sai(u)?\s+nao|nao\s+sai|nao\s+sa[ii]|ainda\s+nao\s+sa[ii]|continuo\s+(la|trabalhando)|ainda\s+to\s+(la|trabalhando)/i.test(msgNFD);
      if (indicaAindaEmpregado) {
        frustrationHandling = {
          injectIntoSystemPrompt:
            `=== CONTRADIÇÃO: SITUAÇÃO DE EMPREGO ===\n` +
            `O lead disse anteriormente que saiu da empresa (saida registrada: "${saidaAtual}"), ` +
            `mas a mensagem atual sugere que ainda está empregado. ` +
            `NÃO avance o fluxo. Pergunte em UMA frase curta e direta: ` +
            `"Fica me confirmando — você ainda tá na empresa ou já saiu?"`,
          skipDeterministicOverride: true,
          escalateToHuman: false,
        };
        console.log(`[StageEngine] Contradição saida detectada dealId=${deal.id} saidaAtual="${saidaAtual}"`);
      }
    }
  }

  // If the lead asked any question (complex message with "?"), let the LLM respond
  // then append the next qualification question as a second bubble to resume the flow.
  const leadFezPerguntaInesperada = (isPerguntaComplexa || isObjecao) && !frustrationHandling;

  const systemPrompt = buildSystemPrompt({
    personaChave, personaNome: persona.nomeExibicao,
    // Full vinculos mode: suppress assistente agent systemInstructions (phase/vinculos list) —
    // the persona prompt's ETAPA 1-15 drives the conversation, not the agent phase injections.
    personaInstrucoes: personaChave === "assistente" ? (assistenteAgentResult?.systemInstructions ?? "") : personaChave === "secretaria" ? secretariaInstrucoes : advogadoInstrucoes, // calculo uses advogadoInstrucoes (set above)
    personaFase: personaChave === "assistente" ? (assistenteAgentResult?.phase ?? "") : "",
    instrucaoComportamento: persona.systemPrompt, instrucaoBase: instrBase,
    perguntasDeterministicas, camposBloqueados: [],
    merged: { ...merged, ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}) },
    vinculos, vinculosOk, vinculosTodosPrescritos,
    iaFlowStepChave: (deal as any).iaFlowStepChave ?? null,
    iaFlowStepData: (deal as any).iaFlowStepData as Record<string, unknown> ?? {},
    // Triagem mode: suppress ⚠️ PRÓXIMA PERGUNTA OBRIGATÓRIA so the persona prompt drives the flow.
    documentosEnviados, isDocAnalitico, nextQDeterministico: isSdrTriagem ? null : nextQDeterministico, advFlowStepType, advFlowNextStepChave, advFlowCampoColetar,
    valueInjection, handoffSnapshot: personaChave === "advogado" ? buildHandoffSnapshot(merged, advNomeHandoff) : null,
    frustrationInjection: frustrationHandling?.injectIntoSystemPrompt ?? null,
    outgoingCount, nomeCliente: typeof merged.nome === "string" ? merged.nome : null,
    cidadeCliente: typeof merged.cidade === "string" ? merged.cidade : null,
    incomingText: text,
    leadFezPerguntaInesperada,
    assistenteGenerico: isSdrGenerico,
    identityContextInject,
    assistenteNome: assistNomeGlobal,
    escritorioNome: escritorioNomeGlobal,
    advogadoNome: advNomeGlobal,
  });
  const llmMessages = llmMsgsBase.map(m => ({ role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant", content: m.conteudo ?? "" }));

  // B12: call LLM (up to 3 humanization attempts)
  // Pre-compute whether we will override with a deterministic question so we can skip
  // the LLM call entirely — saves 3–10 s per coleta_docs / advogado deterministic step.
  // Guard final anti-repetição: se a pergunta que vamos mandar já foi feita e o lead JÁ RESPONDEU,
  // não repetir. Cobre qualquer origem — passo determinístico, variante da mesma pergunta em outra
  // fase (acao_andamento_rec × _ant) ou pergunta gerada pelo LLM. O step vai para _q_skipped para o
  // fluxo andar, e a resposta passa a sair do LLM, que tem o histórico e responde ao que ele disse.
  if (nextQDeterministico && advFlowStepType !== "saudacao" && advFlowStepType !== "llm_generated" && advFlowStepType !== "llm_gate") {
    const repetida = await jaPerguntouEFoiRespondida(deal.id, nextQDeterministico).catch(() => false);
    if (repetida) {
      const stepRepetido = advFlowNextStepChave ?? (await import("./persona-router.js")).getLastVinculoStepChave();
      console.log(`[StageEngine] dealId=${deal.id} — "${nextQDeterministico.slice(0, 50)}" já perguntada e respondida; não repetindo (step=${stepRepetido ?? "?"})`);
      if (stepRepetido && !((merged._q_skipped as string[] | undefined)?.includes(stepRepetido))) {
        const qSkipped = Array.isArray(merged._q_skipped)
          ? [...(merged._q_skipped as string[]), stepRepetido]
          : [stepRepetido];
        merged._q_skipped = qSkipped;
        await atualizarMergedFlags(deal.id, merged, { _q_skipped: qSkipped });
      }
      nextQDeterministico = null;
    }
  }

  const willOverrideDeterministic =
    // secretaria is fully flow-controlled — never let unexpected questions bypass deterministic steps
    (!leadFezPerguntaInesperada || personaChave === "secretaria") &&
    // Triagem mode bypasses deterministic override EXCEPT for the saudacao step —
    // the greeting must always be sent verbatim to avoid the LLM skipping the intro.
    (!isSdrTriagem || advFlowStepType === "saudacao") &&
    !isDocAnalitico &&
    (personaChave === "assistente" || personaChave === "advogado" || personaChave === "secretaria" || personaChave === "coleta_docs" || personaChave === "calculo") &&
    !!nextQDeterministico &&
    // Turno sem resposta: mandar o próximo template por cima do que a pessoa disse é o que
    // fez a IA parecer surda nos áudios. O LLM responde e reencaixa a pergunta.
    !(turnoSemResposta && personaChave === "assistente" && advFlowStepType !== "saudacao") &&
    advFlowStepType !== "llm_generated" &&
    advFlowStepType !== "llm_gate" &&   // llm_gate/gate pergunta = LLM instruction, never send verbatim
    advFlowStepType !== "gate" &&
    !frustrationHandling?.skipDeterministicOverride;

  let resposta = "";
  if (willOverrideDeterministic) {
    console.log(`[StageEngine] dealId=${deal.id} skipLLM — deterministic override`);
    resposta = nextQDeterministico!;
  } else {
    try {
      resposta = await callLlmWithRetry(projetoId, deal.id, systemPrompt, llmMessages, personaChave, (persona as any).llmProviderChave ?? null, stageChave, advFlowStepType === "llm_generated", isSdrGenerico);
    } catch {
      console.warn(`[StageEngine] Todos os LLMs falharam para deal ${deal.id} — agendando retry`);
      scheduleLlmRetry(projetoId, deal.id, phone);
      return;
    }
    if (!resposta) return;
  }

  // B13: deterministic question override (skip for triagem / analytical doc analysis)
  if (willOverrideDeterministic) {
    resposta = applyDeterministicOverride(resposta, nextQDeterministico!, merged, text, deal.id, persona.nomeExibicao, {
      nome_advogado: advNomeGlobal, nome_secretaria: secNomeGlobal, nome_assistente: assistNomeGlobal,
    });
  } else if (leadFezPerguntaInesperada && nextQDeterministico && !allAnswered
             && advFlowStepType !== "llm_generated" && advFlowStepType !== "llm_gate") {
    // Lead asked an off-flow question — LLM responded; now append the next qualification question
    // as a second WhatsApp bubble so the flow always resumes.
    // Guard: llm_generated/llm_gate nextQDeterministico is an LLM instruction template, never user-visible.
    // Guard: if the same question was already the last outgoing message, do NOT re-append —
    // re-sending the same Q on consecutive side-question turns looks like a stuck/broken bot.
    const lastOutMsg = history.filter(m => m.direcao === "out").slice(-1)[0]?.conteudo ?? "";
    const normQ = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
    const qAlreadyLastSent = normQ(lastOutMsg).includes(normQ(nextQDeterministico));
    // Caso Cigano 04/11: o LLM já devolveu a pergunta obrigatória (ela vai no system prompt) e a
    // segunda bolha repetia a mesma pergunta 3 s depois, com outras palavras.
    const llmJaPerguntou = respostaJaFazPergunta(resposta, nextQDeterministico);
    if (llmJaPerguntou) {
      console.log(`[StageEngine] dealId=${deal.id} — LLM já fez a próxima pergunta; omitindo segunda bolha`);
    } else if (!qAlreadyLastSent) {
      const nome = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
      let resolvedQ = nome ? nextQDeterministico.replace(/\{nome\}/g, nome) : nextQDeterministico.replace(/\{nome\},?\s*/g, "");
      resolvedQ = resolvedQ.replace(/\{nome_persona\}/g, persona.nomeExibicao)
        .replace(/\{nome_advogado\}/g, advNomeGlobal)
        .replace(/\{nome_secretaria\}/g, secNomeGlobal)
        .replace(/\{nome_assistente\}/g, assistNomeGlobal);
      resposta = `${resposta}\n\n---\n\n${resolvedQ}`;
    } else {
      console.log(`[StageEngine] dealId=${deal.id} — nextQ já enviado na última mensagem, omitindo segunda bolha`);
    }
  }

  // Personalização: usa o primeiro nome do lead 1× na primeira pergunta após ele se apresentar.
  // Variação anti-robô: pergunta idêntica à última enviada ganha um prefixo de retomada.
  if (willOverrideDeterministic && resposta && personaChave === "assistente") {
    const nomeP = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
    if (nomeP && nomeP.length >= 2 && merged._nome_saudado !== true && merged._saudacao_enviada) {
      if (!new RegExp(`\\b${nomeP.replace(/[.*+?^${}()|[\]\\]/g, "")}\\b`, "i").test(resposta)) {
        resposta = `${nomeP}, ${resposta.charAt(0).toLowerCase()}${resposta.slice(1)}`;
      }
      merged._nome_saudado = true;
      await atualizarMergedFlags(deal.id, merged, { _nome_saudado: true });
    }
    const lastOutRaw = history.filter(m => m.direcao === "out").slice(-1)[0]?.conteudo ?? "";
    const lastOutClean = lastOutRaw.replace(/^\*[^*]+\*\s*/, "");
    const normRep = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
    if (lastOutClean && normRep(lastOutClean) === normRep(resposta)) {
      resposta = `Só pra fechar essa parte: ${resposta.charAt(0).toLowerCase()}${resposta.slice(1)}`;
    }
  }

  // C1: frustração sem escalada humana (repeticao, demora, sem_resposta) — LLM instrui a
  // "continuar o flow" mas o override foi suprimido. Appenda nextQ como segunda bolha para
  // garantir que o fluxo não para após o tratamento de frustração.
  if (frustrationHandling?.skipDeterministicOverride && !frustrationHandling.escalateToHuman
      && nextQDeterministico && !allAnswered
      && advFlowStepType !== "llm_generated" && advFlowStepType !== "llm_gate") {
    const lastOutMsg = history.filter(m => m.direcao === "out").slice(-1)[0]?.conteudo ?? "";
    const normQ = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 70);
    if (!normQ(lastOutMsg).includes(normQ(nextQDeterministico)) && !respostaJaFazPergunta(resposta, nextQDeterministico)) {
      const nome = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
      let resolvedQ = nome ? nextQDeterministico.replace(/\{nome\}/g, nome) : nextQDeterministico.replace(/\{nome\},?\s*/g, "");
      resolvedQ = resolvedQ
        .replace(/\{nome_persona\}/g, persona.nomeExibicao)
        .replace(/\{nome_advogado\}/g, advNomeGlobal)
        .replace(/\{nome_secretaria\}/g, secNomeGlobal)
        .replace(/\{nome_assistente\}/g, assistNomeGlobal);
      resposta = `${resposta}\n\n---\n\n${resolvedQ}`;
    }
  }

  if (!merged._saudacao_enviada) {
    merged._saudacao_enviada = true;
    await atualizarMergedFlags(deal.id, merged, { _saudacao_enviada: true });
  }

  // B14: transition logic — allAnswered handoff + stage transitions
  const temVinculoValido = (vinculosOk || vinculos.length > 0) && !vinculosTodosPrescritos;
  // SDR simplificado e triagem lidam com prescrição via lógica própria — não bloquear aqui
  const prescricaoGate   = isSdrSimples || isSdrTriagem || !regraQualificacao?.requerPrescricaoAtiva || temVinculoValido;
  if (allAnswered && regraQualificacao && prescricaoGate) {
    const evoFarewell = await getEvolutionConfig(projetoId);
    if (evoFarewell) {
      // farewellTexto vem do banco (persona.farewellTexto) — fallback hardcoded para retrocompatibilidade.
      const FAREWELL_FALLBACK = (persona as any).farewellTexto || `Registrei tudo certinho! Nossa equipe vai entrar em contato com você em breve.`;
      let textoFarewell = FAREWELL_FALLBACK;
      // Strip any {placeholder} the LLM may have generated and fall back to the safe text.
      if (/\{[a-z_][a-z0-9_]*\}/.test(textoFarewell)) textoFarewell = FAREWELL_FALLBACK;
      const comportFarewell = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "comportamento" } });
      const getC = (k: string, d: number) => { const v = comportFarewell.find(c => c.chave === k)?.valor; const n = v ? Number(v) : NaN; return isNaN(n) ? d : n; };
      const rd   = (getC("resposta_delay_min", 20) + Math.random() * (getC("resposta_delay_max", 40) - getC("resposta_delay_min", 20))) * 1000;
      const { sendHumanized: sendFarewell } = await import("./message-handler.js");
      try {
        await sendFarewell(evoFarewell, phone, `*${persona.nomeExibicao}*\n${textoFarewell}`, rd);
        await prisma.crmMensagemWhatsapp.create({ data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave, remetente: persona.nomeExibicao, tipo: "text", conteudo: textoFarewell } });
      } catch (err) {
        console.warn(`[StageEngine] sendFarewell falhou para ${phone} — prosseguindo com transição:`, (err as any)?.message ?? err);
      }
    }
    const qualDados = Object.fromEntries(
      Object.entries(merged).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [k, String(v ?? "")]),
    );
    // Briefing acionável para o SDR humano (telefone, vínculos, prescrição, valor, dor, melhor hora)
    const { buildLeadBriefing } = await import("./lead-briefing.js");
    const briefingQualif = await buildLeadBriefing(deal.id, {
      titulo: "🔥 LEAD QUALIFICADO",
      acao: "Ligar para o lead — o robô avisou que um advogado da equipe vai ligar",
    }).catch(() => "");
    dispararNotificacoes(projetoId, "qualificacao_completa", { ...qualDados, telefone: phone, stage: stageChave, briefing: briefingQualif, dealId: deal.id }).catch(() => {});
    const { transitioned: t1, pendingActions: t1Actions } = await transitionDeal(projetoId, deal.id, "qualificacao_completa", phone, stageChave);
    scheduleProativasDeduped(t1Actions, projetoId);
    // Override iaPersonaChave AFTER transitionDeal — transitionDeal sets it from the stage config,
    // but proximaPersonaChave takes precedence when explicitly configured on the persona.
    const proximaPersonaChaveAssistente = (persona as any).proximaPersonaChave as string | undefined;
    if (await proximaPersonaAtiva(projetoId, proximaPersonaChaveAssistente)) {
      await (prisma.crmDeal as any).update({
        where: { id: deal.id },
        data: { iaPersonaChave: proximaPersonaChaveAssistente, iaFlowStepChave: null, iaFlowStepData: {}, iaPersonaTrocadaEm: new Date() },
      });
      console.log(`[StageEngine] assistente allAnswered → ${proximaPersonaChaveAssistente} (proximaPersonaChave) para deal ${deal.id}`);

      // When transitioning to secretaria, send her greeting proactively on this same turn
      // (same inline init the advogado→secretaria path does at line ~779).
      if (proximaPersonaChaveAssistente === "secretaria") {
        try {
          const evoSec = await getEvolutionConfig(projetoId);
          const secPersona = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave: "secretaria" } } });
          if (evoSec && secPersona) {
            const { getSlotsDisponiveis, renderHorarios: renderHorariosSec } = await import("./secretaria-agenda.js");
            const { advanceAdvogadoFlow } = await import("./flow-controller.js");
            const slotsDisp = await getSlotsDisponiveis(projetoId);
            const secFlow   = await advanceAdvogadoFlow(
              projetoId,
              { id: deal.id, iaFlowStepChave: null, iaFlowStepData: {}, qualificacao: deal.qualificacao },
              text ?? "", outgoingCount, history,
              { personaChave: "secretaria", fase: "secretaria" },
            );
            let secGreeting = secFlow.nextQuestion ?? null;
            if (secGreeting) {
              secGreeting = await renderHorariosSec(projetoId, secGreeting, slotsDisp);
            }
            if (secGreeting) {
              const { renderNomePlaceholder } = await import("./gate-evaluator.js");
              const nomeLead = typeof merged.nome === "string" ? merged.nome.split(" ")[0].trim() : "";
              secGreeting = renderNomePlaceholder(secGreeting, nomeLead);
            }
            if (secGreeting) {
              const rdSec = 3000 + Math.random() * 2000;
              await sendHumanizedSafe(evoSec, phone, `*${secPersona.nomeExibicao}*\n${secGreeting}`, rdSec, { deal, persona: secPersona, projetoId });
              await prisma.crmMensagemWhatsapp.create({
                data: { dealId: deal.id, contatoId: contato.id, direcao: "out", personaChave: "secretaria", remetente: secPersona.nomeExibicao, tipo: "text", conteudo: secGreeting },
              });
              // Marcar apresentacao_enviado para evitar cron reenviar a saudação após 90min (BUG-003)
              await prisma.crmDeal.update({
                where: { id: deal.id },
                data: { iaFlowStepData: { ...((deal.iaFlowStepData ?? {}) as object), apresentacao_enviado: true, sec_apresentacao_enviado: true } as any },
              });
              console.log(`[StageEngine] secretaria greeting enviado proativamente + apresentacao_enviado=true para deal ${deal.id}`);
            }
          }
        } catch (secErr) {
          console.warn(`[StageEngine] secretaria proactive greeting falhou para deal ${deal.id}:`, (secErr as any)?.message ?? secErr);
        }
      }
    }
    if (t1) return;
    // Proposal creation is deferred to docs_coletados / dados_coletados — not here.
  }
  let transitioned = false;
  try {
    const t2Result = await checkTransitions(projetoId, deal.id, stageChave, text ?? "", phone);
    scheduleProativasDeduped(t2Result.pendingActions, projetoId);
    transitioned = t2Result.transitioned;
  } catch (err) {
    console.error(`[StageEngine] checkTransitions falhou dealId=${deal.id}:`, err);
  }
  if (transitioned) return;

  // B15: load delays + intercept descarte + dedup + send
  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) { console.error("[StageEngine] Evolution API não configurada"); return; }
  const comportConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "comportamento" } });
  const getC  = (k: string, d: number) => { const v = comportConfigs.find(c => c.chave === k)?.valor; const n = v ? Number(v) : NaN; return isNaN(n) ? d : n; };
  // Deterministic steps don't need the human-like delay — the question is fixed,
  // so there's no risk of sounding rushed. Use 2–4 s (read + typing still applies).
  const delay = willOverrideDeterministic
    ? (2000 + Math.random() * 2000)
    : (getC("resposta_delay_min", 20) + Math.random() * (getC("resposta_delay_max", 40) - getC("resposta_delay_min", 20))) * 1000;

  let isDescarte = false;
  // Só aplicar DESCARTE_REGEX quando a persona ativa for "assistente" — evita falsos positivos
  // quando o advogado usa frases similares em contexto de análise jurídica (BUG-018)
  // O LLM não dispensa por conta própria: sem confirmação, a dispensa vira a pergunta direta.
  if (personaChave === "assistente" && merged._acao_confirmada !== true && isDispensaPorAdvogado(resposta)) {
    console.warn(`[StageEngine] dealId=${deal.id} — dispensa por advogado sem confirmação trocada pela pergunta`);
    resposta = "Só pra eu entender certo: hoje você já tem advogado cuidando desse caso, ou alguma ação trabalhista em andamento contra essa empresa?";
  }
  if (personaChave === "assistente" && DESCARTE_REGEX.test(resposta) && stageChave !== "descartado") {
    isDescarte = true;
    resposta   = "Aguarda um momento aqui, vou verificar com a equipe e já retorno pra você, tá?";
  }

  const textoLimpo = limparResposta(resposta, persona.nomeExibicao);
  const sent = await dedupAndSend(projetoId, evoConfig, deal, contato, phone, persona, personaChave, textoLimpo, delay);
  if (!sent) return;

  // B16: post-send actions
  // Set _mais_empregos_perguntado when Ana just sent the mais_empregos question
  if (personaChave === "assistente" && merged._mais_empregos_perguntado !== true) {
    const MAIS_EMPREGOS_SENT_RE = /outro lugar|outra empresa|mais emprego|trabalhou antes|emprego anterior|outro[s]?\s*v[íi]nculo|vamos investigar/i;
    if (MAIS_EMPREGOS_SENT_RE.test(textoLimpo)) {
      merged._mais_empregos_perguntado = true;
      await persistMergedUpdates(deal.id, merged, { _mais_empregos_perguntado: true });
    }
  }

  // Mark llm_generated flow step as sent so next message advances the step.
  // Use advFlowNextStepChave (the step just advanced to) instead of deal.iaFlowStepChave
  // (stale start-of-request value) — critical when advancing from parecer→valor_estimado
  // so valor_estimado_enviado is set, not parecer_enviado again.
  if ((advFlowStepType === "llm_generated" || advFlowStepType === "llm_gate") && (advFlowNextStepChave ?? (deal as any).iaFlowStepChave)) {
    const chave = (advFlowNextStepChave ?? (deal as any).iaFlowStepChave) as string;
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { iaFlowStepData: { ...((deal as any).iaFlowStepData ?? {}), [`${chave}_enviado`]: true } } });
    // Steps proativos: avança automaticamente sem esperar resposta do lead
    if (advFlowProativo) {
      const proativoDelay = 10000 + Math.random() * 8000; // 10–18s entre blocos
      setTimeout(() => runProativoNextStep(projetoId, deal.id, phone).catch(() => {}), proativoDelay);
    }
  }

  if (PEDIDO_LINK_REGEX.test(text ?? "") && (personaChave === "advogado" || personaChave === "assistente")) {
    resendPropostaLinks(deal.id, projetoId, evoConfig, phone).catch(() => {});
  }

  if (isDescarte) {
    const { moved, justificativa } = await moveToDescarte(projetoId, deal.id, vinculosTodosPrescritos);
    if (moved) {
      const empresa = String(merged.empresa_recente ?? (Array.isArray(merged.vinculos) && (merged.vinculos as any[])[0]?.empresa) ?? "");
      const { buildLeadBriefing: buildBriefingDesc } = await import("./lead-briefing.js");
      const briefingDescarte = await buildBriefingDesc(deal.id, {
        titulo: "🗑 DESCARTE PARA REVISÃO HUMANA",
        acao: `Revisar antes de perder o lead — motivo: ${justificativa}`,
      }).catch(() => "");
      dispararNotificacoes(projetoId, "descarte_revisao_humana", {
        nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone,
        cidade: String(merged.cidade ?? ""), empresa, justificativa, briefing: briefingDescarte, dealId: deal.id,
      }).catch(() => {});
      console.log(`[StageEngine] Deal ${deal.id} → descartado — ${justificativa}`);
    }
    return;
  }

  // SDR simplificado: gate de descarte (prescrição, sem CLT, recusa, etc.)
  // A mensagem de encerramento já foi enviada pelo deterministic override.
  if (isSdrSimples && advFlowNextStepChave === "__discarded__") {
    await moveToDescarte(projetoId, deal.id, false).catch(() => {});
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { iaAtiva: false } });
    dispararNotificacoes(projetoId, "sdr_descartado", {
      nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone,
    }).catch(() => {});
    console.log(`[SdrSimples] dealId=${deal.id} → descartado via gate`);
    return;
  }

  // SDR triagem: handle intermediate stage transitions and disqualifications
  if (isSdrTriagem && triagemPostPhaseRoute && !allAnswered) {
    const route = triagemPostPhaseRoute;
    if (route.toStage === "lead_desqualificado") {
      await moveToDescarte(projetoId, deal.id, false).catch(() => {});
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { iaAtiva: false } });
      dispararNotificacoes(projetoId, "sdr_triagem_desqualificado", {
        nome: String(merged.nome ?? contato.nome ?? ""), telefone: phone, motivo: route.motivo,
      }).catch(() => {});
      console.log(`[SdrTriagem] dealId=${deal.id} → desqualificado (${route.motivo})`);
      return;
    }
    // Intermediate transition: try DB rule first, fall back to direct update
    const { transitioned: t3, pendingActions: t3Actions } = await transitionDeal(projetoId, deal.id, `goto_${route.toStage}`, phone);
    scheduleProativasDeduped(t3Actions, projetoId);
    if (!t3) {
      // No matching IaRegraTransicao — update stage directly
      await prisma.crmDeal.update({
        where: { id: deal.id },
        data: { iaStageChave: route.toStage, iaFlowStepChave: null, iaFlowStepData: undefined },
      });
      const { marcarEntradaEtapa } = await import("./lead-qualificado.js");
      void marcarEntradaEtapa(deal.id, route.toStage, `ia:triagem:${route.motivo}`);
    }
    console.log(`[SdrTriagem] dealId=${deal.id} → stage "${route.toStage}" (${route.motivo})`);
  }

  if ((personaChave === "daniela" || personaChave?.includes("closer") || personaChave === "advogado") && PARECER_KEYWORDS.test(resposta) && !persona.usarAudio) {
    // sendAudioIfConfigured only when persona doesn't already send audio via sendHumanizedOrAudio (usarAudio=false).
    // When usarAudio=true, dedupAndSend already sent the audio — calling this again would duplicate it.
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
    criarPropostaAutomatica(projetoId, deal.id, phone, "dados_coletados").catch(() => {});
  }

  await prisma.crmDeal.update({ where: { id: deal.id }, data: { ultimoContatoEm: new Date() } });

  } finally {
    _dealProcessingSet.delete(deal.id);
  }
}

/**
 * Auto-advances a proativo llm_generated flow step for the advogado persona.
 * Called internally via setTimeout after sending a step with proativo=true.
 * Re-runs handleAdvogadoFlow (which sees _enviado=true and advances), generates
 * LLM content for the next step, sends it, and chains another auto-advance if needed.
 */
export async function runProativoNextStep(projetoId: string, dealId: string, phone: string, tentativa = 0): Promise<void> {
  // Mesmo mutex por deal do webhook: sem ele, um webhook chegando durante o setTimeout do
  // proativo processava em paralelo e gerava mensagens/avanços de step duplicados.
  if (_dealProcessingSet.has(dealId)) {
    if (tentativa < 3) {
      setTimeout(() => runProativoNextStep(projetoId, dealId, phone, tentativa + 1).catch(() => {}), 15_000);
    } else {
      console.log(`[ProativoNextStep] dealId=${dealId} — lock ocupado após ${tentativa} tentativas; desistindo (webhook conduz o flow)`);
    }
    return;
  }
  _dealProcessingSet.add(dealId);
  try {
    await runProativoNextStepLocked(projetoId, dealId, phone);
  } finally {
    _dealProcessingSet.delete(dealId);
  }
}

async function runProativoNextStepLocked(projetoId: string, dealId: string, phone: string): Promise<void> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal || !(deal as any).iaAtiva) return;

  const personaChave = (deal as any).iaPersonaChave ?? "advogado";
  if (personaChave !== "advogado") return;

  const persona = await prisma.iaPersona.findUnique({ where: { projetoId_chave: { projetoId, chave: personaChave } } });
  if (persona && !persona.ativo) {
    console.log(`[Proativo] dealId=${dealId} — persona "${personaChave}" desativada; mensagem proativa cancelada`);
    return;
  }
  if (!persona) return;

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  const { handleAdvogadoFlow } = await import("./flow-controller.js");
  const advFlow = await handleAdvogadoFlow(
    projetoId,
    { id: deal.id, iaFlowStepChave: (deal as any).iaFlowStepChave ?? null, iaFlowStepData: (deal as any).iaFlowStepData ?? null, qualificacao: deal.qualificacao },
    "", 0, [],
  );

  if (!advFlow.nextQuestion || advFlow.stepType !== "llm_generated") return;

  const history = await prisma.crmMensagemWhatsapp.findMany({ where: { dealId }, orderBy: { enviadaEm: "desc" }, take: 20 });
  history.reverse();

  const merged = { ...(deal.qualificacao as Record<string, unknown> ?? {}), ...((deal as any).iaFlags as Record<string, unknown> ?? {}) };
  const instrBase = buildInstrucaoBase();
  const [advNomeProativo, assistNomeProativo, escritorioNomeCfgPro] = await Promise.all([
    getPersonaNomeExibicao(projetoId, "advogado"),
    getPersonaNomeExibicao(projetoId, "assistente"),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "comportamento.escritorio_nome" } }),
  ]);
  const escritorioNomeProativo = escritorioNomeCfgPro?.valor ?? "";

  // Extract vinculos from merged so the system prompt has lead case data
  const vinculosRaw = Array.isArray(merged.vinculos) ? merged.vinculos as import("./types.js").VinculoEmprego[] : [];

  const { runAdvogadoAgent } = await import("./advogado-agents.js");
  const advResult = await runAdvogadoAgent({
    projetoId,
    iaFlowStepChave: advFlow.nextStepChave ?? null,
    merged,
    vinculos: vinculosRaw,
  });

  const systemPrompt = buildSystemPrompt({
    personaChave, personaNome: persona.nomeExibicao,
    personaInstrucoes: advResult.systemInstructions,
    personaFase: "",
    instrucaoComportamento: persona.systemPrompt, instrucaoBase: instrBase,
    perguntasDeterministicas: [], camposBloqueados: [],
    merged: { ...merged, ...((deal as any).iaFlowStepData as Record<string, unknown> ?? {}) },
    vinculos: vinculosRaw, vinculosOk: vinculosRaw.length > 0, vinculosTodosPrescritos: false,
    iaFlowStepChave: advFlow.nextStepChave ?? null,
    iaFlowStepData: (deal as any).iaFlowStepData as Record<string, unknown> ?? {},
    nextQDeterministico: advFlow.nextQuestion, advFlowStepType: "llm_generated",
    advFlowNextStepChave: advFlow.nextStepChave ?? null, advFlowCampoColetar: null,
    valueInjection: null, handoffSnapshot: buildHandoffSnapshot(merged, advNomeProativo),
    frustrationInjection: null,
    outgoingCount: 0, nomeCliente: typeof merged.nome === "string" ? merged.nome : null,
    cidadeCliente: typeof merged.cidade === "string" ? merged.cidade : null,
    incomingText: "",
    assistenteNome: assistNomeProativo,
    escritorioNome: escritorioNomeProativo,
    advogadoNome: advNomeProativo,
  });

  const llmMessages = history.map(m => ({ role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant", content: m.conteudo ?? "" }));

  let resposta = "";
  try {
    resposta = await callLlmWithRetry(projetoId, deal.id, systemPrompt, llmMessages, personaChave, (persona as any).llmProviderChave ?? null, (deal as any).iaStageChave ?? "lead_qualificado", true);
  } catch {
    console.warn(`[ProativoNextStep] LLM falhou dealId=${dealId}`);
    return;
  }
  if (!resposta) return;

  const { limparResposta } = await import("./message-handler.js");
  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  if (!contato) return;

  const textoLimpo = limparResposta(resposta, persona.nomeExibicao);
  const delay = 8000 + Math.random() * 6000;
  const sent = await dedupAndSend(projetoId, evoConfig, deal as any, contato, phone, persona, personaChave, textoLimpo, delay);
  if (!sent) return;

  const nextChave = advFlow.nextStepChave as string;
  await prisma.crmDeal.update({
    where: { id: deal.id },
    data: { iaFlowStepData: { ...((deal as any).iaFlowStepData ?? {}), [`${nextChave}_enviado`]: true } },
  });

  if (advFlow.proativo) {
    const nextDelay = 10000 + Math.random() * 8000;
    setTimeout(() => runProativoNextStep(projetoId, dealId, phone).catch(() => {}), nextDelay);
  }
}
