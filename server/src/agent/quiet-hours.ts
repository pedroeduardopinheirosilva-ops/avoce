/**
 * Quiet Hours — janela de silêncio para mensagens automáticas (lembretes, follow-ups, proativos).
 *
 * Motivo: lembretes de reunião estavam saindo às 03:00 da madrugada (caso Edgar 9312 — reunião
 * 18/08 09:30, lembrete de 6h antes disparado às 03:00). O cron só comparava a diferença de horas
 * até a reunião, sem nenhuma noção de hora do dia.
 *
 * Regra padrão: só envia entre 07:00 e 22:00 (America/Sao_Paulo). Configurável por projeto pelas
 * chaves que a UI já expõe em IaProjetoConfig: `horario_ini` / `horario_fim` (0-23).
 *
 * Fonte única: `isHorarioComercial` (cron-agent) existia mas não era chamada em lugar nenhum, e o
 * cron de lembretes não tinha noção de hora do dia. Ambos passam por aqui agora.
 *
 * NÃO se aplica a respostas a uma mensagem do lead — se ele escreve 03:00 da manhã, a IA responde.
 * Silêncio vale só para o que o SISTEMA inicia.
 */

import { prisma } from "../db.js";

export const TZ = "America/Sao_Paulo";

const DEFAULT_ABRE  = 7;   // 07:00 — a partir daqui pode enviar
const DEFAULT_FECHA = 22;  // 22:00 — a partir daqui, silêncio

/** Faixa em que o envio automático é PERMITIDO (abre inclusive, fecha exclusive). */
type Janela = { abre: number; fecha: number };

const cache = new Map<string, { janela: Janela; expira: number }>();
const CACHE_MS = 5 * 60 * 1000;

/** Hora local (0-23) em America/Sao_Paulo para um instante qualquer. */
export function horaLocal(quando: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", hour12: false });
  return Number(fmt.format(quando));
}

export async function getJanelaSilencio(projetoId: string | null | undefined): Promise<Janela> {
  if (!projetoId) return { abre: DEFAULT_ABRE, fecha: DEFAULT_FECHA };

  const hit = cache.get(projetoId);
  if (hit && hit.expira > Date.now()) return hit.janela;

  const janela = { abre: DEFAULT_ABRE, fecha: DEFAULT_FECHA };
  try {
    const cfgs = await prisma.iaProjetoConfig.findMany({
      where: { projetoId, chave: { in: ["horario_ini", "horario_fim"] } },
    });
    for (const c of cfgs) {
      const n = Number(c.valor);
      if (!Number.isInteger(n) || n < 0 || n > 23) continue;
      if (c.chave === "horario_ini") janela.abre = n;
      if (c.chave === "horario_fim") janela.fecha = n;
    }
  } catch {
    // Config indisponível: mantém o padrão em vez de liberar envio na madrugada.
  }

  cache.set(projetoId, { janela, expira: Date.now() + CACHE_MS });
  return janela;
}

/** true quando a hora está DENTRO da faixa permitida de envio (a faixa pode cruzar a meia-noite). */
export function dentroDaJanela(hora: number, janela: Janela): boolean {
  const { abre, fecha } = janela;
  if (abre === fecha) return true;             // faixa degenerada = sem restrição
  if (abre < fecha) return hora >= abre && hora < fecha;
  return hora >= abre || hora < fecha;         // cruza a meia-noite (ex.: 22 → 7)
}

/** Atalho legível: dá para enviar mensagem automática agora? */
export async function podeEnviarAgora(projetoId: string | null | undefined, quando: Date = new Date()): Promise<boolean> {
  return dentroDaJanela(horaLocal(quando), await getJanelaSilencio(projetoId));
}

/**
 * Deve segurar uma mensagem automática agora?
 * Uso: `if (await emSilencio(projetoId)) return;` antes de qualquer envio iniciado pelo sistema.
 */
export async function emSilencio(projetoId: string | null | undefined, quando: Date = new Date()): Promise<boolean> {
  return !(await podeEnviarAgora(projetoId, quando));
}

/** Limpa o cache (usado nos testes e após alterar a config). */
export function limparCacheSilencio(): void {
  cache.clear();
}
