/**
 * OCR Providers — raw I/O primitives.
 * Each function calls ONE external service and returns raw text or structured JSON.
 * No LLM calls. No business logic. No DB access.
 */

import Groq from "groq-sdk";
import type { DocJsonResult } from "./types.js";
import { validarCPF } from "./qualification-utils.js";

// ── Groq client (singleton keyed by apiKey) ────────────────────────────────────

const _groqClients = new Map<string, Groq>();
function getGroqClient(apiKey: string): Groq {
  if (!_groqClients.has(apiKey)) _groqClients.set(apiKey, new Groq({ apiKey }));
  return _groqClients.get(apiKey)!;
}

// ── Prompts ────────────────────────────────────────────────────────────────────

const OCR_EXTRACT_PROMPT =
  "PASSO 1 — Identifique o tipo do documento:\n" +
  "  A) CNH — texto 'CARTEIRA NACIONAL DE HABILITAÇÃO' ou 'CNH'\n" +
  "  B) RG — texto 'REGISTRO GERAL' ou cartão/cédula de identidade\n" +
  "  C) CTPS — texto 'CARTEIRA DE TRABALHO' ou 'CTPS'\n" +
  "  D) COMPROVANTE DE ENDEREÇO — conta de água, luz, gás, telefone, fatura bancária ou extrato com endereço\n" +
  "  E) OUTRO — boleto avulso, nota fiscal sem endereço do titular, contrato\n\n" +
  "PASSO 2 — Extraia APENAS os campos abaixo conforme o tipo:\n\n" +
  "SE TIPO A (CNH):\n" +
  "  Tipo: CNH\n" +
  "  Nome: (campo rotulado NOME)\n" +
  "  CPF: (campo rotulado CPF — 11 dígitos, formato XXX.XXX.XXX-XX)\n" +
  "  RG/IDENTIDADE: (campo rotulado 'Doc. Identidade', 'IDENTIDADE' ou 'RG' — DIFERENTE do Nº Registro)\n" +
  "  Órgão Emissor RG: (sigla ao lado do RG: SSP/BA, PC/MG, SSP/SP, SESPDC/BA — só se explícito)\n" +
  "  Data de Nascimento:\n" +
  "  Local de Nascimento: (se visível)\n" +
  "  ATENÇÃO: o 'Nº Registro' é da habilitação — NÃO é RG. Não confunda com IDENTIDADE.\n" +
  "SE TIPO B (RG físico):\n" +
  "  Tipo: RG\n  Nome:, RG:, Órgão Emissor:, CPF: (se visível), Data de Nascimento:\n\n" +
  "SE TIPO C (CTPS):\n" +
  "  Tipo: CTPS\n  Nome:, CPF:, PIS/NIS:, Série CTPS:, Número CTPS:\n\n" +
  "SE TIPO D (Comprovante de Endereço):\n" +
  "  Tipo: COMPROVANTE_ENDERECO\n" +
  "  Titular:, Endereço:, Bairro:, Cidade:, UF:, CEP:\n\n" +
  "SE TIPO E (outro):\n  Tipo: OUTRO\n\n" +
  "Retorne em formato de lista 'Campo: Valor', um por linha.\n" +
  "REGRA CRÍTICA: Omita completamente qualquer campo não encontrado — NUNCA use 'Não disponível', 'N/A', '?' ou equivalentes.\n" +
  "Nunca invente valores. Se CPF não estiver legível, simplesmente não inclua o campo CPF na resposta.";

// ── Mistral ────────────────────────────────────────────────────────────────────

