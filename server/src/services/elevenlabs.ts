/**
 * ElevenLabs TTS service — converts text to Opus audio for WhatsApp PTT
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

const CENTENAS = ["", "cem", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const DEZENAS  = ["", "dez", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const TEENS    = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];

const ORDINAIS_MASC = ["", "primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono", "décimo",
  "décimo primeiro", "décimo segundo", "décimo terceiro", "décimo quarto", "décimo quinto",
  "décimo sexto", "décimo sétimo", "décimo oitavo", "décimo nono", "vigésimo"];
const ORDINAIS_FEM  = ["", "primeira", "segunda", "terceira", "quarta", "quinta", "sexta", "sétima", "oitava", "nona", "décima",
  "décima primeira", "décima segunda", "décima terceira", "décima quarta", "décima quinta",
  "décima sexta", "décima sétima", "décima oitava", "décima nona", "vigésima"];

function numParaExtenso(n: number): string {
  if (n === 0) return "zero";
  if (n < 0) return "menos " + numParaExtenso(-n);
  const partes: string[] = [];
  if (n >= 1000000) {
    const m = Math.floor(n / 1000000);
    partes.push(m === 1 ? "um milhão" : numParaExtenso(m) + " milhões");
    n %= 1000000;
  }
  if (n >= 1000) {
    const mil = Math.floor(n / 1000);
    partes.push(mil === 1 ? "mil" : numParaExtenso(mil) + " mil");
    n %= 1000;
  }
  if (n >= 100) {
    const c = Math.floor(n / 100);
    partes.push(n === 100 ? "cem" : CENTENAS[c]);
    n %= 100;
  }
  if (n >= 20) {
    const d = Math.floor(n / 10), u = n % 10;
    partes.push(u ? DEZENAS[d] + " e " + UNIDADES[u] : DEZENAS[d]);
  } else if (n >= 10) {
    partes.push(TEENS[n - 10]);
  } else if (n > 0) {
    partes.push(UNIDADES[n]);
  }
  return partes.join(" e ");
}

function ordinalMasc(n: number): string {
  return n >= 1 && n < ORDINAIS_MASC.length ? ORDINAIS_MASC[n] : numParaExtenso(n) + "º";
}
function ordinalFem(n: number): string {
  return n >= 1 && n < ORDINAIS_FEM.length ? ORDINAIS_FEM[n] : numParaExtenso(n) + "ª";
}

function moedaParaExtenso(valor: string): string {
  const limpo = valor.replace(/\./g, "").replace(",", ".");
  const num = parseFloat(limpo);
  if (isNaN(num)) return valor;
  const inteiro = Math.floor(num);
  const centavos = Math.round((num - inteiro) * 100);
  let resultado = numParaExtenso(inteiro) + (inteiro === 1 ? " real" : " reais");
  if (centavos > 0) resultado += " e " + numParaExtenso(centavos) + (centavos === 1 ? " centavo" : " centavos");
  return resultado;
}

/**
 * Expands abbreviations and numbers so ElevenLabs reads them naturally in Portuguese.
 * Order matters: specific patterns must run before generic ones.
 */
