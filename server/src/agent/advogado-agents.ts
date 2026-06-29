/**
 * Advogado Agents — focused sub-agents for Daniela's flow.
 *
 * Phase "autoridade":
 *   apresentacao → parecer → contorno_objecao → explicar_processo → confirmacao_final
 *   Goal: establish authority, deliver opinion (NO values), invite to meeting.
 *
 * Phase "coleta": coleta_docs flow (Ana) handles all personal data collection.
 *
 * Phase detection is DB-driven (IaFlowStep.fase column), cached 60s per project.
 */

import { prisma } from "../db.js";
import type { VinculoEmprego, AdvogadoPhase, AdvogadoAgentContext, AdvogadoAgentResult } from "./types.js";
import { getPersonaNomeExibicao } from "./transition-engine.js";

// Re-export for backward compat — callers should migrate to types.ts
export type { AdvogadoPhase, AdvogadoAgentContext, AdvogadoAgentResult };

// ── Step→fase cache (60s TTL per projetoId) ───────────────────────────────────

const _stepFaseCache = new Map<string, { data: Map<string, string>; expiresAt: number }>();

export async function getStepFaseMap(projetoId: string): Promise<Map<string, string>> {
  const cached = _stepFaseCache.get(projetoId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const steps = await prisma.iaFlowStep.findMany({
    where: { projetoId, ativo: true },
    select: { chave: true, fase: true },
  });

  const map = new Map<string, string>();
  for (const step of steps) {
    if (step.chave && step.fase) map.set(step.chave, step.fase);
  }

  _stepFaseCache.set(projetoId, { data: map, expiresAt: Date.now() + 60_000 });
  return map;
}

// ── Phase detection (DB-driven) ────────────────────────────────────────────────

export async function detectAdvogadoPhase(
  projetoId: string,
  iaFlowStepChave: string | null,
): Promise<AdvogadoPhase> {
  if (!iaFlowStepChave) return "autoridade";
  const faseMap = await getStepFaseMap(projetoId);
  const fase = faseMap.get(iaFlowStepChave);
  return fase === "coleta" ? "coleta" : "autoridade";
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runAdvogadoAgent(ctx: AdvogadoAgentContext): Promise<AdvogadoAgentResult> {
  const phase = await detectAdvogadoPhase(ctx.projetoId, ctx.iaFlowStepChave);
  const secretariaNome = await getPersonaNomeExibicao(ctx.projetoId, "secretaria");
  const systemInstructions = phase === "autoridade"
    ? buildAutoridadeInstructions(ctx, secretariaNome)
    : buildColetaInstructions(ctx);
  return { phase, systemInstructions };
}

// ── Agente de Autoridade ───────────────────────────────────────────────────────

function buildAutoridadeInstructions(ctx: AdvogadoAgentContext, secretariaNome: string = "a secretária"): string {
  const { iaFlowStepChave, merged, vinculos } = ctx;
  const nomeCliente = String(merged.nome ?? "cliente");
  const vinculoDesc = vinculos.map(v =>
    `${v.empresa ?? "?"} (${v.funcao ?? "?"}, ${v.vinculo ?? "?"}, ${v.tempo ?? "?"})`
  ).join("; ");

  const isParecer = iaFlowStepChave === "parecer" ||
    iaFlowStepChave === "parecer_acolhimento" ||
    iaFlowStepChave === "parecer_verbas" ||
    iaFlowStepChave === "parecer_calculista" ||
    iaFlowStepChave === "parecer_convite";

  const base = [
    `Restrições importantes nesta fase:`,
    `- Não pergunte sobre salário, holerite, jornada de trabalho, FGTS, carteira de trabalho ou valores financeiros.`,
    `- Não calcule nem mencione valores monetários do caso do cliente.`,
    `- Não invente nomes de empresas — use apenas o que o cliente informou. Se não souber, diga "a empresa".`,
    `- Não peça documentos (CNH, RG, CPF) — isso é feito em outro momento.`,
    `- Não mencione contrato, procuração ou assinatura.`,
    `- Cliente: ${nomeCliente}${vinculoDesc ? `. Vínculos: ${vinculoDesc}` : " — use os dados coletados pela assistente"}.`,
    isParecer
      ? `- Linguagem de WhatsApp: parágrafos curtos. Escreva o conteúdo completo conforme a estrutura da tarefa.`
      : `- Linguagem de WhatsApp: frases curtas e diretas. Máximo 3 frases por resposta.`,
  ];

  if (isParecer) {
    base.push(
      ``,
      `Escreva o conteúdo completo conforme a estrutura definida na tarefa.`,
      `- Não encurte nem resuma.`,
      `- Não faça perguntas intermediárias.`,
      `- Não calcule nem mencione valores monetários do caso.`,
      `- Linguagem próxima e humana — sem juridiquês rebuscado.`,
    );
    if (iaFlowStepChave === "parecer_acolhimento") {
      base.push(``, `Bloco atual: ACOLHIMENTO. Acolha com empatia, valide a situação, confirme que analisou o caso. Cite os vínculos e irregularidades identificados. Encerre sinalizando que vai apresentar os direitos encontrados.`);
    } else if (iaFlowStepChave === "parecer_verbas") {
      base.push(``, `Bloco atual: VERBAS E DIREITOS. Liste as verbas trabalhistas aplicáveis ao caso (horas extras, FGTS, multa, aviso prévio etc.). Cite artigos legais relevantes (art. 59 CLT, Lei 8.036/90, art. 477 CLT). Sem juridiquês.`);
    } else if (iaFlowStepChave === "parecer_calculista") {
      base.push(``, `Bloco atual: PERSPECTIVA E PRAZO. Mencione o prazo de 2 anos para acionar a Justiça. Cite experiência do escritório com casos semelhantes. Gere expectativa positiva sem prometer valores. Indique que o próximo passo é a reunião técnica já agendada.`);
    } else if (iaFlowStepChave === "parecer_convite") {
      base.push(``, `Bloco atual: CONFIRMAÇÃO. A reunião JÁ ESTÁ AGENDADA — NÃO convide para agendar. Parabenize pela decisão, reforce que a reunião é online, rápida (20-30 min) e sem necessidade de preparação. Encerre com entusiasmo — sem pergunta.`);
    }
  } else if (iaFlowStepChave === "contorno_objecao") {
    base.push(
      ``,
      `Contexto: a reunião técnica JÁ ESTÁ AGENDADA. O lead está hesitando, quer cancelar ou demonstrou preocupação.`,
      `Leia o que o lead disse e escolha o cenário correto:`,
      ``,
      `Cenário A — Lead confirma a reunião, está animado ou fez uma pergunta simples:`,
      `→ Responda em 1-2 frases com entusiasmo. Encerre: "Até a reunião!"`,
      ``,
      `Cenário B — Lead quer reagendar (surgiu frete, ocupado esta semana):`,
      `→ Acolha sem drama. Diga que pode reagendar: "Manda um aviso pra secretária, a gente encaixa outro horário pra você!"`,
      `→ Reforce: é online, rápida, sem compromisso.`,
      ``,
      `Cenário C — Lead hesita ou quer desistir (mudou de ideia, não sei não, depois eu vejo):`,
      `→ Acolha com cuidado. Pergunte o que aconteceu em 1 frase.`,
      `→ Reforce: a reunião não abre nenhum processo — é só uma conversa. Zero custo, zero compromisso.`,
      `→ Mencione prescrição com cuidado: cada mês que passa é um direito que some.`,
      ``,
      `Não pergunte sobre documentos, valores do caso ou salário. Máximo 4 frases.`,
    );
  } else if (iaFlowStepChave === "__done__") {
    // First message after meeting was scheduled (secretaria → advogado handoff).
    // Do NOT use reengagement/closer language ("ficamos de conversar", "na época").
    // The lead just confirmed a meeting — start with a warm, professional introduction.
    base.push(
      ``,
      `Esta é sua primeira mensagem para este lead — a reunião técnica acaba de ser agendada pela secretária.`,
      `Apresente-se brevemente como a advogada responsável pelo caso. Use o nome do lead (${nomeCliente}).`,
      `Tom: próxima, confiante e profissional. Frases curtas. Máximo 3 frases.`,
      `NÃO use expressões como "ficamos de conversar", "na época", "acabamos não conseguindo" ou linguagem de reengajamento — você está sendo apresentada AGORA, logo após o agendamento.`,
      `Finalize sinalizando que vai analisar o histórico do lead para a reunião.`,
    );
  } else {
    base.push(
      ``,
      `Transmita segurança e autoridade. Cite artigos legais relevantes quando aplicável (art. 59 CLT, Lei 8.036/90, art. 477 CLT).`,
    );
  }

  return base.join("\n");
}

// ── Agente de Coleta ───────────────────────────────────────────────────────────

function buildColetaInstructions(ctx: AdvogadoAgentContext): string {
  const { iaFlowStepChave, merged } = ctx;
  const nomeCliente = String(merged.nome ?? "cliente");

  const lines = [
    `Fase de coleta de dados pessoais para formalizar o contrato e a procuração.`,
    ``,
    `Orientações para esta fase:`,
    `- Uma pergunta por vez. Não agrupe campos.`,
    `- Não repita o parecer jurídico — esta fase é só coleta de dados.`,
    `- Não mencione valores ou estimativas — já foram apresentados.`,
    `- Fale de forma natural e rápida: "Me informa seu CPF?" — sem explicar por que precisa.`,
    `- Se o cliente perguntar algo jurídico, responda em 1 frase e volte para o campo pendente.`,
    `- Confirme os dados que o cliente informar (ex: "Perfeito, anota aqui: CPF 000.000.000-00. Correto?").`,
    `- Step atual: ${iaFlowStepChave ?? "início"}. Dados de ${nomeCliente} sendo coletados.`,
    `- Quando todos os dados estiverem prontos, o contrato será gerado automaticamente — não mencione isso antes.`,
  ];

  // Inject structured identity values when available so LLM doesn't re-derive them from raw OCR text
  const cpf = merged.cpf;
  const rg  = merged.rg;
  const nomeCompleto = merged.nome_completo ?? merged.nome;
  const dataNascimento = merged.data_nascimento;
  if (cpf || rg) {
    const dadosLines = [
      ``,
      `DADOS JÁ VERIFICADOS DO SISTEMA (USE ESTES EXATOS, NÃO O TEXTO BRUTO DO DOCUMENTO):`,
    ];
    if (cpf)            dadosLines.push(`- CPF: ${cpf}`);
    if (rg)             dadosLines.push(`- RG: ${rg}`);
    if (nomeCompleto)   dadosLines.push(`- Nome completo: ${nomeCompleto}`);
    if (dataNascimento) dadosLines.push(`- Data de nascimento: ${dataNascimento}`);
    dadosLines.push(`Use estes valores exatos ao confirmar com o cliente. Não use outros números.`);
    lines.push(...dadosLines);
  } else {
    // CPF/RG ainda não foram coletados — bloquear alucinação
    lines.push(``, `CPF e RG ainda não foram coletados. Não mencione nenhum número de CPF ou RG — pergunte diretamente ao cliente.`);
  }

  return lines.join("\n");
}
