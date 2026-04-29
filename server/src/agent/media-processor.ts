/**
 * Media Processor — audio transcription + document/image OCR for incoming WhatsApp messages.
 * Returns normalised text + structured doc fields; caller persists everything.
 */

import { prisma } from "../db.js";
import { transcribeAudio, downloadAudioFromEvolution } from "../services/whisper.js";
import { downloadMedia } from "../services/evolution.js";
import { extractDocumentJson, extractMediaData } from "./doc-extractor.js";
import { extractText } from "./webhook-parser.js";
import type { DocJsonResult } from "./types.js";
import type { EvolutionWebhookMessage } from "./webhook-parser.js";

export interface NormalizedInput {
  text: string | null;
  documentosEnviados: boolean;
  docJsonDireto: DocJsonResult | null;
  tipo: string;
}

export async function normalizeInput(projetoId: string, msg: EvolutionWebhookMessage): Promise<NormalizedInput> {
  const isAudio = msg.messageType === "audioMessage" || !!msg.message?.audioMessage;
  const isDocument = msg.messageType === "documentMessage" || !!msg.message?.documentMessage;
  const isImage = !isAudio && (msg.messageType === "imageMessage" || !!msg.message?.imageMessage);
  const tipo = isAudio ? "audio" : (msg.messageType ?? "text");
  let text = extractText(msg);

  if (isAudio) text = await tryTranscribeAudio(projetoId, msg) ?? text;
  if (isDocument || isImage) return { ...await tryExtractDocument(projetoId, msg, isDocument, text), tipo };
  return { text, documentosEnviados: false, docJsonDireto: null, tipo };
}

async function tryTranscribeAudio(projetoId: string, msg: EvolutionWebhookMessage): Promise<string | null> {
  try {
    const audioConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "audio" } });
    const getAudio = (k: string) => audioConfigs.find(c => c.chave === k)?.valor ?? "";
    const audioApiKey = getAudio("audio_api_key");
    if (!audioApiKey) return null;
    const waConfigs = await prisma.iaProjetoConfig.findMany({ where: { projetoId, categoria: "whatsapp" } });
    const getWa = (k: string) => waConfigs.find(c => c.chave === k)?.valor ?? "";
    const evo = { baseUrl: getWa("evolution_api_url").replace(/\/$/, ""), apiKey: getWa("evolution_api_key"), instancia: getWa("evolution_instancia") };
    if (!evo.baseUrl || !evo.apiKey) return null;
    const audio = await downloadAudioFromEvolution(evo.baseUrl, evo.apiKey, evo.instancia, msg);
    if (!audio) return null;
    const result = await transcribeAudio(audio.buffer, audio.mimetype, audioApiKey, getAudio("audio_model") || "whisper-large-v3-turbo", (getAudio("audio_provider") || "groq") as "groq" | "openai");
    if (result.ok && result.text) { console.log(`[Audio] Transcrito: "${result.text.slice(0, 80)}"`); return result.text; }
    console.warn(`[Audio] Falha: ${result.error}`);
    return null;
  } catch (e: any) { console.error(`[Audio] Erro: ${e.message}`); return null; }
}

async function tryExtractDocument(
  projetoId: string, msg: EvolutionWebhookMessage, isDocument: boolean, fallbackText: string | null,
): Promise<{ text: string | null; documentosEnviados: boolean; docJsonDireto: DocJsonResult | null }> {
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
    return { text: extracted ? `[Documento recebido — dados extraídos]\n${extracted}` : fallbackMsg, documentosEnviados: true, docJsonDireto };
  } catch (e: any) {
    console.warn(`[DocExtract] Falha: ${e?.message}`);
    return { text: fallbackText ?? fallbackMsg, documentosEnviados: true, docJsonDireto: null };
  }
}
