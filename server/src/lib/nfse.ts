// ─────────────────────────────────────────────────────────────────────────────
// NFS-e multi-provider
//   "el_vdc"    → E&L Sistemas, Vitória da Conquista/BA  (ABRASF 2.04, CDATA)
//   "issnet_df" → ISSNet/Nota Control, Brasília/DF        (ABRASF 2.04, XML-escaped)
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { resolve }                  from "node:path";
import { request as httpsRequest }  from "node:https";
import forge                        from "node-forge";
import { SignedXml }                from "xml-crypto";
import { emitirDps, proximoNDps, cancelarNfseDps, canalEmissao, canalDaNota, semConvenioNacional } from "./nfse-dps.js";

// Legacy export kept for any direct imports
export const WSDL = "https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao/NfseWSService";

const PROVIDER_URL: Record<string, { prod: string; hom: string }> = {
  el_vdc:    { prod: "https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao/NfseWSService", hom: "https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao/NfseWSService" },
  issnet_df: { prod: "https://df.issnetonline.com.br/webservicenfse204/nfse.asmx", hom: "https://www.issnetonline.com.br/apresentacao/df/webservicenfse204/nfse.asmx" },
};

const PROVIDER_SERIE: Record<string, string> = {
  el_vdc:    "A",
  issnet_df: "3",
};

const PROVIDER_MUNICIPIO: Record<string, string> = {
  el_vdc:    "2933307",  // Vitória da Conquista/BA
  issnet_df: "5300108",  // Brasília/DF
};

export interface EmpresaConfig {
  cnpj:                    string;
  inscricaoMunicipal:      string;
  certPath:                string;
  certPass:                string;
  aliquotaIss:             number;   // ex: 0.05
  itemListaServico:        string;   // ex: "17.14"
  codTributacao:           string;   // ABRASF: CodigoTributacaoMunicipio / SPED: cTribMun ex: "701900"
  codigoServicoNacional?:  string;   // ex: "171401" CodigoServicoNacional (E&L v1.0+)
  codigoNbs?:              string;   // ex: "113019000" CodigoNbs sem máscara
  simplesNacional:         string;   // "1"=Simples, "2"=Não Simples
  regimeTributacao?:       string;   // ABRASF: RegimeEspecialTributacao / SPED: regEspTrib
  nfseProvider?:           "el_vdc" | "issnet_df" | "sefin_nacional";
  codigoMunicipioEmitente?: string;  // from EmpresaEmitente.codigoMunicipio
  codigoCnae?:             string;   // CNAE
  tpAmb?:                  "1" | "2"; // SPED: 1=producao (default), 2=homologacao
  pTotTribSN?:             string;   // SPED: Simples Nacional total tax %, ex: "11.60"
  regApTribSN?:            string;   // SPED: regime apuração Simples: "1" (default)
  nfseToken?:              string;   // E&L DPS: token de integração (portal → Configurações → Integração)
}

function providerUrl(cfg: EmpresaConfig): string {
  const urls = PROVIDER_URL[cfg.nfseProvider ?? "el_vdc"] ?? PROVIDER_URL.el_vdc;
  if (cfg.nfseProvider === "issnet_df") {
    return cfg.tpAmb === "2" ? urls.hom : urls.prod;
  }
  return urls.prod;
}

function providerSerie(cfg: EmpresaConfig): string {
  return PROVIDER_SERIE[cfg.nfseProvider ?? "el_vdc"] ?? "A";
}

export function providerMunicipio(cfg: EmpresaConfig): string {
  if (cfg.codigoMunicipioEmitente) return cfg.codigoMunicipioEmitente;
  return PROVIDER_MUNICIPIO[cfg.nfseProvider ?? "el_vdc"] ?? "2933307";
}

export interface TomadorNfse {
  nome:            string;
  cpfCnpj:         string;
  inscMunicipal?:  string;
  endereco:        string;
  numero?:         string;
  bairro:          string;
  cidade:          string;
  codigoMunicipio: string;
  uf:              string;
  cep:             string;
  email?:          string;
}

