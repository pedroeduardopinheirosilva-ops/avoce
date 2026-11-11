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
import { limparEmpresaPlaceholder } from "./sinais-lead.js";

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
      salario_holerite: v.salario_holerite != null
        ? (parseBrNumber(v.salario_holerite) || undefined)
        : (idx === 0 && merged.salario_holerite != null ? (parseBrNumber(merged.salario_holerite) || undefined) : undefined),
      salario_por_fora: v.salario_por_fora != null
        ? (parseBrNumber(v.salario_por_fora) || undefined)
        : (idx === 0 && merged.salario_por_fora != null ? (parseBrNumber(merged.salario_por_fora) || undefined) : undefined),
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
  personaLlmChave: string | null = null,
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
    personaLlmChave,
  });
}

export async function tryExtractVinculo(
  projetoId: string,
  text: string,
  vinculos: VinculoEmprego[],
  historiaTexto: string,
  maisEmpregosConfirmado = false,
  maisEmpregosPerguntado = false,
  personaLlmChave: string | null = null,
): Promise<{ vinculo: VinculoEmprego | null; semMaisEmpregos: boolean; updatedVinculos: VinculoEmprego[]; confirmouMaisEmpregos: boolean }> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });

  const vinculosJson = JSON.stringify(
    vinculos.map((v) => ({
      ordem: v.ordem, empresa: v.empresa ?? null, funcao: v.funcao ?? null,
      vinculo: v.vinculo ?? null, tempo: v.tempo ?? null, data_saida: v.data_saida ?? null,
      periodo_sem_registro: v.periodo_sem_registro ?? null,
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
    correcao_empresa?: { ordem: number; empresa: string } | null;
    vinculos_atualizados?: Array<{
      ordem: number; empresa?: string | null; funcao?: string | null; vinculo?: string | null;
      tempo?: string | null; data_saida?: string | null; saida?: string | null;
      horas_extras?: string | null; pagamento_fora?: string | null; injustica?: string | null; frota?: string | null;
      periodo_sem_registro?: string | null;
      salario_holerite?: number | null; salario_por_fora?: number | null;
      jornada_inicio?: string | null; jornada_fim?: string | null; intervalo_minutos?: number | null;
      jornada_descricao?: string | null;
    }>;
    novo_vinculo?: {
      empresa?: string | null; funcao?: string | null; vinculo?: string | null;
      tempo?: string | null; data_saida?: string | null; saida?: string | null;
      horas_extras?: string | null; pagamento_fora?: string | null; injustica?: string | null; frota?: string | null;
      periodo_sem_registro?: string | null;
      salario_holerite?: number | null; salario_por_fora?: number | null;
      jornada_inicio?: string | null; jornada_fim?: string | null; intervalo_minutos?: number | null;
      jornada_descricao?: string | null;
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
5. CORREÇÃO DE NOME: se o cliente reescreveu ou corrigiu o nome de uma empresa JÁ listada — grafia parecida (erro de áudio/digitação: "Contonela" → "Fontanella trasportes"), ou disse "escrevi errado", "é a mesma", "só uma empresa" — preencha "correcao_empresa": { "ordem": <ordem do vínculo>, "empresa": "<nome corrigido>" } e NÃO crie novo_vinculo. Isso NÃO é outro emprego. Sem correção: "correcao_empresa": null.

REGRA CRÍTICA — confirmação + nome de empresa na mesma mensagem:
Se a mensagem contém confirmação de outro emprego (ex: "sim", "trabalhei sim", "tive", "antes trabalhei", "antes da [empresa] trabalhei") E o nome de uma empresa NÃO listada no array atual, preencha AMBOS:
- confirmou_mais_empregos: true
- novo_vinculo: { "empresa": "[nome da empresa]", ... }
NÃO marque apenas confirmou_mais_empregos sem preencher novo_vinculo.empresa quando o nome da empresa está presente na mensagem.

⚠️ ANTI-FALSO-POSITIVO CRÍTICO: NUNCA marque sem_mais_empregos: true quando a mensagem menciona uma empresa NOVA (não listada no array atual). Exemplos de erros a evitar:
  ❌ "sim, antes trabalhei 2 anos na Logistica Brasil CLT" → sem_mais_empregos: true ← ERRADO!
  ❌ "sim, antes da TransXYZ trabalhei 4 anos na Transparra CLT" → sem_mais_empregos: true ← ERRADO!
  ❌ "Antes dessa empresa, trabalhei na Multilog Transportes" → sem_mais_empregos: true ← ERRADO!
Nesses casos SEMPRE use: confirmou_mais_empregos: true, novo_vinculo: {empresa: "...", ...}, sem_mais_empregos: false.

Exemplos corretos:
  "sim, antes trabalhei 2 anos na Logistica Brasil CLT, motorista, hora extra" → confirmou_mais_empregos: true, novo_vinculo: { empresa: "Logistica Brasil", vinculo: "CLT", tempo: "2 anos", ... }, sem_mais_empregos: false
  "trabalhei sim até abril na Transporte Azul Ltda" → confirmou_mais_empregos: true, novo_vinculo: { empresa: "Transporte Azul Ltda", saida: "abril de ..." }, sem_mais_empregos: false
  "sim, trabalhei em outra empresa antes" → confirmou_mais_empregos: true, novo_vinculo: null (sem nome), sem_mais_empregos: false
  "nao, só essas empresas" → sem_mais_empregos: true, novo_vinculo: null ← ÚNICA situação com sem_mais_empregos: true

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
    * Uma data ou período de saída ("saí em março", "saí há 6 meses", "saí ano passado", "tem 60 dias que saí", "há 2 meses", "faz uns 3 meses")
  Se a resposta contiver apenas o nome da empresa, função, ou tempo verbal no passado SEM nenhum dos sinais acima → saida = null.
  NÃO infira saida a partir de: tempo verbal passado ("trabalhei", "era motorista"), menção à empresa no passado, ou qualquer outra inferência que não seja declaração explícita.

CAMPOS A EXTRAIR (para cada vínculo):
- empresa: nome da empresa
- funcao: cargo/função exercida
- vinculo: "CLT" | "informal" | "autônomo" | "avulso" | "cooperado" — CRÍTICO: só preencha se houver base no que o cliente disse para ESSA empresa específica. Nunca infira CLT por analogia com outro vínculo. Se não há nenhuma informação sobre o regime/condições: DEIXE NULL. Regras de classificação:
  • "CLT" → o cliente disse que tinha carteira assinada / registro / CTPS / "fichado".
  • "informal" → o cliente trabalhava como MOTORISTA DA EMPRESA de forma SUBORDINADA (tinha chefe/encarregado, cumpria escala/rota/ordens da empresa, dirigia caminhão DA EMPRESA ou exclusivo dela) MAS SEM carteira assinada — OU foi obrigado a abrir PJ/MEI para fazer o MESMO trabalho de empregado (pejotização). ISSO É RECONHECIMENTO DE VÍNCULO e QUALIFICA — é uma grande oportunidade. Sinais: "sem carteira", "sem registro", "não assinaram", "por fora", "no recibo", "me recontrataram sem carteira", "tive que abrir firma/MEI/PJ pra continuar", "era PJ mas trabalhava igual empregado". Na DÚVIDA entre informal e autônomo, para um motorista que rodava para UMA empresa, prefira "informal".
  • "autônomo" → AUTONOMIA REAL: dono do PRÓPRIO caminhão rodando para VÁRIOS embarcadores/clientes, sem subordinação a uma empresa; OU plataforma de app (ver gig economy abaixo). Só marque "autônomo" se ficar claro que ele era DONO do veículo e/ou rodava para vários clientes sem chefe. NÃO use "autônomo" só porque não tinha carteira.
  • "avulso" / "cooperado" → trabalhador avulso (sindicato/OGMO) ou cooperado de cooperativa.
  ⚠️ PERÍODO MISTO (parte com carteira, parte sem) NA MESMA EMPRESA — muito comum e NUNCA é motivo
  de descarte. Se o cliente disser que ficou um tempo sem registro e depois foi registrado (ou o
  contrário), marque vinculo: "CLT" e descreva o trecho sem registro em periodo_sem_registro. É um
  caso BOM: pede reconhecimento do período sem registro somado ao período anotado.
  Ex: "trabalhei numa firma de carteira assinada durante três meses e os outros 5 meses sem carteira"
  → vinculo: "CLT", tempo: "8 meses", periodo_sem_registro: "5 meses sem registro, 3 meses com carteira"
  Ex: "trabalhei um mês e dez dias antes de assinarem minha carteira"
  → vinculo: "CLT", periodo_sem_registro: "1 mês e 10 dias antes do registro"
  EXCEÇÃO OBRIGATÓRIA — GIG ECONOMY: Se a empresa for uma plataforma de aplicativo/gig economy (Uber, 99, Cabify, iFood, Rappi, Loggi, Lalamove, Shein Flex, Amazon Flex, Mottu, Shopper, Getninjas, TaskRabbit, ou qualquer outra plataforma onde o trabalhador usa o próprio veículo e recebe por corrida/entrega via app), marque OBRIGATORIAMENTE vinculo: "autônomo". Essas plataformas NUNCA geram vínculo CLT. Exceção: se o cliente disser literalmente "minha carteira foi assinada na Uber" ou equivalente muito explícito, honre o que disse.
- tempo: tempo total de trabalho lá — ⚠️ CRÍTICO: NÃO confunda com tempo DESDE A SAÍDA. "saí há 4 meses", "já tem 4 meses que saí", "faz 4 meses que saí" NÃO é tempo de serviço — é referência temporal de saída (use em data_saida e DEIXE tempo NULL se a duração do emprego não foi dita). Ex: "saí dessa empresa em fevereiro, já tem 4 meses" → tempo: null, data_saida calculada.
- data_saida: data de rescisão/demissão no formato MM/AAAA — CRÍTICO para prescrição. OBRIGATÓRIO calcular a partir de expressões relativas usando a DATA ATUAL acima. Exemplos: "há 60 dias" → subtraia 60 dias da data atual e formate MM/AAAA; "há 2 meses" → subtraia 2 meses; "saí há 3 meses" → subtraia 3 meses; "mês passado" → mês anterior ao atual; "ano passado" → MM/AAAA correspondente. Sempre calcule e preencha quando o cliente deu qualquer referência temporal de saída.
- saida: como e quando saiu (demitido, pediu demissão, ainda empregado, etc)
- horas_extras: horas extras além da jornada normal. Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- pagamento_fora: pagamentos fora do holerite (PIX, Pamcard, dinheiro). Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- injustica: irregularidades sofridas. Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- periodo_sem_registro: trecho do contrato trabalhado SEM carteira assinada, quando houve período
  misto na mesma empresa (texto livre, ex.: "os 5 primeiros meses sem registro"). DEIXE NULL se
  o cliente não mencionou período sem registro.
- frota: tamanho da frota da empresa (se mencionado)
- salario_holerite: número — valor NOMINAL registrado na carteira de trabalho/CTPS (o que aparecia formalmente no holerite como salário base), independentemente do que o cliente recebeu na prática. REGRA CRÍTICA: se o cliente diz "no holerite não recebia nada / era descontado da comissão" isso descreve o FUNCIONAMENTO do pagamento, não que o valor registrado era zero — capture o valor que ele informar como sendo o do holerite. Ex: "2000 na carteira" → 2000, "Era 2.970,00" (em resposta à pergunta sobre holerite) → 2970, "recebia 1.400 de registro" → 1400. DEIXE NULL apenas se o cliente não mencionou nenhum valor numérico para o salário registrado.
- salario_por_fora: número — valor recebido fora do holerite (PIX, Pamcard, dinheiro, comissão por frete) em R$ por mês. Se percentual sem valor mensal (ex: "12% do frete"), registre null. Ex: "8000 por fora" → 8000. DEIXE NULL se não mencionado.
- jornada_inicio: string "HH:MM" — hora de início da jornada. Converta horas informais: "das 5" → "05:00", "às 6h" → "06:00", "de manhã às 4" → "04:00". DEIXE NULL se não mencionado.
- jornada_fim: string "HH:MM" — hora de término da jornada. Converta: "até as 23" → "23:00", "até meia-noite" → "00:00", "até as 22h30" → "22:30". DEIXE NULL se não mencionado.
- intervalo_minutos: número inteiro — minutos de intervalo/almoço. Se não informado explicitamente, DEIXE NULL (não assuma 60min).
- jornada_descricao: descrição livre da jornada diária, horários e frequência de folgas — transcreva o que o cliente disse (ex: "saía às 5h da manhã, voltava às 23h, folga de domingo a domingo às vezes"). DEIXE NULL se não mencionado.

Responda APENAS JSON no formato:
{
  "sem_mais_empregos": false,
  "confirmou_mais_empregos": false,
  "correcao_empresa": null,
  "vinculos_atualizados": [
    { "ordem": 1, "empresa": "...", "funcao": null, ... }
  ],
  "novo_vinculo": null
}`,
    text: historiaTexto + "\n\nMensagem atual: " + text,
    personaLlmChave,
    // Modelos de raciocínio (deepseek-v4-flash) gastam parte do orçamento em reasoning_content;
    // 2048 estourava (finish_reason=length) em extrações pesadas (multi-vínculo, 15 campos) →
    // JSON truncado → JSON.parse falha. Folga maior garante o JSON completo após o reasoning.
    maxTokens: 4096,
  });

  // Negação curta e inequívoca à pergunta de mais_empregos. Modelos de raciocínio flaky às vezes
  // estouram o orçamento (JSON vazio/truncado) ou leem errado um "não, só a X" — então tratamos a
  // negação de forma determinística para não travar o fluxo. Guard contra falso-positivo: curto,
  // começa com negação e SEM sinal de que o lead está, na verdade, adicionando outro emprego.
  const tNeg = text.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const negacaoCurtaMaisEmpregos = maisEmpregosPerguntado
    && tNeg.length <= 40
    && /^(nao|nunca|nenhum|so |so a |so o |so essa|so esse|somente|apenas|foi so|trabalhei so|nada mais|mais nenhum)\b/.test(tNeg)
    && !/(tambem|alem|trabalhei (na|no|em|pra|para)|antes (disso|trabalhei)|outra empresa|\d{4})/.test(tNeg);

  if (!result) {
    if (negacaoCurtaMaisEmpregos) {
      console.warn(`[tryExtractVinculo] LLM null + negação curta → semMaisEmpregos=true (fallback determinístico)`);
      return { vinculo: null, semMaisEmpregos: true, updatedVinculos: vinculos, confirmouMaisEmpregos: false };
    }
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
          empresa:           existing.empresa           ?? limparEmpresaPlaceholder(upd.empresa),
          funcao:            existing.funcao            ?? (upd.funcao            ?? undefined),
          vinculo:           existing.vinculo           ?? (upd.vinculo           ?? undefined),
          periodo_sem_registro: existing.periodo_sem_registro ?? (upd.periodo_sem_registro ?? undefined),
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
          jornada_descricao: existing.jornada_descricao ?? (upd.jornada_descricao ?? undefined),
        };
      }
    }
  }

  // Correção de grafia: o merge acima nunca sobrescreve empresa (primeiro valor vence), então
  // um nome transcrito errado do áudio ficava para sempre e a versão digitada virava emprego novo.
  const corr = result.correcao_empresa;
  const empresaCorrigida = limparEmpresaPlaceholder(corr?.empresa);
  if (corr && empresaCorrigida && !maisEmpregosConfirmado) {
    const idx = updatedVinculos.findIndex((v) => v.ordem === corr.ordem);
    if (idx >= 0 && updatedVinculos[idx].empresa !== empresaCorrigida) {
      console.log(`[tryExtractVinculo] correção de empresa: "${updatedVinculos[idx].empresa}" → "${empresaCorrigida}"`);
      updatedVinculos[idx] = { ...updatedVinculos[idx], empresa: empresaCorrigida };
      if (result.novo_vinculo && limparEmpresaPlaceholder(result.novo_vinculo.empresa) === empresaCorrigida) {
        result.novo_vinculo = null;
      }
    }
  }

  const empresaNova = limparEmpresaPlaceholder(result.novo_vinculo?.empresa);
  if (result.novo_vinculo && empresaNova) {
    const novoVinculo: VinculoEmprego = {
      ordem: updatedVinculos.length + 1,
      empresa:           empresaNova,
      funcao:            result.novo_vinculo.funcao            ?? undefined,
      vinculo:           result.novo_vinculo.vinculo           ?? undefined,
      periodo_sem_registro: result.novo_vinculo.periodo_sem_registro ?? undefined,
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
      jornada_descricao: result.novo_vinculo.jornada_descricao ?? undefined,
    };
    // Preserve semMaisEmpregos alongside the new vinculo so both are handled together
    return { vinculo: novoVinculo, semMaisEmpregos: result.sem_mais_empregos === true, updatedVinculos, confirmouMaisEmpregos: false };
  }

  if (result.sem_mais_empregos) {
    return { vinculo: null, semMaisEmpregos: true, updatedVinculos, confirmouMaisEmpregos: false };
  }

  // LLM não marcou sem_mais_empregos, mas o lead deu negação curta inequívoca e não adicionou
  // vínculo novo → trata como negação (cobre leitura errada do modelo flaky). Caso Uber A3.
  if (negacaoCurtaMaisEmpregos && !empresaNova) {
    console.warn(`[tryExtractVinculo] override: negação curta com LLM sem_mais_empregos=false → true`);
    return { vinculo: null, semMaisEmpregos: true, updatedVinculos, confirmouMaisEmpregos: false };
  }

  return { vinculo: null, semMaisEmpregos: false, updatedVinculos, confirmouMaisEmpregos: result.confirmou_mais_empregos === true };
}

/**
 * Deriva data_saida "MM/AAAA" de padrões determinísticos (ano solto na saída,
 * intervalo de anos no tempo). Usa 12/ANO — a data mais favorável ao lead.
 * Retorna null quando ambíguo (ex: ano único no tempo = ano de início) ou ainda empregado.
 */
const MESES_PT: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

/** "fevereiro de 2026" / "março/2025" → "02/2026" / "03/2025". Null se não houver mês+ano. */
export function parseMesNomeAno(s: string | null | undefined): string | null {
  const norm = String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const m = norm.match(/\b(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b\s*(?:de|\/)?\s*((?:19|20)\d{2})/);
  if (!m) return null;
  return `${String(MESES_PT[m[1]]).padStart(2, "0")}/${m[2]}`;
}

export function deriveDataSaida(v: { data_saida?: string | null; saida?: string | null; tempo?: string | null }): string | null {
  const ds = (v.data_saida ?? "").trim();
  if (/^\d{2}\/\d{4}$/.test(ds)) return ds;
  if (/ainda|até hoje|ate hoje|atual|continuo|estou lá|estou la|trabalho lá|trabalho la/i.test(String(v.saida ?? ""))) return null;
  // Mês por extenso tem precedência sobre o fallback 12/ANO ("saí em fevereiro de 2026" → 02/2026).
  const porExtenso = parseMesNomeAno(ds) ?? parseMesNomeAno(v.saida);
  if (porExtenso) {
    const [, anoPE] = porExtenso.split("/").map(Number);
    if (anoPE >= 1980 && anoPE <= new Date().getFullYear()) return porExtenso;
  }
  const years = (s: string | null | undefined) => String(s ?? "").match(/\b(?:19|20)\d{2}\b/g) ?? [];
  let y: string | undefined = years(ds).at(-1) ?? years(v.saida).at(-1);
  if (!y) {
    // No tempo, ano único é início ("desde 2010") — só deriva de intervalo ("de 2019 a 2023").
    const ys = years(v.tempo);
    if (ys.length >= 2) y = ys.map(Number).sort((a, b) => a - b).at(-1)!.toString();
  }
  if (!y) return null;
  const yr = parseInt(y);
  const nowY = new Date().getFullYear();
  if (yr < 1980 || yr > nowY) return null;
  return `12/${yr}`;
}

/**
 * Deriva data_saida do TEXTO bruto do turno quando a extração perdeu a referência de ano
 * (ex.: flash converte "de 2019 a 2023" em tempo="4 anos"). Regras conservadoras:
 * intervalo de anos → último ano; ano único só com palavra de saída no texto e sem
 * indicação de vínculo atual ("desde", "ainda", "até hoje").
 */
export function deriveDataSaidaFromText(text: string | null | undefined): string | null {
  const t = String(text ?? "");
  if (!t) return null;
  if (/desde|ainda|até hoje|ate hoje|atual|trabalho lá|trabalho la|continuo/i.test(t)) return null;
  const SAIDA_RE = /sa[ií]|peguei as contas|pedi as contas|demitid|desped|mandaram embora|deslig|rescis|fui embora|larguei|abandonei o emprego/i;
  // Mês por extenso + palavra de saída → data exata ("saí em fevereiro de 2026" → 02/2026).
  const porExtenso = parseMesNomeAno(t);
  if (porExtenso && SAIDA_RE.test(t)) {
    const anoPE = Number(porExtenso.split("/")[1]);
    if (anoPE >= 1980 && anoPE <= new Date().getFullYear()) return porExtenso;
  }
  const anos = (t.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number);
  const nowY = new Date().getFullYear();
  const valid = anos.filter(y => y >= 1980 && y <= nowY);
  if (valid.length === 0) return null;
  const y = Math.max(...valid);
  if (valid.length >= 2) return `12/${y}`;
  if (SAIDA_RE.test(t)) return `12/${y}`;
  return null;
}

export async function askLlmVinculoPrazo(
  projetoId: string,
  vinculo: VinculoEmprego,
  personaLlmChave: string | null = null,
): Promise<boolean> {
  // Caminho determinístico: com data de saída conhecida (informada ou derivada),
  // calcula a prescrição direto, sem depender do julgamento do LLM.
  const derivada = deriveDataSaida(vinculo);
  if (derivada) {
    const [mm, yyyy] = derivada.split("/").map(Number);
    const agora = new Date();
    const mesesDesde = (agora.getFullYear() - yyyy) * 12 + (agora.getMonth() + 1 - mm);
    // ==24 fica dentro do prazo (mês tem granularidade grossa; em dúvida, favorece o lead).
    return mesesDesde <= 24;
  }
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
    personaLlmChave,
  });

  return result?.dentro_prazo !== false;
}

/** @deprecated Use askLlmVinculoPrazo */
export const checkVinculoPrazo = askLlmVinculoPrazo;

export async function askLlmPrescricao(
  projetoId: string,
  qualificacao: Record<string, unknown>,
  history: { direcao: string; conteudo: string | null }[],
  personaLlmChave: string | null = null,
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
    personaLlmChave,
  });

  return result?.prescricao ?? "pendente";
}

/** @deprecated Use askLlmPrescricao */
export const checkPrescricao = askLlmPrescricao;
