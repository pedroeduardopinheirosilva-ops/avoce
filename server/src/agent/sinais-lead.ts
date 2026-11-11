/**
 * Sinais determinísticos do lead — detectores por regex, sem LLM.
 *
 * Existem porque a extração por LLM (`extractQualificacaoData`) só preenche campos
 * AINDA NULOS: uma vez que `acao_em_andamento` foi gravado como `false` na primeira
 * resposta, o campo nunca mais é reavaliado, mesmo que o lead diga depois "eu já
 * tenho ação contra eles" (caso Ledison 558291763487, 26/08 12:09).
 *
 * Também centralizam o reconhecimento de placeholders de empresa ("não identificada"),
 * que o LLM às vezes devolve como se fosse o nome real e vazavam para o WhatsApp do
 * cliente ("Na não identificada você tinha carteira assinada...").
 */

export function normalizarSinal(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// ── Empresa: placeholders que NÃO são nome de empresa ─────────────────────────

const EMPRESA_PLACEHOLDER_RE =
  /^(nao\s+((identificad|informad|especificad|declarad|mencionad|citad|dit|lembrad|revelad|fornecid)[ao]|lembr[ao]u?|sei|disse)|desconhecid[ao]|sem\s+nome|empresa\s+(anterior|atual|nao\s+identificada)|n\/?a|null|undefined|\?+|-+)$/;

/** true quando o "nome" é um placeholder do LLM e não pode ir para o texto ao cliente. */
export function isEmpresaPlaceholder(nome: string | null | undefined): boolean {
  if (nome == null) return true;
  const n = normalizarSinal(String(nome)).trim().replace(/[.!]+$/, "");
  if (n.length === 0) return true;
  return EMPRESA_PLACEHOLDER_RE.test(n);
}

/** Devolve o nome da empresa ou `undefined` quando é placeholder/vazio. */
export function limparEmpresaPlaceholder(nome: string | null | undefined): string | undefined {
  return isEmpresaPlaceholder(nome) ? undefined : String(nome).trim();
}

// ── Ação trabalhista já em andamento ──────────────────────────────────────────

// Só PRIMEIRA PESSOA e com o substantivo colado ao verbo. A versão anterior aceitava "tem"/"tinha"
// e até 30 caracteres de permeio: "ele tem advogado", "tem como falar com advogado" e
// "temos que ter direito de advogado" viravam ação em andamento.
const ACAO_RE =
  /\b(j[áa]\s+)?(tenho|possuo|entrei\s+com|movi|ajuizei|abri|coloquei|botei)\s+(?:(?:j[áa]|sim|a[íi]|l[áa]|uma?|o|a|meu|minha|outr[oa]|alguma?)\s+){0,3}(a[çc][ãa]o|reclamat[óo]ria|advogad[oa])\b/g;
// "processo" sozinho é ambíguo no vocabulário do carreteiro ("processo de transporte",
// "processo de carregamento") — só conta com qualificador jurídico colado.
const ACAO_PROCESSO_RE =
  /\bprocesso\b[^.!?]{0,25}\b(trabalhista|judicial|contra\s+(a|o|eles|ela|essa|esse)|na\s+justi[çc]a|no\s+f[óo]rum|em\s+andamento|corr?endo|protocolad[ao])\b/g;
const ACAO_RE_ALT =
  /\b(a[çc][ãa]o|reclamat[óo]ria)\b[^.!?]{0,20}\b(em\s+andamento|corr?endo|na\s+justi[çc]a|no\s+f[óo]rum|protocolad[ao])\b/g;

/** Palavras que, imediatamente antes do gatilho, invertem o sentido (negação ou intenção futura). */
const ANTI_ACAO_RE =
  /\b(nao|nunca|jamais|nenhum[a]?|quero|queria|gostaria|pretendo|penso|vou|iria|posso|poderia|como|preciso|se\s+eu)\b/;

/**
 * Devolve o trecho da mensagem que afirma existir ação/advogado, ou null.
 * Serve tanto ao detector quanto à auditoria do backfill (mostra o que casou).
 */
export function trechoAcaoEmAndamento(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = normalizarSinal(text);
  for (const re of [ACAO_RE, ACAO_PROCESSO_RE, ACAO_RE_ALT]) {
    // TODAS as ocorrências, não só a primeira: numa mesma mensagem o lead nega e depois
    // afirma ("ainda não movi a ação... eu já tenho ação contra a Jaméf") — parar na
    // primeira, negada, engolia a afirmação (caso Robson 553195847242).
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      // Janela curta antes do gatilho: pega "nao tenho ação" e "quero entrar com uma ação".
      const antes = t.slice(Math.max(0, m.index - 28), m.index + (m[1]?.length ?? 0));
      if (ANTI_ACAO_RE.test(antes)) continue;
      // Trecho recortado do texto NORMALIZADO: a normalização NFD muda o comprimento,
      // então índices daqui não valem no original — sem acento, mas alinhado.
      return t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim();
    }
  }
  return null;
}

