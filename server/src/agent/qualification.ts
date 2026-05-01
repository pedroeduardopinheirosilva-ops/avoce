/**
 * Qualification — LLM-based data extraction for employment links (vínculos) and conversation data.
 * OCR functions → ocr-providers.ts + doc-extractor.ts
 * Pure utilities (validarCPF, syncVinculosFromFlat, temDadosMinimosCalculo) → qualification-utils.ts
 * Types (VinculoEmprego, DocJsonResult) → types.ts
 */

import { extractJson } from "./llm.js";
import type { VinculoCalculo } from "./calc-trabalhista.js";
import type { VinculoEmprego } from "./types.js";
import { parseBrNumber } from "./qualification-utils.js";

// Re-export for backward compat — callers should migrate to types.ts
export type { VinculoEmprego };

function parseTempo(s: string | undefined): number | undefined {
  if (!s) return undefined;
  let t = 0;
  const ma = s.match(/(\d+)\s*an/i); if (ma) t += parseInt(ma[1]) * 12;
  const mm = s.match(/(\d+)\s*m[eê]/i); if (mm) t += parseInt(mm[1]);
  return t > 0 ? t : undefined;
}

export function extractVinculosFromMerged(merged: Record<string, unknown>): VinculoCalculo[] {
  const vinculosRaw = Array.isArray(merged.vinculos) ? merged.vinculos as any[] : [];
  if (vinculosRaw.length > 0) {
    return vinculosRaw.map((v, idx) => ({
      empresa: String(v.empresa ?? "Empresa não informada"),
      funcao: String(v.funcao ?? "Função não informada"),
      vinculo: (v.vinculo === "CLT" || v.vinculo === "PJ" || v.vinculo === "autonomo" || v.vinculo === "informal")
        ? v.vinculo : "CLT",
      data_admissao: v.data_admissao ?? undefined,
      data_saida: v.data_saida ?? v.saida ?? undefined,
      tempo_meses_estimado: v.tempo_meses_estimado ? Number(v.tempo_meses_estimado) : parseTempo(v.tempo),
      salario_holerite: v.salario_holerite
        ? parseBrNumber(v.salario_holerite) || undefined
        : (idx === 0 && merged.salario_holerite ? parseBrNumber(merged.salario_holerite) || undefined : undefined),
      salario_por_fora: v.salario_por_fora
        ? parseBrNumber(v.salario_por_fora) || undefined
        : (idx === 0 && merged.salario_por_fora ? parseBrNumber(merged.salario_por_fora) || undefined : undefined),
      salario_total_declarado: v.salario_total_declarado
        ? parseBrNumber(v.salario_total_declarado) || undefined
        : (idx === 0 && merged.salario_total_declarado ? parseBrNumber(merged.salario_total_declarado) || undefined : undefined),
      jornada_inicio: v.jornada_inicio ?? (idx === 0 ? (merged.jornada_inicio as string | undefined) : undefined),
      jornada_fim: v.jornada_fim ?? (idx === 0 ? (merged.jornada_fim as string | undefined) : undefined),
      intervalo_minutos: v.intervalo_minutos
        ? Number(v.intervalo_minutos)
        : (idx === 0 && merged.intervalo_minutos ? Number(merged.intervalo_minutos) : undefined),
      horas_extras_pagas: v.horas_extras_pagas ?? (v.horas_extras === false ? false : undefined),
      modalidade_saida: v.modalidade_saida ?? undefined,
      injustica_relatada: v.injustica ?? v.injustica_relatada ?? undefined,
      frota_empresa: v.frota ? Number(v.frota) : undefined,
      fgtsOk: (v.fgts_ok ?? (idx === 0 ? merged.fgts_ok : undefined)) as "sim" | "nao" | "parcial" | undefined,
      situacaoCtps: (v.situacao_ctps ?? (idx === 0 ? merged.situacao_ctps : undefined)) as "assinada" | "nao_assinada" | "parcial" | undefined,
    }));
  }
  return [{
    empresa: String(merged.empresa_recente ?? merged.empresa_principal ?? "Empresa não informada"),
    funcao: String(merged.funcao ?? "Função não informada"),
    vinculo: "CLT",
    salario_total_declarado: merged.salario_total_declarado ? parseBrNumber(merged.salario_total_declarado) || undefined : undefined,
    salario_holerite: merged.salario_holerite ? parseBrNumber(merged.salario_holerite) || undefined : undefined,
    fgtsOk: merged.fgts_ok as "sim" | "nao" | "parcial" | undefined,
    situacaoCtps: merged.situacao_ctps as "assinada" | "nao_assinada" | "parcial" | undefined,
  }];
}

