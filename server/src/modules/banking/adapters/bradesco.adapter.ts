import { createHash } from "node:crypto";
import type {
  IBankAdapter,
  BankCredentialPayload,
  FetchStatementOptions,
  BankStatementEntry,
  AccountBalance,
} from "./bank.adapter.js";
import { handleBankHttpError } from "./bank.adapter.js";

const BRADESCO_BASE_URL = process.env.BRADESCO_BASE_URL ?? "https://proxy.api.prebanco.com.br";

async function buildDispatcher(credentials: BankCredentialPayload) {
  const { Agent } = await import("undici");
  if (!credentials.certData) throw new Error("Bradesco requires certData (PFX base64)");
  const certBuffer = Buffer.from(credentials.certData, "base64");
  return new Agent({
    connect: {
      pfx:        certBuffer,
      passphrase: credentials.certPassword ?? "",
      rejectUnauthorized: false,
    },
  });
}

async function getBasicToken(credentials: BankCredentialPayload, dispatcher: unknown): Promise<string> {
  const { fetch: undociFetch } = await import("undici");

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     credentials.clientId ?? "",
    client_secret: credentials.clientSecret ?? "",
  });

  const resp = await (undociFetch as unknown as typeof fetch)(
    `${BRADESCO_BASE_URL}/auth/server/v1/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:   body.toString(),
      // @ts-ignore undici dispatcher
      dispatcher,
    }
  );

  if (!resp.ok) handleBankHttpError(resp.status);
  const data = await resp.json() as { access_token: string };
  return data.access_token;
}

async function getExternalAccountId(
  credentials: BankCredentialPayload,
  options:     FetchStatementOptions,
  token:       string,
  dispatcher:  unknown
): Promise<string> {
  if (options.externalAccountId) return options.externalAccountId;

  const { fetch: undociFetch } = await import("undici");
  const resp = await (undociFetch as unknown as typeof fetch)(
    `${BRADESCO_BASE_URL}/open-banking/v1/accounts`,
    {
      headers: { Authorization: `Bearer ${token}` },
      // @ts-ignore
      dispatcher,
    }
  );

  if (!resp.ok) handleBankHttpError(resp.status);
  const data = await resp.json() as { data?: Array<{ accountId?: string; number?: string }> };

  const account = (data.data ?? []).find(
    (a) => (a.number ?? "").replace(/\D/g, "").endsWith(options.account.replace(/\D/g, ""))
  );
  return account?.accountId ?? options.account;
}

export class BradescoAdapter implements IBankAdapter {
  async fetchStatement(
    credentials: BankCredentialPayload,
    options:     FetchStatementOptions
  ): Promise<BankStatementEntry[]> {
    const { fetch: undociFetch } = await import("undici");
    const dispatcher   = await buildDispatcher(credentials);
    const token        = await getBasicToken(credentials, dispatcher);
    const accountId    = await getExternalAccountId(credentials, options, token, dispatcher);

    const params = new URLSearchParams({
      fromBookingDateTime: options.startDate.toISOString(),
      toBookingDateTime:   options.endDate.toISOString(),
    });

    const resp = await (undociFetch as unknown as typeof fetch)(
      `${BRADESCO_BASE_URL}/open-banking/v1/accounts/${accountId}/transactions?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore
        dispatcher,
      }
    );

    if (!resp.ok) handleBankHttpError(resp.status);
    const data = await resp.json() as {
      data?: Array<{
        transactionId?:         string;
        bookingDateTime?:        string;
        valueDateTime?:          string;
        amount?:                 { amount: string; currency: string };
        creditDebitIndicator?:   string;
        transactionInformation?: string;
        transactionReference?:   string;
        creditorName?:           string;
        [k: string]:             unknown;
      }>;
    };

    return (data.data ?? []).map((tx) => {
      const amount    = Math.abs(parseFloat(tx.amount?.amount ?? "0"));
      const entryType: "DEBIT" | "CREDIT" =
        (tx.creditDebitIndicator ?? "").toUpperCase() === "CREDIT" ? "CREDIT" : "DEBIT";
      const externalId = tx.transactionId ??
        createHash("sha256")
          .update(`${tx.bookingDateTime}:${tx.amount?.amount}:${entryType}`)
          .digest("hex")
          .slice(0, 32);

      return {
        externalId,
        entryDate:        tx.bookingDateTime ? new Date(tx.bookingDateTime) : new Date(),
        valueDate:        tx.valueDateTime   ? new Date(tx.valueDateTime)   : undefined,
        amount,
        entryType,
        description:      tx.transactionInformation ?? tx.transactionReference ?? "",
        documentNumber:   tx.transactionReference,
        counterpartyName: tx.creditorName,
        rawData:          tx as Record<string, unknown>,
      };
    });
  }

  async fetchBalance(
    credentials: BankCredentialPayload,
    options:     Pick<FetchStatementOptions, "account" | "agency" | "agencyDigit" | "accountDigit" | "externalAccountId">
  ): Promise<AccountBalance> {
    const { fetch: undociFetch } = await import("undici");
    const dispatcher = await buildDispatcher(credentials);
    const token      = await getBasicToken(credentials, dispatcher);

    const accountId = options.externalAccountId ?? options.account;

    const resp = await (undociFetch as unknown as typeof fetch)(
      `${BRADESCO_BASE_URL}/open-banking/v1/accounts/${accountId}/balances`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore
        dispatcher,
      }
    );

    if (!resp.ok) handleBankHttpError(resp.status);
    const data = await resp.json() as {
      data?: { availableBalance?: { amount: string }; blockedBalance?: { amount: string } };
    };

    const d = data.data ?? {};
    return {
      available: parseFloat(d.availableBalance?.amount ?? "0"),
      blocked:   d.blockedBalance ? parseFloat(d.blockedBalance.amount) : undefined,
      date:      new Date(),
    };
  }

  async testConnection(credentials: BankCredentialPayload): Promise<boolean> {
    try {
      const dispatcher = await buildDispatcher(credentials);
      const token      = await getBasicToken(credentials, dispatcher);
      return !!token;
    } catch {
      return false;
    }
  }
}
