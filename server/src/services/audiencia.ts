/**
 * Mensagens de audiência.
 *
 * Nenhum texto mora aqui: os modelos ficam em `IaMensagemTemplate` (por projeto,
 * editáveis em Config IA → Audiências) e a cadência do lembrete em
 * `IaProjetoConfig`, categoria "audiencia". Este módulo só resolve variáveis,
 * decide o dia do lembrete e diz quando falta configuração.
 */

import { prisma } from "../db.js";

/** Tipos de audiência — cada um lê o seu próprio modelo de mensagem. */
export const TIPOS_AUDIENCIA = [
  { chave: "inicial_protocolo", rotulo: "Inicial — designada já no protocolo" },
  { chave: "inicial_posterior", rotulo: "Inicial — designada depois" },
  { chave: "instrucao",         rotulo: "Instrução" },
  { chave: "una",               rotulo: "Una" },
] as const;

export type TipoAudiencia = (typeof TIPOS_AUDIENCIA)[number]["chave"];

export const MODALIDADES = ["presencial", "virtual"] as const;
export type Modalidade = (typeof MODALIDADES)[number];

/** Chaves em IaMensagemTemplate. O prefixo agrupa a aba de configuração. */
export const PREFIXO_TEMPLATE = "audiencia_";
export const CHAVE_LEMBRETE = "audiencia_lembrete";
export const CHAVE_BLOCO_VIRTUAL = "audiencia_bloco_virtual";
export const chaveDesignacao = (tipo: TipoAudiencia) => `${PREFIXO_TEMPLATE}${tipo}`;

/** Todas as chaves que o módulo espera encontrar no banco. */
export const CHAVES_ESPERADAS = [
  ...TIPOS_AUDIENCIA.map((t) => chaveDesignacao(t.chave)),
  CHAVE_LEMBRETE,
  CHAVE_BLOCO_VIRTUAL,
];

/** Chaves em IaProjetoConfig (categoria "audiencia"). */
export const CFG_DIARIO_DIAS = "audiencia_lembrete_diario_dias";
export const CFG_SEMANAL     = "audiencia_lembrete_semanal";
export const CFG_HORA        = "audiencia_lembrete_hora";
export const CATEGORIA_CFG   = "audiencia";

export const VARIAVEIS = [
  { chave: "{nome}",          descricao: "Primeiro nome do cliente" },
  { chave: "{data}",          descricao: "Data da audiência (dd/mm/aaaa)" },
  { chave: "{hora}",          descricao: "Horário da audiência (hh:mm)" },
  { chave: "{local}",         descricao: "Local ou link da sala virtual" },
  { chave: "{empresa}",       descricao: "Empresa reclamada (1º vínculo do lead)" },
  { chave: "{valor_causa}",   descricao: "Valor da causa já formatado em reais" },
  { chave: "{bloco_virtual}", descricao: "Parágrafo do Zoom — só entra se a audiência for virtual" },
] as const;

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

/** Dias inteiros entre duas datas, contados no fuso do escritório. */
export function diasAte(em: Date, agora = new Date()): number {
  const dia = (d: Date) => {
    const s = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    }).format(d);
    return Date.parse(`${s}T00:00:00Z`);
  };
  return Math.round((dia(em) - dia(agora)) / 86_400_000);
}

/** Hora local do escritório (0-23). */
export function horaLocal(d = new Date()): number {
  return Number(new Intl.DateTimeFormat("pt-BR", {
    timeZone: TZ, hour: "2-digit", hour12: false,
  }).format(d));
}

const MOEDA = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function formatarValor(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v.toString());
  return Number.isFinite(n) && n > 0 ? MOEDA.format(n) : null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Cadência do lembrete
// ──────────────────────────────────────────────────────────────────────────────

export interface Cadencia {
  /** Dentro desses dias, lembra todo dia. */
  diarioDias: number;
  /** Fora disso, lembra de 7 em 7 dias (ancorado na data da audiência). */
  semanal: boolean;
  /** Hora local em que o cron pode disparar. */
  hora: number;
}

/** Usado só quando a linha de configuração não existe — números, nunca texto. */
export const CADENCIA_FALLBACK: Cadencia = { diarioDias: 7, semanal: true, hora: 9 };

