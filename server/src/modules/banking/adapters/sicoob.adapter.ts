import { createHash } from "node:crypto";
import type {
  IBankAdapter,
  BankCredentialPayload,
  FetchStatementOptions,
  BankStatementEntry,
  AccountBalance,
} from "./bank.adapter.js";
import { handleBankHttpError } from "./bank.adapter.js";

const SICOOB_BASE_URL = process.env.SICOOB_BASE_URL ?? "https://api.sicoob.com.br";

interface TokenCache {
  token:     string;
  expiresAt: Date;
}

// Token cache keyed by sha256 of cert
const tokenCache = new Map<string, TokenCache>();

async function getToken(credentials: BankCredentialPayload): Promise<string> {
  if (!credentials.certData) throw new Error("Sicoob requires MTLS cert (certData)");
  if (!credentials.clientId) throw new Error("Sicoob requires clientId");

  const certKey = createHash("sha256").update(credentials.certData).digest("hex");
  const cached  = tokenCache.get(certKey);
  if (cached && cached.expiresAt > new Date()) return cached.token;

  // Build agent with mTLS via undici
  const { Agent, fetch: undociFetch } = await import("undici");

  const certBuffer = Buffer.from(credentials.certData, "base64");

  const dispatcher = new Agent({
    connect: {
      pfx:        certBuffer,
      passphrase: credentials.certPassword ?? "",
      rejectUnauthorized: false,
    },
  });

  const body = new URLSearchParams({
    grant_type:    "client_credentials",
    client_id:     credentials.clientId,
    client_secret: credentials.clientSecret ?? "",
    scope:         "cobranca_boletos-consultar conta-corrente-dados-consultar conta-corrente-extrato-consultar conta-corrente-saldo-consultar",
  });

  const resp = await (undociFetch as unknown as typeof fetch)(
    `${SICOOB_BASE_URL}/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:   body.toString(),
      // @ts-ignore undici-specific
      dispatcher,
    }
  );

  if (!resp.ok) handleBankHttpError(resp.status);

  const data = await resp.json() as { access_token: string; expires_in: number };

  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  tokenCache.set(certKey, { token: data.access_token, expiresAt });

  return data.access_token;
}

async function buildDispatcher(credentials: BankCredentialPayload) {
  const { Agent } = await import("undici");
  if (!credentials.certData) throw new Error("Sicoob requires certData");
  const certBuffer = Buffer.from(credentials.certData, "base64");
  return new Agent({
    connect: {
      pfx:        certBuffer,
      passphrase: credentials.certPassword ?? "",
      rejectUnauthorized: false,
    },
  });
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

export class SicoobAdapter implements IBankAdapter {
  async fetchStatement(
    credentials: BankCredentialPayload,
    options:     FetchStatementOptions
  ): Promise<BankStatementEntry[]> {
    const { fetch: undociFetch } = await import("undici");
    const token      = await getToken(credentials);
    const dispatcher = await buildDispatcher(credentials);

    const params = new URLSearchParams({
      numeroConta: options.account,
      dataInicio:  formatDate(options.startDate),
      dataFim:     formatDate(options.endDate),
    });

    const resp = await (undociFetch as unknown as typeof fetch)(
      `${SICOOB_BASE_URL}/conta-corrente/v1/extratos?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore undici-specific
        dispatcher,
      }
    );

    if (!resp.ok) handleBankHttpError(resp.status);

    const data = await resp.json() as {
      resultado?: Array<{
        dataLancamento:  string;
        dataMovimento?:  string;
        valor:           number;
        tipoLancamento:  string;
        saldo?:          number;
        descricao?:      string;
        numeroDocumento?: string;
        nomeOrigemDestino?: string;
        endToEndId?:     string;
        txid?:           string;
        [k: string]:     unknown;
      }>;
    };

    const entries: BankStatementEntry[] = [];
    for (const item of data.resultado ?? []) {
      const entryType: "DEBIT" | "CREDIT" = item.tipoLancamento === "D" ? "DEBIT" : "CREDIT";

      // Generate externalId from endToEndId, txid or hash
      const externalId = item.endToEndId ?? item.txid ??
        createHash("sha256")
          .update(`${item.dataLancamento}:${item.valor}:${item.tipoLancamento}:${item.descricao ?? ""}`)
          .digest("hex")
          .slice(0, 32);

      entries.push({
        externalId,
        entryDate:   new Date(item.dataLancamento),
        valueDate:   item.dataMovimento ? new Date(item.dataMovimento) : undefined,
        amount:      Math.abs(item.valor),
        entryType,
        balance:     item.saldo,
        description: item.descricao ?? "",
        documentNumber: item.numeroDocumento,
        counterpartyName: item.nomeOrigemDestino,
        rawData: {
          endToEndId: item.endToEndId,
          txid:       item.txid,
          ...item,
        },
      });
    }

    return entries;
  }

  async fetchBalance(
    credentials: BankCredentialPayload,
    options:     Pick<FetchStatementOptions, "account" | "agency" | "agencyDigit" | "accountDigit" | "externalAccountId">
  ): Promise<AccountBalance> {
    const { fetch: undociFetch } = await import("undici");
    const token      = await getToken(credentials);
    const dispatcher = await buildDispatcher(credentials);

    const params = new URLSearchParams({ numeroConta: options.account });

    const resp = await (undociFetch as unknown as typeof fetch)(
      `${SICOOB_BASE_URL}/conta-corrente/v1/saldos?${params}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        // @ts-ignore undici-specific
        dispatcher,
      }
    );

    if (!resp.ok) handleBankHttpError(resp.status);

    const data = await resp.json() as {
      resultado?: { saldoDisponivel?: number; saldoBloqueado?: number; dataHora?: string };
    };

    const r = data.resultado ?? {};
    return {
      available: r.saldoDisponivel ?? 0,
      blocked:   r.saldoBloqueado,
      date:      r.dataHora ? new Date(r.dataHora) : new Date(),
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
