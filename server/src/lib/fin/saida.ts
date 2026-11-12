/**
 * Conversão das saídas calculadas (centavos) para a resposta da API (reais, number com 2 casas —
 * mesma convenção do routers/acordos.ts / recebimentos.ts). Puro.
 *
 * Percorre objetos/arrays e converte TODO número, exceto as chaves que não são dinheiro
 * (`NAO_DINHEIRO`, e qualquer chave que comece com "qtd" ou termine com "Pct"/"Dias").
 * Chaves terminadas em "Centavos" perdem o sufixo na saída (valorCentavos → valor).
 */
import { deCentavos } from "./util.js";

export const NAO_DINHEIRO = new Set([
  "ano", "mes", "dia", "numero", "parcelaAmortizacao", "refAno", "refMes", "percentual", "percentualIndexador",
  "ignorados", "dias", "aliquotaIr", "ordem", "meses", "numParcelas", "carenciaMeses", "spreadAnual", "total_registros",
  "pagina", "porPagina", "totalPaginas", "totalItens", "percentualConsumido",
]);

function chaveNaoDinheiro(k: string): boolean {
  return NAO_DINHEIRO.has(k) || k.startsWith("qtd") || k.endsWith("Pct") || k.endsWith("Dias");
}

export function reaisDe(c: number): number {
  return Number(deCentavos(c));
}

/** Tipo da saída: mesmas chaves, exceto "xCentavos" → "x" (para o tRPC inferir certo no web). */
export type SemCentavos<T> = T extends Date
  ? T
  : T extends ReadonlyArray<infer U>
    ? SemCentavos<U>[]
    : T extends object
      ? { [K in keyof T as K extends `${infer P}Centavos` ? (P extends "" ? K : P) : K]: SemCentavos<T[K]> }
      : T;

/** Converte recursivamente centavos → reais. Datas, strings, booleanos e null passam intactos. */
export function emReais<T>(v: T, chave?: string): SemCentavos<T> {
  return conv(v, chave) as SemCentavos<T>;
}

function conv(v: unknown, chave?: string): unknown {
  if (typeof v === "number") return chave && chaveNaoDinheiro(chave) ? v : reaisDe(v);
  if (Array.isArray(v)) return v.map((x) => conv(x, chave));
  // Prisma.Decimal (tem toFixed) e Date passam intactos — não use emReais em linhas do Prisma.
  if (v && typeof v === "object" && !(v instanceof Date) && typeof (v as { toFixed?: unknown }).toFixed !== "function") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // "valorCentavos" → "valor" (o número sai em reais, o nome não pode dizer centavos)
      const nome = k.endsWith("Centavos") && k.length > 8 ? k.slice(0, -8) : k;
      out[nome] = conv(x, k);
    }
    return out;
  }
  return v;
}
