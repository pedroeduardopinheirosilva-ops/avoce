/**
 * Stage Engine — 100% data-driven WhatsApp AI orchestrator
 * Zero hardcoded stage logic. Behavior comes entirely from DB tables.
 */

import { prisma } from "../db.js";
import { callLlm, extractJson } from "./llm.js";
import { isHumanized } from "./humanizer.js";
import { sendText, sendTyping, sendWhatsAppAudio, downloadMedia } from "../services/evolution.js";
import { transcribeAudio, downloadAudioFromEvolution } from "../services/whisper.js";
import { textToSpeech } from "../services/elevenlabs.js";
import { extractCNHData, type CNHExtractorResult } from "./cnh-extractor.js";
import Groq from "groq-sdk";

// ──────────────────────────────────────────────────────────────────────────────
// LLM failure retry queue
// When all providers are down, we schedule a retry so the client gets a response
// once the LLMs recover. Max 4 retries with exponential backoff (60s→120s→240s→480s).
// ──────────────────────────────────────────────────────────────────────────────
const _retryQueue = new Map<string, { timer: ReturnType<typeof setTimeout>; attempts: number }>();

export function scheduleLlmRetry(
  projetoId: string,
  dealId: string,
  phone: string,
  attempts = 1,
  delayMs = 60_000
): void {
  if (attempts > 4) {
    console.warn(`[RetryQueue] Deal ${dealId}: esgotadas ${attempts} tentativas — desistindo`);
    _retryQueue.delete(dealId);
    return;
  }
  const existing = _retryQueue.get(dealId);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(async () => {
    _retryQueue.delete(dealId);
    console.log(`[RetryQueue] Tentativa ${attempts} para deal ${dealId} (phone ${phone})`);
    try {
      await respondFromDealState(projetoId, dealId, phone);
    } catch (err: any) {
      console.warn(`[RetryQueue] Tentativa ${attempts} falhou: ${err?.message}`);
      scheduleLlmRetry(projetoId, dealId, phone, attempts + 1, Math.min(delayMs * 2, 480_000));
    }
  }, delayMs);

  _retryQueue.set(dealId, { timer, attempts });
  console.log(`[RetryQueue] Deal ${dealId}: retry em ${Math.round(delayMs / 1000)}s (tentativa ${attempts})`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Humanized delay — simulates reading + typing before sending
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Waits a human-like delay before sending, then sends with typing indicator.
 * readDelay:  time to "read" the last message (min 30s)
 * typingTime: time "typing" based on response length (~60 chars/s, min 2s max 8s)
 */
async function sendHumanized(
  evoConfig: EvolutionConfig,
  phone: string,
  text: string,
  readDelayMs = 0
): Promise<void> {
  // 1. Delay simulating reading the client's message
  if (readDelayMs > 0) {
    await new Promise(r => setTimeout(r, readDelayMs));
  }

  // 2. Send typing indicator
  const typingMs = Math.min(Math.max(Math.floor(text.length / 60) * 1000, 2000), 8000);
  try {
    await sendTyping(evoConfig, phone, typingMs);
  } catch {
    // typing indicator is best-effort
  }
  await new Promise(r => setTimeout(r, typingMs));

  // 3. Send the actual message
  await sendText(evoConfig, phone, text);
}

// ──────────────────────────────────────────────────────────────────────────────
// Response cleanup helpers
// ──────────────────────────────────────────────────────────────────────────────

const EMOJI_REGEX = /[\u{1F300}-\u{1FFFF}\u{2600}-\u{27FF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{231A}\u{231B}\u{25AA}-\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2702}\u{2705}\u{2708}-\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{2744}\u{2747}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2763}\u{2764}\u{2795}-\u{2797}\u{27A1}\u{27B0}\u{27BF}\u{2934}\u{2935}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{3030}\u{303D}\u{3297}\u{3299}]/gu;

/**
 * Remove persona name prefix (any form the LLM might output) and strip emojis.
 * Accepts: "*Ana*\n", "Ana\n", "Ana: ", "Ana " at the start of the text.
 */
function limparResposta(text: string, nomePersona: string): string {
  const escaped = nomePersona.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Strip: *Ana*\n | Ana\n | *Ana*: | Ana: | *Ana* | followed by space/newline at start
  const semPrefixo = text
    .replace(new RegExp(`^\\*?${escaped}\\*?[:\\s]\\s*`, ""), "")
    .trim();
  // Strip emojis
  return semPrefixo.replace(EMOJI_REGEX, "").replace(/\s{2,}/g, " ").trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Document / image OCR — multi-provider
// ──────────────────────────────────────────────────────────────────────────────

// Prompt para Groq Vision — leitura de documentos brasileiros com diferenciação de tipo.
// Suporta: CNH-e, RG físico, CTPS digital, comprovante de endereço, e rejeita outros.
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
  "  ATENÇÃO: CPF e RG/IDENTIDADE têm rótulos DIFERENTES no documento — leia o rótulo de cada um.\n\n" +

  "SE TIPO B (RG físico):\n" +
  "  Tipo: RG\n" +
  "  Nome:, RG:, Órgão Emissor:, CPF: (se visível), Data de Nascimento:\n\n" +

  "SE TIPO C (CTPS):\n" +
  "  Tipo: CTPS\n" +
  "  Nome:, CPF:, PIS/NIS:, Série CTPS:, Número CTPS:\n\n" +

  "SE TIPO D (Comprovante de Endereço):\n" +
  "  Tipo: COMPROVANTE_ENDERECO\n" +
  "  Titular: (nome na conta)\n" +
  "  Endereço: (logradouro completo)\n" +
  "  Bairro:, Cidade:, UF:, CEP: (se visível)\n" +
  "  Empresa emissora: (ex: EMBASA, COELBA, Vivo, Bradesco)\n\n" +

  "SE TIPO E (outro):\n" +
  "  Tipo: OUTRO\n\n" +

  "Retorne em formato de lista 'Campo: Valor', um por linha. " +
  "Transcreva exatamente como aparece. Omita campos não encontrados. Nunca invente valores.";

const STRUCT_PROMPT =
  "Com base no texto bruto extraído de um documento abaixo, identifique e liste as informações relevantes: " +
  "nome completo, CPF (11 dígitos no formato XXX.XXX.XXX-XX — campo rotulado CPF), " +
  "RG/IDENTIDADE (campo rotulado Doc. Identidade ou IDENTIDADE na CNH — NÃO o Nº Registro da habilitação), " +
  "órgão emissor do RG (sigla ao lado do RG, ex: SSP/BA, PC/MG — só se estiver explícito), " +
  "data de nascimento. Retorne em formato de lista (campo: valor). Omita campos não encontrados.";

// Validação matemática do CPF brasileiro (dígitos verificadores)
function validarCPF(cpf: string): boolean {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const calc = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += parseInt(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r >= 10 ? 0 : r;
  };
  return calc(9) === parseInt(d[9]) && calc(10) === parseInt(d[10]);
}

/** OCR via Mistral — handles both scanned PDFs and images natively.
 *  For PDFs with embedded images (e.g. CNH digital/gov.br), returns the images
 *  as base64 so the caller can do a second Vision pass. */
async function ocrMistral(
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
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: documentPayload,
      include_image_base64: true,   // request embedded image data
    }),
  });

  if (!res.ok) throw new Error(`Mistral OCR ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    pages?: {
      markdown?: string;
      images?: { id: string; image_base64?: string }[];
    }[];
  };

  const text = json.pages?.map((p) => p.markdown ?? "").join("\n\n").trim() ?? null;

  // Collect embedded images returned by Mistral
  const embeddedImages: { base64: string; mime: string }[] = [];
  for (const page of json.pages ?? []) {
    for (const img of page.images ?? []) {
      if (img.image_base64) {
        // id is like "img-0.jpeg" — derive mime from extension
        const ext = img.id.split(".").pop()?.toLowerCase() ?? "jpeg";
        const mime = ext === "png" ? "image/png" : "image/jpeg";
        embeddedImages.push({ base64: img.image_base64, mime });
      }
    }
  }

  return { text: text?.length ? text : null, embeddedImages };
}

/**
 * Mistral OCR com document_annotation — extração estruturada de CNH a partir de fotos.
 * Usa o parâmetro document_annotation_format + prompt para retornar JSON direto.
 * Ideal para fotos de CNH física enviadas via WhatsApp (imagens JPEG/PNG/WEBP).
 */
const CNH_ANNOTATION_SCHEMA = {
  type: "json_schema",
  json_schema: {
    name: "cnh_data",
    schema: {
      type: "object",
      properties: {
        nome:               { type: "string",           description: "Nome completo do titular da CNH" },
        cpf:                { type: "string",           description: "CPF com pontuação (000.000.000-00)" },
        rg:                 { type: "string",           description: "Número do RG (só dígitos)" },
        orgao_expedidor:    { type: "string",           description: "Órgão expedidor do RG (ex: SSP)" },
        uf_rg:              { type: "string",           description: "UF do órgão expedidor (ex: BA)" },
        data_nascimento:    { type: "string",           description: "Data de nascimento DD/MM/AAAA" },
        filiacao_pai:       { type: ["string", "null"], description: "Nome do pai" },
        filiacao_mae:       { type: ["string", "null"], description: "Nome da mãe" },
        categoria:          { type: "string",           description: "Categoria habilitação (A, B, AB...)" },
        numero_registro:    { type: "string",           description: "Número de registro da CNH (11 dígitos)" },
        validade:           { type: "string",           description: "Validade da CNH DD/MM/AAAA" },
        primeira_habilitacao: { type: "string",         description: "Primeira habilitação DD/MM/AAAA" },
        local_emissao:      { type: "string",           description: "Local de emissão (Cidade, UF)" },
        data_emissao:       { type: "string",           description: "Data de emissão DD/MM/AAAA" },
      },
      required: ["nome", "cpf", "rg", "orgao_expedidor", "uf_rg", "data_nascimento"],
    },
  },
};

const CNH_ANNOTATION_PROMPT =
  "Extraia todos os dados pessoais visíveis nesta CNH (Carteira Nacional de Habilitação) brasileira. " +
  "CPF deve incluir pontuação (000.000.000-00). Datas no formato DD/MM/AAAA. " +
  "Preserve acentuação nos nomes. Se um campo não for legível, retorne null.";

async function ocrMistralCNHAnnotation(
  apiKey: string,
  buffer: Buffer,
  mimetype: string,
): Promise<DocJsonResult | null> {
  const base64 = buffer.toString("base64");
  const isPdf = mimetype === "application/pdf";

  const documentPayload = isPdf
    ? { type: "document_url", document_url: `data:application/pdf;base64,${base64}` }
    : { type: "image_url",    image_url:    `data:${mimetype};base64,${base64}` };

  const res = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: documentPayload,
      document_annotation_format: CNH_ANNOTATION_SCHEMA,
      document_annotation_prompt: CNH_ANNOTATION_PROMPT,
      include_image_base64: false,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn(`[Mistral CNH Annotation] ${res.status}: ${errText}`);
    return null;
  }

  const json = (await res.json()) as { document_annotation?: unknown };
  const annotation = json.document_annotation;
  if (!annotation) {
    console.warn("[Mistral CNH Annotation] document_annotation não retornado");
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = typeof annotation === "string" ? JSON.parse(annotation) : annotation as Record<string, unknown>;
  } catch {
    console.warn("[Mistral CNH Annotation] JSON.parse falhou");
    return null;
  }

  console.log(`[Mistral CNH Annotation] OK: nome=${data.nome} cpf=${data.cpf} rg=${data.rg}`);

  // Mapear para DocJsonResult — validar CPF matematicamente
  let cpf = (data.cpf as string | undefined) ?? null;
  let rg  = (data.rg  as string | undefined) ?? null;

  if (cpf && !validarCPF(cpf)) {
    console.warn(`[Mistral CNH Annotation] CPF inválido (${cpf}) — ${rg && validarCPF(rg) ? "invertendo" : "descartando"}`);
    if (rg && validarCPF(rg)) {
      [cpf, rg] = [rg, cpf];
    } else {
      cpf = null;
    }
  }
  if (cpf) {
    const d = cpf.replace(/\D/g, "");
    if (d.length === 11) cpf = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
  }

  return {
    tipo_documento:   "CNH",
    subtipo:          "CNH_FOTO",
    nome:             (data.nome             as string | undefined) ?? null,
    cpf,
    rg,
    orgao_emissor_rg: (data.orgao_expedidor  as string | undefined) ?? null,
    uf_emissor_rg:    (data.uf_rg            as string | undefined) ?? null,
    data_nascimento:  (data.data_nascimento   as string | undefined) ?? null,
    filiacao_pai:     (data.filiacao_pai     as string | undefined) ?? null,
    filiacao_mae:     (data.filiacao_mae     as string | undefined) ?? null,
    naturalidade: null, local_nascimento: null,
    pis: null, numero_ctps: null, serie_ctps: null,
    endereco: null, bairro: null, cidade: null, uf: null, cep: null,
  };
}

/**
 * Convert first page of a PDF to JPEG using pdftoppm (poppler).
 * Returns the JPEG buffer, or null if pdftoppm is unavailable.
 */
async function pdfPrimeiraPagemParaJpeg(buffer: Buffer): Promise<Buffer | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { writeFile, unlink, readFile } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const { readdir } = await import("fs/promises");
  const execFileAsync = promisify(execFile);

  const ts = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const tmpIn  = join(tmpdir(), `pdf-in-${ts}.pdf`);
  const tmpOut = join(tmpdir(), `pdf-pg-${ts}`); // pdftoppm adds -1.jpg suffix

  try {
    await writeFile(tmpIn, buffer);
    // -r 300: 300dpi — alta resolução para leitura de campos pequenos (CPF, RG).
    // -f 1 -l 1: só primeira página.
    await execFileAsync(
      "pdftoppm",
      ["-jpeg", "-r", "300", "-f", "1", "-l", "1", tmpIn, tmpOut],
      { timeout: 30_000 },
    );
    // pdftoppm cria arquivos como pdf-pg-{ts}-1.jpg ou pdf-pg-{ts}-01.jpg
    const dir = tmpdir();
    const prefix = `pdf-pg-${ts}-`;
    const files = (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".jpg"));
    if (!files.length) return null;
    const img = await readFile(join(dir, files[0]));
    // Limpar arquivos temporários
    for (const f of files) unlink(join(dir, f)).catch(() => {});
    return img;
  } catch (e: any) {
    console.warn(`[DocExtract] pdftoppm falhou: ${e?.message}`);
    return null;
  } finally {
    unlink(tmpIn).catch(() => {});
  }
}

/** OCR via Groq Vision (Llama 4 Scout) — returns free text (used as fallback) */
async function ocrGroqVision(apiKey: string, buffer: Buffer, mimetype: string): Promise<string | null> {
  const imgMime = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimetype)
    ? mimetype : "image/jpeg";
  const base64Url = `data:${imgMime};base64,${buffer.toString("base64")}`;

  const client = new Groq({ apiKey });
  const res = await client.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    max_tokens: 768,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: base64Url } } as any,
      { type: "text", text: OCR_EXTRACT_PROMPT },
    ]}],
  });
  return res.choices[0]?.message?.content ?? null;
}

type DocJsonResult = {
  tipo_documento: "CNH" | "RG" | "CTPS" | "COMPROVANTE_ENDERECO" | "OUTRO";
  /** CNH_E = PDF digital Gov.br com imagens embarcadas; CNH_FOTO = foto de CNH física */
  subtipo?: "CNH_E" | "CNH_FOTO" | null;
  nome?: string | null;
  cpf?: string | null;
  rg?: string | null;
  orgao_emissor_rg?: string | null;
  uf_emissor_rg?: string | null;
  data_nascimento?: string | null;
  local_nascimento?: string | null;
  naturalidade?: string | null;
  filiacao_pai?: string | null;
  filiacao_mae?: string | null;
  pis?: string | null;
  numero_ctps?: string | null;
  serie_ctps?: string | null;
  endereco?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
};

/**
 * Groq Vision — retorna JSON estruturado diretamente a partir da imagem.
 * Elimina o passo intermediário de texto livre → extractJson,
 * que perdia a associação entre rótulo e valor.
 */
async function ocrGroqVisionJson(apiKey: string, buffer: Buffer, mimetype: string): Promise<DocJsonResult | null> {
  const imgMime = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimetype)
    ? mimetype : "image/jpeg";
  const base64Url = `data:${imgMime};base64,${buffer.toString("base64")}`;

  const prompt =
    "Analise este documento brasileiro e retorne APENAS um JSON válido (sem markdown, sem explicações).\n\n" +

    "PASSO 1 — Identifique o tipo:\n" +
    "  'CNH' → contém 'CARTEIRA NACIONAL DE HABILITAÇÃO' ou 'CNH'\n" +
    "  'RG'  → cédula de identidade, 'REGISTRO GERAL'\n" +
    "  'CTPS' → 'CARTEIRA DE TRABALHO' ou 'CTPS'\n" +
    "  'COMPROVANTE_ENDERECO' → conta de água, luz, gás, telefone ou fatura com endereço residencial\n" +
    "  'OUTRO' → qualquer outro (boleto, nota fiscal, contrato)\n\n" +

    "PASSO 2 — Para CNH ou RG, leia os campos PELO SEU RÓTULO VISUAL no documento:\n" +
    "  'cpf'              → número do campo rotulado literalmente 'CPF' (formato XXX.XXX.XXX-XX, sempre 11 dígitos)\n" +
    "  'rg'               → número do campo rotulado 'Doc. Identidade', 'IDENTIDADE' ou 'RG'\n" +
    "                       ATENÇÃO: o campo 'Nº Registro' ou 'Registro nº' é o registro de HABILITAÇÃO — NÃO é o rg\n" +
    "  'orgao_emissor_rg' → sigla do órgão emissor do RG, que aparece AO LADO do campo rg (ex: SSP/BA, PC/MG, SSP/SP)\n" +
    "                       Se não aparecer explicitamente ao lado do RG, deixe null\n" +
    "  'nome'             → campo rotulado 'NOME' ou 'Nome'\n" +
    "  'data_nascimento'  → campo data de nascimento (DD/MM/AAAA)\n" +
    "  'naturalidade'     → local de nascimento\n\n" +

    "REGRAS CRÍTICAS:\n" +
    "  - CPF e RG/IDENTIDADE são campos DIFERENTES com rótulos diferentes — nunca coloque o mesmo valor nos dois\n" +
    "  - Se não encontrar o rótulo 'CPF' explicitamente, coloque null em 'cpf'\n" +
    "  - Se não encontrar o rótulo 'IDENTIDADE'/'Doc. Identidade'/'RG', coloque null em 'rg'\n" +
    "  - Nunca invente valores — null se não encontrado\n\n" +

    "PASSO 3 — Para CTPS: preencha nome, cpf, pis, numero_ctps, serie_ctps\n" +
    "PASSO 4 — Para COMPROVANTE_ENDERECO: preencha nome (titular), endereco, bairro, cidade, uf, cep\n" +
    "PASSO 5 — Para OUTRO: apenas tipo_documento='OUTRO', demais campos null\n\n" +

    "Retorne SOMENTE o JSON, sem texto antes ou depois:\n" +
    "{ \"tipo_documento\": \"...\", \"nome\": null, \"cpf\": null, \"rg\": null, \"orgao_emissor_rg\": null, " +
    "\"data_nascimento\": null, \"naturalidade\": null, \"pis\": null, \"numero_ctps\": null, \"serie_ctps\": null, " +
    "\"endereco\": null, \"bairro\": null, \"cidade\": null, \"uf\": null, \"cep\": null }";

  const client = new Groq({ apiKey });
  const res = await client.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    max_tokens: 512,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: base64Url } } as any,
      { type: "text", text: prompt },
    ]}],
  });

  const raw = res.choices[0]?.message?.content ?? "";
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as DocJsonResult;
  } catch {
    console.warn(`[DocExtract] ocrGroqVisionJson parse falhou. Raw: "${cleaned.slice(0, 200)}"`);
    return null;
  }
}

/** OCR via Tesseract (local — requires tesseract-ocr installed on server) */
async function ocrTesseract(buffer: Buffer, mimetype: string): Promise<string | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const { writeFile, unlink, readFile } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const execFileAsync = promisify(execFile);

  const isPdf = mimetype === "application/pdf";
  const ext = isPdf ? "pdf" : "jpg";
  const ts = Date.now();
  const tmpIn  = join(tmpdir(), `ocr-in-${ts}.${ext}`);
  const tmpOut = join(tmpdir(), `ocr-out-${ts}`);

  try {
    await writeFile(tmpIn, buffer);
    // -l por+eng: Portuguese + English; --oem 1: LSTM neural net
    await execFileAsync("tesseract", [tmpIn, tmpOut, "-l", "por+eng", "--oem", "1", "--psm", "3"], { timeout: 30000 });
    const text = await readFile(`${tmpOut}.txt`, "utf8");
    return text.trim() || null;
  } catch (e: any) {
    // Try without language pack if por not installed
    if (String(e?.message).includes("Could not initialize tesseract") || String(e?.stderr).includes("por")) {
      try {
        await execFileAsync("tesseract", [tmpIn, tmpOut, "--oem", "1", "--psm", "3"], { timeout: 30000 });
        const text = await readFile(`${tmpOut}.txt`, "utf8");
        return text.trim() || null;
      } catch { /* ignore */ }
    }
    throw e;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(`${tmpOut}.txt`).catch(() => {});
  }
}


/**
 * Extrai campos estruturados de um documento brasileiro.
 *
 * Estratégia híbrida:
 *   PDFs (CNH-e, CTPS digital):
 *     A. Mistral OCR → texto → regex CPF (matematicamente validado = sem confusão possível)
 *                             → regex RG/órgão/nome
 *     PDFs: Python multi-strategy (pdfimages + MRZ + Tesseract + Claude Vision opcional)
 *     Fallback PDFs: pdftoppm → Groq Vision (texto livre + JSON) com validação matemática de CPF
 *
 *   Imagens (foto CNH física, RG, comprovante):
 *     Groq Vision JSON direto — marcada como CNH_FOTO
 */
async function extractDocumentJson(
  opts: { groqKey: string; mistralKey: string; anthropicKey?: string },
  buffer: Buffer,
  mimetype: string,
): Promise<DocJsonResult | null> {
  const { groqKey, mistralKey, anthropicKey } = opts;
  const isPdf = mimetype === "application/pdf";

  if (isPdf) {
    // ── Estratégia primária: Python extractor (pdfimages + MRZ + Tesseract) ──
    // Funciona apenas em PDFs CNH-e que contêm imagens JPEG embarcadas.
    // Lança ValueError para PDFs sem imagens suficientes (boletos, contratos, etc).
    try {
      const pyResult: CNHExtractorResult = await extractCNHData(buffer, anthropicKey || undefined);
      const hasDados = pyResult.nome || pyResult.cpf || pyResult.rg;
      if (hasDados) {
        // Validar/corrigir CPF com mesma lógica da função validarCPF
        let cpfFinal = pyResult.cpf ?? null;
        let rgFinal  = pyResult.rg ?? null;
        if (cpfFinal && !validarCPF(cpfFinal)) {
          console.warn(`[DocExtract] Python CPF inválido (${cpfFinal}) — ${rgFinal && validarCPF(rgFinal) ? "invertendo com RG" : "descartando"}`);
          if (rgFinal && validarCPF(rgFinal)) {
            [cpfFinal, rgFinal] = [rgFinal, cpfFinal];
          } else {
            cpfFinal = null;
          }
        }
        // Formatar CPF se veio sem máscara
        if (cpfFinal) {
          const d = cpfFinal.replace(/\D/g, "");
          if (d.length === 11) cpfFinal = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
        }

        const resultado: DocJsonResult = {
          tipo_documento:   "CNH",
          subtipo:          "CNH_E",
          nome:             pyResult.nome ?? null,
          cpf:              cpfFinal,
          rg:               rgFinal,
          orgao_emissor_rg: pyResult.orgao_emissor_rg ?? null,
          uf_emissor_rg:    pyResult.uf_emissor_rg ?? null,
          data_nascimento:  pyResult.data_nascimento ?? null,
          local_nascimento: pyResult.local_nascimento ?? null,
          naturalidade:     pyResult.nacionalidade ?? null,
          filiacao_pai:     pyResult.filiacao_pai ?? null,
          filiacao_mae:     pyResult.filiacao_mae ?? null,
          pis: null, numero_ctps: null, serie_ctps: null,
          endereco: null, bairro: null, cidade: null, uf: null, cep: null,
        };
        console.log(`[DocExtract] Python CNH-e OK: tipo=${resultado.tipo_documento} subtipo=CNH_E cpf=${resultado.cpf} rg=${resultado.rg} orgao=${resultado.orgao_emissor_rg} nome=${resultado.nome}`);
        return resultado;
      }
      console.warn("[DocExtract] Python extractor retornou sem dados — usando fallback Vision");
    } catch (pyErr: any) {
      // ValueError = não é CNH-e; outros erros = falha técnica
      const isNotCnhe = pyErr?.message?.includes("não contém imagens") || pyErr?.message?.includes("suficiente");
      console.warn(`[DocExtract] Python extractor falhou (${isNotCnhe ? "não é CNH-e" : pyErr?.message}) — fallback Vision`);
    }

    // ── Fallback: pdftoppm → Groq Vision (free text + JSON) em paralelo ──────
    // Usado para PDFs que não são CNH-e (boletos, contratos, CTPS etc)
    // e como segurança se o Python falhar.
    const visionPagePromise: Promise<Buffer | null> = groqKey
      ? pdfPrimeiraPagemParaJpeg(buffer).catch(() => null)
      : Promise.resolve(null);

    const mistralPromise = mistralKey
      ? ocrMistral(mistralKey, buffer, mimetype).catch(() => ({ text: null, embeddedImages: [] as { base64: string; mime: string }[] }))
      : Promise.resolve({ text: null, embeddedImages: [] as { base64: string; mime: string }[] });

    const [pageImg, mistralResult] = await Promise.all([visionPagePromise, mistralPromise]);
    const mistralText = mistralResult.text;

    if (mistralText) {
      console.log(`[DocExtract] Mistral texto (${mistralText.length}c):\n${mistralText}`);
    }

    let visionJson: DocJsonResult | null = null;
    let visionFreeText: string | null = null;
    if (pageImg && groqKey) {
      [visionJson, visionFreeText] = await Promise.all([
        ocrGroqVisionJson(groqKey, pageImg, "image/jpeg").catch(() => null),
        ocrGroqVision(groqKey, pageImg, "image/jpeg").catch(() => null),
      ]);
      if (visionJson) console.log(`[DocExtract] Vision JSON: tipo=${visionJson.tipo_documento} cpf=${visionJson.cpf} rg=${visionJson.rg}`);
      if (visionFreeText) console.log(`[DocExtract] Vision free text: "${visionFreeText.slice(0, 300)}"`);
    }

    // CPF: validação matemática sobre todos os candidatos de 11 dígitos
    let cpfValidado: string | null = null;
    const fontes = [visionFreeText ?? "", visionJson ? JSON.stringify(visionJson) : "", mistralText ?? ""];
    for (const fonte of fontes) {
      if (cpfValidado) break;
      const candidatos = fonte.match(/\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}|\d{11}/g) ?? [];
      console.log(`[DocExtract] Candidatos CPF (fonte ${fontes.indexOf(fonte)}): ${JSON.stringify(candidatos)}`);
      for (const c of candidatos) {
        if (validarCPF(c)) {
          const d = c.replace(/\D/g, "");
          cpfValidado = `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
          console.log(`[DocExtract] CPF validado: ${cpfValidado}`);
          break;
        }
      }
    }

    // RG: número que NÃO é CPF válido, próximo de rótulo IDENTIDADE/RG
    let rgTexto: string | null = null;
    let orgaoTexto: string | null = null;
    for (const fonte of fontes) {
      if (rgTexto) break;
      const rgM = fonte.match(/(?:IDENTIDADE|Doc\.?\s*Identidade|RG)\s*[:\s*]?\s*([\d./-]{7,15})/i);
      if (rgM) {
        const num = rgM[1].replace(/\D/g, "");
        if (num && !validarCPF(num)) { rgTexto = num; }
      }
      const orgaoM = fonte.match(/\b(SSP|PC|SESPDC|SESDEC|DETRAN|IFP|IGP)[/\s-]?([A-Z]{2})\b/);
      if (orgaoM) orgaoTexto = `${orgaoM[1]}/${orgaoM[2]}`;
    }

    const tipoCerto: DocJsonResult["tipo_documento"] = visionJson?.tipo_documento ?? (
      fontes.join(" ").includes("HABILITAÇÃO") || fontes.join(" ").includes("CNH") ? "CNH" :
      fontes.join(" ").includes("CARTEIRA DE TRABALHO") || fontes.join(" ").includes("CTPS") ? "CTPS" :
      fontes.join(" ").includes("REGISTRO GERAL") ? "RG" : "CNH"
    );

    const resultado: DocJsonResult = {
      tipo_documento:   tipoCerto,
      nome:             visionJson?.nome ?? null,
      cpf:              cpfValidado,
      rg:               rgTexto ?? (visionJson?.rg && !validarCPF(visionJson.rg) ? visionJson.rg : null),
      orgao_emissor_rg: orgaoTexto ?? visionJson?.orgao_emissor_rg ?? null,
      data_nascimento:  visionJson?.data_nascimento ?? null,
      naturalidade:     visionJson?.naturalidade ?? null,
      pis: null, numero_ctps: null, serie_ctps: null,
      endereco: null, bairro: null, cidade: null, uf: null, cep: null,
    };
    console.log(`[DocExtract] Fallback Vision: tipo=${resultado.tipo_documento} cpf=${resultado.cpf} rg=${resultado.rg} orgao=${resultado.orgao_emissor_rg} nome=${resultado.nome}`);
    return resultado;
  }

  // ── Imagem direta (foto CNH física, RG, comprovante) ────────────────────
  // Estratégia primária: Mistral OCR com document_annotation (retorna JSON estruturado)
  // Fallback: Groq Vision JSON + validação matemática de CPF
  if (mistralKey) {
    const mistralResult = await ocrMistralCNHAnnotation(mistralKey, buffer, mimetype).catch((e: any) => {
      console.warn(`[DocExtract] Mistral CNH Annotation falhou: ${e?.message}`);
      return null;
    });
    if (mistralResult && (mistralResult.nome || mistralResult.cpf || mistralResult.rg)) {
      return mistralResult;
    }
  }

  // Fallback: Groq Vision JSON — cobre CNH foto e outros documentos (RG, comprovante)
  if (groqKey) {
    const result = await ocrGroqVisionJson(groqKey, buffer, mimetype).catch((e: any) => {
      console.warn(`[DocExtract] Groq Vision JSON falhou: ${e?.message}`);
      return null;
    });
    if (result) {
      // Marcar como foto de CNH (física) se for CNH
      if (result.tipo_documento === "CNH") result.subtipo = "CNH_FOTO";
      console.log(`[DocExtract] Vision JSON (img): tipo=${result.tipo_documento} subtipo=${result.subtipo} cpf=${result.cpf} rg=${result.rg}`);
      // Validar CPF
      if (result.cpf && !validarCPF(result.cpf)) {
        console.warn(`[DocExtract] CPF da imagem inválido: ${result.cpf} — descartando`);
        if (result.rg && validarCPF(result.rg)) {
          console.warn(`[DocExtract] Campos CPF/RG invertidos na imagem — corrigindo`);
          [result.cpf, result.rg] = [result.rg, result.cpf];
        } else {
          result.cpf = null;
        }
      }
    }
    return result;
  }

  return null;
}

