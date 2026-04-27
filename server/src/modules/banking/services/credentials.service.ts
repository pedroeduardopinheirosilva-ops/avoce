import { prisma }                from "../../../db.js";
import { getCredentialsCrypto } from "../crypto/credentials.crypto.js";
import { AdapterFactory }       from "../adapters/adapter.factory.js";
import type { BankCredentialPayload } from "../adapters/bank.adapter.js";
import type { BankProvider }    from "@prisma/client";

export interface SaveCredentialInput {
  emitenteId:    string;
  bankAccountId: string;
  credentialType: "MTLS_CERT" | "MTLS_KEYPAIR" | "OAUTH2";
  certData?:     string;
  certPassword?: string;
  certPem?:      string;
  keyPem?:       string;
  clientId?:     string;
  clientSecret?: string;
  expiresAt?:    Date;
}

export interface CredentialMeta {
  id:             string;
  emitenteId:     string;
  bankAccountId:  string;
  credentialType: string;
  expiresAt:      Date | null;
  isActive:       boolean;
  lastTestedAt:   Date | null;
  lastTestOk:     boolean | null;
  createdAt:      Date;
  updatedAt:      Date;
}

function encryptField(value: string | undefined | null): string | null {
  if (!value) return null;
  const { encrypt } = getCredentialsCrypto();
  return encrypt(value);
}

function decryptField(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const { decrypt } = getCredentialsCrypto();
  return decrypt(value);
}

export const credentialsService = {
  async save(input: SaveCredentialInput): Promise<CredentialMeta> {
    let expiresAt = input.expiresAt;

    // For MTLS_KEYPAIR: set expiry 365 days if not provided
    if (input.credentialType === "MTLS_KEYPAIR" && !expiresAt) {
      expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }

    const data = {
      emitenteId:     input.emitenteId,
      bankAccountId:  input.bankAccountId,
      credentialType: input.credentialType,
      certData:       encryptField(input.certData),
      certPassword:   encryptField(input.certPassword),
      certPem:        encryptField(input.certPem),
      keyPem:         encryptField(input.keyPem),
      clientId:       encryptField(input.clientId),
      clientSecret:   encryptField(input.clientSecret),
      expiresAt:      expiresAt ?? null,
    };

    const existing = await prisma.bankCredential.findUnique({
      where: { bankAccountId: input.bankAccountId },
    });

    let cred;
    if (existing) {
      cred = await prisma.bankCredential.update({
        where: { bankAccountId: input.bankAccountId },
        data,
      });
    } else {
      cred = await prisma.bankCredential.create({ data });
    }

    return this._toMeta(cred);
  },

  // INTERNAL ONLY — never expose via tRPC
  async getDecrypted(bankAccountId: string): Promise<BankCredentialPayload | null> {
    const cred = await prisma.bankCredential.findUnique({
      where: { bankAccountId },
    });
    if (!cred || !cred.isActive) return null;

    return {
      credentialType: cred.credentialType as "MTLS_CERT" | "MTLS_KEYPAIR" | "OAUTH2",
      certData:       decryptField(cred.certData),
      certPassword:   decryptField(cred.certPassword),
      certPem:        decryptField(cred.certPem),
      keyPem:         decryptField(cred.keyPem),
      clientId:       decryptField(cred.clientId),
      clientSecret:   decryptField(cred.clientSecret),
      expiresAt:      cred.expiresAt ?? undefined,
    };
  },

  async getMeta(emitenteId: string, bankAccountId: string): Promise<CredentialMeta | null> {
    const cred = await prisma.bankCredential.findFirst({
      where: { bankAccountId, emitenteId },
    });
    if (!cred) return null;
    return this._toMeta(cred);
  },

  async testConnection(
    emitenteId:    string,
    bankAccountId: string,
    provider:      BankProvider
  ): Promise<{ ok: boolean; error?: string }> {
    const decrypted = await this.getDecrypted(bankAccountId);
    if (!decrypted) return { ok: false, error: "No credentials configured" };

    const adapter = AdapterFactory.getAdapter(provider);
    let ok = false;
    let error: string | undefined;

    try {
      ok = await adapter.testConnection(decrypted);
    } catch (err) {
      ok    = false;
      error = err instanceof Error ? err.message : "Unknown error";
    }

    await prisma.bankCredential.updateMany({
      where: { bankAccountId, emitenteId },
      data:  { lastTestedAt: new Date(), lastTestOk: ok },
    });

    return { ok, error };
  },

  async getExpiring(emitenteId: string, daysAhead: number): Promise<CredentialMeta[]> {
    const cutoff = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
    const creds  = await prisma.bankCredential.findMany({
      where: {
        emitenteId,
        isActive:  true,
        expiresAt: { lte: cutoff },
      },
    });
    return creds.map(this._toMeta);
  },

  async remove(emitenteId: string, bankAccountId: string): Promise<void> {
    await prisma.bankCredential.deleteMany({
      where: { bankAccountId, emitenteId },
    });
  },

  _toMeta(cred: {
    id: string;
    emitenteId: string;
    bankAccountId: string;
    credentialType: string;
    expiresAt: Date | null;
    isActive: boolean;
    lastTestedAt: Date | null;
    lastTestOk: boolean | null;
    createdAt: Date;
    updatedAt: Date;
  }): CredentialMeta {
    return {
      id:             cred.id,
      emitenteId:     cred.emitenteId,
      bankAccountId:  cred.bankAccountId,
      credentialType: cred.credentialType,
      expiresAt:      cred.expiresAt,
      isActive:       cred.isActive,
      lastTestedAt:   cred.lastTestedAt,
      lastTestOk:     cred.lastTestOk,
      createdAt:      cred.createdAt,
      updatedAt:      cred.updatedAt,
    };
  },
};
