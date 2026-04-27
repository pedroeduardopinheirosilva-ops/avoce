// ─────────────────────────────────────────────────────────────────────────────
// Geração de HTML da Nota de Honorários com PIX e Boleto Sicoob
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SICOOB_LOGO_PATH = resolve(
  process.env["SICOOB_LOGO_PATH"] ||
  "./logos/sicoob.png"
);

function getSicoobLogoBase64(): string {
  try {
    if (existsSync(SICOOB_LOGO_PATH)) {
      const buf = readFileSync(SICOOB_LOGO_PATH);
      return `data:image/jpeg;base64,${buf.toString("base64")}`;
    }
  } catch { /* ignora */ }
  return "";
}

export interface CartaCobrancaParams {
  // Emitente (prestador)
  emitente: {
    nome:         string;
    nomeFantasia?: string;
    cnpj:         string;
    endereco?:    string;
    numero?:      string;
    complemento?: string;
    bairro?:      string;
    cidade?:      string;
    uf?:          string;
    cep?:         string;
    email?:       string;
    telefone?:    string;
    logoBase64?:  string;
  };
  // Tomador (cliente)
  tomador: {
    nome:      string;
    cpfCnpj:   string;
    endereco?: string;
    cidade?:   string;
    uf?:       string;
    email?:    string;
  };
  // Contrato/Serviço
  nomeServico?:    string;
  discriminacao:   string;
  observacao?:     string;
  competencia:     string;  // "MM/YYYY"
  vencimento:      string;  // "YYYY-MM-DD"
  valor:           number;  // centavos
  // PIX
  pixBrcode?:  string;
  pixQrcode?:  string;  // base64 PNG
  pixExpiresAt?: Date;
  // Boleto
  boletoLinhaDigitavel?: string;
  boletoCodigoBarras?:   string;
  boletoPdfEndpoint?:    string;  // URL para abrir o boleto PDF separadamente
  // NFS-e (se já emitida)
  nfse?: {
    numero:      string;
    emitidoEm?:  Date | null;
    codigoVerif?: string | null;
    linkNfse?:   string | null;
  };
}