/**
 * Extracts raw text from a document/image — used only for the conversational message.
 * Structured field extraction is done by extractDocumentJson separately.
 */
async function extractMediaData(
  opts: { groqKey: string; mistralKey: string },
  buffer: Buffer,
  mimetype: string,
): Promise<string | null> {
  const { groqKey, mistralKey } = opts;
  const isPdf = mimetype === "application/pdf";

  try {
    // PDF → pdftoppm → Groq Vision (texto livre para mensagem)
    if (isPdf && groqKey) {
      const pageImg = await pdfPrimeiraPagemParaJpeg(buffer);
      if (pageImg) {
        const result = await ocrGroqVision(groqKey, pageImg, "image/jpeg").catch(() => null);
        if (result) return result;
      }
    }

    // Mistral OCR fallback
    if (mistralKey) {
      const { text: mistralText, embeddedImages } = await ocrMistral(mistralKey, buffer, mimetype);
      if (embeddedImages.length > 0 && groqKey) {
        const parts: string[] = [];
        for (const img of embeddedImages) {
          const imgBuf = Buffer.from(img.base64, "base64");
          const visionResult = await ocrGroqVision(groqKey, imgBuf, img.mime).catch(() => null);
          if (visionResult) parts.push(visionResult);
        }
        if (parts.length > 0) return parts.join("\n\n");
      }
      if (mistralText) {
        const textLimpo = mistralText.replace(/!\[.*?\]\(.*?\)/g, "").trim();
        if (textLimpo.length > 30) return textLimpo;
      }
    }

    // Groq Vision direto (imagens)
    if (groqKey && !isPdf) {
      const result = await ocrGroqVision(groqKey, buffer, mimetype);
      if (result) return result;
    }

    // Tesseract local
    const result = await ocrTesseract(buffer, mimetype);
    return result;

  } catch (e: any) {
    console.warn(`[DocExtract] Falha na extração (${mimetype}): ${e?.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export interface EvolutionWebhookMessage {
  key: { id: string; remoteJid: string; fromMe: boolean };
  message?: {
    conversation?: string;
    extendedTextMessage?: { text: string };
    imageMessage?: { caption?: string; url?: string };
    audioMessage?: { url?: string };
    documentMessage?: { url?: string; mimetype?: string };
  };
  messageType?: string;
  pushName?: string;
  instanceName?: string;
}

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instancia: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point — called by webhook
// ──────────────────────────────────────────────────────────────────────────────

export async function processIncomingMessage(
  projetoId: string,
  msg: EvolutionWebhookMessage
): Promise<void> {
  const phone = msg.key.remoteJid.replace(/@.*/, "");
  if (msg.key.fromMe) return;

  // Deduplication: skip if this exact Evolution message was already processed.
  // Uses a unique constraint on evolutionMessageId — the INSERT below is the atomic guard.
  // Any duplicate webhook fires will hit the unique violation (P2002) and be silently dropped.

  let text = extractText(msg);
  let documentosEnviados = false; // set to true when OCR extraction succeeds — for documentos_pessoais trigger
  let docJsonDireto: DocJsonResult | null = null; // resultado estruturado direto do Groq Vision JSON
  const isAudio = msg.messageType === "audioMessage" || !!msg.message?.audioMessage;
  const tipo = isAudio ? "audio" : (msg.messageType ?? "text");

  // Skip status messages
  if (msg.key.remoteJid.endsWith("@broadcast") || msg.key.remoteJid.endsWith("@g.us")) return;

  // ── Transcrição de áudio ─────────────────────────────────────────────────
  if (isAudio) {
    try {
      const audioConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId, categoria: "audio" },
      });
      const getAudio = (k: string) => audioConfigs.find((c) => c.chave === k)?.valor ?? "";
      const audioApiKey = getAudio("audio_api_key");
      const audioModel  = getAudio("audio_model")  || "whisper-large-v3-turbo";
      const audioProvider = (getAudio("audio_provider") || "groq") as "groq" | "openai";

      if (audioApiKey) {
        // Buscar config Evolution para download do áudio
        const waConfigs = await prisma.iaProjetoConfig.findMany({
          where: { projetoId, categoria: "whatsapp" },
        });
        const getWa = (k: string) => waConfigs.find((c) => c.chave === k)?.valor ?? "";
        const evoConfig = {
          baseUrl: getWa("evolution_api_url").replace(/\/$/, ""),
          apiKey:  getWa("evolution_api_key"),
          instancia: getWa("evolution_instancia"),
        };

        if (evoConfig.baseUrl && evoConfig.apiKey) {
          const audio = await downloadAudioFromEvolution(
            evoConfig.baseUrl, evoConfig.apiKey, evoConfig.instancia, msg
          );
          if (audio) {
            const result = await transcribeAudio(
              audio.buffer, audio.mimetype, audioApiKey, audioModel, audioProvider
            );
            if (result.ok && result.text) {
              text = result.text;
              console.log(`[Audio] Transcrito (${audioProvider}): "${text.slice(0, 80)}"`);
            } else {
              console.warn(`[Audio] Falha na transcrição: ${result.error}`);
            }
          }
        }
      }
    } catch (e: any) {
      console.error(`[Audio] Erro ao transcrever: ${e.message}`);
    }
  }

  // ── Extração de dados de documentos e imagens ──────────────────────────────
  // When client sends a CNH, CTPS, PDF contract, or any other document/image,
  // extract qualification data via Anthropic Vision and populate deal fields.
  const isDocument = msg.messageType === "documentMessage" || !!msg.message?.documentMessage;
  const isImage = !isAudio && (msg.messageType === "imageMessage" || !!msg.message?.imageMessage);

  if (isDocument || isImage) {
    try {
      const waConfigs = await prisma.iaProjetoConfig.findMany({
        where: { projetoId, categoria: "whatsapp" },
      });
      const getWa = (k: string) => waConfigs.find((c) => c.chave === k)?.valor ?? "";
      const docEvoConfig: EvolutionConfig = {
        baseUrl: getWa("evolution_api_url").replace(/\/$/, ""),
        apiKey:  getWa("evolution_api_key"),
        instancia: getWa("evolution_instancia"),
      };

      if (docEvoConfig.baseUrl && docEvoConfig.apiKey) {
        const mediaBuffer = await downloadMedia(docEvoConfig, msg.key.id);

        const mimetype = msg.message?.documentMessage?.mimetype
          ?? (isImage ? "image/jpeg" : "application/octet-stream");

        // Load OCR provider keys
        const ocrConfigs = await prisma.iaProjetoConfig.findMany({
          where: { projetoId, categoria: "ocr" },
        });
        let mistralKey = ocrConfigs.find((c) => c.chave === "ocr_mistral_api_key")?.valor ?? "";

        // Auto-create OCR config entries so they appear in Config IA
        if (!ocrConfigs.length) {
          prisma.iaProjetoConfig.createMany({
            data: [
              { projetoId, categoria: "ocr", chave: "ocr_mistral_api_key", valor: "", descricao: "API Key Mistral (OCR — PDFs escaneados e imagens)" },
            ],
            skipDuplicates: true,
          }).catch(() => {});
        }

        // Groq key: prefer LLM provider, fallback to audio key
        const groqLlmRow = await prisma.iaLlmProvedor.findFirst({
          where: { projetoId, ativo: true, provider: "groq" },
          orderBy: { ordem: "asc" },
        });
        let groqKey = groqLlmRow?.apiKey ?? "";
        if (!groqKey) {
          const audioConfigs = await prisma.iaProjetoConfig.findMany({
            where: { projetoId, categoria: "audio" },
          });
          groqKey = audioConfigs.find((c) => c.chave === "audio_api_key")?.valor ?? "";
        }

        // Anthropic key: used by Python extractor (Claude Vision Strategy 3 — optional)
        const anthropicLlmRow = await prisma.iaLlmProvedor.findFirst({
          where: { projetoId, ativo: true, provider: "anthropic" },
          orderBy: { ordem: "asc" },
        });
        const anthropicKey = anthropicLlmRow?.apiKey ?? "";

        // Roda extração de texto (para mensagem) e JSON estruturado (para campos) em paralelo
        const [extracted, _docJsonDireto] = await Promise.all([
          extractMediaData({ groqKey, mistralKey }, mediaBuffer, mimetype).catch(() => null),
          extractDocumentJson({ groqKey, mistralKey, anthropicKey }, mediaBuffer, mimetype).catch(() => null),
        ]);
        docJsonDireto = _docJsonDireto; // assign to outer scoped variable (avoids shadowing)

        // Armazena resultado estruturado para usar no passo 7a2 (sem passar por extractJson)
        if (docJsonDireto) {
          console.log(`[DocExtract] JSON direto: tipo=${docJsonDireto.tipo_documento} cpf=${docJsonDireto.cpf} rg=${docJsonDireto.rg} orgao=${docJsonDireto.orgao_emissor_rg}`);
        }

        // documentosEnviados=true whenever a doc/image arrives — so the system prompt
        // always guides the LLM correctly (whether or not OCR succeeded).
        documentosEnviados = true;
        if (extracted) {
          text = `[Documento recebido — dados extraídos]\n${extracted}`;
          console.log(`[DocExtract] OCR texto ok:\n${extracted.slice(0, 300)}`);
        } else {
          text = isDocument ? "[Cliente enviou um documento — leitura automática falhou]" : "[Cliente enviou uma foto/imagem — leitura automática falhou]";
        }
      }
    } catch (e: any) {
      console.warn(`[DocExtract] Falha ao extrair ${isDocument ? "documento" : "imagem"}: ${e?.message}`);
      documentosEnviados = true; // still guide the LLM
      if (!text) {
        text = isDocument ? "[Cliente enviou um documento — leitura automática falhou]" : "[Cliente enviou uma foto/imagem — leitura automática falhou]";
      }
    }
  }

  // 1. Find or create contact + deal
  let contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  let deal = contato
    ? await prisma.crmDeal.findFirst({
        where: { contatoId: contato.id, projetoId, status: "aberto" },
        orderBy: { criadoEm: "desc" },
      })
    : null;

  if (!contato) {
    const nome = msg.pushName ?? `Lead ${phone}`;
    contato = await prisma.crmContato.create({ data: { nome, whatsapp: phone } });
  }

  const isNewDeal = !deal;
  if (!deal) {
    deal = await createInitialDeal(projetoId, contato.id, contato.nome);
  }

  // 2. Save incoming message — atomic dedup guard via unique(evolutionMessageId).
  // If the same webhook fires twice, the second INSERT throws P2002 and we bail out.
  try {
    await prisma.crmMensagemWhatsapp.create({
      data: {
        dealId: deal.id,
        contatoId: contato.id,
        direcao: "in",
        remetente: phone,
        tipo,
        conteudo: text ?? "",
        evolutionMessageId: msg.key.id,
      },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      console.log(`[StageEngine] Mensagem ${msg.key.id} já processada — ignorando duplicata`);
      return;
    }
    throw err;
  }

  // 2b. New deal → send first proactive message and stop here
  // Pass empty name so the AI doesn't use the WhatsApp profile name before asking
  if (isNewDeal) {
    await enviarMensagemProativa(projetoId, deal.id, phone, "primeira_mensagem", "");
    return;
  }

  // 3. IA paused — human took over
  if (!deal.iaAtiva) return;

  // 4. Update contact name
  if (msg.pushName && contato.nome.startsWith("Lead ")) {
    await prisma.crmContato.update({ where: { id: contato.id }, data: { nome: msg.pushName } });
    contato = { ...contato, nome: msg.pushName };
  }

  // 5. Load stage & persona
  const stageChave = deal.iaStageChave ?? "lead_carreteiro";
  const fase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: stageChave } },
  });

  if (!fase || fase.requerAcaoHumana) return;

  const personaChave = deal.iaPersonaChave ?? fase.personaChave ?? "assistente";
  const persona = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChave } },
  });

  if (!persona) return;

  // 6. Load last 20 messages as context
  const history = await prisma.crmMensagemWhatsapp.findMany({
    where: { dealId: deal.id },
    orderBy: { enviadaEm: "desc" },
    take: 20,
  });
  history.reverse();

  // 7. Load qualification questions for basic fields (nome, cidade, interesse, etc.)
  //    Employment links are handled separately via the vinculos array loop below.
  const perguntas = await prisma.iaPerguntaQualificacao.findMany({
    where: { projetoId, stageColeta: stageChave, ativo: true },
    orderBy: { ordem: "asc" },
  });

  let merged: Record<string, unknown> = (deal.qualificacao as Record<string, unknown>) ?? {};

  // 7a. Auto-populate nome from WhatsApp pushName if not yet in qualificacao
  if (!merged.nome && contato.nome && !contato.nome.startsWith("Lead ")) {
    const primeiroNome = contato.nome.trim().split(" ")[0];
    merged.nome = primeiroNome;
    await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
  }

  // 7a. Extract basic qualification fields from recent history (last 8 client messages)
  //     Using history instead of just current message catches answers given in earlier turns.
  const todosOsPendentes = perguntas.filter((p) => !merged[p.chave]);
  if (todosOsPendentes.length > 0) {
    const textoParaExtrair = history
      .filter((m) => m.direcao === "in")
      .slice(-8)
      .map((m) => m.conteudo ?? "")
      .filter(Boolean)
      .join("\n");
    const extracted = await extractQualificacaoData(projetoId, textoParaExtrair || text || "", todosOsPendentes, merged).catch(() => null);
    if (extracted) {
      const novos: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(extracted)) {
        if (v !== null && v !== undefined && !merged[k]) {
          merged[k] = v;
          novos[k] = v;
        }
      }
      if (Object.keys(novos).length > 0) {
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
        prisma.crmNota.create({
          data: { dealId: deal.id, conteudo: `[IA] Qualificação:\n${Object.entries(novos).map(([k, v]) => `${k}: ${v}`).join("\n")}` },
        }).catch(() => {});
        if (novos.nome && typeof novos.nome === "string") {
          const nomeCapturado = novos.nome.trim();
          await prisma.crmContato.update({ where: { id: contato.id }, data: { nome: nomeCapturado } });
          await prisma.crmDeal.update({ where: { id: deal.id }, data: { titulo: nomeCapturado } });
          contato = { ...contato, nome: nomeCapturado };
        }
      }
    }
  }

  // 7a2. Document field extraction — usa docJsonDireto (Groq Vision JSON) que já vem com
  //      campos corretamente mapeados pelo rótulo visual no documento.
  //      Também limpa CPF inválido que possa estar em merged de extração anterior.
  if (documentosEnviados) {
    // Limpar CPF inválido salvo anteriormente (de extrações erradas antes desta fix)
    if (merged.cpf && typeof merged.cpf === "string" && !validarCPF(merged.cpf as string)) {
      console.warn(`[DocExtract] CPF em merged inválido ("${merged.cpf}") — limpando`);
      delete merged.cpf;
    }

    if (docJsonDireto && docJsonDireto.tipo_documento !== "OUTRO") {
      try {
        // Guardar tipo e subtipo do documento para uso no system prompt
        merged._ultimo_doc_tipo   = docJsonDireto.tipo_documento;
        merged._ultimo_doc_subtipo = docJsonDireto.subtipo ?? null;

        // Validação matemática de CPF — detecta CPF/RG invertidos
        let cpfExtraido = docJsonDireto.cpf ?? null;
        let rgExtraido  = docJsonDireto.rg  ?? null;

        if (cpfExtraido && !validarCPF(cpfExtraido)) {
          if (rgExtraido && validarCPF(rgExtraido)) {
            console.warn(`[DocExtract] CPF inválido ("${cpfExtraido}") e RG parece CPF válido ("${rgExtraido}") — invertendo`);
            [cpfExtraido, rgExtraido] = [rgExtraido, cpfExtraido];
            docJsonDireto.cpf = cpfExtraido;
            docJsonDireto.rg  = rgExtraido;
          } else {
            console.warn(`[DocExtract] CPF extraído inválido: "${cpfExtraido}" — descartando`);
            cpfExtraido = null;
            docJsonDireto.cpf = null;
          }
        }

        // Campos que SEMPRE sobrescrevem quando vêm de extração confiável (CNH_E ou CNH_FOTO).
        // Isso corrige dados errados de extrações anteriores (ex: RG errado de run antes da fix).
        const isCnhConfiavel = docJsonDireto.subtipo === "CNH_E" || docJsonDireto.subtipo === "CNH_FOTO";
        const camposSempre = isCnhConfiavel
          ? new Set(["rg", "orgao_emissor_rg", "uf_emissor_rg", "nome", "data_nascimento", "local_nascimento", "filiacao_pai", "filiacao_mae"])
          : new Set<string>();

        const novosDocFields: Record<string, unknown> = {};
        const todosCampos = [
          "rg", "orgao_emissor_rg", "uf_emissor_rg", "cpf", "nome",
          "data_nascimento", "local_nascimento", "naturalidade",
          "filiacao_pai", "filiacao_mae",
          "pis", "numero_ctps", "serie_ctps",
          "endereco", "bairro", "cidade", "uf", "cep",
        ] as const;

        for (const campo of todosCampos) {
          const val = (docJsonDireto as Record<string, unknown>)[campo];
          if (val) {
            // CPF: sempre sobrescreve se matematicamente válido
            if (campo === "cpf" && validarCPF(val as string)) {
              if (merged.cpf !== val) {
                merged.cpf = val;
                novosDocFields.cpf = val;
              }
            } else if (camposSempre.has(campo)) {
              // Campos confiáveis de CNH_E/CNH_FOTO: sempre sobrescrever para corrigir dados antigos
              if (merged[campo] !== val) {
                merged[campo] = val;
                novosDocFields[campo] = val;
              }
            } else if (!merged[campo]) {
              merged[campo] = val;
              novosDocFields[campo] = val;
            }
          }
        }

        if (Object.keys(novosDocFields).length > 0) {
          await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
          prisma.crmNota.create({
            data: { dealId: deal.id, conteudo: `[IA] Dados do documento (${docJsonDireto.tipo_documento}):\n${Object.entries(novosDocFields).map(([k, v]) => `${k}: ${v}`).join("\n")}` },
          }).catch(() => {});
          console.log(`[DocExtract] tipo=${docJsonDireto.tipo_documento} campos salvos: ${Object.keys(novosDocFields).join(", ")}`);
        } else {
          console.log(`[DocExtract] tipo=${docJsonDireto.tipo_documento} — nenhum campo novo`);
        }
      } catch (e: any) {
        console.warn(`[DocExtract] Falha ao salvar campos: ${e?.message}`);
      }
    } else {
      console.log(`[DocExtract] docJsonDireto=${docJsonDireto?.tipo_documento ?? "null"} — ignorado`);
    }
  }

  // 7b. Vinculos array loop — collect all employment links within the 2-year prescription window.
  //
  //  Prescription rule (CLT art. 11):
  //  - Worker has 2 years from termination to file. Can recover up to 5 years back.
  //  - If the MOST RECENT job is prescribed (> 2 years ago), ALL previous ones are too
  //    (they were terminated even earlier). No point investigating anteriores.
  //  - If most recent is within 2 years, keep asking about previous jobs until one is outside
  //    the 2-year window or the person confirms there are no more.
  //
  //  State stored in qualificacao:
  //    vinculos[]              — array of collected employment objects
  //    _vinculos_ok            — true when the loop is finished (all within 2y collected)
  //    _vinculos_todos_prescritos — true when even the most recent job is prescribed

  const vinculos: VinculoEmprego[] = Array.isArray(merged.vinculos)
    ? (merged.vinculos as VinculoEmprego[])
    : [];
  const vinculosOk              = merged._vinculos_ok === true;
  const vinculosTodosPrescritos = merged._vinculos_todos_prescritos === true;

  if (!vinculosOk && text) {
    try {
      const historiaTexto = history
        .slice(-12)
        .map((m) => `${m.direcao === "out" ? "Ana" : "Cliente"}: ${m.conteudo ?? ""}`)
        .join("\n");

      const extraido = await tryExtractVinculo(projetoId, text, vinculos, historiaTexto);

      // 1. Apply enrichments to existing vinculos (fields filled in by LLM from history)
      const vinculosEnriquecidos = extraido.updatedVinculos;
      const foiEnriquecido = JSON.stringify(vinculosEnriquecidos) !== JSON.stringify(vinculos);
      if (foiEnriquecido) {
        merged.vinculos = vinculosEnriquecidos;
        prisma.crmNota.create({
          data: {
            dealId: deal.id,
            conteudo: `[IA] Vínculos enriquecidos com dados da conversa: ${vinculosEnriquecidos.map((v) => v.empresa ?? "?").join(", ")}`,
          },
        }).catch(() => {});
      }

      // Use the enriched array going forward
      const vinculosAtuais = vinculosEnriquecidos;

      if (extraido.semMaisEmpregos) {
        // Person confirmed no more jobs within 2 years — close the loop
        merged._vinculos_ok = true;
        merged.vinculos = vinculosAtuais;
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
      } else if (extraido.vinculo) {
        const dentroPrazo = await checkVinculoPrazo(projetoId, extraido.vinculo);

        if (!dentroPrazo) {
          if (vinculosAtuais.length === 0) {
            // First (most recent) job is already prescribed → ALL are → end
            merged._vinculos_ok = true;
            merged._vinculos_todos_prescritos = true;
          } else {
            // A subsequent job is outside the window → 2-year boundary reached → end
            merged._vinculos_ok = true;
          }
          merged.vinculos = vinculosAtuais;
        } else {
          // Within 2 years — add to array and keep asking
          vinculosAtuais.push({ ...extraido.vinculo, ordem: vinculosAtuais.length + 1 });
          merged.vinculos = vinculosAtuais;
          prisma.crmNota.create({
            data: {
              dealId: deal.id,
              conteudo: `[IA] Vínculo ${vinculosAtuais.length}: ${extraido.vinculo.empresa ?? "?"} — ${extraido.vinculo.funcao ?? "?"} — saída: ${extraido.vinculo.saida ?? extraido.vinculo.data_saida ?? "?"}`,
            },
          }).catch(() => {});
        }
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
      } else if (foiEnriquecido) {
        // No new vínculo and no semMaisEmpregos signal, but existing vinculos were enriched
        await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
      }
    } catch (err: any) {
      console.warn("[VinculosLoop] Erro na extração de vínculos — Ana responde normalmente sem atualizar vínculos:", err?.message ?? err);
      // Non-blocking: extraction failure does not abort the response
    }
  }

  // 7c. Sync vinculos[] → flat fields once the vinculos loop is done.
  //     vinculos[0] = emprego mais recente → campos *_recente
  //     vinculos[1] = emprego anterior      → campos emprego_anterior_*
  //     This ensures the flat qualification fields are populated for reporting/filtering,
  //     even though the actual data lives in vinculos[].
  if (merged._vinculos_ok === true && vinculos.length > 0) {
    const v0 = vinculos[0];
    const v1 = vinculos[1];
    const syncFlat: Record<string, unknown> = {};

    if (v0) {
      if (!merged.empresa_recente && v0.empresa)         syncFlat.empresa_recente         = v0.empresa;
      if (!merged.funcao_recente  && v0.funcao)          syncFlat.funcao_recente          = v0.funcao;
      if (!merged.vinculo_recente && v0.vinculo)         syncFlat.vinculo_recente         = v0.vinculo;
      if (!merged.tempo_recente   && v0.tempo)           syncFlat.tempo_recente           = v0.tempo;
      if (!merged.saida_recente   && (v0.saida ?? v0.data_saida)) syncFlat.saida_recente  = v0.saida ?? v0.data_saida;
      if (!merged.frota_recente   && v0.frota)           syncFlat.frota_recente           = v0.frota;
      if (!merged.horas_extras_recentes   && v0.horas_extras)     syncFlat.horas_extras_recentes   = v0.horas_extras;
      if (!merged.pagamento_fora_recente  && v0.pagamento_fora)   syncFlat.pagamento_fora_recente  = v0.pagamento_fora;
      if (!merged.injustica_recente       && v0.injustica)         syncFlat.injustica_recente       = v0.injustica;
    }
    if (v1) {
      if (!merged.emprego_anterior_empresa  && v1.empresa)  syncFlat.emprego_anterior_empresa  = v1.empresa;
      if (!merged.emprego_anterior_funcao   && v1.funcao)   syncFlat.emprego_anterior_funcao   = v1.funcao;
      if (!merged.emprego_anterior_vinculo  && v1.vinculo)  syncFlat.emprego_anterior_vinculo  = v1.vinculo;
      if (!merged.emprego_anterior_tempo    && v1.tempo)    syncFlat.emprego_anterior_tempo    = v1.tempo;
      if (!merged.emprego_anterior_saida    && (v1.saida ?? v1.data_saida)) syncFlat.emprego_anterior_saida = v1.saida ?? v1.data_saida;
      if (!merged.emprego_anterior_horas_extras   && v1.horas_extras)   syncFlat.emprego_anterior_horas_extras   = v1.horas_extras;
      if (!merged.emprego_anterior_pagamento_fora && v1.pagamento_fora) syncFlat.emprego_anterior_pagamento_fora = v1.pagamento_fora;
      if (!merged.emprego_anterior_injustica      && v1.injustica)      syncFlat.emprego_anterior_injustica      = v1.injustica;
    }

    if (Object.keys(syncFlat).length > 0) {
      Object.assign(merged, syncFlat);
      await prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } });
      prisma.crmNota.create({
        data: { dealId: deal.id, conteudo: `[IA] Sync vínculos→flat:\n${Object.entries(syncFlat).map(([k, v]) => `${k}: ${v}`).join("\n")}` },
      }).catch(() => {});
    }
  }

  // 7d. Load qualificacao_completa transition rule (used for allAnswered check and prescription gate)
  const regraQualificacao = await prisma.iaRegraTransicao.findFirst({
    where: { projetoId, stageOrigemChave: stageChave, condicao: "qualificacao_completa" },
  });

  // 7d. allAnswered: all required DB questions answered + vinculos loop finished
  const perguntasPendentes = perguntas.filter((p) => !merged[p.chave]);
  const requiredChaves = new Set(perguntas.filter((p) => p.obrigatorio).map((p) => p.chave));
  const basicAnswered = [...requiredChaves].every((chave) => merged[chave] !== undefined);
  const allAnswered = basicAnswered && (merged._vinculos_ok === true);

  // 7e. Detect client insisting on a phone call → notify SDR/Closer via WhatsApp
  //     Keywords come from IaProjetoConfig (categoria: "comportamento", chave: "solicita_ligacao_palavras")
  //     Value: comma-separated list of phrases. Configurable in Config IA > Comportamento.
  if (text) {
    const DEFAULT_LIGACAO_PALAVRAS = "me liga,pode ligar,ligue pra mim,ligue para mim,quero ligacao,quero uma ligacao,preciso de ligacao,prefiro falar por telefone,falar por telefone,quando voces ligam,quando vocês ligam,aguardando a ligacao,espero a ligacao,manda o telefone,qual o telefone,numero de telefone";

    // Load from DB (upsert default on first access so it appears in the UI)
    let ligacaoPalavrasConfig = await prisma.iaProjetoConfig.findFirst({
      where: { projetoId, categoria: "comportamento", chave: "solicita_ligacao_palavras" },
    });
    if (!ligacaoPalavrasConfig) {
      ligacaoPalavrasConfig = await prisma.iaProjetoConfig.create({
        data: {
          projetoId,
          categoria: "comportamento",
          chave: "solicita_ligacao_palavras",
          valor: DEFAULT_LIGACAO_PALAVRAS,
        },
      }).catch(() => null);
    }

    const palavras = (ligacaoPalavrasConfig?.valor ?? DEFAULT_LIGACAO_PALAVRAS)
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);

    const normalizado = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    const pedidoLigacao = palavras.some((p) => {
      const pNorm = p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      return normalizado.includes(pNorm);
    });

    if (pedidoLigacao) {
      // Cooldown: notify at most once every 2 hours per deal
      const ultimaNotif = merged._notif_ligacao_at as string | undefined;
      const cooldownMs = 2 * 60 * 60 * 1000;
      const devNotificar = !ultimaNotif || (Date.now() - new Date(ultimaNotif).getTime() > cooldownMs);

      if (devNotificar) {
        const nomeCliente = String(merged.nome ?? contato.nome ?? "");
        const empresa = String(merged.empresa_recente ?? (Array.isArray(merged.vinculos) && (merged.vinculos as any[])[0]?.empresa) ?? "");
        const cidade = String(merged.cidade ?? "");
        dispararNotificacoes(projetoId, "solicita_ligacao", {
          nome:     nomeCliente,
          telefone: phone,
          empresa,
          cidade,
          stage:    stageChave,
          mensagem: text,
        }).catch(() => {});

        merged._notif_ligacao_at = new Date().toISOString();
        prisma.crmDeal.update({ where: { id: deal.id }, data: { qualificacao: merged as any } }).catch(() => {});
        console.log(`[StageEngine] Cliente ${phone} pediu ligação — notificação disparada`);
      }
    }
  }

  // 8. Build system prompt
  const INSTRUCAO_BASE = buildInstrucaoBase();
  let userSystem = persona.systemPrompt
    .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
    .replace(/\{nome_persona\}/g, persona.nomeExibicao);

  // REGRA GLOBAL — links nunca devem aparecer nas respostas do LLM.
  // Links de proposta, contrato e procuração são enviados automaticamente
  // pelo sistema como mensagens separadas após o LLM responder.
  // Se o cliente pedir para reenviar links, a IA deve dizer que o sistema
  // vai enviar novamente em instantes — nunca fabricar ou incluir URLs.
  userSystem +=
    `\n\nREGRA ABSOLUTA — LINKS: Nunca inclua links, URLs ou placeholders de link` +
    ` (como "[LINK AQUI]", "[URL]", etc.) em nenhuma resposta.` +
    ` Links de assinatura, contrato e procuração são enviados automaticamente pelo sistema em mensagens separadas.` +
    ` Se o cliente pedir para reenviar links, diga apenas: "Vou solicitar que o sistema reenvie agora, aguarde um instante."`;

  // When the client just sent a document (CNH, CTPS, etc.), guide the LLM precisely.
  // Build dynamic instruction based on what was actually extracted — avoids hallucinated placeholders.
  if (documentosEnviados) {
    // Detectar tipo de documento pelo que foi extraído
    const tipoDoc = (merged._ultimo_doc_tipo as string | undefined) || null;
    const isEndereco = tipoDoc === "COMPROVANTE_ENDERECO";
    const isCtps     = tipoDoc === "CTPS";

    // CRÍTICO: o link de assinatura é enviado automaticamente pelo sistema
    // em mensagens separadas logo após. O LLM NUNCA deve incluir links na resposta.
    const instrucaoLink =
      `\nIMPORTANTE: O link de assinatura do contrato e da procuração será enviado AUTOMATICAMENTE` +
      ` pelo sistema na próxima mensagem. NÃO inclua nenhum link, URL ou placeholder de link na sua resposta.` +
      ` Diga apenas que o contrato e a procuração serão enviados em instantes.`;

    if (isEndereco) {
      // Comprovante de endereço
      const endExtraido = (merged.endereco as string | undefined) || null;
      const cidadeExtraida = (merged.cidade as string | undefined) || null;
      const extraidos = [
        endExtraido   ? `endereço: ${endExtraido}` : null,
        cidadeExtraida ? `cidade: ${cidadeExtraida}` : null,
      ].filter(Boolean) as string[];

      if (extraidos.length > 0) {
        userSystem +=
          `\n\nCOMPROVANTE DE ENDEREÇO recebido — dados extraídos: ${extraidos.join(", ")}.` +
          `\nAgradeça o envio e confirme o endereço com o cliente.` +
          instrucaoLink;
      } else {
        userSystem +=
          `\n\nCOMPROVANTE DE ENDEREÇO recebido — não conseguimos ler o endereço automaticamente.` +
          `\nAgradeça o envio e peça que o cliente informe o endereço completo com CEP.` +
          instrucaoLink;
      }
    } else if (isCtps) {
      // CTPS digital
      const pisExtraido = (merged.pis as string | undefined) || null;
      const nomeExtraido = (merged.nome as string | undefined) || null;
      const extraidos = [
        nomeExtraido ? `nome: ${nomeExtraido}` : null,
        pisExtraido  ? `PIS/NIS: ${pisExtraido}` : null,
      ].filter(Boolean) as string[];

      if (extraidos.length > 0) {
        userSystem +=
          `\n\nCTPS recebida — dados extraídos: ${extraidos.join(", ")}.` +
          `\nAgradeça o envio e confirme os dados.` +
          instrucaoLink;
      } else {
        userSystem +=
          `\n\nCTPS recebida — não conseguimos ler os dados automaticamente.` +
          `\nAgradeça o envio e continue o atendimento normalmente.` +
          instrucaoLink;
      }
    } else {
      // CNH ou RG — fluxo principal de identidade
      const docNome  = (merged.nome  as string | undefined) || null;
      const docCpf   = (merged.cpf   as string | undefined) || null;
      const docRg    = (merged.rg    as string | undefined) || null;
      const docOrgao = (merged.orgao_emissor_rg as string | undefined) || null;
      const docSubtipo = (merged._ultimo_doc_subtipo as string | undefined) || null;

      // Rótulo do tipo de documento para o LLM
      const rotuloDoc = docSubtipo === "CNH_E"
        ? "CNH-e digital (documento Gov.br)"
        : docSubtipo === "CNH_FOTO"
        ? "foto da CNH física"
        : "documento de identidade";

      const extraidos = [
        docNome  ? `nome: ${docNome}`   : null,
        docCpf   ? `CPF: ${docCpf}`    : null,
        docRg    ? `RG: ${docRg}${docOrgao ? ` ${docOrgao}` : ""}` : null,
      ].filter(Boolean) as string[];

      const faltando = [
        !docNome ? "nome completo"                                  : null,
        !docCpf  ? "CPF"                                           : null,
        !docRg   ? "RG (número de identidade, não de habilitação)" : null,
      ].filter(Boolean) as string[];

      // Proibição absoluta de linguagem técnica — vale para TODOS os casos (com ou sem dados)
      const proibicaoTecnica =
        `\nREGRA ABSOLUTA DE LINGUAGEM: JAMAIS use as palavras "sistema", "extração", "leitura automática",` +
        ` "não consegui", "não foi possível", "erro", "falha" ou qualquer palavra técnica.` +
        ` JAMAIS peça que o cliente "digite" — use "pode me confirmar", "qual é seu", "me fala".` +
        ` Fale como uma atendente humana que está olhando o documento na tela.`;

      if (extraidos.length > 0) {
        userSystem +=
          `\n\n${rotuloDoc.toUpperCase()} recebido — dados confirmados: ${extraidos.join(", ")}.` +
          `\nAgradeça o envio de forma natural e confirme exatamente estes dados com o cliente.` +
          (faltando.length
            ? `\nPreciso ainda de: ${faltando.join(", ")}. Peça de forma conversacional e natural.`
            : "") +
          `\nNÃO mencione nem peça: número de registro CNH, categoria (A/B/C/D/E), validade da CNH, foto do verso da CNH.` +
          `\nA frente da CNH já contém todos os dados necessários — não há informação adicional no verso.` +
          proibicaoTecnica +
          instrucaoLink;
      } else {
        userSystem +=
          `\n\n${rotuloDoc.toUpperCase()} recebido.` +
          `\nAgradeça o envio de forma natural. Em seguida, peça de forma conversacional o CPF e o RG.` +
          `\nExemplo de resposta natural: "Recebi sua CNH! Pode me confirmar seu CPF e o número do RG para fecharmos o contrato?"` +
          `\nNÃO mencione nem peça: número de registro CNH, categoria, validade da habilitação, foto do verso da CNH.` +
          `\nA frente da CNH já contém todos os dados necessários.` +
          proibicaoTecnica +
          instrucaoLink;
      }
    }
  }

  // Show pending basic questions (interest, contact time, etc.)
  if (perguntasPendentes.length > 0 && !vinculosTodosPrescritos) {
    const questCtx = perguntasPendentes
      .slice(0, 2)
      .map((p) => `- ${p.perguntaContexto}${p.exemploAbordagem ? ` (ex: ${p.exemploAbordagem})` : ""}`)
      .join("\n");
    userSystem += `\n\nINFORMAÇÕES AINDA NÃO COLETADAS:\n${questCtx}`;
  }

  // Vinculos collection state context — drives what Ana asks next
  if (!vinculosOk && !vinculosTodosPrescritos) {
    const listaColetados = vinculos.length > 0
      ? vinculos.map((v) => `  • ${v.empresa ?? "?"} (${v.funcao ?? "?"}) — saída: ${v.saida ?? "?"}`).join("\n")
      : "  (nenhum ainda)";

    const proximaAcao = vinculos.length === 0
      ? "Colete as informações do emprego mais recente: empresa, função, tipo de vínculo (CLT/autônomo), quanto tempo trabalhou, como e quando saiu, se havia horas extras ou pagamento fora do holerite."
      : `Pergunte se houve outro emprego com saída nos últimos 2 anos. Se sim, colete os mesmos dados. Se não houver mais, confirme.`;

    userSystem += `\n\nCOLETA DE VÍNCULOS TRABALHISTAS\nVínculos já registrados (${vinculos.length}):\n${listaColetados}\n\nPRÓXIMA AÇÃO: ${proximaAcao}`;
  }

  if (vinculosOk && vinculos.length > 0) {
    userSystem += `\n\nVÍNCULOS COLETADOS (${vinculos.length}):\n${vinculos.map((v, i) => `${i + 1}. ${v.empresa ?? "?"} — ${v.funcao ?? "?"} — saída: ${v.saida ?? "?"}`).join("\n")}`;
  }

  if (vinculosTodosPrescritos) {
    userSystem += `\n\nATENÇÃO — PRAZO PRESCRICIONAL VENCIDO: O emprego mais recente do cliente foi encerrado há mais de 2 anos. Pelo art. 11 da CLT, o prazo de 2 anos para ajuizar ação trabalhista já expirou. Como o vínculo mais recente está prescrito, todos os anteriores também estão — foram encerrados ainda antes. Informe o cliente com empatia que, infelizmente, não é mais possível ajuizar ação referente a esses empregos. Encerre a conversa de forma acolhedora, sem prometer nada.`;
  }

  if (Object.keys(merged).filter(k => !k.startsWith("_") && k !== "vinculos").length > 0) {
    const dadosBasicos = Object.fromEntries(
      Object.entries(merged).filter(([k]) => !k.startsWith("_") && k !== "vinculos")
    );
    userSystem += `\n\nDADOS BÁSICOS COLETADOS:\n${JSON.stringify(dadosBasicos, null, 2)}`;

    // Se CPF já está confirmado em merged (válido matematicamente), instruir o LLM
    // a não questionar nem mencionar outras leituras do documento.
    const cpfConfirmado = typeof merged.cpf === "string" && validarCPF(merged.cpf as string)
      ? merged.cpf as string : null;
    if (cpfConfirmado) {
      userSystem +=
        `\n\nIMPORTANTE — CPF CONFIRMADO: O CPF do cliente é ${cpfConfirmado} (já registrado e validado).` +
        ` NÃO questione este CPF, NÃO mencione outros números que possam ter aparecido no documento.` +
        ` Trate este CPF como definitivo.`;
    }
  }

  const nomeInformado = typeof merged.nome === "string" ? merged.nome : null;
  if (nomeInformado) {
    userSystem += `\n\nNome do cliente: ${nomeInformado}`;
  }

  // 9. Build LLM messages
  const llmMessages = history.map((m) => ({
    role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
    content: m.conteudo ?? "",
  }));

  // 10. Call LLM (up to 3 attempts to get humanized response)
  let resposta = "";
  try {
    for (let attempts = 0; attempts < 3; attempts++) {
      const result = await callLlm({
        projetoId,
        dealId: deal.id,
        systemPrompt: userSystem,
        messages: llmMessages,
        personaChave,
        stageChave,
        maxTokens: 2048,
      });
      resposta = result.content.trim();
      if (isHumanized(resposta)) break;
      llmMessages.push({ role: "assistant", content: resposta });
      llmMessages.push({ role: "user", content: "INSTRUÇÃO INTERNA: Reescreva sem padrões robóticos." });
    }
  } catch (err: any) {
    console.warn(`[StageEngine] Todos os LLMs falharam para deal ${deal.id} — agendando retry`);
    scheduleLlmRetry(projetoId, deal.id, phone);
    return;
  }

  if (!resposta) return;

  // 11. Transition logic
  //   allAnswered = basic required questions done + vinculos loop finished
  //   requerPrescricaoAtiva = only fire when there is at least one valid vinculation (not all prescribed)
  const temVinculoValido = vinculos.length > 0 && !vinculosTodosPrescritos;
  const prescricaoGate = !regraQualificacao?.requerPrescricaoAtiva || temVinculoValido;

  if (allAnswered && regraQualificacao && prescricaoGate) {
    const qualDados = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, String(v ?? "")]));
    dispararNotificacoes(projetoId, "qualificacao_completa", {
      ...qualDados,
      telefone: phone,
      stage: stageChave,
    }).catch(() => {});
    const transitioned = await transitionDeal(projetoId, deal.id, "qualificacao_completa", phone);
    if (transitioned) return;

    // Auto-proposal trigger for qualificacao_completa moment
    const evoForProposta = await getEvolutionConfig(projetoId);
    if (evoForProposta) {
      criarPropostaAutomatica(projetoId, evoForProposta, phone, deal.id, "qualificacao_completa").catch(() => {});
    }
  }

  // 12. Check transitions based on client reply
  const transitioned = await checkTransitions(projetoId, deal.id, stageChave, text ?? "", phone);
  if (transitioned) return; // transition sent its own message

  // 13. Load Evolution config and send response
  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) {
    console.error("[StageEngine] Evolution API não configurada");
    return;
  }

  // Load comportamento configs for configurable delays
  const comportConfigs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "comportamento" },
  });
  const getComport = (k: string, def: number) => {
    const v = comportConfigs.find((c) => c.chave === k)?.valor;
    const n = v ? Number(v) : NaN;
    return isNaN(n) ? def : n;
  };
  const delayMin = getComport("resposta_delay_min", 20) * 1000;
  const delayMax = getComport("resposta_delay_max", 40) * 1000;
  const readDelay = delayMin + Math.random() * (delayMax - delayMin);

  const respostaFinal = `*${persona.nomeExibicao}*\n${limparResposta(resposta, persona.nomeExibicao)}`;

  await sendHumanized(evoConfig, phone, respostaFinal, readDelay);

  // 14. Save outgoing message
  await prisma.crmMensagemWhatsapp.create({
    data: {
      dealId: deal.id,
      contatoId: contato.id,
      direcao: "out",
      personaChave,
      tipo: "text",
      conteudo: respostaFinal,
    },
  });

  // 14b. If Daniela sent a parecer with a value estimate, persist it on the deal + send TTS audio.
  //      Detect: response contains a BRL value (R$ X.XXX,XX) and keywords indicating an assessment.
  if (personaChave === "daniela" || personaChave?.includes("closer")) {
    const PARECER_KEYWORDS = /\b(parecer|estima(tiva)?|calcul(ei|amos)|valor.*recup|recup.*valor|pleite|pode recup|você pode receb|a[çc][ãa]o trabalhista|ajuiz|indeniza[çc][ãa]o)\b/i;
    const VALOR_REGEX = /R\$\s*([\d.,]+)/g;

    if (PARECER_KEYWORDS.test(resposta)) {
      // Send audio for parecer (non-blocking, TTS failure won't affect text flow)
      sendAudioIfConfigured(projetoId, evoConfig, phone, resposta, personaChave, "parecer", deal.id).catch(() => {});
      const valores: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = VALOR_REGEX.exec(resposta)) !== null) {
        const v = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
        if (!isNaN(v) && v > 1000) valores.push(v);
      }

      if (valores.length > 0) {
        const maiorValor = Math.max(...valores);
        await prisma.crmDeal.update({
          where: { id: deal.id },
          data: {
            parecer: resposta,
            valorEstimado: maiorValor,
          },
        });
        await prisma.crmNota.create({
          data: {
            dealId: deal.id,
            conteudo: `[Parecer Daniela] Valor estimado: ${maiorValor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
          },
        });
        console.log(`[StageEngine] Parecer salvo no deal ${deal.id} — valorEstimado: ${maiorValor}`);

        // Auto-proposal: trigger if configured for "parecer_enviado"
        criarPropostaAutomatica(projetoId, evoConfig, phone, deal.id, "parecer_enviado").catch(() => {});
      }
    }
  }

  // 14c. Auto-proposal trigger for documentos_pessoais moment
  if (documentosEnviados) {
    criarPropostaAutomatica(projetoId, evoConfig, phone, deal.id, "documentos_pessoais").catch(() => {});
  }

  // 15. Update last contact time
  await prisma.crmDeal.update({
    where: { id: deal.id },
    data: { ultimoContatoEm: new Date() },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Proactive message sender — called by cron or after transition
// ──────────────────────────────────────────────────────────────────────────────

export async function enviarMensagemProativa(
  projetoId: string,
  dealId: string,
  phone: string,
  motivoCron: string, // "primeira_mensagem" | "timeout_sem_resposta" | "closer_tentativa" | "solicitar_documentos"
  nomeCliente: string
): Promise<void> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal?.iaAtiva) return;

  const stageChave = deal.iaStageChave ?? "lead_carreteiro";
  const personaChave = deal.iaPersonaChave ?? "assistente";

  const persona = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChave } },
  });
  if (!persona) return;

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  // Check for custom template first
  const templateChave = `${stageChave}_${motivoCron}`;
  const template = await prisma.iaMensagemTemplate.findFirst({
    where: { projetoId, chave: templateChave, ativo: true },
  });

  let mensagem = "";

  if (template) {
    mensagem = template.template
      .replace(/\{nome\}/g, nomeCliente)
      .replace(/\{nome_persona\}/g, persona.nomeExibicao);
  } else {
    // Generate via LLM
    const history = await prisma.crmMensagemWhatsapp.findMany({
      where: { dealId },
      orderBy: { enviadaEm: "desc" },
      take: 10,
    });
    history.reverse();

    const INSTRUCAO_BASE = buildInstrucaoBase();
    let systemPrompt = persona.systemPrompt
      .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
      .replace(/\{nome_persona\}/g, persona.nomeExibicao);
    if (nomeCliente) {
      systemPrompt += `\n\nNome do cliente: ${nomeCliente}`;
    }

    // Only count as "histórico" if there are prior outgoing (AI) messages —
    // the first incoming message is already saved before this is called
    const temHistorico = history.some((m) => m.direcao === "out");
    const tipoAbordagem = temHistorico ? "reengajamento com histórico" : "novo";

    let instrucao = "";
    if (motivoCron === "primeira_mensagem") {
      instrucao = `TIPO DE ABORDAGEM: ${tipoAbordagem}\n\nEscreva APENAS a primeira mensagem para ${nomeCliente}. Siga exatamente as instruções de PRIMEIRA MENSAGEM do seu system prompt para o cenário correspondente. Uma mensagem curta e natural de WhatsApp.`;
    } else if (motivoCron === "timeout_sem_resposta") {
      instrucao = `O cliente ${nomeCliente} não respondeu há algum tempo. Envie uma mensagem de seguimento natural, sem pressão.`;
    } else if (motivoCron === "closer_tentativa_1") {
      instrucao = `Você é a Dra. Daniela Pires. O cliente ${nomeCliente} parou de responder. Envie o lembrete sobre prescrição trabalhista (2 anos). Seja conciso e direto.`;
    } else if (motivoCron === "closer_tentativa_2") {
      instrucao = `Você é a Dra. Daniela Pires. Segunda e última tentativa com ${nomeCliente}. Mencione valores que costumamos recuperar e que não há custo antecipado.`;
    } else if (motivoCron === "solicitar_documentos") {
      instrucao = `O cliente ${nomeCliente} confirmou interesse. Solicite a CNH frente de forma natural e humana para dar início ao processo.`;
    }

    const llmMessages = [
      ...history.map((m) => ({
        role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
        content: m.conteudo ?? "",
      })),
      { role: "user" as const, content: `INSTRUÇÃO INTERNA: ${instrucao}` },
    ];

    for (let attempts = 0; attempts < 3; attempts++) {
      const result = await callLlm({
        projetoId,
        dealId,
        systemPrompt,
        messages: llmMessages,
        personaChave,
        stageChave,
        maxTokens: 2048,
      });
      mensagem = result.content.trim();
      if (isHumanized(mensagem)) break;
    }
  }

  if (!mensagem) return;

  const mensagemFinal = `*${persona.nomeExibicao}*\n${limparResposta(mensagem, persona.nomeExibicao)}`;

  // Proactive: use same configurable delay
  const proativaConfigs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "comportamento" },
  });
  const getPComport = (k: string, def: number) => {
    const v = proativaConfigs.find((c) => c.chave === k)?.valor;
    const n = v ? Number(v) : NaN;
    return isNaN(n) ? def : n;
  };
  const pDelayMin = getPComport("resposta_delay_min", 20) * 1000;
  const pDelayMax = getPComport("resposta_delay_max", 40) * 1000;
  const proativaReadDelay = pDelayMin + Math.random() * (pDelayMax - pDelayMin);
  await sendHumanized(evoConfig, phone, mensagemFinal, proativaReadDelay);

  // Send TTS audio for configured moments (non-blocking)
  sendAudioIfConfigured(projetoId, evoConfig, phone, mensagem, personaChave, motivoCron, dealId).catch(() => {});

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  await prisma.crmMensagemWhatsapp.create({
    data: {
      dealId,
      contatoId: contato?.id,
      direcao: "out",
      personaChave,
      tipo: "text",
      conteudo: mensagemFinal,
    },
  });

  await prisma.crmDeal.update({
    where: { id: dealId },
    data: { ultimoContatoEm: new Date() },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Transition with optional proactive message + action
// Returns true if a proactive message was sent (caller should not send another)
// ──────────────────────────────────────────────────────────────────────────────

export async function transitionDeal(
  projetoId: string,
  dealId: string,
  condicao: string,
  phone?: string
): Promise<boolean> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal) return false;

  const stageAtual = deal.iaStageChave;

  const regra = await prisma.iaRegraTransicao.findFirst({
    where: { projetoId, stageOrigemChave: stageAtual, condicao },
    orderBy: { ordem: "asc" },
  });

  if (!regra) return false;

  const novaFase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: regra.stageDestinoChave } },
  });

  if (!novaFase) return false;

  // Find matching CrmStage
  let newStageId = deal.stageId;
  if (novaFase.pipelineId) {
    const newStage = await prisma.crmStage.findFirst({
      where: { pipelineId: novaFase.pipelineId, chave: novaFase.chave },
    });
    if (newStage) newStageId = newStage.id;
  }

  // Determine new persona
  let novaPersona = novaFase.personaChave ?? deal.iaPersonaChave;
  if (regra.acaoAdicional?.startsWith("trocar_persona:")) {
    novaPersona = regra.acaoAdicional.split(":")[1];
  }

  // Update deal
  await prisma.crmDeal.update({
    where: { id: dealId },
    data: {
      iaStageChave: regra.stageDestinoChave,
      iaPersonaChave: novaPersona,
      stageId: newStageId,
    },
  });

  await prisma.crmDealStageLog.create({
    data: {
      dealId,
      stageAnteriorId: deal.stageId,
      stageNovoId: newStageId,
      motivo: `IA: ${condicao}`,
    },
  });

  console.log(`[StageEngine] Deal ${dealId}: ${stageAtual} → ${regra.stageDestinoChave} (${condicao})`);

  // Fire stage_entrada notification (non-blocking)
  {
    const contatoNotif = await prisma.crmContato.findFirst({ where: { deals: { some: { id: dealId } } } });
    const qual = (deal.qualificacao as Record<string, unknown>) ?? {};
    dispararNotificacoes(projetoId, `stage_entrada:${regra.stageDestinoChave}`, {
      nome:     String(contatoNotif?.nome ?? ""),
      cidade:   String(qual.cidade ?? ""),
      telefone: contatoNotif?.whatsapp ?? "",
      stage:    regra.stageDestinoChave,
    }).catch(() => {});
  }

  // Execute additional action
  if (!regra.acaoAdicional) return false;

  // trocar_persona: persona already updated above; send new persona's intro + return true
  // so the caller does NOT send the old persona's stale LLM response
  if (regra.acaoAdicional.startsWith("trocar_persona:")) {
    if (phone) {
      const contatoTroca = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
      const nomeTroca = contatoTroca?.nome ?? "cliente";
      // Use "primeira_mensagem" motivo so the new persona generates a natural intro
      await enviarMensagemProativa(projetoId, dealId, phone, "primeira_mensagem", nomeTroca);
      return true;
    }
    return false;
  }

  if (!phone) return false;

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  const nomeCliente = contato?.nome ?? "cliente";

  const acao = regra.acaoAdicional;

  if (acao === "solicitar_documentos") {
    // Update persona before sending
    await prisma.crmDeal.update({ where: { id: dealId }, data: { iaPersonaChave: novaPersona } });
    await enviarMensagemProativa(projetoId, dealId, phone, "solicitar_documentos", nomeCliente);
    return true;
  }

  if (acao === "criar_deal_processual") {
    await criarDealProcessual(projetoId, dealId);
    // Send welcome message
    const boas_vindas = `*Dra. Daniela Pires*\n${nomeCliente}, ótimo! Seu caso foi registrado e vamos agendar uma reunião com o advogado responsável. Em breve entraremos em contato.`;
    const evoConfig = await getEvolutionConfig(projetoId);
    if (evoConfig) {
      await sendHumanized(evoConfig, phone, boas_vindas, 1500);
      await prisma.crmMensagemWhatsapp.create({
        data: {
          dealId,
          contatoId: contato?.id,
          direcao: "out",
          personaChave: "advogado",
          tipo: "text",
          conteudo: boas_vindas,
        },
      });
    }
    return true;
  }

  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Check transitions triggered by client reply
