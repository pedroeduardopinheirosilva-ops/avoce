// ─────────────────────────────────────────────────────────────────────────────
// Sicoob Cobrança Bancária — API V3
// mTLS com certificado ICP-Brasil da empresa emitente
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "undici";

export interface SicoobBoletoConfig {
  clientId:         string;
  numeroCliente:    number;
  contaCorrente:    number;
  codigoModalidade: number;
  contratoCobranca: number;
  certPath:         string;
  certPass:         string;
}

// ── mTLS Agent (cache por certPath+pass) ──────────────────────────────────────

const _agents = new Map<string, Agent>();

function getAgent(cfg: SicoobBoletoConfig): Agent {
  const key = `${cfg.certPath}::${cfg.certPass}`;
  if (_agents.has(key)) return _agents.get(key)!;
  const fullPath = resolve(cfg.certPath);
  if (!existsSync(fullPath)) throw new Error(`[Sicoob-Boleto] Certificado não encontrado: ${fullPath}`);
  const pfx = readFileSync(fullPath);
  const agent = new Agent({ connect: { pfx, passphrase: cfg.certPass, rejectUnauthorized: true } });
  _agents.set(key, agent);
  console.log(`[Sicoob-Boleto] mTLS agent inicializado para ${fullPath}`);
  return agent;
}

// ── OAuth2 token (cache por clientId) ────────────────────────────────────────

const TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token";
const _tokens = new Map<string, { token: string; expiresAt: number }>();

