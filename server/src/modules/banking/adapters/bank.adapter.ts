export interface BankStatementEntry {
  externalId:           string;
  entryDate:            Date;
  valueDate?:           Date;
  amount:               number;          // Always positive
  entryType:            "DEBIT" | "CREDIT";
  balance?:             number;
  description:          string;
  documentNumber?:      string;
  counterpartyName?:    string;
  counterpartyDocument?: string;
  rawData?:             Record<string, unknown>;
}

export interface FetchStatementOptions {
  account:       string;
  agency:        string;
  agencyDigit?:  string;
  accountDigit?: string;
  startDate:     Date;
  endDate:       Date;
  externalAccountId?: string;
}

export interface AccountBalance {
  available: number;
  blocked?:  number;
  date:      Date;
}

export interface BankCredentialPayload {
  credentialType: "MTLS_CERT" | "MTLS_KEYPAIR" | "OAUTH2";
  certData?:      string;   // base64 PFX for MTLS_CERT
  certPassword?:  string;
  certPem?:       string;   // PEM cert for MTLS_KEYPAIR
  keyPem?:        string;   // PEM key  for MTLS_KEYPAIR
  clientId?:      string;
  clientSecret?:  string;
  expiresAt?:     Date;
}

export interface IBankAdapter {
  fetchStatement(
    credentials: BankCredentialPayload,
    options:     FetchStatementOptions
  ): Promise<BankStatementEntry[]>;

  fetchBalance(
    credentials: BankCredentialPayload,
    options:     Pick<FetchStatementOptions, "account" | "agency" | "agencyDigit" | "accountDigit" | "externalAccountId">
  ): Promise<AccountBalance>;

  testConnection(credentials: BankCredentialPayload): Promise<boolean>;
}

// ── Error handling ────────────────────────────────────────────────────────────

export class BankError extends Error {
  constructor(
    message: string,
    public readonly code: "UNAUTHORIZED" | "RATE_LIMITED" | "UNAVAILABLE" | "UNKNOWN"
  ) {
    super(message);
    this.name = "BankError";
  }
}

export function handleBankHttpError(status: number): never {
  if (status === 401 || status === 403) {
    throw new BankError(`HTTP ${status}: Authentication failed`, "UNAUTHORIZED");
  }
  if (status === 429) {
    throw new BankError(`HTTP ${status}: Rate limited`, "RATE_LIMITED");
  }
  if (status >= 500) {
    throw new BankError(`HTTP ${status}: Bank service unavailable`, "UNAVAILABLE");
  }
  throw new BankError(`HTTP ${status}: Unexpected error`, "UNKNOWN");
}
