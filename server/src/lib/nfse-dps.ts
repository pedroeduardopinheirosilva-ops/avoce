// ─────────────────────────────────────────────────────────────────────────────
// NFS-e — modelo DPS (leiaute Nacional v1.01), por dois canais:
//   "el"    → API própria da E&L (Vitória da Conquista), autenticação por token
//   "sefin" → Emissor Nacional (Sefin Nacional), autenticação mTLS com o A1
// Optantes do Simples Nacional (ME/EPP) passam ao Emissor Nacional em 01/11/2026
// (Resolução CGSN nº 191/2026); a troca é automática — ver canalEmissao().
//
// Desde 01/10/2026 a E&L desativou o ABRASF 2.04 para emissão/cancelamento
// (erro E999 "Com a Obrigatoriedade do IBS CBS o modelo Abrasf foi desativado").
// A emissão passa a ser por DPS no leiaute nacional, enviada à API REST da E&L,
// que converte em NFS-e municipal e transmite ao Ambiente Nacional (ADN).
//
// Documentação: "Orientações - API de Integração NFS-e Nacional.pdf" em
//   https://s3.us-east-1.amazonaws.com/el.com.br/nfse/Layout_EL_DPS_Nacional.zip
//
//   POST {base}/nfse?token=…                  {"dpsXmlGZipB64": …}  → 201 {idDPS}
//   GET  {base}/nfseDps/{idDPS}?token=…       → {chaveAcesso, nfseXmlGZipB64 | erros[]}
//   POST {base}/nfse/{chave}/eventos?token=…  {"pedidoRegistroEventoXmlGZipB64": …}
//
//   base produção:    …/producao/api/nacional
//   base homologação: …/producao/api/nacional/homologacao
//
// Autenticação: token de integração do contribuinte (portal E&L → Configurações →
// Integração). O XML continua assinado com o A1 do prestador (XMLDSig enveloped).
// O processamento é ASSÍNCRONO: o 201 só confirma o recebimento; a NFS-e sai
// depois, consultando /nfseDps/{idDPS}. Reenviar o MESMO idDPS reprocessa a DPS
// (não duplica), por isso o nDPS vem de uma sequence do banco e é gravado na nota.
//
// Sefin Nacional (síncrono — o 201 já traz a NFS-e):
//   POST {sefin}/nfse                 {"dpsXmlGZipB64": …}  → {idDps, chaveAcesso, nfseXmlGZipB64}
//   GET  {sefin}/dps/{idDPS}          → {chaveAcesso}
//   GET  {sefin}/nfse/{chave}         → {nfseXmlGZipB64}
//   POST {sefin}/nfse/{chave}/eventos {"pedidoRegistroEventoXmlGZipB64": …}
// ─────────────────────────────────────────────────────────────────────────────

import { gzipSync, gunzipSync } from "node:zlib";
import { request as httpsRequest } from "node:https";
import { prisma }               from "../db.js";
import { assinarXml, escXml, getCert, providerMunicipio, type EmpresaConfig, type NfseStatus, type TomadorNfse } from "./nfse.js";

const EL_BASE: Record<string, string> = {
  "2933307": "https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao/api/nacional",
};

const SEFIN_BASE = { "1": "https://sefin.nfse.gov.br/SefinNacional", "2": "https://sefin.producaorestrita.nfse.gov.br/SefinNacional" };

/** Res. CGSN nº 191/2026: ME/EPP do Simples emitem pelo Emissor Nacional desde 01/11/2026. */
export const INICIO_EMISSOR_NACIONAL_SN = new Date("2026-11-01T00:00:00-03:00");

export type CanalDps = "el" | "sefin";

/** Canal de emissão: Emissor Nacional para o Simples a partir de 01/11/2026 (ou quando o
 *  emitente estiver configurado como "sefin_nacional"); senão o provedor municipal. */
export function canalEmissao(cfg: EmpresaConfig, agora = new Date()): CanalDps {
  if (cfg.nfseProvider === "sefin_nacional") return "sefin";
  if (cfg.simplesNacional === "1" && agora >= INICIO_EMISSOR_NACIONAL_SN) return "sefin";
  return "el";
}

