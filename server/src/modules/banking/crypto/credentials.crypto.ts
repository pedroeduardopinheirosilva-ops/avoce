import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LEN    = 12;

function getKey(): Buffer {
  const hex = process.env.BANKING_ENCRYPTION_KEY ?? "";
  if (hex.length !== 64) {
    throw new Error(
      "BANKING_ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate with: openssl rand -hex 32"
    );
  }
  return Buffer.from(hex, "hex");
}

let _key: Buffer | null = null;

function getCredentialsCrypto() {
  if (!_key) {
    _key = getKey();
  }

  function encrypt(plaintext: string): string {
    const iv      = randomBytes(IV_LEN);
    const cipher  = createCipheriv(ALGORITHM, _key!, iv);
    const enc     = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${authTag.toString("hex")}:${enc.toString("hex")}`;
  }

  function decrypt(ciphertext: string): string {
    const parts = ciphertext.split(":");
    if (parts.length !== 3) throw new Error("Invalid ciphertext format");
    const [ivHex, authTagHex, encHex] = parts;
    const iv      = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const enc     = Buffer.from(encHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, _key!, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  }

  return { encrypt, decrypt };
}

export { getCredentialsCrypto };
