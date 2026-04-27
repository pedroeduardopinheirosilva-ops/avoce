/**
 * Qualification module — OCR, document extraction, and employment link (vínculo) collection.
 * All data-extraction functions isolated here so stage-engine stays an orchestrator.
 */

import { prisma } from "../db.js";
import { extractJson } from "./llm.js";
import { extractCNHData, type CNHExtractorResult } from "./cnh-extractor.js";
import Groq from "groq-sdk";
import type { VinculoCalculo } from "./calc-trabalhista.js";

// ──────────────────────────────────────────────────────────────────────────────
// OCR prompts
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────

export type DocJsonResult = {
  tipo_documento: "CNH" | "RG" | "CTPS" | "COMPROVANTE_ENDERECO" | "OUTRO";
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

export interface VinculoEmprego {
  ordem: number;
  empresa?: string;
  funcao?: string;
  vinculo?: string;
  tempo?: string;
  data_saida?: string;
  saida?: string;
  horas_extras?: string;
  pagamento_fora?: string;
  injustica?: string;
  frota?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// CPF validation
// ──────────────────────────────────────────────────────────────────────────────

export function validarCPF(cpf: string): boolean {
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

// ──────────────────────────────────────────────────────────────────────────────
// Sprint 2 helpers — dados mínimos para cálculo de valor de causa
// ──────────────────────────────────────────────────────────────────────────────

export function temDadosMinimosCalculo(merged: Record<string, unknown>): boolean {
  const vinculos = Array.isArray(merged.vinculos) ? merged.vinculos as any[] : [];
  if (vinculos.length > 0) {
    return vinculos.some(v =>
      v.empresa &&
      (v.salario_total_declarado || v.salario_holerite || v.salario_por_fora)
    );
  }
  const temEmpresa = !!(merged.empresa_recente || merged.empresa_principal);
  const temSalario = !!(merged.salario_total_declarado || merged.salario_holerite);
  return temEmpresa && temSalario;
}

export function extractVinculosFromMerged(merged: Record<string, unknown>): VinculoCalculo[] {
  const vinculosRaw = Array.isArray(merged.vinculos) ? merged.vinculos as any[] : [];
  if (vinculosRaw.length > 0) {
    return vinculosRaw.map(v => ({
      empresa: String(v.empresa ?? "Empresa não informada"),
      funcao: String(v.funcao ?? "Função não informada"),
      vinculo: (v.vinculo === "CLT" || v.vinculo === "PJ" || v.vinculo === "autonomo" || v.vinculo === "informal")
        ? v.vinculo : "CLT",
      data_admissao: v.data_admissao ?? undefined,
      data_saida: v.data_saida ?? undefined,
      tempo_meses_estimado: v.tempo_meses_estimado ? Number(v.tempo_meses_estimado) : undefined,
      salario_holerite: v.salario_holerite ? Number(v.salario_holerite) : undefined,
      salario_por_fora: v.salario_por_fora ? Number(v.salario_por_fora) : undefined,
      salario_total_declarado: v.salario_total_declarado ? Number(v.salario_total_declarado) : undefined,
      jornada_inicio: v.jornada_inicio ?? undefined,
      jornada_fim: v.jornada_fim ?? undefined,
      intervalo_minutos: v.intervalo_minutos ? Number(v.intervalo_minutos) : undefined,
      horas_extras_pagas: v.horas_extras_pagas ?? (v.horas_extras === false ? false : undefined),
      modalidade_saida: v.modalidade_saida ?? undefined,
      injustica_relatada: v.injustica ?? v.injustica_relatada ?? undefined,
      frota_empresa: v.frota ? Number(v.frota) : undefined,
    }));
  }
  return [{
    empresa: String(merged.empresa_recente ?? merged.empresa_principal ?? "Empresa não informada"),
    funcao: String(merged.funcao ?? "Função não informada"),
    vinculo: "CLT",
    salario_total_declarado: merged.salario_total_declarado ? Number(merged.salario_total_declarado) : undefined,
    salario_holerite: merged.salario_holerite ? Number(merged.salario_holerite) : undefined,
  }];
}

// ──────────────────────────────────────────────────────────────────────────────
// OCR functions — multi-provider
// ──────────────────────────────────────────────────────────────────────────────

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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: documentPayload,
      include_image_base64: true,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Mistral OCR ${res.status}: ${err.slice(0, 200)}`);
  }

  type MistralPage = { markdown?: string; images?: { id: string; image_base64?: string; image_annotation?: string }[] };
  const json = (await res.json()) as { pages?: MistralPage[] };

  let text = (json.pages ?? []).map((p: MistralPage) => p.markdown ?? "").filter(Boolean).join("\n\n") || null;

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
  const base64 = buffer.toString("base64");
  const isPdf = mimetype === "application/pdf";

  if (isPdf) return null;

  const prompt =
    "Este é um documento de identidade brasileiro (CNH, RG ou similar). " +
    "Extraia os seguintes campos em JSON: " +
    "nome (campo NOME), cpf (campo CPF, 11 dígitos), rg (campo IDENTIDADE ou RG — NÃO o Nº Registro da habilitação), " +
    "orgao_expedidor (sigla ao lado do RG, ex: SSP/BA), uf_rg (UF do órgão), " +
    "data_nascimento (DD/MM/AAAA), filiacao_pai, filiacao_mae. " +
    "REGRA: CPF e RG têm rótulos DIFERENTES — nunca coloque o mesmo valor nos dois. " +
    "NUNCA confunda 'Nº Registro' (registro de habilitação) com RG/IDENTIDADE. " +
    "Retorne APENAS JSON válido.";

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
          schema: {
            type: "object",
            properties: {
              nome:            { type: ["string", "null"] },
              cpf:             { type: ["string", "null"] },
              rg:              { type: ["string", "null"] },
              orgao_expedidor: { type: ["string", "null"] },
              uf_rg:           { type: ["string", "null"] },
              data_nascimento: { type: ["string", "null"] },
              filiacao_pai:    { type: ["string", "null"] },
              filiacao_mae:    { type: ["string", "null"] },
            },
          },
        },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Mistral Annotation ${res.status}: ${err.slice(0, 200)}`);
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
    await execFileAsync(
      "pdftoppm",
      ["-jpeg", "-r", "300", "-f", "1", "-l", "1", tmpIn, tmpOut],
      { timeout: 30_000 },
    );
    const dir = tmpdir();
    const prefix = `pdf-pg-${ts}-`;
    const files = (await readdir(dir)).filter((f: string) => f.startsWith(prefix) && f.endsWith(".jpg"));
    if (!files.length) return null;
    const img = await readFile(join(dir, files[0]));
    for (const f of files) unlink(join(dir, f)).catch(() => {});
    return img;
  } catch (e: any) {
    console.warn(`[DocExtract] pdftoppm falhou: ${e?.message}`);
    return null;
  } finally {
    unlink(tmpIn).catch(() => {});
  }
}

