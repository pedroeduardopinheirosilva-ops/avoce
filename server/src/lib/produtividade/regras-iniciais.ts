import type { Regra } from "./tipos.js";

type RegraInicial = Omit<Regra, "cargoId" | "usuarioId">;

const r = (alvo: Regra["alvo"], categoria: Regra["categoria"], padroes: string[]): RegraInicial[] =>
  padroes.map((padrao) => ({ alvo, padrao, categoria, prioridade: 0 }));

/** Regras gerais (sem cargo/pessoa) inseridas por `regras.semear`. O PSA Docs entra pela tela de regras. */
export const REGRAS_INICIAIS: RegraInicial[] = [
  ...r("dominio", "trabalho", [
    "pje.jus.br", "jus.br", "tjba.jus.br", "trf1.jus.br", "stj.jus.br", "receita.fazenda.gov.br", "gov.br",
    "sefaz.ba.gov.br", "avoce.capium.com.br", "avoce.com.br", "capium.com.br", "paktdoc.com",
  ]),
  ...r("app", "trabalho", ["winword", "excel", "outlook", "onlyoffice", "acrobat", "microsoft word", "microsoft excel"]),
  ...r("dominio", "pessoal", [
    "youtube.com", "instagram.com", "facebook.com", "tiktok.com", "x.com", "twitter.com", "netflix.com",
    "mercadolivre.com.br", "shopee.com.br", "amazon.com.br", "globo.com", "uol.com.br", "ge.globo",
  ]),
  ...r("app", "pessoal", ["steam", "spotify"]),
  ...r("dominio", "neutro", ["web.whatsapp.com"]),
  ...r("app", "neutro", ["whatsapp"]),
];
