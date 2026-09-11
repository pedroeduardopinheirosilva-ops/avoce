/**
 * Client da API pública do PAKT (v1, autenticada por API key).
 *
 * Usa a MESMA conta/API key já configurada no Avoce (PAKT_API_KEY), que é a mesma
 * do PSA-MT — os dois sistemas compartilham o tenant PAKT.
 *
 * Atenção ao formato das respostas do /api/v1 (routes/v1.ts do PAKT):
 *   POST /documents        → { id, nome, status, signers:[{id,nome,email,signUrl,tokenAcesso}] }
 *   GET  /documents        → { documents:[...], pagination:{page,limit,total,totalPages} }
 *   GET  /documents/:id    → { ...documento, signers:[{...,signUrl}], auditLogs:[...] }
 */

export const PAKT_BASE_URL = process.env.PAKT_BASE_URL ?? "https://pakt.capium.com.br";
const PAKT_API = `${PAKT_BASE_URL}/api/v1`;

export type PaktSignerInput = {
  nome: string;
  email: string;
  telefone?: string;
  countryCode?: string;
  /** SIGNER | WITNESS | APPROVER — o PAKT valida como enum */
  signatureRole?: "SIGNER" | "WITNESS" | "APPROVER";
  orderIndex?: number;
};

export type PaktSignerOut = {
  id: string;
  nome: string;
  email: string;
  signUrl?: string;
  tokenAcesso?: string;
  status?: string;
  signedAt?: string | null;
  orderIndex?: number;
};

export type PaktDocumentOut = {
  id: string;
  nome: string;
  status: string;
  signers: PaktSignerOut[];
  createdAt?: string;
  hashOriginal?: string;
  auditLogs?: Array<{ evento: string; createdAt: string }>;
};

function apiKey(): string {
  const key = process.env.PAKT_API_KEY ?? "";
  if (!key) throw new Error("PAKT_API_KEY não configurada no ecosystem.config.cjs");
  return key;
}

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${apiKey()}` };
}

async function ok(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new Error(`PAKT ${ctx} falhou (${res.status}): ${body.slice(0, 400)}`);
}

/** POST /documents — cria o documento em DRAFT. */
export async function paktCriarDocumento(
  file: Buffer,
  filename: string,
  metadata: {
    nome: string;
    mensagem?: string;
    expiresAt?: string;
    signers: PaktSignerInput[];
  },
): Promise<PaktDocumentOut> {
  const form = new FormData();
  form.append("file", new Blob([file as unknown as BlobPart], { type: "application/pdf" }), filename);
  form.append("metadata", JSON.stringify(metadata));

  const res = await fetch(`${PAKT_API}/documents`, { method: "POST", headers: headers(), body: form });
  await ok(res, "criar documento");
  const json = (await res.json()) as any;
  // Aceita tanto a resposta plana do /v1 quanto a aninhada ({document:{...}}) por segurança.
  const doc = json.document ?? json;
  return { ...doc, signers: json.signers ?? doc.signers ?? [] } as PaktDocumentOut;
}

/** POST /documents/:id/send — DRAFT → PENDING e dispara os e-mails do PAKT. */
export async function paktEnviarDocumento(paktId: string): Promise<void> {
  const res = await fetch(`${PAKT_API}/documents/${paktId}/send`, { method: "POST", headers: headers() });
  await ok(res, "enviar documento");
}

/** GET /documents/:id — detalhe com signatários (signUrl) e trilha de auditoria. */
export async function paktObterDocumento(paktId: string): Promise<PaktDocumentOut> {
  const res = await fetch(`${PAKT_API}/documents/${paktId}`, { headers: headers() });
  await ok(res, "obter documento");
  const json = (await res.json()) as any;
  const doc = json.document ?? json;
  return { ...doc, signers: json.signers ?? doc.signers ?? [] } as PaktDocumentOut;
}

/**
 * GET /documents — lista os documentos da conta PAKT (compartilhada com o PSA-MT).
 * Vem ordenado por createdAt desc; `status` filtra no servidor (ex.: "COMPLETED").
 */
export async function paktListarDocumentos(
  page = 1,
  limit = 100,
  status?: string,
): Promise<{ documents: PaktDocumentOut[]; pagination: { page: number; limit: number; total: number; totalPages: number } }> {
  const qs = `page=${page}&limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ""}`;
  const res = await fetch(`${PAKT_API}/documents?${qs}`, { headers: headers() });
  await ok(res, "listar documentos");
  return (await res.json()) as any;
}

/** GET /documents/:id/download?type=original|final */
export async function paktBaixarPdf(paktId: string, tipo: "original" | "final" = "original"): Promise<Buffer> {
  const res = await fetch(`${PAKT_API}/documents/${paktId}/download?type=${tipo}`, { headers: headers() });
  await ok(res, "baixar PDF");
  return Buffer.from(await res.arrayBuffer());
}

/** DELETE /documents/:id — cancela o documento. */
export async function paktCancelarDocumento(paktId: string): Promise<void> {
  const res = await fetch(`${PAKT_API}/documents/${paktId}`, { method: "DELETE", headers: headers() });
  await ok(res, "cancelar documento");
}
