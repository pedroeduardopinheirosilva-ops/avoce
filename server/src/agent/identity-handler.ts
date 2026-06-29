/**
 * Identity Handler — resposta quando lead pergunta se está falando com IA ou pede dados do escritório.
 * Política: manter a persona (atendente humana da equipe) + fornecer dados reais de legitimidade.
 * "Rsrs, isso não importa" = resposta de golpista. A correção é: endereçar a desconfiança com dados reais.
 */

import { prisma } from "../db.js";
import type { IaProjeto, IaPersona } from "@prisma/client";

// ──────────────────────────────────────────────────────────────────────────────
// Normalização
// ──────────────────────────────────────────────────────────────────────────────

function normalizar(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Padrões de detecção de pergunta de identidade
// ──────────────────────────────────────────────────────────────────────────────

const IDENTITY_PATTERNS: RegExp[] = [
  /(voce|vc|tu|ce)\s+(e|eh|es)\s+(uma?|um)?\s*(ia|robo|bot|inteligencia artificial|chatgpt|chat\s?gpt|claude|gemini|gpt)/,
  /(falando|conversando)\s+com\s+(uma?|um)\s*(ia|robo|bot|maquina|programa)/,
  /(e|eh)\s+(de\s+verdade|real|humana?|pessoa|gente)\??/,
  /isso\s+(e|eh)\s+(serio|real|verdade)\??/,
  /voce\s+nao\s+e\s+advogad[oa]/,
  /e\s+um\s+robo\??/,
  /ta\s+falando\s+com\s+um\s+robo/,
  /(estou|to)\s+falando\s+com\s+(uma\s+)?pessoa/,
  /vc\s+e\s+(ia|bot|robo|programa)/,
  /\b(ia|bot|robo)\b.*\?$/,
  /e\s+automatizado/,
  /sistema\s+automatico/,
  /\b(chatgpt|chat\s?gpt|claude|gemini|gpt)\b/,
  /\brobo\b/,                                   // qualquer menção a robô
  // Perguntas de legitimidade do escritório (suspeita de golpe)
  /(voces?|vcs?)\s+(tem|têm|possuem)\s+cnpj/,
  /onde\s+(fica|ficam|é|esta|e)\s+(o\s+)?(escritorio|escritório|advogad)/,
  /onde\s+(vcs?|voces?|voce)\s+ficam?/,       // "onde vcs ficam"
  /onde\s+ficam?\b/,                            // "onde ficam" genérico
  /quero\s+saber\s+onde/,                       // "quero saber onde vcs ficam"
  /(endereço|endereco)\s+d[oa]\s+(escritorio|escritório)/,
  /\bgolpe\b/,                                  // qualquer menção a golpe
  /\bgolpes?\b.*\bwhatsapp\b|\bwhatsapp\b.*\bgolpes?\b/,
  /n[aã]o\s+[eé]\s+golpe/,                     // "se não é golpe"
  /[eé]\s+golpe\??/,                            // "é golpe?"
  /ja\s+(fui|me)\s*(enganad|golpe|fraude)/,
  /cnpj.*escritorio|escritorio.*cnpj/,
  /cnpj\b/,                                     // qualquer pergunta com CNPJ
];

export function detectIdentityQuestion(message: string): boolean {
  const norm = normalizar(message);
  return IDENTITY_PATTERNS.some(p => p.test(norm));
}

// ──────────────────────────────────────────────────────────────────────────────
// Construção da resposta de identidade
// ──────────────────────────────────────────────────────────────────────────────

export async function buildIdentityResponse(
  projeto: { id: string },
  persona: { chave: string; nomeExibicao: string }
): Promise<string> {
  // Prioridade 1: texto completo configurado pelo operador ({nome} substituted with persona name)
  const respostaConfig = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId: projeto.id, chave: "comportamento.resposta_identidade_ia" },
  });
  if (respostaConfig?.valor) {
    return respostaConfig.valor.replace(/\{nome\}/g, persona.nomeExibicao);
  }

  // Prioridade 2: monta resposta transparente com dados do escritório
  const [escritorioConfig, cnpjConfig, cidadeConfig, advogadoConfig, oabUfConfig, oabNumConfig] = await Promise.all([
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.escritorio_nome" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.cnpj_escritorio" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.cidade_escritorio" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.advogado_responsavel_nome" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.oab_responsavel_uf" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.oab_responsavel_numero" } }),
  ]);

  const escritorioNome = escritorioConfig?.valor;
  const cnpj = cnpjConfig?.valor;
  const cidade = cidadeConfig?.valor;
  const advogadoNome = advogadoConfig?.valor;
  const oabUf = oabUfConfig?.valor;
  const oabNumero = oabNumConfig?.valor;

  // Abertura: persona humana da equipe, legitima a preocupação do lead
  const nomeEscritorio = escritorioNome || "nosso escritório de advocacia";
  let resp = `Sou a ${persona.nomeExibicao}, atendente da equipe d${nomeEscritorio.match(/^[aeiouáéíóúâêîôûãõ]/i) ? "a" : "o"} ${nomeEscritorio}! Sua preocupação é totalmente válida — golpes no WhatsApp são mesmo muito comuns.`;

  // Dados de legitimidade: incluir tudo que estiver configurado
  const infos: string[] = [];
  if (cnpj) infos.push(`CNPJ: ${cnpj}`);
  if (cidade) infos.push(`Localização: ${cidade}`);
  if (advogadoNome) {
    const oab = oabUf && oabNumero ? ` (OAB/${oabUf} ${oabNumero})` : "";
    infos.push(`Advogado responsável: ${advogadoNome}${oab}`);
  }

  if (infos.length > 0) {
    resp += `\n\n${infos.join("\n")}`;
    resp += `\n\nSeus dados ficam somente com a equipe jurídica. Podemos continuar?`;
  } else {
    // Sem configs: orientar a verificar e manter engajamento
    resp += ` O escritório é real e tem advogados registrados na OAB. Se quiser, posso passar o contato direto do advogado responsável ao final. Podemos continuar com suas informações?`;
  }

  return resp;
}

// ──────────────────────────────────────────────────────────────────────────────
// Registro de evento de identidade no banco
// ──────────────────────────────────────────────────────────────────────────────

export async function registrarEventoIdentidade(
  dealId: string,
  mensagemCliente: string,
  respostaEnviada: string
): Promise<void> {
  try {
    await (prisma as any).iaEventoIdentidade.create({
      data: { dealId, mensagemCliente, respostaEnviada },
    });
  } catch (err: any) {
    // Ignora se a tabela ainda não existe (migration pendente)
    if (err?.code !== "P2021") {
      console.error("[IdentityHandler] Erro ao registrar evento:", err?.message);
    }
  }
}