export async function carregarCadencia(projetoId: string): Promise<Cadencia> {
  const rows = await prisma.iaProjetoConfig.findMany({
    where: { projetoId, chave: { in: [CFG_DIARIO_DIAS, CFG_SEMANAL, CFG_HORA] } },
  });
  const get = (k: string) => rows.find((r) => r.chave === k)?.valor?.trim();
  const num = (k: string, padrao: number) => {
    const n = Number(get(k));
    return Number.isFinite(n) && n >= 0 ? n : padrao;
  };
  const bool = get(CFG_SEMANAL);
  return {
    diarioDias: num(CFG_DIARIO_DIAS, CADENCIA_FALLBACK.diarioDias),
    semanal:    bool === undefined ? CADENCIA_FALLBACK.semanal : bool !== "false",
    hora:       num(CFG_HORA, CADENCIA_FALLBACK.hora),
  };
}

/**
 * Hoje é dia de lembrete? No dia da audiência e depois dela, não manda mais.
 * O semanal é ancorado na própria data, para cair sempre no mesmo dia da semana.
 */
export function ehDiaDeLembrete(dias: number, cad: Cadencia): boolean {
  if (dias <= 0) return false;
  if (dias <= cad.diarioDias) return true;
  return cad.semanal && dias % 7 === 0;
}

/** Dias em que o lembrete cairia, para a tela mostrar a cadência configurada. */
export function previsaoLembretes(diasAteAudiencia: number, cad: Cadencia): number[] {
  const out: number[] = [];
  for (let d = Math.max(0, diasAteAudiencia); d >= 1; d--) if (ehDiaDeLembrete(d, cad)) out.push(d);
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// Montagem da mensagem
// ──────────────────────────────────────────────────────────────────────────────

export interface DadosAudiencia {
  nome: string;
  em: Date;
  modalidade: Modalidade;
  local: string | null;
  empresa?: string | null;
  valorCausa?: string | null;
}

export interface MensagemMontada {
  texto: string;
  /** Variáveis que o modelo usa mas que vieram vazias — a tela avisa antes de enviar. */
  faltando: string[];
}

export function renderizar(template: string, vars: Record<string, string>): MensagemMontada {
  const faltando: string[] = [];
  let texto = template;
  for (const [chave, valor] of Object.entries(vars)) {
    const marcador = `{${chave}}`;
    if (!texto.includes(marcador)) continue;
    if (!valor.trim()) faltando.push(marcador);
    texto = texto.split(marcador).join(valor);
  }
  // Espaço duplo e linha órfã que sobram quando uma variável vem vazia.
  texto = texto.replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { texto, faltando };
}

async function carregarTemplate(projetoId: string, chave: string): Promise<string | null> {
  const t = await prisma.iaMensagemTemplate.findFirst({
    where: { projetoId, chave, ativo: true },
    select: { template: true },
  });
  return t?.template ?? null;
}

/**
 * Monta a mensagem a partir do modelo gravado no banco.
 * Devolve `null` quando o modelo não existe — quem chama decide o que fazer
 * (a tela pede para cadastrar; o cron pula e loga).
 */
export async function montarMensagem(
  projetoId: string,
  chave: string,
  d: DadosAudiencia,
): Promise<MensagemMontada | null> {
  const template = await carregarTemplate(projetoId, chave);
  if (!template) return null;

  const { data, hora } = formatarDataHora(d.em);
  const blocoVirtual = d.modalidade === "virtual"
    ? (await carregarTemplate(projetoId, CHAVE_BLOCO_VIRTUAL)) ?? ""
    : "";

  return renderizar(template, {
    nome:          d.nome,
    data,
    hora,
    local:         d.local?.trim() ?? "",
    empresa:       d.empresa?.trim() ?? "",
    valor_causa:   d.valorCausa ?? "",
    bloco_virtual: blocoVirtual,
  });
}

/** Quais modelos ainda não foram cadastrados neste projeto. */
export async function templatesFaltando(projetoId: string): Promise<string[]> {
  const existentes = await prisma.iaMensagemTemplate.findMany({
    where: { projetoId, chave: { in: CHAVES_ESPERADAS }, ativo: true },
    select: { chave: true },
  });
  const set = new Set(existentes.map((e) => e.chave));
  return CHAVES_ESPERADAS.filter((c) => !set.has(c));
}

/** Projeto que responde pelo lead — o dele, senão o primeiro da empresa. */
export async function resolverProjetoId(deal: {
  projetoId: string | null; empresaId: string | null;
}): Promise<string | null> {
  if (deal.projetoId) return deal.projetoId;
  if (!deal.empresaId) return null;
  const p = await prisma.iaProjeto.findFirst({
    where: { empresaId: deal.empresaId }, select: { id: true },
  });
  return p?.id ?? null;
}