/**
 * true quando o lead afirma que JÁ existe ação/advogado — não quando nega
 * ("não tenho ação") nem quando manifesta intenção futura ("quero entrar com uma ação").
 */
export function detectaAcaoEmAndamento(text: string | null | undefined): boolean {
  return trechoAcaoEmAndamento(text) !== null;
}

// ── Confirmação de ação/advogado: só resposta à pergunta direta dispensa o lead ─────
//
// O gate de ética encerra o atendimento, então não pode depender de menção solta. José Olívio
// (09/11) contou que o PATRÃO disse "eu tenho advogado pra isso" e foi dispensado na hora.

const PERGUNTA_ACAO_RE = /\b(tem|tenha|possui)\b[^?]{0,60}\b(advogad[oa]|acao|processo)\b[^?]*\?/;
const RESPOSTA_NEGA_RE = /^\W*(?:nao|n|nunca|nenhum\w*|negativo|tenho\s+nao|tem\s+nao)\b/;
const RESPOSTA_AFIRMA_RE = /^\W*(?:sim|s|tenho|tem\s+sim|isso|claro|positivo|uhum|aham|correto|exato)\b/;
const NEGA_ADVOGADO_RE = /\b(?:nao|nenhum)\s+(?:tem|tenho|existe|ha|possuo)\s+(?:nenhum\s+|um\s+|o\s+)?advogad[oa]\b/;
const DISPENSA_ETICA_RE = /(?:etica|existe\s+um\s+advogado\s+cuidando|ja\s+tem\s+um\s+advogado\s+cuidando).{0,80}|nao\s+podemos\s+assumir/;

/** true se alguma das últimas mensagens da IA perguntou diretamente sobre ação/advogado. */
export function iaPerguntouAcaoOuAdvogado(saidasIa: Array<string | null | undefined>): boolean {
  return saidasIa.some(m => !!m && PERGUNTA_ACAO_RE.test(normalizarSinal(m)));
}

/** true quando a resposta da IA é a dispensa "por ética, já existe advogado". */
export function isDispensaPorAdvogado(resposta: string | null | undefined): boolean {
  return !!resposta && DISPENSA_ETICA_RE.test(normalizarSinal(resposta));
}

export type DecisaoAcaoEmAndamento = "manter" | "confirmar" | "suspeita" | "negou";

/**
 * Decide o que fazer com `acao_em_andamento` neste turno.
 * - confirmar: a IA perguntou e o lead afirmou. Só este caso pode acionar o gate.
 * - suspeita: há menção ou extração sem pergunta direta; a IA precisa perguntar.
 * - negou: o lead desmentiu um registro anterior ("não tem advogado nenhum").
 */
export function decidirAcaoEmAndamento(input: {
  valorAtual: unknown;
  confirmada: boolean;
  texto: string | null | undefined;
  saidasIa: Array<string | null | undefined>;
}): DecisaoAcaoEmAndamento {
  const t = normalizarSinal(input.texto ?? "");
  if (input.valorAtual === true && NEGA_ADVOGADO_RE.test(t)) return "negou";
  if (input.confirmada) return "manter";
  const extraido = input.valorAtual === true;
  const afirma = detectaAcaoEmAndamento(input.texto);
  if (!extraido && !afirma) return "manter";
  if (!iaPerguntouAcaoOuAdvogado(input.saidasIa)) return "suspeita";
  if (RESPOSTA_NEGA_RE.test(t)) return "suspeita";
  return RESPOSTA_AFIRMA_RE.test(t) || afirma ? "confirmar" : "suspeita";
}

// ── Pedido explícito de contato / intenção de seguir ──────────────────────────

const PEDIDO_CONTATO_RE =
  /\b(me\s+lig[ae]|pode(m)?\s+ligar|podem?\s+me\s+ligar|ligar?\s+(pra|para)\s+mim|liga\s+(pra|para)\s+mim|ligue[m]?\s+(pra|para)\s+mim|quero\s+(uma\s+)?liga[çc][ãa]o|prefiro\s+falar\s+por\s+telefone|me\s+chama\s+no\s+telefone|pode\s+me\s+chamar)\b/g;

