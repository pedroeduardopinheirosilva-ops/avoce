/**
 * Value Trigger — detecta quando o lead pergunta sobre valor da causa
 * e monta a injeção de cálculo no system prompt.
 * P4: Pergunta substantiva do lead tem precedência sobre o flow.
 */

import type { CalculoResultado } from "./calc-trabalhista.js";

// ──────────────────────────────────────────────────────────────────────────────
// Normalização
// ──────────────────────────────────────────────────────────────────────────────

function normalizar(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────────────
// isAskingValue
// ──────────────────────────────────────────────────────────────────────────────

const VALUE_PATTERNS: RegExp[] = [
  /quanto.*(receber|recuperar|ganhar|posso|tenho\s+direito)/,
  /(qual|quanto).*(valor|total|estimativa).*(causa|acao|processo)/,
  /(qual|quanto).*(estimativa|calculo)/,
  /vale\s+a\s+pena/,
  /da\s+(pra|para)\s+ganhar\s+quanto/,
  /quanto\s+(eu\s+)?vou\s+(receber|tirar|levar)/,
  /quanto\s+(eu\s+)?posso\s+receber/,
  /qual\s+o\s+valor\s+da\s+(minha\s+)?causa/,
  /tenho\s+direito\s+a\s+quanto/,
  /quanto\s+vale\s+(meu|minha|o meu|a minha)/,
  /(qual|quanto).*(total|valor).*(recup|ganhar|receber|tirar)/,
];

export function isAskingValue(message: string): boolean {
  const norm = normalizar(message);
  return VALUE_PATTERNS.some(p => p.test(norm));
}

// ──────────────────────────────────────────────────────────────────────────────
// buildValueResponseInjection
// ──────────────────────────────────────────────────────────────────────────────

const fmt = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

export function buildValueResponseInjection(
  calculo: CalculoResultado,
  faseAtual: "ana" | "advogado_valor" | "advogado_dados" | "advogado_documentos"
): string {
  const tesesComValor = calculo.por_tese
    .filter(t => t.valor_max > 0)
    .sort((a, b) => b.valor_max - a.valor_max);

  const listaTeses = tesesComValor.length > 0
    ? tesesComValor.map(t => `• ${t.tese}: ${fmt(t.valor_min)} a ${fmt(t.valor_max)}`).join("\n")
    : "• (dados insuficientes para detalhar por tese)";

  return (
    `=== TAREFA OBRIGATÓRIA ===\n` +
    `O cliente acabou de perguntar sobre o valor da causa. ` +
    `VOCÊ JÁ TEM O CÁLCULO CALCULADO ABAIXO. ` +
    `Sua tarefa é apresentar esse cálculo de forma natural, em linguagem de WhatsApp, ` +
    `NÃO INVENTE NÚMEROS DIFERENTES.\n\n` +
    `CÁLCULO PRONTO:\n` +
    `${calculo.resumo_textual_curto}\n\n` +
    `Faixa total: ${fmt(calculo.total_estimado_min)} a ${fmt(calculo.total_estimado_max)}\n` +
    `Teses por valor:\n${listaTeses}\n\n` +
    `INSTRUÇÕES DE APRESENTAÇÃO:\n` +
    `1. Use os números EXATOS acima — não arredonde, não invente, não estime de novo\n` +
    `2. Apresente em 3-4 frases curtas (WhatsApp, não e-mail)\n` +
    `3. Mencione 1-2 teses principais por nome (ex: "horas extras não pagas", "rescisão indireta")\n` +
    `4. Termine perguntando se faz sentido prosseguir (gancho para próxima fase)\n` +
    `5. NÃO peça documentos nesta resposta — isso vem depois\n` +
    `6. NÃO se reapresente — você já está em conversa\n` +
    `7. Mencione que é estimativa APENAS se perguntado, não preventivamente`
  );
}
