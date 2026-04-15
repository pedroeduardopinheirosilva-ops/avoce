// ─────────────────────────────────────────────────────────────────────────────
// NFS-e Vitória da Conquista / BA — E&L Sistemas (ABRASF 2.04)
// Multi-empresa: cada emitente tem seu próprio certificado e configurações
// WSDL: https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao/NfseWSService
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { resolve }                  from "node:path";
import forge                        from "node-forge";
import { SignedXml }                from "xml-crypto";

export const WSDL = "https://ba-vitoriadaconquista-pm-nfs-backend.cloud.el.com.br/producao/NfseWSService";

export interface EmpresaConfig {
  cnpj:                    string;
  inscricaoMunicipal:      string;
  certPath:                string;
  certPass:                string;
  aliquotaIss:             number;   // ex: 0.05
  itemListaServico:        string;   // ex: "17.14"
  codTributacao:           string;   // ex: "17.14" CodigoTributacaoMunicipio
  codigoServicoNacional?:  string;   // ex: "171401" CodigoServicoNacional (E&L v1.0+)
  codigoNbs?:              string;   // ex: "113019000" CodigoNbs sem máscara
  simplesNacional:         string;   // "1"=Simples, "2"=Não Simples (OptanteSimplesNacional)
  regimeTributacao?:       string;   // "3"=Sociedade Profissionais (RegimeEspecialTributacao 1-9)
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
  numero:      string;
  codigoVerif: string;
  dataEmissao: string;
  linkNfse?:   string;
  xmlRetorno:  string;
}

export interface NfseStatus {
  numero:      string;
  situacao:    string;
  dataEmissao: string;
  valor:       string;
}

// ── Cache de certificados por path ───────────────────────────────────────────

interface CertData { privateKeyPem: string; certBase64: string; }
const _certCache = new Map<string, CertData>();

function getCert(cfg: EmpresaConfig): CertData {
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

  const data = { privateKeyPem, certBase64 };
  _certCache.set(cfg.certPath, data);
  return data;
}

// Invalida o cache de um certificado (após upload de novo cert)
export function invalidarCacheCert(certPath: string) {
  _certCache.delete(certPath);
}

// ── XMLDSig ───────────────────────────────────────────────────────────────────

