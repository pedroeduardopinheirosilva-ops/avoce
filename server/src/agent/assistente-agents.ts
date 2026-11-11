/**
 * Assistente Agents — sub-agents focused for Ana's qualification flow.
 *
 * Each agent handles ONE phase with a narrow, focused system prompt.
 * Phase transitions are determined by code (state), not by the LLM.
 *
 * Flow:
 *   "inicial"           → greeting + nome + cidade
 *   "vinculos_recente"  → employment details for the most recent employer (vinculos[0])
 *   "vinculos_anterior" → employment details for previous employers (vinculos[1+])
 *   "resumo"            → hand off to Daniela
 */

import type { VinculoEmprego, AssistentePhase, AgentContext, AgentResult } from "./types.js";
import { getNextDeterministicQuestion, parseTempToMeses, getMaisEmpregosAnteriorQuestion } from "./persona-router.js";
import { getPersonaNomeExibicao } from "./transition-engine.js";
import { getMesesMinimoProjeto, getTempoMinimoGate, renderNomePlaceholder } from "./gate-evaluator.js";
import { prisma } from "../db.js";

// Re-export for backward compat — callers should migrate to types.ts
export type { AssistentePhase, AgentContext, AgentResult };

// ── Required fields per vínculo ────────────────────────────────────────────────

const CAMPOS_REQ: Array<keyof VinculoEmprego> = [
  "empresa", "funcao", "vinculo", "saida", "tempo",
  "horas_extras", "pagamento_fora", "injustica",
];

const NON_CLT_RE = /autônomo|autonomo|avulso|cooperado|agregado|\btac\b|transportador\s+autonomo/i;
const CLT_RE_AA  = /clt|carteira/i;

/**
 * Autonomia REAL (dono do próprio caminhão, cooperado, avulso, app).
 * "informal"/"sem registro"/PJ forçado NÃO entram — motorista subordinado sem carteira
 * qualifica (reconhecimento de vínculo). CLT/carteira tem prioridade em vínculo misto.
 */
export function isNaoCltSdr(vinculo: string | null | undefined): boolean {
  return vinculo != null && !CLT_RE_AA.test(String(vinculo)) && NON_CLT_RE.test(String(vinculo));
}

/**
 * Há pelo menos um vínculo aproveitável: empresa não bloqueada, tempo >= mínimo do projeto
 * e sem autonomia real. O segundo termo é belt-and-suspenders: o LLM extraiu CLT nos campos
 * flat mesmo com vinculos[].vinculo errado.
 */
export function temVinculoValidoSdr(
  vinculos: VinculoEmprego[],
  merged: Record<string, unknown>,
  mesesMin: number,
  isBlocked: (empresa: string | null | undefined) => boolean,
): boolean {
  const tempoOk = (v: VinculoEmprego) =>
    !isBlocked(v.empresa) && v.tempo != null && v.tempo !== "" &&
    parseTempToMeses(String(v.tempo)) >= mesesMin;
  if (vinculos.some(v => tempoOk(v) && !isNaoCltSdr(v.vinculo))) return true;
  const cltNosFlats =
    (!!merged.vinculo_recente && CLT_RE_AA.test(String(merged.vinculo_recente))) ||
    (!!merged.clt_anterior    && CLT_RE_AA.test(String(merged.clt_anterior)));
  return cltNosFlats && vinculos.some(tempoOk);
}

function isVinculoComplete(v: VinculoEmprego): boolean {
  return CAMPOS_REQ.every(k => {
    const val = v[k];
    return val !== undefined && val !== null && val !== "";
  });
}

// ── Phase detection (pure, based on state) ────────────────────────────────────

