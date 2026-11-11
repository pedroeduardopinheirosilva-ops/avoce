import { createHash } from "node:crypto";
import type {
  IBankAdapter,
  BankCredentialPayload,
  FetchStatementOptions,
  BankStatementEntry,
  AccountBalance,
} from "./bank.adapter.js";
import { handleBankHttpError } from "./bank.adapter.js";

// ─────────────────────────────────────────────────────────────────────────────
// Sicoob — API Conta Corrente v3/v4 (extrato + saldo)
// Auth: OAuth2 client_credentials + mTLS (mesmo certificado ICP-Brasil do boleto)
// Escopo real do app de extrato do PSA: "cco_consulta" (NÃO "cco_extrato").
// Contrato validado em produção 01/07/2026 contra a conta 114510.
// ─────────────────────────────────────────────────────────────────────────────

const SICOOB_TOKEN_URL =
  process.env.SICOOB_TOKEN_URL ??
  "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token";
const SICOOB_API_BASE = process.env.SICOOB_BASE_URL ?? "https://api.sicoob.com.br";
const SICOOB_CC_SCOPE = process.env.SICOOB_CC_SCOPE ?? "cco_consulta";

interface TokenCache {
  token:     string;
  expiresAt: Date;
}

// Token cache keyed by sha256(cert) + clientId
const tokenCache = new Map<string, TokenCache>();

async function buildDispatcher(credentials: BankCredentialPayload) {
  const { Agent } = await import("undici");
  if (!credentials.certData) throw new Error("Sicoob requires certData (base64 PFX)");
  const certBuffer = Buffer.from(credentials.certData, "base64");
  return new Agent({
    connect: {
      pfx:        certBuffer,
      passphrase: credentials.certPassword ?? "",
      rejectUnauthorized: true,
    },
  });
}

async function getToken(credentials: BankCredentialPayload): Promise<string> {
  if (!credentials.certData) throw new Error("Sicoob requires MTLS cert (certData)");
  if (!credentials.clientId) throw new Error("Sicoob requires clientId");

  const cacheKey = createHash("sha256")
    .update(credentials.certData)
    .update(credentials.clientId)
    .digest("hex");
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > new Date()) return cached.token;

  const { fetch: undiciFetch } = await import("undici");
  const dispatcher = await buildDispatcher(credentials);

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id:  credentials.clientId,
    scope:      SICOOB_CC_SCOPE,
  });

  const resp = await (undiciFetch as unknown as typeof fetch)(SICOOB_TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
    // @ts-ignore undici-specific
    dispatcher,
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    if (resp.status === 400 && /invalid_scope/.test(txt)) {
      throw new Error(
        `Sicoob: escopo "${SICOOB_CC_SCOPE}" não autorizado para este client_id — ` +
        `assine a API Conta Corrente no app do portal developers.sicoob.com.br. (${txt})`,
      );
    }
    handleBankHttpError(resp.status);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + (data.expires_in - 60) * 1000);
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });
  return data.access_token;
}

// ── Datas ─────────────────────────────────────────────────────────────────────

function lastDayOfMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate(); // month1 é 1-based; day 0 = último do mês anterior
}

/** Fatia o intervalo [start,end] em segmentos por mês-calendário. */
function monthSegments(start: Date, end: Date): Array<{ mes: number; ano: number; diaInicial: number; diaFinal: number }> {
  const segs: Array<{ mes: number; ano: number; diaInicial: number; diaFinal: number }> = [];
  let y = start.getFullYear(), m = start.getMonth() + 1; // 1-based
  const endY = end.getFullYear(), endM = end.getMonth() + 1;
  while (y < endY || (y === endY && m <= endM)) {
    const isFirst = y === start.getFullYear() && m === start.getMonth() + 1;
    const isLast  = y === endY && m === endM;
    segs.push({
      mes: m, ano: y,
      diaInicial: isFirst ? start.getDate() : 1,
      diaFinal:   isLast  ? end.getDate()   : lastDayOfMonth(y, m),
    });
    m++; if (m > 12) { m = 1; y++; }
  }
  return segs;
}

// ── Parse do contraparte a partir de descInfComplementar ──────────────────────
// Ex.: "Recebimento Pix|@PARATY ATACADO E DISTRIBUIDORA LTDA|@05.476.815 0005-99|@NF 291"
//      "NOME: ROSEMERI LOURES DIAS RODRIGUES|@CPF CNPJ: 013.671.056-50"
//      "REM.: TRUST COMERCIO DE ROUPAS LTDA|@Transferência Pix|@..."
const DOC_RE = /\d{2,3}[.\d]{2,}[ .]?\d{3}[ ./-]?\d{2,4}[-/]?\d{0,2}/;
const GENERIC = /^(pagamento|recebimento|transfer[êe]ncia)\s+pix$/i;

