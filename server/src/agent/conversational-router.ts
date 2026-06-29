/**
 * Conversational Router — A/B alternative to the strict sequential question router.
 *
 * In "conversacional" mode the LLM is given a list of missing fields and is free
 * to compose natural compound questions (e.g. empresa + funcao + CLT in one turn).
 * The deterministic override in stage-engine is disabled so the LLM phrasing is used.
 *
 * Toggle per project:
 *   IaProjetoConfig { categoria: "comportamento", chave: "modo_coleta", valor: "conversacional" }
 * Default (absent or any other value): "sequencial" — existing behavior, no change.
 */

import type { VinculoEmprego } from "./qualification.js";
import { getNextDeterministicQuestion } from "./persona-router.js";
import { getPersonaNomeExibicao } from "./transition-engine.js";

export type ConversationalResult = {
  systemSuffix: string;
  isDone: boolean;
};

export async function getConversationalSystemInstructions(
  projetoId: string,
  merged: Record<string, unknown>,
  vinculos: VinculoEmprego[],
  vinculosOk: boolean,
  vinculosTodosPrescritos: boolean,
  empresasBloqueadas: string[],
  outgoingCount: number,
): Promise<ConversationalResult> {
  // Delegate to deterministic router to know WHICH field is next.
  // We only change HOW the instruction is phrased (compound vs single).
  const nextQ = await getNextDeterministicQuestion(
    projetoId, merged, vinculos, vinculosOk, vinculosTodosPrescritos, empresasBloqueadas, outgoingCount,
  );

  if (!nextQ) {
    const advNome = await getPersonaNomeExibicao(projetoId, "advogado");
    return {
      systemSuffix:
        `⚠️ ENCERRAMENTO — Você coletou todas as informações. Sua próxima mensagem deve:\n` +
        `1. Agradecer brevemente pelo tempo\n` +
        `2. Informar que ${advNome} vai entrar em contato em instantes para dar o parecer jurídico do caso\n` +
        `MÁXIMO 2 frases. Não prometa ligação, não peça horário. Exemplo: "Ótimo! Registrei tudo aqui. ${advNome} vai te chamar agora mesmo com o parecer do seu caso."`,
      isDone: true,
    };
  }

  const lastV = vinculos.length > 0 ? vinculos[vinculos.length - 1] : null;
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

  // ── Group 1: nome + cidade (both missing → single compound question) ──────────
  const nomeOk = typeof merged.nome === "string" && merged.nome.trim().length > 1;
  if (!nomeOk && !merged.cidade) {
    return {
      systemSuffix: `⚠️ CAMPO OBRIGATÓRIO — Antes de qualquer outra coisa, combine numa única pergunta curta e natural: nome do cliente + cidade onde mora.\nExemplo: "Qual é o seu nome e de onde você é?"`,
      isDone: false,
    };
  }

  // ── Group 2: início de novo vínculo (empresa + funcao + tipo de contrato) ─────
  const isEmpresaQ = /qual.*empresa|em que empresa|empresa.*trabalhou|onde.*trabalhou/i.test(norm(nextQ));
  const startingNewCompany =
    (vinculos.length === 0 || merged._mais_empregos_confirmado === true) && !vinculosOk;

  if (isEmpresaQ && startingNewCompany) {
    const plural = vinculos.length > 0 ? "anterior" : "principal";
    return {
      systemSuffix:
        `⚠️ CAMPO OBRIGATÓRIO — Sua próxima mensagem DEVE combinar em 1-2 frases naturais (NÃO soe como formulário):\n` +
        `1. empresa (emprego ${plural})\n` +
        `2. função que exercia\n` +
        `3. tipo de contrato: CLT (carteira assinada) OU autônomo/agregado/TAC\n` +
        `Exemplo: "Me conta — em qual empresa você trabalhava? Qual era sua função e tinha carteira assinada?"`,
      isDone: false,
    };
  }

  // ── Group 3: saida + data de saída ────────────────────────────────────────────
  const isSaidaQ = /desligamento|quando.*sai|sai.*quando|foi demitido|pediu demiss/i.test(norm(nextQ));
  if (isSaidaQ && lastV?.empresa) {
    const emp = lastV.empresa;
    const isEmpregoAnterior = vinculos.length > 1; // more than one vinculo = this is a previous employer
    if (isEmpregoAnterior) {
      // Previous employer — person definitely already left. Never ask "still working there?"
      return {
        systemSuffix:
          `⚠️ CAMPO OBRIGATÓRIO — Este é um emprego ANTERIOR. A pessoa já saiu. NÃO pergunte se ainda trabalha lá.\n` +
          `Sua próxima mensagem DEVE perguntar, numa frase natural:\n` +
          `1. como foi o desligamento na ${emp}: foi demitido, pediu demissão ou saiu por condições intoleráveis (rescisão indireta)\n` +
          `2. mês e ano aproximado de saída\n` +
          `Exemplo: "Na ${emp}, foi demitido ou pediu demissão? E quando foi isso?"`,
        isDone: false,
      };
    }
    // Most recent employer — may still be working there
    return {
      systemSuffix:
        `⚠️ CAMPO OBRIGATÓRIO — Sua próxima mensagem DEVE combinar numa única pergunta natural:\n` +
        `1. se ainda trabalha na ${emp} ou já saiu; se saiu: foi demitido, pediu demissão ou rescisão indireta\n` +
        `2. se já saiu: mês e ano aproximado de saída\n` +
        `Exemplo: "Você ainda está na ${emp} ou já saiu? Se saiu — foi demitido ou pediu demissão? E quando foi isso?"`,
      isDone: false,
    };
  }

  // ── Special: mais_empregos — mandatory, LLM often skips this ─────────────────
  const isMaisEmpregosQ =
    /mais de uma empresa|outro lugar|trabalhou em outro|trabalhou antes|mais empregos|outro emprego/i.test(norm(nextQ));
  if (isMaisEmpregosQ) {
    const emp = lastV?.empresa ?? "essa empresa";
    const parseMesesTempo = (s: string): number => {
      let t = 0;
      const ma = s.match(/(\d+)\s*an/i); if (ma) t += parseInt(ma[1]) * 12;
      const mm = s.match(/(\d+)\s*m[eê]/i); if (mm) t += parseInt(mm[1]);
      return t;
    };
    const tempoMeses = lastV?.tempo ? parseMesesTempo(lastV.tempo) : 0;
    const contextoPrescricao = tempoMeses > 0 && tempoMeses < 24
      ? ` ATENÇÃO: o emprego na ${emp} durou apenas ${tempoMeses} meses — isso significa que o emprego ANTERIOR pode ainda estar dentro do prazo de 2 anos de prescrição trabalhista e DEVE ser investigado.`
      : "";
    return {
      systemSuffix:
        `⚠️ PERGUNTA OBRIGATÓRIA — Sua próxima mensagem DEVE perguntar se o cliente trabalhou em mais de uma empresa como carreteiro nos últimos 2 anos.${contextoPrescricao} ` +
        `NÃO assuma que só teve uma empresa, mesmo que ele tenha dito "por último". ` +
        `Exemplo: "Além da ${emp}, você trabalhou em alguma outra empresa como carreteiro nos últimos 2 anos?"`,
      isDone: false,
    };
  }

  // ── Special: pagamento_fora — frequently skipped in natural conversation ──────
  const isPagamentoForaQ =
    /fora do holerite|fora da folha|pamcard|pix.*pagamento|dinheiro.*vivo|valor fora/i.test(norm(nextQ));
  if (isPagamentoForaQ) {
    const emp = lastV?.empresa ?? "a empresa";
    return {
      systemSuffix:
        `⚠️ CAMPO OBRIGATÓRIO — Pergunte se o cliente recebia algum valor FORA DA FOLHA DE PAGAMENTO em ${emp} ` +
        `(Pamcard, Pix, dinheiro vivo, voucher). É uma informação importante para o caso. ` +
        `Exemplo: "Na ${emp}, você recebia algum valor fora da folha, tipo Pamcard, Pix ou dinheiro?"`,
      isDone: false,
    };
  }

  // ── Default: mandatory instruction (not a soft suggestion) ───────────────────
  return {
    systemSuffix:
      `⚠️ CAMPO OBRIGATÓRIO — Sua próxima mensagem DEVE perguntar, de forma natural e conversacional (não use essa frase literalmente): ${nextQ}\n` +
      `NÃO avance para outro assunto sem coletar essa informação primeiro.`,
    isDone: false,
  };
}
