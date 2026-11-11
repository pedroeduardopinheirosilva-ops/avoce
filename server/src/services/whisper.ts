/**
 * Serviço de transcrição de áudio via Groq ou OpenAI Whisper
 */

interface TranscribeResult {
  ok: boolean;
  text?: string;
  error?: string;
}

/**
 * Transcreve um buffer de áudio usando Groq ou OpenAI Whisper.
 * @param audioBuffer  Buffer do arquivo de áudio (ogg, mp3, wav, etc.)
 * @param mimetype     MIME type do áudio (ex: "audio/ogg; codecs=opus")
 * @param apiKey       API Key do provedor
 * @param model        Modelo Whisper (ex: "whisper-large-v3-turbo")
 * @param provider     "groq" | "openai"
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimetype: string,
  apiKey: string,
  model: string,
  provider: "groq" | "openai" = "groq",
  prompt?: string,
): Promise<TranscribeResult> {
  if (!apiKey) return { ok: false, error: "audio_api_key não configurada" };

  const endpoint =
    provider === "openai"
      ? "https://api.openai.com/v1/audio/transcriptions"
      : "https://api.groq.com/openai/v1/audio/transcriptions";

  const ext = mimetypeToExt(mimetype);

  const form = new FormData();
  form.append("file", new Blob([audioBuffer as unknown as ArrayBuffer], { type: mimetype }), `audio.${ext}`);
  form.append("model", model);
  form.append("language", "pt");
  form.append("response_format", "text");
  if (prompt) form.append("prompt", prompt);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!res.ok) {
      const errBody = await res.text();
      return { ok: false, error: `Whisper HTTP ${res.status}: ${errBody.slice(0, 200)}` };
    }

    const text = (await res.text()).trim();
    return { ok: true, text };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/**
 * Baixa o áudio de uma mensagem via Evolution API e retorna como Buffer.
 */
export async function downloadAudioFromEvolution(
  baseUrl: string,
  apiKey: string,
  instancia: string,
  msg: any
): Promise<{ buffer: Buffer; mimetype: string } | null> {
  // Duas tentativas: primeiro com o payload completo do webhook; se a Evolution recusar,
  // de novo só com a key — nesse formato ela busca a mensagem no próprio banco.
  // Faz diferença quando o webhook entrega o audioMessage sem os campos de mídia: o payload
  // completo devolve 400 "Cannot derive from empty media key", enquanto só a key funciona.
  const tentativas: any[] = [
    { key: msg.key, message: msg.message },
    { key: msg.key },
  ];

  for (const message of tentativas) {
    try {
      const res = await fetch(`${baseUrl}/chat/getBase64FromMediaMessage/${instancia}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        body: JSON.stringify({ message, convertToMp4: false }),
      });
      if (!res.ok) continue;
      const data = await res.json() as { base64?: string; mediaType?: string };
      if (!data.base64) continue;
      return {
        buffer: Buffer.from(data.base64, "base64"),
        mimetype: data.mediaType ?? "audio/ogg; codecs=opus",
      };
    } catch {
      // tenta o próximo formato
    }
  }
  return null;
}

function mimetypeToExt(mimetype: string): string {
  if (mimetype.includes("ogg"))  return "ogg";
  if (mimetype.includes("mp4"))  return "mp4";
  if (mimetype.includes("mp3") || mimetype.includes("mpeg")) return "mp3";
  if (mimetype.includes("wav"))  return "wav";
  if (mimetype.includes("webm")) return "webm";
  if (mimetype.includes("m4a"))  return "m4a";
  return "ogg"; // padrão WhatsApp
}
