// ─────────────────────────────────────────────────────────────────────────────
// Boleto Bancário Sicoob — layout fiel ao modelo FEBRABAN/CNAB 240 Sicoob
// ─────────────────────────────────────────────────────────────────────────────

export interface BoletoHtmlParams {
  beneficiario: {
    nome:            string;
    cnpj:            string;
    endereco?:       string;
    numero?:         string;
    complemento?:    string;
    bairro?:         string;
    cidade?:         string;
    uf?:             string;
    cep?:            string;
    cooperativa:     string;   // ex: "3226"
    codBeneficiario: string;   // ex: "161756"
    carteira:        string;   // ex: "1"
    logoBase64?:     string;
    sicoobLogo?:     string;
  };
  pagador: {
    nome:      string;
    cpfCnpj:   string;
    endereco?: string;
    bairro?:   string;
    cidade?:   string;
    uf?:       string;
    cep?:      string;
  };
  nossoNumero:       number;
  linhaDigitavel:    string;
  codigoBarras:      string;
  valor:             number;    // centavos
  vencimento:        string;    // YYYY-MM-DD
  dataEmissao:       string;    // YYYY-MM-DD
  dataProcessamento: string;    // YYYY-MM-DD
  nroDocumento:      string;
  instrucoes?:       string[];
}