export interface NfseEmitida {
  numero:       string;
  codigoVerif:  string;
  dataEmissao:  string;
  linkNfse?:    string;
  xmlRetorno:   string;
  nDps?:        number;   // E&L DPS
  idDps?:       string;
  chaveAcesso?: string;
  pendente?:    boolean;  // DPS recebida e ainda em processamento no Ambiente Nacional
}

export interface NfseStatus {
  numero:           string;
  situacao:         string;
  dataEmissao:      string;
  valor:            string;
  cancelada:        boolean;
  dataCancelamento: string;
}

// ── Cache de certificados por path ───────────────────────────────────────────

interface CertData { privateKeyPem: string; certBase64: string; certPem: string; }
const _certCache = new Map<string, CertData>();

export function getCert(cfg: EmpresaConfig): CertData {
  const cached = _certCache.get(cfg.certPath);
  if (cached) return cached;

  const fullPath = resolve(cfg.certPath);
  if (!existsSync(fullPath)) throw new Error(`[NFS-e] Certificado não encontrado: ${fullPath}`);

  const p12Der  = readFileSync(fullPath, "binary");
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, cfg.certPass);

  const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
  const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0];
  if (!keyBag?.key) throw new Error("[NFS-e] Chave privada não encontrada no PFX");
  const privateKeyPem = forge.pki.privateKeyToPem(keyBag.key);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag  = certBags[forge.pki.oids.certBag]?.[0];
  if (!certBag?.cert) throw new Error("[NFS-e] Certificado não encontrado no PFX");
  const certPem    = forge.pki.certificateToPem(certBag.cert);
  const certBase64 = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\r?\n/g, "");

  const data = { privateKeyPem, certBase64, certPem };
  _certCache.set(cfg.certPath, data);
  return data;
}

// Invalida o cache de um certificado (após upload de novo cert)
export function invalidarCacheCert(certPath: string) {
  _certCache.delete(certPath);
}

// ── XMLDSig ───────────────────────────────────────────────────────────────────

export function assinarXml(xml: string, refId: string, cfg: EmpresaConfig, sigParent?: string): string {
  const { privateKeyPem, certBase64 } = getCert(cfg);

  const sig = new SignedXml({
    privateKey: privateKeyPem,
    getKeyInfoContent: () =>
      `<X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data>`,
  });

  sig.canonicalizationAlgorithm = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";
  sig.signatureAlgorithm        = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";

  sig.addReference({
    xpath:           `//*[@Id='${refId}']`,
    digestAlgorithm: "http://www.w3.org/2000/09/xmldsig#sha1",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/TR/2001/REC-xml-c14n-20010315",
    ],
  });

  const parentElement = sigParent ?? "InfDeclaracaoPrestacaoServico";

  sig.computeSignature(xml, {
    location: {
      reference: `//*[local-name(.)='${parentElement}']/..`,
      action:    "append",
    },
  });

  return sig.getSignedXml();
}

// ── XMLDSig via forge — para DF (ABRASF 2.04, RSA-SHA1, C14N) ────────────────
// xml-crypto tem incompatibilidade de XPath com o namespace do DF; forge é
// o mesmo approach usado no testDf16 que emitiu com sucesso.