export async function ocrMistral(
  apiKey: string,
  buffer: Buffer,
  mimetype: string,
): Promise<{ text: string | null; embeddedImages: { base64: string; mime: string }[] }> {
  const base64 = buffer.toString("base64");
  const isPdf = mimetype === "application/pdf";
  const documentPayload = isPdf
    ? { type: "document_url", document_url: `data:application/pdf;base64,${base64}` }
    : { type: "image_url",    image_url:    `data:${mimetype};base64,${base64}` };

  const res = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "mistral-ocr-latest", document: documentPayload, include_image_base64: true }),
  });
  if (!res.ok) throw new Error(`Mistral OCR ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);

  type MistralPage = { markdown?: string; images?: { id: string; image_base64?: string }[] };
  const json = (await res.json()) as { pages?: MistralPage[] };
  const text = (json.pages ?? []).map((p: MistralPage) => p.markdown ?? "").filter(Boolean).join("\n\n") || null;
  const embeddedImages: { base64: string; mime: string }[] = [];
  for (const page of json.pages ?? []) {
    for (const img of page.images ?? []) {
      if (img.image_base64) embeddedImages.push({ base64: img.image_base64, mime: "image/jpeg" });
    }
  }
  return { text, embeddedImages };
}

export async function ocrMistralCNHAnnotation(
  apiKey: string,
  buffer: Buffer,
  mimetype: string,
): Promise<DocJsonResult | null> {
  if (mimetype === "application/pdf") return null;
  const base64 = buffer.toString("base64");
  const res = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: { type: "image_url", image_url: `data:${mimetype};base64,${base64}` },
      document_annotation_format: {
        type: "json_schema",
        json_schema: {
          name: "document_fields",
          schema: { type: "object", properties: {
            nome: { type: ["string", "null"] }, cpf: { type: ["string", "null"] },
            rg: { type: ["string", "null"] }, orgao_expedidor: { type: ["string", "null"] },
            uf_rg: { type: ["string", "null"] }, data_nascimento: { type: ["string", "null"] },
            filiacao_pai: { type: ["string", "null"] }, filiacao_mae: { type: ["string", "null"] },
          }},
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Mistral Annotation ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const json = (await res.json()) as { document_annotation?: unknown };
  if (!json.document_annotation) return null;
  let data: Record<string, unknown>;
  try { data = typeof json.document_annotation === "string" ? JSON.parse(json.document_annotation) : json.document_annotation as Record<string, unknown>; }
  catch { return null; }

  let cpf = (data.cpf as string | undefined) ?? null;
  let rg  = (data.rg  as string | undefined) ?? null;
  if (cpf && !validarCPF(cpf)) {
    if (rg && validarCPF(rg)) { [cpf, rg] = [rg, cpf]; } else { cpf = null; }
  }
  if (cpf) { const d = cpf.replace(/\D/g, ""); if (d.length === 11) cpf = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`; }

  return {
    tipo_documento: "CNH", subtipo: "CNH_FOTO",
    nome: (data.nome as string | undefined) ?? null, cpf, rg,
    orgao_emissor_rg: (data.orgao_expedidor as string | undefined) ?? null,
    uf_emissor_rg: (data.uf_rg as string | undefined) ?? null,
    data_nascimento: (data.data_nascimento as string | undefined) ?? null,
    filiacao_pai: (data.filiacao_pai as string | undefined) ?? null,
    filiacao_mae: (data.filiacao_mae as string | undefined) ?? null,
    naturalidade: null, local_nascimento: null, pis: null, numero_ctps: null,
    serie_ctps: null, endereco: null, bairro: null, cidade: null, uf: null, cep: null,
  };
}

// ── Groq Vision ────────────────────────────────────────────────────────────────

/**
 * Modelo de visão da Groq. `meta-llama/llama-4-scout-17b-16e-instruct` foi DESCONTINUADO e
 * passou a devolver 404 model_not_found — 124 imagens de leads em 30 dias ficaram sem leitura
 * ("[Cliente enviou uma foto/imagem — leitura automática falhou]"). Os únicos modelos com
 * entrada de imagem na Groq hoje são qwen3.6-27b e qwen3.8-27b; usamos o mais barato.
 * Conferir com: GET https://api.groq.com/openai/v1/models → input_modalities inclui "image".
 *
 * Os qwen são modelos de RACIOCÍNIO: sem `reasoning_effort: "none"` o <think> consome o
 * orçamento de max_tokens e o content volta VAZIO — mesma armadilha do reasoner do DeepSeek
 * no classificador. Validado: com "none" a resposta sai limpa. Só "none" e "default" são aceitos.
 */
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL ?? "qwen/qwen3.6-27b";


