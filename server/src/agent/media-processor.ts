/**
 * Media Processor — audio transcription + document/image OCR for incoming WhatsApp messages.
 * Returns normalised text + structured doc fields; caller persists everything.
 */

import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "../db.js";
import { transcribeAudio, downloadAudioFromEvolution } from "../services/whisper.js";
import { downloadMedia } from "../services/evolution.js";
import { extractDocumentJson, extractMediaData } from "./doc-extractor.js";
import { extractText } from "./webhook-parser.js";
import type { DocJsonResult } from "./types.js";
import type { EvolutionWebhookMessage } from "./webhook-parser.js";

const AUDIO_DIR = resolve(process.env.AUDIO_DIR ?? "./audio");

export interface NormalizedInput {
  text: string | null;
  documentosEnviados: boolean;
  docJsonDireto: DocJsonResult | null;
  tipo: string;
  isDocAnalitico: boolean; // true when doc is NOT a personal ID (CNH/RG/CTPS/comprovante) — needs LLM analysis
  mediaBuffer?: Buffer;    // raw bytes for document folder persistence
  mediaMimetype?: string;
  mediaOriginalName?: string;
  midiaUrl?: string;       // served URL for saved audio file (incoming audio messages)
}

const ID_DOC_TIPOS = new Set(["CNH", "RG", "CTPS", "COMPROVANTE_ENDERECO"]);

export async function normalizeInput(projetoId: string, msg: EvolutionWebhookMessage): Promise<NormalizedInput> {
  const isAudio = msg.messageType === "audioMessage" || !!msg.message?.audioMessage;
  const isDocument = msg.messageType === "documentMessage" || !!msg.message?.documentMessage;
  const isImage = !isAudio && (msg.messageType === "imageMessage" || !!msg.message?.imageMessage);
  const tipo = isAudio ? "audio" : (msg.messageType ?? "text");
  let text = extractText(msg);

  let midiaUrl: string | undefined;
  if (isAudio) {
    const audioResult = await tryTranscribeAudio(projetoId, msg);
    text = audioResult.text ?? text;
    midiaUrl = audioResult.midiaUrl;
  }
  if (isDocument || isImage) {
    const result = await tryExtractDocument(projetoId, msg, isDocument, text);
    const isDocAnalitico = result.documentosEnviados &&
      (result.docJsonDireto === null || result.docJsonDireto.tipo_documento === "OUTRO" || !ID_DOC_TIPOS.has(result.docJsonDireto.tipo_documento));
    return { ...result, tipo, isDocAnalitico };
  }
  return { text, documentosEnviados: false, docJsonDireto: null, tipo, isDocAnalitico: false, midiaUrl };
}

/**
 * Baixa o áudio da Evolution, guarda o arquivo para tocar na UI e transcreve.
 * Exportada porque os áudios que o SDR humano grava no próprio WhatsApp (fromMe) passam
 * pelo webhook em index.ts, fora do fluxo do agente, e precisam da mesma transcrição.
 */
export async function tryTranscribeAudio(projetoId: string, msg: EvolutionWebhookMessage): Promise<{ text: string | null; midiaUrl?: string }> {
  try {
    const audioConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "audio" } });
    const getAudio = (k: string) => audioConfigs.find(c => c.chave === k)?.valor ?? "";
    const audioApiKey = getAudio("audio_api_key");
    if (!audioApiKey) return { text: null };
    const waConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "whatsapp" } });
    const getWa = (k: string) => waConfigs.find(c => c.chave === k)?.valor ?? "";
    const evo = { baseUrl: getWa("evolution_api_url").replace(/\/$/, ""), apiKey: getWa("evolution_api_key"), instancia: getWa("evolution_instancia") };
    if (!evo.baseUrl || !evo.apiKey) return { text: null };
    const audio = await downloadAudioFromEvolution(evo.baseUrl, evo.apiKey, evo.instancia, msg);
    if (!audio) return { text: null };

    // Save audio file for playback in the UI
    let midiaUrl: string | undefined;
    try {
      mkdirSync(AUDIO_DIR, { recursive: true });
      const safeId = (msg.key.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
      const ext = audio.mimetype.includes("ogg") ? "ogg" : audio.mimetype.includes("mpeg") ? "mp3" : "ogg";
      const filename = `${safeId}.${ext}`;
      writeFileSync(join(AUDIO_DIR, filename), audio.buffer);
      midiaUrl = `/api/audio/${filename}`;
    } catch (saveErr: any) {
      console.warn(`[Audio] Falha ao salvar arquivo: ${saveErr.message}`);
    }

    const modelo = getAudio("audio_model") || "whisper-large-v3";
    const provider = (getAudio("audio_provider") || "groq") as "groq" | "openai";
    const promptBase = getAudio("audio_prompt") ||
      "Transcrição de conversa sobre direitos trabalhistas de motoristas carreteiros e caminhoneiros. " +
      "Público: trabalhadores do Nordeste brasileiro, especialmente Bahia. Sotaque baiano. " +
      "Termos frequentes: CLT, FGTS, carteira assinada, horas extras, transportadora, rescisão, " +
      "vínculo empregatício, adicional noturno, periculosidade, acidente de trabalho, motorista, " +
      "caminhoneiro, carreteiro, frete, comissão de frete, pedágio, diária, pamcard, folha de ponto, " +
      "jornada, rescisão indireta, Rocha Amorim Pires, escritório, advogado. " +
      "Termos coloquiais: 'lerite' = holerite, 'arretado' = bom/ótimo, 'trem' = coisa, " +
      "'misericórdia' = expressão de espanto. Nomes de transportadoras comuns na região: " +
      "Capelete, Tegma, Cometa, JSL, Rapidão Cometa.";
    const result = await transcribeAudio(audio.buffer, audio.mimetype, audioApiKey, modelo, provider, promptBase);
    if (result.ok && result.text && result.text.trim().length >= 3) {
      console.log(`[Audio] Transcrito: "${result.text.slice(0, 80)}"`);
      return { text: result.text, midiaUrl };
    }
    if (result.ok && result.text) { console.warn(`[Audio] Transcrição descartada (muito curta): "${result.text}"`); return { text: null, midiaUrl }; }
    console.warn(`[Audio] Falha: ${result.error}`);
    return { text: null, midiaUrl };
  } catch (e: any) { console.error(`[Audio] Erro: ${e.message}`); return { text: null }; }
}