/** Canal que gerou a NFS-e: ambGer 2 = Sefin Nacional; 1 = sistema do município. */
export function canalDaNota(xmlNfse: string | null | undefined): CanalDps {
  return /<(?:\w+:)?ambGer>\s*2\s*</.test(xmlNfse ?? "") ? "sefin" : "el";
}

// Município fora do convênio do Emissor Nacional (E0037) ou não parametrizado para os
// emissores públicos nacionais (E0039): a DPS não foi registrada e pode
// seguir pelo provedor municipal sem risco de duplicidade.
export function semConvenioNacional(err: unknown): boolean {
  return err instanceof DpsRejeitadaError &&
    err.erros.some(e => ["E0037", "E0039"].includes(e.codigo) || /conv[êe]nio|emissores p[úu]blicos nacionais/i.test(e.descricao));
}

// Série própria do Avoce: separa a numeração das DPS emitidas pelo portal da E&L.
export const SERIE_DPS_AVOCE = "900";

// O WAF da E&L devolve 403 para User-Agents de ferramentas (curl etc.).
const UA = "Mozilla/5.0 (Avoce NFS-e)";

const EM_PROCESSAMENTO = /processamento/i;

export interface DpsParams {
  nDps:          number;
  valor:         number;          // centavos
  discriminacao: string;
  tomador:       TomadorNfse;
  competencia?:  string;          // "YYYY-MM"
  issRetido?:    boolean;
  retirIr?:      boolean;
  retirCsll?:    boolean;
  retirPis?:     boolean;
  retirCofins?:  boolean;
}

export interface DpsResultado {
  idDps:        string;
  chaveAcesso?: string;
  numero?:      string;
  dataEmissao?: string;
  linkNfse?:    string;
  xmlNfse?:     string;
  processando:  boolean;
}

export class DpsRejeitadaError extends Error {
  constructor(public idDps: string, public erros: { codigo: string; descricao: string }[]) {
    super(`[NFS-e DPS] ${erros.map(e => `${e.codigo}: ${e.descricao}`).join(" | ")}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALIQ_IR     = 0.015;
const ALIQ_CSLL   = 0.010;
const ALIQ_PIS    = 0.0065;
const ALIQ_COFINS = 0.030;

function apiBase(cfg: EmpresaConfig): string {
  const mun  = providerMunicipio(cfg);
  const base = EL_BASE[mun];
  if (!base) throw new Error(`[NFS-e DPS] Município ${mun} sem API E&L configurada`);
  return cfg.tpAmb === "2" ? `${base}/homologacao` : base;
}

function token(cfg: EmpresaConfig): string {
  if (!cfg.nfseToken) throw new Error("[NFS-e DPS] Token de integração E&L não configurado para o emitente");
  return encodeURIComponent(cfg.nfseToken);
}

/** dhEmi no fuso de Brasília, 5 min no passado: o relógio da E&L anda ~4 min atrasado
 *  e a DPS não pode ser emitida "no futuro" em relação ao processamento. */
function dhEmiBrt(): string {
  const brt = new Date(Date.now() - 5 * 60_000 - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 19) + "-03:00";
}

/** Próximo nº de DPS da série do Avoce (sequence do Postgres — atômico entre processos).
 *  O usuário avoce não tem CREATE no schema: a sequence é criada pelo postgres
 *  (CREATE SEQUENCE nfse_dps_seq; ALTER SEQUENCE nfse_dps_seq OWNER TO avoce). */
export async function proximoNDps(): Promise<number> {
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT nextval('nfse_dps_seq') AS n`);
  return Number(n);
}

export function idDps(cfg: EmpresaConfig, nDps: number, serie = SERIE_DPS_AVOCE): string {
  const cnpj = cfg.cnpj.replace(/\D/g, "");
  return "DPS" + providerMunicipio(cfg) + "2" + cnpj.padStart(14, "0") +
    serie.padStart(5, "0") + String(nDps).padStart(15, "0");
}

const reais = (centavos: number) => (centavos / 100).toFixed(2);
const so    = (s: string | undefined, re = /\D/g) => (s ?? "").replace(re, "");

/** GZip + Base64 do XML, com a declaração UTF-8 que a Sefin exige (E1229). */
function gz64(xml: string): string {
  const doc = xml.startsWith("<?xml") ? xml : `<?xml version="1.0" encoding="UTF-8"?>${xml}`;
  return gzipSync(Buffer.from(doc, "utf8")).toString("base64");
}

function ungz64(b64: string): string {
  return gunzipSync(Buffer.from(b64, "base64")).toString("utf8");
}

function tag(xml: string, nome: string): string {
  return xml.match(new RegExp(`<(?:\\w+:)?${nome}[^>]*>([^<]*)</(?:\\w+:)?${nome}>`))?.[1]?.trim() ?? "";
}

function errosDe(json: any): { codigo: string; descricao: string }[] {
  const lista = Array.isArray(json?.erros) ? json.erros : [];
  return lista.map((e: any) => ({
    codigo:    String(e.codigo ?? e.Codigo ?? ""),
    descricao: [e.descricao ?? e.Descricao, e.complemento ?? e.Complemento].filter(Boolean).join(" — "),
  }));
}

async function chamar(url: string, init?: { method: string; body: unknown }): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method:  init?.method ?? "GET",
    headers: { "Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA },
    body:    init ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { bruto: text.slice(0, 500) }; }
  return { status: res.status, json };
}