export async function ocrGroqVision(apiKey: string, buffer: Buffer, mimetype: string): Promise<string | null> {
  const imgMime = ["image/jpeg","image/png","image/gif","image/webp"].includes(mimetype) ? mimetype : "image/jpeg";
  const client = getGroqClient(apiKey);
  const res = await client.chat.completions.create({
    model: GROQ_VISION_MODEL, max_tokens: 768, reasoning_effort: "none" as any,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:${imgMime};base64,${buffer.toString("base64")}` } } as any,
      { type: "text", text: OCR_EXTRACT_PROMPT },
    ]}],
  });
  const content = res.choices[0]?.message?.content ?? "";
  // Detect prompt-echo: model returned the instruction text instead of OCR output
  const ECHO_SIGNATURES = ["PASSO 1", "Passo 1", "Identifique o tipo", "## Passo", "##Passo"];
  if (ECHO_SIGNATURES.some(s => content.includes(s))) {
    console.warn("[OCR] ocrGroqVision: modelo ecoou o prompt — descartando resposta");
    return null;
  }
  return content || null;
}

export async function ocrGroqVisionJson(apiKey: string, buffer: Buffer, mimetype: string): Promise<DocJsonResult | null> {
  const imgMime = ["image/jpeg","image/png","image/gif","image/webp"].includes(mimetype) ? mimetype : "image/jpeg";
  const prompt = "Analise este documento brasileiro e retorne APENAS um JSON válido (sem markdown, sem texto extra).\n" +
    "Campos: tipo_documento (CNH|RG|CTPS|COMPROVANTE_ENDERECO|OUTRO), nome, cpf, rg, orgao_emissor_rg, " +
    "data_nascimento, naturalidade, pis, numero_ctps, serie_ctps, endereco, bairro, cidade, uf, cep.\n" +
    "REGRAS CRÍTICAS para CNH (incluindo CNH-e digital):\n" +
    "- O CPF fica logo abaixo do nome com rótulo 'CPF' e tem EXATAMENTE 11 dígitos (formato XXX.XXX.XXX-XX). Se o valor encontrado não tiver 11 dígitos após remover pontos e traços, retorne null para CPF.\n" +
    "- O 'Nº Registro' da CNH (geralmente 11 dígitos começando com número alto) NÃO é CPF nem RG — ignore completamente.\n" +
    "- O campo 'Doc. Identidade' / 'IDENTIDADE' / 'ID' na CNH é o RG — geralmente 7-9 dígitos.\n" +
    "- CPF e RG NUNCA têm o mesmo valor. Se estiverem iguais, retorne null para ambos.\n" +
    "- Na CNH-e digital, o CPF pode estar em fonte diferente do restante — procure especificamente o rótulo 'CPF:'.\n" +
    "- Use null para campos não encontrados ou ambíguos. JAMAIS invente valores.\n" +
    "Retorne SOMENTE JSON válido.";
  const client = getGroqClient(apiKey);
  const res = await client.chat.completions.create({
    model: GROQ_VISION_MODEL, max_tokens: 512, reasoning_effort: "none" as any,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:${imgMime};base64,${buffer.toString("base64")}` } } as any,
      { type: "text", text: prompt },
    ]}],
  });
  const raw = res.choices[0]?.message?.content ?? "";
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try { return JSON.parse(cleaned) as DocJsonResult; }
  catch { return null; }
}

// ── Claude Vision (Anthropic) — melhor extração de CPF/RG em FOTO de documento ──

const _anthropicClients = new Map<string, any>();
async function getAnthropicClient(apiKey: string): Promise<any> {
  if (!_anthropicClients.has(apiKey)) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  }
  return _anthropicClients.get(apiKey)!;
}