async function tryExtractDocument(
  projetoId: string, msg: EvolutionWebhookMessage, isDocument: boolean, fallbackText: string | null,
): Promise<{ text: string | null; documentosEnviados: boolean; docJsonDireto: DocJsonResult | null; mediaBuffer?: Buffer; mediaMimetype?: string; mediaOriginalName?: string }> {
  const fallbackMsg = isDocument ? "[Cliente enviou um documento — leitura automática falhou]" : "[Cliente enviou uma foto/imagem — leitura automática falhou]";
  try {
    const waConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "whatsapp" } });
    const getWa = (k: string) => waConfigs.find(c => c.chave === k)?.valor ?? "";
    const evo = { baseUrl: getWa("evolution_api_url").replace(/\/$/, ""), apiKey: getWa("evolution_api_key"), instancia: getWa("evolution_instancia") };
    if (!evo.baseUrl || !evo.apiKey) return { text: fallbackText, documentosEnviados: true, docJsonDireto: null };

    const mediaBuffer = await downloadMedia(evo, msg.key.id);
    const mimetype = msg.message?.documentMessage?.mimetype ?? (!isDocument ? "image/jpeg" : "application/octet-stream");

    const ocrConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "ocr" } });
    const mistralKey = ocrConfigs.find(c => c.chave === "ocr_mistral_api_key")?.valor ?? "";
    if (!ocrConfigs.length) prisma.iaProjetoConfig.createMany({ data: [{ projetoId, categoria: "ocr", chave: "ocr_mistral_api_key", valor: "", descricao: "API Key Mistral (OCR)" }], skipDuplicates: true }).catch(() => {});

    const groqRow = await prisma.iaLlmProvedor.findFirst({ where: { projetoId, ativo: true, provider: "groq" }, orderBy: { ordem: "asc" } });
    let groqKey = groqRow?.apiKey ?? "";
    if (!groqKey) { const ac = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "audio" } }); groqKey = ac.find(c => c.chave === "audio_api_key")?.valor ?? ""; }
    const anthropicRow = await prisma.iaLlmProvedor.findFirst({ where: { projetoId, ativo: true, provider: "anthropic" }, orderBy: { ordem: "asc" } });
    const anthropicKey = anthropicRow?.apiKey ?? "";

    const [extracted, docJsonDireto] = await Promise.all([
      extractMediaData({ groqKey, mistralKey }, mediaBuffer, mimetype).catch(() => null),
      extractDocumentJson({ groqKey, mistralKey, anthropicKey }, mediaBuffer, mimetype).catch(() => null),
    ]);
    if (docJsonDireto) console.log(`[DocExtract] JSON: tipo=${docJsonDireto.tipo_documento} cpf=${docJsonDireto.cpf} rg=${docJsonDireto.rg}`);
    const originalName = (msg.message?.documentMessage as any)?.fileName ?? null;
    return {
      text: extracted ? `[Documento recebido — dados extraídos]\n${extracted}` : fallbackMsg,
      documentosEnviados: true,
      docJsonDireto,
      mediaBuffer,
      mediaMimetype: mimetype,
      mediaOriginalName: originalName ?? undefined,
    };
  } catch (e: any) {
    console.warn(`[DocExtract] Falha: ${e?.message}`);
    return { text: fallbackText ?? fallbackMsg, documentosEnviados: true, docJsonDireto: null };
  }
}


/** Extensão do arquivo de áudio pelo mime (o navegador grava webm no Chrome e mp4 no Safari). */
export function extensaoAudio(mime: string | undefined | null): string {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("webm")) return "webm";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  return "ogg";
}

/** Guarda um áudio para o player do painel; devolve a midiaUrl (/api/audio/...) ou null. */
export function salvarAudioPainel(buffer: Buffer, id: string, mime: string | undefined | null): string | null {
  try {
    mkdirSync(AUDIO_DIR, { recursive: true });
    const filename = `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extensaoAudio(mime)}`;
    writeFileSync(join(AUDIO_DIR, filename), buffer);
    return `/api/audio/${filename}`;
  } catch (e: any) {
    console.warn(`[Audio] Falha ao salvar arquivo ${id}: ${e.message}`);
    return null;
  }
}