function assinarXmlDf(xmlStr: string, refId: string, cfg: EmpresaConfig): string {
  const { privateKeyPem, certBase64 } = getCert(cfg);
  const privKey = forge.pki.privateKeyFromPem(privateKeyPem);

  const dsNS = 'xmlns="http://www.w3.org/2000/09/xmldsig#"';

  // Extrai InfDeclaracaoPrestacaoServico para calcular o digest
  const infOpen  = `<InfDeclaracaoPrestacaoServico Id="${refId}">`;
  const infClose = `</InfDeclaracaoPrestacaoServico>`;
  const infStart = xmlStr.indexOf(infOpen);
  const infEnd   = xmlStr.indexOf(infClose) + infClose.length;
  const infElem  = xmlStr.slice(infStart, infEnd);

  // C14N: propaga namespace do elemento pai (GerarNfseEnvio)
  const c14nInf = infElem.replace(
    infOpen,
    `<InfDeclaracaoPrestacaoServico Id="${refId}" xmlns="http://www.abrasf.org.br/nfse.xsd">`,
  );

  const md = forge.md.sha1.create();
  md.update(c14nInf, "utf8");
  const digestB64 = forge.util.encode64(md.digest().bytes());

  const signedInfo =
    `<SignedInfo ${dsNS}>` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
    `<Reference URI="#${refId}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const md2 = forge.md.sha1.create();
  md2.update(signedInfo, "utf8");
  const sigB64 = forge.util.encode64(privKey.sign(md2));

  const sigElement =
    `<Signature ${dsNS}>` +
    signedInfo +
    `<SignatureValue>${sigB64}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  // Insere Signature dentro de <Rps> após </InfDeclaracaoPrestacaoServico>
  return xmlStr.replace(`${infClose}</Rps></GerarNfseEnvio>`, `${infClose}${sigElement}</Rps></GerarNfseEnvio>`);
}

// ── SOAP ──────────────────────────────────────────────────────────────────────

const CABECALHO_XML = `<?xml version="1.0" encoding="UTF-8"?><cabecalho versao="2.04" xmlns="http://www.abrasf.org.br/nfse.xsd"><versaoDados>2.04</versaoDados></cabecalho>`;
const CABECALHO_DF  = `<cabecalho versao="1.00" xmlns="http://www.abrasf.org.br/nfse.xsd"><versaoDados>2.04</versaoDados></cabecalho>`;
const DF_NS         = "http://nfse.abrasf.org.br";

