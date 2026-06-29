/**
 * Evolution API client — WhatsApp sending via Evolution self-hosted
 * Configs loaded from ia_projeto_config per project
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Diretório onde a Evolution API grava os mapeamentos LID por instância
const EVOLUTION_INSTANCES_DIR = "/opt/evolution-capium/instances";

// Cache em memória com TTL de 5min para evitar leituras repetidas de disco
const _lidCache = new Map<string, { lid: string; expiresAt: number }>();

/**
 * Resolve o endereço correto para envio ao lead.
 * Quando o WhatsApp do lead usa LID (novos dispositivos), o número @s.whatsapp.net
 * não é entregue — precisa enviar para {lid}@lid.
 * Lê o arquivo lid-mapping-{phone}.json gerado pela Evolution API ao receber mensagens LID.
 */
async function resolveSendAddress(phone: string): Promise<string> {
  const phoneClean = phone.replace(/@.*/, "");

  const cached = _lidCache.get(phoneClean);
  if (cached && Date.now() < cached.expiresAt) return cached.lid;

  try {
    const dirs = await readdir(EVOLUTION_INSTANCES_DIR);
    for (const dir of dirs) {
      const lidFile = join(EVOLUTION_INSTANCES_DIR, dir, `lid-mapping-${phoneClean}.json`);
      try {
        const content = await readFile(lidFile, "utf-8");
        const lid = JSON.parse(content.trim());
        if (lid && typeof lid === "string" && lid !== "lid") {
          const address = `${lid}@lid`;
          _lidCache.set(phoneClean, { lid: address, expiresAt: Date.now() + 5 * 60_000 });
          return address;
        }
      } catch {
        // arquivo não existe para este dir — continuar
      }
    }
  } catch {
    // diretório de instâncias não acessível — usar número normal
  }

  return phoneClean; // fallback: número sem LID
}

const execFileAsync = promisify(execFile);

async function convertToOggOpus(inputBase64: string, inputMime: string): Promise<string> {
  const ext = inputMime.split("/")[1]?.split(";")[0] ?? "webm";
  const inPath  = join(tmpdir(), `avoce_audio_${Date.now()}.${ext}`);
  const outPath = join(tmpdir(), `avoce_audio_${Date.now()}.ogg`);
  try {
    await writeFile(inPath, Buffer.from(inputBase64, "base64"));
    await execFileAsync("ffmpeg", ["-y", "-i", inPath, "-c:a", "libopus", "-b:a", "64k", outPath]);
    const outBuf = await readFile(outPath);
    return outBuf.toString("base64");
  } finally {
    unlink(inPath).catch(() => {});
    unlink(outPath).catch(() => {});
  }
}

export interface EvolutionConfig {
  baseUrl: string;
  apiKey: string;
  instancia: string;
}

interface SendTextResult {
  key: { id: string };
  status: string;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`Evolution API timeout após ${timeoutMs}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(id);
  }
}

// ── Suporte a QA: números de teste (prefixo 5500990000 — DDD "00" jamais é real) ──
// O envio é simulado (no-op) para que o processamento do funil rode até o fim sem o
// Evolution rejeitar o número inexistente (400 exists:false) e abortar a mensagem.
const TEST_NUMBER_PREFIX = "5500990000";
function isTestNumber(to: string): boolean {
  return to.replace(/@.*/, "").startsWith(TEST_NUMBER_PREFIX);
}
const TEST_SEND_RESULT = { key: { id: "TEST_SKIP" } } as unknown as SendTextResult;

export async function sendText(
  config: EvolutionConfig,
  to: string,
  text: string
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendText no-op: ${text.slice(0, 60)}`); return TEST_SEND_RESULT; }
  const url = `${config.baseUrl}/message/sendText/${config.instancia}`;

  const number = await resolveSendAddress(to);
  if (number !== to.replace(/@.*/, "")) {
    console.log(`[Evolution] LID resolvido: ${to.replace(/@.*/, "")} → ${number}`);
  }

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution sendText failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<SendTextResult>;
}

export async function sendImage(
  config: EvolutionConfig,
  to: string,
  imageUrl: string,
  caption?: string
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendImage no-op`); return TEST_SEND_RESULT; }
  const url = `${config.baseUrl}/message/sendMedia/${config.instancia}`;
  const number = await resolveSendAddress(to);

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number,
      mediatype: "image",
      media: imageUrl,
      caption: caption ?? "",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution sendImage failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<SendTextResult>;
}

export async function sendVideo(
  config: EvolutionConfig,
  to: string,
  videoUrl: string,
  caption?: string
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendVideo no-op`); return TEST_SEND_RESULT; }
  const url = `${config.baseUrl}/message/sendMedia/${config.instancia}`;
  const number = await resolveSendAddress(to);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.apiKey },
    body: JSON.stringify({ number, mediatype: "video", media: videoUrl, caption: caption ?? "" }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution sendVideo failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<SendTextResult>;
}

