import { createHash } from "node:crypto";
import type {
  IBankAdapter,
  BankCredentialPayload,
  FetchStatementOptions,
  BankStatementEntry,
  AccountBalance,
} from "./bank.adapter.js";
import { handleBankHttpError } from "./bank.adapter.js";

const BTG_BASE_URL = process.env.BTG_BASE_URL ?? "https://api.btgpactual.com";

interface BtgTokenCache {
  token:     string;
  expiresAt: Date;
}

const tokenCache = new Map<string, BtgTokenCache>();

async function getToken(credentials: BankCredentialPayload): Promise<string> {
  if (!credentials.clientId) throw new Error("BTG requires clientId");
  const cacheKey = createHash("sha256").update(credentials.clientId).digest("hex");

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > new Date()) return cached.token;

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     credentials.clientId,
    client_secret: credentials.clientSecret ?? "",
  });

  const resp = await fetch(`${BTG_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:   body.toString(),
  });

  if (!resp.ok) handleBankHttpError(resp.status);
  const data = await resp.json() as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });
  return data.access_token;
}

export class BtgAdapter implements IBankAdapter {
  async fetchStatement(
    credentials: BankCredentialPayload,
    options:     FetchStatementOptions
  ): Promise<BankStatementEntry[]> {
    const token = await getToken(credentials);
    const entries: BankStatementEntry[] = [];
    let   pageToken: string | undefined;

    do {
      const params = new URLSearchParams({
        startDate: options.startDate.toISOString().split("T")[0],
        endDate:   options.endDate.toISOString().split("T")[0],
        account:   options.externalAccountId ?? options.account,
      });
      if (pageToken) params.set("pageToken", pageToken);

      const resp = await fetch(`${BTG_BASE_URL}/cash-management/v1/transactions?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!resp.ok) handleBankHttpError(resp.status);

      const data = await resp.json() as {
        transactions?:  Array<{
          transactionId?:  string;
          date?:           string;
          amount?:         number;
          type?:           string;
          description?:    string;
          counterparty?:   string;
          documentNumber?: string;
          [k: string]:     unknown;
        }>;
        hasNextPage?:    boolean;
        nextPageToken?:  string;
      };

      for (const tx of data.transactions ?? []) {
        const entryType: "DEBIT" | "CREDIT" =
          (tx.type ?? "").toUpperCase() === "CREDIT" ? "CREDIT" : "DEBIT";
        const externalId = tx.transactionId ??
          createHash("sha256")
            .update(`${tx.date}:${tx.amount}:${tx.type}:${tx.description}`)
            .digest("hex")
            .slice(0, 32);

        entries.push({
          externalId,
          entryDate:        tx.date ? new Date(tx.date) : new Date(),
          amount:           Math.abs(tx.amount ?? 0),
          entryType,
          description:      tx.description ?? "",
          documentNumber:   tx.documentNumber,
          counterpartyName: tx.counterparty,
          rawData:          tx as Record<string, unknown>,
        });
      }

      pageToken = data.hasNextPage ? data.nextPageToken : undefined;
    } while (pageToken);

    return entries;
  }

  async fetchBalance(
    credentials: BankCredentialPayload,
    options:     Pick<FetchStatementOptions, "account" | "agency" | "agencyDigit" | "accountDigit" | "externalAccountId">
  ): Promise<AccountBalance> {
    const token = await getToken(credentials);

    const params = new URLSearchParams({
      account: options.externalAccountId ?? options.account,
    });

    const resp = await fetch(`${BTG_BASE_URL}/cash-management/v1/balance?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) handleBankHttpError(resp.status);

    const data = await resp.json() as {
      availableBalance?: number;
      blockedBalance?:   number;
      date?:             string;
    };

    return {
      available: data.availableBalance ?? 0,
      blocked:   data.blockedBalance,
      date:      data.date ? new Date(data.date) : new Date(),
    };
  }

  async testConnection(credentials: BankCredentialPayload): Promise<boolean> {
    try {
      await getToken(credentials);
      return true;
    } catch {
      return false;
    }
  }
}
