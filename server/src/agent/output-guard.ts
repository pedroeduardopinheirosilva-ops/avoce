/**
 * Output Guard — defesa em profundidade contra vazamento de instrução de prompt.
 * Última barreira antes de qualquer sendText ao cliente.
 */

import { prisma } from "../db.js";

export class PromptLeakError extends Error {
  constructor(
    public readonly reason: string,
    public readonly text: string,
    public readonly stepKey?: string
  ) {
    super(`[PROMPT_LEAK] ${reason}: "${text.slice(0, 80)}"`);
    this.name = "PromptLeakError";
  }
}

export interface SendableContext {
  text: string;
  currentStep?: { stepType: string; pergunta: string; chave: string } | null;
  persona: { chave: string; nomeExibicao: string };
  dealId: string;
  projetoId?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Normalização de texto para comparação
// ──────────────────────────────────────────────────────────────────────────────

function normalizar(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────────────
// Padrões de detecção
// ──────────────────────────────────────────────────────────────────────────────

const IMPERATIVOS_REGEX = /^(gere|crie|analise|elabore|produza|faca|escreva|redija|formule|desenvolva|construa)\s/i;

const META_INSTRUCAO_REGEX = /com base nos dados (reais )?coletados|cite as irregularidades|fundamente brevemente|maximo \d+ frases|de forma personalizada|personalize a resposta|seja conciso|nao exceda/i;

const PLACEHOLDER_REGEX = /\{[a-z_][a-z0-9_]*\}/;

const ROLE_MARKER_REGEX = /(system|user|assistant|tool):\s/i;

const COMMENT_REGEX = /^\/\/|^#\s|^<!--/m;

const QUEBRA_PERSONAGEM_REGEX = /como (uma? )?(ia|inteligencia artificial|modelo de linguagem|assistente de ia)|nao posso (gerar|criar|elaborar|fornecer)|(desculpe|sinto muito), nao consigo/i;

// Stopwords para cálculo de sobreposição de tokens
const STOPWORDS = new Set(["para", "com", "que", "uma", "dos", "das", "nos", "nas", "por", "ser", "ter"]);

function tokenize(text: string): Set<string> {
  const normalized = normalizar(text);
  const tokens = normalized.match(/[a-z]{3,}/g) ?? [];
  return new Set(tokens.filter(t => !STOPWORDS.has(t)));
}

function calcularSobreposicao(pergunta: string, resposta: string): number {
  const tokensPergunta = tokenize(pergunta);
  const tokensResposta = tokenize(resposta);
  if (tokensPergunta.size === 0) return 0;
  let interseção = 0;
  for (const t of tokensPergunta) {
    if (tokensResposta.has(t)) interseção++;
  }
  return interseção / tokensPergunta.size;
}

// ──────────────────────────────────────────────────────────────────────────────
// assertSendable — lança PromptLeakError no primeiro problema encontrado
// ──────────────────────────────────────────────────────────────────────────────

export function assertSendable(ctx: SendableContext): void {
  const { text, currentStep } = ctx;
  const stepKey = currentStep?.chave;
  const normalizado = normalizar(text);

  // 1a. Verbos imperativos no início
  if (IMPERATIVOS_REGEX.test(normalizado)) {
    throw new PromptLeakError("verbo_imperativo_inicio", text, stepKey);
  }

  // 1b. Frases de meta-instrução
  if (META_INSTRUCAO_REGEX.test(normalizado)) {
    throw new PromptLeakError("meta_instrucao", text, stepKey);
  }

  // 1c. Placeholders não substituídos
  if (PLACEHOLDER_REGEX.test(text)) {
    throw new PromptLeakError("placeholder_nao_substituido", text, stepKey);
  }

  // 1d. Marcadores de role
  if (ROLE_MARKER_REGEX.test(text)) {
    throw new PromptLeakError("role_marker", text, stepKey);
  }

  // 1e. Comentários de código/prompt
  if (COMMENT_REGEX.test(text)) {
    throw new PromptLeakError("comentario_prompt", text, stepKey);
  }

  // 2. Eco de step llm_generated
  if (
    currentStep?.stepType === "llm_generated" &&
    currentStep?.pergunta
  ) {
    const sobreposicao = calcularSobreposicao(currentStep.pergunta, text);
    if (sobreposicao >= 0.6) {
      throw new PromptLeakError("eco_step_llm_generated", text, stepKey);
    }
  }

  // 3. Quebra de personagem
  if (QUEBRA_PERSONAGEM_REGEX.test(normalizado)) {
    // Permitido em contexto de resposta de identidade pré-aprovada (texto curto, sem verbos de ação)
    const eRespostaIdentidade = text.length < 400 && /assistente virtual|triagem/i.test(text);
    if (!eRespostaIdentidade) {
      throw new PromptLeakError("quebra_personagem", text, stepKey);
    }
  }

  // 4. Sanidade básica
  const charsUteis = text.replace(/[\s.,!?]/g, "").length;
  if (charsUteis < 3) {
    throw new PromptLeakError("texto_vazio", text, stepKey);
  }
  if (text.length > 4000) {
    throw new PromptLeakError("texto_muito_longo", text, stepKey);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// handleBlockedSend — side-effects quando assertSendable lança
// ──────────────────────────────────────────────────────────────────────────────

export async function handleBlockedSend(
  error: PromptLeakError,
  ctx: SendableContext
): Promise<{ blocked: true; fallbackText?: string; notifyOperations: boolean }> {
  const { text, currentStep, dealId, projetoId } = ctx;
  const stepKey = currentStep?.chave;

  console.error(`[OutputGuard] BLOQUEADO — ${error.reason} | deal=${dealId} step=${stepKey ?? "?"}`);

  // a) Log em IaInteracaoLog
  try {
    await prisma.iaInteracaoLog.create({
      data: {
        dealId,
        projetoId: projetoId ?? null,
        erro: `prompt_leak_blocked:${error.reason}`,
      } as any,
    });
  } catch { /* non-critical */ }

  // b) Marca deal para intervenção humana
  try {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
    if (deal) {
      const qualAtual = (deal.qualificacao as Record<string, unknown>) ?? {};
      qualAtual._requer_intervencao_humana = true;
      qualAtual._motivo_intervencao = error.reason;
      qualAtual._bloqueado_em = new Date().toISOString();
      await prisma.crmDeal.update({
        where: { id: dealId },
        data: { qualificacao: qualAtual as any },
      });
    }
  } catch { /* non-critical */ }

  // c) Webhook de alerta (se configurado)
  if (projetoId) {
    try {
      const webhookConfig = await prisma.iaProjetoConfig.findFirst({
        where: { projetoId, chave: "comportamento.webhook_alertas_url" },
      });
      if (webhookConfig?.valor) {
        const { default: https } = await import("https");
        const { default: http } = await import("http");
        const payload = JSON.stringify({
          tipo: "prompt_leak",
          dealId,
          reason: error.reason,
          stepKey: stepKey ?? null,
          preview: text.slice(0, 200),
        });
        const url = new URL(webhookConfig.valor);
        const client = url.protocol === "https:" ? https : http;
        client.request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        }, () => {}).end(payload);
      }
    } catch { /* non-critical */ }
  }

  // d) Fallback — só envia se configurado E sem outro fallback recente no deal
  let fallbackText: string | undefined;
  if (projetoId) {
    try {
      const [fallbackAtivoConfig, fallbackMsgConfig] = await Promise.all([
        prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "comportamento.fallback_em_erro" } }),
        prisma.iaProjetoConfig.findFirst({ where: { projetoId, chave: "comportamento.mensagem_fallback_erro" } }),
      ]);

      if (fallbackAtivoConfig?.valor === "true" && fallbackMsgConfig?.valor) {
        // Checar cooldown de 60min por deal
        const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
        const qualAtual = (deal?.qualificacao as Record<string, unknown>) ?? {};
        const ultimoFallback = qualAtual._ultimo_fallback_em as string | undefined;
        const cooldownOk = !ultimoFallback || (Date.now() - new Date(ultimoFallback).getTime() > 60 * 60 * 1000);

        if (cooldownOk) {
          fallbackText = fallbackMsgConfig.valor;
          // Salva timestamp do fallback
          qualAtual._ultimo_fallback_em = new Date().toISOString();
          await prisma.crmDeal.update({
            where: { id: dealId },
            data: { qualificacao: qualAtual as any },
          }).catch(() => {});
        }
      }
    } catch { /* non-critical */ }
  }

  return { blocked: true, fallbackText, notifyOperations: true };
}
