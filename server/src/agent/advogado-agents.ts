/**
 * Advogado Agents — 2 focused sub-agents for Daniela's flow.
 *
 * Phase "autoridade":
 *   apresentacao → parecer → valor_estimado → explicar_processo
 *   Goal: establish legal authority, deliver the opinion, build trust.
 *
 * Phase "coleta":
 *   cpf → nome_completo → ... → envio_contrato → confirmacao_final
 *   Goal: collect personal data one field at a time, then send contract.
 *
 * Phase detection is now DB-driven (IaFlowStep.fase column), cached 60s per project.
 */

import { prisma } from "../db.js";
import type { VinculoEmprego, AdvogadoPhase, AdvogadoAgentContext, AdvogadoAgentResult } from "./types.js";

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
  const systemInstructions = phase === "autoridade"
    ? buildAutoridadeInstructions(ctx)
    : buildColetaInstructions(ctx);
  return { phase, systemInstructions };
}

// ── Agente de Autoridade ───────────────────────────────────────────────────────

const COMPLEMENTO_STEPS = new Set(["comp_salario", "comp_jornada", "comp_fgts", "comp_carteira"]);

function buildAutoridadeInstructions(ctx: AdvogadoAgentContext): string {
  const { iaFlowStepChave, merged, vinculos } = ctx;
  const nomeCliente = String(merged.nome ?? "cliente");
  const vinculoDesc = vinculos.map(v =>
    `${v.empresa ?? "?"} (${v.funcao ?? "?"}, ${v.vinculo ?? "?"}, ${v.tempo ?? "?"})`
  ).join("; ");

  const isColetandoComplemento = iaFlowStepChave && COMPLEMENTO_STEPS.has(iaFlowStepChave);

  const base = [
    `AGENTE DE AUTORIDADE — Dra. Daniela Pires`,
    `Fase: coletar informações complementares e elaborar o parecer jurídico personalizado.`,
    ``,
    `REGRAS ABSOLUTAS NESTA FASE:`,
    `- NUNCA peça documentos (CNH, RG, CPF, comprovante de endereço) — isso acontece depois.`,
    `- NUNCA mencione contrato, procuração ou assinatura — ainda não.`,
    `- USE os dados reais do caso: cliente ${nomeCliente}, vínculos: ${vinculoDesc || "ver dados coletados pela Ana"}.`,
    `- Linguagem de WhatsApp: frases curtas e diretas. Máximo 4 frases por resposta.`,
    `- Posicione-se como especialista: transmita segurança e autoridade sobre o caso.`,
  ];

  if (isColetandoComplemento) {
    base.push(
      ``,
      `OBJETIVO IMEDIATO (step ${iaFlowStepChave}): Faça UMA PERGUNTA de cada vez para completar os dados necessários ao parecer.`,
      `- NÃO resuma o que já foi dito. Vá direto à pergunta obrigatória do fluxo.`,
      `- NÃO explique por que está perguntando — apenas pergunte de forma natural.`,
      `- Após essa resposta, haverá mais 1-2 perguntas rápidas antes do parecer jurídico completo.`,
    );
  } else if (iaFlowStepChave === "parecer") {
    base.push(
      ``,
      `⚠️ VOCÊ ESTÁ NO PASSO DO PARECER AGORA. GERE O PARECER JURÍDICO IMEDIATAMENTE.`,
      `PROIBIDO fazer qualquer pergunta neste momento. NÃO peça mais dados. NÃO confirme informações já ditas.`,
      `REGRAS OBRIGATÓRIAS DO PARECER:`,
      `- Cite artigos reais específicos do caso: horas extras não pagas → art. 59 CLT + Súmula 264 TST; pagamento por fora da folha → art. 457 CLT; rescisão indireta → art. 483 CLT; FGTS não depositado → Lei 8.036/90.`,
      `- Use os nomes reais das empresas e irregularidades informadas pelo cliente.`,
      `- Máximo 4 frases curtas. Linguagem de WhatsApp.`,
      `- NÃO termine com pergunta — o lead já confirmou interesse. Encerre afirmando que vai calcular o valor.`,
    );
  } else if (iaFlowStepChave === "valor_estimado") {
    base.push(
      ``,
      `⚠️ VOCÊ ESTÁ NO PASSO DO VALOR ESTIMADO. CALCULE E APRESENTE O RANGE AGORA.`,
      `PROIBIDO fazer qualquer pergunta neste momento. NÃO peça datas, nomes de empresas ou qualquer dado adicional.`,
      `REGRAS OBRIGATÓRIAS DO VALOR ESTIMADO:`,
      `- Calcule para CADA vínculo/empresa separadamente. Os vínculos são: ${vinculoDesc || "ver dados coletados"}.`,
      `- Para cada vínculo informe: nome da empresa, período trabalhado e o range estimado (R$ X a R$ Y).`,
      `- Ao final, some todos os vínculos e apresente o TOTAL estimado.`,
      `- Se faltar algum dado de um vínculo, use o tempo aproximado declarado e sinalize que é estimativa preliminar.`,
      `- Mencione brevemente as verbas: horas extras, FGTS, férias + 13º proporcional, reflexos do salário por fora.`,
      `- NÃO peça confirmação de dados. NÃO faça perguntas. Encerre com transição natural para o próximo passo.`,
    );
  } else if (iaFlowStepChave === "contorno_objecao") {
    base.push(
      ``,
      `⚠️ VOCÊ ESTÁ NO PASSO DE CONTORNO DE OBJEÇÃO. O LEAD HESITOU OU DISSE NÃO.`,
      `PROIBIDO encerrar a conversa ou dizer "até mais". NÃO desista.`,
      `REGRAS OBRIGATÓRIAS:`,
      `- Valide a preocupação com empatia em 1 frase curta.`,
      `- Reforce o modelo de sucesso: zero custo adiantado, só cobramos se ganhar, sem risco para o cliente.`,
      `- Se o valor estimado ainda não foi mencionado, apresente o range agora.`,
      `- Encerre com uma pergunta simples de fechamento: "Quer pelo menos ver quanto pode receber?".`,
    );
  } else {
    base.push(
      ``,
      `Cite artigos reais (art. 59 CLT, art. 457 CLT, art. 483 CLT, Súmula 264 TST, Lei 8.036/90, etc.) e mencione as teses específicas do caso quando aplicável.`,
    );
  }

  return base.join("\n");
}

