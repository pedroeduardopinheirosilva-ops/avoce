/**
 * Webhook parser — extracts text from Evolution API webhook payloads.
 * Pure function, no I/O, no side effects.
 */

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

/**
 * Extracts the text content from an Evolution webhook message.
 * Returns null for audio-only, document-only, or empty messages.
 */
export function extractText(msg: EvolutionWebhookMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    null
  );
}
