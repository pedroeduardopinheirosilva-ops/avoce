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

/** JIDs que já são endereço final — não passam por resolução de LID */
const FINAL_JID_RE = /@(g\.us|lid|broadcast|newsletter)$/i;

/**
 * Resolve o endereço correto para envio ao lead.
 * Quando o WhatsApp do lead usa LID (novos dispositivos), o número @s.whatsapp.net
 * não é entregue — precisa enviar para {lid}@lid.
 * Lê o arquivo lid-mapping-{phone}.json gerado pela Evolution API ao receber mensagens LID.
 * Grupos (@g.us) e demais JIDs finais são devolvidos intactos — cortar o sufixo faria
 * a Evolution reclassificar o destino e a mensagem não chegaria ao grupo.
 */
async function resolveSendAddress(phone: string): Promise<string> {
  if (FINAL_JID_RE.test(phone)) return phone;

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
export function isTestNumber(to: string): boolean {
  return to.replace(/@.*/, "").startsWith(TEST_NUMBER_PREFIX);
}
const TEST_SEND_RESULT = { key: { id: "TEST_SKIP" } } as unknown as SendTextResult;

/**
 * Pergunta ao WhatsApp qual é o JID real do número, em vez de deduzir.
 *
 * O 9º dígito do celular brasileiro não faz parte do JID de contas mais antigas:
 * 5577991322975 é entregue como 557791322975. Não dá para aplicar a regra às
 * cegas — ela vale para uns números e não para outros —, e errar significa
 * mandar o link de assinatura para um destino que não existe, em silêncio.
 * Devolve null quando o número não tem WhatsApp.
 */
export async function resolverJidReal(config: EvolutionConfig, telefone: string): Promise<string | null> {
  const numero = (telefone ?? "").replace(/\D/g, "");
  if (!numero) return null;
  try {
    const res = await fetch(`${config.baseUrl}/chat/whatsappNumbers/${config.instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.apiKey },
      body: JSON.stringify({ numbers: [numero] }),
    });
    if (!res.ok) return null;
    const body = await res.json() as Array<{ exists?: boolean; jid?: string }> | { exists?: boolean; jid?: string };
    const hit = Array.isArray(body) ? body[0] : body;
    return hit?.exists && hit.jid ? hit.jid : null;
  } catch {
    return null;
  }
}

/**
 * Foto de perfil do contato (POST /chat/fetchProfilePictureUrl).
 * Devolve null quando o número não tem foto, a privacidade esconde ou a instância falha —
 * nunca lança, porque roda no caminho do webhook e em cron.
 */
export async function fetchProfilePictureUrl(config: EvolutionConfig, telefone: string): Promise<string | null> {
  const numero = (telefone ?? "").replace(/@.*/, "").replace(/\D/g, "");
  if (!numero || isTestNumber(numero)) return null;
  try {
    const res = await fetchWithTimeout(`${config.baseUrl}/chat/fetchProfilePictureUrl/${config.instancia}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: config.apiKey },
      body: JSON.stringify({ number: numero }),
    }, 10_000);
    if (!res.ok) return null;
    const body = await res.json() as { profilePictureUrl?: string | null };
    const url = body?.profilePictureUrl;
    return typeof url === "string" && /^https?:\/\//.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** Mensagem a citar no envio (o "Responder" do WhatsApp). */
export interface CitacaoEnvio {
  id: string;        // evolutionMessageId da mensagem citada
  fromMe: boolean;   // true se a citada foi enviada por nós
  texto: string;     // texto da citada (a Evolution usa direto, sem buscar no store)
}

export async function sendText(
  config: EvolutionConfig,
  to: string,
  text: string,
  citacao?: CitacaoEnvio,
): Promise<SendTextResult> {
  if (isTestNumber(to)) { console.log(`[Evolution] TEST ${to} — sendText no-op: ${text.slice(0, 60)}`); return TEST_SEND_RESULT; }
  const url = `${config.baseUrl}/message/sendText/${config.instancia}`;

  const number = await resolveSendAddress(to);
  if (number !== to && number !== to.replace(/@.*/, "")) {
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
      ...(citacao ? {
        quoted: {
          key: {
            id: citacao.id,
            fromMe: citacao.fromMe,
            remoteJid: number.includes("@") ? number : `${number}@s.whatsapp.net`,
          },
          message: { conversation: citacao.texto || " " },
        },
      } : {}),
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

/**
 * Apaga para todos no WhatsApp uma mensagem que NÓS enviamos
 * (DELETE /chat/deleteMessageForEveryone). Mensagem do lead não dá para apagar
 * do celular dele — isso só existe em grupo, para admin. O WhatsApp também
 * recusa depois de ~2 dias do envio. Devolve { ok, erro } e nunca lança: quem
 * chama decide se apaga só do painel quando o WhatsApp recusa.
 */
export async function deleteMessageForEveryone(
  config: EvolutionConfig,
  telefone: string,
  messageId: string,
): Promise<{ ok: boolean; erro?: string }> {
  if (isTestNumber(telefone) || messageId === "TEST_SKIP") return { ok: true };
  const tentados = new Set<string>();
  const candidatos: string[] = [];
  const add = (j: string | null | undefined) => { if (j && !tentados.has(j)) { tentados.add(j); candidatos.push(j); } };
  // O remoteJid tem de ser o MESMO do envio: LID quando houver, senão o JID real
  // (9º dígito decidido pelo WhatsApp, não por regra).
  const enviado = await resolveSendAddress(telefone);
  add(enviado.includes("@") ? enviado : `${enviado}@s.whatsapp.net`);
  add(await resolverJidReal(config, telefone));
  let ultimoErro = "";
  for (const remoteJid of candidatos) {
    try {
      const res = await fetchWithTimeout(`${config.baseUrl}/chat/deleteMessageForEveryone/${config.instancia}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", apikey: config.apiKey },
        body: JSON.stringify({ id: messageId, remoteJid, fromMe: true }),
      }, 15_000);
      if (res.ok) return { ok: true };
      ultimoErro = `${res.status} ${(await res.text()).slice(0, 200)}`;
    } catch (e: any) {
      ultimoErro = e?.message ?? String(e);
    }
  }
  return { ok: false, erro: ultimoErro || "sem JID para o contato" };
}
