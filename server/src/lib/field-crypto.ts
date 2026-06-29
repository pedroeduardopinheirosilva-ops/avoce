// AES-256-GCM field-level encryption for sensitive DB values (certPass, smtpPass, apiKey).
// Uses BANKING_ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
// Backward-compatible: values without the "enc:" prefix are returned as-is.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO   = "aes-256-gcm";
const IV_LEN = 12;
const PREFIX = "enc:";

function _getKey(): Buffer | null {
  const hex = process.env.BANKING_ENCRYPTION_KEY ?? "";
  if (hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

export function fieldEncrypt(plaintext: string): string {
  const key = _getKey();
  if (!key) {
    console.warn("[field-crypto] BANKING_ENCRYPTION_KEY not set — storing sensitive field as plaintext");
    return plaintext;
  }
  const iv      = randomBytes(IV_LEN);
  const cipher  = createCipheriv(ALGO, key, iv);
  const enc     = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${enc.toString("hex")}`;
}

export function fieldDecrypt(value: string | null | undefined): string {
  if (!value) return "";
  if (!value.startsWith(PREFIX)) return value; // plaintext legacy value
  const key = _getKey();
  if (!key) throw new Error("BANKING_ENCRYPTION_KEY not set — cannot decrypt field");
  const parts = value.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted field format");
  const [ivHex, authTagHex, encHex] = parts;
  const iv      = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const enc     = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