function parseCounterparty(desc?: string): { name?: string; doc?: string } {
  if (!desc) return {};
  const parts = desc.split("|@").map(s => s.trim()).filter(Boolean);
  let name: string | undefined;
  let doc:  string | undefined;
  for (let p of parts) {
    p = p.replace(/^NOME:\s*/i, "").replace(/^REM\.?:\s*/i, "").replace(/^CPF\s*CNPJ:\s*/i, "").trim();
    if (!p) continue;
    if (!doc && DOC_RE.test(p) && /\d/.test(p) && !/[A-Za-z]{4}/.test(p)) { doc = p; continue; }
    if (!name && /[A-Za-zÀ-ÿ]{4,}/.test(p) && !GENERIC.test(p)) { name = p; continue; }
  }
  return { name, doc };
}

// ── Requisição autenticada ao extrato ─────────────────────────────────────────

interface SicoobExtratoResultado {
  saldoAtual?:   string;
  saldoAnterior?: string;
  saldoBloqueado?: string;
  transacoes?: Array<{
    transactionId?:      string;
    tipo:                string;   // "CREDITO" | "DEBITO"
    valor:               string;   // "9726.00"
    data?:               string;   // "2026-06-15T17:07"
    dataLote?:           string;   // "2026-06-15"
    descricao?:          string;
    numeroDocumento?:    string;
    descInfComplementar?: string;
    [k: string]:         unknown;
  }>;
}

async function fetchExtratoMes(
  credentials: BankCredentialPayload,
  account:     string,
  seg:         { mes: number; ano: number; diaInicial: number; diaFinal: number },
): Promise<SicoobExtratoResultado> {
  const { fetch: undiciFetch } = await import("undici");
  const token      = await getToken(credentials);
  const dispatcher = await buildDispatcher(credentials);

  const params = new URLSearchParams({
    diaInicial:            String(seg.diaInicial),
    diaFinal:              String(seg.diaFinal),
    numeroContaCorrente:   account,
    agruparCreditoDebito:  "false",
  });

  const url = `${SICOOB_API_BASE}/conta-corrente/v4/extrato/${seg.mes}/${seg.ano}?${params}`;
  const resp = await (undiciFetch as unknown as typeof fetch)(url, {
    headers: { Authorization: `Bearer ${token}`, client_id: credentials.clientId! },
    // @ts-ignore undici-specific
    dispatcher,
  });

  if (!resp.ok) handleBankHttpError(resp.status);
  const data = await resp.json() as { resultado?: SicoobExtratoResultado };
  return data.resultado ?? {};
}

export class SicoobAdapter implements IBankAdapter {
  async fetchStatement(
    credentials: BankCredentialPayload,
    options:     FetchStatementOptions,
  ): Promise<BankStatementEntry[]> {
    const segs = monthSegments(options.startDate, options.endDate);
    const entries: BankStatementEntry[] = [];

    for (let i = 0; i < segs.length; i++) {
      // Espaça as chamadas: a API Conta Corrente do Sicoob tem rate-limit agressivo (429).
      if (i > 0) await new Promise(r => setTimeout(r, 1200));

      const resultado = await fetchExtratoMes(credentials, options.account, segs[i]);

      for (const item of resultado.transacoes ?? []) {
        const entryType: "DEBIT" | "CREDIT" = item.tipo?.toUpperCase() === "DEBITO" ? "DEBIT" : "CREDIT";
        const rawDate = item.data ?? item.dataLote ?? "";
        const entryDate = rawDate ? new Date(rawDate) : new Date();
        const { name, doc } = parseCounterparty(item.descInfComplementar);

        const externalId = item.transactionId ??
          createHash("sha256")
            .update(`${item.dataLote ?? item.data}:${item.valor}:${item.tipo}:${item.descricao ?? ""}`)
            .digest("hex").slice(0, 40);

        entries.push({
          externalId,
          entryDate,
          valueDate:        item.dataLote ? new Date(item.dataLote) : undefined,
          amount:           Math.abs(parseFloat(item.valor) || 0),
          entryType,
          description:      item.descricao ?? "",
          documentNumber:   item.numeroDocumento,
          counterpartyName: name,
          counterpartyDocument: doc,
          rawData:          item as Record<string, unknown>,
        });
      }
    }

    return entries;
  }

  async fetchBalance(
    credentials: BankCredentialPayload,
    options:     Pick<FetchStatementOptions, "account" | "agency" | "agencyDigit" | "accountDigit" | "externalAccountId">,
  ): Promise<AccountBalance> {
    // O endpoint /saldo exige escopo cco_saldo (que o app não tem). O saldo atual
    // vem no próprio corpo do extrato, então consultamos um intervalo mínimo do dia.
    const now = new Date();
    const seg = {
      mes: now.getMonth() + 1, ano: now.getFullYear(),
      diaInicial: now.getDate(), diaFinal: now.getDate(),
    };
    const resultado = await fetchExtratoMes(credentials, options.account, seg);
    return {
      available: parseFloat(resultado.saldoAtual ?? "0") || 0,
      blocked:   resultado.saldoBloqueado ? parseFloat(resultado.saldoBloqueado) : undefined,
      date:      new Date(),
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
