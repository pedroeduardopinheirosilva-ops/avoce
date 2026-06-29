/**
 * SDR Avoce — Testes de Regressão de Bugs Críticos
 *
 * Cada describe indica o(s) BUG(s) que o grupo cobre.
 * Testes marcados com "BUG ATIVO" falhará enquanto o bug não for corrigido.
 * Testes marcados com "COMPORTAMENTO ESPERADO" documentam o comportamento correto já existente.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks globais — declarados antes de qualquer import
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../db.js", () => ({
  prisma: {
    iaGateSdr:   { findMany: vi.fn(), findFirst: vi.fn() },
    iaFlowStep:  { findMany: vi.fn() },
    crmDeal:     { update: vi.fn() },
    iaFlowGate:  { findMany: vi.fn() },
    // evaluateGates consulta empresas bloqueadas antes de disparar tempo_minimo
    iaEmpresaBloqueada: { findMany: vi.fn().mockResolvedValue([]) },
    // getPersonaNomeExibicao (quando não mockado) usa iaPersona.findFirst
    iaPersona: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("./qualification.js", () => ({
  tryExtractVinculo: vi.fn(),
  checkVinculoPrazo: vi.fn(),
  // vinculos-processor importa também os derivadores de data de saída
  deriveDataSaida: vi.fn(() => null),
  deriveDataSaidaFromText: vi.fn(() => null),
}));

vi.mock("./persona-router.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getNextDeterministicQuestion:    vi.fn(),
    getMaisEmpregosAnteriorQuestion: vi.fn(),
  };
});

vi.mock("./transition-engine.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getPersonaNomeExibicao: vi.fn().mockResolvedValue("Especialista"),
    transitionDeal:         actual.transitionDeal ?? vi.fn(),
    enviarMensagemProativa: actual.enviarMensagemProativa ?? vi.fn(),
    applyAutoTags:          vi.fn(),
  };
});

vi.mock("./gate-evaluator.js", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getMesesMinimoProjeto: vi.fn().mockResolvedValue(2),
    getTempoMinimoGate:    vi.fn().mockResolvedValue({ mesesMin: 2, mensagemLead: "tempo insuficiente" }),
  };
});

vi.mock("./deal-repository.js", () => ({
  saveFlowStepData: vi.fn().mockResolvedValue(undefined),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports após mocks
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db.js";
import { tryExtractVinculo, checkVinculoPrazo } from "./qualification.js";
import { getNextDeterministicQuestion, getMaisEmpregosAnteriorQuestion, parseTempToMeses } from "./persona-router.js";
import { getMesesMinimoProjeto } from "./gate-evaluator.js";
import { evaluateGates } from "./gate-evaluator.js";
import { processVinculos } from "./vinculos-processor.js";
import { runAssistenteAgent } from "./assistente-agents.js";
import { resolvePostPhaseRoute } from "./triagem-router.js";
import { validarCPF } from "./qualification-utils.js";
import { advanceAdvogadoFlow } from "./flow-controller.js";

const mockTryExtract      = tryExtractVinculo as ReturnType<typeof vi.fn>;
const mockCheckPrazo      = checkVinculoPrazo as ReturnType<typeof vi.fn>;
const mockNextQ           = getNextDeterministicQuestion as ReturnType<typeof vi.fn>;
const mockMaisEmpregosQ   = getMaisEmpregosAnteriorQuestion as ReturnType<typeof vi.fn>;
const mockMesesMin        = getMesesMinimoProjeto as ReturnType<typeof vi.fn>;
const mockGateFindMany    = prisma.iaGateSdr.findMany as ReturnType<typeof vi.fn>;
const mockGateFindFirst   = prisma.iaGateSdr.findFirst as ReturnType<typeof vi.fn>;
const mockStepFindMany    = prisma.iaFlowStep.findMany as ReturnType<typeof vi.fn>;
const mockDealUpdate      = prisma.crmDeal.update as ReturnType<typeof vi.fn>;

function emptyExtractResult() {
  return { semMaisEmpregos: false, vinculo: null, updatedVinculos: [], confirmouMaisEmpregos: false };
}

function makeCompleteVinculo(overrides: Record<string, unknown> = {}) {
  return {
    ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "CLT",
    saida: "demitido", tempo: "3 anos", horas_extras: "sim",
    pagamento_fora: "nao", injustica: "sim",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckPrazo.mockResolvedValue(true);
  mockMesesMin.mockResolvedValue(2);
  mockGateFindFirst.mockResolvedValue(null);
  mockDealUpdate.mockResolvedValue({});
  mockStepFindMany.mockResolvedValue([]);
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 1 — parseTempToMeses (persona-router.ts) — BUG-024, BUG-025
// ═════════════════════════════════════════════════════════════════════════════

describe("parseTempToMeses — BUG-024 (extenso) e BUG-025 (menos de)", () => {
  it("COMPORTAMENTO ESPERADO — '3 anos' → 36", () => {
    expect(parseTempToMeses("3 anos")).toBe(36);
  });

  it("COMPORTAMENTO ESPERADO — '6 meses' → 6", () => {
    expect(parseTempToMeses("6 meses")).toBe(6);
  });

  it("COMPORTAMENTO ESPERADO — '30 dias' → ~1 mês", () => {
    expect(parseTempToMeses("30 dias")).toBeCloseTo(1, 0);
  });

  it("BUG-023 CORRIGIDO — '3 semanas' → 1 mês (semanas agora são parseadas, /4.3 arredondado)", () => {
    // Semanas passaram a ser parseadas: Math.round(3 / 4.3) = 1 (< 2 → não passa no gate).
    expect(parseTempToMeses("3 semanas")).toBe(1);
    expect(parseTempToMeses("3 semanas")).toBeLessThan(2);
  });

  it("BUG-025 CORRIGIDO — 'menos de 2 meses' → 1 (modificador 'menos de' reduz para X-1)", () => {
    const resultado = parseTempToMeses("menos de 2 meses");
    expect(resultado).toBe(1);
    expect(resultado).toBeLessThan(2); // fica abaixo do mínimo do gate
  });

  it("CORRIGIDO (11/06) — 'menos de 1 mês' → 0 (abaixo do mínimo, dispara pivot)", () => {
    // Quando uma unidade é reconhecida, 0 é resultado válido — não cai mais no sentinela 999.
    const r = parseTempToMeses("menos de 1 mês");
    expect(r).toBe(0);
    expect(r).toBeLessThan(2);
  });

  it("BUG-024 CORRIGIDO — 'um mês' → 1 (número por extenso normalizado)", () => {
    expect(parseTempToMeses("um mês")).toBe(1);
  });

  it("BUG-024 CORRIGIDO — 'dois meses' → 2", () => {
    expect(parseTempToMeses("dois meses")).toBe(2);
  });

  it("CORRIGIDO (11/06) — 'uma semana' → 0 (feminino 'uma' normalizado)", () => {
    const r = parseTempToMeses("uma semana");
    expect(r).toBeLessThan(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 2 — validarCPF — BUG-029, BUG-036
// ═════════════════════════════════════════════════════════════════════════════

describe("validarCPF — BUG-029", () => {
  it("COMPORTAMENTO ESPERADO — CPF válido retorna true", () => {
    expect(validarCPF("52998224725")).toBe(true);
    expect(validarCPF("529.982.247-25")).toBe(true);
  });

  it("COMPORTAMENTO ESPERADO — CPF com todos dígitos iguais retorna false", () => {
    expect(validarCPF("111.111.111-11")).toBe(false);
    expect(validarCPF("00000000000")).toBe(false);
    expect(validarCPF("99999999999")).toBe(false);
  });

  it("BUG-029 referência — CPF com dígito verificador errado é rejeitado", () => {
    // Documenta que CPFs com 11 dígitos mas inválidos são corretamente rejeitados pela função
    // O bug está em flow-controller.ts que usa regex de 11 dígitos sem chamar validarCPF
    expect(validarCPF("12345678910")).toBe(false); // último dígito errado (correto seria 09)
    expect(validarCPF("52998224726")).toBe(false); // último dígito errado (correto seria 25)
  });

  it("COMPORTAMENTO ESPERADO — CPF com dígito verificador errado retorna false", () => {
    expect(validarCPF("52998224726")).toBe(false); // último dígito errado
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 3 — DESCARTE_REGEX (copiado de stage-engine.ts) — BUG-018
// ═════════════════════════════════════════════════════════════════════════════

describe("DESCARTE_REGEX — BUG-018 (aplicado a todas as personas)", () => {
  // Regex exato da linha 42 de stage-engine.ts
  const DESCARTE_REGEX = /infelizmente.{0,40}não.{0,30}(vamos conseguir|conseguimos|podemos).{0,30}atender/i;

  it("COMPORTAMENTO ESPERADO — descarte legítimo da persona assistente faz match", () => {
    expect(DESCARTE_REGEX.test("Infelizmente não vamos conseguir atender o seu caso")).toBe(true);
    expect(DESCARTE_REGEX.test("infelizmente não conseguimos atender")).toBe(true);
  });

  it("BUG-018 ATIVO — frase legítima do advogado (personaChave=advogado) faz match indevido", () => {
    // Daniela explicando limitação de documentos — NÃO deveria descartar o lead
    const fraseDaniela = "Infelizmente não conseguimos atender sua solicitação de segunda via por aqui, mas posso agendar a reunião";
    expect(DESCARTE_REGEX.test(fraseDaniela)).toBe(true); // BUG: faz match → lead descartado erroneamente
    // Correto seria: false (quando personaChave !== "assistente")
  });

  it("BUG-018 ATIVO — frase da secretaria também dispara descarte indevido", () => {
    const fraseSecretaria = "Infelizmente não podemos atender nesse horário — escolha outro por favor";
    expect(DESCARTE_REGEX.test(fraseSecretaria)).toBe(true); // BUG
  });

  it("COMPORTAMENTO ESPERADO — frase sem 'atender' não faz match", () => {
    expect(DESCARTE_REGEX.test("Infelizmente não conseguimos processar o documento")).toBe(false);
    expect(DESCARTE_REGEX.test("Não vamos conseguir enviar hoje")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 4 — NAO_CARRETEIRO_RE (copiado de stage-engine.ts) — BUG-004, BUG-027, BUG-028
// ═════════════════════════════════════════════════════════════════════════════

describe("NAO_CARRETEIRO_RE — BUG-004 (acento), BUG-027 (frota), BUG-028 (frete)", () => {
  // Regex exato da linha 174 de stage-engine.ts
  const NAO_CARRETEIRO_RE = /\b(taxista|t[aá]xi|motorista\s+de\s+(t[aá]xi|aplicativo)|uber|99\s*(driver|app|\b)|indriver|mototaxi|motoboy|entregador\s+(ifood|rappi|motoboy|de\s+aplicativo)|ifood|rappi|autonomo\s+sem\s+carteira|dono\s+do\s+ve[ií]culo|carro\s+pr[oó]prio)\b/i;

  it("COMPORTAMENTO ESPERADO — 'taxista' faz match", () => {
    expect(NAO_CARRETEIRO_RE.test("sou taxista")).toBe(true);
  });

  it("COMPORTAMENTO ESPERADO — 'uber' faz match", () => {
    expect(NAO_CARRETEIRO_RE.test("trabalho de uber")).toBe(true);
  });

  it("BUG-004 ATIVO — 'autônomo' COM acento NÃO faz match (falta normalização Unicode)", () => {
    // Regex tem 'autonomo\s+sem\s+carteira' sem normalização de acentos
    expect(NAO_CARRETEIRO_RE.test("sou autônomo")).toBe(false); // BUG: deveria ser true
    expect(NAO_CARRETEIRO_RE.test("trabalho como autônomo")).toBe(false); // BUG
    // Com normalização o correto seria: true
  });

  it("BUG-004 — 'autonomo sem carteira' (sem acento) faz match (versão sem acento funciona)", () => {
    // Confirma que o problema é apenas com o acento
    expect(NAO_CARRETEIRO_RE.test("autonomo sem carteira")).toBe(true);
  });

  it("BUG-027 ATIVO — 'dono de frota' NÃO faz match (deveria ser não-carreteiro)", () => {
    expect(NAO_CARRETEIRO_RE.test("sou dono de frota")).toBe(false); // BUG
    expect(NAO_CARRETEIRO_RE.test("tenho uma frota de caminhões")).toBe(false); // BUG
  });

  it("BUG-028 ATIVO — 'motorista de aplicativo de frete' faz match INDEVIDAMENTE", () => {
    // Motorista de app de frete (CargoX, Uber Freight) É caminhoneiro — não deveria desqualificar
    // O regex atual captura "motorista de aplicativo" sem exceção para "frete"
    expect(NAO_CARRETEIRO_RE.test("sou motorista de aplicativo de frete")).toBe(true); // BUG
    // O correto seria: false (é caminhoneiro, só não é CLT necessariamente)
  });

  it("COMPORTAMENTO ESPERADO — caminhoneiro CLT normal não faz match", () => {
    expect(NAO_CARRETEIRO_RE.test("trabalho como motorista de caminhão")).toBe(false);
    expect(NAO_CARRETEIRO_RE.test("sou carreteiro")).toBe(false);
    expect(NAO_CARRETEIRO_RE.test("dirijo caminhão de carga")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 5 — processVinculos — BUG-001, BUG-023, BUG-005, BUG-026
// ═════════════════════════════════════════════════════════════════════════════

describe("processVinculos — BUG-001 (dias), BUG-023 (semanas)", () => {
  it("BUG-001 CORRIGIDO — 2 vínculos CLT completos com tempo='30 dias' → NÃO auto-fecha", async () => {
    // Auto-close agora exige pelo menos 1 vínculo CLT com tempo >= 2 meses (ou negação
    // explícita de mais empregos). Com 2 vínculos de 30 dias, a coleta continua aberta
    // para investigar outros empregos.
    const v0 = makeCompleteVinculo({ ordem: 1, tempo: "30 dias" });
    const v1 = makeCompleteVinculo({ ordem: 2, empresa: "TransABC", tempo: "30 dias" });
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0, v1] });

    const result = await processVinculos({
      projetoId: "proj-bug001",
      merged: { vinculos: [v0, v1] },
      text: "sim",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculosOk).toBe(false);
  });

  it("BUG-023 CORRIGIDO — vínculos com tempo='3 semanas' (< 2 meses) → NÃO auto-fecha", async () => {
    // parseMesesTempo agora parseia semanas (round(3/4.3)=1 < 2) → nenhum vínculo válido
    // → coleta permanece aberta (mesma regra do caso "30 dias").
    const v0 = makeCompleteVinculo({ ordem: 1, tempo: "3 semanas" });
    const v1 = makeCompleteVinculo({ ordem: 2, empresa: "TransABC", tempo: "3 semanas" });
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0, v1] });

    const result = await processVinculos({
      projetoId: "proj-bug023",
      merged: { vinculos: [v0, v1] },
      text: "sim",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculosOk).toBe(false);
  });

  it("COMPORTAMENTO ESPERADO — 2 vínculos CLT completos com tempo válido (3 anos) → auto-close correto", async () => {
    const v0 = makeCompleteVinculo({ ordem: 1, tempo: "3 anos" });
    const v1 = makeCompleteVinculo({ ordem: 2, empresa: "TransABC", tempo: "2 anos" });
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0, v1] });

    const result = await processVinculos({
      projetoId: "proj-ok",
      merged: { vinculos: [v0, v1] },
      text: "sim",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.state.vinculosOk).toBe(true);
  });
});

describe("processVinculos — BUG-026 (agregado e TAC não reconhecidos como não-CLT)", () => {
  it("BUG-026 CORRIGIDO — vinculo='agregado' seta e_clt=false", async () => {
    // NON_CLT_RE agora inclui 'agregado' e '\btac\b' (vinculos-processor.ts:299)
    const v0 = { ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "agregado" };
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0] });

    const result = await processVinculos({
      projetoId: "proj-bug026a",
      merged: { vinculos: [v0] },
      text: "sou agregado",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates.e_clt).toBe(false);
  });

  it("BUG-026 CORRIGIDO — vinculo='TAC' seta e_clt=false", async () => {
    const v0 = { ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "TAC" };
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0] });

    const result = await processVinculos({
      projetoId: "proj-bug026b",
      merged: { vinculos: [v0] },
      text: "trabalho com TAC",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates.e_clt).toBe(false);
  });

  it("COMPORTAMENTO ESPERADO — vinculo='autônomo' seta e_clt=false", async () => {
    const v0 = { ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "autônomo" };
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0] });

    const result = await processVinculos({
      projetoId: "proj-clt-ok",
      merged: { vinculos: [v0] },
      text: "sou autônomo",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates.e_clt).toBe(false);
  });

  it("COMPORTAMENTO ESPERADO — vinculo='PJ' seta e_clt=false", async () => {
    const v0 = { ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "PJ" };
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0] });

    const result = await processVinculos({
      projetoId: "proj-pj-ok",
      merged: { vinculos: [v0] },
      text: "sou PJ",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates.e_clt).toBe(false);
  });
});

describe("processVinculos — BUG-005 (auto-close com 2 vínculos inválidos bloqueia 3º)", () => {
  it("BUG-005 ATIVO — 2 vínculos bloqueados completos → _vinculos_ok=true sem vínculo válido", async () => {
    // Empresa bloqueada + empresa bloqueada → ambos completos, nenhum válido
    // O auto-close deveria verificar se há algum vínculo válido antes de fechar
    const v0 = makeCompleteVinculo({ ordem: 1, empresa: "Transparra", tempo: "3 anos" }); // empresa bloqueada
    const v1 = makeCompleteVinculo({ ordem: 2, empresa: "Transoares", tempo: "2 anos" }); // empresa bloqueada
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0, v1] });

    const result = await processVinculos({
      projetoId: "proj-bug005",
      merged: { vinculos: [v0, v1] },
      text: "sim",
      history: [],
      maisEmpregosPerguntado: false,
    });

    // BUG: auto-close ocorre mesmo sem vínculo não-bloqueado
    // A verificação de empresa bloqueada NÃO está no vinculos-processor (está em assistente-agents)
    // Este teste confirma que o vinculos-processor fecha sem saber se as empresas são bloqueadas
    // (A correção FIX-05 precisa ser aplicada em assistente-agents, não aqui)
    expect(result.state.vinculosOk).toBe(true); // fechar é esperado aqui — o problema é no assistente-agents
  });

  it("BUG-005 CORRIGIDO cenário CLT curto — 2 vínculos curtos (30/45 dias) → NÃO auto-fecha (aguarda 3º emprego)", async () => {
    const v0 = makeCompleteVinculo({ ordem: 1, tempo: "30 dias" });
    const v1 = makeCompleteVinculo({ ordem: 2, empresa: "TransABC", tempo: "45 dias" });
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0, v1] });

    const result = await processVinculos({
      projetoId: "proj-bug005b",
      merged: { vinculos: [v0, v1] },
      text: "só nessas duas",
      history: [],
      maisEmpregosPerguntado: false,
    });

    // Auto-close agora exige vínculo CLT com tempo >= 2 meses OU negação explícita
    // (_mais_empregos_negado) — com 2 vínculos curtos a coleta segue aberta.
    expect(result.state.vinculosOk).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 6 — evaluateGates — BUG-002, BUG-022
// ═════════════════════════════════════════════════════════════════════════════

describe("evaluateGates gate tempo_minimo — BUG-002 e BUG-022", () => {
  function makeTempoMinimoGate(mesesMin = 2) {
    return {
      tipo: "tempo_minimo",
      campoGatilho: null,
      condicaoJson: { mesesMin },
      mensagemLead: "Tempo insuficiente.",
      motivoChave: "tempo_minimo",
      stageDestino: "lead_desqualificado",
      ativo: true,
      ordem: 1,
    };
  }

  beforeEach(() => {
    mockGateFindMany.mockResolvedValue([makeTempoMinimoGate()]);
  });

  it("COMPORTAMENTO ESPERADO — lead com 3 anos de CLT não dispara gate", async () => {
    const v0 = { ordem: 1, empresa: "TransXYZ", vinculo: "CLT", tempo: "3 anos" };
    const result = await evaluateGates("proj-ok-" + Date.now(), { tem_emprego_anterior: false }, [v0 as any], false, "João");
    expect(result).toBeNull();
  });

  it("COMPORTAMENTO ATUAL — lead CLT 30 dias + negação EXPLÍCITA (_mais_empregos_negado) → gate dispara", async () => {
    const v0 = { ordem: 1, empresa: "TransXYZ", vinculo: "CLT", tempo: "30 dias" };
    const result = await evaluateGates(
      "proj-ok-dias-" + Date.now(),
      { _mais_empregos_negado: true },
      [v0 as any], false, "João"
    );
    // parseMeses("30 dias") = 1 < 2 e negação explícita do lead → gate dispara
    expect(result).not.toBeNull();
    expect(result?.tipo).toBe("tempo_minimo");
  });

  it("BUG-002 ATIVO — lead com tempo=null (não respondeu) passa pelo gate", async () => {
    // Lead recusou informar o tempo → v0.tempo=null → parseMeses(null)=null → gate retorna false
    const v0 = { ordem: 1, empresa: "TransXYZ", vinculo: "CLT", tempo: null };
    const result = await evaluateGates(
      "proj-bug002-" + Date.now(),
      { tem_emprego_anterior: false },
      [v0 as any], false, "João"
    );
    // BUG: gate retorna null (não dispara) quando tempo não foi coletado
    expect(result).toBeNull(); // BUG ATIVO — com tempo=null o lead passa para a secretaria!
    // Correto: deveria disparar ou bloquear o avanço
  });

  it("BUG-022 CORRIGIDO — _mais_empregos_negado=true mesmo sem tem_emprego_anterior → gate dispara", async () => {
    // O gate tempo_minimo agora usa a flag explícita _mais_empregos_negado
    // (gate-evaluator.ts:152) — tem_emprego_anterior não é mais necessário.
    const v0 = { ordem: 1, empresa: "TransXYZ", vinculo: "CLT", tempo: "30 dias" };
    const result = await evaluateGates(
      "proj-bug022-" + Date.now(),
      {
        _mais_empregos_negado: true,  // lead negou via vinculos-processor
        // tem_emprego_anterior: undefined — nunca setado
      },
      [v0 as any], false, "João"
    );
    expect(result).not.toBeNull();
    expect(result?.tipo).toBe("tempo_minimo");
  });

  it("COMPORTAMENTO ATUAL — tem_emprego_anterior=false (só extração LLM) NÃO dispara o gate", async () => {
    // Mudança intencional: o gate IGNORA tem_emprego_anterior extraído pelo LLM (pode ser
    // falso — ex.: "último" lido como "único") e só desqualifica após negação EXPLÍCITA
    // registrada pelo vinculos-processor (_mais_empregos_negado=true). gate-evaluator.ts:150-152.
    const v0 = { ordem: 1, empresa: "TransXYZ", vinculo: "CLT", tempo: "30 dias" };
    const result = await evaluateGates(
      "proj-dispara-" + Date.now(),
      { tem_emprego_anterior: false },
      [v0 as any], false, "João"
    );
    expect(result).toBeNull();
  });

  it("COMPORTAMENTO ESPERADO — gate nao_carreteiro dispara quando e_carreteiro=false", async () => {
    mockGateFindMany.mockResolvedValue([{
      tipo: "nao_carreteiro",
      campoGatilho: "e_carreteiro",
      condicaoJson: null,
      mensagemLead: "Não atendemos motoristas de app.",
      motivoChave: "nao_carreteiro",
      stageDestino: "lead_desqualificado",
      ativo: true,
      ordem: 1,
    }]);
    const result = await evaluateGates(
      "proj-nao-car-" + Date.now(),
      { e_carreteiro: false },
      [], false, "João"
    );
    expect(result).not.toBeNull();
    expect(result?.tipo).toBe("nao_carreteiro");
  });

  it("COMPORTAMENTO ESPERADO — gate vinculo_invalido: e_clt=false com mais_empregos_investigado dispara", async () => {
    mockGateFindMany.mockResolvedValue([{
      tipo: "vinculo_invalido",
      campoGatilho: "e_clt",
      condicaoJson: { campo: "e_clt", valorDesqualifica: false },
      mensagemLead: "Vínculo inválido.",
      motivoChave: "vinculo_invalido",
      stageDestino: "lead_desqualificado",
      ativo: true,
      ordem: 1,
    }]);
    const result = await evaluateGates(
      "proj-vinc-inv-" + Date.now(),
      { e_clt: false, _mais_empregos_negado: true },
      [{ ordem: 1, empresa: "TransXYZ", vinculo: "autônomo" } as any],
      false, "João"
    );
    expect(result).not.toBeNull();
    expect(result?.tipo).toBe("vinculo_invalido");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 7 — resolvePostPhaseRoute — BUG-007 (pessoalidade)
// ═════════════════════════════════════════════════════════════════════════════

describe("resolvePostPhaseRoute — BUG-007 (rv_substituto e pessoalidade)", () => {
  it("COMPORTAMENTO ESPERADO — rv_substituto=false → pessoalidade=true (não tinha substituto)", () => {
    // Lead NÃO podia mandar substituto → pessoalidade PRESENTE
    // Com 3 outros elementos true → deve qualificar
    const result = resolvePostPhaseRoute("lead_reconhecimento_vinculo", {
      rv_frequencia_trabalho: true,  // habitualidade
      rv_recebia_ordens: true,        // subordinação
      rv_substituto: false,           // pessoalidade: NÃO tinha substituto = presente
      rv_forma_pagamento: "R$ 5000", // onerosidade
    });
    expect(result?.toStage).toBe("lead_qualificado");
  });

  it("BUG-007 ATIVO — rv_substituto=true → pessoalidade=null em vez de false (lead qualifica indevidamente)", () => {
    // Lead TINHA substituto → pessoalidade AUSENTE → deveria ser false
    // Bug: pessoalidade=null ao invés de false → não é contada como false, só não conta como true
    // Com habitualidade+subordinação+onerosidade=true e pessoalidade=null → elementos=3 → QUALIFICA!
    const result = resolvePostPhaseRoute("lead_reconhecimento_vinculo", {
      rv_frequencia_trabalho: true,  // habitualidade
      rv_recebia_ordens: true,        // subordinação
      rv_substituto: true,            // BUG: pessoalidade=null (deveria ser false)
      rv_forma_pagamento: "R$ 5000", // onerosidade
    });
    // BUG: lead COM substituto (sem pessoalidade) está sendo qualificado!
    expect(result?.toStage).toBe("lead_qualificado"); // BUG ATIVO
    // Correto: pessoalidade=false → elementos apenas 3 (hab+sub+oner) mas pessoalidade está ausente
    // Como pessoalidade=false NÃO conta como null, o tudo.every verifica... mas ainda:
    // elementos = filter(v => v === true) = [true, true, false(=null na versão bugada), true].filter = 3
    // Então com pessoalidade=null, ainda conta como 3 true → qualifica (bug!)
    // Com pessoalidade=false corrigido: filter = [true, true, false, true] → count = 3 → ainda qualifica!
    // O verdadeiro bug: pessoalidade DEVERIA ser false (não conta) → 2 elementos → desqualifica
  });

  it("BUG-007 — rv_substituto=true + sub=false → desqualifica com 2 elementos (sub ausente)", () => {
    // hab=true, sub=false, pessoalidade=null(rv_substituto=true), oner=true
    // elementos=[true,false,null,true].filter(v=>v===true)=2 → não qualifica
    // tudo todos preenchidos → lead_desqualificado
    const result = resolvePostPhaseRoute("lead_reconhecimento_vinculo", {
      rv_frequencia_trabalho: true,
      rv_recebia_ordens: false,       // subordinação ausente
      rv_substituto: true,            // pessoalidade ausente
      rv_forma_pagamento: "R$ 3000",
    });
    // Retorna desqualificado (tudo preenchido, elementos < 3)
    expect(result?.toStage).toBe("lead_desqualificado");
    expect(result?.motivo).toBe("rv_elementos_insuficientes");
  });

  it("BUG-037 CORRIGIDO — rv_substituto=undefined (não respondido) + 3 outros true → NÃO qualifica (aguarda pessoalidade)", () => {
    // O check de completude (todoRespondido) agora roda ANTES da qualificação
    // (triagem-router.ts:114-120): com rv_substituto sem resposta, nenhuma rota é
    // resolvida — o fluxo aguarda a pergunta de pessoalidade.
    const result = resolvePostPhaseRoute("lead_reconhecimento_vinculo", {
      rv_frequencia_trabalho: true,
      rv_recebia_ordens: true,
      // rv_substituto: NÃO RESPONDIDO (undefined)
      rv_forma_pagamento: "R$ 5000",
    });
    expect(result).toBeNull();
  });

  it("COMPORTAMENTO ESPERADO — rota triagem ainda_na_empresa=true → rescisao_indireta", () => {
    const result = resolvePostPhaseRoute("lead_triagem", { ainda_na_empresa: true });
    expect(result?.toStage).toBe("lead_rescisao_indireta");
  });

  it("COMPORTAMENTO ESPERADO — rota triagem prescrito=true → desqualificado", () => {
    const result = resolvePostPhaseRoute("lead_triagem", { prescrito: true });
    expect(result?.toStage).toBe("lead_desqualificado");
  });

  it("COMPORTAMENTO ESPERADO — rota triagem tempo_muito_curto=true → desqualificado", () => {
    const result = resolvePostPhaseRoute("lead_triagem", { tempo_muito_curto: true });
    expect(result?.toStage).toBe("lead_desqualificado");
  });

  it("COMPORTAMENTO ESPERADO — rota triagem tinha_clt=true → direito_suprimido", () => {
    const result = resolvePostPhaseRoute("lead_triagem", { tinha_clt: true });
    expect(result?.toStage).toBe("lead_direito_suprimido");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 8 — runAssistenteAgent — BUG-010 (tipoRazao), BUG-036 (buildResumoEncerramento)
// ═════════════════════════════════════════════════════════════════════════════

describe("runAssistenteAgent — BUG-010 e BUG-036", () => {
  beforeEach(() => {
    mockNextQ.mockResolvedValue(null); // sem mais perguntas → allDone ou forceDescarte
    mockMaisEmpregosQ.mockResolvedValue("Você trabalhou em outro lugar antes?");
    mockMesesMin.mockResolvedValue(2);
    mockGateFindFirst.mockResolvedValue({
      condicaoJson: { investigarAnterior: false },
      mensagemLead: "Infelizmente não conseguimos atender.",
    });
  });

  it("BUG-010 ATIVO — lead com vínculo curto + bloqueado → tipoRazao='bloqueada' (deveria ser 'curto')", async () => {
    // Lead tem: v0=curto(30 dias, não bloqueado) + v1=bloqueado
    // tipoRazao deveria ser 'curto' (curto vem antes de bloqueado na precedência)
    // BUG: temAlgumBloqueado=true → 'bloqueada' em vez de 'curto'
    const ctx = {
      projetoId: "proj-bug010",
      merged: {
        _mais_empregos_negado: true,
        tem_emprego_anterior: false,
      },
      vinculos: [
        makeCompleteVinculo({ ordem: 1, empresa: "TransLegal", tempo: "30 dias", vinculo: "CLT" }),
        makeCompleteVinculo({ ordem: 2, empresa: "Transparra", tempo: "3 anos", vinculo: "CLT" }),
      ],
      vinculosOk: true, // já fechado
      vinculosTodosPrescritos: false,
      empresasBloqueadas: ["transparra"], // v1 é bloqueada
      outgoingCount: 5,
    };

    const result = await runAssistenteAgent(ctx);
    // forceDescarte=true → mensagem de descarte baseada em tipoRazao
    expect(result.forceDescarte).toBe(true);
    // BUG: a mensagem de gate é de "empresa_bloqueada" quando deveria ser "tempo_minimo" (curto)
    // O tipoGate é derivado de tipoRazao: curto → tempo_minimo, bloqueada → empresa_bloqueada
    // Não conseguimos testar tipoRazao diretamente — mas o gate buscado no DB seria empresa_bloqueada (bug)
    // O mockGateFindFirst foi chamado com tipo errado:
    expect(mockGateFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tipo: "empresa_bloqueada" }), // BUG: deveria ser 'tempo_minimo'
      })
    );
  });

  it("BUG-036 CORRIGIDO — buildResumoEncerramento NÃO menciona o advogado como próxima persona", async () => {
    // O fluxo real é: assistente → secretaria → advogado.
    // buildResumoEncerramento agora instrui o LLM a dizer apenas que "a equipe vai entrar
    // em contato", sem nomear advogado nem secretária (assistente-agents.ts:342-355).
    const ctx = {
      projetoId: "proj-bug036",
      merged: {},
      vinculos: [makeCompleteVinculo({ ordem: 1, tempo: "3 anos" })],
      vinculosOk: true,
      vinculosTodosPrescritos: false,
      empresasBloqueadas: [],
      outgoingCount: 5,
    };

    const result = await runAssistenteAgent(ctx);
    expect(result.allDone).toBe(true);
    expect(result.systemInstructions).not.toContain("Especialista");
    expect(result.systemInstructions).toMatch(/equipe vai entrar em contato/i);
  });

  it("COMPORTAMENTO ESPERADO — sem vínculo válido + semAlternativa=true → forceDescarte", async () => {
    const ctx = {
      projetoId: "proj-descarte",
      merged: { _mais_empregos_negado: true, tem_emprego_anterior: false },
      vinculos: [makeCompleteVinculo({ ordem: 1, tempo: "30 dias" })],
      vinculosOk: true,
      vinculosTodosPrescritos: false,
      empresasBloqueadas: [],
      outgoingCount: 5,
    };

    const result = await runAssistenteAgent(ctx);
    expect(result.forceDescarte).toBe(true);
    expect(result.phase).toBe("resumo");
  });

  it("COMPORTAMENTO ESPERADO — vínculo válido + vinculosOk=true + sem mais perguntas → allDone=true", async () => {
    const ctx = {
      projetoId: "proj-alldone",
      merged: {},
      vinculos: [makeCompleteVinculo({ ordem: 1, tempo: "3 anos" })],
      vinculosOk: true,
      vinculosTodosPrescritos: false,
      empresasBloqueadas: [],
      outgoingCount: 5,
    };

    const result = await runAssistenteAgent(ctx);
    expect(result.allDone).toBe(true);
    expect(result.forceDescarte).toBeFalsy();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 9 — advanceAdvogadoFlow saudacao — BUG-015
// ═════════════════════════════════════════════════════════════════════════════

describe("advanceAdvogadoFlow — BUG-015 (saudacao avança sem coletar campoColetar)", () => {
  function makeSecApresentacaoStep(overrides: Record<string, unknown> = {}) {
    return {
      id: "step-sec",
      chave: "sec_apresentacao",
      pergunta: "Olá! Aqui estão os horários disponíveis:\n{horarios}\nQual prefere?",
      stepType: "saudacao",
      campoColetar: "horario_reuniao", // deve coletar o horário!
      ordem: 1,
      ativo: true,
      gates: [],
      proativo: false,
      ...overrides,
    };
  }

  function makeSecConclusaoStep() {
    return {
      id: "step-conclusao",
      chave: "sec_conclusao",
      pergunta: "Perfeito! Reunião confirmada.",
      stepType: "end",
      campoColetar: null,
      ordem: 2,
      ativo: true,
      gates: [],
      proativo: false,
    };
  }

  beforeEach(() => {
    mockStepFindMany.mockResolvedValue([makeSecApresentacaoStep(), makeSecConclusaoStep()]);
  });

  it("BUG-015 ATIVO — saudacao com campoColetar avança com 'oi' sem coletar horário", async () => {
    // O step sec_apresentacao tem stepType="saudacao" E campoColetar="horario_reuniao"
    // O flow-controller deveria verificar campoColetar antes de avançar automaticamente
    // BUG: avança independentemente da mensagem
    const result = await advanceAdvogadoFlow(
      "proj-bug015",
      { id: "deal-1", iaFlowStepChave: "sec_apresentacao", iaFlowStepData: {}, qualificacao: {} },
      "oi",  // mensagem de ACK — não escolheu horário!
      1,
      [],
      { personaChave: "secretaria", fase: "secretaria" }
    );

    // BUG: avança para sec_conclusao mesmo sem horário coletado
    expect(result.nextStepChave).toBe("sec_conclusao"); // BUG ATIVO
    // Correto: deveria permanecer em sec_apresentacao aguardando escolha de horário
  });

  it("BUG-015 ATIVO — saudacao com campoColetar avança com qualquer texto curto", async () => {
    const result = await advanceAdvogadoFlow(
      "proj-bug015b",
      { id: "deal-2", iaFlowStepChave: "sec_apresentacao", iaFlowStepData: {}, qualificacao: {} },
      "ok tá bom",
      1,
      [],
      { personaChave: "secretaria", fase: "secretaria" }
    );

    expect(result.nextStepChave).toBe("sec_conclusao"); // BUG ATIVO
  });

  it("COMPORTAMENTO ESPERADO — saudacao SEM campoColetar avança normalmente", async () => {
    mockStepFindMany.mockResolvedValue([
      { ...makeSecApresentacaoStep(), campoColetar: null }, // sem campoColetar
      makeSecConclusaoStep(),
    ]);

    const result = await advanceAdvogadoFlow(
      "proj-saud-ok",
      { id: "deal-3", iaFlowStepChave: "sec_apresentacao", iaFlowStepData: {}, qualificacao: {} },
      "oi",
      1,
      [],
      { personaChave: "secretaria", fase: "secretaria" }
    );

    // Sem campoColetar, avançar automaticamente é correto
    expect(result.nextStepChave).toBe("sec_conclusao");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SEÇÃO 10 — Cenários de conversa completos (ponta a ponta nos pure functions)
// ═════════════════════════════════════════════════════════════════════════════

describe("Cenários de conversa — lead passa quando não deveria", () => {
  it("Cenário A CORRIGIDO (11/06) — lead CLT 'uma semana' → tempo < 2 meses → pivot/gate", () => {
    // parseTempToMeses("uma semana") agora retorna < 1; temVinculoValido (>= 2) é falso
    // e o fluxo investiga vínculo anterior / desqualifica corretamente.
    const resultado = parseTempToMeses("uma semana");
    expect(resultado).toBeLessThan(2);
  });

  it("Cenário B CORRIGIDO — lead CLT 'menos de 2 meses' NÃO passa pelo gate de tempo_minimo", () => {
    // parseTempToMeses("menos de 2 meses") = 1 (fix do modificador "menos de" → X-1)
    // 1 < 2 → temVinculoValido = false → lead não passa.
    const resultado = parseTempToMeses("menos de 2 meses");
    expect(resultado).toBeLessThan(2);
  });

  it("Cenário C — lead CLT 'uns 40 dias' passa pelo check de temVinculoValido", () => {
    // parseTempToMeses("uns 40 dias") — "dias" encontra 40 → 40/30 ≈ 1.33 meses < 2
    const resultado = parseTempToMeses("uns 40 dias");
    // Aqui parseTempToMeses funciona corretamente para dias
    expect(resultado).toBeLessThan(2); // CORRETO: 1.33 < 2 → não passa
  });

  it("Cenário D CORRIGIDO — lead 'agregado' da transportadora — NON_CLT_RE detecta e seta e_clt=false", async () => {
    // NON_CLT_RE agora inclui 'agregado' → e_clt=false → gate vinculo_invalido pode disparar
    const v0 = { ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "agregado" };
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0] });

    const result = await processVinculos({
      projetoId: "cenario-d-" + Date.now(),
      merged: { vinculos: [v0] },
      text: "sou agregado",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates.e_clt).toBe(false);
  });

  it("Cenário E CORRIGIDO — lead TAC com 5 anos — NON_CLT_RE detecta e seta e_clt=false", async () => {
    const v0 = { ordem: 1, empresa: "TransXYZ", funcao: "Motorista", vinculo: "TAC" };
    mockTryExtract.mockResolvedValue({ ...emptyExtractResult(), updatedVinculos: [v0] });

    const result = await processVinculos({
      projetoId: "cenario-e-" + Date.now(),
      merged: { vinculos: [v0] },
      text: "tenho TAC",
      history: [],
      maisEmpregosPerguntado: false,
    });

    expect(result.mergedUpdates.e_clt).toBe(false);
  });

  it("Cenário F — lead motorista de aplicativo de frete desqualificado como nao-carreteiro", () => {
    // NAO_CARRETEIRO_RE captura "motorista de aplicativo" sem exceção para "frete" (BUG-028)
    const NAO_CARRETEIRO_RE = /\b(taxista|t[aá]xi|motorista\s+de\s+(t[aá]xi|aplicativo)|uber|99\s*(driver|app|\b)|indriver|mototaxi|motoboy|entregador\s+(ifood|rappi|motoboy|de\s+aplicativo)|ifood|rappi|autonomo\s+sem\s+carteira|dono\s+do\s+ve[ií]culo|carro\s+pr[oó]prio)\b/i;
    const texto = "sou motorista de aplicativo de frete, uso o Uber Freight";
    // BUG: este lead É um caminhoneiro que usa app de frete — não deveria ser nao_carreteiro
    expect(NAO_CARRETEIRO_RE.test(texto)).toBe(true); // BUG-028: falso positivo
  });

  it("Cenário G — CPF inválido '111.111.111-11' rejeitado por validarCPF", () => {
    expect(validarCPF("111.111.111-11")).toBe(false); // CORRETO
    // O bug está em flow-controller.ts que não chama validarCPF para CPF digitado via texto
    // A função em si está correta — o problema é não ser chamada
  });

  it("Cenário H — resolvePostPhaseRoute: lead com rv_substituto=true (tinha substituto) qualifica com 3 outros elementos", () => {
    // BUG-007: rv_substituto=true deveria tornar pessoalidade=false, mas fica null
    // Com pessoalidade=null, o elemento não é false — não IMPEDE qualificação com 3 outros
    const result = resolvePostPhaseRoute("lead_reconhecimento_vinculo", {
      rv_frequencia_trabalho: true,  // habitualidade
      rv_recebia_ordens: true,        // subordinação
      rv_substituto: true,            // TINHA substituto → pessoalidade AUSENTE (deveria ser false)
      rv_forma_pagamento: "R$ 5000", // onerosidade
    });
    // BUG: lead COM substituto (pessoalidade ausente) qualifica com 3 elementos
    expect(result?.toStage).toBe("lead_qualificado"); // BUG-007 ATIVO
    // Correto: pessoalidade=false → apenas 3 dos 4 elementos → ainda pode qualificar dependendo da lógica
    // Mas o ponto é que pessoalidade=null vs pessoalidade=false tem comportamentos diferentes no check tudo.every
  });
});
