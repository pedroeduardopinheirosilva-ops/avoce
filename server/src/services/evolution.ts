/**
 * Evolution API client — WhatsApp sending via Evolution self-hosted
 * Configs loaded from ia_projeto_config per project
 */

interface EvolutionConfig {
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

export async function sendText(
  config: EvolutionConfig,
  to: string,
  text: string
): Promise<SendTextResult> {
  const url = `${config.baseUrl}/message/sendText/${config.instancia}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number: to,
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
  const url = `${config.baseUrl}/message/sendMedia/${config.instancia}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number: to,
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

/**
 * Sends a "composing" (typing) presence update for a given duration.
 * Makes the chat show "digitando..." to the recipient.
 */
export async function sendTyping(
  config: EvolutionConfig,
  to: string,
  durationMs: number
): Promise<void> {
  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
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
): Promise<SendTextResult> {
  const url = `${config.baseUrl}/message/sendWhatsAppAudio/${config.instancia}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number: to,
      audio: `data:audio/ogg;base64,${audioBase64}`,
    }),
  });

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
  const url = `${config.baseUrl}/message/sendMedia/${config.instancia}`;

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
    },
    body: JSON.stringify({
      number: to,
      mediatype: "document",
      media: `data:application/pdf;base64,${pdfBase64}`,
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
