// ─────────────────────────────────────────────────────────────────────────────
// Envio de e-mail de cobrança (Nota de Honorários + Boleto em PDF)
// Chamado após gerar cobrança (PIX / Boleto) no router ou no cron
// ─────────────────────────────────────────────────────────────────────────────

import nodemailer                       from "nodemailer";
import { existsSync, readFileSync }    from "node:fs";
import { join }                        from "node:path";
import QRCode                          from "qrcode";
import { prisma }                      from "../db.js";
import { renderTemplate }              from "./template.js";
import { gerarCartaCobrancaHtml }      from "./cobranca-html.js";
import { gerarBoletoHtml }             from "./boleto-html.js";
import { htmlToPdf }                   from "./pdf.js";
import { LOGOS_DIR, certPathForEmpresa } from "../upload.js";
import type { SmtpConfig }             from "./email.js";
import { sendMailAndSave }             from "./email.js";
import { fieldDecrypt }                from "./field-crypto.js";
import { obterDanfsePdf }              from "./danfse.js";
import type { EmpresaConfig }          from "./nfse.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtValor(c: number) {
  return (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fmtData(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function loadLogoBase64(logoPath: string | null | undefined): string | undefined {
  if (!logoPath || !existsSync(logoPath)) return undefined;
  try {
    const buf  = readFileSync(logoPath);
    const ext  = logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
    const mime = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch { return undefined; }
}
function loadSicoobLogo(): string | undefined {
  try {
    const svg = join(LOGOS_DIR, "sicoob.svg");
    if (existsSync(svg)) return `data:image/svg+xml;base64,${readFileSync(svg).toString("base64")}`;
    const png = join(LOGOS_DIR, "sicoob.png");
    if (existsSync(png)) return `data:image/png;base64,${readFileSync(png).toString("base64")}`;
  } catch { /* ignora */ }
  return undefined;
}
function loadBrasaoVdc(): string | undefined {
  try {
    const p = join(LOGOS_DIR, "brasao-vdc.gif");
    if (existsSync(p)) return `data:image/gif;base64,${readFileSync(p).toString("base64")}`;
  } catch { /* ignora */ }
  return undefined;
}

// ── URL de autenticidade NFS-e (E&L / VDC-BA) ────────────────────────────────

function urlAutenticidadeNfse(cnpj: string, codigoVerif: string): string {
  return `https://ba-vitoriadaconquista-pm-nfs.cloud.el.com.br/#/autenticacao?cpfCnpj=${cnpj}&chave=${codigoVerif}&tipo=N`;
}

// ── HTML da NFS-e no padrão oficial VDC/BA para conversão em PDF ──────────────

function gerarNfseHtml(p: {
  numero:               string;
  emitidoEm?:          Date | null;
  codigoVerif?:         string | null;
  urlAuth?:             string;
  brasaoBase64?:        string;
  qrcodeBase64?:        string;
  xmlRetorno?:          string | null;
  emitente: {
    nome: string; nomeFantasia?: string | null; cnpj: string;
    inscricaoMunicipal?: string | null;
    endereco?: string | null; numero?: string | null; bairro?: string | null;
    cidade?: string | null; uf?: string | null; cep?: string | null;
    telefone?: string | null; email?: string | null;
  };
  tomador: {
    nome: string; cpfCnpj: string;
    endereco?: string | null; cidade?: string | null; uf?: string | null; email?: string | null;
  };
  competencia:   string;
  valor:         number;
  discriminacao: string;
}): string {

  // ── helpers XML ──
  const xt = (tag: string): string => {
    const m = (p.xmlRetorno ?? "").match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return m?.[1]?.trim() ?? "";
  };
  const fmtNum = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 2 });
  const fmtXml = (s: string) => {
    const n = parseFloat(s || "0");
    return fmtNum(isNaN(n) ? 0 : n);
  };

  // ── dados da emissão ──
  const dtEmissao = p.emitidoEm
    ? p.emitidoEm.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" })
      + " " + p.emitidoEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";

  // ── competência → data fato gerador ──
  const competenciaXml = xt("Competencia"); // "2026-04-01"
  const dataFatoGerador = competenciaXml
    ? competenciaXml.split("-").reverse().join("/")
    : (() => {
        const [mm, yy] = (p.competencia ?? "").split("/");
        return mm && yy ? `01/${mm}/${yy}` : "—";
      })();

  // ── RPS number ──
  const rpsMatch = (p.xmlRetorno ?? "").match(/<IdentificacaoRps>[\s\S]*?<Numero>([\s\S]*?)<\/Numero>/);
  const numeroRps = rpsMatch?.[1]?.trim() ?? "—";

  // ── regime tributário ──
  const regimeMap: Record<string, string> = {
    "1": "Microempresa Municipal", "2": "Estimativa", "3": "Sociedade de Profissionais",
    "4": "Cooperativa", "5": "MEI", "6": "ME EPP - Simples Nacional",
  };
  const regimeTributario = regimeMap[xt("RegimeEspecialTributacao")] ?? "Tributação Normal";

  // ── recolhimento / simples ──
  const issRetidoCode  = xt("IssRetido");
  const tipoRecolhimento = issRetidoCode === "1" ? "Retido" : "Não Retido";
  const optanteSNCode    = xt("OptanteSimplesNacional");
  const optanteSN        = optanteSNCode === "1" ? "Optante" : "Não Optante";

  // ── valores (XML em reais; p.valor em centavos) ──
  const valorServXml = parseFloat(xt("ValorServicos") || "0");
  const valorServ    = valorServXml > 0 ? fmtNum(valorServXml) : fmtNum(p.valor / 100);
  const valDeducoes  = fmtXml(xt("ValorDeducoes"));
  const valIssXml    = parseFloat(xt("ValorIss") || "0");
  const valIss       = fmtNum(valIssXml);
  const aliquotaF    = parseFloat(xt("Aliquota") || "0");
  const aliquotaFmt  = aliquotaF > 0 ? aliquotaF.toString() : "—";
  const valInss      = fmtXml(xt("ValorInss"));
  const valIr        = fmtXml(xt("ValorIr"));
  const valCsll      = fmtXml(xt("ValorCsll"));
  const valPis       = fmtXml(xt("ValorPis"));
  const valCofins    = fmtXml(xt("ValorCofins"));

  // valor líquido = valor - INSS - IR - CSLL - PIS - COFINS - ISS(retido)
  const issRetidoNum = issRetidoCode === "1" ? valIssXml : 0;
  const liqNum = (valorServXml > 0 ? valorServXml : p.valor / 100)
    - parseFloat(xt("ValorInss") || "0")
    - parseFloat(xt("ValorIr")   || "0")
    - parseFloat(xt("ValorCsll") || "0")
    - parseFloat(xt("ValorPis")  || "0")
    - parseFloat(xt("ValorCofins") || "0")
    - issRetidoNum;
  const valorLiquido = fmtNum(liqNum);

  // ── serviços ──
  const codigoSN     = xt("CodigoServicoNacional");
  const codigoNbsRaw = xt("CodigoNbs");
  const codigoNbs    = codigoNbsRaw
    ? codigoNbsRaw.replace(/\D/g, "").replace(/^(\d)(\d{4})(\d{2})(\d{2})$/, "$1.$2.$3.$4")
    : "";
  const itemLS       = xt("ItemListaServico");
  const discriminacaoFinal = xt("Discriminacao") || p.discriminacao;

  // ── chave de acesso / outras informações ──
  const chaveAcesso = xt("ChaveNfse") || xt("CodigoAcessoNfse") || "";
  const textoSN = optanteSNCode === "1"
    ? `ESTE DOCUMENTO FOI EMITIDO POR EMPRESA OPTANTE DO SIMPLES NACIONAL (Art. 23 da LC 123/2006), DEVENDO NESTA CONDIÇÃO O PRESTADOR INFORMAR A ALÍQUOTA ENTRE 2 A 5%, CONFORME TABELA DE ENQUADRAMENTO DE ACORDO COM O SEU FATURAMENTO. O RECOLHIMENTO DO ISSQN É REALIZADO VIA DAS EMITIDO PELA RECEITA FEDERAL DO BRASIL.`
    : "";

  // ── endereços ──
  const endPrestador = [
    p.emitente.endereco,
    p.emitente.numero,
    p.emitente.bairro,
    [p.emitente.cidade, p.emitente.uf].filter(Boolean).join(" - "),
    p.emitente.cep ? `CEP: ${p.emitente.cep}` : null,
  ].filter(Boolean).join(", ");

  const endTomador = [
    p.tomador.endereco,
    [p.tomador.cidade, p.tomador.uf].filter(Boolean).join(" - "),
  ].filter(Boolean).join(", ");

  // ── brasão e QR code ──
  const brasaoHtml = p.brasaoBase64
    ? `<img src="${p.brasaoBase64}" style="width:76px;height:auto;max-height:76px;" alt="Brasão">`
    : `<div style="width:76px;height:76px;border:1px solid #ccc;display:inline-flex;align-items:center;justify-content:center;font-size:6pt;color:#999;text-align:center;">BRASÃO<br>MUNICIPAL</div>`;
  const qrHtml = p.qrcodeBase64
    ? `<img src="${p.qrcodeBase64}" style="width:78px;height:78px;" alt="QR Code">`
    : `<div style="width:78px;height:78px;border:1px solid #ccc;display:inline-flex;align-items:center;justify-content:center;font-size:6pt;color:#999;text-align:center;">QR<br>CODE</div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8">
<style>
  *  { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:Arial,Helvetica,sans-serif; font-size:9pt; color:#000; background:#fff; padding:6mm 8mm; }
  .doc { border:2px solid #000; }
  /* tabelas internas */
  .tbl { width:100%; border-collapse:collapse; table-layout:fixed; }
  .tbl td, .tbl th { border:1px solid #999; padding:2px 4px; vertical-align:top; }
  /* label + valor dentro de célula */
  .lbl { display:block; font-size:6.5pt; color:#555; margin-bottom:1px; }
  .val { display:block; font-size:8.5pt; }
  .val-bold  { display:block; font-size:8.5pt; font-weight:bold; }
  .val-large { display:block; font-size:9.5pt; font-weight:bold; }
  /* cabeçalho de seção */
  .sec { background:#c8c8c8; color:#000; font-weight:bold; font-size:9pt;
         text-align:center; padding:2px 4px; border:1px solid #000;
         border-top:0; text-transform:uppercase; letter-spacing:.4px; }
  /* bloco de conteúdo abaixo de .sec */
  .cnt { padding:4px 8px; font-size:8.5pt; line-height:1.55;
         border:1px solid #000; border-top:0; }
  .cnt div { margin-bottom:1px; }
  /* áreas de texto livre */
  .disc { padding:6px 8px; font-size:8.5pt; min-height:58px;
          white-space:pre-wrap; word-break:break-word;
          border:1px solid #000; border-top:0; }
  .obs  { padding:6px 8px; min-height:38px; border:1px solid #000; border-top:0; }
  /* cabeçalhos de tabela de valores */
  .vh  { font-size:7pt; font-weight:bold; text-align:center;
         background:#f0f0f0; padding:2px 3px; border:1px solid #999; }
  .vhd { font-size:7pt; font-weight:bold; text-align:left;
          background:#f0f0f0; padding:2px 3px; border:1px solid #999; }
  .vhl { font-size:7pt; font-weight:bold; text-align:center;
          background:#d0d0d0; padding:2px 3px; border:1px solid #999; }
  .vv  { font-size:8.5pt; text-align:center; padding:3px; border:1px solid #999; }
  .vvb { font-size:9.5pt; font-weight:bold; text-align:center; padding:3px; border:1px solid #999; }
  /* outras informações */
  .outras { padding:4px 8px; font-size:7.5pt; line-height:1.5;
            border:1px solid #000; border-top:0; }
  /* rodapé */
  .footer { padding:3px 8px; font-size:7.5pt; text-align:center; color:#333;
            border:1px solid #000; border-top:0; }
</style>
</head>
<body>
<div class="doc">

<!-- ═══════ CABEÇALHO ═══════ -->
<table class="tbl" style="border:1px solid #000;">
  <colgroup><col style="width:96px"><col><col style="width:108px"></colgroup>
  <tr style="vertical-align:middle;">
    <td style="border:0;border-right:1px solid #999;padding:8px;text-align:center;">
      ${brasaoHtml}
    </td>
    <td style="border:0;text-align:center;padding:8px 10px;">
      <div style="font-size:13pt;font-weight:bold;letter-spacing:.3px;">NOTA FISCAL DE SERVIÇOS ELETRÔNICA - NFSe</div>
      <div style="font-size:11pt;font-weight:bold;margin-top:2px;">MUNICIPIO DE VITORIA DA CONQUISTA</div>
      ${p.codigoVerif ? `<div style="font-size:9pt;margin-top:4px;">Codigo de Verificação para Autenticação: <strong>${p.codigoVerif}</strong></div>` : ""}
      <div style="font-size:7.5pt;margin-top:5px;color:#333;">Endereço: Vitória da Conquista, Bahia, BA, 45000-600</div>
      <div style="font-size:7.5pt;color:#333;">CNPJ: 14.239.578/0001-00, E-mail: gerpat.semgi@pmvc.ba.gov.br</div>
    </td>
    <td style="border:0;border-left:1px solid #999;padding:8px;text-align:center;">
      ${qrHtml}
      <div style="font-size:6.5pt;margin-top:4px;color:#333;">Emitido em ${dtEmissao}</div>
    </td>
  </tr>
</table>

<!-- ═══════ LINHA ADMINISTRATIVA 1 ═══════ -->
<table class="tbl" style="border:1px solid #000;border-top:0;border-bottom:0;">
  <colgroup>
    <col style="width:14%"><col style="width:21%"><col style="width:20%">
    <col style="width:14%"><col style="width:7%"><col style="width:24%">
  </colgroup>
  <tr>
    <td><span class="lbl">Data Fato Gerador</span><span class="val">${dataFatoGerador}</span></td>
    <td><span class="lbl">Exigibilidade de ISS</span><span class="val">Exigível</span></td>
    <td><span class="lbl">Regime Tributário</span><span class="val">${regimeTributario}</span></td>
    <td><span class="lbl">Número RPS</span><span class="val">${numeroRps}</span></td>
    <td style="text-align:center;"><span class="lbl">Serie RPS</span><span class="val">A</span></td>
    <td style="text-align:right;"><span class="lbl">N° da Nota Fiscal</span><span class="val-large">${p.numero}</span></td>
  </tr>
</table>

<!-- ═══════ LINHA ADMINISTRATIVA 2 ═══════ -->
<table class="tbl" style="border:1px solid #000;border-top:0;">
  <colgroup>
    <col style="width:15%"><col style="width:8%">
    <col style="width:38.5%"><col style="width:38.5%">
  </colgroup>
  <tr>
    <td><span class="lbl">Tipo de Recolhimento</span><span class="val">${tipoRecolhimento}</span></td>
    <td><span class="lbl">Simples</span><span class="val">${optanteSN}</span></td>
    <td><span class="lbl">Local de Prestação</span><span class="val">2933307 - Vitória da Conquista - BA</span></td>
    <td><span class="lbl">Local de Recolhimento</span><span class="val">2933307 - Vitória da Conquista - BA</span></td>
  </tr>
</table>

<!-- ═══════ PRESTADOR ═══════ -->
<div class="sec">PRESTADOR</div>
<div class="cnt">
  <div><strong>Razão Social:</strong> ${p.emitente.nome}</div>
  ${p.emitente.nomeFantasia && p.emitente.nomeFantasia !== p.emitente.nome
    ? `<div><strong>Nome Fantasia:</strong> ${p.emitente.nomeFantasia}</div>` : ""}
  ${endPrestador ? `<div><strong>Endereço:</strong> ${endPrestador}</div>` : ""}
  <div>
    ${p.emitente.email    ? `<strong>E-mail:</strong> ${p.emitente.email}` : ""}
    ${p.emitente.telefone ? ` &nbsp;-&nbsp; <strong>Fone:</strong> ${p.emitente.telefone}` : ""}
  </div>
  <div>
    <strong>Inscrição Municipal:</strong> ${p.emitente.inscricaoMunicipal || "—"}
    &nbsp;-&nbsp; <strong>CPF/CNPJ:</strong> ${p.emitente.cnpj}
  </div>
</div>

<!-- ═══════ TOMADOR ═══════ -->
<div class="sec">TOMADOR</div>
<div class="cnt">
  <div><strong>Razão Social:</strong> ${p.tomador.nome}</div>
  ${endTomador ? `<div><strong>Endereço:</strong> ${endTomador}</div>` : ""}
  <div>
    ${p.tomador.email ? `<strong>E-mail:</strong> ${p.tomador.email} &nbsp;-&nbsp;` : ""}
    <strong>CPF/CNPJ:</strong> ${p.tomador.cpfCnpj}
  </div>
</div>

<!-- ═══════ SERVIÇO NACIONAL ═══════ -->
${codigoSN ? `<div class="sec">SERVIÇO NACIONAL</div>
<div class="cnt" style="min-height:20px;">${codigoSN}</div>` : ""}

<!-- ═══════ SERVIÇO NBS ═══════ -->
${codigoNbs ? `<div class="sec">SERVIÇO NBS</div>
<div class="cnt" style="min-height:20px;">NBS: ${codigoNbs}</div>` : ""}

<!-- ═══════ SERVIÇO ═══════ -->
${itemLS ? `<div class="sec">SERVIÇO</div>
<div class="cnt" style="min-height:20px;">${itemLS}</div>` : ""}

<!-- ═══════ DISCRIMINAÇÃO DOS SERVIÇOS ═══════ -->
<div class="sec">DISCRIMINAÇÃO DOS SERVIÇOS</div>
<div class="disc">${discriminacaoFinal}</div>

<!-- ═══════ OBSERVAÇÃO ═══════ -->
<div class="sec">OBSERVAÇÃO</div>
<div class="obs"></div>

<!-- ═══════ VALORES ═══════ -->
<table class="tbl" style="border:1px solid #000;border-top:0;border-bottom:0;">
  <colgroup>
    <col style="width:17%"><col style="width:13%"><col style="width:24%">
    <col style="width:20%"><col style="width:12%"><col style="width:14%">
  </colgroup>
  <tr>
    <td class="vh">VALOR SERVIÇO (R$)</td>
    <td class="vh">DEDUÇÕES (R$)</td>
    <td class="vh">DESCONTO INCONDICIONAL (R$)</td>
    <td class="vh">BASE CÁLCULO (R$)</td>
    <td class="vh">ALÍQUOTA (%)</td>
    <td class="vh">ISS (R$)</td>
  </tr>
  <tr>
    <td class="vv">${valorServ}</td>
    <td class="vv">${valDeducoes}</td>
    <td class="vv">0,00</td>
    <td class="vv">${valorServ}</td>
    <td class="vv">${aliquotaFmt}</td>
    <td class="vv">${valIss}</td>
  </tr>
</table>

<!-- ═══════ DEMONSTRATIVO DOS TRIBUTOS FEDERAIS ═══════ -->
<!-- cols 1-5 = 54% (17+13+24) alinhados com VALOR/DEDUÇÕES/DESC da tabela acima -->
<!-- cols 6-8 = 46% (20+12+14) alinhados com BASE/ALÍQ/ISS da tabela acima -->
<table class="tbl" style="border:1px solid #000;border-top:0;">
  <colgroup>
    <col style="width:10.8%"><col style="width:10.8%"><col style="width:10.8%">
    <col style="width:10.8%"><col style="width:10.8%">
    <col style="width:20%"><col style="width:12%"><col style="width:14%">
  </colgroup>
  <tr>
    <td class="vhd" colspan="5">DEMONSTRATIVO DOS TRIBUTOS FEDERAIS</td>
    <td class="vh"  rowspan="2">DESCONTO<br>CONDICIONAL (R$)</td>
    <td class="vh"  rowspan="2">OUTRAS<br>RETENÇÕES (R$)</td>
    <td class="vhl" rowspan="2">VALOR LÍQUIDO (R$)</td>
  </tr>
  <tr>
    <td class="vh">INSS (R$)</td>
    <td class="vh">IR (R$)</td>
    <td class="vh">CSLL (R$)</td>
    <td class="vh">COFINS (R$)</td>
    <td class="vh">PIS (R$)</td>
  </tr>
  <tr>
    <td class="vv">${valInss}</td>
    <td class="vv">${valIr}</td>
    <td class="vv">${valCsll}</td>
    <td class="vv">${valCofins}</td>
    <td class="vv">${valPis}</td>
    <td class="vv">0,00</td>
    <td class="vv">0,00</td>
    <td class="vvb">${valorLiquido}</td>
  </tr>
</table>

<!-- ═══════ OUTRAS INFORMAÇÕES ═══════ -->
<div class="sec">OUTRAS INFORMAÇÕES</div>
<div class="outras">
  ${chaveAcesso ? `<div><strong>Chave de acesso Ambiente de Dados Nacional:</strong> ${chaveAcesso}</div>
  <div>(Valor Líquido = Valor Serviço - INSS - IR - CSLL - Outras Retenções - COFINS - PIS - Descontos Diversos - ISS Retido - Desconto Incondicional)</div>` : ""}
  ${textoSN ? `<div style="margin-top:3px;">${textoSN}</div>` : ""}
</div>

<!-- ═══════ RODAPÉ ═══════ -->
<div class="footer">
  Consulte a autenticidade deste documento acessando o site <strong>www.vitoriadaconquista.ba.gov.br</strong>
</div>

</div>
</body></html>`;
}

// ── Barcode ITF-25 para email — tabela HTML (Gmail bloqueia SVG) ─────────────

function barcodeEmailTable(code: string): string {
  // N=1px, W=2px → barcode total ~320px para 44 dígitos; cabe em qualquer email
  const N = 1, W = 2, H = 48;
  const enc: Record<string, string> = {
    "0": "nnwwn", "1": "wnnnw", "2": "nwnnw", "3": "wwnnn", "4": "nnwnw",
    "5": "wnwnn", "6": "nwwnn", "7": "nnnww", "8": "wnnwn", "9": "nwnwn",
  };
  const raw = code.replace(/\D/g, "");
  const s   = raw.length % 2 === 0 ? raw : "0" + raw;
  const cells: { w: number; black: boolean }[] = [];
  // Start: NNNN
  cells.push({ w:N, black:true }, { w:N, black:false }, { w:N, black:true }, { w:N, black:false });
  for (let i = 0; i < s.length; i += 2) {
    const bE = enc[s[i]], sE = enc[s[i + 1]];
    if (!bE || !sE) continue;
    for (let j = 0; j < 5; j++) {
      cells.push({ w: bE[j] === "w" ? W : N, black: true  });
      cells.push({ w: sE[j] === "w" ? W : N, black: false });
    }
  }
  // Stop: WNN
  cells.push({ w:W, black:true }, { w:N, black:false }, { w:N, black:true });

  const tds = cells
    .map(c => `<td style="width:${c.w}px;height:${H}px;background:${c.black ? "#000" : "#fff"};padding:0;font-size:0;line-height:0;"></td>`)
    .join("");

  return `<table cellpadding="0" cellspacing="0" border="0"
    style="border-collapse:collapse;height:${H}px;background:#fff;"><tr>${tds}</tr></table>`;
}

// ── Template HTML do corpo do e-mail ─────────────────────────────────────────

function corpoEmail(params: {
  emitenteNome:         string;
  logoHasCid:           boolean;
  tomadorNome:          string;
  competencia:          string;
  vencimento:           string;
  valor:                number;
  nomeServico?:         string;
  nfseNumero?:          string;
  nfseLinkNfse?:        string;
  nfseCodigoVerif?:     string;
  nfseQrcodeHasCid?:    boolean;
  nfseTemXml?:          boolean;
  pixBrcode?:           string;
  pixQrcodeHasCid:      boolean;
  boletoLinhaDigitavel?: string;
  boletoCodigoBarras?:  string;
  temAnexos:            boolean;
}): string {
  const v = fmtValor(params.valor);
  const d = fmtData(params.vencimento);

  const pixSection = params.pixBrcode ? `
    <tr><td style="padding:0 32px 24px">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#f0faf4;border-radius:8px;border:1px solid #86efac;padding:16px">
        <tr>
          ${params.pixQrcodeHasCid ? `
          <td width="146" style="vertical-align:top;padding-right:16px">
            <img src="cid:pix_qrcode" width="130" height="130"
                 style="display:block;border-radius:4px;border:1px solid #d1fae5;" alt="QR Code PIX">
          </td>` : ""}
          <td style="vertical-align:top">
            <p style="margin:0 0 6px;font-size:12px;font-weight:bold;color:#15803d;text-transform:uppercase;letter-spacing:.5px">⚡ PIX — Pagamento instantâneo</p>
            <p style="margin:0 0 4px;font-size:11px;color:#374151;">Copie o código Copia e Cola:</p>
            <div style="background:#fff;border:1px solid #d1fae5;border-radius:4px;padding:8px;
                        font-family:monospace;font-size:10px;color:#065f46;word-break:break-all;">${params.pixBrcode}</div>
          </td>
        </tr>
      </table>
    </td></tr>` : "";

  const boletoSection = params.boletoLinhaDigitavel ? `
    <tr><td style="padding:0 32px 24px">
      <table width="100%" cellpadding="0" cellspacing="0"
             style="background:#eef4f8;border-radius:8px;border:1px solid #b6cfd9;padding:16px">
        <tr><td>
          <p style="margin:0 0 8px;font-size:12px;font-weight:bold;color:#004a5c;text-transform:uppercase;letter-spacing:.5px">🏦 Boleto Bancário</p>
          <p style="margin:0 0 6px;font-size:11px;color:#374151;">Linha digitável:</p>
          <div style="background:#fff;border:1px solid #b6cfd9;border-radius:4px;padding:10px;
                      font-family:monospace;font-size:11px;color:#004a5c;font-weight:bold;
                      letter-spacing:0.5px;word-break:break-all;text-align:center;">${params.boletoLinhaDigitavel}</div>
          ${params.boletoCodigoBarras ? `
          <p style="margin:12px 0 6px;font-size:11px;color:#374151;">Código de barras:</p>
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:10px;">
            ${barcodeEmailTable(params.boletoCodigoBarras)}
          </div>` : ""}
          <p style="margin:8px 0 0;font-size:10px;color:#888;">Vencimento: ${d} &nbsp;·&nbsp; Valor: ${v}</p>
        </td></tr>
      </table>
    </td></tr>` : "";

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">

        <!-- Header -->
        <tr><td style="background:#004a5c;padding:20px 32px">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            ${params.logoHasCid ? `
            <td width="80" style="vertical-align:middle;padding-right:16px">
              <img src="cid:emitente_logo" width="70" height="70"
                   style="display:block;border-radius:6px;object-fit:contain;background:#fff;padding:4px;" alt="Logo">
            </td>` : ""}
            <td style="vertical-align:middle">
              <p style="margin:0;color:#fff;font-size:20px;font-weight:bold">Nota de Honorários — ${params.competencia}</p>
              <p style="margin:4px 0 0;color:#7dd3e8;font-size:13px">${params.emitenteNome}</p>
            </td>
          </tr></table>
        </td></tr>

        <!-- Saudação -->
        <tr><td style="padding:24px 32px 0">
          <p style="margin:0 0 16px;font-size:14px;color:#374151">
            Prezado(a) <strong>${params.tomadorNome}</strong>,
          </p>
          <p style="margin:0 0 24px;font-size:14px;color:#555">
            Encaminhamos o faturamento referente a
            <strong>${params.nomeServico || "serviços prestados"}</strong>
            — competência ${params.competencia}.
          </p>
        </td></tr>

        <!-- NFS-e -->
        ${params.nfseNumero ? `
        <tr><td style="padding:0 32px 16px">
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="background:#f0f4ff;border-radius:8px;border:1px solid #c7d2fe;padding:14px 18px">
            <tr>
              ${params.nfseQrcodeHasCid ? `
              <td width="106" style="vertical-align:top;padding-right:14px">
                <img src="cid:nfse_qrcode" width="90" height="90"
                     style="display:block;border-radius:4px;border:1px solid #c7d2fe;" alt="QR Code NFS-e">
                <p style="margin:4px 0 0;font-size:9px;color:#6366f1;text-align:center;line-height:1.2;">Escanear para<br>verificar NFS-e</p>
              </td>` : ""}
              <td style="vertical-align:top">
                <p style="margin:0 0 6px;font-size:11px;font-weight:bold;color:#3730a3;text-transform:uppercase;letter-spacing:.5px">📄 Nota Fiscal de Serviços Eletrônica</p>
                <p style="margin:0 0 4px;font-size:14px;color:#1e1b4b">NFS-e nº <strong>${params.nfseNumero}</strong></p>
                ${params.nfseCodigoVerif ? `<p style="margin:0 0 10px;font-size:11px;color:#64748b">Código de verificação: <strong style="font-family:monospace;color:#3730a3">${params.nfseCodigoVerif}</strong></p>` : ""}
                <table cellpadding="0" cellspacing="0"><tr>
                  ${params.nfseLinkNfse ? `
                  <td style="padding-right:8px;padding-top:4px">
                    <a href="${params.nfseLinkNfse}"
                       style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;
                              font-size:11px;font-weight:bold;padding:7px 12px;border-radius:6px;">
                      🏛️ Consultar NFS-e →
                    </a>
                  </td>` : ""}
                  ${params.nfseTemXml ? `
                  <td style="padding-top:4px">
                    <span style="display:inline-block;background:#e0e7ff;color:#3730a3;
                                 font-size:11px;font-weight:bold;padding:7px 12px;border-radius:6px;">
                      📎 XML em anexo
                    </span>
                  </td>` : ""}
                </tr></table>
              </td>
            </tr>
          </table>
        </td></tr>` : ""}

        <!-- Detalhes -->
        <tr><td style="padding:0 32px 24px">
          <table width="100%" cellpadding="0" cellspacing="0"
                 style="background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
            <tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Competência</td>
                <td align="right" style="font-size:14px;color:#1e293b;font-weight:bold">${params.competencia}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 20px;border-bottom:1px solid #e2e8f0">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Vencimento</td>
                <td align="right" style="font-size:14px;color:#1e293b;font-weight:bold">${d}</td>
              </tr></table>
            </td></tr>
            <tr><td style="padding:14px 20px">
              <table width="100%"><tr>
                <td style="font-size:13px;color:#64748b">Valor</td>
                <td align="right" style="font-size:18px;font-weight:bold;color:#16a34a">${v}</td>
              </tr></table>
            </td></tr>
          </table>
        </td></tr>

        <!-- PIX -->
        ${pixSection}

        <!-- Boleto -->
        ${boletoSection}

        <!-- Documentos em anexo -->
        ${params.temAnexos ? `
        <tr><td style="padding:0 32px 24px">
          <p style="margin:0;font-size:13px;color:#6b7280;background:#f8fafc;border-left:3px solid #004a5c;
                    padding:10px 14px;border-radius:0 6px 6px 0;">
            📎 Documentos em anexo: Nota de Honorários${params.nfseNumero ? ", NFS-e (PDF e XML)" : ""}${params.boletoLinhaDigitavel ? " e Boleto Bancário" : ""}.
          </p>
        </td></tr>` : ""}

        <!-- Footer -->
        <tr><td style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e7eb;text-align:center">
          <p style="margin:0;font-size:11px;color:#94a3b8">
            E-mail automático gerado pelo sistema Avoce.<br>
            ${params.emitenteNome}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Helpers compartilhados (cobrança e NFS-e) ────────────────────────────────

type EmitenteEmail = {
  id: string; cnpj: string; certPass: string | null; codigoMunicipio: string | null;
  nfseProvider: string | null; nfseTpAmb: string | null; inscricaoMunicipal: string;
  smtpHost: string | null; smtpPort: number | null; smtpUser: string | null; smtpPass: string | null; smtpFrom: string | null;
};

/** Usa emailsCobranca do contrato se configurados; senão o e-mail principal do tomador. */
function destinatariosDoContrato(contrato: { emailsCobranca?: string[] | null; tomador: { email: string | null } }): string[] {
  const emailsContrato = contrato.emailsCobranca ?? [];
  return emailsContrato.length > 0
    ? [...new Set(emailsContrato)]
    : (contrato.tomador.email ? [contrato.tomador.email] : []);
}

function smtpDoEmitente(emp: EmitenteEmail): SmtpConfig {
  // Montar o campo "from" corretamente: se smtpFrom não contém "@", é um nome
  // de exibição e precisa ser combinado com o smtpUser
  const fromEmail = emp.smtpUser!;
  const fromName  = emp.smtpFrom && !emp.smtpFrom.includes("@") ? emp.smtpFrom : null;
  return {
    host:   emp.smtpHost!,
    port:   emp.smtpPort ?? 587,
    secure: emp.smtpPort === 465,   // SSL apenas se porta for explicitamente 465
    user:   fromEmail,
    pass:   fieldDecrypt(emp.smtpPass),
    from:   fromName ? `"${fromName}" <${fromEmail}>` : (emp.smtpFrom ?? fromEmail),
  };
}

/** Configuração mínima para usar o A1 do emitente (DANFSe no ADN / portal E&L). */
function cfgCertificado(emp: EmitenteEmail): EmpresaConfig {
  return {
    cnpj: emp.cnpj, inscricaoMunicipal: emp.inscricaoMunicipal,
    certPath: certPathForEmpresa(emp.id),
    certPass: fieldDecrypt(emp.certPass) || process.env[`CERT_PASS_${emp.id}`] || process.env.CERT_PASS_DEFAULT || "",
    aliquotaIss: 0, itemListaServico: "", codTributacao: "", simplesNacional: "",
    nfseProvider: (emp.nfseProvider as EmpresaConfig["nfseProvider"]) ?? undefined,
    codigoMunicipioEmitente: emp.codigoMunicipio ?? undefined,
    tpAmb: (emp.nfseTpAmb as EmpresaConfig["tpAmb"]) ?? undefined,
  };
}

// ── Função principal ──────────────────────────────────────────────────────────

export async function enviarEmailCobranca(cobrancaId: string): Promise<void> {
  const cobranca = await prisma.cobranca.findUnique({
    where: { id: cobrancaId },
    include: { emitente: true, contrato: { include: { tomador: true } } },
  });
  if (!cobranca) {
    console.warn(`[Email-Cob] Cobrança ${cobrancaId} não encontrada`);
    return;
  }

  // Helper: registra o resultado do envio na própria cobrança (monitor de saúde)
  const marcar = (patch: {
    emailStatus: string; emailErro?: string | null; emailEnviadoEm?: Date | null;
    emailDestinatarios?: string[];
  }) =>
    prisma.cobranca.update({
      where: { id: cobrancaId },
      data: {
        ...patch,
        emailTentativas:   { increment: 1 },
        emailUltTentativa: new Date(),
      },
    }).catch((e) => console.error(`[Email-Cob] Falha ao registrar status ${cobrancaId}:`, e));

  // ── SMTP ──
  const emp = cobranca.emitente;
  if (!emp.smtpHost || !emp.smtpUser) {
    console.log(`[Email-Cob] SMTP não configurado para empresa ${emp.nome} — e-mail não enviado`);
    await marcar({ emailStatus: "FALHA", emailErro: "SMTP não configurado para a empresa" });
    return;
  }

  const destinatarios = destinatariosDoContrato(cobranca.contrato);

  if (!destinatarios.length) {
    console.log(`[Email-Cob] Cobrança ${cobrancaId}: sem e-mails cadastrados — não enviado`);
    await marcar({ emailStatus: "FALHA", emailErro: "Nenhum e-mail cadastrado para o tomador/contrato" });
    return;
  }

  const smtp = smtpDoEmitente(emp);

  // ── Variáveis de template ──
  const vars = {
    competencia: cobranca.competencia,
    vencimento:  cobranca.vencimento,
    valor:       cobranca.valor,
    emitente:    emp.nomeFantasia || emp.nome,
    tomador:     cobranca.contrato.tomador.nome,
    servico:     cobranca.contrato.nomeServico ?? undefined,
  };

  // ── NFS-e emitida para esta competência ──
  const notaFiscal = await prisma.notaFiscal.findFirst({
    where: {
      contratoId:  cobranca.contratoId,
      competencia: cobranca.competencia,
      status:      "EMITIDA",
    },
    orderBy: { emitidoEm: "desc" },
  });

  // ── Logos ──
  const logoBase64   = loadLogoBase64(emp.logoPath);
  const sicoobLogo   = loadSicoobLogo();

  // ── QR code para a carta de cobrança (URL de autenticidade NFS-e) ──
  // NFS-e por DPS (leiaute nacional): consulta pública nacional pela chave; a
  // autenticação da E&L por código de verificação só vale para as notas ABRASF.
  const nfseDps  = !!notaFiscal?.chaveAcesso;
  const nfseLink = (nfseDps || !notaFiscal?.codigoVerif
    ? notaFiscal?.linkNfse
    : urlAutenticidadeNfse(emp.cnpj, notaFiscal.codigoVerif)) ?? undefined;
  const nfseCodigoVerif = nfseDps ? undefined : notaFiscal?.codigoVerif ?? undefined;
  let nfseQrcodeBase64: string | undefined;
  if (nfseLink) {
    try { nfseQrcodeBase64 = await QRCode.toDataURL(nfseLink, { width: 80, margin: 1 }); }
    catch { /* ignora */ }
  }

  // ── Gerar carta de cobrança (PDF) ──
  let cartaPdf: Buffer | undefined;
  try {
    const cartaHtml = gerarCartaCobrancaHtml({
      emitente: {
        nome:         emp.nome,
        nomeFantasia: emp.nomeFantasia ?? undefined,
        cnpj:         emp.cnpj,
        endereco:     emp.endereco    ?? undefined,
        numero:       emp.numero      ?? undefined,
        complemento:  emp.complemento ?? undefined,
        bairro:       emp.bairro      ?? undefined,
        cidade:       emp.cidade      ?? undefined,
        uf:           emp.uf          ?? undefined,
        cep:          emp.cep         ?? undefined,
        email:        emp.email       ?? undefined,
        telefone:     emp.telefone    ?? undefined,
        logoBase64,
      },
      tomador: {
        nome:     cobranca.contrato.tomador.nome,
        cpfCnpj:  cobranca.contrato.tomador.cpfCnpj,
        endereco: cobranca.contrato.tomador.endereco ?? undefined,
        cidade:   cobranca.contrato.tomador.cidade   ?? undefined,
        uf:       cobranca.contrato.tomador.uf        ?? undefined,
        email:    cobranca.contrato.tomador.email     ?? undefined,
      },
      nomeServico:   cobranca.contrato.nomeServico    ?? undefined,
      discriminacao: renderTemplate(cobranca.contrato.descricaoServico, vars),
      observacao:    cobranca.contrato.observacoes
        ? renderTemplate(cobranca.contrato.observacoes, vars)
        : undefined,
      competencia: cobranca.competencia,
      vencimento:  cobranca.vencimento,
      valor:       cobranca.valor,
      pixBrcode:    cobranca.pixBrcode    ?? undefined,
      pixQrcode:    cobranca.pixQrcode    ?? undefined,
      pixExpiresAt: cobranca.pixExpiresAt ?? undefined,
      boletoLinhaDigitavel: cobranca.boletoLinhaDigitavel ?? undefined,
      boletoCodigoBarras:   cobranca.boletoCodigoBarras   ?? undefined,
      nfse: notaFiscal ? {
        numero:        notaFiscal.numero!,
        emitidoEm:     notaFiscal.emitidoEm,
        codigoVerif:   nfseCodigoVerif,
        linkNfse:      nfseLink,
        qrcodeBase64:  nfseQrcodeBase64,
      } : undefined,
    });
    cartaPdf = await htmlToPdf(cartaHtml);
  } catch (err) {
    console.error(`[Email-Cob] Falha ao gerar carta PDF:`, err);
  }

  // ── Gerar boleto (PDF) ──
  let boletoPdf: Buffer | undefined;
  if (cobranca.boletoNossoNumero) {
    try {
      const today = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const boletoHtml = gerarBoletoHtml({
        beneficiario: {
          nome:            emp.nome,
          cnpj:            emp.cnpj,
          endereco:        emp.endereco    ?? undefined,
          numero:          emp.numero      ?? undefined,
          complemento:     emp.complemento ?? undefined,
          bairro:          emp.bairro      ?? undefined,
          cidade:          emp.cidade      ?? undefined,
          uf:              emp.uf          ?? undefined,
          cep:             emp.cep         ?? undefined,
          cooperativa:     "3226",
          codBeneficiario: emp.boletoNumeroCliente ?? "161756",
          carteira:        emp.boletoModalidade    ?? "1",
          logoBase64,
          sicoobLogo,
        },
        pagador: {
          nome:     cobranca.contrato.tomador.nome,
          cpfCnpj:  cobranca.contrato.tomador.cpfCnpj,
          endereco: cobranca.contrato.tomador.endereco ?? undefined,
          cidade:   cobranca.contrato.tomador.cidade   ?? undefined,
          uf:       cobranca.contrato.tomador.uf        ?? undefined,
          cep:      cobranca.contrato.tomador.cep       ?? undefined,
        },
        nossoNumero:       cobranca.boletoNossoNumero,
        linhaDigitavel:    cobranca.boletoLinhaDigitavel ?? "",
        codigoBarras:      cobranca.boletoCodigoBarras   ?? "",
        valor:             cobranca.valor,
        vencimento:        cobranca.vencimento,
        dataEmissao:       cobranca.criadoEm.toISOString().slice(0, 10),
        dataProcessamento: today,
        nroDocumento:      cobranca.id.slice(-10).toUpperCase(),
        instrucoes: [
          `Ref.: ${cobranca.contrato.nomeServico || "Serviços prestados"} — ${cobranca.competencia}`,
          "Multa de 2% + juros de 0,033% ao dia após o vencimento.",
          "Não receber após 30 dias do vencimento.",
        ],
      });
      boletoPdf = await htmlToPdf(boletoHtml);
    } catch (err) {
      console.error(`[Email-Cob] Falha ao gerar boleto PDF:`, err);
    }
  }

  // ── Montar e-mail ──
  const transporter = nodemailer.createTransport({
    host:       smtp.host,
    port:       smtp.port,
    secure:     smtp.secure,
    requireTLS: !smtp.secure,  // STARTTLS quando não for SSL direto
    auth:       { user: smtp.user, pass: smtp.pass },
    tls:        { rejectUnauthorized: false },
  });

  const emitenteNome = emp.nomeFantasia || emp.nome;
  const assunto = `Nota de Honorários ${cobranca.competencia} — ${cobranca.contrato.nomeServico || emitenteNome} — ${fmtValor(cobranca.valor)}`;

  // ── Preparar imagens CID (inline) ──
  // QR Code PIX: extrair base64 do data URL e anexar como cid:pix_qrcode
  let pixQrcodeBase64: Buffer | null = null;
  if (cobranca.pixQrcode) {
    const m = cobranca.pixQrcode.match(/^data:image\/png;base64,(.+)$/);
    if (m) pixQrcodeBase64 = Buffer.from(m[1], "base64");
  }

  // QR Code NFS-e: extrair base64 do data URL e anexar como cid:nfse_qrcode
  let nfseQrcodeBuffer: Buffer | null = null;
  if (nfseQrcodeBase64) {
    const m = nfseQrcodeBase64.match(/^data:image\/png;base64,(.+)$/);
    if (m) nfseQrcodeBuffer = Buffer.from(m[1], "base64");
  }

  // Logo da empresa: extrair base64 para cid:emitente_logo
  let logoBuffer: Buffer | null = null;
  let logoMime   = "image/jpeg";
  if (emp.logoPath && existsSync(emp.logoPath)) {
    try {
      logoBuffer = readFileSync(emp.logoPath);
      const ext  = emp.logoPath.split(".").pop()?.toLowerCase() ?? "jpg";
      logoMime   = ext === "png" ? "image/png" : ext === "svg" ? "image/svg+xml" : "image/jpeg";
    } catch { /* ignora */ }
  }

  const attachments: nodemailer.SendMailOptions["attachments"] = [];

  // Anexos inline (CID)
  if (pixQrcodeBase64) {
    attachments.push({
      cid:         "pix_qrcode",
      filename:    "qrcode-pix.png",
      content:     pixQrcodeBase64,
      contentType: "image/png",
    });
  }
  if (nfseQrcodeBuffer) {
    attachments.push({
      cid:         "nfse_qrcode",
      filename:    "qrcode-nfse.png",
      content:     nfseQrcodeBuffer,
      contentType: "image/png",
    });
  }
  if (logoBuffer) {
    attachments.push({
      cid:         "emitente_logo",
      filename:    "logo-emitente",
      content:     logoBuffer,
      contentType: logoMime,
    });
  }

  // ── Gerar PDF da NFS-e ──
  let nfsePdf: Buffer | undefined;
  if (notaFiscal?.chaveAcesso) {
    try { nfsePdf = await obterDanfsePdf(cfgCertificado(emp), notaFiscal.chaveAcesso); }
    catch (err) { console.error(`[Email-Cob] Falha ao obter DANFSe ${notaFiscal.chaveAcesso}:`, err); }
  } else if (notaFiscal) {
    try {
      const nfseUrlAuth = notaFiscal.codigoVerif
        ? urlAutenticidadeNfse(emp.cnpj, notaFiscal.codigoVerif)
        : (notaFiscal.linkNfse ?? undefined);

      const nfseHtml = gerarNfseHtml({
        numero:        notaFiscal.numero!,
        emitidoEm:     notaFiscal.emitidoEm,
        codigoVerif:   notaFiscal.codigoVerif,
        urlAuth:       nfseUrlAuth,
        brasaoBase64:  loadBrasaoVdc(),
        qrcodeBase64:  nfseQrcodeBase64,
        xmlRetorno:    notaFiscal.xmlRetorno,
        emitente: {
          nome:               emp.nome,
          nomeFantasia:       emp.nomeFantasia        ?? undefined,
          cnpj:               emp.cnpj,
          inscricaoMunicipal: emp.inscricaoMunicipal  ?? undefined,
          endereco:           emp.endereco             ?? undefined,
          numero:             emp.numero               ?? undefined,
          bairro:             emp.bairro               ?? undefined,
          cidade:             emp.cidade               ?? undefined,
          uf:                 emp.uf                   ?? undefined,
          cep:                emp.cep                  ?? undefined,
          telefone:           emp.telefone             ?? undefined,
          email:              emp.email                ?? undefined,
        },
        tomador: {
          nome:     cobranca.contrato.tomador.nome,
          cpfCnpj:  cobranca.contrato.tomador.cpfCnpj,
          endereco: cobranca.contrato.tomador.endereco ?? undefined,
          cidade:   cobranca.contrato.tomador.cidade   ?? undefined,
          uf:       cobranca.contrato.tomador.uf        ?? undefined,
          email:    cobranca.contrato.tomador.email     ?? undefined,
        },
        competencia:   cobranca.competencia,
        valor:         cobranca.valor,
        discriminacao: renderTemplate(cobranca.contrato.descricaoServico, vars),
      });
      nfsePdf = await htmlToPdf(nfseHtml);
    } catch (err) {
      console.error(`[Email-Cob] Falha ao gerar PDF NFS-e:`, err);
    }
  }

  // Anexos PDF
  if (cartaPdf) {
    const comp = cobranca.competencia.replace("/", "-");
    attachments.push({
      filename:    `Nota-Honorarios-${comp}.pdf`,
      content:     cartaPdf,
      contentType: "application/pdf",
    });
  }
  if (nfsePdf && notaFiscal) {
    attachments.push({
      filename:    `NFS-e-${notaFiscal.numero}.pdf`,
      content:     nfsePdf,
      contentType: "application/pdf",
    });
  }
  if (notaFiscal?.xmlRetorno) {
    attachments.push({
      filename:    `NFS-e-${notaFiscal.numero}.xml`,
      content:     Buffer.from(notaFiscal.xmlRetorno),
      contentType: "application/xml",
    });
  }
  if (boletoPdf) {
    attachments.push({
      filename:    `Boleto-${cobranca.boletoNossoNumero}.pdf`,
      content:     boletoPdf,
      contentType: "application/pdf",
    });
  }

  const html = corpoEmail({
    emitenteNome,
    logoHasCid:           !!logoBuffer,
    tomadorNome:          cobranca.contrato.tomador.nome,
    competencia:          cobranca.competencia,
    vencimento:           cobranca.vencimento,
    valor:                cobranca.valor,
    nomeServico:          cobranca.contrato.nomeServico ?? undefined,
    nfseNumero:           notaFiscal?.numero            ?? undefined,
    nfseLinkNfse:         nfseLink,
    nfseCodigoVerif:      nfseCodigoVerif,
    nfseQrcodeHasCid:     !!nfseQrcodeBuffer,
    nfseTemXml:           !!(notaFiscal?.xmlRetorno),
    pixBrcode:            cobranca.pixBrcode            ?? undefined,
    pixQrcodeHasCid:      !!pixQrcodeBase64,
    boletoLinhaDigitavel: cobranca.boletoLinhaDigitavel ?? undefined,
    boletoCodigoBarras:   cobranca.boletoCodigoBarras   ?? undefined,
    temAnexos:            !!(cartaPdf || nfsePdf || boletoPdf || notaFiscal?.xmlRetorno),
  });

  const bccEmail = emp.email || undefined;

  try {
    const info = await sendMailAndSave(smtp, {
      from:        smtp.from || smtp.user,
      to:          destinatarios.join(", "),
      bcc:         bccEmail,
      subject:     assunto,
      html,
      attachments,
    });
    console.log(`[Email-Cob] Cobrança ${cobrancaId} enviada para ${destinatarios.join(", ")}${bccEmail ? ` (bcc: ${bccEmail})` : ""} (msgId=${info.messageId})`);
    await marcar({
      emailStatus:       "ENVIADO",
      emailErro:         null,
      emailEnviadoEm:    new Date(),
      emailDestinatarios: destinatarios,
    });
    if (notaFiscal && (nfsePdf || notaFiscal.xmlRetorno)) {
      await prisma.notaFiscal.update({ where: { id: notaFiscal.id }, data: { emailEnviadoEm: new Date() } })
        .catch((e) => console.error(`[Email-Cob] Falha ao marcar NFS-e ${notaFiscal.id} como enviada:`, e));
    }
  } catch (err) {
    console.error(`[Email-Cob] Falha ao enviar cobrança ${cobrancaId}:`, err);
    await marcar({
      emailStatus:       "FALHA",
      emailErro:         (err instanceof Error ? err.message : String(err)).slice(0, 500),
      emailDestinatarios: destinatarios,
    });
  }
}

// ── NFS-e avulsa (sem cobrança no mesmo e-mail) ──────────────────────────────

function corpoEmailNfse(p: {
  tomadorNome: string; emitenteNome: string; nomeServico?: string | null; competencia: string;
  numero: string; valor: number; chaveAcesso?: string | null; linkNfse?: string | null; semPdf?: boolean;
  emitenteEmail?: string | null; emitenteTelefone?: string | null; cobrancaJaEnviada: boolean;
}): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:600px">
<p>Prezado(a) <strong>${esc(p.tomadorNome)}</strong>,</p>
<p>Segue em anexo a Nota Fiscal de Serviços Eletrônica referente a <strong>${esc(p.nomeServico || "honorários advocatícios")}</strong>, competência <strong>${esc(p.competencia)}</strong>, emitida por ${esc(p.emitenteNome)}.</p>
<table style="border-collapse:collapse;margin:16px 0;font-size:13px">
<tr><td style="padding:4px 16px 4px 0;color:#666">NFS-e nº</td><td><strong>${esc(p.numero)}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#666">Valor</td><td><strong>${fmtValor(p.valor)}</strong></td></tr>
${p.chaveAcesso ? `<tr><td style="padding:4px 16px 4px 0;color:#666">Chave de acesso</td><td style="font-family:monospace;font-size:12px">${esc(p.chaveAcesso)}</td></tr>` : ""}
</table>
${p.semPdf
  ? `<p>Em anexo: arquivo XML da nota. O DANFSe (PDF) pode ser visualizado e baixado na <a href="${p.linkNfse || `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${p.chaveAcesso ?? ""}`}">consulta pública da NFS-e</a>, informando a chave de acesso acima.</p>`
  : `<p>Em anexo: DANFSe (PDF) e o arquivo XML da nota.${p.linkNfse ? ` A autenticidade pode ser conferida em <a href="${p.linkNfse}">consulta pública da NFS-e</a>.` : ""}</p>`}
${p.cobrancaJaEnviada ? `<p>O boleto desta competência foi enviado anteriormente, em mensagem separada.</p>` : ""}
<p>Atenciosamente,<br><strong>${esc(p.emitenteNome)}</strong><br>${esc(p.emitenteEmail ?? "")}${p.emitenteTelefone ? ` · ${esc(p.emitenteTelefone)}` : ""}</p>
</div>`;
}

/** Envia ao tomador a NFS-e (DANFSe PDF + XML), sem cobrança. Marca emailEnviadoEm. */
export async function enviarEmailNfse(notaId: string, opts: { permitirSemPdf?: boolean } = {}): Promise<void> {
  const nota = await prisma.notaFiscal.findUnique({
    where:   { id: notaId },
    include: { emitente: true, contrato: { include: { tomador: true } } },
  });
  if (!nota || nota.status !== "EMITIDA" || !nota.numero) return;
  const emp = nota.emitente;
  if (!emp.smtpHost || !emp.smtpUser) {
    console.log(`[Email-NFSe] SMTP não configurado para ${emp.nome} — NFS-e ${nota.numero} não enviada`);
    return;
  }
  const destinatarios = destinatariosDoContrato(nota.contrato);
  if (!destinatarios.length) {
    console.log(`[Email-NFSe] NFS-e ${nota.numero}: sem e-mails cadastrados — não enviada`);
    return;
  }

  const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
  if (nota.chaveAcesso) {
    try {
      attachments.push({
        filename: `NFS-e_${nota.numero}.pdf`, contentType: "application/pdf",
        content:  await obterDanfsePdf(cfgCertificado(emp), nota.chaveAcesso),
      });
    } catch (err) {
      console.error(`[Email-NFSe] Falha ao obter DANFSe da NFS-e ${nota.numero}:`, err);
    }
  }
  if (nota.xmlRetorno) {
    attachments.push({ filename: `NFS-e_${nota.numero}.xml`, contentType: "application/xml", content: Buffer.from(nota.xmlRetorno) });
  }
  const semPdf = !attachments.some(a => a.contentType === "application/pdf");
  // permitirSemPdf: envio manual com o ADN fora do ar (XML + link da consulta pública)
  if (semPdf && !(opts.permitirSemPdf && nota.xmlRetorno && nota.chaveAcesso)) {
    console.error(`[Email-NFSe] NFS-e ${nota.numero}: DANFSe indisponível — não enviada (o cron tenta de novo)`);
    return;
  }

  const cobranca = await prisma.cobranca.findFirst({
    where: { contratoId: nota.contratoId, competencia: nota.competencia, emailStatus: "ENVIADO" },
  });
  const emitenteNome = emp.nomeFantasia || emp.nome;
  const smtp = smtpDoEmitente(emp);
  try {
    const info = await sendMailAndSave(smtp, {
      from:    smtp.from,
      to:      destinatarios.join(", "),
      subject: `NFS-e nº ${nota.numero} — ${emitenteNome} — ${nota.competencia}`,
      html:    corpoEmailNfse({
        tomadorNome: nota.contrato.tomador.nome, emitenteNome, nomeServico: nota.contrato.nomeServico,
        competencia: nota.competencia, numero: nota.numero, valor: nota.valor,
        chaveAcesso: nota.chaveAcesso, linkNfse: nota.linkNfse,
        emitenteEmail: emp.email, emitenteTelefone: emp.telefone, cobrancaJaEnviada: !!cobranca,
        semPdf,
      }),
      attachments,
    });
    await prisma.notaFiscal.update({ where: { id: nota.id }, data: { emailEnviadoEm: new Date() } });
    console.log(`[Email-NFSe] NFS-e ${nota.numero} enviada para ${destinatarios.join(", ")} (msgId=${info.messageId})`);
  } catch (err) {
    console.error(`[Email-NFSe] Falha ao enviar NFS-e ${nota.numero}:`, err);
  }
}

/**
 * Entrega a NFS-e ao tomador sem duplicar com o e-mail de cobrança:
 * - se a cobrança da competência ainda vai sair (existe e não foi enviada, ou o
 *   contrato gera cobrança automática e ela ainda não existe), a NFS-e segue
 *   anexada nela;
 * - se a cobrança já saiu (sem a nota) ou o contrato não gera cobrança, envia avulsa.
 */
export async function enviarNfseSeNecessario(notaId: string): Promise<void> {
  const nota = await prisma.notaFiscal.findUnique({ where: { id: notaId }, include: { contrato: true } });
  if (!nota || nota.status !== "EMITIDA" || nota.emailEnviadoEm) return;

  const cobranca = await prisma.cobranca.findFirst({
    where: { contratoId: nota.contratoId, competencia: nota.competencia },
    orderBy: { criadoEm: "desc" },
  });
  const c = nota.contrato as any;
  const geraCobranca = c.gerarCobrancaAuto !== false && c.metodoCobr !== "NENHUM" && c.metodoCobr !== "ALVARA";

  // emailStatus nulo = cobrança anterior ao monitor de envio; trata como já enviada
  if (cobranca?.emailStatus && cobranca.emailStatus !== "ENVIADO") return;   // vai junto da cobrança
  if (!cobranca && geraCobranca) return;                         // cobrança ainda será gerada
  await enviarEmailNfse(notaId);
}