export async function extractQualificacaoData(
  projetoId: string,
  text: string,
  perguntas: { chave: string; perguntaContexto: string; tipoDado: string }[],
  merged: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const pendingPerguntas = perguntas.filter(p => merged[p.chave] === undefined || merged[p.chave] === null);
  if (pendingPerguntas.length === 0) return null;

  const pendingStr = pendingPerguntas
    .map((p) => `"${p.chave}" /* ${p.perguntaContexto} */: ${p.tipoDado === "booleano" ? "true/false/null" : '"valor ou null"'}`)
    .join(", ");

  return extractJson({
    projetoId,
    instruction: `Analise a conversa abaixo e extraia os campos solicitados com base no que o CLIENTE respondeu. Use null quando não mencionado ou resposta ambígua.\nCampos: {${pendingStr}}`,
    text,
  });
}

export async function tryExtractVinculo(
  projetoId: string,
  text: string,
  vinculos: VinculoEmprego[],
  historiaTexto: string,
  maisEmpregosConfirmado = false,
  maisEmpregosPerguntado = false,
): Promise<{ vinculo: VinculoEmprego | null; semMaisEmpregos: boolean; updatedVinculos: VinculoEmprego[]; confirmouMaisEmpregos: boolean }> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });

  const vinculosJson = JSON.stringify(
    vinculos.map((v) => ({
      ordem: v.ordem, empresa: v.empresa ?? null, funcao: v.funcao ?? null,
      vinculo: v.vinculo ?? null, tempo: v.tempo ?? null, data_saida: v.data_saida ?? null,
      saida: v.saida ?? null, horas_extras: v.horas_extras ?? null,
      pagamento_fora: v.pagamento_fora ?? null, injustica: v.injustica ?? null, frota: v.frota ?? null,
      salario_holerite: v.salario_holerite ?? null, salario_por_fora: v.salario_por_fora ?? null,
      jornada_inicio: v.jornada_inicio ?? null, jornada_fim: v.jornada_fim ?? null,
      intervalo_minutos: v.intervalo_minutos ?? null,
    })),
    null, 2
  );

  const result = await extractJson<{
    sem_mais_empregos?: boolean;
    confirmou_mais_empregos?: boolean;
    vinculos_atualizados?: Array<{
      ordem: number; empresa?: string | null; funcao?: string | null; vinculo?: string | null;
      tempo?: string | null; data_saida?: string | null; saida?: string | null;
      horas_extras?: string | null; pagamento_fora?: string | null; injustica?: string | null; frota?: string | null;
      salario_holerite?: number | null; salario_por_fora?: number | null;
      jornada_inicio?: string | null; jornada_fim?: string | null; intervalo_minutos?: number | null;
    }>;
    novo_vinculo?: {
      empresa?: string | null; funcao?: string | null; vinculo?: string | null;
      tempo?: string | null; data_saida?: string | null; saida?: string | null;
      horas_extras?: string | null; pagamento_fora?: string | null; injustica?: string | null; frota?: string | null;
      salario_holerite?: number | null; salario_por_fora?: number | null;
      jornada_inicio?: string | null; jornada_fim?: string | null; intervalo_minutos?: number | null;
    } | null;
  }>({
    projetoId,
    instruction: `DATA ATUAL: ${hoje}.

Você está analisando mensagens de um cliente para extrair informações de vínculos trabalhistas.

VÍNCULOS JÁ COLETADOS (array atual):
${vinculosJson}

TAREFA:
1. Preencha campos null dos vínculos existentes com informações mencionadas no texto.
2. Se o cliente mencionou um emprego DIFERENTE dos já listados, inclua em "novo_vinculo". SE O ARRAY ESTÁ VAZIO ([]) e o cliente mencionou qualquer empresa/empregador, coloque OBRIGATORIAMENTE em "novo_vinculo".
3. Marque "sem_mais_empregos": true SOMENTE se ${maisEmpregosPerguntado ? "a pergunta sobre empregos anteriores foi feita e" : "o cliente usou negação inequívoca e explícita de outros empregos — ex: 'não', 'não trabalhei', 'só essa empresa', 'nenhuma outra', 'somente lá'. NÃO marque true para frases passivas como 'meu último emprego', 'trabalhei por último em'. NUNCA infira ausência de empregos sem negação explícita. Caso contrário (não houver negação clara), e"} o cliente indicou que não tem mais empregos. REGRAS (quando a pergunta foi feita ou o cliente negou explicitamente):
   - Se o cliente começar com "não", "nao", "não trabalhei", "só esses", "foi só" → marque true.
   - Se o cliente mencionar uma empresa que JÁ ESTÁ na lista de vínculos → marque true (está descrevendo trajetória já coletada).
   - NUNCA inferir de frases passivas como "por último", "meu último emprego", "saí de lá e" — essas frases NÃO confirmam ausência de empregos anteriores.
4. Marque "confirmou_mais_empregos": true quando o cliente confirmou que teve outro emprego mas NÃO deu o nome ainda (ex: "sim", "sim trabalhei", "tive mais", "trabalhei sim", "tinha outro"). Só marque true se NÃO colocou o nome em novo_vinculo.

REGRA CRÍTICA — confirmação + nome de empresa na mesma mensagem:
Se a mensagem contém confirmação de outro emprego (ex: "sim", "trabalhei sim", "tive") E o nome de uma empresa, preencha AMBOS:
- confirmou_mais_empregos: true
- novo_vinculo: { "empresa": "[nome da empresa]", ... }
NÃO marque apenas confirmou_mais_empregos sem preencher novo_vinculo.empresa quando o nome da empresa está presente na mensagem.
Exemplos:
  "trabalhei sim até abril na Transporte Azul Ltda" → confirmou_mais_empregos: true, novo_vinculo: { empresa: "Transporte Azul Ltda", saida: "abril de ..." }
  "sim, trabalhei em outra empresa antes" → confirmou_mais_empregos: true, novo_vinculo: null (sem nome)

${maisEmpregosConfirmado ? `
MODO MAIS EMPREGOS ATIVO: o cliente já confirmou que trabalhou em outra empresa ANTES das já listadas. A mensagem atual é a resposta dele dando o nome desse emprego anterior. REGRA ABSOLUTA:
- Qualquer nome de empresa que o cliente mencionar DEVE ir para "novo_vinculo", MESMO que seja igual ou parecido com um já listado (a pessoa pode ter trabalhado na mesma empresa em períodos diferentes).
- NÃO tente deduplicar pelo nome — crie novo_vinculo com o nome que o cliente disse.
- Se o cliente não der um nome claro, marque confirmou_mais_empregos: true para continuar pedindo.` : ""}

REGRAS CRÍTICAS DE PREENCHIMENTO:
- NUNCA deixe um campo como null se o cliente respondeu sobre ele, mesmo que com "não", "nenhum", "sim", "normal".
- "não" é uma resposta válida. Ex: cliente disse "não tinha horas extras" → horas_extras = "não tinha horas extras".
- "sim" genérico = capture o contexto. Ex: "sim, recebia por Pix" → pagamento_fora = "sim, recebia por Pix".
- Capture o máximo possível do que o cliente disse, mesmo que incompleto.
- REGRA CRÍTICA para o campo "saida":
  Só preencha saida se o lead declarou EXPLICITAMENTE uma das seguintes situações:
    * Foi demitido (palavras: demitido, mandaram embora, fui dispensado, perdi o emprego, me mandaram embora)
    * Pediu demissão (palavras: pedi demissão, saí por conta própria, eu saí, me desliguei, larguei)
    * Ainda trabalha lá (palavras: ainda trabalho, estou lá, trabalho até hoje, continuo lá)
    * Uma data ou período de saída ("saí em março", "saí há 6 meses", "saí ano passado")
  Se a resposta contiver apenas o nome da empresa, função, ou tempo verbal no passado SEM nenhum dos sinais acima → saida = null.
  NÃO infira saida a partir de: tempo verbal passado ("trabalhei", "era motorista"), menção à empresa no passado, ou qualquer outra inferência que não seja declaração explícita.

CAMPOS A EXTRAIR (para cada vínculo):
- empresa: nome da empresa
- funcao: cargo/função exercida
- vinculo: "CLT" | "autônomo" | "avulso" | "cooperado"
- tempo: tempo total de trabalho lá
- data_saida: data de rescisão/demissão no formato DD/MM/AAAA ou MM/AAAA — CRÍTICO para prescrição
- saida: como e quando saiu (demitido, pediu demissão, ainda empregado, etc)
- horas_extras: horas extras além da jornada normal. Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- pagamento_fora: pagamentos fora do holerite (PIX, Pamcard, dinheiro). Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- injustica: irregularidades sofridas. Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- frota: tamanho da frota da empresa (se mencionado)
- salario_holerite: número — valor exato do salário registrado na carteira/holerite em R$. Se mencionar "mínimo do sindicato", "salário base" ou valor específico, capture o número. Ex: "2000 na carteira" → 2000. DEIXE NULL se não mencionado.
- salario_por_fora: número — valor recebido fora do holerite (PIX, Pamcard, dinheiro, comissão por frete) em R$ por mês. Se percentual sem valor mensal (ex: "12% do frete"), registre null. Ex: "8000 por fora" → 8000. DEIXE NULL se não mencionado.
- jornada_inicio: string "HH:MM" — hora de início da jornada. Converta horas informais: "das 5" → "05:00", "às 6h" → "06:00", "de manhã às 4" → "04:00". DEIXE NULL se não mencionado.
- jornada_fim: string "HH:MM" — hora de término da jornada. Converta: "até as 23" → "23:00", "até meia-noite" → "00:00", "até as 22h30" → "22:30". DEIXE NULL se não mencionado.
- intervalo_minutos: número inteiro — minutos de intervalo/almoço. Se não informado explicitamente, DEIXE NULL (não assuma 60min).

Responda APENAS JSON no formato:
{
  "sem_mais_empregos": false,
  "confirmou_mais_empregos": false,
  "vinculos_atualizados": [
    { "ordem": 1, "empresa": "...", "funcao": null, ... }
  ],
  "novo_vinculo": null
}`,
    text: historiaTexto + "\n\nMensagem atual: " + text,
  });

  if (!result) {
    console.warn(`[tryExtractVinculo] extractJson retornou null — mantendo vinculos anteriores`);
    return { vinculo: null, semMaisEmpregos: false, updatedVinculos: vinculos, confirmouMaisEmpregos: false };
  }

  let updatedVinculos = [...vinculos];
  if (result.vinculos_atualizados?.length) {
    for (const upd of result.vinculos_atualizados) {
      const idx = updatedVinculos.findIndex((v) => v.ordem === upd.ordem);
      if (idx >= 0) {
        const existing = updatedVinculos[idx];
        updatedVinculos[idx] = {
          ...existing,
          empresa:           existing.empresa           ?? (upd.empresa           ?? undefined),
          funcao:            existing.funcao            ?? (upd.funcao            ?? undefined),
          vinculo:           existing.vinculo           ?? (upd.vinculo           ?? undefined),
          tempo:             existing.tempo             ?? (upd.tempo             ?? undefined),
          data_saida:        existing.data_saida        ?? (upd.data_saida        ?? undefined),
          saida:             existing.saida             ?? (upd.saida             ?? undefined),
          horas_extras:      existing.horas_extras      ?? (upd.horas_extras      ?? undefined),
          pagamento_fora:    existing.pagamento_fora    ?? (upd.pagamento_fora    ?? undefined),
          injustica:         existing.injustica         ?? (upd.injustica         ?? undefined),
          frota:             existing.frota             ?? (upd.frota             ?? undefined),
          salario_holerite:  existing.salario_holerite  ?? (upd.salario_holerite  ?? undefined),
          salario_por_fora:  existing.salario_por_fora  ?? (upd.salario_por_fora  ?? undefined),
          jornada_inicio:    existing.jornada_inicio    ?? (upd.jornada_inicio    ?? undefined),
          jornada_fim:       existing.jornada_fim       ?? (upd.jornada_fim       ?? undefined),
          intervalo_minutos: existing.intervalo_minutos ?? (upd.intervalo_minutos ?? undefined),
        };
      }
    }
  }

  if (result.sem_mais_empregos) {
    return { vinculo: null, semMaisEmpregos: true, updatedVinculos, confirmouMaisEmpregos: false };
  }

  if (result.novo_vinculo?.empresa) {
    const novoVinculo: VinculoEmprego = {
      ordem: updatedVinculos.length + 1,
      empresa:           result.novo_vinculo.empresa           ?? undefined,
      funcao:            result.novo_vinculo.funcao            ?? undefined,
      vinculo:           result.novo_vinculo.vinculo           ?? undefined,
      tempo:             result.novo_vinculo.tempo             ?? undefined,
      data_saida:        result.novo_vinculo.data_saida        ?? undefined,
      saida:             result.novo_vinculo.saida             ?? undefined,
      horas_extras:      result.novo_vinculo.horas_extras      ?? undefined,
      pagamento_fora:    result.novo_vinculo.pagamento_fora    ?? undefined,
      injustica:         result.novo_vinculo.injustica         ?? undefined,
      frota:             result.novo_vinculo.frota             ?? undefined,
      salario_holerite:  result.novo_vinculo.salario_holerite  ?? undefined,
      salario_por_fora:  result.novo_vinculo.salario_por_fora  ?? undefined,
      jornada_inicio:    result.novo_vinculo.jornada_inicio    ?? undefined,
      jornada_fim:       result.novo_vinculo.jornada_fim       ?? undefined,
      intervalo_minutos: result.novo_vinculo.intervalo_minutos ?? undefined,
    };
    return { vinculo: novoVinculo, semMaisEmpregos: false, updatedVinculos, confirmouMaisEmpregos: false };
  }

  return { vinculo: null, semMaisEmpregos: false, updatedVinculos, confirmouMaisEmpregos: result.confirmou_mais_empregos === true };
}

