/**
 * Utilitários do núcleo financeiro (puro, sem I/O).
 *
 * Convenções de todo o lib/fin:
 *  - Dinheiro em CENTAVOS inteiros (`number` inteiro). Use `paraCentavos` para converter
 *    Prisma.Decimal/string/number e `deCentavos` para gravar de volta ("1234.56").
 *  - Taxas de índice em % a.m. (`taxaPct`, ex.: 1.1 = 1,10% no mês), como no FinIndiceMensal.
 *  - Datas como data-calendário `DataCal` = "YYYY-MM-DD" (sem hora, sem fuso).
 *    Do banco: `paraDataCal(date)` (lê no fuso America/Bahia). Para o banco: `deDataCal(s)`
 *    (meio-dia UTC, que é o mesmo dia em qualquer fuso do Brasil).
 */

export type DataCal = string; // "YYYY-MM-DD"
export type Centavos = number; // inteiro
/** Aceita number, string ("1234.56") ou Prisma.Decimal (qualquer coisa com toString). */
export type Numerico = number | string | { toString(): string };

export interface MesRef {
  ano: number;
  mes: number; // 1..12
}

export const FUSO = "America/Bahia";

// ── Dinheiro ────────────────────────────────────────────────────────────────

/** Arredonda para inteiro, meio para longe do zero (evita o viés de Math.round em negativos). */
export function arred(x: number): number {
  const r = Math.round(Math.abs(x) + 1e-9);
  return x < 0 ? -r : r;
}

/** Converte valor em reais (Decimal/string/number) para centavos inteiros, sem float acumulado. */
export function paraCentavos(v: Numerico | null | undefined): Centavos {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`valor inválido: ${v}`);
    return arred(v * 100);
  }
  const s = v.toString().trim().replace(",", ".");
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`valor inválido: ${s}`);
  const sinal = m[1] === "-" ? -1 : 1;
  const inteiro = Number(m[2] || "0");
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cent = inteiro * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cent += 1; // 3ª casa arredonda (meio para cima)
  return sinal * cent;
}

/** Centavos → string decimal com 2 casas ("1234.50"), pronta para Prisma.Decimal. */
export function deCentavos(c: Centavos): string {
  const neg = c < 0;
  const a = Math.abs(Math.trunc(c));
  const s = `${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** Converte percentual (ex.: 30, "33.33") para pontos-base inteiros (3000, 3333). */
export function paraBp(p: Numerico | null | undefined): number {
  return paraCentavos(p); // mesma aritmética: 2 casas decimais
}

/** valor × bp / 10000, arredondado (inteiro). */
export function aplicarBp(valor: Centavos, bp: number): Centavos {
  return arred((valor * bp) / 10000);
}

/** Converte taxa (Decimal/string/number em %) para number. */
export function paraTaxaPct(v: Numerico): number {
  const n = typeof v === "number" ? v : Number(v.toString().replace(",", "."));
  if (!Number.isFinite(n)) throw new Error(`taxa inválida: ${v}`);
  return n;
}

// ── Datas-calendário ────────────────────────────────────────────────────────

const RE_DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

export function partesData(d: DataCal): { ano: number; mes: number; dia: number } {
  const m = RE_DATA.exec(d);
  if (!m) throw new Error(`data inválida (esperado YYYY-MM-DD): ${d}`);
  return { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) };
}

export function montarData(ano: number, mes: number, dia: number): DataCal {
  return `${String(ano).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** Date do banco → data-calendário no fuso America/Bahia. */
export function paraDataCal(d: Date): DataCal {
  // en-CA formata como YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: FUSO, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Data-calendário → Date às 12:00 UTC (mesmo dia em qualquer fuso brasileiro). */
export function deDataCal(d: DataCal): Date {
  const { ano, mes, dia } = partesData(d);
  return new Date(Date.UTC(ano, mes - 1, dia, 12, 0, 0));
}

export function diasNoMes(ano: number, mes: number): number {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

export function mesDe(d: DataCal): MesRef {
  const { ano, mes } = partesData(d);
  return { ano, mes };
}

export function chaveMes(r: MesRef): string {
  return `${r.ano}-${String(r.mes).padStart(2, "0")}`;
}

/** Índice absoluto do mês (para comparar e subtrair meses). */
export function idxMes(r: MesRef): number {
  return r.ano * 12 + (r.mes - 1);
}

export function deIdxMes(i: number): MesRef {
  return { ano: Math.floor(i / 12), mes: (i % 12) + 1 };
}

export function addMeses(r: MesRef, n: number): MesRef {
  return deIdxMes(idxMes(r) + n);
}

export function compararMes(a: MesRef, b: MesRef): number {
  return idxMes(a) - idxMes(b);
}

/** Soma n meses a uma data, ajustando o dia ao fim do mês (31/01 + 1 → 28/02 ou 29/02). */
export function addMesesData(d: DataCal, n: number): DataCal {
  const { ano, mes, dia } = partesData(d);
  const r = addMeses({ ano, mes }, n);
  return montarData(r.ano, r.mes, Math.min(dia, diasNoMes(r.ano, r.mes)));
}

export function primeiroDia(r: MesRef): DataCal {
  return montarData(r.ano, r.mes, 1);
}

export function ultimoDia(r: MesRef): DataCal {
  return montarData(r.ano, r.mes, diasNoMes(r.ano, r.mes));
}

/** Diferença em dias corridos (b − a). */
export function diasEntre(a: DataCal, b: DataCal): number {
  return Math.round((deDataCal(b).getTime() - deDataCal(a).getTime()) / 86_400_000);
}

/** Lista de meses de `de` até `ate`, inclusive. */
export function mesesEntre(de: MesRef, ate: MesRef): MesRef[] {
  const out: MesRef[] = [];
  for (let i = idxMes(de); i <= idxMes(ate); i++) out.push(deIdxMes(i));
  return out;
}

export function soma(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