export function detectPhase(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
): AssistentePhase {
  if (vinculosOk) {
    return "resumo";
  }

  // Phase 3: collecting a previous employer
  if (merged._mais_empregos_confirmado === true) return "vinculos_anterior";
  if (vinculos.some(v => v.ordem > 1)) return "vinculos_anterior";

  // Phase 2: collecting the most recent employer (may be ongoing)
  if (vinculos.length > 0) return "vinculos_recente";

  // Phase 1: no vinculos started yet (greeting, nome, cidade)
  return "inicial";
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runAssistenteAgent(ctx: AgentContext): Promise<AgentResult> {
  const phase = detectPhase(ctx.merged, ctx.vinculos, ctx.vinculosOk);

  // Busca mesesMin antes de qualquer check para usá-lo em temVinculoValido.
  const [nextQ, advNome, mesesMin] = await Promise.all([
    getNextDeterministicQuestion(
      ctx.projetoId, ctx.merged, ctx.vinculos, ctx.vinculosOk,
      ctx.vinculosTodosPrescritos, ctx.empresasBloqueadas, ctx.outgoingCount,
    ),
    getPersonaNomeExibicao(ctx.projetoId, "advogado"),
    getMesesMinimoProjeto(ctx.projetoId),
  ]);

  // Helpers de bloqueio (usados em múltiplos checks abaixo)
  const normStr = (s: string | null | undefined) =>
    (s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const isBlocked = (empresa: string | null | undefined) =>
    !!empresa && ctx.empresasBloqueadas.some(b => normStr(empresa).includes(normStr(b)));

  // BUG-001 FIX: If e_clt=false detected but pivot hasn't been asked yet, skip CLT-specific
  // flow steps (e.g. saida_recente) and go straight to mais_empregos investigation.
  // This prevents "Como foi o desligamento?" being asked to autônomo/agregado workers.
  // Trigger when e_clt=false and we have at least employment-type context (vinculos seeded
  // OR vinculo_recente extracted from flat fields) — allows pivot even if empresa is unknown.
  const ecltFalse =
    ctx.merged.e_clt === false &&
    !ctx.vinculosOk &&
    ctx.merged._mais_empregos_negado !== true &&
    ctx.merged._mais_empregos_perguntado !== true &&
    (ctx.vinculos.length > 0 || ctx.merged.vinculo_recente != null);

  if (ecltFalse) {
    const ultimoVinNaoClt = ctx.vinculos.at(-1);
    const maisEmpregosQNaoClt = await getMaisEmpregosAnteriorQuestion(
      ctx.projetoId, ultimoVinNaoClt?.empresa ?? null,
    );
    if (maisEmpregosQNaoClt) {
      return {
        deterministicQuestion: maisEmpregosQNaoClt,
        systemInstructions: buildPhaseInstructions(phase, ctx.merged, ctx.vinculos, advNome, mesesMin),
        allDone: false,
        phase,
      };
    }
  }

  // All phases complete → signal transition to Daniela
  const vinculosEffectivelyDone = ctx.vinculosOk || ctx.merged._vinculos_ok === true;
  // BUG-002 FIX: If vinculos-processor explicitly closed collection (_vinculos_ok=true),
  // override nextQ to null so the allDone/descarte path is taken even if field questions remain.
  const effectiveNextQ = vinculosEffectivelyDone ? null : nextQ;
  // Fallback: if no more questions AND we have at least one vinculos with minimum data,
  // close even if the LLM didn't explicitly set _vinculos_ok (e.g. after mais_empregos skip).
  // Empresa bloqueada conta como "mínimo": o pivot pula a coleta de vinculo/saida
  // desses vínculos, então sem isBlocked aqui o descarte nunca seria alcançável (A10/E1).
  const temVinculoMinimo = ctx.vinculos.some(v => v.empresa && (v.vinculo || v.saida || isBlocked(v.empresa)));
  if (!effectiveNextQ && (vinculosEffectivelyDone || temVinculoMinimo)) {
    const todosVinculosBloqueados = ctx.vinculos.length > 0 && ctx.vinculos.every(v => isBlocked(v.empresa));
    // _mais_empregos_negado = flag explícita do vinculos-processor.
    // tem_emprego_anterior=false extraído pelo LLM SÓ vale se a pergunta sobre outros empregos
    // foi realmente feita (_mais_empregos_perguntado) — caso Nelson 11/06: a extração alucinou
    // tem_emprego_anterior=false de um relato em áudio e o lead foi descartado sem investigação.
    const semAlternativa = ctx.merged._mais_empregos_negado === true ||
      (ctx.merged._mais_empregos_perguntado === true && ctx.merged.tem_emprego_anterior === false);

    // Verifica se há pelo menos um vínculo válido:
    // não bloqueado + tempo suficiente + não é autonomia real.
    // Cobre: transparra 30 dias (curto) + transoares (bloqueada) → nenhum válido.
    // Cobre: Uber/iFood autônomo / dono do caminhão → não-CLT → nenhum válido.
    // RECONHECIMENTO DE VÍNCULO: "informal"/"sem registro"/"PJ forçado" (pejotização) QUALIFICAM
    // (motorista subordinado sem carteira) → NÃO entram no NON_CLT_RE.
    const isNaoClt = isNaoCltSdr;
    const temVinculoValido = temVinculoValidoSdr(ctx.vinculos, ctx.merged, mesesMin, isBlocked);

    if (todosVinculosBloqueados || (!temVinculoValido && ctx.vinculos.length > 0)) {
      // Detecta a razão de não haver vínculo válido para usar o gate correto.
      const ultimoVinculo = ctx.vinculos.at(-1);
      const temAlgumNaoClt = ctx.vinculos.some(v => isNaoClt(v.vinculo));
      const temAlgumCurto  = ctx.vinculos.some(v =>
        !isNaoClt(v.vinculo) && parseTempToMeses(String(v.tempo ?? "")) < mesesMin
      );
      const temAlgumBloqueado = ctx.vinculos.some(v => isBlocked(v.empresa));
      // Prioridade: bloqueada > nao_clt > curto (BUG-003: com mix curto+bloqueada,
      // a mensagem de descarte final deve ser a de empresa bloqueada, não a de tempo mínimo,
      // que é redigida como pivot e convida a "investigar outro vínculo").
      const tipoRazao: "bloqueada" | "nao_clt" | "curto" =
        todosVinculosBloqueados ? "bloqueada"
        : temAlgumBloqueado     ? "bloqueada"
        : temAlgumNaoClt        ? "nao_clt"
        : "curto";

      // Carrega o gate correspondente à razão da invalidade.
      const tipoGate = tipoRazao === "bloqueada" ? "empresa_bloqueada"
                     : tipoRazao === "nao_clt"   ? "vinculo_invalido"
                     : "tempo_minimo";
      const gate = await prisma.iaGateSdr.findFirst({
        // O gate de ação em andamento também é `vinculo_invalido` (campo acao_em_andamento): sem
        // filtrar o campo, agregado/autônomo recebia "já existe um advogado cuidando" (09/11).
        where: {
          projetoId: ctx.projetoId, tipo: tipoGate, ativo: true,
          ...(tipoGate === "vinculo_invalido" ? { OR: [{ campoGatilho: "e_clt" }, { campoGatilho: null }] } : {}),
        },
      });
      // empresa_bloqueada tem flag investigarAnterior; para os demais a semântica é a mesma.
      const investigarAnterior = (gate?.condicaoJson as any)?.investigarAnterior !== false;

      if (investigarAnterior && !semAlternativa) {
        // Nenhum vínculo válido mas lead pode ter outro emprego — perguntar sobre mais empregos.
        const maisEmpregosQ = await getMaisEmpregosAnteriorQuestion(ctx.projetoId, ultimoVinculo?.empresa ?? null);
        if (maisEmpregosQ) {
          return {
            deterministicQuestion: maisEmpregosQ,
            systemInstructions: buildPhaseInstructions(phase, ctx.merged, ctx.vinculos, advNome, mesesMin),
            allDone: false,
            phase,
          };
        }
      } else {
        const nomeCliente = typeof ctx.merged.nome === "string" ? ctx.merged.nome : "";
        let msgGate = renderNomePlaceholder(gate?.mensagemLead ?? "", nomeCliente);
        // A mensagem do gate tempo_minimo é redigida como pivot ("Vamos investigar outro
        // vinculo?"). Em descarte final (lead já negou outros vínculos) o convite não faz
        // sentido — substitui o fecho por encerramento.
        if (/vamos investigar outro v[ií]nculo\??\s*$/i.test(msgGate)) {
          msgGate = msgGate.replace(/\s*vamos investigar outro v[ií]nculo\??\s*$/i,
            " Infelizmente, não conseguiremos te ajudar nesse caso. Agradecemos muito o contato!");
        }
        const msgDescarte = msgGate || `Infelizmente não vamos conseguir atender o seu caso no momento${nomeCliente ? ", " + nomeCliente : ""}.`;
        return {
          deterministicQuestion: msgDescarte,
          systemInstructions: "",
          allDone: false,
          forceDescarte: true,
          phase: "resumo",
        };
      }
    }

    return {
      deterministicQuestion: null,
      systemInstructions: buildResumoEncerramento(ctx.vinculos, advNome),
      allDone: true,
      phase: "resumo",
    };
  }
  return {
    deterministicQuestion: effectiveNextQ,
    systemInstructions: buildPhaseInstructions(phase, ctx.merged, ctx.vinculos, advNome, mesesMin),
    allDone: false,
    phase,
  };
}

// ── Descarte empresa bloqueada ────────────────────────────────────────────────

function buildEmpresaBloqueadaDescarte(empresaNome: string, msgCustom: string | null): string {
  if (msgCustom) {
    return [
      `PRÓXIMA MENSAGEM (envie exatamente este texto, sem modificar, sem acrescentar nada):`,
      msgCustom,
    ].join("\n");
  }
  return [
    `A empresa "${empresaNome}" está numa lista interna com restrição de atendimento.`,
    `Comunique ao lead, com empatia e respeito, que infelizmente não vamos conseguir atender o caso.`,
    `NÃO convide para reunião. NÃO mencione valores. Tom: honesto e cuidadoso.`,
  ].join("\n");
}

// ── Per-phase system instructions ─────────────────────────────────────────────

function buildPhaseInstructions(
  phase: AssistentePhase,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  advNome?: string,
  mesesMin = 2,
): string {
  switch (phase) {
    case "inicial":           return buildInicialInstructions(merged);
    case "vinculos_recente":  return buildVinculosRecenteInstructions(merged, vinculos, advNome, mesesMin);
    case "vinculos_anterior": return buildVinculosAnteriorInstructions(merged, vinculos, advNome);
    case "resumo":            return buildResumoInstructions(merged, vinculos);
  }
}

// ── Agente Inicial ─────────────────────────────────────────────────────────────

function buildInicialInstructions(merged: Record<string, unknown>): string {
  const nomeOk = typeof merged.nome === "string" && merged.nome.trim().length > 1;

  if (!nomeOk) {
    return [
      `Agente inicial — colete apenas o nome do cliente de forma natural.`,
      `Não mencione emprego, direitos trabalhistas, advogados ou qualquer outro assunto.`,
      `SAUDAÇÃO: Use UMA ÚNICA saudação de período (Bom dia / Boa tarde / Boa noite). NÃO adicione "Olá" ou outra saudação em seguida — seria redundante.`,
    ].join("\n");
  }

  return [
    `Agente inicial — nome coletado: ${merged.nome}.`,
    `Siga o fluxo e faça a próxima pergunta indicada abaixo.`,
  ].join("\n");
}

// ── Agente Emprego Recente ─────────────────────────────────────────────────────

function buildVinculosRecenteInstructions(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  advNome?: string,
  mesesMin = 2,
): string {
  const especialista = advNome ?? "o(a) especialista";
  const v0 = vinculos.find(v => v.ordem === 1);
  const empresa = v0?.empresa ?? null;
  const coletados = v0
    ? CAMPOS_REQ.filter(k => v0[k]).map(k => `${String(k)}: ${v0[k]}`).join(", ")
    : null;
  const tempoMesesV0 = v0?.tempo ? parseTempToMeses(String(v0.tempo)) : null;
  const vinculoMuitoCurto = tempoMesesV0 !== null && tempoMesesV0 < mesesMin;
  return [
    `Fase de coleta do emprego mais recente${empresa ? ` (${empresa})` : ""}.`,
    coletados ? `Dados já coletados (não pergunte de novo): ${coletados}.` : "",
    vinculoMuitoCurto
      ? `ATENÇÃO: O tempo de serviço na ${empresa ?? "empresa"} (${v0?.tempo}) é muito curto — sem base suficiente para ação trabalhista nesse vínculo isolado. Ao fazer a próxima pergunta, mencione de forma natural e empática que o período foi muito curto e que precisa verificar se há empregos anteriores.`
      : `Envie exatamente a próxima pergunta definida no fluxo abaixo. Não gere perguntas próprias.`,
    !vinculoMuitoCurto ? `O cliente pode ainda estar empregado — não assuma que já saiu.` : "",
    `Não mencione ${especialista} ainda.`,
    `PROIBIDO: jamais mencione prescrição, prazo de 2 anos, ou diga que o caso está prescrito. Isso é papel exclusivo d${especialista}.`,
  ].filter(Boolean).join("\n");
}

// ── Agente Emprego Anterior ────────────────────────────────────────────────────

function buildVinculosAnteriorInstructions(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  advNome?: string,
): string {
  const especialista = advNome ?? "o(a) especialista";
  const anteriores = vinculos.filter(v => v.ordem > 1).sort((a, b) => b.ordem - a.ordem);
  const alvo = anteriores[0];
  const empresa = alvo?.empresa ?? null;
  const coletados = alvo
    ? CAMPOS_REQ.filter(k => alvo[k]).map(k => `${String(k)}: ${alvo[k]}`).join(", ")
    : null;
  return [
    `Fase de coleta de emprego anterior${empresa ? ` (${empresa})` : ""} — o cliente já saiu dessa empresa.`,
    coletados ? `Dados já coletados (não pergunte de novo): ${coletados}.` : "",
    `Envie exatamente a próxima pergunta definida no fluxo abaixo. Não gere perguntas próprias.`,
    `Use sempre o passado — o cliente já saiu dessa empresa.`,
    `Não mencione ${especialista} ainda.`,
    `PROIBIDO: jamais mencione prescrição, prazo de 2 anos, ou diga que o caso está prescrito. Isso é papel exclusivo d${especialista}.`,
  ].filter(Boolean).join("\n");
}

// ── Agente Resumo ──────────────────────────────────────────────────────────────

function buildResumoInstructions(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
): string {
  const empresas = vinculos.map(v => v.empresa ?? "?").join(", ");

  return [
    `Fase final — vínculos completos (${vinculos.length} empresa(s): ${empresas}).`,
    `Envie exatamente a próxima pergunta definida no fluxo abaixo. Não gere perguntas próprias.`,
    `Não pergunte mais sobre empregos — essa fase já encerrou.`,
    `Não anuncie encerramento nem handoff para outra pessoa — o sistema controla isso.`,
  ].join("\n");
}

// O fluxo real é: assistente → secretaria → advogado.
// A próxima persona após o assistente é a SECRETARIA (agenda reunião), não o advogado diretamente.
// O texto final enviado ao lead é o farewellTexto configurado no DB para a persona "assistente".
// Este buildResumoEncerramento guia o LLM APENAS na última mensagem do assistente.
function buildResumoEncerramento(vinculos: VinculoEmprego[], _advNome?: string): string {
  const empresas = vinculos.map(v => v.empresa ?? "?").join(", ");

  return [
    `FASE DE ENCERRAMENTO — Todos os dados foram coletados (${vinculos.length} empresa(s): ${empresas}).`,
    `Sua resposta DEVE:`,
    `1. Agradecer brevemente pelo tempo do cliente`,
    `2. Confirmar que registrou tudo e que nossa equipe vai entrar em contato em seguida`,
    `REGRAS: MÁXIMO 2 frases curtas. NÃO mencione o nome do advogado nem da secretária — a equipe vai entrar em contato.`,
    `NÃO prometa ligação. NÃO peça horário (a secretária vai apresentar os horários logo em seguida).`,
    `NÃO colete mais dados.`,
    `Exemplo: "Registrei tudo certinho! Nossa equipe já vai entrar em contato com você."`,
  ].join("\n");
}