export async function askLlmVinculoPrazo(
  projetoId: string,
  vinculo: VinculoEmprego,
): Promise<boolean> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });
  const textoAnalise = [
    vinculo.data_saida ? `Data de rescisão: ${vinculo.data_saida}` : null,
    vinculo.saida      ? `Descrição da saída: ${vinculo.saida}` : null,
    vinculo.tempo      ? `Tempo de serviço (NÃO é a data de saída): ${vinculo.tempo}` : null,
  ].filter(Boolean).join("\n");

  const result = await extractJson<{ dentro_prazo: boolean }>({
    projetoId,
    instruction: `DATA ATUAL: ${hoje}.

Determine se a DATA DE RESCISÃO/DEMISSÃO está dentro do prazo prescricional de 2 anos.
ATENÇÃO: "tempo de serviço" (ex: "5 anos") NÃO é a data de saída — ignore para calcular prescrição.
A prescrição conta a partir da DATA EM QUE O VÍNCULO FOI ENCERRADO.

Responda JSON:
- {"dentro_prazo": true} se a rescisão foi há MENOS de 2 anos da DATA ATUAL
- {"dentro_prazo": false} se foi há MAIS de 2 anos
- {"dentro_prazo": true} se não há informação suficiente sobre a data (conservador)`,
    text: textoAnalise,
  });

  return result?.dentro_prazo !== false;
}

