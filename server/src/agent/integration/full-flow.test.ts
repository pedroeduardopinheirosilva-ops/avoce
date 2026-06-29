/**
 * Integration test: full processIncomingMessage flow.
 * Mocks all I/O boundaries; tests three scenarios end-to-end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Shared state + mock fns (vi.hoisted → available in vi.mock factories) ────
const { state, mocks } = vi.hoisted(() => {
  const state = {
    contato: { id: "c1", nome: "Lead 5511999999999", whatsapp: "5511999999999", cpf: null, email: null } as Record<string, any>,
    deal: {
      id: "d1", projetoId: "p1", contatoId: "c1", titulo: "Lead 5511999999999",
      iaAtiva: true, iaStageChave: "lead_carreteiro", iaPersonaChave: "assistente",
      iaFlowStepChave: null, iaFlowStepData: null, iaPersonaTrocadaEm: null,
      qualificacao: {} as Record<string, unknown>,
      iaFlags: {} as Record<string, unknown>,
      status: "aberto", criadoEm: new Date(), ultimoContatoEm: new Date(),
    } as Record<string, any>,
    messages: [] as Array<Record<string, any>>,
    sentMessages: [] as string[],
    isNewDeal: true,
    seenIds: new Set<string>(),
    reset() {
      this.contato = { id: "c1", nome: "Lead 5511999999999", whatsapp: "5511999999999", cpf: null, email: null };
      this.deal = {
        id: "d1", projetoId: "p1", contatoId: "c1", titulo: "Lead 5511999999999",
        iaAtiva: true, iaStageChave: "lead_carreteiro", iaPersonaChave: "assistente",
        iaFlowStepChave: null, iaFlowStepData: null, iaPersonaTrocadaEm: null,
        qualificacao: {} as Record<string, unknown>, iaFlags: {} as Record<string, unknown>,
        status: "aberto", criadoEm: new Date(), ultimoContatoEm: new Date(),
      };
      this.messages.length = 0;
      this.sentMessages.length = 0;
      this.isNewDeal = true;
      this.seenIds = new Set<string>();
    },
  };

  const mocks = {
    callLlm: vi.fn(async () => ({ content: "Olá! Qual o seu nome completo?", usage: { input: 100, output: 50 } })),
    transcribeAudio: vi.fn(async () => ({ ok: true, text: "áudio simulado" })),
    downloadAudioFromEvolution: vi.fn(async () => ({ buffer: Buffer.from(""), contentType: "audio/ogg" })),
    normalizeInput: vi.fn(async (_pid: string, msg: any) => ({
      text: msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? null,
      documentosEnviados: false,
      docJsonDireto: null,
      tipo: msg.messageType ?? "text",
    })),
    extractQual: vi.fn(async () => ({} as Record<string, unknown>)),
    processVinculos: vi.fn(async () => ({
      mergedUpdates: {},
      notasParaCriar: [] as string[],
      state: { vinculos: [], vinculosOk: false, todosPrescritosFlag: false },
    })),
    runAssistente: vi.fn(async () => ({
      allDone: false, phase: "qualificacao",
      deterministicQuestion: "Qual o seu nome completo?",
      systemInstructions: "", dealUpdates: null,
    })),
    getGreetingStep: vi.fn(async () => "Sou a Ana, assistente do escritório. Me conta, qual é o seu nome?"),
    transitionDeal: vi.fn(async () => ({ transitioned: false, pendingActions: [] as any[] })),
    checkTransitions: vi.fn(async () => ({ transitioned: false, pendingActions: [] as any[] })),
    // Devem retornar true: dedupAndSend só persiste a mensagem out quando sent=true,
    // e a persistência é o que permite o dedup bloquear o reenvio de webhooks duplicados.
    sendHumanized: vi.fn(async () => true),
    sendHumanizedSafe: vi.fn(async () => true),
  };

  return { state, mocks };
});

// ─── Mock: Prisma ─────────────────────────────────────────────────────────────
vi.mock("../../db.js", () => ({
  prisma: {
    crmContato: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.whatsapp === state.contato.whatsapp) return state.contato;
        return null;
      }),
      create: vi.fn(async ({ data }: any) => { Object.assign(state.contato, data); return state.contato; }),
      update: vi.fn(async ({ data }: any) => { Object.assign(state.contato, data); return state.contato; }),
    },
    crmDeal: {
      findFirst: vi.fn(async () => state.isNewDeal ? null : state.deal),
      findUnique: vi.fn(async () => state.deal),
      create: vi.fn(async ({ data }: any) => {
        state.isNewDeal = false;
        Object.assign(state.deal, data);
        return state.deal;
      }),
      update: vi.fn(async ({ data }: any) => {
        if (data.qualificacao !== undefined) Object.assign(state.deal.qualificacao, data.qualificacao);
        if (data.iaFlags !== undefined) Object.assign(state.deal.iaFlags, data.iaFlags);
        const { qualificacao: _q, iaFlags: _f, ...rest } = data;
        Object.assign(state.deal, rest);
        return state.deal;
      }),
    },
    crmMensagemWhatsapp: {
      create: vi.fn(async ({ data }: any) => {
        if (data.evolutionMessageId && state.seenIds.has(data.evolutionMessageId)) {
          const e: any = new Error("Unique constraint"); e.code = "P2002"; throw e;
        }
        if (data.evolutionMessageId) state.seenIds.add(data.evolutionMessageId);
        const msg = { id: `m${state.messages.length}`, enviadaEm: new Date(), ...data };
        state.messages.push(msg);
        if (data.direcao === "out") state.sentMessages.push(data.conteudo ?? "");
        return msg;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => [...state.messages]),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        let list = [...state.messages];
        if (where?.direcao) list = list.filter(m => m.direcao === where.direcao);
        if (where?.dealId) list = list.filter(m => m.dealId === where.dealId);
        if (where?.conteudo) list = list.filter(m => m.conteudo === where.conteudo);
        if (where?.enviadaEm?.gte) list = list.filter(m => new Date(m.enviadaEm) >= new Date(where.enviadaEm.gte));
        // dedupAndSend usa `enviadaEm: { gt: ... }` para checar resposta do lead após o último out
        if (where?.enviadaEm?.gt) list = list.filter(m => new Date(m.enviadaEm) > new Date(where.enviadaEm.gt));
        if (!list.length) return null;
        if (orderBy?.enviadaEm === "desc") return list[list.length - 1];
        return list[0];
      }),
      count: vi.fn(async ({ where }: any) => {
        let list = [...state.messages];
        if (where?.direcao) list = list.filter(m => m.direcao === where.direcao);
        if (where?.dealId) list = list.filter(m => m.dealId === where.dealId);
        return list.length;
      }),
    },
    crmNota: { create: vi.fn(async () => ({ id: "n1" })) },
    iaFaseFunil: {
      findUnique: vi.fn(async () => ({
        id: "f1", chave: "lead_carreteiro", personaChave: "assistente",
        requerAcaoHumana: false, pipelineId: "pipe1", ehEntrada: true, requerPrescricaoAtiva: false,
      })),
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.ehEntrada) return { id: "f1", chave: "lead_carreteiro", personaChave: "assistente", pipelineId: "pipe1", ehEntrada: true };
        return null;
      }),
    },
    iaPersona: {
      findUnique: vi.fn(async () => ({
        id: "per1", chave: "assistente", nomeExibicao: "Ana", projetoId: "p1",
        systemPrompt: "Você é {nome_persona}. {INSTRUÇÃO BASE}", llmProviderChave: null,
      })),
    },
    iaPerguntaQualificacao: { findMany: vi.fn(async () => []) },
    iaRegraTransicao: {
      findFirst: vi.fn(async () => ({
        id: "r1", stageOrigemChave: "lead_carreteiro", condicao: "qualificacao_completa",
        stageDestinoChave: "qualificado", requerPrescricaoAtiva: false,
      })),
    },
    iaProjetoConfig: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => null),
    },
    crmPipeline: {
      findFirst: vi.fn(async () => ({
        id: "pipe1", tipo: "comercial", ativo: true,
        stages: [{ id: "stage1", ehEntrada: true }],
      })),
    },
    crmStage: { findFirst: vi.fn(async () => ({ id: "stage1", chave: "lead_carreteiro" })) },
    iaNotificacaoEvento: { findMany: vi.fn(async () => []) },
    iaNotificacaoLog: { create: vi.fn(async () => ({})) },
    // Novos acessos do stage-engine: empresas bloqueadas + gates SDR (gate-evaluator)
    iaEmpresaBloqueada: { findMany: vi.fn(async () => []) },
    iaGateSdr: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
  },
}));

// ─── Mock: Evolution service ──────────────────────────────────────────────────
vi.mock("../../services/evolution.js", () => ({
  sendText: vi.fn(async () => ({ key: { id: "ev1" }, status: "PENDING" })),
  sendTyping: vi.fn(async () => {}),
  downloadMedia: vi.fn(async () => Buffer.from("fake")),
  markAsRead: vi.fn(async () => {}),
  sendWhatsAppAudio: vi.fn(async () => {}),
  sendImage: vi.fn(async () => {}),
  sendDocument: vi.fn(async () => {}),
}));

// ─── Mock: LLM ───────────────────────────────────────────────────────────────
vi.mock("../llm.js", () => ({ callLlm: mocks.callLlm }));

// ─── Mock: Whisper ───────────────────────────────────────────────────────────
vi.mock("../../services/whisper.js", () => ({
  transcribeAudio: mocks.transcribeAudio,
  downloadAudioFromEvolution: mocks.downloadAudioFromEvolution,
}));

// ─── Mock: normalizeInput ─────────────────────────────────────────────────────
vi.mock("../media-processor.js", () => ({ normalizeInput: mocks.normalizeInput }));

// ─── Mock: qualification ─────────────────────────────────────────────────────
vi.mock("../qualification.js", () => ({
  extractQualificacaoData: mocks.extractQual,
  extractVinculosFromMerged: vi.fn(() => []),
}));

// ─── Mock: vinculos-processor ────────────────────────────────────────────────
vi.mock("../vinculos-processor.js", () => ({ processVinculos: mocks.processVinculos }));

// ─── Mock: assistente-agents (dynamically imported by stage-engine) ───────────
vi.mock("../assistente-agents.js", () => ({ runAssistenteAgent: mocks.runAssistente }));

// ─── Mock: flow-controller (dynamically imported by stage-engine) ─────────────
vi.mock("../flow-controller.js", () => ({
  getGreetingStep: mocks.getGreetingStep,
  handleAdvogadoFlow: vi.fn(async () => ({ nextQuestion: null, stepType: null, nextStepChave: null })),
  invalidateFlowCache: vi.fn(),
}));

// ─── Mock: advogado-agents (dynamically imported by stage-engine) ─────────────
vi.mock("../advogado-agents.js", () => ({
  runAdvogadoAgent: vi.fn(async () => ({ phase: "init", systemInstructions: "" })),
}));

// ─── Mock: transition-engine ──────────────────────────────────────────────────
vi.mock("../transition-engine.js", () => ({
  transitionDeal: mocks.transitionDeal,
  checkTransitions: mocks.checkTransitions,
  enviarMensagemProativa: vi.fn(async () => {}),
  // stage-engine agora também importa estes dois (B9a auto-tags + nomes de persona)
  applyAutoTags: vi.fn(async () => {}),
  getPersonaNomeExibicao: vi.fn(async (_pid: string, chave: string) => chave),
}));

// ─── Mock: output-guard ───────────────────────────────────────────────────────
vi.mock("../output-guard.js", () => ({
  assertSendable: vi.fn(() => {}),
  handleBlockedSend: vi.fn(async () => ({ fallbackText: null })),
  PromptLeakError: class PromptLeakError extends Error {
    constructor(msg: string) { super(msg); this.name = "PromptLeakError"; }
  },
}));

// ─── Mock: message-handler ────────────────────────────────────────────────────
vi.mock("../message-handler.js", () => ({
  sendHumanized: mocks.sendHumanized,
  sendHumanizedSafe: mocks.sendHumanizedSafe,
  normalizarTexto: (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(),
  limparResposta: (t: string) => t,
  getEvolutionConfig: vi.fn(async () => ({ baseUrl: "http://evo", apiKey: "k", instancia: "inst" })),
  respondFromDealState: vi.fn(async () => {}),
  sendAudioIfConfigured: vi.fn(async () => {}),
  dispararNotificacoes: vi.fn(async () => {}),
  checkAndNotifySolicitaLigacao: vi.fn(async () => ({ notificado: false })),
}));

// ─── Mock: system-prompt-builder ─────────────────────────────────────────────
vi.mock("../system-prompt-builder.js", () => ({
  buildSystemPrompt: vi.fn(() => "SYSTEM_PROMPT"),
}));

// ─── Mock: persona-router ────────────────────────────────────────────────────
vi.mock("../persona-router.js", () => ({
  buildInstrucaoBase: vi.fn(() => "INSTRUCAO_BASE"),
  detectarFaseAtualDaniela: vi.fn(() => "inicial"),
  invalidateFlowCache: vi.fn(),
  // stage-engine: tracking do passo de vínculo atual + parser de tempo (reopen path)
  getLastVinculoStepChave: vi.fn(() => null),
  parseTempToMeses: vi.fn(() => 999),
}));

// ─── Mock: deal-repository ────────────────────────────────────────────────────
vi.mock("../deal-repository.js", () => ({
  splitState: vi.fn((merged: Record<string, unknown>) => {
    const qualificacao: Record<string, unknown> = {};
    const iaFlags: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (k.startsWith("_")) iaFlags[k] = v; else qualificacao[k] = v;
    }
    return { qualificacao, iaFlags };
  }),
  atualizarMergedFlags: vi.fn(async (_id: string, _merged: any, flags: any) => {
    Object.assign(state.deal.iaFlags, flags);
  }),
  createInitialDeal: vi.fn(async () => {
    state.isNewDeal = false;
    return state.deal;
  }),
  persistMergedUpdates: vi.fn(async () => {}),
  moveToDescarte: vi.fn(async () => ({ moved: false, justificativa: "" })),
  saveParecerValue: vi.fn(async () => {}),
}));

// ─── Mock: retry-queue ───────────────────────────────────────────────────────
vi.mock("../retry-queue.js", () => ({ scheduleLlmRetry: vi.fn() }));

// ─── Mock: humanizer ─────────────────────────────────────────────────────────
vi.mock("../humanizer.js", () => ({ isHumanized: vi.fn(() => true) }));

// ─── Mock: identity-handler ──────────────────────────────────────────────────
vi.mock("../identity-handler.js", () => ({
  detectIdentityQuestion: vi.fn(() => false),
  buildIdentityResponse: vi.fn(async () => "Sou a Ana."),
  registrarEventoIdentidade: vi.fn(async () => {}),
}));

// ─── Mock: frustration-detector ──────────────────────────────────────────────
vi.mock("../frustration-detector.js", () => ({
  detectFrustration: vi.fn(() => null),
  buildFrustrationHandling: vi.fn(() => ({})),
}));

// ─── Mock: proposal-engine ───────────────────────────────────────────────────
vi.mock("../proposal-engine.js", () => ({
  criarPropostaAutomatica: vi.fn(async () => {}),
  resendPropostaLinks: vi.fn(async () => {}),
  PEDIDO_LINK_REGEX: /envia.*link|manda.*link/i,
}));

// ─── Mock: handoff-snapshot ──────────────────────────────────────────────────
vi.mock("../handoff-snapshot.js", () => ({
  buildHandoffSnapshot: vi.fn(() => "HANDOFF"),
}));

// ─── Mock: value-trigger ─────────────────────────────────────────────────────
vi.mock("../value-trigger.js", () => ({
  isAskingValue: vi.fn(() => false),
  buildValueResponseInjection: vi.fn(() => ""),
}));

// ─── Mock: calc-trabalhista ───────────────────────────────────────────────────
vi.mock("../calc-trabalhista.js", () => ({
  calcularValorCausa: vi.fn(() => ({ total: 0, detalhes: [] })),
}));

// ─── Mock: qualification-utils ───────────────────────────────────────────────
vi.mock("../qualification-utils.js", () => ({
  validarCPF: vi.fn(() => false),
  temDadosMinimosCalculo: vi.fn(() => false),
}));

// ─── SUT ─────────────────────────────────────────────────────────────────────
import { processIncomingMessage } from "../stage-engine.js";
import type { EvolutionWebhookMessage } from "../webhook-parser.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeMsg(id: string, text: string): EvolutionWebhookMessage {
  return {
    key: { id, remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: text },
    messageType: "text",
    pushName: "João",
  };
}

const PROJETO_ID = "p1";

// ─── beforeEach: reset state + restore default mock implementations ───────────
beforeEach(() => {
  state.reset();
  vi.clearAllMocks();

  mocks.callLlm.mockResolvedValue({ content: "Olá! Qual o seu nome completo?", usage: { input: 100, output: 50 } });

  mocks.normalizeInput.mockImplementation(async (_pid: string, msg: any) => ({
    text: msg.message?.conversation ?? msg.message?.extendedTextMessage?.text ?? null,
    documentosEnviados: false, docJsonDireto: null, tipo: msg.messageType ?? "text",
  }));

  mocks.runAssistente.mockResolvedValue({
    allDone: false, phase: "qualificacao",
    deterministicQuestion: "Qual o seu nome completo?",
    systemInstructions: "", dealUpdates: null,
  });

  mocks.extractQual.mockResolvedValue({});

  mocks.processVinculos.mockResolvedValue({
    mergedUpdates: {}, notasParaCriar: [],
    state: { vinculos: [], vinculosOk: false, todosPrescritosFlag: false },
  });

  mocks.transitionDeal.mockResolvedValue({ transitioned: false, pendingActions: [] });
  mocks.checkTransitions.mockResolvedValue({ transitioned: false, pendingActions: [] });
  mocks.getGreetingStep.mockResolvedValue("Sou a Ana, assistente do escritório. Me conta, qual é o seu nome?");
});

// ─── Scenario 1: 4-message qualification flow ─────────────────────────────────
describe("Scenario 1: Ana qualification flow", () => {
  it("Msg 1 (new deal): sends greeting without calling LLM", async () => {
    state.isNewDeal = true;

    await processIncomingMessage(PROJETO_ID, makeMsg("msg1", "oi"), false);

    expect(mocks.callLlm).not.toHaveBeenCalled();
    expect(mocks.sendHumanized).toHaveBeenCalledOnce();
    const sentText = (mocks.sendHumanized.mock.calls[0] as unknown[])[2] as string;
    expect(sentText).toMatch(/sou a ana|bom dia|boa tarde|boa noite/i);
  });

  it("Msg 2 (nome): extractQualificacaoData called, pergunta determinística enviada SEM chamar LLM", async () => {
    state.isNewDeal = false;
    state.deal.iaFlags = { _saudacao_enviada: true };
    mocks.extractQual.mockResolvedValueOnce({ nome: "João Silva" });

    await processIncomingMessage(PROJETO_ID, makeMsg("msg2", "João Silva"), false);

    expect(mocks.extractQual).toHaveBeenCalled();
    // Comportamento atual: quando há nextQDeterministico para a assistente, o stage-engine
    // pula o LLM ("skipLLM — deterministic override") e envia a pergunta verbatim.
    expect(mocks.callLlm).not.toHaveBeenCalled();
    expect(mocks.sendHumanizedSafe).toHaveBeenCalledOnce();
    // O override determinístico pode personalizar com o nome do lead ("João, qual o seu nome...")
    const sent = (mocks.sendHumanizedSafe.mock.calls[0] as unknown[])[2] as string;
    expect(sent).toMatch(/qual o seu nome completo\?/i);
  });

  it("Msg 3 (work history): empresa_recente and vinculo_recente saved to deal state", async () => {
    state.isNewDeal = false;
    state.deal.qualificacao = { nome: "João Silva" };
    state.deal.iaFlags = { _saudacao_enviada: true };
    mocks.extractQual.mockResolvedValueOnce({
      empresa_recente: "Transportes ABC",
      vinculo_recente: "CLT",
      cidade: "Vitória da Conquista",
    });

    await processIncomingMessage(PROJETO_ID, makeMsg("msg3", "Trabalhei 3 anos na Transportes ABC, carteira assinada"), false);

    expect(mocks.extractQual).toHaveBeenCalled();
    // Deterministic override: pergunta enviada sem LLM (ver Msg 2)
    expect(mocks.sendHumanizedSafe).toHaveBeenCalled();
    const merged = { ...state.deal.qualificacao, ...state.deal.iaFlags };
    expect(merged.nome).toBe("João Silva");
    expect(merged.empresa_recente).toBe("Transportes ABC");
    expect(merged.vinculo_recente).toBe("CLT");
  });

  it("Msg 4 (allDone): transitionDeal called, setTimeout fires proativa at 45000ms", async () => {
    state.isNewDeal = false;
    state.deal.qualificacao = {
      nome: "João Silva", empresa_recente: "Transportes ABC",
      vinculo_recente: "CLT", cidade: "Vitória da Conquista",
    };
    state.deal.iaFlags = { _saudacao_enviada: true };

    mocks.runAssistente.mockResolvedValueOnce({
      allDone: true, phase: "qualificacao_completa",
      deterministicQuestion: null as unknown as string, systemInstructions: "", dealUpdates: null,
    });
    mocks.transitionDeal.mockResolvedValueOnce({
      transitioned: true,
      pendingActions: [{
        type: "send_proativa", dealId: "d1", phone: "5511999999999",
        motivoCron: "qualificacao_completa", nomeCliente: "João Silva", delayMs: 45000,
      }],
    });

    const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation((_fn, _delay) => 0 as any);

    await processIncomingMessage(PROJETO_ID, makeMsg("msg4", "sim tinha horas extras"), false);

    // transitionDeal agora recebe um 5º argumento: stageChaveOverride (stage efetivo do deal)
    expect(mocks.transitionDeal).toHaveBeenCalledWith(PROJETO_ID, "d1", "qualificacao_completa", "5511999999999", "lead_carreteiro");

    const t45 = setTimeoutSpy.mock.calls.find(c => c[1] === 45000);
    expect(t45).toBeDefined();

    setTimeoutSpy.mockRestore();
  });

  it("after sequential msgs 2+3: merged has nome, empresa_recente, vinculo_recente", async () => {
    state.isNewDeal = false;
    state.deal.iaFlags = { _saudacao_enviada: true };

    mocks.extractQual.mockResolvedValueOnce({ nome: "João Silva" });
    await processIncomingMessage(PROJETO_ID, makeMsg("s2", "João Silva"), false);

    mocks.extractQual.mockResolvedValueOnce({ empresa_recente: "Transportes ABC", vinculo_recente: "CLT" });
    await processIncomingMessage(PROJETO_ID, makeMsg("s3", "trabalhei na Transportes ABC"), false);

    const merged = { ...state.deal.qualificacao, ...state.deal.iaFlags };
    expect(merged.nome).toBe("João Silva");
    expect(merged.empresa_recente).toBe("Transportes ABC");
    expect(merged.vinculo_recente).toBe("CLT");
  });
});

// ─── Scenario 2: Duplicate message guard ─────────────────────────────────────
describe("Scenario 2: Duplicate evolutionMessageId", () => {
  it("second call (saveOnly=false) does not send another message (dedupAndSend blocks)", async () => {
    state.isNewDeal = false;
    state.deal.iaFlags = { _saudacao_enviada: true };

    const dupMsg = makeMsg("SAME_ID_001", "oi tudo bem");

    // First call — full processing, one send
    await processIncomingMessage(PROJETO_ID, dupMsg, false);
    const sentAfterFirst = mocks.sendHumanizedSafe.mock.calls.length;
    expect(sentAfterFirst).toBeGreaterThanOrEqual(1);

    // Second call — same id → P2002 → "early_path" → continues but dedupAndSend blocks re-send
    await processIncomingMessage(PROJETO_ID, dupMsg, false);
    expect(mocks.sendHumanizedSafe.mock.calls.length).toBe(sentAfterFirst);
  });

  it("saveOnly=true twice: second call returns immediately without calling LLM", async () => {
    state.isNewDeal = false;
    state.deal.iaFlags = { _saudacao_enviada: true };

    const msg = makeMsg("SAVEID_001", "teste");

    await processIncomingMessage(PROJETO_ID, msg, true);
    expect(mocks.callLlm).not.toHaveBeenCalled();

    // P2002 on second create → "duplicate" returned → early return
    await processIncomingMessage(PROJETO_ID, msg, true);
    expect(mocks.callLlm).not.toHaveBeenCalled();
  });
});

// ─── Scenario 3: Audio message transcription ─────────────────────────────────
describe("Scenario 3: Audio message", () => {
  it("transcribed text is passed to extractQualificacaoData", async () => {
    state.isNewDeal = false;
    state.deal.iaFlags = { _saudacao_enviada: true };

    const transcribedText = "quero saber sobre meus direitos";

    mocks.normalizeInput.mockResolvedValueOnce({
      text: transcribedText, documentosEnviados: false, docJsonDireto: null, tipo: "audio",
    });

    const audioMsg: EvolutionWebhookMessage = {
      key: { id: "audio1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: false },
      message: { audioMessage: { url: "https://example.com/audio.ogg" } },
      messageType: "audioMessage",
      pushName: "João",
    };

    await processIncomingMessage(PROJETO_ID, audioMsg, false);

    // Assinatura atual: extractQualificacaoData(projetoId, texto, perguntas[], merged, personaLlmChave)
    // O texto transcrito chega prefixado com "Cliente: " — verifica pelo argumento posicional.
    expect(mocks.extractQual).toHaveBeenCalled();
    const extractArgs = mocks.extractQual.mock.calls[0] as unknown[];
    expect(String(extractArgs[1])).toContain(transcribedText);
    // Deterministic override: a resposta é enviada sem chamar o LLM
    expect(mocks.sendHumanizedSafe).toHaveBeenCalled();
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────
describe("Guards", () => {
  it("fromMe=true: ignores message without normalizing", async () => {
    const msg: EvolutionWebhookMessage = {
      key: { id: "fm1", remoteJid: "5511999999999@s.whatsapp.net", fromMe: true },
      message: { conversation: "test" },
      messageType: "text",
    };
    await processIncomingMessage(PROJETO_ID, msg, false);
    expect(mocks.normalizeInput).not.toHaveBeenCalled();
  });

  it("group message (@g.us): ignores message", async () => {
    const msg: EvolutionWebhookMessage = {
      key: { id: "gm1", remoteJid: "group@g.us", fromMe: false },
      message: { conversation: "test" },
      messageType: "text",
    };
    await processIncomingMessage(PROJETO_ID, msg, false);
    expect(mocks.normalizeInput).not.toHaveBeenCalled();
  });

  it("iaAtiva=false: saves message but skips LLM", async () => {
    state.isNewDeal = false;
    state.deal.iaAtiva = false;

    await processIncomingMessage(PROJETO_ID, makeMsg("ia1", "oi"), false);

    expect(mocks.callLlm).not.toHaveBeenCalled();
  });

  it("fase.requerAcaoHumana=true: saves message but skips LLM", async () => {
    state.isNewDeal = false;
    const { prisma } = await import("../../db.js");
    vi.mocked((prisma as any).iaFaseFunil.findUnique).mockResolvedValueOnce({
      id: "f1", chave: "lead_carreteiro", personaChave: "assistente",
      requerAcaoHumana: true, pipelineId: "pipe1", ehEntrada: true, requerPrescricaoAtiva: false,
    });

    await processIncomingMessage(PROJETO_ID, makeMsg("fa1", "oi"), false);

    expect(mocks.callLlm).not.toHaveBeenCalled();
  });
});
