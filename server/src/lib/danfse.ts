// ─────────────────────────────────────────────────────────────────────────────
// DANFSe (PDF) das NFS-e emitidas por DPS (leiaute nacional)
//
// 1º Ambiente de Dados Nacional: GET adn.nfse.gov.br/danfse/{chave} com o A1
//    do emitente (mTLS) — PDF oficial.
// 2º Portal da E&L (Vitória da Conquista), quando o ADN está fora do ar (foi o
//    caso em 01/10/2026, HTTP 503): login no portal com o mesmo A1 e
//    findDanfseHtmlByChaveNfse (HTML do DANFSe nacional, em base64) → PDF.
// ─────────────────────────────────────────────────────────────────────────────

import { request as httpsRequest } from "node:https";
import { getCert, providerMunicipio, type EmpresaConfig } from "./nfse.js";
import { chamarMtls } from "./nfse-dps.js";
import { htmlToPdf } from "./pdf.js";

const ADN = { "1": "https://adn.nfse.gov.br", "2": "https://adn.producaorestrita.nfse.gov.br" };

const EL_PORTAL: Record<string, { front: string; back: string }> = {
  "2933307": {
    front: "https://ba-vitoriadaconquista-pm-nfs.cloud.el.com.br",
    back:  "https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao",
  },
};
const UA = "Mozilla/5.0 (Avoce NFS-e)";

type Resp = { status: number; location?: string; body: string };

function get(url: string, opts: { method?: string; cfg?: EmpresaConfig; headers?: Record<string, string> } = {}): Promise<Resp> {
  const cert = opts.cfg ? getCert(opts.cfg) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method:  opts.method ?? "GET",
      ...(cert ? { key: cert.privateKeyPem, cert: cert.certPem } : {}),
      headers: { "User-Agent": UA, ...opts.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, location: res.headers.location, body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error(`[DANFSe] Timeout ${url}`)));
    req.end();
  });
}

// ── Portal E&L: sessão pelo certificado (cache ~20 min por emitente) ─────────

type SessaoEl = { token: string; idContribuinte: string; expira: number };
const _sessoes = new Map<string, SessaoEl>();

async function sessaoEl(cfg: EmpresaConfig, portal: { front: string; back: string }): Promise<SessaoEl> {
  const cache = _sessoes.get(cfg.cnpj);
  if (cache && cache.expira > Date.now()) return cache;

  const r1 = await get(
    `https://certificado.cloud.el.com.br/gpilogin/base64NF?urlRetorno=${portal.back}/requestCertificado&urlFront=${portal.front}/login`,
    { cfg },
  );
  if (!r1.location) throw new Error(`[DANFSe] Login E&L (certificado) HTTP ${r1.status}`);
  const r2   = await get(r1.location);
  const auth = r2.location?.match(/auth=([^&]+)/)?.[1];
  if (!auth) throw new Error(`[DANFSe] Login E&L (retorno) HTTP ${r2.status}`);
  const r3 = await get(`${portal.back}/api/usuario/loginAuth?auth=${auth}`, {
    method: "POST", headers: { "Content-Type": "application/json; charset=UTF-8" },
  });
  const u = JSON.parse(r3.body);
  if (!u.token) throw new Error(`[DANFSe] Login E&L HTTP ${r3.status}`);

  const s = { token: u.token, idContribuinte: u.contribuinte.idContribuinte, expira: Date.now() + 20 * 60_000 };
  _sessoes.set(cfg.cnpj, s);
  return s;
}

async function danfseEl(cfg: EmpresaConfig, chave: string): Promise<Buffer> {
  const portal = EL_PORTAL[providerMunicipio(cfg)];
  if (!portal) throw new Error(`[DANFSe] Município ${providerMunicipio(cfg)} sem portal E&L`);
  const s = await sessaoEl(cfg, portal);
  const r = await get(
    `${portal.back}/api/nfse/notafiscal/findDanfseHtmlByChaveNfse?idContribuinte=${s.idContribuinte}&chaveNfse=${chave}`,
    { headers: { authorization: `Bearer ${s.token}`, Accept: "application/json, text/plain, */*" } },
  );
  if (r.status === 401) _sessoes.delete(cfg.cnpj);
  if (r.status !== 200) throw new Error(`[DANFSe] Portal E&L HTTP ${r.status}: ${r.body.slice(0, 200)}`);

  let html = r.body;
  try { const j = JSON.parse(html); if (typeof j === "string") html = j; } catch { /* já é texto */ }
  if (!html.includes("<")) html = Buffer.from(html.trim(), "base64").toString("utf8");   // vem em base64
  if (!/<html/i.test(html)) throw new Error("[DANFSe] Portal E&L não devolveu HTML");
  return htmlToPdf(html);
}

/** PDF do DANFSe da NFS-e (chave nacional de 50 dígitos). */
export async function obterDanfsePdf(cfg: EmpresaConfig, chave: string): Promise<Buffer> {
  try {
    const r = await chamarMtls(cfg, `${ADN[cfg.tpAmb === "2" ? "2" : "1"]}/danfse/${chave}`, undefined, "binario");
    if (r.status === 200 && r.bytes.subarray(0, 4).toString() === "%PDF") return r.bytes;
    console.warn(`[DANFSe] ADN HTTP ${r.status} para ${chave} — tentando portal do município`);
  } catch (err) {
    console.warn(`[DANFSe] ADN indisponível para ${chave}:`, (err as Error).message);
  }
  return danfseEl(cfg, chave);
}
