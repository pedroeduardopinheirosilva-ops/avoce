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
    /(ja|ja)\s+(falei|disse|informei|passei|respondi|tinha?\s+falado)/,
    /(ta|esta)\s+(repetindo|perguntando)\s+(de\s+novo|igual|mesma\s+coisa)/,
    /(voce|vc)\s+nao\s+(ta|esta)\s+(lendo|prestando\s+atencao)/,
    /ja\s+respondi\s+isso/,
    /ta\s+repetindo/,
    /ja\s+falei\s+isso/,
    /ja\s+disse\s+isso/,
    /falei\s+(isso|pra|para)\s+(a\s+)?(ana|voce|vc)/,
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
