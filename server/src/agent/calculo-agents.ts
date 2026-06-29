/**
 * Agente de Cálculo — persona "calculo"
 *
 * Toda a lógica (perguntas, fórmulas, parâmetros) vive no banco:
 *   - Perguntas:  IaFlowStep  fase="calculo"  (via advanceAdvogadoFlow)
 *   - Fórmula:   IaPersona.systemPrompt  chave="calculo"
 *
 * Este módulo só monta a injeção de contexto com os dados já coletados,
 * para que o LLM possa calcular e apresentar o resultado conforme o
 * systemPrompt configurado no banco.
 */

import type { VinculoEmprego } from "./types.js";

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

/**
 * Monta a injeção de contexto (personaInstrucoes) com todos os dados disponíveis.
 * O LLM usa esses dados + o systemPrompt do banco para calcular e apresentar.
 */
export function buildCalculoInjection(
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
): string {
  const v0 = vinculos.find(v => v.ordem === 1);

  const linhas: string[] = [];

  if (v0?.empresa)  linhas.push(`Empresa: ${v0.empresa}`);
  if (v0?.funcao)   linhas.push(`Função: ${v0.funcao}`);
  if (v0?.vinculo)  linhas.push(`Vínculo: ${v0.vinculo}`);
  if (v0?.tempo)    linhas.push(`Tempo de empresa: ${v0.tempo}`);
  if (v0?.saida || merged.saida)
    linhas.push(`Saída: ${v0?.saida ?? merged.saida}`);

  const salHolerite = merged.calculo_salario_holerite ?? (v0 as any)?.salario_holerite;
  const salFora     = merged.calculo_salario_fora     ?? (v0 as any)?.salario_por_fora;
  if (salHolerite != null) linhas.push(`Salário holerite: ${fmt(Number(salHolerite))}`);
  if (salFora     != null && Number(salFora) > 0)
    linhas.push(`Salário fora do holerite: ${fmt(Number(salFora))}`);

  const jInicio = merged.calculo_jornada_inicio;
  const jFim    = merged.calculo_jornada_fim;
  const jInt    = merged.calculo_intervalo_min;
  if (jInicio && jFim) linhas.push(`Jornada: ${jInicio} às ${jFim}${jInt != null ? `, intervalo ${jInt} min` : ""}`);

  if (merged.calculo_he_pagas != null)
    linhas.push(`Horas extras pagas: ${merged.calculo_he_pagas === true || merged.calculo_he_pagas === "true" ? "sim" : "não"}`);
  else if (v0?.horas_extras)
    linhas.push(`Tinha horas extras: ${v0.horas_extras}`);

  if (merged.calculo_modalidade_saida)
    linhas.push(`Modalidade de saída: ${merged.calculo_modalidade_saida}`);

  const fgts = merged.calculo_fgts ?? (v0 as any)?.fgts_ok ?? merged.fgts_ok;
  if (fgts) linhas.push(`FGTS: ${fgts}`);

  if (v0?.injustica || merged.injustica)
    linhas.push(`Injustiça relatada: ${v0?.injustica ?? merged.injustica}`);
  if (v0?.frota || merged.frota)
    linhas.push(`Frota da empresa: ${v0?.frota ?? merged.frota} veículos`);

  const nomeCliente = typeof merged.nome === "string" ? merged.nome.split(" ")[0] : null;

  return [
    `DADOS COLETADOS DO CASO${nomeCliente ? ` (${nomeCliente})` : ""}:`,
    ...linhas,
    "",
    "Use os dados acima e a metodologia de cálculo do seu system prompt para estimar o valor da causa.",
    "Apresente a faixa e as teses conforme instruído.",
  ].join("\n");
}
