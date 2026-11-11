/**
 * Document extractor — multi-provider pipeline for extractDocumentJson and extractMediaData.
 * Orchestrates ocr-providers.ts with fallback logic and CPF/RG validation.
 * No LLM calls (extractJson). No DB access.
 *
 * Note: this module was split from the 1.5 ocr-providers scope to keep each file under 200 lines.
 */

import { extractCNHData, type CNHExtractorResult } from "./cnh-extractor.js";
import {
  ocrMistral, ocrMistralCNHAnnotation, ocrGroqVision, ocrGroqVisionJson, ocrClaudeVisionJson,
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

/**
 * Leitura DETERMINÍSTICA de CNH — MRZ + tesseract + regex, com validação de
 * dígito do CPF. Nenhuma chamada de IA. Serve tanto para o PDF da CNH digital
 * (dados nos JPEGs embarcados) quanto para a foto da CNH física.
 * Devolve null quando não conseguiu nada de útil, para o chamador cair no fallback.
 */
async function extrairCnhLocalmente(
  buffer: Buffer,
  mimetype: string,
  subtipo: "CNH_E" | "CNH_FOTO",
): Promise<DocJsonResult | null> {
  try {
    const py: CNHExtractorResult = await extractCNHData(buffer, undefined, { mimetype, usarIa: false });
    if (!py.nome && !py.cpf && !py.rg) return null;

    let cpf = py.cpf ?? null;
    let rg  = py.rg  ?? null;
    if (cpf && !validarCPF(cpf)) {
      if (rg && validarCPF(rg)) { [cpf, rg] = [rg, cpf]; } else { cpf = null; }
    }
    if (cpf) cpf = formatCpf(cpf);
    return {
      tipo_documento: "CNH", subtipo, nome: py.nome ?? null, cpf, rg,
      orgao_emissor_rg: py.orgao_emissor_rg ?? null, uf_emissor_rg: py.uf_emissor_rg ?? null,
      data_nascimento: py.data_nascimento ?? null, local_nascimento: py.local_nascimento ?? null,
      // `naturalidade` (naturalidade/local de nascimento) e `nacionalidade` (BRASILEIRA) são
      // conceitos diferentes — antes o valor de nacionalidade era jogado no campo naturalidade
      // e nunca chegava em CAMPOS_PESSOAIS (coleta-docs-context.ts), então cd_nacionalidade
      // sempre perguntava de novo mesmo com a CNH já lida.
      naturalidade: null, nacionalidade: py.nacionalidade ?? null, filiacao_pai: py.filiacao_pai ?? null,
      filiacao_mae: py.filiacao_mae ?? null,
      pis: null, numero_ctps: null, serie_ctps: null, endereco: null, bairro: null, cidade: null, uf: null, cep: null,
    };
  } catch { return null; }
}

/** Aceita o resultado local de imediato só quando o CPF passou na validação —
 *  é o campo que inviabiliza a procuração se vier errado. */
function localSuficiente(r: DocJsonResult | null): boolean {
  return !!(r && r.cpf && validarCPF(r.cpf));
}

async function extractDocFromPdf(
  keys: OcrKeys,
  buffer: Buffer,
): Promise<DocJsonResult | null> {
  // Estratégia 1: extrator local (MRZ + tesseract). Sem IA, sem custo.
  const local = await extrairCnhLocalmente(buffer, "application/pdf", "CNH_E");
  if (localSuficiente(local)) return local;

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
  // Último caso é OUTRO, não CNH: o default anterior arquivava como CNH todo PDF cuja leitura
  // falhasse — comprovante de rendimentos, rescisão e CTPS digital entraram no acervo como CNH,
  // e o loader do coleta_docs trata CNH como documento de identidade confiável, puxando
  // nome/CPF/RG de um papel que não os tem.
  const corpus = sources.join(" ").toUpperCase();
  const tipoFallback: DocJsonResult["tipo_documento"] = visionJson?.tipo_documento ?? (
    corpus.includes("HABILITAÇÃO") || corpus.includes("HABILITACAO") || corpus.includes("CNH") ? "CNH" :
    corpus.includes("CARTEIRA DE TRABALHO") || corpus.includes("CTPS") ? "CTPS" :
    corpus.includes("REGISTRO GERAL") || corpus.includes("CARTEIRA DE IDENTIDADE") ? "RG" :
    corpus.includes("COMPROVANTE DE ENDEREÇO") || corpus.includes("COMPROVANTE DE RESIDÊNCIA") ? "COMPROVANTE_ENDERECO" :
    "OUTRO"
  );

  // Nada melhor apareceu: se o extrator local trouxe algo (nome/RG mesmo sem CPF),
  // ele vale mais que um fallback de visão vazio.
  if (local && !cpf && !visionJson?.nome) return local;

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
  "data_nascimento", "local_nascimento", "naturalidade", "nacionalidade",
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
    ? new Set(["rg", "orgao_emissor_rg", "uf_emissor_rg", "nome", "data_nascimento", "local_nascimento", "filiacao_pai", "filiacao_mae", "nacionalidade"])
    : new Set<string>();

  // COMPROVANTE_ENDERECO: address fields always overwrite (more authoritative than self-reported)
  const isComprovante  = docJson.tipo_documento === "COMPROVANTE_ENDERECO";
  const camposEndereco = new Set(["endereco", "bairro", "cidade", "uf", "cep"]);

  const novosDocFields: Record<string, unknown> = {};
  for (const campo of DOC_CAMPOS) {
    const val = docFixed[campo];
    if (!val) continue;
    if (campo === "cpf") {
      if (validarCPF(val as string) && m.cpf !== val) {
        m.cpf = val; novosDocFields.cpf = val;
        m[`_pf_cpf`] = val; novosDocFields[`_pf_cpf`] = val;
      }
    } else if (camposSempre.has(campo) || (isComprovante && camposEndereco.has(campo))) {
      if (m[campo] !== val) {
        m[campo] = val; novosDocFields[campo] = val;
        m[`_pf_${campo}`] = val; novosDocFields[`_pf_${campo}`] = val;
      }
    } else if (!m[campo]) {
      m[campo] = val; novosDocFields[campo] = val;
      m[`_pf_${campo}`] = val; novosDocFields[`_pf_${campo}`] = val;
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

  // Image path (foto de documento): Claude Vision → Mistral CNH annotation → Groq Vision JSON → null.
  // Normaliza subtipo + valida/troca CPF↔RG antes de devolver.
  const normalize = (r: DocJsonResult | null): DocJsonResult | null => {
    if (!r) return null;
    if (r.tipo_documento === "CNH") r.subtipo = "CNH_FOTO";
    if (r.cpf && !validarCPF(r.cpf)) {
      if (r.rg && validarCPF(r.rg)) { [r.cpf, r.rg] = [r.rg, r.cpf]; }
      else { r.cpf = null; }
    }
    return r;
  };

  // Extrator local primeiro (MRZ + tesseract + validação de CPF): resolve a foto de CNH
  // sem gastar IA. Só se ele não fechar um CPF válido é que os provedores entram.
  const local = await extrairCnhLocalmente(buffer, mimetype, "CNH_FOTO");
  if (localSuficiente(local)) return local;

  // Claude Vision primeiro: melhor extração de CPF/RG em foto de CNH. Só aceita de imediato se trouxe
  // CPF válido (o ponto fraco do Groq); senão guarda o parcial e tenta os outros provedores.
  let claudeFallback: DocJsonResult | null = null;
  if (keys.anthropicKey) {
    const r = normalize(await ocrClaudeVisionJson(keys.anthropicKey, buffer, mimetype).catch(() => null));
    if (r && r.cpf && validarCPF(r.cpf)) return r;
    if (r && (r.nome || r.rg)) claudeFallback = r;
  }
  if (keys.mistralKey) {
    const result = await ocrMistralCNHAnnotation(keys.mistralKey, buffer, mimetype).catch(() => null);
    if (result && (result.nome || result.cpf || result.rg)) return normalize(result);
  }
  if (keys.groqKey) {
    const result = normalize(await ocrGroqVisionJson(keys.groqKey, buffer, mimetype).catch(() => null));
    if (result && (result.cpf || result.nome || result.rg)) return result;
  }
  // Nenhum trouxe CPF válido — devolve o melhor parcial que houver (Claude ou o local).
  return claudeFallback ?? local;
}

function sanitizeOcrText(text: string): string {
  // Remove lines with "Não disponível", "N/A", "?" for any field — prevents LLM hallucination
  return text
    .split("\n")
    .filter(line => !/:\s*(n[aã]o\s*dispon[ií]vel|não\s*informado|n\/a|\?+)\s*$/i.test(line))
    .join("\n")
    .trim();
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
        const clean = sanitizeOcrText(mistralText.replace(/!\[.*?\]\(.*?\)/g, "").trim());
        if (clean.length > 30) return clean;
      }
    }
    if (keys.groqKey && !isPdf) {
      const groqResult = await ocrGroqVision(keys.groqKey, buffer, mimetype);
      return groqResult ? sanitizeOcrText(groqResult) : null;
    }
    return ocrTesseract(buffer, mimetype);
  } catch (e: any) {
    console.warn(`[DocExtract] Falha na extração (${mimetype}): ${e?.message}`);
    return null;
  }
}
