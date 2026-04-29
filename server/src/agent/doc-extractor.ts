/**
 * Document extractor — multi-provider pipeline for extractDocumentJson and extractMediaData.
 * Orchestrates ocr-providers.ts with fallback logic and CPF/RG validation.
 * No LLM calls (extractJson). No DB access.
 *
 * Note: this module was split from the 1.5 ocr-providers scope to keep each file under 200 lines.
 */

import { extractCNHData, type CNHExtractorResult } from "./cnh-extractor.js";
import {
  ocrMistral, ocrMistralCNHAnnotation, ocrGroqVision, ocrGroqVisionJson,
  ocrTesseract, pdfPrimeiraPagemParaJpeg,
} from "./ocr-providers.js";
import { validarCPF } from "./qualification-utils.js";
import type { DocJsonResult } from "./types.js";

export type OcrKeys = { groqKey: string; mistralKey: string; anthropicKey?: string };

function formatCpf(raw: string): string {
  const d = raw.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}` : raw;
}

function findValidCpf(sources: string[]): string | null {
  for (const src of sources) {
    const candidates = src.match(/\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}|\d{11}/g) ?? [];
    for (const c of candidates) {
      if (validarCPF(c)) return formatCpf(c);
    }
  }
  return null;
}

function findRg(sources: string[]): { rg: string | null; orgao: string | null } {
  for (const src of sources) {
    const rgM = src.match(/(?:IDENTIDADE|Doc\.?\s*Identidade|RG)\s*[:\s*]?\s*([\d./-]{7,15})/i);
    const orgaoM = src.match(/\b(SSP|PC|SESPDC|SESDEC|DETRAN|IFP|IGP)[/\s-]?([A-Z]{2})\b/);
    const rg = rgM ? rgM[1].replace(/\D/g, "") : null;
    if (rg && !validarCPF(rg)) {
      return { rg, orgao: orgaoM ? `${orgaoM[1]}/${orgaoM[2]}` : null };
    }
  }
  return { rg: null, orgao: null };
}

async function extractDocFromPdf(
  keys: OcrKeys,
  buffer: Buffer,
): Promise<DocJsonResult | null> {
  // Strategy 1: Python CNH-e extractor (Claude Vision)
  if (keys.anthropicKey) {
    try {
      const py: CNHExtractorResult = await extractCNHData(buffer, keys.anthropicKey);
      if (py.nome || py.cpf || py.rg) {
        let cpf = py.cpf ?? null;
        let rg  = py.rg  ?? null;
        if (cpf && !validarCPF(cpf)) {
          if (rg && validarCPF(rg)) { [cpf, rg] = [rg, cpf]; } else { cpf = null; }
        }
        if (cpf) cpf = formatCpf(cpf);
        return {
          tipo_documento: "CNH", subtipo: "CNH_E", nome: py.nome ?? null, cpf, rg,
          orgao_emissor_rg: py.orgao_emissor_rg ?? null, uf_emissor_rg: py.uf_emissor_rg ?? null,
          data_nascimento: py.data_nascimento ?? null, local_nascimento: py.local_nascimento ?? null,
          naturalidade: py.nacionalidade ?? null, filiacao_pai: py.filiacao_pai ?? null,
          filiacao_mae: py.filiacao_mae ?? null,
          pis: null, numero_ctps: null, serie_ctps: null, endereco: null, bairro: null, cidade: null, uf: null, cep: null,
        };
      }
    } catch { /* fallthrough */ }
  }

  // Strategy 2: Groq Vision (first page as JPEG) + Mistral OCR (parallel)
  const [pageImg, mistralResult] = await Promise.all([
    keys.groqKey ? pdfPrimeiraPagemParaJpeg(buffer).catch(() => null) : Promise.resolve(null),
    keys.mistralKey ? ocrMistral(keys.mistralKey, buffer, "application/pdf").catch(() => ({ text: null, embeddedImages: [] as { base64: string; mime: string }[] }))
                    : Promise.resolve({ text: null, embeddedImages: [] as { base64: string; mime: string }[] }),
  ]);

  let visionJson: DocJsonResult | null = null;
  let visionText: string | null = null;
  if (pageImg && keys.groqKey) {
    [visionJson, visionText] = await Promise.all([
      ocrGroqVisionJson(keys.groqKey, pageImg, "image/jpeg").catch(() => null),
      ocrGroqVision(keys.groqKey, pageImg, "image/jpeg").catch(() => null),
    ]);
  }

  const sources = [visionText ?? "", visionJson ? JSON.stringify(visionJson) : "", mistralResult.text ?? ""];
  const cpf = findValidCpf(sources);
  const { rg, orgao } = findRg(sources);
  const tipoFallback: DocJsonResult["tipo_documento"] = visionJson?.tipo_documento ?? (
    sources.join(" ").includes("HABILITAÇÃO") || sources.join(" ").includes("CNH") ? "CNH" :
    sources.join(" ").includes("CARTEIRA DE TRABALHO") ? "CTPS" :
    sources.join(" ").includes("REGISTRO GERAL") ? "RG" : "CNH"
  );

  return {
    tipo_documento: tipoFallback, nome: visionJson?.nome ?? null, cpf,
    rg: rg ?? (visionJson?.rg && !validarCPF(visionJson.rg) ? visionJson.rg : null),
    orgao_emissor_rg: orgao ?? visionJson?.orgao_emissor_rg ?? null,
    data_nascimento: visionJson?.data_nascimento ?? null, naturalidade: visionJson?.naturalidade ?? null,
    pis: null, numero_ctps: null, serie_ctps: null, endereco: null, bairro: null, cidade: null, uf: null, cep: null,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

const DOC_CAMPOS = [
  "rg", "orgao_emissor_rg", "uf_emissor_rg", "cpf", "nome",
  "data_nascimento", "local_nascimento", "naturalidade",
  "filiacao_pai", "filiacao_mae",
  "pis", "numero_ctps", "serie_ctps",
  "endereco", "bairro", "cidade", "uf", "cep",
  "estado_civil", "regime_bens",
] as const;

/**
 * Apply structured document JSON (from extractDocumentJson) onto the deal's merged state.
 * Pure function — no DB access. Returns the updated merged and a diff of changed fields.
 */
export function applyDocJsonToMerged(
  docJson: DocJsonResult,
  merged: Record<string, unknown>,
): { updatedMerged: Record<string, unknown>; novosDocFields: Record<string, unknown> } {
  if (docJson.tipo_documento === "OUTRO") return { updatedMerged: merged, novosDocFields: {} };

  const m = { ...merged };

  // Clean pre-existing invalid CPF from a prior failed extraction
  if (m.cpf && typeof m.cpf === "string" && !validarCPF(m.cpf)) {
    console.warn(`[DocExtract] CPF em merged inválido ("${m.cpf}") — limpando`);
    delete m.cpf;
  }

  m._ultimo_doc_tipo    = docJson.tipo_documento;
  m._ultimo_doc_subtipo = docJson.subtipo ?? null;

  // Detect swapped CPF/RG and correct
  let cpfExtraido = docJson.cpf ?? null;
  let rgExtraido  = docJson.rg  ?? null;
  if (cpfExtraido && !validarCPF(cpfExtraido)) {
    if (rgExtraido && validarCPF(rgExtraido)) {
      console.warn(`[DocExtract] CPF inválido ("${cpfExtraido}") e RG parece CPF ("${rgExtraido}") — invertendo`);
      [cpfExtraido, rgExtraido] = [rgExtraido, cpfExtraido];
    } else {
      console.warn(`[DocExtract] CPF extraído inválido: "${cpfExtraido}" — descartando`);
      cpfExtraido = null;
    }
  }
  const docFixed: Record<string, unknown> = { ...docJson, cpf: cpfExtraido, rg: rgExtraido };

  // CNH_E / CNH_FOTO: always overwrite identity fields (corrects prior bad extractions)
  const isCnhConfiavel = docJson.subtipo === "CNH_E" || docJson.subtipo === "CNH_FOTO";
  const camposSempre   = isCnhConfiavel
    ? new Set(["rg", "orgao_emissor_rg", "uf_emissor_rg", "nome", "data_nascimento", "local_nascimento", "filiacao_pai", "filiacao_mae"])
    : new Set<string>();

  // COMPROVANTE_ENDERECO: address fields always overwrite (more authoritative than self-reported)
  const isComprovante  = docJson.tipo_documento === "COMPROVANTE_ENDERECO";
  const camposEndereco = new Set(["endereco", "bairro", "cidade", "uf", "cep"]);

  const novosDocFields: Record<string, unknown> = {};
  for (const campo of DOC_CAMPOS) {
    const val = docFixed[campo];
    if (!val) continue;
    if (campo === "cpf") {
      if (validarCPF(val as string) && m.cpf !== val) { m.cpf = val; novosDocFields.cpf = val; }
    } else if (camposSempre.has(campo) || (isComprovante && camposEndereco.has(campo))) {
      if (m[campo] !== val) { m[campo] = val; novosDocFields[campo] = val; }
    } else if (!m[campo]) {
      m[campo] = val; novosDocFields[campo] = val;
    }
  }

  return { updatedMerged: m, novosDocFields };
}

export async function extractDocumentJson(
  keys: OcrKeys,
  buffer: Buffer,
  mimetype: string,
): Promise<DocJsonResult | null> {
  if (mimetype === "application/pdf") return extractDocFromPdf(keys, buffer);

  // Image path: Mistral CNH annotation → Groq Vision JSON → null
  if (keys.mistralKey) {
    const result = await ocrMistralCNHAnnotation(keys.mistralKey, buffer, mimetype).catch(() => null);
    if (result && (result.nome || result.cpf || result.rg)) return result;
  }
  if (keys.groqKey) {
    const result = await ocrGroqVisionJson(keys.groqKey, buffer, mimetype).catch(() => null);
    if (result) {
      if (result.tipo_documento === "CNH") result.subtipo = "CNH_FOTO";
      if (result.cpf && !validarCPF(result.cpf)) {
        if (result.rg && validarCPF(result.rg)) { [result.cpf, result.rg] = [result.rg, result.cpf]; }
        else { result.cpf = null; }
      }
      return result;
    }
  }
  return null;
}

export async function extractMediaData(
  keys: { groqKey: string; mistralKey: string },
  buffer: Buffer,
  mimetype: string,
): Promise<string | null> {
  const isPdf = mimetype === "application/pdf";
  try {
    if (isPdf && keys.groqKey) {
      const pageImg = await pdfPrimeiraPagemParaJpeg(buffer);
      if (pageImg) {
        const result = await ocrGroqVision(keys.groqKey, pageImg, "image/jpeg").catch(() => null);
        if (result) return result;
      }
    }
    if (keys.mistralKey) {
      const { text: mistralText, embeddedImages } = await ocrMistral(keys.mistralKey, buffer, mimetype);
      if (embeddedImages.length > 0 && keys.groqKey) {
        const parts: string[] = [];
        for (const img of embeddedImages) {
          const vr = await ocrGroqVision(keys.groqKey, Buffer.from(img.base64, "base64"), img.mime).catch(() => null);
          if (vr) parts.push(vr);
        }
        if (parts.length > 0) return parts.join("\n\n");
      }
      if (mistralText) {
        const clean = mistralText.replace(/!\[.*?\]\(.*?\)/g, "").trim();
        if (clean.length > 30) return clean;
      }
    }
    if (keys.groqKey && !isPdf) return ocrGroqVision(keys.groqKey, buffer, mimetype);
    return ocrTesseract(buffer, mimetype);
  } catch (e: any) {
    console.warn(`[DocExtract] Falha na extração (${mimetype}): ${e?.message}`);
    return null;
  }
}