// ──────────────────────────────────────────────────────────────────────────────

async function checkTransitions(
  projetoId: string,
  dealId: string,
  stageAtual: string,
  clienteText: string,
  phone: string
): Promise<boolean> {
  // Coming back from sem_resposta
  if (stageAtual === "lead_sem_resposta" && clienteText) {
    return await transitionDeal(projetoId, dealId, "cliente_respondeu", phone);
  }

  // Interest confirmation
  const interestKeywords = /\b(quero|sim|pode|vamos|ok|bora|vou|claro|concordo|aceito|tô dentro|to dentro|bom|ótimo)\b/i;
  if (interestKeywords.test(clienteText)) {
    const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
    const stage = deal?.iaStageChave;
    if (stage === "lead_qualificado" || stage === "lead_indeciso" || stage === "com_closer") {
      return await transitionDeal(projetoId, dealId, "interesse_confirmado", phone);
    }
  }

  return false;
}

// ──────────────────────────────────────────────────────────────────────────────
// Create processual deal after commercial deal is won
// ──────────────────────────────────────────────────────────────────────────────

async function criarDealProcessual(projetoId: string, dealComercialId: string): Promise<void> {
  const dealComercial = await prisma.crmDeal.findUnique({
    where: { id: dealComercialId },
    include: { contato: true },
  });
  if (!dealComercial) return;

  // Find processual pipeline entry stage
  const faseEntrada = await prisma.iaFaseFunil.findFirst({
    where: { projetoId, ehEntrada: true, pipelineTipo: "processual" },
    orderBy: { ordem: "asc" },
  });

  let stageId: string | undefined;
  let pipelineId: string | undefined;

  if (faseEntrada?.pipelineId) {
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: faseEntrada.pipelineId, chave: faseEntrada.chave },
    });
    stageId = stage?.id;
    pipelineId = faseEntrada.pipelineId;
  }

  if (!stageId || !pipelineId) {
    console.warn("[StageEngine] Nenhum pipeline processual configurado");
    return;
  }

  // Mark commercial deal as won
  await prisma.crmDeal.update({
    where: { id: dealComercialId },
    data: { status: "ganho", iaAtiva: false },
  });

  // Create processual deal
  await prisma.crmDeal.create({
    data: {
      titulo: `${dealComercial.contato?.nome ?? "Cliente"} — Processo`,
      pipelineId,
      stageId,
      contatoId: dealComercial.contatoId,
      projetoId,
      iaAtiva: false, // human-only from here
      iaStageChave: faseEntrada?.chave,
      fonteLead: "crm_comercial",
      qualificacao: dealComercial.qualificacao as any,
    },
  });

  console.log(`[StageEngine] Deal processual criado para deal comercial ${dealComercialId}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function extractText(msg: EvolutionWebhookMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    null
  );
}

async function createInitialDeal(projetoId: string, contatoId: string, nome: string) {
  const faseEntrada = await prisma.iaFaseFunil.findFirst({
    where: { projetoId, ehEntrada: true, pipelineTipo: "comercial" },
    orderBy: { ordem: "asc" },
  });

  let stageId: string | undefined;
  let pipelineId: string | undefined;

  if (faseEntrada?.pipelineId) {
    const stage = await prisma.crmStage.findFirst({
      where: { pipelineId: faseEntrada.pipelineId, chave: faseEntrada.chave },
    });
    stageId = stage?.id;
    pipelineId = faseEntrada.pipelineId;
  }

  if (!stageId) {
    const pipeline = await prisma.crmPipeline.findFirst({
      where: { tipo: "comercial", ativo: true },
      include: { stages: { where: { ehEntrada: true }, take: 1 } },
    });
    if (pipeline?.stages[0]) {
      stageId = pipeline.stages[0].id;
      pipelineId = pipeline.id;
    }
  }

  if (!stageId || !pipelineId) throw new Error("Nenhum pipeline comercial configurado");

  return prisma.crmDeal.create({
    data: {
      titulo: `${nome} — WhatsApp`,
      pipelineId,
      stageId,
      contatoId,
      projetoId,
      iaAtiva: true,
      iaStageChave: faseEntrada?.chave ?? "lead_carreteiro",
      iaPersonaChave: faseEntrada?.personaChave ?? "assistente",
      fonteLead: "whatsapp",
    },
  });
}

async function extractQualificacaoData(
  projetoId: string,
  text: string,
  perguntas: { chave: string; perguntaContexto: string; tipoDado: string }[],
  existing: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  const pending = perguntas
    .filter((p) => !existing[p.chave])
    .map((p) => `"${p.chave}": ${p.tipoDado === "booleano" ? "true/false/null" : '"valor ou null"'}`)
    .join(", ");

  return extractJson({
    projetoId,
    instruction: `Extraia os seguintes campos do texto do cliente. Use null se não mencionado.\nCampos: {${pending}}`,
    text,
  });
}

/**
 * Re-generate and send a response using the current DB state of the deal.
 * Called by the retry queue when all LLMs were temporarily unavailable.
 */
async function respondFromDealState(projetoId: string, dealId: string, phone: string): Promise<void> {
  const deal = await prisma.crmDeal.findUnique({ where: { id: dealId } });
  if (!deal || !deal.iaAtiva) return;

  const stageChave = deal.iaStageChave ?? "lead_carreteiro";
  const fase = await prisma.iaFaseFunil.findUnique({
    where: { projetoId_chave: { projetoId, chave: stageChave } },
  });
  if (!fase || fase.requerAcaoHumana) return;

  const personaChave = deal.iaPersonaChave ?? fase.personaChave ?? "assistente";
  const persona = await prisma.iaPersona.findUnique({
    where: { projetoId_chave: { projetoId, chave: personaChave } },
  });
  if (!persona) return;

  const history = await prisma.crmMensagemWhatsapp.findMany({
    where: { dealId },
    orderBy: { enviadaEm: "desc" },
    take: 20,
  });
  history.reverse();

  const llmMessages = history.map((m) => ({
    role: (m.direcao === "out" ? "assistant" : "user") as "user" | "assistant",
    content: m.conteudo ?? "",
  }));

  const INSTRUCAO_BASE = buildInstrucaoBase();
  const userSystem = persona.systemPrompt
    .replace("{INSTRUÇÃO BASE}", INSTRUCAO_BASE)
    .replace(/\{nome_persona\}/g, persona.nomeExibicao);

  const result = await callLlm({
    projetoId,
    dealId,
    systemPrompt: userSystem,
    messages: llmMessages,
    personaChave,
    stageChave,
    maxTokens: 2048,
  });
  const resposta = result.content.trim();
  if (!resposta) return;

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  const respostaFinal = `*${persona.nomeExibicao}*\n${limparResposta(resposta, persona.nomeExibicao)}`;
  await sendHumanized(evoConfig, phone, respostaFinal, 3000);

  const contato = await prisma.crmContato.findFirst({ where: { whatsapp: phone } });
  if (contato) {
    await prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        contatoId: contato.id,
        direcao: "out",
        remetente: persona.nomeExibicao,
        tipo: "text",
        conteudo: respostaFinal,
      },
    });
  }
}

export async function getEvolutionConfig(projetoId: string): Promise<EvolutionConfig | null> {
  const configs = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, categoria: "whatsapp" },
  });
  const get = (k: string) => configs.find((c) => c.chave === k)?.valor ?? "";
  const baseUrl = get("evolution_api_url");
  const apiKey = get("evolution_api_key");
  const instancia = get("evolution_instancia");
  if (!baseUrl || !apiKey || !instancia) return null;
  return { baseUrl, apiKey, instancia };
}

// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────
// Auto-proposal creator — generates + sends proposal/contracts via WhatsApp
// ──────────────────────────────────────────────────────────────────────────────

async function criarPropostaAutomatica(
  projetoId: string,
  evoConfig: EvolutionConfig,
  phone: string,
  dealId: string,
  momento: string,
): Promise<void> {
  try {
    // 1. Load proposta configs
    const propostaConfigs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, categoria: "proposta" },
    });
    const getProp = (k: string) => propostaConfigs.find((c) => c.chave === k)?.valor ?? "";

    if (getProp("proposta_ativo") !== "true") return;
    if (getProp("proposta_momento") !== momento) return;

    const emitenteId = getProp("proposta_emitente_id");
    if (!emitenteId) {
      console.warn("[Proposta] proposta_emitente_id não configurado — proposta não gerada");
      return;
    }

    // 2. Load deal + contato
    const deal = await prisma.crmDeal.findUnique({
      where: { id: dealId },
      include: { contato: true },
    });
    if (!deal) return;

    const merged = (deal.qualificacao ?? {}) as Record<string, unknown>;
    const nomeCliente      = String(merged.nome ?? deal.contato?.nome ?? "Cliente");
    const cpfCliente       = String(merged.cpf ?? deal.contato?.cpf ?? "");
    const emailCliente     = String(merged.email ?? deal.contato?.email ?? "");
    const rgCliente        = String(merged.rg ?? "");
    const orgaoEmissorRg   = String(merged.orgao_emissor_rg ?? "");
    const dataNascimento   = merged.data_nascimento ? new Date(String(merged.data_nascimento).split("/").reverse().join("-")) : null;

    if (!cpfCliente) {
      console.warn(`[Proposta] CPF não disponível para deal ${dealId} — proposta não gerada`);
      return;
    }

    // 3. Find or create Tomador — update identity fields if already exists
    let tomador = await prisma.tomador.findUnique({ where: { cpfCnpj: cpfCliente.replace(/\D/g, "") } });
    const tomadorData = {
      nome:           nomeCliente,
      email:          emailCliente || null,
      telefone:       phone || null,
      cidade:         String(merged.cidade ?? "") || null,
      ...(rgCliente     ? { rg: rgCliente }                : {}),
      ...(orgaoEmissorRg ? { rgOrgaoEmissor: orgaoEmissorRg } : {}),
      ...(dataNascimento && !isNaN(dataNascimento.getTime()) ? { dataNascimento } : {}),
    };
    if (!tomador) {
      tomador = await prisma.tomador.create({
        data: { cpfCnpj: cpfCliente.replace(/\D/g, ""), ...tomadorData },
      });
      console.log(`[Proposta] Tomador criado: ${tomador.id} (${nomeCliente})`);
    } else if (rgCliente || orgaoEmissorRg) {
      // Update identity fields if we have new data from the document
      await prisma.tomador.update({
        where: { id: tomador.id },
        data:  tomadorData as any,
      });
    }

    // 4. Load body template HTML
    const corpoTemplateId = getProp("proposta_template_corpo_id");
    let textoHtml = "";
    if (corpoTemplateId) {
      const tmpl = await (prisma as any).templateDocumento.findUnique({ where: { id: corpoTemplateId } });
      textoHtml = tmpl?.textoHtml ?? "";
    }
    if (!textoHtml) {
      // Fallback: use first hardcoded template (assessoria)
      const { TEMPLATES_PROPOSTA } = await import("../routers/propostas.js");
      textoHtml = TEMPLATES_PROPOSTA[0].html;
    }

    // 5. Load emitente for variable substitution
    const emitente = await prisma.empresaEmitente.findUnique({ where: { id: emitenteId } });
    if (!emitente) {
      console.warn(`[Proposta] Emitente ${emitenteId} não encontrado`);
      return;
    }

    // 6. Substitute variables in template
    const hoje = new Date();
    const validadeDias = parseInt(getProp("proposta_validade_dias") || "30", 10);
    const validadeAte = new Date(hoje.getTime() + validadeDias * 24 * 60 * 60 * 1000);
    const honorariosTipo = getProp("proposta_honorarios_tipo") || "exito";
    const honorariosPerc = getProp("proposta_honorarios_perc") || "30";
    const descricaoServico = getProp("proposta_descricao_servico") || "Ação trabalhista";

    const valorEstimado = deal.valorEstimado ? Number(deal.valorEstimado) : null;
    const valorStr = valorEstimado
      ? (valorEstimado / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
      : "a definir";

    const fmtData = (d: Date) => d.toLocaleDateString("pt-BR");
    const localidade = [emitente.cidade, emitente.uf].filter(Boolean).join("/");

    textoHtml = textoHtml
      .replace(/\{\{emitente\}\}/gi,   emitente.nomeFantasia || emitente.nome)
      .replace(/\{\{tomador\}\}/gi,    nomeCliente)
      .replace(/\{\{cnpj\}\}/gi,       emitente.cnpj)
      .replace(/\{\{cidade\}\}/gi,     localidade)
      .replace(/\{\{endereco\}\}/gi,   emitente.endereco || "")
      .replace(/\{\{servico\}\}/gi,    descricaoServico)
      .replace(/\{\{valor\}\}/gi,      valorStr)
      .replace(/\{\{diaVencimento\}\}/gi,      getProp("proposta_dia_vencimento") || "5")
      .replace(/\{\{validadeAte\}\}/gi,         fmtData(validadeAte))
      .replace(/\{\{dataAtual\}\}/gi,           fmtData(hoje))
      .replace(/\{\{honorariosExito\}\}/gi,     `${honorariosPerc}%`)
      .replace(/\{\{honorariosExitoPerc\}\}/gi, honorariosPerc);

    // 7. Collect template IDs for contract/procuracao generation
    const templatesGerar: string[] = [];
    const contratoTemplateId  = getProp("proposta_template_contrato_id");
    const procuracaoTemplateId = getProp("proposta_template_procuracao_id");
    if (contratoTemplateId)   templatesGerar.push(contratoTemplateId);
    if (procuracaoTemplateId) templatesGerar.push(procuracaoTemplateId);

    // 8. Create Proposta record
    const titulo = `Proposta — ${nomeCliente}`;
    const proposta = await prisma.proposta.create({
      data: {
        emitenteId,
        tomadorId:     tomador.id,
        titulo,
        textoHtml,
        valorEstimado: valorEstimado ? Math.round(valorEstimado) : null,
        validadeAte,
        status:        "ENVIADA",
        contratoDiaVencimento:     parseInt(getProp("proposta_dia_vencimento") || "5", 10),
        contratoMetodoCobr:        (getProp("proposta_metodo_cobr") as any) || "PIX_BOLETO",
        contratoTipoContrato:      (getProp("proposta_tipo_contrato") as any) || "RECORRENTE",
        contratoEmitirNfseAuto:    true,
        contratoGerarCobrancaAuto: true,
        contratoIssRetido:         false,
        contratoDescricao:         descricaoServico,
        templatesGerar:            templatesGerar.length > 0 ? JSON.stringify(templatesGerar) : null,
      } as any,
    });
    console.log(`[Proposta] Proposta criada: ${proposta.id} para deal ${dealId}`);

    // Link note
    prisma.crmNota.create({
      data: { dealId, conteudo: `[IA] Proposta criada automaticamente: ${proposta.id} | ${titulo}` },
    }).catch(() => {});

    // 9. Generate documents (contrato + procuração)
    if (templatesGerar.length > 0) {
      try {
        const { gerarDocumentosProposta } = await import("../routers/templateDocumentos.js");
        await gerarDocumentosProposta(proposta.id);
        console.log(`[Proposta] Documentos gerados para proposta ${proposta.id}`);
      } catch (e) {
        console.error("[Proposta] Falha ao gerar documentos:", e);
      }
    }

    // 10. Upload docs to PAKT and collect sign URLs
    const baseUrl    = process.env.APP_BASE_URL ?? "https://avoce.capium.com.br";
    const paktApiKey = process.env.PAKT_API_KEY;
    const paktBaseUrl = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
    const { existsSync } = await import("node:fs");
    const { readFile }   = await import("node:fs/promises");

    type PaktDoc = { titulo: string; signUrl: string; documentId: string };
    const paktDocs: PaktDoc[] = [];

    if (paktApiKey && templatesGerar.length > 0 && emailCliente) {
      try {
        const docs = await (prisma as any).documentoGerado.findMany({
          where: { propostaId: proposta.id },
          orderBy: [{ tipo: "asc" }, { criadoEm: "asc" }],
        });

        for (const doc of docs) {
          if (!doc.pdfPath || !existsSync(doc.pdfPath)) continue;
          try {
            const pdfBuf = await readFile(doc.pdfPath);
            const filename = `${doc.titulo.replace(/[^a-zA-Z0-9\s]/g, "").trim().replace(/\s+/g, "-")}.pdf`;
            const form = new FormData();
            form.append("file", new Blob([pdfBuf as unknown as BlobPart], { type: "application/pdf" }), filename);
            form.append("metadata", JSON.stringify({
              nome:      doc.titulo,
              mensagem:  `Documento de ${emitente.nomeFantasia || emitente.nome} para assinatura.`,
              expiresAt: validadeAte.toISOString(),
              signers:   [{ nome: nomeCliente, email: emailCliente, countryCode: "BR" }],
            }));

            const createRes = await fetch(`${paktBaseUrl}/api/v1/documents`, {
              method: "POST",
              headers: { Authorization: `Bearer ${paktApiKey}` },
              body: form,
            });
            if (createRes.ok) {
              const paktDoc = await createRes.json() as { id: string; signers: Array<{ signUrl: string }> };
              const signUrl = paktDoc.signers[0]?.signUrl;
              if (signUrl) {
                paktDocs.push({ titulo: doc.titulo, signUrl, documentId: paktDoc.id });
                fetch(`${paktBaseUrl}/api/v1/documents/${paktDoc.id}/send`, {
                  method: "POST", headers: { Authorization: `Bearer ${paktApiKey}` },
                }).catch(() => {});
              }
            }
          } catch (e) {
            console.error(`[Proposta] PAKT falhou para doc ${doc.id}:`, e);
          }
        }

        if (paktDocs.length > 0) {
          await prisma.proposta.update({
            where: { id: proposta.id },
            data: {
              paktSignUrl:    paktDocs[0].signUrl,
              paktDocumentId: JSON.stringify(paktDocs.map(d => d.documentId)),
            } as any,
          });
        }
      } catch (e) {
        console.error("[Proposta] Falha no PAKT:", e);
      }
    }

    // 11. Send WhatsApp messages with proposal text + links
    const linkProposta = `${baseUrl}/api/proposta/${(proposta as any).tokenAceite}`;

    // Convert HTML body to readable plain text for WhatsApp
    const textoPlano = textoHtml
      .replace(/<h[1-6][^>]*>/gi, "\n*")
      .replace(/<\/h[1-6]>/gi, "*\n")
      .replace(/<p[^>]*>/gi, "\n")
      .replace(/<\/p>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "*$1*")
      .replace(/<b[^>]*>(.*?)<\/b>/gi, "*$1*")
      .replace(/<em[^>]*>(.*?)<\/em>/gi, "_$1_")
      .replace(/<li[^>]*>/gi, "\n• ")
      .replace(/<\/li>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Send proposal text first (max 3000 chars to avoid WA limits)
    const textoEnviar = textoPlano.length > 3000 ? textoPlano.slice(0, 2997) + "..." : textoPlano;
    if (textoEnviar) {
      await sendText(evoConfig, phone, textoEnviar);
      // Small pause between messages
      await new Promise(r => setTimeout(r, 1500));
    }

    if (paktDocs.length > 0) {
      // Has PAKT signing links — send each doc link
      const linhasAssinatura = paktDocs
        .map((d, i) => `${i + 1}. ${d.titulo}:\n${d.signUrl}`)
        .join("\n\n");
      const msgAssinatura =
        `Para assinar digitalmente, acesse os links abaixo:\n\n${linhasAssinatura}\n\n` +
        `Ou revise a proposta completa: ${linkProposta}`;
      await sendText(evoConfig, phone, msgAssinatura);
    } else {
      // No PAKT or no docs — send proposal link only
      const msgProposta = `Para revisar e confirmar sua proposta, acesse:\n${linkProposta}`;
      await sendText(evoConfig, phone, msgProposta);
    }

    // Log outgoing message
    prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        direcao: "out",
        personaChave: "sistema",
        tipo: "text",
        conteudo: `[Proposta automática] ${linkProposta}`,
      },
    }).catch(() => {});

    console.log(`[Proposta] Proposta ${proposta.id} enviada via WhatsApp para ${phone}`);
  } catch (err: any) {
    console.error(`[Proposta] Erro em criarPropostaAutomatica: ${err?.message ?? err}`);
  }
}

// TTS audio sender — sends ElevenLabs voice note after text, if configured
// ──────────────────────────────────────────────────────────────────────────────

async function sendAudioIfConfigured(
  projetoId: string,
  evoConfig: EvolutionConfig,
  phone: string,
  text: string,
  personaChave: string,
  momento: string,
  dealId: string,
): Promise<void> {
  try {
    // Load TTS configs
    const ttsConfigs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, categoria: "tts" },
    });
    const getTts = (k: string) => ttsConfigs.find((c) => c.chave === k)?.valor ?? "";

    const apiKey  = getTts("tts_api_key");
    const model   = getTts("tts_model") || "eleven_multilingual_v2";
    const momentos = getTts("tts_momentos_audio")
      .split(",").map((m) => m.trim()).filter(Boolean);

    if (!apiKey || !momentos.includes(momento)) return;

    // Load persona voice ID
    const persona = await prisma.iaPersona.findUnique({
      where: { projetoId_chave: { projetoId, chave: personaChave } },
    });
    const voiceId = (persona as any)?.ttsVoiceId as string | undefined;
    if (!voiceId) return;

    // Generate and send audio
    const audioBuffer = await textToSpeech(apiKey, voiceId, text, model);
    await sendWhatsAppAudio(evoConfig, phone, audioBuffer.toString("base64"));

    // Log audio message (non-blocking)
    prisma.crmMensagemWhatsapp.create({
      data: {
        dealId,
        direcao: "out",
        personaChave,
        tipo: "audio",
        conteudo: text,
      },
    }).catch(() => {});

    console.log(`[TTS] Áudio enviado para ${phone} (${personaChave}/${momento})`);
  } catch (err: any) {
    // TTS failure must never block text flow
    console.warn(`[TTS] Falha ao enviar áudio — ${err?.message ?? err}`);
  }
}

// Notification dispatcher — sends WhatsApp messages for configured events
// ──────────────────────────────────────────────────────────────────────────────

export async function dispararNotificacoes(
  projetoId: string,
  evento: string,
  dados: Record<string, string>
): Promise<void> {
  const notifs = await prisma.iaNotificacaoEvento.findMany({
    where: { projetoId, evento, ativo: true },
  });
  if (!notifs.length) return;

  const evoConfig = await getEvolutionConfig(projetoId);
  if (!evoConfig) return;

  for (const notif of notifs) {
    try {
      const texto = notif.mensagem.replace(/\{\{(\w+)\}\}/g, (_, k) => dados[k] ?? "");
      await sendText(evoConfig, notif.destino, texto);
    } catch (err) {
      console.error(`[Notificação] Falha ao enviar para ${notif.destino}:`, err);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Employment link (vínculo) collection helpers
// ──────────────────────────────────────────────────────────────────────────────

interface VinculoEmprego {
  ordem: number;
  empresa?: string;
  funcao?: string;
  vinculo?: string;       // CLT | autônomo | avulso | cooperado
  tempo?: string;         // duration of employment
  data_saida?: string;    // termination date/period — used for prescription check
  saida?: string;         // full narrative: how + when left
  horas_extras?: string;
  pagamento_fora?: string;
  injustica?: string;
  frota?: string;
}

/**
 * Tries to extract ONE employment link from the current client message.
 * Returns the extracted link OR a signal that the person has no more jobs within 2 years.
 */
/**
 * Extracts employment info from the current message + recent history.
 *
 * Two operations:
 * 1. UPDATE — enriches existing vinculos that have null/missing fields (new details from client).
 * 2. NEW — detects a new employer not yet in the list.
 *
 * Returns the (possibly enriched) vinculos array, a new vínculo if found, and the semMaisEmpregos signal.
 */
async function tryExtractVinculo(
  projetoId: string,
  text: string,
  vinculos: VinculoEmprego[],
  historiaTexto: string,
): Promise<{ vinculo: VinculoEmprego | null; semMaisEmpregos: boolean; updatedVinculos: VinculoEmprego[] }> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });

  const vinculosJson = JSON.stringify(
    vinculos.map((v) => ({
      ordem: v.ordem,
      empresa: v.empresa ?? null,
      funcao: v.funcao ?? null,
      vinculo: v.vinculo ?? null,
      tempo: v.tempo ?? null,
      data_saida: v.data_saida ?? null,
      saida: v.saida ?? null,
      horas_extras: v.horas_extras ?? null,
      pagamento_fora: v.pagamento_fora ?? null,
      injustica: v.injustica ?? null,
      frota: v.frota ?? null,
    })),
    null, 2
  );

  const result = await extractJson<{
    sem_mais_empregos?: boolean;
    vinculos_atualizados?: Array<{
      ordem: number;
      empresa?: string | null;
      funcao?: string | null;
      vinculo?: string | null;
      tempo?: string | null;
      data_saida?: string | null;
      saida?: string | null;
      horas_extras?: string | null;
      pagamento_fora?: string | null;
      injustica?: string | null;
      frota?: string | null;
    }>;
    novo_vinculo?: {
      empresa?: string | null;
      funcao?: string | null;
      vinculo?: string | null;
      tempo?: string | null;
      data_saida?: string | null;
      saida?: string | null;
      horas_extras?: string | null;
      pagamento_fora?: string | null;
      injustica?: string | null;
      frota?: string | null;
    } | null;
  }>({
    projetoId,
    instruction: `DATA ATUAL: ${hoje}.

Você está analisando mensagens de um cliente para extrair informações de vínculos trabalhistas.

VÍNCULOS JÁ COLETADOS (array atual):
${vinculosJson}

TAREFA:
1. Preencha campos null dos vínculos existentes se o texto mencionar essa informação.
2. Se o cliente mencionou um emprego DIFERENTE dos já listados, inclua em "novo_vinculo".
3. Se o cliente confirmou que não tem mais empregos nos últimos 2 anos, marque "sem_mais_empregos": true.

CAMPOS A EXTRAIR (para cada vínculo):
- empresa: nome da empresa
- funcao: cargo/função exercida
- vinculo: "CLT" | "autônomo" | "avulso" | "cooperado"
- tempo: tempo total de trabalho lá
- data_saida: data de rescisão/demissão no formato DD/MM/AAAA ou MM/AAAA — CRÍTICO para prescrição
- saida: como e quando saiu (demitido, pediu demissão, etc)
- horas_extras: horas extras e comissão — descreva quantas horas, valores, como era pago
- pagamento_fora: pagamentos fora do holerite (PIX, Pamcard, dinheiro) — valores e frequência
- injustica: irregularidades sofridas (desconto indevido, jornada não paga, pressão, etc)
- frota: tamanho da frota da empresa

Responda APENAS JSON no formato:
{
  "sem_mais_empregos": false,
  "vinculos_atualizados": [
    { "ordem": 1, "empresa": "...", "funcao": null, ... }
  ],
  "novo_vinculo": null
}`,
    text: historiaTexto + "\n\nMensagem atual: " + text,
  });

  if (!result) return { vinculo: null, semMaisEmpregos: false, updatedVinculos: vinculos };
  if (result.sem_mais_empregos) return { vinculo: null, semMaisEmpregos: true, updatedVinculos: vinculos };

  // Apply updates to existing vinculos
  let updatedVinculos = [...vinculos];
  if (result.vinculos_atualizados?.length) {
    for (const upd of result.vinculos_atualizados) {
      const idx = updatedVinculos.findIndex((v) => v.ordem === upd.ordem);
      if (idx >= 0) {
        const existing = updatedVinculos[idx];
        updatedVinculos[idx] = {
          ...existing,
          // Only overwrite if existing field is null/undefined
          empresa:       existing.empresa       ?? (upd.empresa       ?? undefined),
          funcao:        existing.funcao        ?? (upd.funcao        ?? undefined),
          vinculo:       existing.vinculo       ?? (upd.vinculo       ?? undefined),
          tempo:         existing.tempo         ?? (upd.tempo         ?? undefined),
          data_saida:    existing.data_saida    ?? (upd.data_saida    ?? undefined),
          saida:         existing.saida         ?? (upd.saida         ?? undefined),
          horas_extras:  existing.horas_extras  ?? (upd.horas_extras  ?? undefined),
          pagamento_fora: existing.pagamento_fora ?? (upd.pagamento_fora ?? undefined),
          injustica:     existing.injustica     ?? (upd.injustica     ?? undefined),
          frota:         existing.frota         ?? (upd.frota         ?? undefined),
        };
      }
    }
  }

  // New vínculo
  if (result.novo_vinculo?.empresa) {
    const novoVinculo: VinculoEmprego = {
      ordem: updatedVinculos.length + 1,
      empresa:        result.novo_vinculo.empresa       ?? undefined,
      funcao:         result.novo_vinculo.funcao        ?? undefined,
      vinculo:        result.novo_vinculo.vinculo       ?? undefined,
      tempo:          result.novo_vinculo.tempo         ?? undefined,
      data_saida:     result.novo_vinculo.data_saida    ?? undefined,
      saida:          result.novo_vinculo.saida         ?? undefined,
      horas_extras:   result.novo_vinculo.horas_extras  ?? undefined,
      pagamento_fora: result.novo_vinculo.pagamento_fora ?? undefined,
      injustica:      result.novo_vinculo.injustica     ?? undefined,
      frota:          result.novo_vinculo.frota         ?? undefined,
    };
    return { vinculo: novoVinculo, semMaisEmpregos: false, updatedVinculos };
  }

  return { vinculo: null, semMaisEmpregos: false, updatedVinculos };
}

/**
 * Checks if an employment link's TERMINATION DATE is within the 2-year prescription window.
 * Uses `data_saida` (explicit date) first, falls back to the full `saida` narrative.
 * Conservative: returns true (within window) when there's not enough date info.
 *
 * Note: "tempo de serviço" (how long they worked) is irrelevant — only the TERMINATION DATE matters.
 * Someone who worked 5 years but left 2 months ago is fully within the prescription period.
 */
async function checkVinculoPrazo(
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

/**
 * Checks if the most recent job termination is within the 2-year labor prescription period.
 * Returns "ativa" (within 2 years), "prescrita" (outside 2 years), or "pendente" (not enough info).
 * Conservative: when uncertain, returns "pendente" so the flow continues normally.
 */
async function checkPrescricao(
  projetoId: string,
  qualificacao: Record<string, unknown>,
  history: { direcao: string; conteudo: string | null }[]
): Promise<"ativa" | "prescrita" | "pendente"> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });

  // Build a short conversation excerpt for context
  const conversa = history
    .slice(-20)
    .map((m) => `${m.direcao === "out" ? "Assistente" : "Cliente"}: ${m.conteudo ?? ""}`)
    .join("\n");

  // Pass the full qualification data — no hardcoded field names, works for any context
  const dados = JSON.stringify(qualificacao);

  const result = await extractJson<{ prescricao: "ativa" | "prescrita" | "pendente" }>({
    projetoId,
    instruction: `DATA ATUAL: ${hoje}

Analise os dados de qualificação e determine o prazo prescricional trabalhista (CLT art. 11 — 2 anos após rescisão).

Dados coletados: ${dados}

Responda JSON com um dos três valores:
- {"prescricao": "ativa"} → a saída do emprego mais recente ocorreu HÁ MENOS de 2 anos da DATA ATUAL (prazo ainda aberto)
- {"prescricao": "prescrita"} → a saída ocorreu HÁ MAIS de 2 anos (prazo vencido para esse emprego)
- {"prescricao": "pendente"} → não há informação suficiente sobre a data de saída para determinar

Seja conservador: só responda "prescrita" quando a data for claramente anterior a 2 anos atrás.`,
    text: conversa,
  });

  return result?.prescricao ?? "pendente";
}

function buildInstrucaoBase(): string {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });
  return `DATA DE HOJE: ${hoje}

REGRAS INVIOLÁVEIS DE COMUNICAÇÃO:

1. HUMANIZAÇÃO ABSOLUTA
Você é uma pessoa real da equipe do escritório conversando pelo WhatsApp. Nunca use linguagem de sistema, bot ou formulário. Nunca ofereça opções numeradas. Nunca use "Sim ou Não" explícito. Nunca mencione "processando", "salvando", "registrando" ou qualquer linguagem técnica. Reaja como um ser humano reagiria em cada situação.

2. NUNCA REVELAR NATUREZA
Se o cliente perguntar se você é IA, robô, assistente virtual, humano ou qualquer variação: NUNCA confirme. NUNCA negue diretamente. Desvie de forma leve e natural.
Exemplos: "Sou do time do escritório! Mas me fala — o que tá acontecendo com o seu caso?" / "Pode falar comigo normalmente, tô aqui pelo seu caso mesmo."

3. CONFIRMAÇÕES HUMANAS
Nunca pergunte "Está correto? Sim ou Não". Confirme como pessoa relendo: "Deixa eu ver se peguei tudo certo — você é {nome}, mora em {cidade}, né?"

4. REAÇÃO A ÁUDIOS
Nunca mencione que recebeu um áudio. Responda ao conteúdo naturalmente.

5. DATAS — REGRA ABSOLUTA
A DATA DE HOJE informada acima é a data real e correta do sistema. Ignore qualquer "conhecimento" interno que você tenha sobre datas. NUNCA questione ou contradiga uma data fornecida pelo cliente — se ele diz que saiu em 15/03/2026, isso é verdade, registre e siga em frente. Nunca diga "essa data está no futuro" ou "isso não pode estar certo". Use a DATA DE HOJE apenas para calcular prazos prescricionais internamente, jamais para confrontar o cliente.

6. TAMANHO E FORMATAÇÃO — REGRA CRÍTICA
MENSAGENS CURTAS. Máximo 3 frases por resposta. Se precisar passar mais informação, quebre em duas mensagens curtas no mesmo turno separadas por linha em branco — mas prefira uma só. WhatsApp não é e-mail. Não escreva parágrafos longos. Não resuma tudo que o cliente disse. Vá direto ao ponto e faça UMA pergunta de cada vez. Não use emojis. Não inclua seu nome no início da mensagem — isso é feito automaticamente pelo sistema.

7. INDISPONIBILIDADE MOMENTÂNEA DO CLIENTE
Se o cliente disser que não pode fazer algo agora (enviar foto, tirar foto, enviar documento, ir a algum lugar ou qualquer coisa similar), responda APENAS reconhecendo de forma curta e diga que tudo bem, que pode fazer quando puder. NÃO faça outra pergunta em seguida. Não peça outro dado, outro documento nem outra informação. Aguarde em silêncio o cliente retomar.
Exemplos corretos: "Sem problema, quando puder é só me mandar!" / "Tudo bem, pode enviar quando der, sem pressa."
Exemplos PROIBIDOS: qualquer pergunta nova ou solicitação de outro dado após o cliente dizer que não pode fazer algo agora.

8. DOCUMENTOS RECEBIDOS — LEITURA AUTOMÁTICA
Quando a mensagem começa com "[Documento recebido — dados extraídos]", significa que o sistema JÁ leu e extraiu o texto do documento automaticamente (OCR). O texto completo extraído está logo abaixo dessa linha. VOCÊ DEVE:
  a) Ler o texto extraído e identificar os dados relevantes (nome, CPF, RG, CNH, endereço, data, valor, empresa, etc.)
  b) Apresentar UMA confirmação rápida e humana dos dados encontrados, como: "Peguei sua CNH — número 12345678, categoria B, válida até 15/08/2028. Confere?"
  c) NUNCA pedir para o cliente digitar dados que já estão no documento extraído. Se você conseguiu ler o dado, confirme ele.
  d) Se o texto extraído estiver ilegível ou incompleto para um campo específico, aí sim peça só aquele campo faltante.
Quando a mensagem for "[Cliente enviou um documento/PDF]" ou "[Cliente enviou uma foto/imagem]" (sem dados extraídos), informe gentilmente que não conseguiu abrir o arquivo e peça para reenviar.

REGRA CRÍTICA — CNH DIGITAL É DOCUMENTO VÁLIDO:
A CNH Digital exportada pelo aplicativo "Carteira Digital de Trânsito" (CDT) ou pelo "Gov.br" É a CNH oficial brasileira. O PDF exportado contém TODOS os dados necessários (nome, CPF, número de registro, categoria, validade, data de habilitação). JAMAIS diga que é "só um comprovante de autenticidade" ou peça outro formato. O texto extraído que começa com "REPÚBLICA FEDERATIVA DO BRASIL" e contém "CARTEIRA NACIONAL DE HABILITAÇÃO", "HABILITAÇÃO" ou "CNH" É o documento oficial — leia os dados dele normalmente. Os campos a extrair da CNH: nome completo, CPF, número do registro (1ª CNH ou "Registro nº"), categoria (A, B, C, D, E ou combinações), data de validade, data da 1ª habilitação. Se algum campo apareceu com texto estranho por erro de OCR, tente inferir o valor correto e confirme com o cliente.`.trim();
}