export function escXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildSoap(operacao: string, xmlPayload: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:nfse="http://nfse.abrasf.org.br">
  <soapenv:Body>
    <nfse:${operacao}>
      <${operacao}Request>
        <nfseCabecMsg><![CDATA[${CABECALHO_XML}]]></nfseCabecMsg>
        <nfseDadosMsg><![CDATA[${xmlPayload}]]></nfseDadosMsg>
      </${operacao}Request>
    </nfse:${operacao}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

// DF/ISSNet uses XML-escaped (not CDATA), no XML declaration, soap: prefix
function buildSoapDf(operacao: string, xmlPayload: string): string {
  const payload = xmlPayload.replace(/^<\?xml[^?]*\?>\s*/i, "");
  return `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operacao} xmlns="${DF_NS}"><nfseCabecMsg>${escXml(CABECALHO_DF)}</nfseCabecMsg><nfseDadosMsg>${escXml(payload)}</nfseDadosMsg></${operacao}></soap:Body></soap:Envelope>`;
}

async function chamaSoap(operacao: string, xmlPayload: string, url: string, cfg?: EmpresaConfig): Promise<string> {
  // DF/ISSNet: XML-escaped SOAP, SOAPAction with quotes, rejectUnauthorized: false
  if (cfg?.nfseProvider === "issnet_df") {
    const body   = buildSoapDf(operacao, xmlPayload);
    const action = `"${DF_NS}/${operacao}"`;
    return new Promise<string>((resolve, reject) => {
      const parsed = new URL(url);
      const req = httpsRequest({
        hostname: parsed.hostname,
        port:     Number(parsed.port) || 443,
        path:     parsed.pathname,
        method:   "POST",
        headers: {
          "Content-Type":   "text/xml; charset=utf-8",
          "SOAPAction":     action,
          "Content-Length": Buffer.byteLength(body, "utf8"),
        },
        rejectUnauthorized: false,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      req.on("error", reject);
      req.write(body, "utf8");
      req.end();
    });
  }

  // el_vdc (E&L Sistemas): CDATA format, plain fetch
  const body   = buildSoap(operacao, xmlPayload);
  const action = `http://nfse.abrasf.org.br/${operacao}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": action },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`[NFS-e] SOAP ${operacao} HTTP ${res.status}: ${text.slice(0, 500)}`);
  return text;
}

// ── Parse de resposta ─────────────────────────────────────────────────────────

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extrairRetorno(soap: string): string {
  const m = soap.match(/<outputXML>([\s\S]*?)<\/outputXML>/);
  if (m) return decodeHtmlEntities(m[1].trim());
  const c = soap.match(/<\?xml[^>]*>[\s\S]*?(?=<\/xml>|$)/);
  if (c) return c[0];
  return soap;
}

function extrairTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() ?? "";
}

function verificaErro(xml: string): void {
  // Use regex with word boundary to avoid matching <MensagemRetorno> as <Mensagem>
  const m = xml.match(/<Mensagem>([^<]*)<\/Mensagem>/);
  const c = xml.match(/<Codigo>([^<]*)<\/Codigo>/);
  const mensagem = m?.[1]?.trim() ?? "";
  const codigo   = c?.[1]?.trim() ?? "";
  if (mensagem && !xml.includes("CompNfse") && !xml.includes("NfseRps")) {
    throw new Error(`[NFS-e] Erro ${codigo}: ${mensagem}`);
  }
}

// ── Sequência RPS por empresa ─────────────────────────────────────────────────

const _rpsSeqs = new Map<string, number>();

function nextRps(empresaId: string): number {
  const cur = _rpsSeqs.get(empresaId) ?? (300 + (Math.floor(Date.now() / 1000) % 600));
  const next = cur + 1;
  _rpsSeqs.set(empresaId, next);
  return next;
}

// ── Emitir NFS-e ─────────────────────────────────────────────────────────────

// Alíquotas federais padrão (Lei 10.833/2003)
const ALIQ_IR     = 0.015;  // 1,5%
const ALIQ_CSLL   = 0.010;  // 1,0%
const ALIQ_PIS    = 0.0065; // 0,65%
const ALIQ_COFINS = 0.030;  // 3,0%

export type Retencoes = {
  iss: number; ir: number; csll: number; pis: number; cofins: number;
  total: number; liquido: number;
};

/**
 * Retenções e valor líquido de um faturamento, em centavos.
 *
 * Espelha exatamente o cálculo do RPS (reais com 2 casas, arredondado por
 * tributo) para que o líquido bata com o "Valor Líquido" do DANFSE — é esse
 * valor que o tomador efetivamente paga quando há retenção.
 */
export function calcularRetencoes(
  valorCentavos: number,
  opts: {
    aliquotaIss: number;
    issRetido?:  boolean;
    retirIr?:     boolean;
    retirCsll?:   boolean;
    retirPis?:    boolean;
    retirCofins?: boolean;
  },
): Retencoes {
  const base = valorCentavos / 100;
  const ret  = (aplica: boolean | undefined, aliq: number) =>
    aplica ? Math.round(Number((base * aliq).toFixed(2)) * 100) : 0;

  const iss    = ret(opts.issRetido,   opts.aliquotaIss);
  const ir     = ret(opts.retirIr,     ALIQ_IR);
  const csll   = ret(opts.retirCsll,   ALIQ_CSLL);
  const pis    = ret(opts.retirPis,    ALIQ_PIS);
  const cofins = ret(opts.retirCofins, ALIQ_COFINS);
  const total  = iss + ir + csll + pis + cofins;

  return { iss, ir, csll, pis, cofins, total, liquido: valorCentavos - total };
}

export async function emitirNfse(
  empresaId: string,
  cfg: EmpresaConfig,
  params: {
    valor:            number;
    discriminacao:    string;
    tomador:          TomadorNfse;
    competencia?:     string;
    issRetido?:       boolean;
    itemListaServico?: string;
    codigoNbs?:       string;
    retirIr?:         boolean;
    retirCsll?:       boolean;
    retirPis?:        boolean;
    retirCofins?:     boolean;
    nDps?:            number;   // reenvio de uma DPS já numerada (mesmo idDPS)
  }
): Promise<NfseEmitida> {
  if (!cfg.inscricaoMunicipal) throw new Error("[NFS-e] Inscrição Municipal não configurada");

  const nacional = canalEmissao(cfg) === "sefin";
  if (cfg.nfseProvider === "issnet_df" && !nacional) {
    return emitirNfse_DF(empresaId, cfg, params);
  }

  // ── DPS no leiaute nacional: E&L (Vitória da Conquista, cujo ABRASF só aceita
  // consultas desde 01/10/2026 — E999) ou Emissor Nacional (Simples, desde 01/11/2026)
  const nDps = params.nDps ?? await proximoNDps();
  let r: Awaited<ReturnType<typeof emitirDps>>;
  try {
    r = await emitirDps(cfg, { ...params, nDps });
  } catch (err) {
    // Município ainda fora do convênio do Emissor Nacional: segue pelo ISSNet (DF)
    if (cfg.nfseProvider === "issnet_df" && semConvenioNacional(err)) return emitirNfse_DF(empresaId, cfg, params);
    throw err;
  }
  return {
    numero:      r.numero ?? "",
    codigoVerif: r.chaveAcesso ?? "",
    dataEmissao: r.dataEmissao ?? new Date().toISOString().slice(0, 10),
    linkNfse:    r.linkNfse,
    xmlRetorno:  r.xmlNfse ?? "",
    nDps,
    idDps:       r.idDps,
    chaveAcesso: r.chaveAcesso,
    pendente:    r.processando,
  };
}

/** Campos da NotaFiscal após a emissão. DPS ainda em processamento continua PENDENTE
 *  (o cron reconciliarDpsPendentes conclui) — PENDENTE já bloqueia reemissão na competência. */
export function dadosNotaEmitida(r: NfseEmitida) {
  const dps = { nDps: r.nDps, idDps: r.idDps, chaveAcesso: r.chaveAcesso };
  if (r.pendente) return { status: "PENDENTE", ...dps };
  return {
    status:      "EMITIDA",
    numero:      r.numero,
    codigoVerif: r.codigoVerif,
    xmlRetorno:  r.xmlRetorno,
    linkNfse:    r.linkNfse,
    emitidoEm:   new Date(),
    ...dps,
  };
}

// ── Emitir NFS-e ABRASF 2.04 — ISSNet/DF ────────────────────────────────────

async function emitirNfse_DF(
  empresaId: string,
  cfg: EmpresaConfig,
  params: Parameters<typeof emitirNfse>[2]
): Promise<NfseEmitida> {
  const agora       = new Date();
  const agoraBrt    = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const dataEmissao = agoraBrt.toISOString().slice(0, 10);
  const competencia = (params.competencia ?? agoraBrt.toISOString().slice(0, 7)) + "-01";
  const valorStr    = (params.valor / 100).toFixed(2);
  const aliquota    = cfg.aliquotaIss;
  const aliquotaStr = (aliquota * 100).toFixed(2);
  const valorIss    = ((params.valor / 100) * aliquota).toFixed(2);
  const issRetido   = params.issRetido ? "1" : "2";
  const itemLS      = params.itemListaServico || cfg.itemListaServico;
  const municipio   = providerMunicipio(cfg);
  const cnpjLimpo   = cfg.cnpj.replace(/\D/g, "");
  const url         = providerUrl(cfg);

  const cpfCnpjTomador = params.tomador.cpfCnpj.replace(/\D/g, "");
  const isCnpj         = cpfCnpjTomador.length === 14;
  const tagCpfCnpj     = isCnpj
    ? `<Cnpj>${cpfCnpjTomador}</Cnpj>`
    : `<Cpf>${cpfCnpjTomador}</Cpf>`;

  const cnaeTag    = cfg.codigoCnae ? `<CodigoCnae>${cfg.codigoCnae.replace(/\D/g, "")}</CodigoCnae>` : "";
  const codTribTag = cfg.codTributacao ? `<CodigoTributacaoMunicipio>${cfg.codTributacao}</CodigoTributacaoMunicipio>` : "";
  const emailTag   = params.tomador.email ? `<Contato><Email>${params.tomador.email}</Email></Contato>` : "";

  let lastError: Error = new Error("[NFS-e DF] Falha ao emitir após múltiplas tentativas");

  for (let attempt = 0; attempt < 20; attempt++) {
    const rpsNum = nextRps(empresaId);
    const refId  = `rps${rpsNum}`;

    const rpsXml = `<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd"><Rps><InfDeclaracaoPrestacaoServico Id="${refId}"><Rps><IdentificacaoRps><Numero>${rpsNum}</Numero><Serie>3</Serie><Tipo>1</Tipo></IdentificacaoRps><DataEmissao>${dataEmissao}</DataEmissao><Status>1</Status></Rps><Competencia>${competencia}</Competencia><Servico><Valores><ValorServicos>${valorStr}</ValorServicos><ValorIss>${valorIss}</ValorIss><Aliquota>${aliquotaStr}</Aliquota><DescontoIncondicionado>0.00</DescontoIncondicionado></Valores><IssRetido>${issRetido}</IssRetido><ItemListaServico>${itemLS}</ItemListaServico>${cnaeTag}${codTribTag}<Discriminacao>${escXml(params.discriminacao.slice(0, 2000))}</Discriminacao><CodigoMunicipio>${municipio}</CodigoMunicipio><ExigibilidadeISS>1</ExigibilidadeISS><MunicipioIncidencia>${municipio}</MunicipioIncidencia></Servico><Prestador><CpfCnpj><Cnpj>${cnpjLimpo}</Cnpj></CpfCnpj><InscricaoMunicipal>${cfg.inscricaoMunicipal}</InscricaoMunicipal></Prestador><TomadorServico><IdentificacaoTomador><CpfCnpj>${tagCpfCnpj}</CpfCnpj></IdentificacaoTomador><RazaoSocial>${escXml(params.tomador.nome)}</RazaoSocial><Endereco><Endereco>${escXml(params.tomador.endereco)}</Endereco><Numero>${params.tomador.numero ?? "S/N"}</Numero><Bairro>${escXml(params.tomador.bairro)}</Bairro><CodigoMunicipio>${params.tomador.codigoMunicipio}</CodigoMunicipio><Uf>${params.tomador.uf}</Uf><Cep>${params.tomador.cep.replace(/\D/g, "")}</Cep></Endereco>${emailTag}</TomadorServico><OptanteSimplesNacional>${cfg.simplesNacional === "1" ? "1" : "2"}</OptanteSimplesNacional><IncentivoFiscal>2</IncentivoFiscal></InfDeclaracaoPrestacaoServico></Rps></GerarNfseEnvio>`;

    const signedXml = assinarXmlDf(rpsXml, refId, cfg);
    const soapResp  = await chamaSoap("GerarNfse", signedXml, url, cfg);
    const decoded   = decodeHtmlEntities(soapResp);

    if (decoded.includes("E010") || decoded.includes("E090")) {
      const code = decoded.includes("E010") ? "E010" : "E090";
      console.log(`[NFS-e DF] RPS ${rpsNum} ${code}, tentativa ${attempt + 1}/20`);
      lastError = new Error(`[NFS-e] Erro ${code}: RPS ${rpsNum} inválido ou já informado`);
      continue;
    }

    verificaErro(decoded);

    const numero      = extrairTag(decoded, "Numero");
    const codigoVerif = extrairTag(decoded, "CodigoVerificacao");
    const dataEmit    = extrairTag(decoded, "DataEmissaoNfse") || dataEmissao;
    const linkNfse    = extrairTag(decoded, "LinkNfse") || undefined;

    console.log(`[NFS-e DF] Emitida nº ${numero} empresa=${empresaId} rps=${rpsNum}`);
    return { numero, codigoVerif, dataEmissao: dataEmit, linkNfse, xmlRetorno: decoded };
  }

  throw lastError;
}

// ── Cancelar NFS-e ────────────────────────────────────────────────────────────

// DF: forge-based signing de InfPedidoCancelamento (xml-crypto falha no XPath para DF)
function assinarCancelDf(xmlStr: string, refId: string, cfg: EmpresaConfig): string {
  const { privateKeyPem, certBase64 } = getCert(cfg);
  const privKey = forge.pki.privateKeyFromPem(privateKeyPem);

  const dsNS     = 'xmlns="http://www.w3.org/2000/09/xmldsig#"';
  const infOpen  = `<InfPedidoCancelamento Id="${refId}">`;
  const infClose = `</InfPedidoCancelamento>`;
  const infStart = xmlStr.indexOf(infOpen);
  const infEnd   = xmlStr.indexOf(infClose) + infClose.length;
  const infElem  = xmlStr.slice(infStart, infEnd);

  const c14nInf = infElem.replace(
    infOpen,
    `<InfPedidoCancelamento Id="${refId}" xmlns="http://www.abrasf.org.br/nfse.xsd">`,
  );

  const md = forge.md.sha1.create();
  md.update(c14nInf, "utf8");
  const digestB64 = forge.util.encode64(md.digest().bytes());

  const signedInfo =
    `<SignedInfo ${dsNS}>` +
    `<CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/>` +
    `<Reference URI="#${refId}">` +
    `<Transforms>` +
    `<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/>` +
    `<Transform Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>` +
    `</Transforms>` +
    `<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/>` +
    `<DigestValue>${digestB64}</DigestValue>` +
    `</Reference>` +
    `</SignedInfo>`;

  const md2 = forge.md.sha1.create();
  md2.update(signedInfo, "utf8");
  const sigB64 = forge.util.encode64(privKey.sign(md2));

  const sigElement =
    `<Signature ${dsNS}>` +
    signedInfo +
    `<SignatureValue>${sigB64}</SignatureValue>` +
    `<KeyInfo><X509Data><X509Certificate>${certBase64}</X509Certificate></X509Data></KeyInfo>` +
    `</Signature>`;

  return xmlStr.replace(`${infClose}</Pedido>`, `${infClose}${sigElement}</Pedido>`);
}

export async function cancelarNfse(
  cfg: EmpresaConfig, numeroNfse: string, chaveAcesso?: string | null, xmlRetorno?: string | null,
): Promise<void> {
  // NFS-e emitida por DPS: cancela pelo evento nacional, no canal que a gerou
  // (o ABRASF da E&L não cancela mais)
  if (chaveAcesso) {
    await cancelarNfseDps(cfg, chaveAcesso, canalDaNota(xmlRetorno));
    return;
  }

  const refId     = `Can${numeroNfse}`;
  const cnpjLimpo = cfg.cnpj.replace(/\D/g, "");
  const municipio = providerMunicipio(cfg);
  const url       = providerUrl(cfg);

  if (cfg.nfseProvider === "issnet_df") {
    // DF: inline XML sem declaração, forge signing, CodigoCancelamento=2
    // (código 1 "erro na emissão" retorna E206 no ISSNet DF — não permitido via WS)
    const cancelXml = `<CancelarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd"><Pedido><InfPedidoCancelamento Id="${refId}"><IdentificacaoNfse><Numero>${numeroNfse}</Numero><CpfCnpj><Cnpj>${cnpjLimpo}</Cnpj></CpfCnpj><InscricaoMunicipal>${cfg.inscricaoMunicipal}</InscricaoMunicipal><CodigoMunicipio>${municipio}</CodigoMunicipio></IdentificacaoNfse><CodigoCancelamento>2</CodigoCancelamento></InfPedidoCancelamento></Pedido></CancelarNfseEnvio>`;
    const signedXml = assinarCancelDf(cancelXml, refId, cfg);
    const soapResp  = await chamaSoap("CancelarNfse", signedXml, url, cfg);
    const decoded   = decodeHtmlEntities(soapResp);
    verificaErro(decoded);
    console.log(`[NFS-e DF] Cancelada nº ${numeroNfse}`);
    return;
  }

  const cancelXml = `<?xml version="1.0" encoding="UTF-8"?>
<CancelarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Pedido>
    <InfPedidoCancelamento Id="${refId}">
      <IdentificacaoNfse>
        <Numero>${numeroNfse}</Numero>
        <CpfCnpj><Cnpj>${cnpjLimpo}</Cnpj></CpfCnpj>
        <InscricaoMunicipal>${cfg.inscricaoMunicipal}</InscricaoMunicipal>
        <CodigoMunicipio>${municipio}</CodigoMunicipio>
      </IdentificacaoNfse>
      <CodigoCancelamento>1</CodigoCancelamento>
    </InfPedidoCancelamento>
  </Pedido>
</CancelarNfseEnvio>`;

  const signedXml = assinarXml(cancelXml, refId, cfg, "InfPedidoCancelamento");
  const soapResp  = await chamaSoap("CancelarNfse", signedXml, url, cfg);
  const retorno   = extrairRetorno(soapResp) || soapResp;
  verificaErro(retorno);

  console.log(`[NFS-e] Cancelada nº ${numeroNfse}`);
}

// ── Consultar NFS-e ───────────────────────────────────────────────────────────

export async function consultarNfse(cfg: EmpresaConfig, numeroNfse: string): Promise<NfseStatus> {
  const cnpjLimpo = cfg.cnpj.replace(/\D/g, "");

  const consultaXml = `<?xml version="1.0" encoding="UTF-8"?>
<ConsultarNfseServicoPrestadoEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Prestador>
    <CpfCnpj><Cnpj>${cnpjLimpo}</Cnpj></CpfCnpj>
    <InscricaoMunicipal>${cfg.inscricaoMunicipal}</InscricaoMunicipal>
  </Prestador>
  <NumeroNfse>${numeroNfse}</NumeroNfse>
  <Pagina>1</Pagina>
</ConsultarNfseServicoPrestadoEnvio>`;

  const soapResp = await chamaSoap("ConsultarNfseServicoPrestado", consultaXml, providerUrl(cfg), cfg);
  const retorno  = extrairRetorno(soapResp) || soapResp;

  // Log completo para diagnóstico de cancelamentos (remover após calibrar)
  console.log(`[NFS-e Consulta] Nº ${numeroNfse} — XML retorno:\n${retorno.slice(0, 2000)}`);

  // Detecção de cancelamento — E&L ABRASF 2.04 pode usar várias tags
  const dataCancelamento         = extrairTag(retorno, "DataCancelamento") ||
                                   extrairTag(retorno, "DataHoraCancelamento");
  const temBlocoNfseCancelamento = retorno.includes("<NfseCancelamento") ||
                                   retorno.includes("<Cancelamento");
  const temErroNaoEncontrada     = retorno.includes("E10") ||          // E&L: nota não encontrada
                                   retorno.includes("E4") ||            // E&L: nota cancelada
                                   retorno.toLowerCase().includes("não encontrada") ||
                                   retorno.toLowerCase().includes("cancelad");

  const cancelada = !!(dataCancelamento || temBlocoNfseCancelamento || temErroNaoEncontrada);

  console.log(`[NFS-e Consulta] Nº ${numeroNfse} — cancelada=${cancelada} dataCancelamento="${dataCancelamento}" temBloco=${temBlocoNfseCancelamento} temErro=${temErroNaoEncontrada}`);

  return {
    numero:           extrairTag(retorno, "Numero")           || numeroNfse,
    situacao:         extrairTag(retorno, "NaturezaOperacao") || "1",
    dataEmissao:      extrairTag(retorno, "DataEmissaoNfse")  || "",
    valor:            extrairTag(retorno, "ValorServicos")    || "0",
    cancelada,
    dataCancelamento: dataCancelamento || "",
  };
}

// ── Extrair metadados do certificado via forge ────────────────────────────────

export interface CertMeta { nome: string; validade: Date; }

export function extrairMetaCert(p12Buffer: Buffer, senha: string): CertMeta {
  const p12Der  = p12Buffer.toString("binary");
  const p12Asn1 = forge.asn1.fromDer(p12Der);
  const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, senha);

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certBag  = certBags[forge.pki.oids.certBag]?.[0];
  if (!certBag?.cert) throw new Error("Certificado não encontrado no PFX");

  const cn = certBag.cert.subject.getField("CN")?.value ?? "Certificado";
  const validade = certBag.cert.validity.notAfter;
  return { nome: String(cn), validade };
}