function sefinBase(cfg: EmpresaConfig): string {
  return SEFIN_BASE[cfg.tpAmb === "2" ? "2" : "1"];
}

/** Chamada à Sefin Nacional / ADN com o certificado A1 do emitente (mTLS). */
export function chamarMtls(
  cfg: EmpresaConfig,
  url: string,
  init?: { method: string; body: unknown },
  aceita: "json" | "binario" = "json",
): Promise<{ status: number; json: any; bytes: Buffer; contentType: string }> {
  const { privateKeyPem, certPem } = getCert(cfg);
  const body = init ? JSON.stringify(init.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method:  init?.method ?? "GET",
      key:     privateKeyPem,
      cert:    certPem,
      headers: {
        "Accept": aceita === "json" ? "application/json" : "*/*",
        "User-Agent": UA,
        ...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let json: any;
        try { json = JSON.parse(bytes.toString("utf8")); } catch { json = { bruto: bytes.toString("utf8").slice(0, 500) }; }
        resolve({ status: res.statusCode ?? 0, json, bytes, contentType: String(res.headers["content-type"] ?? "") });
      });
    });
    req.on("error", reject);
    req.setTimeout(90_000, () => req.destroy(new Error(`[NFS-e] Timeout ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

// ── Município do tomador pelo CEP ────────────────────────────────────────────
// A Sefin cruza CEP × cMun e exige endereço de tomador CNPJ (E1358). Muitos
// tomadores não têm codigoMunicipio no cadastro e os chamadores completam com o
// município do prestador; o IBGE vindo do CEP é a fonte confiável.

const _ibgePorCep = new Map<string, string | null>();

async function ibgeDoCep(cep: string): Promise<string | null> {
  if (_ibgePorCep.has(cep)) return _ibgePorCep.get(cep)!;
  let ibge: string | null = null;
  try {
    const res  = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(5_000) });
    const json = await res.json() as { ibge?: string; erro?: boolean };
    ibge = !json.erro && /^\d{7}$/.test(json.ibge ?? "") ? json.ibge! : null;
  } catch (err) {
    console.warn(`[NFS-e DPS] ViaCEP indisponível para ${cep}:`, (err as Error).message);
    return null;   // não cacheia falha de rede
  }
  _ibgePorCep.set(cep, ibge);
  return ibge;
}

async function comMunicipioDoCep(t: TomadorNfse): Promise<TomadorNfse> {
  const cep = so(t.cep);
  if (cep.length !== 8 || /^0+$/.test(cep)) return t;
  const ibge = await ibgeDoCep(cep);
  return ibge ? { ...t, codigoMunicipio: ibge } : t;
}

// ── Montagem da DPS ──────────────────────────────────────────────────────────

export function montarDps(cfg: EmpresaConfig, p: DpsParams, canal: CanalDps = "el"): { xml: string; id: string } {
  const id        = idDps(cfg, p.nDps);
  const municipio = providerMunicipio(cfg);
  const agora     = dhEmiBrt();
  const dCompet   = p.competencia ? `${p.competencia}-01` : agora.slice(0, 10);
  const base      = p.valor / 100;
  const simples   = cfg.simplesNacional === "1";

  // Sefin Nacional: IM só pode ir se constar no CNC NFS-e do município (E0120 em 01/11/2026 —
  // VDC não registrou informações complementares). Na E&L a IM continua sendo enviada.
  const im      = so(cfg.inscricaoMunicipal);
  const imPrest = im && canal === "el" ? `<IM>${im}</IM>` : "";

  const regTrib = simples
    ? `<opSimpNac>3</opSimpNac><regApTribSN>1</regApTribSN><regEspTrib>0</regEspTrib>`
    : `<opSimpNac>1</opSimpNac><regEspTrib>0</regEspTrib>`;

  const doc   = so(p.tomador.cpfCnpj);
  const tomaId = doc.length === 14 ? `<CNPJ>${doc}</CNPJ>` : `<CPF>${doc}</CPF>`;
  const cMunToma = so(p.tomador.codigoMunicipio);
  const cepToma  = so(p.tomador.cep);
  // Endereço é opcional no leiaute nacional; os chamadores preenchem CEP "00000000" quando o
  // tomador não tem cadastro — nesse caso omite (a Sefin valida CEP × município).
  const endToma = cMunToma.length === 7 && cepToma.length === 8 && !/^0+$/.test(cepToma)
    ? `<end><endNac><cMun>${cMunToma}</cMun><CEP>${cepToma}</CEP></endNac>` +
      `<xLgr>${escXml(p.tomador.endereco.slice(0, 255))}</xLgr>` +
      `<nro>${escXml((p.tomador.numero || "S/N").slice(0, 60))}</nro>` +
      `<xBairro>${escXml(p.tomador.bairro.slice(0, 60))}</xBairro></end>`
    : "";
  const emailToma = p.tomador.email ? `<email>${escXml(p.tomador.email.slice(0, 80))}</email>` : "";

  const cIntContrib = so(cfg.codTributacao, /[^a-zA-Z0-9]/g).slice(0, 20);
  const cServ =
    `<cTribNac>${so(cfg.codigoServicoNacional)}</cTribNac>` +
    `<xDescServ>${escXml(p.discriminacao.slice(0, 2000))}</xDescServ>` +
    (cfg.codigoNbs ? `<cNBS>${so(cfg.codigoNbs)}</cNBS>` : "") +
    (cIntContrib ? `<cIntContrib>${cIntContrib}</cIntContrib>` : "");

  const tribMun =
    `<tribISSQN>1</tribISSQN>` +
    `<tpRetISSQN>${p.issRetido ? "2" : "1"}</tpRetISSQN>` +
    // E0625 (Sefin, 03/11/2026): ME/EPP do Simples sem retenção não informa alíquota —
    // o ISSQN é apurado no DAS. Com retenção (tpRetISSQN 2) a alíquota continua obrigatória.
    (simples && !p.issRetido ? "" : `<pAliq>${(cfg.aliquotaIss * 100).toFixed(2)}</pAliq>`);

  // E0712 (Sefin, 03/11/2026): ME/EPP não pode usar indTotTrib — informa pTotTribSN, o % aproximado
  // de tributos do Simples (alíquota efetiva do PGDAS-D). Vem de NFSE_PTOTTRIBSN_<CNPJ> no ecosystem.
  const pTotSN  = process.env[`NFSE_PTOTTRIBSN_${so(cfg.cnpj)}`];
  if (simples && !pTotSN) throw new Error(`[NFS-e DPS] Falta NFSE_PTOTTRIBSN_${so(cfg.cnpj)} (% aproximado de tributos do Simples)`);
  const totTrib = simples
    ? `<pTotTribSN>${Number(pTotSN!.replace(",", ".")).toFixed(2)}</pTotTribSN>`
    : `<indTotTrib>0</indTotTrib>`;

  const ret = (aplica: boolean | undefined, aliq: number) => (aplica ? base * aliq : 0).toFixed(2);
  const temPisCofins = p.retirPis || p.retirCofins;
  const tribFed = (temPisCofins || p.retirIr || p.retirCsll)
    ? `<tribFed>` +
        (temPisCofins
          ? `<piscofins><CST>01</CST><vBCPisCofins>${base.toFixed(2)}</vBCPisCofins>` +
            `<pAliqPis>${(ALIQ_PIS * 100).toFixed(2)}</pAliqPis><pAliqCofins>${(ALIQ_COFINS * 100).toFixed(2)}</pAliqCofins>` +
            `<vPis>${ret(p.retirPis, ALIQ_PIS)}</vPis><vCofins>${ret(p.retirCofins, ALIQ_COFINS)}</vCofins>` +
            `<tpRetPisCofins>1</tpRetPisCofins></piscofins>`
          : "") +
        (p.retirIr   ? `<vRetIRRF>${ret(true, ALIQ_IR)}</vRetIRRF>`   : "") +
        (p.retirCsll ? `<vRetCSLL>${ret(true, ALIQ_CSLL)}</vRetCSLL>` : "") +
      `</tribFed>`
    : "";

  const xml =
    `<DPS xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">` +
    `<infDPS Id="${id}">` +
      `<tpAmb>${cfg.tpAmb === "2" ? "2" : "1"}</tpAmb>` +
      `<dhEmi>${agora}</dhEmi>` +
      `<verAplic>Avoce-1.0</verAplic>` +
      `<serie>${SERIE_DPS_AVOCE}</serie>` +
      `<nDPS>${p.nDps}</nDPS>` +
      `<dCompet>${dCompet}</dCompet>` +
      `<tpEmit>1</tpEmit>` +
      `<cLocEmi>${municipio}</cLocEmi>` +
      `<prest><CNPJ>${so(cfg.cnpj)}</CNPJ>${imPrest}<regTrib>${regTrib}</regTrib></prest>` +
      `<toma>${tomaId}<xNome>${escXml(p.tomador.nome.slice(0, 300))}</xNome>${endToma}${emailToma}</toma>` +
      `<serv><locPrest><cLocPrestacao>${municipio}</cLocPrestacao></locPrest><cServ>${cServ}</cServ></serv>` +
      `<valores>` +
        `<vServPrest><vServ>${reais(p.valor)}</vServ></vServPrest>` +
        `<trib><tribMun>${tribMun}</tribMun>${tribFed}<totTrib>${totTrib}</totTrib></trib>` +
      `</valores>` +
    `</infDPS>` +
    `</DPS>`;

  return { xml, id };
}

/** URL do QR code do DANFSe (consulta pública nacional). */
export function linkConsultaPublica(chave: string): string {
  return `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`;
}

// ── Leitura da NFS-e autorizada ──────────────────────────────────────────────

function lerNfse(idDps: string, chave: string | undefined, xmlNfse: string): DpsResultado {
  const chaveXml = xmlNfse.match(/<infNFSe[^>]*Id="NFS(\d{50})"/)?.[1];
  const ch       = chave || chaveXml;
  return {
    idDps,
    chaveAcesso: ch,
    numero:      tag(xmlNfse, "nNFSe") || undefined,
    dataEmissao: (tag(xmlNfse, "dhProc") || tag(xmlNfse, "dhEmi")).slice(0, 10) || undefined,
    linkNfse:    ch ? linkConsultaPublica(ch) : undefined,
    xmlNfse,
    processando: false,
  };
}

// ── Operações ────────────────────────────────────────────────────────────────

function verificar(id: string, status: number, json: any, oque: string): void {
  const erros = errosDe(json);
  if (erros.length) throw new DpsRejeitadaError(id, erros);
  if (status >= 300) throw new Error(`[NFS-e DPS] ${oque} HTTP ${status}: ${JSON.stringify(json).slice(0, 500)}`);
}

async function dpsAssinada(cfg: EmpresaConfig, p: DpsParams, canal: CanalDps = "el"): Promise<{ id: string; b64: string }> {
  const { xml, id } = montarDps(cfg, { ...p, tomador: await comMunicipioDoCep(p.tomador) }, canal);
  return { id, b64: gz64(assinarXml(xml, id, cfg, "infDPS")) };
}

/** E&L: envia (ou reenvia, mesmo nDps = mesmo idDPS) a DPS. Não espera a autorização. */
export async function enviarDps(cfg: EmpresaConfig, p: DpsParams): Promise<string> {
  const { id, b64 } = await dpsAssinada(cfg, p);
  const { status, json } = await chamar(`${apiBase(cfg)}/nfse?token=${token(cfg)}`, {
    method: "POST", body: { dpsXmlGZipB64: b64 },
  });
  verificar(id, status, json, "Envio");
  console.log(`[NFS-e DPS] Recebida ${json.idDPS ?? id} (HTTP ${status})`);
  return json.idDPS ?? id;
}

/** Sefin Nacional: envio síncrono — a resposta já traz a NFS-e autorizada. */
async function emitirDpsSefin(cfg: EmpresaConfig, p: DpsParams): Promise<DpsResultado> {
  const { id, b64 } = await dpsAssinada(cfg, p, "sefin");
  const { status, json } = await chamarMtls(cfg, `${sefinBase(cfg)}/nfse`, {
    method: "POST", body: { dpsXmlGZipB64: b64 },
  });
  verificar(id, status, json, "Envio Sefin");
  if (!json.nfseXmlGZipB64) throw new Error(`[NFS-e DPS] Sefin sem NFS-e na resposta: ${JSON.stringify(json).slice(0, 500)}`);
  const r = lerNfse(json.idDps ?? id, json.chaveAcesso, ungz64(json.nfseXmlGZipB64));
  console.log(`[NFS-e DPS] Sefin autorizou ${r.idDps} → NFS-e ${r.numero} chave ${r.chaveAcesso}`);
  return r;
}

/** Situação da DPS. Lança DpsRejeitadaError se o processamento falhou. */
export async function consultarDps(cfg: EmpresaConfig, idDps: string, canal: CanalDps = "el"): Promise<DpsResultado> {
  if (canal === "sefin") {
    const d = await chamarMtls(cfg, `${sefinBase(cfg)}/dps/${idDps}`);
    if (d.status === 404) return { idDps, processando: true };
    verificar(idDps, d.status, d.json, "Consulta DPS Sefin");
    const n = await chamarMtls(cfg, `${sefinBase(cfg)}/nfse/${d.json.chaveAcesso}`);
    verificar(idDps, n.status, n.json, "Consulta NFS-e Sefin");
    return lerNfse(idDps, d.json.chaveAcesso, ungz64(n.json.nfseXmlGZipB64));
  }

  const { status, json } = await chamar(`${apiBase(cfg)}/nfseDps/${idDps}?token=${token(cfg)}`);
  verificar(idDps, status, json, "Consulta");
  const b64 = json.nfseXmlGZipB64 as string | undefined;
  if (!b64 || EM_PROCESSAMENTO.test(b64)) {
    return { idDps, chaveAcesso: json.chaveAcesso || undefined, processando: true };
  }
  return lerNfse(idDps, json.chaveAcesso, ungz64(b64));
}

/** Emite a DPS pelo canal do emitente. Na E&L acompanha o processamento por até `esperaMs`.
 *  Se o Emissor Nacional recusar por falta de convênio do município, segue pela E&L. */
export async function emitirDps(cfg: EmpresaConfig, p: DpsParams, esperaMs = 90_000): Promise<DpsResultado & { canal: CanalDps }> {
  if (canalEmissao(cfg) === "sefin") {
    try {
      return { ...await emitirDpsSefin(cfg, p), canal: "sefin" };
    } catch (err) {
      if (!semConvenioNacional(err) || !EL_BASE[providerMunicipio(cfg)] || !cfg.nfseToken) throw err;
      console.warn(`[NFS-e DPS] Emissor Nacional sem convênio para ${providerMunicipio(cfg)} — seguindo pela E&L`);
    }
  }

  const id     = await enviarDps(cfg, p);
  const limite = Date.now() + esperaMs;
  let atual: DpsResultado = { idDps: id, processando: true };

  for (let espera = 3_000; Date.now() < limite; espera = Math.min(espera * 1.5, 15_000)) {
    await new Promise(r => setTimeout(r, espera));
    atual = await consultarDps(cfg, id);
    if (!atual.processando) {
      console.log(`[NFS-e DPS] Autorizada ${id} → NFS-e ${atual.numero} chave ${atual.chaveAcesso}`);
      return { ...atual, canal: "el" };
    }
  }
  console.warn(`[NFS-e DPS] ${id} ainda em processamento após ${esperaMs / 1000}s`);
  return { ...atual, canal: "el" };
}

/** Cancelamento (evento e101101) da NFS-e pela chave, no canal que a gerou. */
export async function cancelarNfseDps(
  cfg: EmpresaConfig,
  chaveAcesso: string,
  canal: CanalDps = "el",
  motivo = "Cancelamento solicitado pelo prestador",
  cMotivo: "1" | "2" | "9" = "9",
): Promise<string> {
  const id  = `PRE${chaveAcesso}101101`;
  const xml =
    `<pedRegEvento xmlns="http://www.sped.fazenda.gov.br/nfse" versao="1.01">` +
    `<infPedReg Id="${id}">` +
      `<tpAmb>${cfg.tpAmb === "2" ? "2" : "1"}</tpAmb>` +
      `<verAplic>Avoce-1.0</verAplic>` +
      `<dhEvento>${dhEmiBrt()}</dhEvento>` +
      `<CNPJAutor>${so(cfg.cnpj)}</CNPJAutor>` +
      `<chNFSe>${chaveAcesso}</chNFSe>` +
      `<e101101><xDesc>Cancelamento de NFS-e</xDesc><cMotivo>${cMotivo}</cMotivo>` +
      `<xMotivo>${escXml(motivo.padEnd(15, ".").slice(0, 255))}</xMotivo></e101101>` +
    `</infPedReg>` +
    `</pedRegEvento>`;
  const body = { pedidoRegistroEventoXmlGZipB64: gz64(assinarXml(xml, id, cfg, "infPedReg")) };

  const { status, json } = canal === "sefin"
    ? await chamarMtls(cfg, `${sefinBase(cfg)}/nfse/${chaveAcesso}/eventos`, { method: "POST", body })
    : await chamar(`${apiBase(cfg)}/nfse/${chaveAcesso}/eventos?token=${token(cfg)}`, { method: "POST", body });
  verificar(chaveAcesso, status, json, "Evento");

  console.log(`[NFS-e DPS] Cancelada chave ${chaveAcesso} (${canal})`);
  return json.eventoXmlGZipB64 ? ungz64(json.eventoXmlGZipB64) : "";
}

/** Consulta a NFS-e pela chave de acesso, no canal que a gerou. */
export async function consultarNfseChave(cfg: EmpresaConfig, chaveAcesso: string, canal: CanalDps = "el"): Promise<NfseStatus> {
  const { status, json } = canal === "sefin"
    ? await chamarMtls(cfg, `${sefinBase(cfg)}/nfse/${chaveAcesso}`)
    : await chamar(`${apiBase(cfg)}/nfse/${chaveAcesso}?token=${token(cfg)}`);
  verificar(chaveAcesso, status, json, "Consulta");
  if (!json.nfseXmlGZipB64) throw new Error(`[NFS-e DPS] Consulta sem XML: ${JSON.stringify(json).slice(0, 500)}`);

  const xml = ungz64(json.nfseXmlGZipB64);
  return {
    numero:           tag(xml, "nNFSe"),
    situacao:         tag(xml, "cStat"),
    dataEmissao:      tag(xml, "dhProc").slice(0, 10),
    valor:            tag(xml, "vServ"),
    cancelada:        false,   // cancelamento é evento à parte; não vem no XML da NFS-e
    dataCancelamento: "",
  };
}
