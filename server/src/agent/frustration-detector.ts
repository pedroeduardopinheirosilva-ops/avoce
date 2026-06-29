/**
 * Frustration Detector — detecta e trata categorias de frustração do lead.
 * P6: Frustração reconhecida não é frustração ignorada.
 */

import { detectIdentityQuestion } from "./identity-handler.js";
import type { CrmMensagemWhatsapp } from "@prisma/client";

export type FrustrationType =
  | "repeticao"
  | "demora"
  | "sem_resposta"
  | "duvida_legitimidade"
  | "abandono_iminente";

export interface FrustrationDetection {
  type: FrustrationType;
  triggerPhrase: string;
}

export interface FrustrationHandling {
  injectIntoSystemPrompt?: string;
  forceResponseText?: string;
  skipDeterministicOverride: boolean;
  escalateToHuman: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Normalização
// ──────────────────────────────────────────────────────────────────────────────

function normalizar(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Padrões por tipo
// ──────────────────────────────────────────────────────────────────────────────

const PATTERNS: Record<FrustrationType, RegExp[]> = {
  repeticao: [
    // "já falei", "já te falei", "já lhe disse", "já havia falado" — com ou sem pronome no meio
    /ja\s+(\w{1,5}\s+)?(falei|disse|informei|passei|respondi|havia\s+falado|tinha\s+falado)/,
    /(ta|esta)\s+(repetindo|perguntando)\s+(de\s+novo|igual|mesma\s+coisa)/,
    /(voce|vc)\s+nao\s+(ta|esta)\s+(lendo|prestando\s+atencao)/,
    /ja\s+respondi\s+isso/,
    /ta\s+repetindo/,
    /ja\s+falei\s+isso/,
    /ja\s+disse\s+isso/,
    /falei\s+(isso|pra|para)\s+(a\s+)?(ana|voce|vc)/,
    // repete a pergunta — lead menciona que a IA está fazendo a mesma coisa
    /mesma\s+pergunta/,
    /perguntou\s+(isso|mesma|de\s+novo|outra\s+vez)/,
    /voce\s+ja\s+perguntou/,
    /ja\s+te\s+falei/,
    /ja\s+respondi\s+(essa|isso|essa\s+pergunta)/,
    // "não te disse", "não lhe falei" — lead reafirma informação já dada
    /n[aã]o\s+(te\s+|lhe\s+)?(disse|falei|informei|avisei|contei)/,
    // "perguntas inúteis / desnecessárias / sem sentido / vc repete"
    /perguntas?\s+(in[uú]teis?|desnecessar|sem\s+sentido|bobas?|rid[ií]cul|irrelevante)/,
    /(vc|voce)\s+repete/,
    /repete\s+(as\s+)?(perguntas?|isso|tudo|mesma)/,
    /ta\s+repetindo\s+(as\s+)?perguntas?/,
    // Padrões específicos para o público carreteiro nordestino
    /(ja|já)\s+falei\s+(no\s+)?(audio|áudio|aúdio)/,
    /(a\s+)?(senhora?|senhor|moca|moça|rapariga|menina)\s+n[aã]o\s+(t[aá]|est[aá])\s+(ouvindo|prestando|lendo)/,
    /(voce|vc|senhora)\s+(e|é)\s+(burr|idiota|lerda?|lerd[ao]|bobinha?|incompat|urr[ao]|bobo)/,
    /n[aã]o\s+prestou\s+aten/,
    /eu\s+ja\s+respondi\s+isso\s+(tudo|ali|antes)/,
    /falei\s+isso\s+no\s+come[cç]o/,
  ],
  demora: [
    /(demorou|demora\s+muito|ta\s+demorando)/,
    /(cade|kade)\s+(a\s+)?(resposta|voce|advogad)/,
    /(estou|to|ta)\s+esperando\s+ha/,
    /quando\s+(vai|vao)\s+(responder|me\s+atender)/,
  ],
  sem_resposta: [
    /ninguem\s+(me\s+)?responde/,
    /nao\s+responderam/,
  ],
  duvida_legitimidade: [], // tratado via detectIdentityQuestion
  abandono_iminente: [
    /(vou|to)\s+desist(ir|indo|iu)/,
    /^esquece(\s+isso)?$/,
    /deixa\s+pra\s+la/,
    /nao\s+(quero|tenho)\s+mais\s+interesse/,
    /cancela(r)?\s+(tudo|isso)/,
    /nao\s+vai\s+dar\s+certo/,
    /vou\s+desistir/,
    /esquece\s+isso/,
    // Rejeição/xingamento severo — escalada imediata
    /vai\s+tomar\s+(banho|no\b)/,
    /^vtnc$|^vsf$|^vtc$|^foda[\s-]?se$/,
    /vai\s+(se\s+)?(foder|fuder|embora|pra\s+casa\s+do\s+diabo)/,
  ],
};

// ──────────────────────────────────────────────────────────────────────────────
// detectFrustration
// ──────────────────────────────────────────────────────────────────────────────

export function detectFrustration(
  message: string,
  history: Pick<CrmMensagemWhatsapp, "conteudo" | "direcao">[]
): FrustrationDetection | null {
  const norm = normalizar(message);

  // duvida_legitimidade tem precedência absoluta via detectIdentityQuestion
  if (detectIdentityQuestion(norm)) {
    return { type: "duvida_legitimidade", triggerPhrase: message };
  }

  // Ordem de prioridade: abandono > repeticao > demora > sem_resposta
  const ordem: Array<Exclude<FrustrationType, "duvida_legitimidade">> = [
    "abandono_iminente",
    "repeticao",
    "demora",
    "sem_resposta",
  ];

  for (const tipo of ordem) {
    for (const pattern of PATTERNS[tipo]) {
      if (pattern.test(norm)) {
        return { type: tipo, triggerPhrase: message };
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// selectKeyFactsForRecognition — extrai 3-4 fatos salientes do merged
// ──────────────────────────────────────────────────────────────────────────────

function selectKeyFactsForRecognition(merged: Record<string, unknown>): string[] {
  const fatos: string[] = [];

  if (merged.nome && typeof merged.nome === "string") {
    fatos.push(`nome: ${merged.nome}`);
  }

  // empresa mais recente
  const empresaRecente = merged.empresa_recente ?? merged.empresa_principal;
  if (empresaRecente) {
    fatos.push(`empresa: ${empresaRecente}`);
  } else if (Array.isArray(merged.vinculos) && merged.vinculos.length > 0) {
    const ultimo = (merged.vinculos as any[]).at(-1);
    if (ultimo?.empresa) fatos.push(`empresa: ${ultimo.empresa}`);
  }

  // função/cargo
  const funcao = merged.funcao ?? merged.cargo;
  if (funcao) fatos.push(`função: ${funcao}`);

  // motivo da saída
  if (Array.isArray(merged.vinculos) && merged.vinculos.length > 0) {
    const ultimo = (merged.vinculos as any[]).at(-1);
    if (ultimo?.saida) fatos.push(`saída: ${ultimo.saida}`);
    else if (ultimo?.injustica) fatos.push(`irregularidade: ${ultimo.injustica}`);
  }

  // tempo de serviço como fallback
  if (fatos.length < 3 && merged.tempo_servico) {
    fatos.push(`tempo de serviço: ${merged.tempo_servico}`);
  }

  return fatos.slice(0, 4);
}

// ──────────────────────────────────────────────────────────────────────────────
// buildFrustrationHandling
// ──────────────────────────────────────────────────────────────────────────────

export function buildFrustrationHandling(
  detection: FrustrationDetection,
  deal: { id: string },
  merged: Record<string, unknown>,
  persona: { chave: string; nomeExibicao: string },
  identityResponseText?: string,
  retencaoText?: string
): FrustrationHandling {
  const { type } = detection;

  switch (type) {
    case "repeticao": {
      const fatos = selectKeyFactsForRecognition(merged);
      const fatosStr = fatos.length > 0
        ? `[${fatos.join("; ")}]`
        : "[dados ainda em coleta]";

      return {
        injectIntoSystemPrompt:
          `=== ATENÇÃO IMEDIATA ===\n` +
          `O cliente acaba de reclamar que está repetindo informação. ` +
          `Você JÁ TEM estes dados sobre ele: ${fatosStr}. ` +
          `Confirme em UMA frase curta que você viu esses dados ` +
          `(ex: 'Verdade, desculpa — vi aqui que você é o [nome], trabalhou na [empresa] como [função] e saiu por [saída]') ` +
          `e siga DIRETO para a próxima etapa pendente, SEM cumprimentar de novo, SEM se reapresentar.`,
        skipDeterministicOverride: true,
        escalateToHuman: false,
      };
    }

    case "duvida_legitimidade": {
      return {
        forceResponseText: identityResponseText ?? `Sou uma assistente virtual de triagem deste escritório de advocacia. Os dados que você me passa ficam com a equipe jurídica, que é quem conduz efetivamente o seu caso. Posso continuar?`,
        skipDeterministicOverride: true,
        escalateToHuman: false,
      };
    }

    case "abandono_iminente": {
      return {
        forceResponseText: retencaoText, // undefined = silêncio (humano assume)
        skipDeterministicOverride: true,
        escalateToHuman: true,
      };
    }

    case "demora":
    case "sem_resposta": {
      return {
        injectIntoSystemPrompt:
          `=== ATENÇÃO IMEDIATA ===\n` +
          `O cliente reclamou de demora/falta de resposta. ` +
          `Comece a resposta com UMA frase curta de desculpa específica (ex: 'Desculpa a demora aqui'). ` +
          `Em seguida, responda objetivamente à pergunta substantiva mais recente dele se houver. ` +
          `Depois siga o flow.`,
        skipDeterministicOverride: true,
        escalateToHuman: false,
      };
    }
  }
}
