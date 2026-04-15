/**
 * ElevenLabs TTS service — converts text to OGG Opus audio for WhatsApp PTT
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

/**
 * Strips WhatsApp/persona formatting from text before sending to TTS.
 * Removes: *NomePersona*\n prefix, **bold**, *italic*, _underline_
 */
function cleanTextForTts(text: string): string {
  return text
    .replace(/^\*[^*\n]+\*\n/, "")     // Remove *NomePersona*\n prefix
    .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** → plain
    .replace(/\*([^*]+)\*/g, "$1")     // *bold* → plain
    .replace(/_([^_]+)_/g, "$1")       // _italic_ → plain
    .replace(/~([^~]+)~/g, "$1")       // ~strike~ → plain
    .trim();
}

/**
 * Converts text to OGG Opus audio via ElevenLabs TTS.
 * Returns a Buffer suitable for sendWhatsAppAudio (base64 encoding).
 * Throws on API failure.
 */
export async function textToSpeech(
  apiKey: string,
  voiceId: string,
  text: string,
  model = "eleven_multilingual_v2",
): Promise<Buffer> {
  const clean = cleanTextForTts(text);

  // ElevenLabs limit is ~5000 chars; truncate gracefully
  const safeText = clean.length > 4900 ? clean.slice(0, 4900) + "..." : clean;

  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=ogg_opus`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: safeText,
      model_id: model,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
