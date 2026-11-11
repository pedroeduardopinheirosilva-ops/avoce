/**
 * Guard contra reperguntar o que o lead já respondeu.
 *
 * Casos reais (18/08):
 *  - Carlos 5521995367039 levou "Você já tem advogado cuidando desse caso?" 4× em 7 minutos e
 *    respondeu todas; no áudio ele reclama: "já falei nos outros áudios que não tenho advogado".
 *  - Keylla 553298491459 levou "qual era sua função" duas vezes no mesmo minuto.
 *
 * Por que o contador que já existia não pegou: `_last_dq` guarda só o ÚLTIMO step perguntado, e
 * `acao_andamento_rec` (fase vinculos_recente) e `acao_andamento_ant` (fase vinculos_anterior)
 * fazem a MESMA pergunta em fases diferentes. Alternando entre os dois, a contagem zerava sempre.
 *
 * Aqui a checagem é sobre o texto de fato enviado, então cobre qualquer origem — passo
 * determinístico, variante de outra fase, ou pergunta gerada pelo LLM.
 */

import { prisma } from "../db.js";

/** Quantas mensagens enviadas olhar para trás. */
const JANELA_OUT = 12;

/** Assinatura semântica da pergunta: o que ela pergunta, ignorando como foi escrita. */
export function assinaturaPergunta(texto: string): string {
  const norm = texto
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\*[^*]*\*/g, " ")            // "*Isabella*"
    .replace(/\{\{?[a-z_]+\}?\}/g, " ")    // placeholders não substituídos
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Palavras vazias e nomes de empresa mudam entre as variantes ("função lá" × "função na Eureka").
  const VAZIAS = new Set([
    "voce", "vc", "o", "a", "os", "as", "um", "uma", "de", "da", "do", "das", "dos", "e", "ou",
    "que", "qual", "quais", "era", "eram", "e", "eh", "sobre", "esse", "essa", "esses", "isso",
    "seu", "sua", "seus", "suas", "me", "meu", "minha", "la", "ai", "aqui", "no", "na", "nos",
    "nas", "em", "para", "pra", "por", "com", "ja", "tem", "teve", "ter", "foi", "sao", "nome",
    "agora", "entao", "mas", "se", "como", "quando", "onde", "quanto", "quantos", "quantas",
  ]);

  const tokens = norm.split(" ").filter(t => t.length > 2 && !VAZIAS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

/** Duas perguntas são "a mesma" quando compartilham a maior parte dos termos significativos. */
export function mesmaPergunta(a: string, b: string): boolean {
  const ta = new Set(assinaturaPergunta(a).split(" ").filter(Boolean));
  const tb = new Set(assinaturaPergunta(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return false;

  let comuns = 0;
  for (const t of ta) if (tb.has(t)) comuns++;
  const menor = Math.min(ta.size, tb.size);
  // Exige sobreposição alta sobre o conjunto menor — "advogado acao andamento emprego" ×
  // "advogado acao andamento cuidando caso emprego" bate; perguntas diferentes não.
  return comuns / menor >= 0.75;
}

export interface MsgHist {
  direcao: string;
  conteudo: string | null;
  transcricao?: string | null;
  enviadaEm: Date;
  evolutionMessageId?: string | null;
}

/**
 * Mensagem do lead que chega até esse tempo depois da pergunta foi escrita ANTES de ele ler a
 * pergunta — não é resposta a ela. Caso Cigano 04/11: "Mas de 200" repetido chegou no mesmo
 * segundo em que saiu "Antes de trabalhar lá, você trabalhou em outro lugar?", o guard achou
 * que a pergunta estava respondida, pulou o passo mais_empregos e a coleta fechou sem a Tombini.
 */
export const GRACA_RESPOSTA_MS = 3_000;
/** Janela em que o mesmo texto do lead, enviado de novo, é considerado repetição (reenvio). */
export const JANELA_REPETICAO_LEAD_MS = 20_000;

function textoMsg(m: MsgHist): string {
  return (m.conteudo ?? m.transcricao ?? "").trim();
}

export function normalizarMsgLead(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * O lead respondeu à pergunta `anterior`? Conta só mensagem que chegou depois da janela de graça
 * e que não é reenvio de algo que ele já tinha mandado logo antes da pergunta.
 */
export function leadRespondeuDepois(historico: MsgHist[], anterior: MsgHist): boolean {
  const t0 = anterior.enviadaEm.getTime();
  const jaDitas = new Set(
    historico
      .filter(m => m.direcao === "in" && m.enviadaEm.getTime() <= t0 && t0 - m.enviadaEm.getTime() <= 60_000)
      .map(m => normalizarMsgLead(textoMsg(m))),
  );
  return historico.some(m =>
    m.direcao === "in" &&
    m.enviadaEm.getTime() > t0 + GRACA_RESPOSTA_MS &&
    textoMsg(m).length > 0 &&
    !jaDitas.has(normalizarMsgLead(textoMsg(m))),
  );
}

/**
 * A mensagem atual do lead é um reenvio da anterior (mesmo texto, poucos segundos depois) que
 * já foi respondida? Então não gera nova resposta — senão a IA repete a pergunta que acabou de
 * fazer ("Anotado, mais de 200. E antes da Buzin...").
 * Exige que a anterior já tenha resposta da IA: se ela foi só salva (lote pendente no debounce),
 * esta é a mensagem que precisa disparar a resposta.
 * Uma pergunta nova enviada com tempo de leitura entre as duas (> graça) faz a segunda ser
 * resposta legítima ("sim" para a pergunta 1, "sim" para a pergunta 2).
 */
export function ehReenvioDoLead(historicoDesc: MsgHist[], atualEvolutionId: string | null | undefined): boolean {
  const entradas = historicoDesc.filter(m => m.direcao === "in");
  const atual = (atualEvolutionId && entradas.find(m => m.evolutionMessageId === atualEvolutionId)) || entradas[0];
  if (!atual) return false;
  const tAtual = atual.enviadaEm.getTime();
  const anterior = entradas.find(m => m !== atual && m.enviadaEm.getTime() <= tAtual);
  if (!anterior) return false;
  const txtAtual = normalizarMsgLead(textoMsg(atual));
  if (!txtAtual || txtAtual !== normalizarMsgLead(textoMsg(anterior))) return false;
  const tAnt = anterior.enviadaEm.getTime();
  if (tAtual - tAnt > JANELA_REPETICAO_LEAD_MS) return false;
  const saidasEntre = historicoDesc.filter(m =>
    m.direcao === "out" && m.enviadaEm.getTime() >= tAnt && m.enviadaEm.getTime() <= tAtual + 1_000);
  if (saidasEntre.length === 0) return false; // anterior ainda sem resposta — esta dispara
  // Houve pergunta nova com tempo de leitura antes do reenvio? Então é resposta, não reenvio.
  return !saidasEntre.some(m => m.enviadaEm.getTime() < tAtual - GRACA_RESPOSTA_MS);
}

/** A resposta gerada já contém (em alguma frase interrogativa) a mesma pergunta? */
export function respostaJaFazPergunta(resposta: string, pergunta: string): boolean {
  if (!resposta || !pergunta) return false;
  const frases = resposta
    .replace(/\*[^*]*\*/g, " ")
    .split(/\n+|---|(?<=[?!.])\s+/)
    .map(f => f.trim())
    .filter(f => f.includes("?"));
  return frases.some(f => mesmaPergunta(f, pergunta));
}

/**
 * A pergunta já foi feita nas últimas mensagens enviadas para este deal?
 * Só considera repetição quando o lead RESPONDEU depois dela — se ele nunca respondeu,
 * insistir uma vez é legítimo.
 */
export async function jaPerguntouEFoiRespondida(dealId: string, pergunta: string): Promise<boolean> {
  if (!pergunta || pergunta.trim().length < 8) return false;

  const historico = await prisma.crmMensagemWhatsapp.findMany({
    where: { dealId },
    orderBy: { enviadaEm: "desc" },
    take: JANELA_OUT * 2,
    select: { direcao: true, conteudo: true, transcricao: true, enviadaEm: true },
  });

  const enviadas = historico.filter(m => m.direcao === "out").slice(0, JANELA_OUT);
  for (const anterior of enviadas) {
    const texto = anterior.conteudo ?? "";
    if (!texto || !mesmaPergunta(texto, pergunta)) continue;
    // Houve resposta real do lead depois dela? Então ele respondeu — repetir é o bug.
    if (leadRespondeuDepois(historico, anterior)) return true;
  }
  return false;
}