async function getToken(cfg: SicoobBoletoConfig): Promise<string> {
  const cached = _tokens.get(cfg.clientId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id:  cfg.clientId,
    scope:      "boletos_inclusao boletos_consulta boletos_alteracao",
  });

  const res = await (fetch as any)(TOKEN_URL, {
    method:     "POST",
    headers:    { "Content-Type": "application/x-www-form-urlencoded" },
    body:       body.toString(),
    dispatcher: getAgent(cfg),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[Sicoob-Boleto] Auth falhou (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  _tokens.set(cfg.clientId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

// ── Requisição autenticada ────────────────────────────────────────────────────

const API_BASE = "https://api.sicoob.com.br/cobranca-bancaria/v3";

async function req(cfg: SicoobBoletoConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken(cfg);
  const res = await (fetch as any)(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
      "client_id":    cfg.clientId,
    },
    body:       body ? JSON.stringify(body) : undefined,
    dispatcher: getAgent(cfg),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`[Sicoob-Boleto] ${method} ${path} (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export interface PagadorBoleto {
  nome:     string;
  cpfCnpj:  string;
  endereco: string;
  bairro:   string;
  cidade:   string;
  uf:       string;
  cep:      string;
  email?:   string;
}

export interface BoletoCriado {
  nossoNumero:    number;
  codigoBarras:   string;
  linhaDigitavel: string;
  urlPdf?:        string;
  brcodeHibrido?: string;
}

export interface BoletoStatus {
  situacao:        string;
  dataVencimento:  string;
  valor:           number;
  valorPago?:      number;
  dataPagamento?:  string;
  nossoNumero:     number;
  linhaDigitavel:  string;
  codigoBarras:    string;
}

// ── Criar boleto ──────────────────────────────────────────────────────────────

export async function criarBoleto(cfg: SicoobBoletoConfig, params: {
  valor:            number;
  dataVencimento:   string;
  pagador:          PagadorBoleto;
  seuNumero?:       string;
  nossoNumero?:     number;
  instrucoes?:      string[];
  comPix?:          boolean;
  multaPercent?:    number;
  jurosDiaPercent?: number;
}): Promise<BoletoCriado> {
  if (!cfg.numeroCliente || !cfg.contaCorrente) {
    throw new Error("[Sicoob-Boleto] numeroCliente e contaCorrente não configurados na empresa");
  }

  const valorBRL = params.valor / 100;
  const hoje = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const dtVenc    = new Date(params.dataVencimento + "T12:00:00Z");
  const dtPosVenc = new Date(dtVenc.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const seuNumeroRaw = params.seuNumero ?? (params.nossoNumero ? String(params.nossoNumero) : "");
  const seuNumero = seuNumeroRaw
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s/-]/g, "")
    .trim()
    .slice(0, 18);

  const pagador: Record<string, unknown> = {
    numeroCpfCnpj: params.pagador.cpfCnpj.replace(/\D/g, ""),
    nome:          params.pagador.nome,
    endereco:      params.pagador.endereco,
    bairro:        params.pagador.bairro,
    cidade:        params.pagador.cidade,
    cep:           params.pagador.cep.replace(/\D/g, ""),
    uf:            params.pagador.uf,
  };
  if (params.pagador.email) pagador["email"] = params.pagador.email;

  const multaPercent    = params.multaPercent    ?? 2;
  const jurosDiaPercent = params.jurosDiaPercent ?? 0.033;

  const payload: Record<string, unknown> = {
    numeroCliente:                   cfg.numeroCliente,
    codigoModalidade:                cfg.codigoModalidade,
    numeroContaCorrente:             cfg.contaCorrente,
    codigoEspecieDocumento:          "DM",
    dataEmissao:                     hoje,
    seuNumero:                       seuNumero || "SN",
    identificacaoEmissaoBoleto:      1,
    identificacaoDistribuicaoBoleto: 1,
    valor:                           valorBRL,
    dataVencimento:                  params.dataVencimento,
    numeroParcela:                   1,
    tipoDesconto:                    0,
    tipoMulta:                       2,
    valorMulta:                      multaPercent,
    dataMulta:                       dtPosVenc,
    tipoJurosMora:                   2,
    valorJurosMora:                  jurosDiaPercent,
    dataJurosMora:                   dtPosVenc,
    pagador,
    codigoCadastrarPIX:              (params.comPix ?? false) ? 1 : 0,
  };

  if (params.nossoNumero) payload["nossoNumero"] = params.nossoNumero;
  if (cfg.contratoCobranca) payload["numeroContratoCobranca"] = cfg.contratoCobranca;
  if (params.instrucoes?.length) payload["mensagensInstrucao"] = params.instrucoes;

  console.log("[Sicoob-Boleto] Payload:", JSON.stringify(payload));
  const result = await req(cfg, "POST", "/boletos", payload) as Record<string, unknown>;

  const r = (result["resultado"] as Record<string, unknown>) ?? result;
  const nossoNumeroRetornado = (r["nossoNumero"] as number) ?? params.nossoNumero ?? 0;
  console.log(`[Sicoob-Boleto] Boleto criado nossoNumero=${nossoNumeroRetornado} R$${valorBRL.toFixed(2)}`);

  return {
    nossoNumero:    nossoNumeroRetornado,
    codigoBarras:   (r["codigoBarras"]   as string) ?? "",
    linhaDigitavel: (r["linhaDigitavel"] as string) ?? "",
    urlPdf:         (r["pdfBoleto"]      as string) ?? undefined,
    brcodeHibrido:  (r["qrCode"]         as string) ?? undefined,
  };
}

// ── Consultar boleto ──────────────────────────────────────────────────────────

export async function consultarBoleto(cfg: SicoobBoletoConfig, nossoNumero: number): Promise<BoletoStatus> {
  const qs = new URLSearchParams({
    numeroCliente:    String(cfg.numeroCliente),
    codigoModalidade: String(cfg.codigoModalidade),
    nossoNumero:      String(nossoNumero),
  });
  const result = await req(cfg, "GET", `/boletos?${qs.toString()}`) as Record<string, unknown>;

  const res = result["resultado"];
  const b = (Array.isArray(res) ? res[0] : res) as Record<string, unknown>;

  return {
    situacao:       (b["situacaoBoleto"] as string) ?? "DESCONHECIDO",
    dataVencimento: (b["dataVencimento"] as string) ?? "",
    valor:          (b["valor"]          as number) ?? 0,
    valorPago:      (b["valorPago"]      as number) ?? undefined,
    dataPagamento:  (b["dataPagamento"]  as string) ?? undefined,
    nossoNumero:    (b["nossoNumero"]    as number) ?? nossoNumero,
    linhaDigitavel: (b["linhaDigitavel"] as string) ?? "",
    codigoBarras:   (b["codigoBarras"]   as string) ?? "",
  };
}

// ── Obter PDF do boleto (via campo pdfBoleto na consulta) ─────────────────────

export async function obterPdfBoleto(cfg: SicoobBoletoConfig, nossoNumero: number): Promise<Buffer> {
  const qs = new URLSearchParams({
    numeroCliente:    String(cfg.numeroCliente),
    codigoModalidade: String(cfg.codigoModalidade),
    nossoNumero:      String(nossoNumero),
    gerarPdf:         "true",
  });
  // Endpoint /boletos/{nossoNumero}/pdf não existe no Sicoob v3.
  // PDF é gerado localmente em boleto-html.ts a partir dos dados salvos.
  throw new Error("[Sicoob-Boleto] obterPdfBoleto não suportado — use gerarBoletoHtml");
}

// ── Baixar/cancelar boleto ────────────────────────────────────────────────────

export async function baixarBoleto(cfg: SicoobBoletoConfig, nossoNumero: number): Promise<void> {
  await req(cfg, "POST", `/boletos/${nossoNumero}/baixar`, {
    numeroCliente:    cfg.numeroCliente,
    codigoModalidade: cfg.codigoModalidade,
  });
  console.log(`[Sicoob-Boleto] Boleto ${nossoNumero} baixado`);
}

// ── Verificar se está configurado ─────────────────────────────────────────────

export function sicoobBoletoConfigurado(cfg: SicoobBoletoConfig): boolean {
  return !!(cfg.clientId && cfg.numeroCliente && cfg.contaCorrente && existsSync(resolve(cfg.certPath)));
}