const QUER_SEGUIR_RE =
  /\b(quero\s+(sim|seguir|contratar|entrar\s+com|prosseguir|fechar|come[çc]ar)|vamos\s+(seguir|em\s+frente|fechar|entrar\s+com)|pode\s+(seguir|prosseguir|dar\s+andamento)|aceito)\b/g;

const ANTI_INTENCAO_RE = /\b(nao|ainda\s+nao|depois|talvez|nao\s+quero|deixa\s+pra)\b/;

/**
 * true quando o lead pede contato/ligação ou declara que quer seguir com a ação.
 * Sinal de compra: a fila de perguntas não pode atropelar isso.
 */
export function detectaPedidoContato(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = normalizarSinal(text);
  for (const re of [PEDIDO_CONTATO_RE, QUER_SEGUIR_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const antes = t.slice(Math.max(0, m.index - 18), m.index);
      if (ANTI_INTENCAO_RE.test(antes)) continue;
      return true;
    }
  }
  return false;
}

// ── Advogado da parte contrária (não é lead) ──────────────────────────────────
//
// Advogado de empresa/reclamada que escreve para tratar de acordo se APRESENTA como advogado
// ("Sou advogada da Transportes Framento, com quem poderia falar a respeito de acordo",
// Alexia 30/10). O motorista também fala "advogado", "escritório" e "processo" o tempo
// todo ("procurei até uma advogada daqui", "o advogado da empresa me ligou") — por isso só
// vale a AUTO-apresentação, a OAB com número ou quem diz representar a empresa.

const ADV_AUTO_RE = [
  // "sou advogada", "sou o advogado", "sou a Dra.", "sou o doutor Fulano"
  /\bsou\s+(?:o\s+|a\s+)?(?:advogad[oa]|dr\.?|dra\.?|doutor[a]?)(?=[\s,.!:;]|$)/,
  // "aqui é a Dra. Ana", "meu nome é Fulano, advogado da…", "me chamo X, advogada"
  /\b(?:aqui\s+(?:e|eh|quem\s+fala\s+e)|meu\s+nome\s+e|me\s+chamo|falo\s+com\s+voce[s]?\s+como)\b[^.!?\n]{0,50}?\b(?:advogad[oa]|dr\.?|dra\.?|doutor[a]?)(?=[\s,.!:;]|$)/,
  // "represento a empresa", "falo em nome da empresa", "patrono da reclamada", "preposto da"
  /\b(?:represento|representamos|falo\s+em\s+nome\s+d[ao]|falamos\s+em\s+nome\s+d[ao]|patron[oa]\s+d[ao]|prepost[oa]\s+d[ao]|escritorio\s+que\s+represent[ao])\b/,
  // OAB com número: "OAB/SC 12.345", "OAB nº 98765", "OAB-BA 1234"
  /\boab\s*[\/\-]?\s*(?:[a-z]{2}\b\s*)?(?:n[oº°.]*\s*)?\d[\d.]{2,}/,
];
/** Próprio escritório (RAP / Pinheiro Silva) se apresentando — não é contraparte. */
const ADV_PROPRIO_RE = /\b(rap|pinheiro|daniela\s+pires|dra\.?\s+daniela)\b/;
const NEGACAO_ANTES_RE = /\b(nao|nunca|nem)\s*$/;
const CNJ_RE = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;

/** Trecho em que o remetente se apresenta como advogado/representante da outra parte, ou null. */
export function trechoAdvogadoContraparte(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = normalizarSinal(text);
  for (const re of ADV_AUTO_RE) {
    const m = re.exec(t);
    if (!m) continue;
    if (NEGACAO_ANTES_RE.test(t.slice(Math.max(0, m.index - 12), m.index))) continue;
    const contexto = t.slice(m.index, m.index + m[0].length + 60);
    if (ADV_PROPRIO_RE.test(contexto)) continue;
    return text.slice(m.index, Math.min(text.length, m.index + m[0].length + 80)).trim();
  }
  return null;
}

export function detectaAdvogadoContraparte(text: string | null | undefined): boolean {
  return trechoAdvogadoContraparte(text) !== null;
}

/** Número de processo no padrão CNJ, se houver na mensagem. */
export function numeroProcessoCnj(text: string | null | undefined): string | null {
  return text ? CNJ_RE.exec(text)?.[0] ?? null : null;
}