export async function ocrGroqVision(apiKey: string, buffer: Buffer, mimetype: string): Promise<string | null> {
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

export async function ocrGroqVisionJson(apiKey: string, buffer: Buffer, mimetype: string): Promise<DocJsonResult | null> {
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

export async function ocrTesseract(buffer: Buffer, mimetype: string): Promise<string | null> {
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
    await execFileAsync("tesseract", [tmpIn, tmpOut, "-l", "por+eng", "--oem", "1", "--psm", "3"], { timeout: 30000 });
    const text = await readFile(`${tmpOut}.txt`, "utf8");
    return text.trim() || null;
  } catch (e: any) {
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

// ──────────────────────────────────────────────────────────────────────────────
// High-level document extraction
// ──────────────────────────────────────────────────────────────────────────────

export async function extractDocumentJson(
  opts: { groqKey: string; mistralKey: string; anthropicKey?: string },
  buffer: Buffer,
  mimetype: string,
): Promise<DocJsonResult | null> {
  const { groqKey, mistralKey, anthropicKey } = opts;
  const isPdf = mimetype === "application/pdf";

  if (isPdf) {
    try {
      const pyResult: CNHExtractorResult = await extractCNHData(buffer, anthropicKey || undefined);
      const hasDados = pyResult.nome || pyResult.cpf || pyResult.rg;
      if (hasDados) {
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
      const isNotCnhe = pyErr?.message?.includes("não contém imagens") || pyErr?.message?.includes("suficiente");
      console.warn(`[DocExtract] Python extractor falhou (${isNotCnhe ? "não é CNH-e" : pyErr?.message}) — fallback Vision`);
    }

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

  if (mistralKey) {
    const mistralResult = await ocrMistralCNHAnnotation(mistralKey, buffer, mimetype).catch((e: any) => {
      console.warn(`[DocExtract] Mistral CNH Annotation falhou: ${e?.message}`);
      return null;
    });
    if (mistralResult && (mistralResult.nome || mistralResult.cpf || mistralResult.rg)) {
      return mistralResult;
    }
  }

  if (groqKey) {
    const result = await ocrGroqVisionJson(groqKey, buffer, mimetype).catch((e: any) => {
      console.warn(`[DocExtract] Groq Vision JSON falhou: ${e?.message}`);
      return null;
    });
    if (result) {
      if (result.tipo_documento === "CNH") result.subtipo = "CNH_FOTO";
      console.log(`[DocExtract] Vision JSON (img): tipo=${result.tipo_documento} subtipo=${result.subtipo} cpf=${result.cpf} rg=${result.rg}`);
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

export async function extractMediaData(
  opts: { groqKey: string; mistralKey: string },
  buffer: Buffer,
  mimetype: string,
): Promise<string | null> {
  const { groqKey, mistralKey } = opts;
  const isPdf = mimetype === "application/pdf";

  try {
    if (isPdf && groqKey) {
      const pageImg = await pdfPrimeiraPagemParaJpeg(buffer);
      if (pageImg) {
        const result = await ocrGroqVision(groqKey, pageImg, "image/jpeg").catch(() => null);
        if (result) return result;
      }
    }

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

    if (groqKey && !isPdf) {
      const result = await ocrGroqVision(groqKey, buffer, mimetype);
      if (result) return result;
    }

    const result = await ocrTesseract(buffer, mimetype);
    return result;

  } catch (e: any) {
    console.warn(`[DocExtract] Falha na extração (${mimetype}): ${e?.message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Qualification data extraction from conversation
// ──────────────────────────────────────────────────────────────────────────────

export async function extractQualificacaoData(
  projetoId: string,
  text: string,
  perguntas: { chave: string; perguntaContexto: string; tipoDado: string }[],
  merged: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  const pendingPerguntas = perguntas.filter(p => merged[p.chave] === undefined || merged[p.chave] === null);
  if (pendingPerguntas.length === 0) return null;

  const pendingStr = pendingPerguntas
    .map((p) => `"${p.chave}" /* ${p.perguntaContexto} */: ${p.tipoDado === "booleano" ? "true/false/null" : '"valor ou null"'}`)
    .join(", ");

  return extractJson({
    projetoId,
    instruction: `Analise a conversa abaixo e extraia os campos solicitados com base no que o CLIENTE respondeu. Use null quando não mencionado ou resposta ambígua.\nCampos: {${pendingStr}}`,
    text,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Vinculos helpers
// ──────────────────────────────────────────────────────────────────────────────

export function syncVinculosFromFlat(
  vinculos: VinculoEmprego[],
  merged: Record<string, unknown>,
): { vinculos: VinculoEmprego[]; changed: boolean } {
  if (vinculos.length === 0) return { vinculos, changed: false };

  const str = (v: unknown) => (v !== undefined && v !== null && v !== "" ? String(v) : undefined);

  let changed = false;
  const updated = vinculos.map((v, i) => {
    const patch: Partial<VinculoEmprego> = {};

    if (i === 0) {
      if (!v.empresa)    patch.empresa    = str(merged.empresa_principal ?? merged.empresa_recente);
      if (!v.funcao)     patch.funcao     = str(merged.funcao_recente);
      if (!v.vinculo)    patch.vinculo    = str(merged.vinculo_recente)
                                          ?? (merged.e_clt === true ? "carteira assinada" : undefined);
      if (!v.saida)      patch.saida      = str(merged.saida_recente);
      if (!v.tempo)      patch.tempo      = str(merged.tempo_recente);
      if (!v.data_saida) patch.data_saida = str(merged.data_saida_recente);
      if (!v.frota)      patch.frota      = str(merged.frota_recente ?? merged.frota);
    } else if (i === 1) {
      const flatEmpresa = str(merged.emprego_anterior_empresa ?? merged.empresa_anterior);
      const normalize = (s: string) =>
        s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
      const empresaMatch = flatEmpresa && v.empresa &&
        (normalize(flatEmpresa).includes(normalize(v.empresa)) ||
         normalize(v.empresa).includes(normalize(flatEmpresa)));

      if (empresaMatch) {
        if (!v.funcao)     patch.funcao     = str(merged.emprego_anterior_funcao  ?? merged.funcao_anterior);
        if (!v.vinculo)    patch.vinculo    = str(merged.emprego_anterior_vinculo ?? merged.clt_anterior);
        if (!v.saida)      patch.saida      = str(merged.emprego_anterior_saida   ?? merged.saida_anterior);
        if (!v.tempo)      patch.tempo      = str(merged.emprego_anterior_tempo   ?? merged.tempo_anterior);
        if (!v.frota)      patch.frota      = str(merged.frota_anterior);
      }
    }

    const effectivePatch = Object.fromEntries(
      Object.entries(patch).filter(([, val]) => val !== undefined),
    ) as Partial<VinculoEmprego>;

    if (Object.keys(effectivePatch).length === 0) return v;
    changed = true;
    return { ...v, ...effectivePatch };
  });

  return { vinculos: updated, changed };
}

export async function tryExtractVinculo(
  projetoId: string,
  text: string,
  vinculos: VinculoEmprego[],
  historiaTexto: string,
  maisEmpregosConfirmado = false,
  maisEmpregosPerguntado = false,
): Promise<{ vinculo: VinculoEmprego | null; semMaisEmpregos: boolean; updatedVinculos: VinculoEmprego[]; confirmouMaisEmpregos: boolean }> {
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
    confirmou_mais_empregos?: boolean;
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
1. Preencha campos null dos vínculos existentes com informações mencionadas no texto.
2. Se o cliente mencionou um emprego DIFERENTE dos já listados, inclua em "novo_vinculo". SE O ARRAY ESTÁ VAZIO ([]) e o cliente mencionou qualquer empresa/empregador, coloque OBRIGATORIAMENTE em "novo_vinculo".
3. Marque "sem_mais_empregos": true SOMENTE se ${maisEmpregosPerguntado ? "a pergunta sobre empregos anteriores foi feita e" : "(ATENÇÃO: a pergunta sobre empregos anteriores NÃO foi feita ainda — portanto NUNCA marque true neste turno, mesmo que o cliente use palavras como 'por último' ou 'meu último emprego') e"} o cliente indicou que não tem mais empregos. REGRAS (quando a pergunta foi feita):
   - Se o cliente começar com "não", "nao", "não trabalhei", "só esses", "foi só" → marque true.
   - Se o cliente mencionar uma empresa que JÁ ESTÁ na lista de vínculos → marque true (está descrevendo trajetória já coletada).
   - NUNCA inferir de frases passivas como "por último", "meu último emprego", "saí de lá e" — essas frases NÃO confirmam ausência de empregos anteriores.
4. Marque "confirmou_mais_empregos": true quando o cliente confirmou que teve outro emprego mas NÃO deu o nome ainda (ex: "sim", "sim trabalhei", "tive mais", "trabalhei sim", "tinha outro"). Só marque true se NÃO colocou o nome em novo_vinculo.
${maisEmpregosConfirmado ? `
MODO MAIS EMPREGOS ATIVO: o cliente já confirmou que trabalhou em outra empresa ANTES das já listadas. A mensagem atual é a resposta dele dando o nome desse emprego anterior. REGRA ABSOLUTA:
- Qualquer nome de empresa que o cliente mencionar DEVE ir para "novo_vinculo", MESMO que seja igual ou parecido com um já listado (a pessoa pode ter trabalhado na mesma empresa em períodos diferentes).
- NÃO tente deduplicar pelo nome — crie novo_vinculo com o nome que o cliente disse.
- Se o cliente não der um nome claro, marque confirmou_mais_empregos: true para continuar pedindo.` : ""}

REGRAS CRÍTICAS DE PREENCHIMENTO:
- NUNCA deixe um campo como null se o cliente respondeu sobre ele, mesmo que com "não", "nenhum", "sim", "normal".
- "não" é uma resposta válida. Ex: cliente disse "não tinha horas extras" → horas_extras = "não tinha horas extras".
- "sim" genérico = capture o contexto. Ex: "sim, recebia por Pix" → pagamento_fora = "sim, recebia por Pix".
- Capture o máximo possível do que o cliente disse, mesmo que incompleto.
- Para "saida": se o cliente ainda está empregado → saida = "ainda empregado". Se foi demitido → saida = "demitido em [data/período]". Se pediu demissão → saida = "pediu demissão".

CAMPOS A EXTRAIR (para cada vínculo):
- empresa: nome da empresa
- funcao: cargo/função exercida
- vinculo: "CLT" | "autônomo" | "avulso" | "cooperado"
- tempo: tempo total de trabalho lá
- data_saida: data de rescisão/demissão no formato DD/MM/AAAA ou MM/AAAA — CRÍTICO para prescrição
- saida: como e quando saiu (demitido, pediu demissão, ainda empregado, etc)
- horas_extras: horas extras além da jornada normal. Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- pagamento_fora: pagamentos fora do holerite (PIX, Pamcard, dinheiro). Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- injustica: irregularidades sofridas. Só preencha se o cliente mencionou EXPLICITAMENTE. Se não mencionou: DEIXE NULL.
- frota: tamanho da frota da empresa (se mencionado)

Responda APENAS JSON no formato:
{
  "sem_mais_empregos": false,
  "confirmou_mais_empregos": false,
  "vinculos_atualizados": [
    { "ordem": 1, "empresa": "...", "funcao": null, ... }
  ],
  "novo_vinculo": null
}`,
    text: historiaTexto + "\n\nMensagem atual: " + text,
  });

  if (!result) {
    console.warn(`[tryExtractVinculo] extractJson retornou null — mantendo vinculos anteriores`);
    return { vinculo: null, semMaisEmpregos: false, updatedVinculos: vinculos, confirmouMaisEmpregos: false };
  }

  let updatedVinculos = [...vinculos];
  if (result.vinculos_atualizados?.length) {
    for (const upd of result.vinculos_atualizados) {
      const idx = updatedVinculos.findIndex((v) => v.ordem === upd.ordem);
      if (idx >= 0) {
        const existing = updatedVinculos[idx];
        updatedVinculos[idx] = {
          ...existing,
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

  if (result.sem_mais_empregos) {
    return { vinculo: null, semMaisEmpregos: true, updatedVinculos, confirmouMaisEmpregos: false };
  }

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
    return { vinculo: novoVinculo, semMaisEmpregos: false, updatedVinculos, confirmouMaisEmpregos: false };
  }

  return { vinculo: null, semMaisEmpregos: false, updatedVinculos, confirmouMaisEmpregos: result.confirmou_mais_empregos === true };
}

export async function checkVinculoPrazo(
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

export async function checkPrescricao(
  projetoId: string,
  qualificacao: Record<string, unknown>,
  history: { direcao: string; conteudo: string | null }[]
): Promise<"ativa" | "prescrita" | "pendente"> {
  const hoje = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "America/Sao_Paulo",
  });

  const conversa = history
    .slice(-20)
    .map((m) => `${m.direcao === "out" ? "Assistente" : "Cliente"}: ${m.conteudo ?? ""}`)
    .join("\n");

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