function normalizarParaTts(text: string): string {
  return text
    // ── Formatação estrutural ─────────────────────────────────────────────────
    // Remove marcadores de lista no início de linhas (-, •, *, ·) → pausa natural
    .replace(/^[\-•*·]\s+/gm, "")
    // Remove linhas só com traços/hifens (separadores visuais)
    .replace(/^[-─═]{2,}\s*$/gm, "")

    // ── Honoríficos e títulos ─────────────────────────────────────────────────
    .replace(/\bDra\.\s*/g, "Doutora ")
    .replace(/\bDr\.\s*/g, "Doutor ")
    .replace(/\bSra\.\s*/g, "Senhora ")
    .replace(/\bSr\.\s*/g, "Senhor ")
    .replace(/\bProfa?\.\s*/g, (m) => (m.startsWith("Profa") ? "Professora " : "Professor "))
    .replace(/\bExmo?\.?\s*Sr\.?\s*/gi, "Excelentíssimo Senhor ")
    .replace(/\bExma?\.?\s*Sra\.?\s*/gi, "Excelentíssima Senhora ")
    .replace(/\bMm\.?\s*/g, "Meritíssimo ")
    .replace(/\bMin\.\s*/g, "Ministro ")
    .replace(/\bDes\.\s*/g, "Desembargador ")

    // ── Símbolos jurídicos ────────────────────────────────────────────────────
    // § N° → parágrafo N | §§ → parágrafos
    .replace(/§§\s*/g, "parágrafos ")
    .replace(/§\s*(\d+)[°º]?\s*/g, (_, n) => `parágrafo ${ordinalMasc(parseInt(n))} `)
    .replace(/§\s*/g, "parágrafo ")
    // Ordinal masculino: 1°, 2°, 3º → primeiro, segundo, terceiro
    .replace(/\b(\d{1,2})[°º]\b/g, (_, n) => ordinalMasc(parseInt(n)))
    // Ordinal feminino: 1ª, 2ª → primeira, segunda
    .replace(/\b(\d{1,2})ª\b/g, (_, n) => ordinalFem(parseInt(n)))

    // ── Abreviações jurídicas com ponto ──────────────────────────────────────
    .replace(/\bnº\.?\s*/gi, "número ")
    .replace(/\bNº\.?\s*/g, "número ")
    .replace(/\bart\.?\s+/gi, "artigo ")                // art. 59 → artigo 59
    .replace(/\bArts\.?\s+/gi, "artigos ")              // Arts. → artigos
    .replace(/\binc\.?\s+/gi, "inciso ")                // inc. I → inciso I
    .replace(/\balín\.?\s+/gi, "alínea ")               // alín. a → alínea a
    .replace(/\bSúm\.?\s+/gi, "Súmula ")               // Súm. 377 → Súmula 377
    .replace(/\bSv\.?\s+/gi, "Súmula Vinculante ")     // SV 33 → Súmula Vinculante 33
    .replace(/\bOJ\s+/g, "Orientação Jurisprudencial ") // OJ 394 → Orientação Jurisprudencial 394
    .replace(/\bp\.ex\.\s*/gi, "por exemplo ")
    .replace(/\bi\.e\.\s*/gi, "isto é ")
    .replace(/\be\.g\.\s*/gi, "por exemplo ")
    .replace(/\betc\.\s*/gi, "etcétera ")
    .replace(/\betc\b/gi, "etcétera")
    .replace(/\bobs\.\s*/gi, "observação: ")
    .replace(/\bresp\.\s*/gi, "respectivamente ")
    .replace(/\bconf\.\s*/gi, "conforme ")
    .replace(/\bproc\.\s*/gi, "processo ")
    .replace(/\bauto?s?\.\s*/gi, "autos ")
    .replace(/\bfl\.\s+(\d)/gi, (_, n) => `folha ${n}`)
    .replace(/\bfls\.\s+/gi, "folhas ")
    .replace(/\bp\.\s*/gi, "página ")                   // p. 10 → página 10
    .replace(/\bpágs?\.\s*/gi, "páginas ")

    // ── Sigla de plataforma judicial (mixed-case — risco real de leitura errada) ──
    .replace(/\bPJe\b/g, "Plataforma Judicial Eletrônica")

    // ── Duração em faixa: 20-30 min → entre vinte e trinta minutos ───────────
    .replace(/\b(\d+)\s*[-–]\s*(\d+)\s*(?:min(?:utos?)?|mn)\b/gi, (_, a, b) =>
      `entre ${numParaExtenso(parseInt(a))} e ${numParaExtenso(parseInt(b))} minutos`)
    // N min → N minutos
    .replace(/\b(\d+)\s*(?:min(?:utos?)?|mn)\b/gi, (_, n) => {
      const v = parseInt(n);
      return numParaExtenso(v) + (v === 1 ? " minuto" : " minutos");
    })

    // ── Moeda ─────────────────────────────────────────────────────────────────
    .replace(/R\$\s*([\d.,]+)/g, (_, val) => moedaParaExtenso(val))

    // ── Horários ─────────────────────────────────────────────────────────────
    // 9h30 → nove horas e trinta minutos | 14h00 → quatorze horas
    .replace(/\b(\d{1,2})h(\d{2})\b/g, (_, h, m) => {
      const hNum = parseInt(h);
      const hStr = numParaExtenso(hNum) + (hNum === 1 ? " hora" : " horas");
      const min = parseInt(m);
      return min > 0 ? hStr + " e " + numParaExtenso(min) + (min === 1 ? " minuto" : " minutos") : hStr;
    })
    // 5h → cinco horas | 0h → zero horas
    .replace(/\b(\d{1,2})h\b/g, (_, h) => {
      const hNum = parseInt(h);
      return numParaExtenso(hNum) + (hNum === 1 ? " hora" : " horas");
    })

    // ── Percentuais ───────────────────────────────────────────────────────────
    .replace(/(\d+(?:,\d+)?)\s*%/g, (_, n) => {
      const num = parseFloat(n.replace(",", "."));
      return numParaExtenso(Math.floor(num)) + " por cento";
    })

    // ── Números grandes com ponto separador de milhar ─────────────────────────
    // Protege CPF (XXX.XXX.XXX-XX) e CNPJ — não expande; apenas números puros tipo 80.000
    .replace(/\b(\d{1,3})\.(\d{3})\b(?![-.\d])/g, (_, a, b) =>
      numParaExtenso(parseInt(a) * 1000 + parseInt(b)))

    // ── Limpeza final ─────────────────────────────────────────────────────────
    // Colapsa múltiplos espaços gerados pelas substituições
    .replace(/  +/g, " ")
    .trim();
}

/**
 * Strips WhatsApp/persona formatting from text before sending to TTS.
 * Removes: *NomePersona*\n prefix, **bold**, *italic*, _underline_
 */
function cleanTextForTts(text: string): string {
  return normalizarParaTts(
    text
      .replace(/^\*[^*\n]+\*\n/, "")     // Remove *NomePersona*\n prefix
      .replace(/\*\*([^*]+)\*\*/g, "$1") // **bold** → plain
      .replace(/\*([^*]+)\*/g, "$1")     // *bold* → plain
      .replace(/_([^_]+)_/g, "$1")       // _italic_ → plain
      .replace(/~([^~]+)~/g, "$1")       // ~strike~ → plain
      .trim()
  );
}

/**
 * Converts text to OGG Opus audio via ElevenLabs TTS.
 * Returns a Buffer suitable for sendWhatsAppAudio (base64 encoding).
 * Throws on API failure.
 */
export async function textToSpeech(
  apiKey: string,
  voiceId: string,
  text: string,
  model = "eleven_multilingual_v2",
): Promise<Buffer> {
  const clean = cleanTextForTts(text);

  // ElevenLabs limit is ~5000 chars; truncate gracefully
  const safeText = clean.length > 4900 ? clean.slice(0, 4900) + "..." : clean;

  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}?output_format=opus_48000_128`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: safeText,
      model_id: model,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ElevenLabs TTS failed: ${res.status} ${body}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
