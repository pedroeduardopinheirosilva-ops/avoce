export type Cat = "trabalho" | "pessoal" | "neutro";

export const COR_CAT: Record<Cat | "pausa", string> = {
  trabalho: "var(--avoce-success)",
  pessoal: "var(--avoce-danger)",
  neutro: "var(--avoce-mute-soft)",
  pausa: "var(--avoce-hair)",
};

/** Dia de hoje (YYYY-MM-DD) no fuso fixo -03:00, igual ao servidor. */
export function hojeStr(): string {
  return new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
}

export function somarDias(d: string, n: number): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function fmtData(d: string): string {
  const [a, m, dia] = d.split("-");
  return `${dia}/${m}/${a}`;
}

export function fmtDur(seg: number): string {
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
}

/** Hora local -03:00 (HH:MM) de um instante. */
export function fmtHora(v: Date | string | null | undefined): string {
  if (!v) return "—";
  const t = new Date(new Date(v).getTime() - 3 * 3600_000);
  return t.toISOString().slice(11, 16);
}

/** Segundos desde 00:00 (-03:00) do instante. */
export function segDoDia(v: Date | string): number {
  const t = new Date(new Date(v).getTime() - 3 * 3600_000);
  return t.getUTCHours() * 3600 + t.getUTCMinutes() * 60 + t.getUTCSeconds();
}

export const DIAS_SEMANA = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export const card = "bg-white rounded-lg border border-gray-200";
export const btn = "px-3 py-1.5 rounded-md text-xs font-medium border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50";
export const btnPrimario = "px-3 py-1.5 rounded-md text-xs font-medium text-white disabled:opacity-50";
export const estiloPrimario = { background: "var(--avoce-navy)" } as const;
export const input = "border border-gray-300 rounded-md px-2 py-1 text-sm bg-white";
