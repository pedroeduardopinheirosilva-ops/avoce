import { createHash } from "node:crypto";
import type {
  IBankAdapter,
  BankCredentialPayload,
  FetchStatementOptions,
  BankStatementEntry,
  AccountBalance,
} from "./bank.adapter.js";
import { handleBankHttpError } from "./bank.adapter.js";

const INTER_BASE_URL = process.env.INTER_BASE_URL ?? "https://cdpj.partners.bancointer.com.br";

function formatDateBR(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

interface InterTokenCache {
  token:     string;
  expiresAt: Date;
}

const tokenCache = new Map<string, InterTokenCache>();

async function buildDispatcher(credentials: BankCredentialPayload) {
  const { Agent } = await import("undici");

  if (credentials.certPem && credentials.keyPem) {
    return new Agent({
      connect: {
        cert:               credentials.certPem,
        key:                credentials.keyPem,
        rejectUnauthorized: false,
      },
    });
  }

  if (credentials.certData) {
    return new Agent({
      connect: {
        pfx:        Buffer.from(credentials.certData, "base64"),
        passphrase: credentials.certPassword ?? "",
        rejectUnauthorized: false,
      },
    });
  }

  throw new Error("Inter requires certPem+keyPem or certData");
}

async function getToken(credentials: BankCredentialPayload): Promise<string> {
  if (!credentials.clientId) throw new Error("Inter requires clientId");

  const cacheKey = createHash("sha256")
    .update(`${credentials.clientId}:${credentials.certPem ?? credentials.certData ?? ""}`)
    .digest("hex");

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > new Date()) return cached.token;

  const { fetch: undociFetch } = await import("undici");
  const dispatcher = await buildDispatcher(credentials);

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     credentials.clientId,
    client_secret: credentials.clientSecret ?? "",
    scope:         "extrato.read saldo.read",
  });

  const resp = await (undociFetch as unknown as typeof fetch)(
    `${INTER_BASE_URL}/oauth/v2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:   body.toString(),
      // @ts-ignore
      dispatcher,
    }
  );

  if (!resp.ok) handleBankHttpError(resp.status);
  const data = await resp.json() as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });
  return data.access_token;
}

export class InterAdapter implements IBankAdapter {
  async fetchStatement(
    credentials: BankCredentialPayload,
    options:     FetchStatementOptions
  ): Promise<BankStatementEntry[]> {
    const { fetch: undociFetch } = await import("undici");
    const token      = await getToken(credentials);
    const dispatcher = await buildDispatcher(credentials);

    const params = new URLSearchParams({
      dataInicio: formatDateBR(options.startDate),
      dataFim:    formatDateBR(options.endDate),
    });

    const resp = await (undociFetch as unknown as typeof fetch)(
      `${INTER_BASE_URL}/banking/v2/extrato?${params}`,
      {
        headers: {
          Authorization:      `Bearer ${token}`,
          "x-conta-corrente": options.externalAccountId ?? options.account,
        },
        // @ts-ignore
        dispatcher,
      }
    );

    if (!resp.ok) handleBankHttpError(resp.status);
    const data = await resp.json() as {
      transacoes?: Array<{
        idTransacao?:     string;
        dataEntrada?:     string;
        dataMovimento?:   string;
        valor?:           number;
        tipoOperacao?:    string;
        tipoTransacao?:   string;
        titulo?:          string;
        descricao?:       string;
        nomeOrigem?:      string;
        [k: string]:      unknown;
      }>;
    };

    return (data.transacoes ?? []).map((tx) => {
      const entryType: "DEBIT" | "CREDIT" = tx.tipoOperacao === "D" ? "DEBIT" : "CREDIT";
      const externalId = tx.idTransacao ??
        createHash("sha256")
          .update(`${tx.dataEntrada}:${tx.valor}:${tx.tipoOperacao}`)
          .digest("hex")
          .slice(0, 32);

      return {
        externalId,
        entryDate:        tx.dataEntrada   ? new Date(tx.dataEntrada)   : new Date(),
        valueDate:        tx.dataMovimento ? new Date(tx.dataMovimento) : undefined,
        amount:           Math.abs(tx.valor ?? 0),
        entryType,
        description:      tx.descricao ?? tx.titulo ?? tx.tipoTransacao ?? "",
        counterpartyName: tx.nomeOrigem,
        rawData:          tx as Record<string, unknown>,
      };
    });
  }

  async fetchBalance(
    credentials: BankCredentialPayload,
    options:     Pick<FetchStatementOptions, "account" | "agency" | "agencyDigit" | "accountDigit" | "externalAccountId">
  ): Promise<AccountBalance> {
    const { fetch: undociFetch } = await import("undici");
    const token      = await getToken(credentials);
    const dispatcher = await buildDispatcher(credentials);

    const resp = await (undociFetch as unknown as typeof fetch)(
      `${INTER_BASE_URL}/banking/v2/saldo`,
      {
        headers: {
          Authorization:      `Bearer ${token}`,
          "x-conta-corrente": options.externalAccountId ?? options.account,
        },
        // @ts-ignore
        dispatcher,
      }
    );

    if (!resp.ok) handleBankHttpError(resp.status);
    const data = await resp.json() as {
      disponivel?: number;
      bloqueado?:  number;
      dataHora?:   string;
    };

    return {
      available: data.disponivel ?? 0,
      blocked:   data.bloqueado,
      date:      data.dataHora ? new Date(data.dataHora) : new Date(),
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