// ── Agente de Coleta ───────────────────────────────────────────────────────────

function buildColetaInstructions(ctx: AdvogadoAgentContext): string {
  const { iaFlowStepChave, merged } = ctx;
  const nomeCliente = String(merged.nome ?? "cliente");

  const lines = [
    `AGENTE DE COLETA — Dra. Daniela Pires`,
    `Fase: coletar dados pessoais para formalizar o contrato e a procuração.`,
    ``,
    `REGRAS ABSOLUTAS NESTA FASE:`,
    `- UMA PERGUNTA POR VEZ. Não agrupe campos.`,
    `- NUNCA repita o parecer jurídico — essa fase é só coleta de dados.`,
    `- NÃO mencione valores ou estimativas novamente — já foram apresentados.`,
    `- Fale de forma natural e rápida: "Me informa seu CPF?" — sem explicar por que precisa.`,
    `- Se o cliente perguntar algo jurídico, responda em 1 frase e volte para o campo pendente.`,
    `- Confirme os dados que o cliente informar (ex: "Perfeito, anota aqui: CPF 000.000.000-00. Correto?").`,
    `- Step atual: ${iaFlowStepChave ?? "início"}. Dados de ${nomeCliente} sendo coletados.`,
    `- Quando todos os dados estiverem prontos, o contrato será gerado automaticamente — NÃO mencione isso antes.`,
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
    dadosLines.push(`NUNCA confirme valores diferentes destes ao cliente.`);
    lines.push(...dadosLines);
  }

  return lines.join("\n");
}
