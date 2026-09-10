/**
 * Mensagens de audiência para o cliente.
 *
 * Os textos são os modelos aprovados pelo escritório (Rocha Amorim Pires
 * Advogados). Nada aqui envia nada: monta o texto e devolve. Quem envia é o
 * router (designação, com revisão humana) ou o cron (lembrete periódico).
 */

/** Tipos de audiência — a chave define qual modelo de mensagem é usado. */
export const TIPOS_AUDIENCIA = [
  { chave: "inicial_protocolo",  rotulo: "Inicial — designada já no protocolo" },
  { chave: "inicial_posterior",  rotulo: "Inicial — designada depois" },
  { chave: "instrucao",          rotulo: "Instrução" },
  { chave: "una",                rotulo: "Una" },
] as const;

export type TipoAudiencia = (typeof TIPOS_AUDIENCIA)[number]["chave"];

export const MODALIDADES = ["presencial", "virtual"] as const;
export type Modalidade = (typeof MODALIDADES)[number];

const TZ = "America/Bahia";

export function ehTipoValido(v: unknown): v is TipoAudiencia {
  return TIPOS_AUDIENCIA.some((t) => t.chave === v);
}

export function rotuloTipo(chave: string | null | undefined): string {
  return TIPOS_AUDIENCIA.find((t) => t.chave === chave)?.rotulo ?? "—";
}

/** "14/10/2026" e "09:30" no fuso do escritório. */
export function formatarDataHora(em: Date): { data: string; hora: string } {
  const data = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric",
  }).format(em);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(em);
  return { data, hora };
}

/** Dias inteiros entre hoje e a audiência, contados no fuso do escritório. */
export function diasAte(em: Date, agora = new Date()): number {
  const dia = (d: Date) => {
    const s = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
    return Date.parse(`${s}T00:00:00Z`);
  };
  return Math.round((dia(em) - dia(agora)) / 86_400_000);
}

const MOEDA = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatarValor(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v.toString());
  return Number.isFinite(n) && n > 0 ? MOEDA.format(n) : null;
}

/** Bloco do Zoom — só entra quando a audiência é virtual. */
const BLOCO_VIRTUAL =
  "Como sua audiência vai ser por videochamada, já baixe no seu celular ou computador " +
  "o aplicativo Zoom. Mais perto da data, vamos te enviar um vídeo explicando direitinho " +
  "como usar o aplicativo no dia da audiência.";

export interface DadosAudiencia {
  nome: string;
  em: Date;
  tipo: TipoAudiencia;
  modalidade: Modalidade;
  local: string | null;
  /** Só usado no modelo "inicial_protocolo". */
  empresa?: string | null;
  valorCausa?: string | null;
}

function cabecalho(d: DadosAudiencia): string {
  const { data, hora } = formatarDataHora(d.em);
  return [
    `DATA: ${data}`,
    `HORÁRIO: ${hora}`,
    `LOCAL: ${d.local?.trim() || (d.modalidade === "virtual" ? "link a confirmar" : "a confirmar")}`,
  ].join("\n");
}

function fechar(partes: string[], modalidade: Modalidade): string {
  if (modalidade === "virtual") partes.push(BLOCO_VIRTUAL);
  return partes.join("\n\n").trim();
}

