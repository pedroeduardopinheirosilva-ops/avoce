// ─────────────────────────────────────────────────────────────────────────────
// Sicoob PIX — Cobrança Imediata (API Pix v2)
// mTLS com certificado ICP-Brasil da empresa emitente
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "undici";

export interface SicoobPixConfig {
  clientId: string;
  pixChave: string;
  certPath: string;
  certPass: string;
}

// ── mTLS Agent (cache por certPath+pass) ──────────────────────────────────────

const _agents = new Map<string, Agent>();

function getAgent(cfg: SicoobPixConfig): Agent {
  const key = `${cfg.certPath}::${cfg.certPass}`;
  if (_agents.has(key)) return _agents.get(key)!;
  const fullPath = resolve(cfg.certPath);
  if (!existsSync(fullPath)) throw new Error(`[Sicoob] Certificado não encontrado: ${fullPath}`);
  const pfx = readFileSync(fullPath);
  const agent = new Agent({ connect: { pfx, passphrase: cfg.certPass, rejectUnauthorized: true } });
  _agents.set(key, agent);
  console.log(`[Sicoob] mTLS agent inicializado para ${fullPath}`);
  return agent;
}

// ── OAuth2 token (cache por clientId) ────────────────────────────────────────

const TOKEN_URL = "https://auth.sicoob.com.br/auth/realms/cooperado/protocol/openid-connect/token";
const _tokens = new Map<string, { token: string; expiresAt: number }>();