function assinarXml(xml: string, refId: string, cfg: EmpresaConfig, sigParent?: string): string {
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

// ── SOAP ──────────────────────────────────────────────────────────────────────

const CABECALHO_XML = `<?xml version="1.0" encoding="UTF-8"?><cabecalho versao="2.04" xmlns="http://www.abrasf.org.br/nfse.xsd"><versaoDados>2.04</versaoDados></cabecalho>`;

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

async function chamaSoap(operacao: string, xmlPayload: string): Promise<string> {
  const res = await fetch(WSDL, {
    method:  "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "SOAPAction":   `http://nfse.abrasf.org.br/${operacao}`,
    },
    body: buildSoap(operacao, xmlPayload),
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
  const mensagem = extrairTag(xml, "Mensagem");
  const codigo   = extrairTag(xml, "Codigo");
  if (mensagem && !xml.includes("CompNfse") && !xml.includes("NfseRps")) {
    throw new Error(`[NFS-e] Erro ${codigo}: ${mensagem}`);
  }
}

// ── Sequência RPS por empresa ─────────────────────────────────────────────────

const _rpsSeqs = new Map<string, number>();

function nextRps(empresaId: string): number {
  const cur = _rpsSeqs.get(empresaId) ?? (Math.floor(Date.now() / 1000) % 99000 + 1000);
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

export async function emitirNfse(
  empresaId: string,
  cfg: EmpresaConfig,
  params: {
    valor:            number;
    discriminacao:    string;
    tomador:          TomadorNfse;
    competencia?:     string;
    issRetido?:       boolean;
    itemListaServico?: string;   // sobrescreve cfg se informado
    codigoNbs?:       string;
    retirIr?:         boolean;
    retirCsll?:       boolean;
    retirPis?:        boolean;
    retirCofins?:     boolean;
  }
): Promise<NfseEmitida> {
  if (!cfg.inscricaoMunicipal) throw new Error("[NFS-e] Inscrição Municipal não configurada");

  const rpsNum       = nextRps(empresaId);
  const agora        = new Date();
  // Usar fuso horário de Brasília (UTC-3) para evitar E15 quando servidor está em UTC
  const agoraBrt     = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  const dataEmissao  = agoraBrt.toISOString().slice(0, 10);
  const competencia  = (params.competencia ?? agoraBrt.toISOString().slice(0, 7)) + "-01";
  const valorStr     = (params.valor / 100).toFixed(2);
  const aliquota     = cfg.aliquotaIss;
  const valorIss     = ((params.valor / 100) * aliquota).toFixed(2);
  const issRetido    = params.issRetido ? "1" : "2";
  const refId        = `Rps${rpsNum}`;
  const itemLS       = params.itemListaServico || cfg.itemListaServico;

  const baseRetencao = params.valor / 100;
  const valorIr     = (params.retirIr     ? baseRetencao * ALIQ_IR     : 0).toFixed(2);
  const valorCsll   = (params.retirCsll   ? baseRetencao * ALIQ_CSLL   : 0).toFixed(2);
  const valorPis    = (params.retirPis    ? baseRetencao * ALIQ_PIS    : 0).toFixed(2);
  const valorCofins = (params.retirCofins ? baseRetencao * ALIQ_COFINS : 0).toFixed(2);

  const cpfCnpjTomador = params.tomador.cpfCnpj.replace(/\D/g, "");
  const isCnpj         = cpfCnpjTomador.length === 14;
  const tagCpfCnpj     = isCnpj
    ? `<Cnpj>${cpfCnpjTomador}</Cnpj>`
    : `<Cpf>${cpfCnpjTomador}</Cpf>`;

  const cnpjLimpo = cfg.cnpj.replace(/\D/g, "");

  const rpsXml = `<?xml version="1.0" encoding="UTF-8"?>
<GerarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Rps>
    <InfDeclaracaoPrestacaoServico Id="${refId}">
      <Rps>
        <IdentificacaoRps>
          <Numero>${rpsNum}</Numero>
          <Serie>A</Serie>
          <Tipo>1</Tipo>
        </IdentificacaoRps>
        <DataEmissao>${dataEmissao}</DataEmissao>
        <Status>1</Status>
      </Rps>
      <Competencia>${competencia}</Competencia>
      <Servico>
        <Valores>
          <ValorServicos>${valorStr}</ValorServicos>
          <ValorDeducoes>0.00</ValorDeducoes>
          <ValorPis>${valorPis}</ValorPis>
          <ValorCofins>${valorCofins}</ValorCofins>
          <ValorInss>0.00</ValorInss>
          <ValorIr>${valorIr}</ValorIr>
          <ValorCsll>${valorCsll}</ValorCsll>
          <OutrasRetencoes>0.00</OutrasRetencoes>
          <ValorIss>${valorIss}</ValorIss>
          <Aliquota>${aliquota.toFixed(4)}</Aliquota>
          <DescontoIncondicionado>0.00</DescontoIncondicionado>
          <DescontoCondicionado>0.00</DescontoCondicionado>
        </Valores>
        <IssRetido>${issRetido}</IssRetido>
        <ItemListaServico>${itemLS}</ItemListaServico>
        ${cfg.codTributacao ? `<CodigoTributacaoMunicipio>${cfg.codTributacao}</CodigoTributacaoMunicipio>` : ""}
        ${cfg.codigoServicoNacional ? `<CodigoServicoNacional>${cfg.codigoServicoNacional.replace(/\D/g, "")}</CodigoServicoNacional>` : ""}
        ${(params.codigoNbs ?? cfg.codigoNbs) ? `<CodigoNbs>${(params.codigoNbs ?? cfg.codigoNbs)!.replace(/\D/g, "")}</CodigoNbs>` : ""}
        <Discriminacao>${params.discriminacao.slice(0, 2000)}</Discriminacao>
        <CodigoMunicipio>2933307</CodigoMunicipio>
        <ExigibilidadeISS>1</ExigibilidadeISS>
        <MunicipioIncidencia>2933307</MunicipioIncidencia>
      </Servico>
      <Prestador>
        <CpfCnpj><Cnpj>${cnpjLimpo}</Cnpj></CpfCnpj>
        <InscricaoMunicipal>${cfg.inscricaoMunicipal}</InscricaoMunicipal>
      </Prestador>
      <TomadorServico>
        <IdentificacaoTomador>
          <CpfCnpj>${tagCpfCnpj}</CpfCnpj>
          ${params.tomador.inscMunicipal ? `<InscricaoMunicipal>${params.tomador.inscMunicipal}</InscricaoMunicipal>` : ""}
        </IdentificacaoTomador>
        <RazaoSocial>${params.tomador.nome}</RazaoSocial>
        <Endereco>
          <Endereco>${params.tomador.endereco}</Endereco>
          <Numero>${params.tomador.numero ?? "S/N"}</Numero>
          <Bairro>${params.tomador.bairro}</Bairro>
          <CodigoMunicipio>${params.tomador.codigoMunicipio}</CodigoMunicipio>
          <Uf>${params.tomador.uf}</Uf>
          <Cep>${params.tomador.cep.replace(/\D/g, "")}</Cep>
        </Endereco>
        ${params.tomador.email ? `<Contato><Email>${params.tomador.email}</Email></Contato>` : ""}
      </TomadorServico>
      ${cfg.regimeTributacao ? `<RegimeEspecialTributacao>${cfg.regimeTributacao}</RegimeEspecialTributacao>` : ""}
      <OptanteSimplesNacional>${cfg.simplesNacional === "1" ? "1" : "2"}</OptanteSimplesNacional>
      <IncentivoFiscal>2</IncentivoFiscal>
    </InfDeclaracaoPrestacaoServico>
  </Rps>
</GerarNfseEnvio>`;

  const signedXml  = assinarXml(rpsXml, refId, cfg);
  const soapResp   = await chamaSoap("GerarNfse", signedXml);
  const retornoXml = extrairRetorno(soapResp);
  verificaErro(retornoXml);

  const numero      = extrairTag(retornoXml, "Numero");
  const codigoVerif = extrairTag(retornoXml, "CodigoVerificacao");
  const dataEmit    = extrairTag(retornoXml, "DataEmissaoNfse") || dataEmissao;
  const linkNfse    = extrairTag(retornoXml, "LinkNfse") || undefined;

  console.log(`[NFS-e] Emitida nº ${numero} empresa=${empresaId}`);
  return { numero, codigoVerif, dataEmissao: dataEmit, linkNfse, xmlRetorno: retornoXml };
}

// ── Cancelar NFS-e ────────────────────────────────────────────────────────────

export async function cancelarNfse(cfg: EmpresaConfig, numeroNfse: string): Promise<void> {
  const refId     = `Can${numeroNfse}`;
  const cnpjLimpo = cfg.cnpj.replace(/\D/g, "");

  const cancelXml = `<?xml version="1.0" encoding="UTF-8"?>
<CancelarNfseEnvio xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Pedido>
    <InfPedidoCancelamento Id="${refId}">
      <IdentificacaoNfse>
        <Numero>${numeroNfse}</Numero>
        <CpfCnpj><Cnpj>${cnpjLimpo}</Cnpj></CpfCnpj>
        <InscricaoMunicipal>${cfg.inscricaoMunicipal}</InscricaoMunicipal>
        <CodigoMunicipio>2933307</CodigoMunicipio>
      </IdentificacaoNfse>
      <CodigoCancelamento>1</CodigoCancelamento>
    </InfPedidoCancelamento>
  </Pedido>
</CancelarNfseEnvio>`;

  const signedXml = assinarXml(cancelXml, refId, cfg, "InfPedidoCancelamento");
  const soapResp  = await chamaSoap("CancelarNfse", signedXml);
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
</ConsultarNfseServicoPrestadoEnvio>`;

  const soapResp = await chamaSoap("ConsultarNfseServicoPrestado", consultaXml);
  const retorno  = extrairRetorno(soapResp) || soapResp;

  return {
    numero:      extrairTag(retorno, "Numero")           || numeroNfse,
    situacao:    extrairTag(retorno, "NaturezaOperacao") || "1",
    dataEmissao: extrairTag(retorno, "DataEmissaoNfse")  || "",
    valor:       extrairTag(retorno, "ValorServicos")    || "0",
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