export async function ocrClaudeVisionJson(apiKey: string, buffer: Buffer, mimetype: string): Promise<DocJsonResult | null> {
  const imgMime = ["image/jpeg","image/png","image/gif","image/webp"].includes(mimetype) ? mimetype : "image/jpeg";
  const prompt = "Analise este documento brasileiro e retorne APENAS um JSON válido (sem markdown, sem texto extra).\n" +
    "Campos: tipo_documento (CNH|RG|CTPS|COMPROVANTE_ENDERECO|OUTRO), nome, cpf, rg, orgao_emissor_rg, " +
    "data_nascimento, naturalidade, pis, numero_ctps, serie_ctps, endereco, bairro, cidade, uf, cep.\n" +
    "REGRAS CRÍTICAS para CNH (incluindo CNH-e digital):\n" +
    "- O CPF fica logo abaixo do nome com rótulo 'CPF' e tem EXATAMENTE 11 dígitos (formato XXX.XXX.XXX-XX). Se não tiver 11 dígitos após remover pontos e traços, retorne null para CPF.\n" +
    "- O 'Nº Registro' da CNH NÃO é CPF nem RG — ignore.\n" +
    "- O campo 'Doc. Identidade' / 'IDENTIDADE' / 'ID' na CNH é o RG — geralmente 7-9 dígitos.\n" +
    "- CPF e RG NUNCA têm o mesmo valor. Se iguais, retorne null para ambos.\n" +
    "- Use null para campos não encontrados ou ambíguos. JAMAIS invente valores.\n" +
    "Retorne SOMENTE JSON válido.";
  try {
    const client = await getAnthropicClient(apiKey);
    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001", max_tokens: 512,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: imgMime, data: buffer.toString("base64") } },
        { type: "text", text: prompt },
      ]}],
    });
    const raw = (res.content?.[0]?.type === "text" ? res.content[0].text : "") ?? "";
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    return JSON.parse(cleaned) as DocJsonResult;
  } catch { return null; }
}

// ── Tesseract (subprocess fallback) ───────────────────────────────────────────

export async function ocrTesseract(buffer: Buffer, mimetype: string): Promise<string | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { writeFile, unlink, readFile } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const execFileAsync = promisify(execFile);
  const isPdf = mimetype === "application/pdf";
  const ts = Date.now();
  const tmpIn  = join(tmpdir(), `ocr-in-${ts}.${isPdf ? "pdf" : "jpg"}`);
  const tmpOut = join(tmpdir(), `ocr-out-${ts}`);
  try {
    await writeFile(tmpIn, buffer);
    await execFileAsync("tesseract", [tmpIn, tmpOut, "-l", "por+eng", "--oem", "1", "--psm", "3"], { timeout: 30000 });
    return (await readFile(`${tmpOut}.txt`, "utf8")).trim() || null;
  } catch (e: any) {
    if (String(e?.message).includes("Could not initialize tesseract") || String(e?.stderr).includes("por")) {
      try {
        await execFileAsync("tesseract", [tmpIn, tmpOut, "--oem", "1", "--psm", "3"], { timeout: 30000 });
        return (await readFile(`${tmpOut}.txt`, "utf8")).trim() || null;
      } catch { return null; }
    }
    throw e;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(`${tmpOut}.txt`).catch(() => {});
  }
}

// ── PDF → JPEG (subprocess) ────────────────────────────────────────────────────

export async function pdfPrimeiraPagemParaJpeg(buffer: Buffer): Promise<Buffer | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { writeFile, unlink, readFile, readdir } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const execFileAsync = promisify(execFile);
  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tmpIn  = join(tmpdir(), `pdf-in-${ts}.pdf`);
  const tmpOut = join(tmpdir(), `pdf-pg-${ts}`);
  try {
    await writeFile(tmpIn, buffer);
    await execFileAsync("pdftoppm", ["-jpeg", "-r", "300", "-f", "1", "-l", "1", tmpIn, tmpOut], { timeout: 30_000 });
    const files = (await readdir(tmpdir())).filter((f: string) => f.startsWith(`pdf-pg-${ts}-`) && f.endsWith(".jpg"));
    if (!files.length) return null;
    const img = await readFile(join(tmpdir(), files[0]));
    for (const f of files) unlink(join(tmpdir(), f)).catch(() => {});
    return img;
  } catch (e: any) {
    console.warn(`[OCR] pdftoppm falhou: ${e?.message}`);
    return null;
  } finally {
    unlink(tmpIn).catch(() => {});
  }
}