async function getToken(cfg: SicoobPixConfig): Promise<string> {
  const cached = _tokens.get(cfg.clientId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id:  cfg.clientId,
    scope:      "cob.read cob.write pix.read pix.write",
  });

  const res = await (fetch as any)(TOKEN_URL, {
    method:     "POST",
    headers:    { "Content-Type": "application/x-www-form-urlencoded" },
    body:       body.toString(),
    dispatcher: getAgent(cfg),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[Sicoob] Auth falhou (${res.status}): ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  _tokens.set(cfg.clientId, { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 });
  return data.access_token;
}

// ── Requisição autenticada ────────────────────────────────────────────────────

const API_BASE = "https://api.sicoob.com.br/pix/api/v2";

async function req(cfg: SicoobPixConfig, method: string, path: string, body?: unknown): Promise<unknown> {
  const token = await getToken(cfg);
  const res = await (fetch as any)(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body:       body ? JSON.stringify(body) : undefined,
    dispatcher: getAgent(cfg),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`[Sicoob] ${method} ${path} (${res.status}): ${text}`);
  return text ? JSON.parse(text) : {};
}

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export interface PixCriado {
  txid:      string;
  brcode:    string;
  qrcode?:   string;
  location:  string;
  expiresAt: Date;
  valor:     string;
}

export interface PixStatus {
  status:            "PENDENTE" | "PAGO" | "EXPIRADO";
  paidAt?:           Date;
  valorPago?:        string;
  pagador?:          string;
  pagadorCpfCnpj?:   string;
  pagadorBancoIspb?: string;
  endToEnd?:         string;
}

// ── Criar cobrança PIX ────────────────────────────────────────────────────────

export async function criarPix(cfg: SicoobPixConfig, params: {
  valor:       number;
  descricao:   string;
  referencia?: string;
  expiracao?:  number;
}): Promise<PixCriado> {
  if (!cfg.clientId) {
    throw new Error("[Sicoob] PIX não configurado — verifique clientId na empresa");
  }

  const valorBRL = (params.valor / 100).toFixed(2);
  const TRINTA_DIAS = 30 * 24 * 60 * 60;
  const expiracao = Math.max(params.expiracao ?? TRINTA_DIAS, TRINTA_DIAS);
  const txid = `avoce${Date.now()}${randomUUID().replace(/-/g, "").slice(0, 10)}`;

  const payload = {
    calendario:         { expiracao },
    valor:              { original: valorBRL },
    chave:              cfg.pixChave,
    solicitacaoPagador: params.descricao.slice(0, 140),
    ...(params.referencia && {
      infoAdicionais: [{ nome: "ref", valor: params.referencia.slice(0, 50) }],
    }),
  };

  const charge = await req(cfg, "PUT", `/cob/${txid}`, payload) as Record<string, unknown>;

  let brcode = charge["brcode"] as string ?? "";
  let qrcode: string | undefined;

  if (!brcode) {
    try {
      const full = await req(cfg, "GET", `/cob/${txid}`) as Record<string, unknown>;
      brcode = full["brcode"] as string ?? "";
    } catch { /* ignora */ }
  }

  const loc = charge["loc"] as { id?: number } | undefined;
  if (loc?.id) {
    try {
      const qr = await req(cfg, "GET", `/loc/${loc.id}/qrcode`) as Record<string, unknown>;
      if (qr["qrcode"]) brcode = qr["qrcode"] as string;
      if (qr["imagemQrcode"]) qrcode = qr["imagemQrcode"] as string;
    } catch { /* ignora */ }
  }

  if (!qrcode && brcode) {
    try {
      const QRCode = await import("qrcode");
      qrcode = await QRCode.default.toDataURL(brcode, { width: 300, margin: 2 });
    } catch { /* ignora */ }
  }

  const expiresAt = new Date(Date.now() + expiracao * 1000);
  const location  = (charge["location"] as string) ?? "";

  console.log(`[Sicoob] PIX criado txid=${txid} R$${valorBRL}`);
  return { txid, brcode, qrcode, location, expiresAt, valor: valorBRL };
}

// ── Consultar status ──────────────────────────────────────────────────────────

export async function consultarPix(cfg: SicoobPixConfig, txid: string): Promise<PixStatus> {
  const charge = await req(cfg, "GET", `/cob/${txid}`) as Record<string, unknown>;

  if (charge["status"] === "CONCLUIDA") {
    const pixArr = charge["pix"] as Array<Record<string, unknown>> | undefined;
    const pix = pixArr?.[0];
    const pagadorObj = pix?.["pagador"] as { nome?: string; cpf?: string; cnpj?: string } | undefined;
    const endToEndId = pix?.["endToEndId"] as string | undefined;
    const pagadorBancoIspb = endToEndId?.startsWith("E") ? endToEndId.slice(1, 9) : undefined;
    const pagadorCpfCnpj = pagadorObj?.cpf ?? pagadorObj?.cnpj ?? undefined;
    return {
      status:           "PAGO",
      paidAt:           pix ? new Date(pix["horario"] as string) : undefined,
      valorPago:        pix?.["valor"] as string,
      pagador:          pagadorObj?.nome,
      pagadorCpfCnpj,
      pagadorBancoIspb,
      endToEnd:         endToEndId,
    };
  }

  const criacao   = new Date((charge["calendario"] as { criacao?: string })?.criacao ?? Date.now());
  const expiracao = (charge["calendario"] as { expiracao?: number })?.expiracao ?? 259200;
  if (new Date() > new Date(criacao.getTime() + expiracao * 1000)) {
    return { status: "EXPIRADO" };
  }
  return { status: "PENDENTE" };
}

// ── Webhook ───────────────────────────────────────────────────────────────────

export async function registrarWebhookPix(cfg: SicoobPixConfig, webhookUrl: string): Promise<void> {
  if (!cfg.pixChave) throw new Error("[Sicoob] pixChave não configurada na empresa");
  await req(cfg, "PUT", `/webhook/${encodeURIComponent(cfg.pixChave)}`, { webhookUrl });
  console.log(`[Sicoob] Webhook PIX registrado: ${webhookUrl}`);
}

export async function consultarWebhookPix(cfg: SicoobPixConfig): Promise<{ webhookUrl?: string } | null> {
  if (!cfg.pixChave) return null;
  try {
    const r = await req(cfg, "GET", `/webhook/${encodeURIComponent(cfg.pixChave)}`);
    return r as { webhookUrl?: string };
  } catch {
    return null;
  }
}

// ── Verificar se está configurado ─────────────────────────────────────────────

export function sicoobPixConfigurado(cfg: SicoobPixConfig): boolean {
  return !!(cfg.clientId && existsSync(resolve(cfg.certPath)));
}