// ── Barcode ITF-25 (Interleaved 2 of 5) em SVG — padrão FEBRABAN ─────────────
function barcodesvg(code: string): string {
  const N = 3, W = 7, H = 60, QZ = 10;
  const enc: Record<string, string> = {
    "0": "nnwwn", "1": "wnnnw", "2": "nwnnw", "3": "wwnnn", "4": "nnwnw",
    "5": "wnwnn", "6": "nwwnn", "7": "nnnww", "8": "wnnwn", "9": "nwnwn",
  };
  const raw = code.replace(/\D/g, "");
  const s = raw.length % 2 === 0 ? raw : "0" + raw;
  const bars: { w: number; b: boolean }[] = [];
  bars.push({ w: N, b: true }, { w: N, b: false }, { w: N, b: true }, { w: N, b: false });
  for (let i = 0; i < s.length; i += 2) {
    const bEnc = enc[s[i]], sEnc = enc[s[i + 1]];
    if (!bEnc || !sEnc) continue;
    for (let j = 0; j < 5; j++) {
      bars.push({ w: bEnc[j] === "w" ? W : N, b: true });
      bars.push({ w: sEnc[j] === "w" ? W : N, b: false });
    }
  }
  bars.push({ w: W, b: true }, { w: N, b: false }, { w: N, b: true });
  const totalW = bars.reduce((acc, b) => acc + b.w, 0) + QZ * 2;
  let x = QZ;
  let rects = "";
  for (const b of bars) {
    if (b.b) rects += `<rect x="${x}" y="0" width="${b.w}" height="${H}"/>`;
    x += b.w;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${H}" width="${totalW}" height="${H}" style="display:block;width:100%;height:auto;fill:#000;" preserveAspectRatio="none">${rects}</svg>`;
}

function fmtValor(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtData(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function fmtDoc(v: string): string {
  const d = v.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
}

export function gerarCartaCobrancaHtml(p: CartaCobrancaParams): string {
  const logoSrc    = getSicoobLogoBase64();
  const [mm, yyyy] = p.competencia.split("/");
  const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                 "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
  const mesRef = `${MESES[parseInt(mm) - 1]}/${yyyy}`;
  const vencFmt = fmtData(p.vencimento);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Nota de Honorários — ${p.emitente.nomeFantasia || p.emitente.nome} — ${mesRef}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11pt; color: #1a1a1a; background: #fff; }
    .page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 15mm 15mm 10mm; }
    @media print {
      body { margin: 0; }
      .page { padding: 10mm; }
      .no-print { display: none !important; }
    }

    /* Header */
    .header { display: flex; align-items: flex-start; gap: 18px; border-bottom: 3px solid #004a5c; padding-bottom: 12px; margin-bottom: 18px; }
    .header-logo { flex-shrink: 0; }
    .header-logo img { height: 90px; width: auto; display: block; }
    .header-emitente { flex: 1; }
    .header-emitente .nome { font-size: 14pt; font-weight: bold; color: #004a5c; }
    .header-emitente .sub { font-size: 9pt; color: #555; margin-top: 2px; }

    /* Título */
    .titulo { text-align: center; margin-bottom: 18px; }
    .titulo h1 { font-size: 13pt; color: #004a5c; text-transform: uppercase; letter-spacing: 1px; }
    .titulo .ref { font-size: 10pt; color: #666; margin-top: 3px; }

    /* Tomador */
    .tomador-box { border: 1px solid #ccc; border-radius: 6px; padding: 12px 14px; margin-bottom: 14px; background: #f9f9f9; }
    .tomador-box .label { font-size: 8.5pt; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .tomador-box .nome { font-size: 11.5pt; font-weight: bold; }
    .tomador-box .info { font-size: 9.5pt; color: #555; margin-top: 2px; }

    /* Serviço */
    .servico-box { border-left: 4px solid #004a5c; padding: 10px 14px; margin-bottom: 14px; background: #f0f6f8; }
    .servico-box .label { font-size: 8.5pt; color: #888; text-transform: uppercase; }
    .servico-box .texto { font-size: 10.5pt; margin-top: 4px; line-height: 1.5; white-space: pre-wrap; }
    .obs-box { font-size: 9.5pt; color: #555; margin-top: 6px; font-style: italic; }

    /* Resumo financeiro */
    .financeiro { display: flex; gap: 12px; margin-bottom: 18px; }
    .fin-item { flex: 1; border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; text-align: center; }
    .fin-item .label { font-size: 8.5pt; color: #888; text-transform: uppercase; }
    .fin-item .valor { font-size: 14pt; font-weight: bold; color: #004a5c; margin-top: 4px; }
    .fin-item.destaque { background: #004a5c; border-color: #004a5c; }
    .fin-item.destaque .label { color: #7ecfde; }
    .fin-item.destaque .valor { color: #fff; }

    /* Seções de pagamento */
    .pagamento-grid { display: flex; flex-direction: column; gap: 14px; margin-bottom: 18px; }
    .pag-box { border: 1px solid #ddd; border-radius: 8px; overflow: hidden; width: 100%; }
    .pag-header { padding: 8px 12px; font-weight: bold; font-size: 10pt; display: flex; align-items: center; gap: 8px; }
    .pag-header.pix    { background: #32bcad; color: #fff; }
    .pag-header.boleto { background: #004a5c; color: #fff; }
    .pag-body { padding: 12px; }

    /* PIX */
    .pix-grid { display: flex; gap: 12px; align-items: center; }
    .pix-qr img { width: 120px; height: 120px; border: 1px solid #eee; border-radius: 4px; }
    .pix-qr .placeholder { width: 120px; height: 120px; border: 2px dashed #aaa; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 8pt; color: #aaa; text-align: center; padding: 8px; }
    .pix-info { flex: 1; }
    .pix-info .label { font-size: 8.5pt; color: #888; text-transform: uppercase; margin-bottom: 3px; }
    .pix-brcode { font-family: monospace; font-size: 7.5pt; word-break: break-all; background: #f5f5f5; padding: 6px 8px; border-radius: 4px; margin-top: 4px; max-height: 48px; overflow: hidden; }
    .pix-expires { font-size: 8.5pt; color: #e05d00; margin-top: 6px; }
    .sicoob-badge { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 8.5pt; color: #555; }
    .sicoob-badge img { height: 22px; }

    /* Boleto */
    .linha-digitavel { font-family: monospace; font-size: 10pt; letter-spacing: 0.5px; background: #f5f5f5; padding: 10px 12px; border-radius: 4px; margin-bottom: 8px; text-align: center; color: #004a5c; font-weight: bold; word-break: break-all; }
    .boleto-info { font-size: 9pt; color: #555; }
    .boleto-info span { margin-right: 14px; }
    .instrucoes { font-size: 8.5pt; color: #777; margin-top: 8px; border-top: 1px dashed #ddd; padding-top: 8px; }
    .boleto-pdf-btn { display: inline-block; margin-top: 10px; background: #004a5c; color: #fff; text-decoration: none; padding: 7px 14px; border-radius: 5px; font-size: 9pt; font-weight: bold; }
    .boleto-pdf-btn:hover { background: #00374a; }

    /* Beneficiário */
    .beneficiario { border-top: 1px solid #eee; padding-top: 12px; margin-top: 4px; font-size: 9pt; color: #666; display: flex; justify-content: space-between; }
    .beneficiario .sicoob-logo { display: flex; align-items: center; gap: 6px; }
    .beneficiario .sicoob-logo img { height: 28px; }

    /* Rodapé */
    .footer { border-top: 1px solid #eee; padding-top: 10px; margin-top: 10px; font-size: 8pt; color: #999; text-align: center; }

    /* Print button */
    .print-btn { position: fixed; bottom: 20px; right: 20px; background: #004a5c; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 13px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  </style>
</head>
<body>
<div class="page">

  <!-- Cabeçalho -->
  <div class="header">
    ${p.emitente.logoBase64 ? `<div class="header-logo"><img src="${p.emitente.logoBase64}" alt="Logo"></div>` : ""}
    <div class="header-emitente">
      <div class="nome">${p.emitente.nomeFantasia || p.emitente.nome}</div>
      ${p.emitente.nomeFantasia ? `<div class="sub">${p.emitente.nome}</div>` : ""}
      <div class="sub">CNPJ: ${fmtDoc(p.emitente.cnpj)}</div>
      ${p.emitente.endereco ? `<div class="sub">${[
        p.emitente.endereco,
        p.emitente.numero,
        p.emitente.complemento,
        p.emitente.bairro,
      ].filter(Boolean).join(", ")}${p.emitente.cidade ? ` — ${p.emitente.cidade}/${p.emitente.uf}` : ""}${p.emitente.cep ? ` · CEP ${p.emitente.cep.replace(/^(\d{5})(\d{3})$/, "$1-$2")}` : ""}</div>` : ""}
      ${p.emitente.email ? `<div class="sub">${p.emitente.email}${p.emitente.telefone ? ` · ${p.emitente.telefone}` : ""}</div>` : ""}
    </div>
  </div>

  <!-- Título -->
  <div class="titulo">
    <h1>Nota de Honorários</h1>
    <div class="ref">Competência: ${mesRef} &nbsp;·&nbsp; Vencimento: ${vencFmt}</div>
  </div>

  <!-- Tomador -->
  <div class="tomador-box">
    <div class="label">Destinatário</div>
    <div class="nome">${p.tomador.nome}</div>
    <div class="info">
      ${fmtDoc(p.tomador.cpfCnpj)}
      ${p.tomador.cidade ? ` &nbsp;·&nbsp; ${p.tomador.cidade}/${p.tomador.uf}` : ""}
      ${p.tomador.email ? ` &nbsp;·&nbsp; ${p.tomador.email}` : ""}
    </div>
  </div>

  <!-- Discriminação do Serviço -->
  <div class="servico-box">
    <div class="label">${p.nomeServico ? `Serviço: ${p.nomeServico}` : "Discriminação dos Serviços"}</div>
    <div class="texto">${p.discriminacao}</div>
    ${p.observacao ? `<div class="obs-box">Obs: ${p.observacao}</div>` : ""}
  </div>

  <!-- Resumo financeiro -->
  <div class="financeiro">
    <div class="fin-item">
      <div class="label">Competência</div>
      <div class="valor" style="font-size:12pt">${mesRef}</div>
    </div>
    <div class="fin-item">
      <div class="label">Vencimento</div>
      <div class="valor" style="font-size:12pt">${vencFmt}</div>
    </div>
    <div class="fin-item destaque">
      <div class="label">Valor Total</div>
      <div class="valor">${fmtValor(p.valor)}</div>
    </div>
  </div>

  <!-- Formas de Pagamento -->
  <div class="pagamento-grid">

    <!-- PIX -->
    ${(p.pixBrcode || p.pixQrcode) ? `
    <div class="pag-box">
      <div class="pag-header pix">
        <span>⚡</span> Pague via PIX
      </div>
      <div class="pag-body">
        <div class="pix-grid">
          <div class="pix-qr">
            ${p.pixQrcode
              ? `<img src="${p.pixQrcode}" alt="QR Code PIX">`
              : `<div class="placeholder">QR Code não disponível</div>`}
          </div>
          <div class="pix-info">
            <div class="label">Chave PIX / Copia e Cola</div>
            ${p.pixBrcode ? `<div class="pix-brcode">${p.pixBrcode.slice(0, 200)}${p.pixBrcode.length > 200 ? "..." : ""}</div>` : ""}
            ${p.pixExpiresAt ? `<div class="pix-expires">Válido até ${p.pixExpiresAt.toLocaleString("pt-BR")}</div>` : ""}
            <div class="sicoob-badge">
              ${logoSrc ? `<img src="${logoSrc}" alt="Sicoob">` : "<strong>SICOOB</strong>"}
              Pix instantâneo
            </div>
          </div>
        </div>
      </div>
    </div>` : ""}

    <!-- Boleto -->
    ${p.boletoLinhaDigitavel ? `
    <div class="pag-box">
      <div class="pag-header boleto">
        <span>🏦</span> Boleto Bancário
      </div>
      <div class="pag-body">
        <div class="linha-digitavel">${p.boletoLinhaDigitavel}</div>
        <div class="boleto-info">
          <span>Vencimento: ${vencFmt}</span>
          <span>Valor: ${fmtValor(p.valor)}</span>
        </div>
        ${p.boletoCodigoBarras ? `
        <div class="instrucoes" style="margin-top:10px">
          <div style="font-size:8pt;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Código de barras</div>
          <div style="width:100%;overflow:hidden;padding:4px 0">${barcodesvg(p.boletoCodigoBarras)}</div>
        </div>` : ""}
        <div class="instrucoes">
          Após o vencimento, sujeito a multa de 2% e juros de 0,033% ao dia.
        </div>
        ${p.boletoPdfEndpoint ? `<a class="boleto-pdf-btn no-print" href="${p.boletoPdfEndpoint}" target="_blank">📄 Abrir Boleto PDF</a>` : ""}
        <div class="sicoob-badge" style="margin-top:10px">
          ${logoSrc ? `<img src="${logoSrc}" alt="Sicoob">` : "<strong>SICOOB</strong>"}
          Cooperativa de Crédito
        </div>
      </div>
    </div>` : ""}

  </div>

  ${p.nfse ? `
  <!-- NFS-e -->
  <div style="border:1px solid #c7d7dd;border-radius:8px;overflow:hidden;margin-bottom:18px;">
    <div style="background:#004a5c;color:#fff;padding:8px 12px;font-weight:bold;font-size:10pt;display:flex;align-items:center;gap:8px;">
      <span>🧾</span> Nota Fiscal de Serviços Eletrônica (NFS-e)
    </div>
    <div style="padding:12px 14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;">
      <div>
        <div style="font-size:8.5pt;color:#888;text-transform:uppercase;margin-bottom:2px;">Número</div>
        <div style="font-size:11pt;font-weight:bold;color:#004a5c;">${p.nfse.numero}</div>
      </div>
      ${p.nfse.emitidoEm ? `
      <div>
        <div style="font-size:8.5pt;color:#888;text-transform:uppercase;margin-bottom:2px;">Data de Emissão</div>
        <div style="font-size:10.5pt;">${new Date(p.nfse.emitidoEm).toLocaleDateString("pt-BR")}</div>
      </div>` : ""}
      ${p.nfse.codigoVerif ? `
      <div>
        <div style="font-size:8.5pt;color:#888;text-transform:uppercase;margin-bottom:2px;">Código de Verificação</div>
        <div style="font-size:10pt;font-family:monospace;letter-spacing:1px;">${p.nfse.codigoVerif}</div>
      </div>` : ""}
      ${p.nfse.linkNfse ? `
      <div style="display:flex;align-items:flex-end;">
        <a href="${p.nfse.linkNfse}" target="_blank"
           style="display:inline-block;background:#004a5c;color:#fff;text-decoration:none;padding:6px 14px;border-radius:5px;font-size:9pt;font-weight:bold;">
          🔗 Acessar NFS-e no portal da Prefeitura
        </a>
      </div>` : ""}
    </div>
  </div>` : ""}

  <!-- Rodapé -->
  <div class="footer">
    Documento gerado em ${new Date().toLocaleString("pt-BR")} &nbsp;·&nbsp;
    Em caso de dúvidas: ${p.emitente.email || p.emitente.telefone || p.emitente.nome}
  </div>

</div>

<button class="print-btn no-print" onclick="window.print()">Imprimir / Salvar PDF</button>
</body>
</html>`;
}