/**
 * Sends a "composing" (typing) presence update for a given duration.
 * Makes the chat show "digitando..." to the recipient.
 */
export async function sendTyping(
  config: EvolutionConfig,
  to: string,
  durationMs: number
): Promise<void> {
  if (isTestNumber(to)) return;
  const resolved = await resolveSendAddress(to);
  const jid = resolved.includes("@") ? resolved : `${resolved}@s.whatsapp.net`;
  const url = `${config.baseUrl}/chat/sendPresence/${config.instancia}`;

  await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number: jid,
      options: { presence: "composing", delay: durationMs },
    }),
  }, 10_000).catch(() => { /* non-critical */ });
}

export async function markAsRead(
  config: EvolutionConfig,
  messageKey: { id: string; remoteJid: string }
): Promise<void> {
  const url = `${config.baseUrl}/message/markMessageAsRead/${config.instancia}`;

  await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({ read_messages: [messageKey] }),
  }, 10_000).catch(() => {
    /* non-critical */
  });
}

/**
 * Sends an audio message as a WhatsApp PTT (push-to-talk) voice note.
 * audioBase64 should be a base64-encoded OGG Opus buffer.
 */
export async function sendWhatsAppAudio(
  config: EvolutionConfig,
  to: string,
  audioBase64: string,
  mimeType = "audio/ogg",
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendWhatsAppAudio no-op`); return TEST_SEND_RESULT; }
  // Convert to OGG/Opus (WhatsApp PTT format) via FFmpeg if not already OGG
  let oggBase64 = audioBase64;
  if (!mimeType.includes("ogg")) {
    try {
      oggBase64 = await convertToOggOpus(audioBase64, mimeType);
    } catch (e: any) {
      console.warn(`[sendWhatsAppAudio] FFmpeg convert failed: ${e.message} — sending original`);
    }
  }

  const url = `${config.baseUrl}/message/sendWhatsAppAudio/${config.instancia}`;
  const number = await resolveSendAddress(to);
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.apiKey },
    body: JSON.stringify({ number, audio: oggBase64 }),
  }, 30_000);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution sendWhatsAppAudio failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<SendTextResult>;
}

/**
 * Sends a PDF document via WhatsApp using base64 encoding.
 */
export async function sendDocument(
  config: EvolutionConfig,
  to: string,
  pdfBase64: string,
  fileName: string,
  caption?: string
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendDocument no-op: ${fileName}`); return TEST_SEND_RESULT; }
  const url = `${config.baseUrl}/message/sendMedia/${config.instancia}`;
  const number = await resolveSendAddress(to);

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number,
      mediatype: "document",
      media: pdfBase64,
      fileName,
      caption: caption ?? "",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution sendDocument failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<SendTextResult>;
}

/**
 * Sends any media (image, video, document) via base64. Detects mediatype from mimeType.
 */
export async function sendMediaBase64(
  config: EvolutionConfig,
  to: string,
  mediaBase64: string,
  mimeType: string,
  fileName: string,
  caption?: string
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendMediaBase64 no-op: ${fileName}`); return TEST_SEND_RESULT; }
  const url = `${config.baseUrl}/message/sendMedia/${config.instancia}`;
  const number = await resolveSendAddress(to);

  let mediatype = "document";
  if (mimeType.startsWith("image/")) mediatype = "image";
  else if (mimeType.startsWith("video/")) mediatype = "video";

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: config.apiKey },
    body: JSON.stringify({
      number,
      mediatype,
      media: mediaBase64,
      fileName,
      caption: caption ?? "",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution sendMediaBase64 failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<SendTextResult>;
}

export async function downloadMedia(
  config: EvolutionConfig,
  messageId: string
): Promise<Buffer> {
  const url = `${config.baseUrl}/chat/getBase64FromMediaMessage/${config.instancia}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({ message: { key: { id: messageId } } }),
  });

  if (!res.ok) {
    throw new Error(`Evolution downloadMedia failed: ${res.status}`);
  }

  const json = (await res.json()) as { base64?: string };
  if (!json.base64) throw new Error("Evolution: no base64 in response");
  return Buffer.from(json.base64, "base64");
}
