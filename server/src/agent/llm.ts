/**
 * LLM Router — multi-provider with ordered fallback.
 * Providers: anthropic | openai | groq | gemini
 * Config loaded per project from IaLlmProvedor table (ordered by `ordem`).
 * Falls back to next provider on quota/credit errors.
 *
 * SDK clients are cached by apiKey — one instance per key, never per call.
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import Groq from "groq-sdk";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../db.js";
import { fieldDecrypt } from "../lib/field-crypto.js";
import type { LlmMessage, LlmCallResult, ExtractJsonResult } from "./types.js";

// Re-export types so existing imports of LlmMessage from llm.ts keep working
export type { LlmMessage, LlmCallResult };

// ── SDK client cache (keyed by "provider:apiKey") ─────────────────────────────

type SdkClient = Anthropic | OpenAI | Groq | GoogleGenAI;
const _sdkClients = new Map<string, SdkClient>();

function getSdkClient(provider: ProviderConfig["provider"], apiKey: string): SdkClient {
  const key = `${provider}:${apiKey}`;
  if (!_sdkClients.has(key)) {
    let client: SdkClient;
    switch (provider) {
      case "anthropic": client = new Anthropic({ apiKey }); break;
      case "openai":    client = new OpenAI({ apiKey }); break;
      case "groq":      client = new Groq({ apiKey }); break;
      case "gemini":    client = new GoogleGenAI({ apiKey }); break;
      case "deepseek":  client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" }); break;
      default: throw new Error(`Provider desconhecido: ${provider}`);
    }
    _sdkClients.set(key, client);
  }
  return _sdkClients.get(key)!;
}

// ── Provider config ────────────────────────────────────────────────────────────

type ProviderConfig = {
  provider: "anthropic" | "openai" | "groq" | "gemini" | "deepseek";
  modelo: string;
  apiKey: string;
};

// Cache: cacheKey → { providers, ts }
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
    console.warn(`[LLM] getProviders DB error: ${err instanceof Error ? err.message : err}`);
  }

  if (!rows.length) {
    throw new Error(
      `Projeto ${projetoId} sem provedores LLM configurados em IaLlmProvedor. ` +
      `Acesse Config IA > Provedores e adicione pelo menos um provedor ativo.`
    );
  }

  // Persona-specific provider goes first; others serve as fallback.
  // personaProviderChave aceita override de modelo no formato "provider:modelo"
  // (ex.: "deepseek:deepseek-v4-flash") → permite modelo por persona sem mudar o schema.
  // Um valor simples ("deepseek") mantém o comportamento antigo.
  if (personaProviderChave) {
    const sep = personaProviderChave.indexOf(":");
    const provChave = sep >= 0 ? personaProviderChave.slice(0, sep) : personaProviderChave;
    const modeloOverride = sep >= 0 ? personaProviderChave.slice(sep + 1) : "";
    const personaRow = rows.find((r: any) => r.provider === provChave);
    if (personaRow) {
      const head = modeloOverride ? { ...personaRow, modelo: modeloOverride } : personaRow;
      rows = [head, ...rows.filter((r: any) => r !== personaRow)];
    }
  }

  const providers: ProviderConfig[] = rows.map((r: any) => ({
    provider: r.provider as ProviderConfig["provider"],
    modelo: r.modelo,
    apiKey: fieldDecrypt(r.apiKey),
  }));
  _provedorCache[cacheKey] = { providers, ts: Date.now() };
  return providers;
}

export function invalidateClientCache(projetoId: string): void {
  for (const key of Object.keys(_provedorCache)) {
    if (key.startsWith(projetoId)) delete _provedorCache[key];
  }
}

// ── Error classification ───────────────────────────────────────────────────────

function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  const status = (err as { status?: number })?.status;
  return (
    status === 429 || status === 402 || status === 503 ||
    msg.includes("credit") || msg.includes("quota") || msg.includes("rate limit") ||
    msg.includes("insufficient") || msg.includes("overloaded") ||
    msg.includes("unavailable") || msg.includes("high demand") || msg.includes("temporarily")
  );
}

// ── Provider dispatcher ────────────────────────────────────────────────────────

async function callProvider(
  cfg: ProviderConfig,
  systemPrompt: string,
  messages: LlmMessage[],
  maxTokens: number,
  jsonMode = false,
  // Desliga o modo de raciocínio quando o provider suporta. Usado SÓ no caminho de extração
  // (JSON estruturado), onde o reasoning é puro overhead de latência/custo sem ganho de qualidade.
  // A conversa (callLlm) mantém o thinking padrão. (deepseek-v4-flash: thinking + $0,28/M output.)
  disableThinking = false,
): Promise<{ content: string; tokensIn: number; tokensOut: number }> {
  const client = getSdkClient(cfg.provider, cfg.apiKey);

  if (cfg.provider === "anthropic") {
    const c = client as Anthropic;
    const res = await c.messages.create({
      model: cfg.modelo, max_tokens: maxTokens, system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    });
    const block = res.content?.[0];
    return { content: block?.type === "text" ? block.text : "", tokensIn: res.usage.input_tokens, tokensOut: res.usage.output_tokens };
  }

  if (cfg.provider === "openai" || cfg.provider === "deepseek") {
    const c = client as OpenAI;
    const res = await c.chat.completions.create({
      model: cfg.modelo, max_tokens: maxTokens,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      // deepseek-v4-flash: param oficial p/ desligar a cadeia de raciocínio (~6x mais rápido,
      // ~7x mais barato na extração). Ignorado por modelos OpenAI puros que não o reconhecem.
      ...(disableThinking && cfg.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
    } as any);
    return { content: res.choices[0]?.message?.content ?? "", tokensIn: res.usage?.prompt_tokens ?? 0, tokensOut: res.usage?.completion_tokens ?? 0 };
  }

  if (cfg.provider === "groq") {
    const c = client as Groq;
    const res = await c.chat.completions.create({
      model: cfg.modelo, max_tokens: maxTokens,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.content }))],
      ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
    });
    return { content: res.choices[0]?.message?.content ?? "", tokensIn: res.usage?.prompt_tokens ?? 0, tokensOut: res.usage?.completion_tokens ?? 0 };
  }

  if (cfg.provider === "gemini") {
    const c = client as GoogleGenAI;
    const res = await c.models.generateContent({
      model: cfg.modelo,
      contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      config: {
        systemInstruction: systemPrompt, maxOutputTokens: maxTokens,
        ...(jsonMode ? { responseMimeType: "application/json" } : {}),
        // gemini-2.5-flash pensa por padrão; na extração desligamos (thinkingBudget=0) → ~2x mais rápido.
        ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    });
    return { content: res.text ?? "", tokensIn: res.usageMetadata?.promptTokenCount ?? 0, tokensOut: res.usageMetadata?.candidatesTokenCount ?? 0 };
  }

  throw new Error(`Provider desconhecido: ${cfg.provider}`);
}

// ── Public: callLlm ────────────────────────────────────────────────────────────

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
    const MAX_RETRIES = 2;

    while (attempt <= MAX_RETRIES) {
      try {
        const { content, tokensIn, tokensOut } = await callProvider(cfg, systemPrompt, messages, maxTokens);
        const latencyMs = Date.now() - t0;
        prisma.iaInteracaoLog.create({
          data: { dealId, projetoId, personaChave, stageChave, llmUsado: `${cfg.provider}/${cfg.modelo}`, tokensEntrada: tokensIn, tokensSaida: tokensOut, latenciaMs: latencyMs },
        }).catch(() => {});
        return { content, tokensIn, tokensOut, latencyMs, model: cfg.modelo, provider: cfg.provider };
      } catch (err) {
        const latencyMs = Date.now() - t0;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (isQuotaError(err) && attempt < MAX_RETRIES) {
          const backoffMs = Math.pow(2, attempt) * 2000;
          console.warn(`[LLM] ${cfg.provider}/${cfg.modelo} transitório — retry em ${backoffMs}ms`);
          await new Promise(r => setTimeout(r, backoffMs));
          attempt++;
          continue;
        }
        console.warn(`[LLM] ${cfg.provider}/${cfg.modelo} falhou: ${errMsg}`);
        prisma.iaInteracaoLog.create({
          data: { dealId, projetoId, personaChave, stageChave, llmUsado: `${cfg.provider}/${cfg.modelo}`, latenciaMs: latencyMs, erro: errMsg },
        }).catch(() => {});
        lastErr = err;
        break;
      }
    }
  }

  throw lastErr ?? new Error("Todos os provedores LLM falharam");
}

// ── Public: extractJsonSafe (new — explicit error reporting) ───────────────────

const EXTRACT_SYSTEM = "You extract structured data from text. Always respond with valid JSON only, no markdown.";

export async function extractJsonSafe<T>(opts: {
  projetoId: string;
  instruction: string;
  text: string;
  maxTokens?: number;
  personaLlmChave?: string | null;
}): Promise<ExtractJsonResult<T>> {
  const { projetoId, instruction, text, maxTokens = 2048, personaLlmChave } = opts;
  let lastError = "Nenhum provedor disponível";

  try {
    const providers = await getProviders(projetoId, personaLlmChave);
    for (const cfg of providers) {
      try {
        const { content } = await callProvider(
          cfg, EXTRACT_SYSTEM,
          [{ role: "user", content: `${instruction}\n\nTexto:\n${text}\n\nResponda APENAS com JSON válido, sem markdown, sem explicações.` }],
          maxTokens,
          true,  // jsonMode
          true,  // disableThinking — extração não precisa de raciocínio (rápido + barato)
        );
        const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        try {
          const parsed = JSON.parse(cleaned) as T;
          console.log(`[extractJsonSafe] extração via ${cfg.provider}/${cfg.modelo}${personaLlmChave ? ` (persona=${personaLlmChave})` : ""}`);
          return { data: parsed, error: null };
        } catch {
          lastError = `JSON inválido (${cfg.provider}): "${cleaned.slice(0, 100)}"`;
          console.warn(`[extractJsonSafe] JSON.parse falhou (${cfg.provider}): "${cleaned.slice(0, 100)}"`);
          continue;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[extractJsonSafe] ${cfg.provider} erro: ${lastError}`);
        continue;
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  return { data: null, error: lastError };
}

// ── Public: extractJson (backward-compat — kept until callers migrated) ────────
// @deprecated Use extractJsonSafe for explicit error handling.

export async function extractJson<T>(opts: {
  projetoId: string;
  instruction: string;
  text: string;
  maxTokens?: number;
  personaLlmChave?: string | null;
}): Promise<T | null> {
  const result = await extractJsonSafe<T>(opts);
  return result.data;
}
