import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "cobranca-config.json");

export interface CobrancaConfig {
  SICOOB_PIX_CLIENT_ID:     string;
  SICOOB_PIX_KEY:           string;
  SICOOB_BOLETO_CLIENT_ID:  string;
  SICOOB_NUMERO_CLIENTE:    string;
  SICOOB_CONTA_CORRENTE:    string;
  SICOOB_MODALIDADE:        string;
  SICOOB_CONTRATO_COBRANCA: string;
  SICOOB_CERT_PATH:         string;
  SICOOB_CERT_PASSWORD:     string;
  BOLETO_MULTA_PERCENT:     string;
  BOLETO_JUROS_DIA_PERCENT: string;
  BENEFICIARIO_NOME:        string;
  BENEFICIARIO_CNPJ:        string;
  BENEFICIARIO_AGENCIA:     string;
  BENEFICIARIO_CONTA:       string;
  // SMTP para envio de e-mails
  EMAIL_HOST:               string;
  EMAIL_PORT:               string;
  EMAIL_SECURE:             string; // "true" = TLS 465, "false" = STARTTLS 587
  EMAIL_USER:               string;
  EMAIL_PASS:               string;
  EMAIL_FROM:               string; // "Avoce <contato@avoce.com.br>"
}

const DEFAULT: CobrancaConfig = {
  SICOOB_PIX_CLIENT_ID:     "",
  SICOOB_PIX_KEY:           "",
  SICOOB_BOLETO_CLIENT_ID:  "f4f47548-c488-4c87-8910-1ef277e74f2e",
  SICOOB_NUMERO_CLIENTE:    "628530",
  SICOOB_CONTA_CORRENTE:    "124257",
  SICOOB_MODALIDADE:        "1",
  SICOOB_CONTRATO_COBRANCA: "0",
  SICOOB_CERT_PATH:         "/opt/avoce/certs/sicoob.p12",
  SICOOB_CERT_PASSWORD:     "",
  BOLETO_MULTA_PERCENT:     "2",
  BOLETO_JUROS_DIA_PERCENT: "0.033",
  BENEFICIARIO_NOME:        "Tainung do Brasil LTDA",
  BENEFICIARIO_CNPJ:        "45.868.961/0001-50",
  BENEFICIARIO_AGENCIA:     "3226-3",
  BENEFICIARIO_CONTA:       "124257-5",
  EMAIL_HOST:               "",
  EMAIL_PORT:               "587",
  EMAIL_SECURE:             "false",
  EMAIL_USER:               "",
  EMAIL_PASS:               "",
  EMAIL_FROM:               "Avoce <contato@avoce.com.br>",
};

export function getCobrancaConfig(): CobrancaConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULT, ...raw };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveCobrancaConfig(data: Partial<CobrancaConfig>): void {
  const current = getCobrancaConfig();
  const updated  = { ...current, ...data };
  writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2), "utf-8");
}