function fmt(c: number): string {
  return (c / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2 });
}
function fmtD(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function fmtDoc(v: string): string {
  const d = v.replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
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
  // Start: NNNN
  bars.push({ w: N, b: true }, { w: N, b: false }, { w: N, b: true }, { w: N, b: false });
  // Data
  for (let i = 0; i < s.length; i += 2) {
    const bEnc = enc[s[i]], sEnc = enc[s[i + 1]];
    if (!bEnc || !sEnc) continue;
    for (let j = 0; j < 5; j++) {
      bars.push({ w: bEnc[j] === "w" ? W : N, b: true });
      bars.push({ w: sEnc[j] === "w" ? W : N, b: false });
    }
  }
  // Stop: WNN
  bars.push({ w: W, b: true }, { w: N, b: false }, { w: N, b: true });

  const totalW = bars.reduce((acc, b) => acc + b.w, 0) + QZ * 2;
  let x = QZ;
  let rects = "";
  for (const b of bars) {
    if (b.b) rects += `<rect x="${x}" y="0" width="${b.w}" height="${H}"/>`;
    x += b.w;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 ${totalW} ${H}"
    width="${totalW}" height="${H}"
    style="display:block;width:100%;height:auto;fill:#000;"
    preserveAspectRatio="none"
  >${rects}</svg>`;
}

// ── Helper: célula com label + valor ─────────────────────────────────────────
const LBL = (t: string) => `<div class="lbl">${t}</div>`;
const VAL = (t: string, bold = false) =>
  `<div class="val${bold ? " vbold" : ""}">${t || "&nbsp;"}</div>`;

export function gerarBoletoHtml(p: BoletoHtmlParams): string {
  const venc      = fmtD(p.vencimento);
  const dtEmis    = fmtD(p.dataEmissao);
  const dtProc    = fmtD(p.dataProcessamento);
  const coopCod   = `${p.beneficiario.cooperativa}/${p.beneficiario.codBeneficiario}`;
  const nossoNum  = `${p.nossoNumero}-${p.beneficiario.carteira}`;
  const instrucoes = p.instrucoes ?? [
    "Não receber após 30 dias do vencimento.",
    "Após vencimento cobrar multa de 2% + juros de 0,033% ao dia.",
  ];

  const logo = p.beneficiario.sicoobLogo
    ? `<img src="${p.beneficiario.sicoobLogo}" style="display:block;height:44px;width:auto;" alt="Sicoob">`
    : `<span style="font-size:24pt;font-weight:900;color:#00833e;font-style:italic;">&#9650; SICOOB</span>`;

  const benefLine2 = [
    [p.beneficiario.endereco, p.beneficiario.numero, p.beneficiario.complemento].filter(Boolean).join(", "),
    p.beneficiario.bairro,
    p.beneficiario.cidade
      ? `${p.beneficiario.cidade}${p.beneficiario.uf ? ` - ${p.beneficiario.uf}` : ""}${p.beneficiario.cep ? `    CEP ${p.beneficiario.cep.replace(/^(\d{5})(\d{3})$/, "$1-$2")}` : ""}`
      : "",
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Boleto Sicoob</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:Arial,Helvetica,sans-serif;font-size:9pt;color:#000;background:#fff;}
  .page{width:210mm;margin:0 auto;padding:8mm 10mm 6mm;}
  table{width:100%;border-collapse:collapse;}
  td{vertical-align:top;}
  .lbl{font-size:6.5pt;color:#444;margin-bottom:1px;}
  .val{font-size:8.5pt;}
  .vbold{font-size:9pt;font-weight:bold;}
  .vlarge{font-size:11pt;font-weight:bold;}
  .B{border:1px solid #aaa;}
  .p{padding:3px 5px;}
  .tr{text-align:right;}
  .instrbox{font-size:8pt;line-height:1.55;}
  .corte{border-top:1px dashed #888;margin:7px 0;text-align:center;font-size:7pt;color:#888;padding-top:2px;}
  .autent{display:flex;justify-content:space-between;align-items:center;border:1px solid #aaa;
          background:#efefef;padding:5px 8px;font-size:7.5pt;margin-top:4px;}
  .hdr-ficha{display:flex;align-items:stretch;border:1px solid #aaa;border-bottom:0;}
  .hdr-logo{padding:6px 12px;border-right:3px solid #000;display:flex;align-items:center;}
  .hdr-cod{padding:4px 14px;border-right:3px solid #000;display:flex;align-items:center;
           font-size:22pt;font-weight:900;white-space:nowrap;}
  .hdr-linha{flex:1;padding:4px 10px;display:flex;align-items:center;justify-content:flex-end;
             font-family:monospace;font-size:9pt;font-weight:bold;letter-spacing:0;
             white-space:nowrap;overflow:hidden;}
  @media print{body{margin:0;}.no-print{display:none!important;}}
  .print-btn{position:fixed;bottom:20px;right:20px;background:#004a5c;color:#fff;border:none;
             padding:10px 22px;border-radius:8px;cursor:pointer;font-size:13px;
             box-shadow:0 2px 8px rgba(0,0,0,.3);}
</style>
</head>
<body>
<div class="page">

<!-- ════════════════ RECIBO DO PAGADOR ════════════════ -->
<div style="padding:6px 0 8px;">
  ${logo}
</div>

<table>
  <!-- 3 colunas: 65% beneficiário/instruções | 17.5% | 17.5% -->
  <colgroup>
    <col style="width:65%">
    <col style="width:17.5%">
    <col style="width:17.5%">
  </colgroup>

  <!-- Linha 1-3: Beneficiário (rowspan=3) | Vencimento | Valor doc -->
  <tr>
    <td rowspan="3" class="B p" style="vertical-align:top;">
      ${LBL("Beneficiário")}
      <div style="font-size:9pt;font-weight:bold;margin:2px 0;">
        ${p.beneficiario.nome} &nbsp;&nbsp; ${fmtDoc(p.beneficiario.cnpj)}
      </div>
      ${benefLine2.map(l => `<div style="font-size:8.5pt;">${l}</div>`).join("")}
    </td>
    <td class="B p">${LBL("Vencimento")}<div class="vlarge">${venc}</div></td>
    <td class="B p tr">${LBL("Valor do Documento")}<div class="vlarge">${fmt(p.valor)}</div></td>
  </tr>
  <tr>
    <td class="B p">${LBL("(+) Outros acréscimos")}${VAL("")}</td>
    <td class="B p">${LBL("(+) Mora / Multa")}${VAL("")}</td>
  </tr>
  <tr>
    <td class="B p">${LBL("(-) Desconto / Abatimento")}${VAL("")}</td>
    <td class="B p">${LBL("(-) Outras deduções")}${VAL("")}</td>
  </tr>

  <!-- Linha 4-6: Instruções (rowspan=3) | Data emissão | (=) Valor cobrado -->
  <tr>
    <td rowspan="3" class="B p" style="vertical-align:top;">
      ${LBL("Instruções (texto de responsabilidade do beneficiário)")}
      <div class="instrbox" style="margin-top:3px;">
        ${instrucoes.map(i => `<div>${i}</div>`).join("")}
      </div>
    </td>
    <td class="B p">${LBL("Data de Emissão")}${VAL(dtEmis)}</td>
    <td class="B p">${LBL("(=) Valor cobrado")}${VAL("")}</td>
  </tr>
  <tr>
    <td colspan="2" class="B p">
      ${LBL("Coop Contr/Cód. Beneficiário")}
      <div class="vlarge" style="text-align:right;">${coopCod}</div>
    </td>
  </tr>
  <tr>
    <td colspan="2" class="B p">
      ${LBL("Nosso Número")}
      <div class="vlarge" style="text-align:right;">${nossoNum}</div>
    </td>
  </tr>
</table>

<!-- Dados do Pagador -->
<div style="font-size:7.5pt;font-weight:bold;color:#333;margin:7px 0 2px;">Dados do Pagador</div>
<table>
  <tr>
    <td class="B p" style="width:72%;">${LBL("Nome do pagador")}<div class="vbold">${p.pagador.nome}</div></td>
    <td class="B p tr">${LBL("Número do Documento")}<div class="vbold">${p.nroDocumento}</div></td>
  </tr>
  <tr>
    <td colspan="2" class="B p">${LBL("Endereço")}<div class="val">${p.pagador.endereco || "&nbsp;"}</div></td>
  </tr>
  <tr>
    <td colspan="2" class="B p">${LBL("Bairro / Distrito")}<div class="val">${p.pagador.bairro || "&nbsp;"}</div></td>
  </tr>
  <tr>
    <td class="B p" style="width:60%;">${LBL("Município")}<div class="val">${p.pagador.cidade || "&nbsp;"}</div></td>
    <td class="B p" style="width:8%;text-align:center;">${LBL("UF")}<div class="val">${p.pagador.uf || "&nbsp;"}</div></td>
    <td class="B p tr">${LBL("CEP")}<div class="val">${p.pagador.cep || "&nbsp;"}</div></td>
  </tr>
  <tr>
    <td colspan="3" class="B p" style="height:26px;">${LBL("Mensagem Pagador")}</td>
  </tr>
</table>

<div class="autent">
  <span style="max-width:56%;line-height:1.5;font-size:7.5pt;">
    Este recibo somente terá validade com a autenticação mecânica ou acompanhado do recibo de
    pagamento emitido pelo Banco. Recebimento através do cheque n.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;do banco
    Esta quitação só terá validade após o pagamento do cheque pelo banco pagador.
  </span>
  <span style="font-size:8pt;">Autenticação mecânica &nbsp;–&nbsp; Recibo do pagador</span>
</div>

<!-- Linha de corte -->
<div class="corte">✂ ─────────────────────────────────────────────────────────────────────────</div>

<!-- ════════════════ FICHA DE COMPENSAÇÃO ════════════════ -->
<div class="hdr-ficha">
  <div class="hdr-logo">${logo}</div>
  <div class="hdr-cod">756</div>
  <div class="hdr-linha">${p.linhaDigitavel}</div>
</div>

<table>
  <colgroup>
    <col style="width:73%">
    <col style="width:27%">
  </colgroup>

  <!-- Local de pagamento | Vencimento -->
  <tr>
    <td class="B p">${LBL("Local de pagamento")}<div class="vbold">PAGAVEL PREFERENCIALMENTE NO SICOOB</div></td>
    <td class="B p tr">${LBL("Vencimento")}<div class="vlarge">${venc}</div></td>
  </tr>

  <!-- Beneficiário | Coop/Cód Beneficiário -->
  <tr>
    <td class="B p">
      ${LBL("Beneficiário")}
      <div class="vbold">${p.beneficiario.nome} &nbsp;&nbsp; ${fmtDoc(p.beneficiario.cnpj)}</div>
    </td>
    <td class="B p tr">
      ${LBL("Cooperativa contratante/Cód. Beneficiário")}
      <div class="vbold">${coopCod}</div>
    </td>
  </tr>

  <!-- Data doc | N. doc | Espécie | Aceite | Dt processamento  ||  Nosso número -->
  <tr>
    <td style="padding:0;">
      <table>
        <tr>
          <td class="B p" style="width:20%;">${LBL("Data do documento")}${VAL(dtEmis)}</td>
          <td class="B p" style="width:25%;">${LBL("N. documento")}${VAL(p.nroDocumento)}</td>
          <td class="B p" style="width:15%;text-align:center;">${LBL("Espécie")}${VAL("DM")}</td>
          <td class="B p" style="width:12%;text-align:center;">${LBL("Aceite")}${VAL("N")}</td>
          <td class="B p">${LBL("Data processamento")}${VAL(dtProc)}</td>
        </tr>
      </table>
    </td>
    <td class="B p tr">${LBL("Nosso número")}<div class="vlarge">${nossoNum}</div></td>
  </tr>

  <!-- Uso banco | Carteira | Espécie | Quantidade | Valor  ||  Valor documento -->
  <tr>
    <td style="padding:0;">
      <table>
        <tr>
          <td class="B p" style="width:25%;">${LBL("Uso do Banco")}${VAL("")}</td>
          <td class="B p" style="width:15%;text-align:center;">${LBL("Carteira")}${VAL(p.beneficiario.carteira)}</td>
          <td class="B p" style="width:15%;text-align:center;">${LBL("Espécie")}${VAL("R$")}</td>
          <td class="B p" style="width:20%;">${LBL("Quantidade")}${VAL("0,00")}</td>
          <td class="B p">${LBL("Valor")}${VAL("")}</td>
        </tr>
      </table>
    </td>
    <td class="B p tr">${LBL("Valor documento")}<div class="vlarge">${fmt(p.valor)}</div></td>
  </tr>

  <!-- Instruções (tall) | boxes: Desconto, Deduções, Mora, Acréscimos, Valor cobrado -->
  <tr>
    <td class="B p" style="vertical-align:top;">
      ${LBL("Instruções (texto de responsabilidade do beneficiário)")}
      <div class="instrbox" style="margin-top:3px;">
        ${instrucoes.map(i => `<div>${i}</div>`).join("")}
      </div>
      <div style="font-size:6.5pt;color:#555;margin-top:10px;line-height:1.5;">
        EMITIDO PELA COOPERATIVA CONTRATANTE SEM RESPONSABILIDADE DO BANCOOB<br>
        COOPERATIVA CONTRATANTE ${p.beneficiario.cooperativa} SICOOB
      </div>
    </td>
    <td style="padding:0;">
      <table>
        <tr><td class="B p" style="height:28px;">${LBL("(-) Desconto / Abatimento")}${VAL("")}</td></tr>
        <tr><td class="B p" style="height:28px;">${LBL("(-) Outras deduções")}${VAL("")}</td></tr>
        <tr><td class="B p" style="height:28px;">${LBL("(+) Mora / Multa")}${VAL("")}</td></tr>
        <tr><td class="B p" style="height:28px;">${LBL("(+) Outros acréscimos")}${VAL("")}</td></tr>
        <tr><td class="B p" style="height:36px;">${LBL("(=) Valor cobrado")}<div class="vbold">&nbsp;</div></td></tr>
      </table>
    </td>
  </tr>

  <!-- Pagador -->
  <tr>
    <td colspan="2" class="B p">
      ${LBL("Pagador")}
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <b style="font-size:8.5pt;">${p.pagador.nome}</b>
        <span style="font-size:8.5pt;">${fmtDoc(p.pagador.cpfCnpj)}</span>
      </div>
      ${p.pagador.endereco ? `<div style="font-size:8.5pt;">${p.pagador.endereco}</div>` : ""}
      ${p.pagador.bairro   ? `<div style="font-size:8.5pt;">${p.pagador.bairro}</div>` : ""}
      ${p.pagador.cidade   ? `<div style="font-size:8.5pt;">${p.pagador.cidade}${p.pagador.uf ? ` - ${p.pagador.uf}` : ""}${p.pagador.cep ? `    ${p.pagador.cep}` : ""}</div>` : ""}
    </td>
  </tr>

  <!-- Beneficiário Final | Autenticação -->
  <tr>
    <td class="B p">
      <span class="lbl">Beneficiário Final</span> &nbsp;
      <b style="font-size:8.5pt;">${p.beneficiario.nome}</b> &nbsp;&nbsp;
      <span style="font-size:8.5pt;">${fmtDoc(p.beneficiario.cnpj)}</span>
    </td>
    <td class="B p tr" style="font-size:7.5pt;vertical-align:bottom;">
      Autenticação mecânica – Ficha de compensação
    </td>
  </tr>
</table>

<!-- Código de Barras -->
<div style="margin-top:6px;overflow:hidden;">
  ${barcodesvg(p.codigoBarras)}
</div>

</div>
<button class="print-btn no-print" onclick="window.print()">Imprimir / Salvar PDF</button>
</body>
</html>`;
}