/** @deprecated Use askLlmVinculoPrazo */
export const checkVinculoPrazo = askLlmVinculoPrazo;

export async function askLlmPrescricao(
  projetoId: string,
  qualificacao: Record<string, unknown>,
  history: { direcao: string; conteudo: string | null }[]
): Promise<"ativa" | "prescrita" | "pendente"> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });
  const conversa = history.slice(-20)
    .map((m) => `${m.direcao === "out" ? "Assistente" : "Cliente"}: ${m.conteudo ?? ""}`)
    .join("\n");

  const result = await extractJson<{ prescricao: "ativa" | "prescrita" | "pendente" }>({
    projetoId,
    instruction: `DATA ATUAL: ${hoje}

Analise os dados de qualificação e determine o prazo prescricional trabalhista (CLT art. 11 — 2 anos após rescisão).

Dados coletados: ${JSON.stringify(qualificacao)}

Responda JSON com um dos três valores:
- {"prescricao": "ativa"} → a saída do emprego mais recente ocorreu HÁ MENOS de 2 anos da DATA ATUAL (prazo ainda aberto)
- {"prescricao": "prescrita"} → a saída ocorreu HÁ MAIS de 2 anos (prazo vencido para esse emprego)
- {"prescricao": "pendente"} → não há informação suficiente sobre a data de saída para determinar

Seja conservador: só responda "prescrita" quando a data for claramente anterior a 2 anos atrás.`,
    text: conversa,
  });

  return result?.prescricao ?? "pendente";
}

/** @deprecated Use askLlmPrescricao */
export const checkPrescricao = askLlmPrescricao;
