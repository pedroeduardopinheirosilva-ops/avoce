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

/**
 * Mensagem citada (o lead — ou o atendente pelo celular — tocou em "Responder").
 * A Evolution v2 manda `contextInfo` no topo do `data`; versões antigas, dentro da
 * mensagem (`extendedTextMessage`, `imageMessage`...). Lemos os dois.
 */
export function extractCitacao(msg: unknown): { citacaoEvolutionId: string; citacaoTexto: string | null } | null {
  const m = msg as any;
  const inner = m?.message ?? {};
  const ctx = m?.contextInfo
    ?? inner.extendedTextMessage?.contextInfo
    ?? inner.imageMessage?.contextInfo
    ?? inner.videoMessage?.contextInfo
    ?? inner.audioMessage?.contextInfo
    ?? inner.documentMessage?.contextInfo
    ?? null;
  const id = typeof ctx?.stanzaId === "string" ? ctx.stanzaId : null;
  if (!id) return null;
  const q = ctx.quotedMessage ?? {};
  const texto: string | null =
    q.conversation ?? q.extendedTextMessage?.text ?? q.imageMessage?.caption ?? q.videoMessage?.caption
    ?? q.documentMessage?.fileName
    ?? (q.imageMessage ? "📷 Imagem" : q.audioMessage ? "🎤 Áudio" : q.videoMessage ? "🎥 Vídeo" : q.documentMessage ? "📎 Arquivo" : null);
  return { citacaoEvolutionId: id, citacaoTexto: texto ? String(texto).slice(0, 1000) : null };
}
