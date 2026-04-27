/**
 * LLM Router — multi-provider with ordered fallback
 * Providers: anthropic | openai | groq | gemini
 * Config loaded per project from IaLlmProvedor table (ordered by `ordem`).
 * Falls back to next provider on quota/credit errors.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../db.js";

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCallResult {
  content: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  model: string;
  provider: string;
}

type ProviderConfig = {
  provider: "anthropic" | "openai" | "groq" | "gemini";
  modelo: string;
  apiKey: string;
};

// Cache: projetoId → { providers, ts }
const _provedorCache: Record<string, { providers: ProviderConfig[]; ts: number }> = {};
const CACHE_TTL = 5 * 60 * 1000;

async function getProviders(projetoId: string, personaProviderChave?: string | null): Promise<ProviderConfig[]> {
  const cacheKey = `${projetoId}:${personaProviderChave ?? ""}`;
  const cached = _provedorCache[cacheKey];
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.providers;

  let rows: any[] = [];
  try {
    rows = await prisma.iaLlmProvedor.findMany({
      where: { projetoId, ativo: true },
      orderBy: { ordem: "asc" },
    });
  } catch (err) {
    console.warn(`[LLM] getProviders DB error: ${err instanceof Error ? err.message : err} — tentando fallback legacy`);
  }

  // If persona has a specific provider, put it first (then others as fallback)
  if (personaProviderChave && rows.length > 0) {
    const personaRow = rows.find((r: any) => r.provider === personaProviderChave);
    if (personaRow) {
      const rest = rows.filter((r: any) => r.provider !== personaProviderChave);
      rows = [personaRow, ...rest];
    }
  }

  // Fallback to legacy anthropic_api_key in IaProjetoConfig if no IaLlmProvedor rows
  if (!rows.length) {
    const configs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, categoria: "llm" },
    });
    const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
    const apiKey = get("anthropic_api_key");
    const modelo = get("llm_model_principal") || "claude-haiku-4-5-20251001";
    if (apiKey) {
      const providers: ProviderConfig[] = [{ provider: "anthropic", modelo, apiKey }];
      _provedorCache[projetoId] = { providers, ts: Date.now() };
      return providers;
    }
    throw new Error("Projeto sem provedores LLM configurados");
  }

  const providers = rows.map((r: any) => ({
    provider: r.provider as ProviderConfig["provider"],
    modelo: r.modelo,
    apiKey: r.apiKey,
  }));

  _provedorCache[cacheKey] = { providers, ts: Date.now() };
  return providers;
}

export function invalidateClientCache(projetoId: string) {
  delete _provedorCache[projetoId];
}

// Detect quota/credit/transient errors that warrant trying next provider or retrying
function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const status = (err as { status?: number })?.status;
  return (
    status === 429 ||
    status === 402 ||
    status === 503 ||
    msg.includes("credit") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("insufficient") ||
    msg.includes("overloaded") ||
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("temporarily")
  );
}

async function callProvider(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: LlmMessage[],
  maxTokens: number
): Promise<{ content: string; tokensIn: number; tokensOut: number }> {
  if (cfg.provider === "anthropic") {
    const client = new Anthropic({ apiKey: cfg.apiKey });
    const res = await client.messages.create({
      model: cfg.modelo,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return {
      content: res.content[0].type === "text" ? res.content[0].text : "",
      tokensIn: res.usage.input_tokens,
      tokensOut: res.usage.output_tokens,
    };
  }

  if (cfg.provider === "openai") {
    const client = new OpenAI({ apiKey: cfg.apiKey });
    const res = await client.chat.completions.create({
      model: cfg.modelo,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    return {
      content: res.choices[0]?.message?.content ?? "",
      tokensIn: res.usage?.prompt_tokens ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    };
  }

  if (cfg.provider === "groq") {
    const client = new Groq({ apiKey: cfg.apiKey });
    const res = await client.chat.completions.create({
      model: cfg.modelo,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    return {
      content: res.choices[0]?.message?.content ?? "",
      tokensIn: res.usage?.prompt_tokens ?? 0,
      tokensOut: res.usage?.completion_tokens ?? 0,
    };
  }

  if (cfg.provider === "gemini") {
    const client = new GoogleGenAI({ apiKey: cfg.apiKey });
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const res = await client.models.generateContent({
      model: cfg.modelo,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: maxTokens,
      },
    });
    return {
      content: res.text ?? "",
      tokensIn: res.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: res.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }

  throw new Error(`Provider desconhecido: ${cfg.provider}`);
}

export async function callLlm(opts: {
  projetoId: string;
  dealId?: string;
  systemPrompt: string;
  messages: LlmMessage[];
  personaChave?: string;
  personaLlmChave?: string | null;
  stageChave?: string;
  maxTokens?: number;
}): Promise<LlmCallResult> {
  const { projetoId, dealId, systemPrompt, messages, personaChave, personaLlmChave, stageChave, maxTokens = 1024 } = opts;

  const providers = await getProviders(projetoId, personaLlmChave);
  let lastErr: unknown;

  for (const cfg of providers) {
    const t0 = Date.now();
    let attempt = 0;
    const MAX_RETRIES = 2; // retry same provider up to 2x for transient errors

    while (attempt <= MAX_RETRIES) {
      try {
        const { content, tokensIn, tokensOut } = await callProvider(cfg, systemPrompt, messages, maxTokens);
        const latencyMs = Date.now() - t0;

        prisma.iaInteracaoLog
          .create({
            data: {
              dealId,
              projetoId,
              personaChave,
              stageChave,
              llmUsado: `${cfg.provider}/${cfg.modelo}`,
              tokensEntrada: tokensIn,
              tokensSaida: tokensOut,
              latenciaMs: latencyMs,
            },
          })
          .catch(() => {});

        return { content, tokensIn, tokensOut, latencyMs, model: cfg.modelo, provider: cfg.provider };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        const errMsg = err instanceof Error ? err.message : String(err);

        if (isQuotaError(err) && attempt < MAX_RETRIES) {
          // Transient error — wait with exponential backoff and retry same provider
          const backoffMs = Math.pow(2, attempt) * 2000; // 2s, 4s
          console.warn(`[LLM] ${cfg.provider}/${cfg.modelo} transitório (tentativa ${attempt + 1}/${MAX_RETRIES + 1}) — retry em ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          attempt++;
          continue;
        }

        console.warn(`[LLM] ${cfg.provider}/${cfg.modelo} falhou: ${errMsg}`);

        prisma.iaInteracaoLog
          .create({
            data: {
              dealId,
              projetoId,
              personaChave,
              stageChave,
              llmUsado: `${cfg.provider}/${cfg.modelo}`,
              latenciaMs: latencyMs,
              erro: errMsg,
            },
          })
          .catch(() => {});

        lastErr = err;
        break; // always try next provider (quota, transient, or unexpected error)
      }
    }
  }

  throw lastErr ?? new Error("Todos os provedores LLM falharam");
}

/**
 * Extract structured JSON from text using the first available provider.
 */
export async function extractJson<T>(opts: {
  projetoId: string;
  instruction: string;
  text: string;
  maxTokens?: number;
}): Promise<T | null> {
  const { projetoId, instruction, text, maxTokens = 2048 } = opts;

  try {
    const providers = await getProviders(projetoId);
    for (const cfg of providers) {
      try {
        const { content } = await callProvider(
          cfg,
          "You extract structured data from text. Always respond with valid JSON only, no markdown.",
          [{ role: "user", content: `${instruction}\n\nTexto:\n${text}\n\nResponda APENAS com JSON válido, sem markdown, sem explicações.` }],
          maxTokens
        );
        // Strip markdown code fences if LLM wrapped the JSON (```json...```)
        const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        try {
          return JSON.parse(cleaned) as T;
        } catch {
          console.warn(`[extractJson] JSON.parse falhou (${cfg.provider}). Conteúdo bruto: "${cleaned.slice(0, 200)}"`);
          // Try next provider — this one returned truncated or malformed JSON
          continue;
        }
      } catch (err) {
        console.warn(`[extractJson] ${cfg.provider} erro: ${err instanceof Error ? err.message : String(err)}`);
        // Always try next provider on any error
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}
