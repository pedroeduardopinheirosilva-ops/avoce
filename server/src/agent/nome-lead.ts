/**
 * Sanitização do nome do lead.
 *
 * Motivo: o nome vinha do LLM (ou do pushName do WhatsApp) e era gravado direto em
 * CrmContato.nome / CrmDeal.titulo sem crítica nenhuma. O lead 558299055284 ditou por voz
 * "What the me oftension da Cunha de Maceió" — a extração devolveu "What" e a Isabella
 * passou a conversa inteira chamando ele de "What".
 *
 * Regra: na dúvida, NÃO grava. Um contato como "Lead 5582…" é constrangedor; chamar a pessoa
 * pelo nome errado a conversa toda é pior.
 */

/**
 * Inglês solto é sinal de transcrição quebrada — o Whisper injeta isso quando o áudio está
 * ruim. Um token destes INVALIDA a extração inteira: foi assim que "What the me oftension da
 * Cunha de Maceió" virou um nome.
 */
const RUIDO_EN = new Set([
  "what", "the", "you", "your", "and", "for", "with", "this", "that", "hello", "hey", "thanks",
  "okay", "yes", "please", "sorry", "well", "there", "here", "she", "her", "his", "him", "are",
  "was", "were", "have", "has", "they", "them", "from", "about", "would", "could", "should",
]);

/** Ruído em português e rótulos de pushName: só são ignorados, não invalidam o resto. */
const RUIDO = new Set([
  "oi", "ola", "bom", "boa", "dia", "tarde", "noite", "tudo", "bem", "sim", "nao",
  "obrigado", "obrigada", "por", "favor", "meu", "minha", "nome", "eh", "aqui", "entao",
  "alo", "opa", "blz", "beleza", "certo", "ok", "pois", "eu", "me", "sou", "chamo", "chama",
  "senhor", "senhora", "sr", "sra", "voce", "ele", "ela", "um", "uma", "o", "a", "que", "com",
  // rótulos que aparecem no pushName
  "cliente", "lead", "contato", "whatsapp", "whats", "wpp", "user", "usuario",
  "motorista", "caminhoneiro", "carreteiro", "empresa", "advogado", "advogada", "dr", "dra",
]);

/** Nome plausível: letras (com acento), hífen e apóstrofo. */
const TOKEN_NOME = /^[a-zà-öø-ÿ][a-zà-öø-ÿ'’-]*$/i;

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Devolve o nome tratado, ou `null` quando não dá para confiar.
 *
 * - corta em no máximo 3 tokens (nome + sobrenomes), ignorando preposições
 * - descarta tokens de ruído, números, e-mail, URL e emoji
 * - exige que o primeiro token seja um nome plausível com 2+ letras
 */
export function sanitizeNomeLead(bruto: unknown): string | null {
  if (typeof bruto !== "string") return null;

  const limpo = bruto
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ")  // emoji
    .replace(/\S+@\S+/g, " ")                                          // e-mail
    .replace(/https?:\/\/\S+/gi, " ")                                  // URL
    .replace(/[|/\\_*<>()[\]{}~"“”]+/g, " ")                           // separadores de pushName ("What | 5284", "~Junior")
    .replace(/[.,;:!?]+/g, " ")                                        // pontuação ("oi, sou o Edgar")
    .replace(/\s+/g, " ")
    .trim();
  if (!limpo || limpo.length > 60) return null;

  const PREPOSICOES = new Set(["de", "da", "do", "das", "dos", "e"]);
  const tokens = limpo.split(" ");
  const nome: string[] = [];

  for (const tok of tokens) {
    const norm = normalizar(tok);
    if (!norm) continue;
    if (RUIDO_EN.has(norm)) return null;             // transcrição quebrada — não dá pra confiar
    if (/\d/.test(tok)) break;                       // número → acabou o nome ("Marcell | 7227")
    if (PREPOSICOES.has(norm)) {
      if (nome.length) nome.push(norm);              // preposição só vale entre nomes
      continue;
    }
    if (RUIDO.has(norm)) {
      if (nome.length) break;                        // ruído depois do nome → corta
      continue;                                      // ruído antes → ignora ("oi, meu nome é João")
    }
    if (!TOKEN_NOME.test(tok) || norm.length < 2) break;
    nome.push(tok);
    if (nome.filter(t => !PREPOSICOES.has(normalizar(t))).length >= 3) break;
  }

  while (nome.length && PREPOSICOES.has(normalizar(nome[nome.length - 1]!))) nome.pop();
  if (!nome.length) return null;

  const primeiro = nome[0]!;
  if (normalizar(primeiro).length < 2) return null;

  return nome
    .map(t => (PREPOSICOES.has(normalizar(t)) ? normalizar(t) : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(" ");
}

/** true quando o contato ainda não tem nome de gente (placeholder gerado pelo sistema). */
export function isNomePlaceholder(nome: string | null | undefined): boolean {
  if (!nome) return true;
  return /^lead\b/i.test(nome.trim()) || /^cliente$/i.test(nome.trim());
}