/** Mensagem de designação, escolhida pelo tipo da audiência. */
export function montarMensagemDesignacao(d: DadosAudiencia): string {
  const ola = `Olá, ${d.nome}! Tudo bem?`;
  const head = cabecalho(d);

  if (d.tipo === "inicial_protocolo") {
    const empresa = d.empresa?.trim() || "a empresa";
    const valor = d.valorCausa
      ? `O valor que colocamos na causa foi de ${d.valorCausa}, que foi estimado e calculado ` +
        "segundo as informações que o senhor nos passou. Não é, portanto, o valor final que você " +
        "vai receber, que pode variar para mais ou para menos em caso de êxito."
      : "";
    return fechar([
      ola,
      `Passando para avisar que hoje protocolamos sua ação trabalhista contra ${empresa}. ${valor}`.trim(),
      "Já saiu também a data da primeira audiência:",
      head,
      "Essa primeira audiência serve para tentar um acordo. Vamos ver se a empresa oferta algum " +
      "valor que seja interessante para você, com o juiz intermediando essa conversa. Se não houver " +
      "acordo, o processo segue normalmente e vamos te explicar os próximos passos com calma.",
      "Qualquer dúvida, pode me chamar. Estamos à disposição.",
    ], d.modalidade);
  }

  if (d.tipo === "inicial_posterior") {
    return fechar([
      ola,
      "Passando para avisar que já saiu a data da audiência do seu processo:",
      head,
      "Essa é a primeira audiência do caso e serve para tentar um acordo. Vamos ver se a empresa " +
      "oferta algum valor que seja interessante para você, com o juiz intermediando essa conversa. " +
      "Se não houver acordo, o processo continua normalmente e a gente te explica os próximos passos.",
      "Fique tranquilo, qualquer coisa estamos aqui.",
    ], d.modalidade);
  }

  if (d.tipo === "instrucao") {
    return fechar([
      ola,
      "Passando para avisar que saiu a data da audiência de instrução do seu processo:",
      head,
      "Essa audiência é mais importante. É quando as testemunhas vão contar para o juiz o que sabem " +
      "sobre como era seu trabalho (horários, condições, etc). Por isso preciso que você já vá " +
      "pensando em quem pode ser sua testemunha, de preferência alguém que trabalhou com você no " +
      "mesmo período e viu de perto sua rotina de trabalho.",
      "O que precisamos que você faça agora:\n" +
      "1. Me passe o nome e telefone das pessoas que podem testemunhar, o quanto antes;\n" +
      "2. Avise essas pessoas que a audiência vai acontecer nessa data, para elas já se programarem.",
      "Mais perto da data, vamos marcar uma ligação com cada uma delas para explicar direitinho " +
      "como vai funcionar.",
      "Qualquer dúvida, me chama.",
    ], d.modalidade);
  }

  return fechar([
    ola,
    "Passando para avisar que saiu a data da audiência do seu processo:",
    head,
    "Essa é uma audiência una, ou seja, junta em um dia só a tentativa de acordo e a oitiva das " +
    "testemunhas, se for necessário. Por isso já é importante pensar em quem pode ser sua " +
    "testemunha, de preferência alguém que trabalhou com você no mesmo período e conhece sua " +
    "rotina de trabalho.",
    "O que precisamos que você faça agora:\n" +
    "1. Me passe o nome e telefone das pessoas que podem testemunhar, o quanto antes;\n" +
    "2. Avise essas pessoas sobre a data da audiência, para elas já se programarem.",
    "Mais perto da data, vamos marcar uma ligação com cada uma delas para explicar tudo com calma.",
    "Qualquer dúvida, estou à disposição.",
  ], d.modalidade);
}

/** Lembrete periódico — o mesmo texto para qualquer tipo de audiência. */
export function montarMensagemLembrete(d: DadosAudiencia): string {
  return fechar([
    `Olá, ${d.nome}! Tudo bem?`,
    "Passando só para lembrar que sua audiência está chegando:",
    cabecalho(d),
    "Fique atento ao dia e horário e, se puder, confirme aqui que está tudo certo para essa data. " +
    "Qualquer dúvida ou imprevisto, me avise o quanto antes.",
  ], d.modalidade);
}

/**
 * Hoje é dia de lembrete? Semanal enquanto falta mais de uma semana, diário na
 * última semana. No dia da audiência e depois dela, não manda mais.
 *
 * A âncora do semanal é a própria data da audiência (faltando 14, 21, 28…),
 * para o lembrete cair sempre no mesmo dia da semana da audiência.
 */
export function ehDiaDeLembrete(dias: number): boolean {
  if (dias <= 0) return false;
  if (dias <= 7) return true;
  return dias % 7 === 0;
}
