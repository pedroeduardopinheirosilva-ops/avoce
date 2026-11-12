/**
 * Utilitários das telas de Acordos e Recebimentos (Fase 3B).
 *
 * Convenções do server (routers/acordos.ts e routers/recebimentos.ts):
 *  - valores em reais (number); blocos `totais*`, `relatorio` e `indicadores` em CENTAVOS;
 *  - datas-calendário "YYYY-MM-DD" — formatadas aqui SEM `new Date(str)` (que desloca o dia em UTC).
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/src/routers/index";
import { hasModulo, type AuthUser } from "../../lib/usePermission";

export type RO = inferRouterOutputs<AppRouter>;
export type RI = inferRouterInputs<AppRouter>;

// ── Formatação ───────────────────────────────────────────────────────────────

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

export function fmtBrl(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return BRL.format(v);
}

/** Centavos (inteiro) → BRL. */
export function fmtCent(c: number | null | undefined): string {
  if (c === null || c === undefined) return "—";
  return BRL.format(c / 100);
}

/** "YYYY-MM-DD" → "dd/mm/aaaa" sem passar por Date. */
export function fmtData(d: string | null | undefined): string {
  if (!d) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Timestamp ISO (criadoEm, decididoEm, audienciaEm) → "dd/mm/aaaa hh:mm" no fuso do navegador. */
export function fmtDataHora(iso: string | Date | null | undefined, comHora = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return comHora
    ? d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR");
}

export function fmtPct(x: number | null | undefined, casas = 1): string {
  if (x === null || x === undefined) return "—";
  return `${(x * 100).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
}

/** Hoje como data-calendário no fuso do escritório (o server usa America/Bahia). */
export function hojeCal(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bahia" }).format(new Date());
}

/** Soma dias a uma data-calendário (aritmética em UTC ao meio-dia: sem deslocar o dia). */
export function addDiasCal(d: string, n: number): string {
  const [y, m, dd] = d.split("-").map(Number);
  const t = Date.UTC(y, m - 1, dd, 12) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Texto digitado ("1.234,56", "1234.56") → number em reais, ou null. */
export function parseValor(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const norm = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  const n = Number(norm);
  return Number.isFinite(n) ? n : null;
}

/** number → texto para input (vírgula decimal). */
export function valorParaInput(v: number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return v.toFixed(2).replace(".", ",");
}

// ── Rótulos ──────────────────────────────────────────────────────────────────

export const STATUS_ACORDO: Record<string, { rotulo: string; cor: string }> = {
  em_negociacao: { rotulo: "Em negociação", cor: "bg-blue-50 text-blue-700 border-blue-200" },
  firmado: { rotulo: "Firmado", cor: "bg-indigo-50 text-indigo-700 border-indigo-200" },
  aguardando_homologacao: { rotulo: "Aguardando homologação", cor: "bg-amber-50 text-amber-700 border-amber-200" },
  homologado: { rotulo: "Homologado", cor: "bg-green-50 text-green-700 border-green-200" },
  sem_acordo: { rotulo: "Sem acordo", cor: "bg-gray-100 text-gray-600 border-gray-200" },
};
export const STATUS_ABERTOS = ["em_negociacao", "firmado", "aguardando_homologacao"];

export const FASES: Array<{ valor: "previo" | "pos_contestacao" | "pos_replica" | "pos_pericia" | "pos_sentenca" | "recursal" | "execucao"; rotulo: string }> = [
  { valor: "previo", rotulo: "Prévio (antes da audiência/contestação)" },
  { valor: "pos_contestacao", rotulo: "Após a contestação" },
  { valor: "pos_replica", rotulo: "Após a réplica" },
  { valor: "pos_pericia", rotulo: "Após a perícia" },
  { valor: "pos_sentenca", rotulo: "Após a sentença" },
  { valor: "recursal", rotulo: "Fase recursal" },
  { valor: "execucao", rotulo: "Execução" },
];
export type Fase = (typeof FASES)[number]["valor"];
export const rotuloFase = (f: string | null | undefined) => FASES.find((x) => x.valor === f)?.rotulo ?? f ?? "—";

export const MOTIVOS_SAIDA: Array<{ valor: "empresa_recusou" | "abaixo_minimo" | "cliente_recusou" | "sem_resposta"; rotulo: string }> = [
  { valor: "empresa_recusou", rotulo: "Empresa recusou" },
  { valor: "abaixo_minimo", rotulo: "Proposta abaixo do mínimo autorizado" },
  { valor: "cliente_recusou", rotulo: "Cliente recusou" },
  { valor: "sem_resposta", rotulo: "Sem resposta da empresa" },
];
export const rotuloMotivoSaida = (m: string | null | undefined) => MOTIVOS_SAIDA.find((x) => x.valor === m)?.rotulo ?? m ?? "—";

export const rotuloTipoAcordo = (t: string | null | undefined) => (t === "previo" ? "Prévio" : t === "posterior" ? "Posterior" : "—");

export const STATUS_REC: Record<string, { rotulo: string; cor: string }> = {
  prevista: { rotulo: "Prevista", cor: "bg-blue-50 text-blue-700 border-blue-200" },
  recebida: { rotulo: "Recebida", cor: "bg-green-50 text-green-700 border-green-200" },
  em_atraso: { rotulo: "Em atraso", cor: "bg-red-50 text-red-700 border-red-200" },
};
export const REPASSE: Record<string, string> = { pendente: "Pendente", realizado: "Realizado", nao_aplicavel: "Não se aplica" };
export const NF: Record<string, string> = { a_emitir: "A emitir", emitida: "Emitida", nao_aplicavel: "Não se aplica" };

// ── Permissões ───────────────────────────────────────────────────────────────

/**
 * Mesmo critério do server (lib/fin/perm.ts → temModulo): role admin, permissões nulas ou
 * sem lista de módulos = acesso total; senão o módulo precisa estar na lista.
 */
export function podeModulo(user: AuthUser | null, ...modulos: string[]): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return modulos.some((m) => hasModulo(user, m));
}

// ── Classes comuns ───────────────────────────────────────────────────────────

export const inputCls =
  "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50";
export const labelCls = "block text-xs font-medium text-gray-600 mb-1";
export const btnPri = "px-3 py-1.5 text-xs bg-brand-900 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50";
export const btnSec = "px-3 py-1.5 text-xs border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 disabled:opacity-50";
export const btnPerigo = "px-3 py-1.5 text-xs border border-red-200 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50";
