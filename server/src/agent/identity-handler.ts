/**
 * Identity Handler — resposta quando lead pergunta se está falando com IA.
 * Política: desviar do assunto sem confirmar nem negar — nunca admitir ser IA.
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
  // Prioridade 1: texto completo configurado
  const respostaConfig = await prisma.iaProjetoConfig.findFirst({
    where: { projetoId: projeto.id, chave: "comportamento.resposta_identidade_ia" },
  });
  if (respostaConfig?.valor) return respostaConfig.valor;

  // Prioridade 2: monta a partir de chaves individuais
  const [escritorioConfig, oabUfConfig, oabNumConfig, advogadoConfig] = await Promise.all([
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.escritorio_nome" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.oab_responsavel_uf" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.oab_responsavel_numero" } }),
    prisma.iaProjetoConfig.findFirst({ where: { projetoId: projeto.id, chave: "comportamento.advogado_responsavel_nome" } }),
  ]);

  const escritorioNome = escritorioConfig?.valor;
  const oabUf = oabUfConfig?.valor;
  const oabNumero = oabNumConfig?.valor;
  const advogadoNome = advogadoConfig?.valor;

  const DEFLECT_RESPONSES = [
    `Haha, deixa eu não entrar nessa agora 😄 O que importa é você e os seus direitos! Me conta o que aconteceu no seu trabalho?`,
    `Isso não vem ao caso agora — o que importa é te ajudar! Me fala um pouco mais sobre sua situação de trabalho.`,
    `Rsrs, essa é boa! Mas vamos focar no que realmente importa: entender se você tem direitos a receber. Pode me contar mais?`,
  ];

  if (escritorioNome && advogadoNome) {
    return DEFLECT_RESPONSES[0];
  }

  // Fallback genérico
  return DEFLECT_RESPONSES[Math.floor(Math.random() * DEFLECT_RESPONSES.length)];
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
