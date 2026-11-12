/**
 * Exportação de tabelas/relatórios — compartilhado (Financeiro gerencial, Acordos, Recebimentos).
 *
 * exportarExcel: gera .xlsx no navegador com `exceljs` (import dinâmico, fica num chunk à parte).
 *   - tipo "moeda":      number ou string numérica (Decimal do Prisma) → célula numérica com formato R$.
 *   - tipo "data":       "YYYY-MM-DD" ou ISO ("YYYY-MM-DDTHH:mm…") → data Excel (dd/mm/aaaa), sem deslocar o dia.
 *   - tipo "numero":     number/string numérica → número (#.##0,## conforme o Excel do usuário).
 *   - tipo "percentual": valor JÁ em % (ex.: 45,2 = 45,2%) → célula 0,452 com formato 0,00%.
 *   - tipo "texto" (default): String(valor). null/undefined → célula vazia.
 * imprimirPdf: window.print() da própria tela; o CSS @media print (index.css) esconde menu,
 *   barra superior e tudo com a classe `no-print`, e imprime em paisagem com tabelas sem rolagem.
 */

export type TipoColunaExport = "moeda" | "data" | "numero" | "texto" | "percentual";

export interface ColunaExport {
  chave: string;
  titulo: string;
  tipo?: TipoColunaExport;
  /** Largura da coluna em caracteres (default: calculada pelo conteúdo, 10–60). */
  largura?: number;
}

export interface AbaExport {
  nome: string;
  colunas: ColunaExport[];
  linhas: Array<Record<string, unknown>>;
}

export interface OpcoesExportarExcel {
  /** Nome do arquivo (com ou sem .xlsx). */
  nomeArquivo: string;
  abas: AbaExport[];
}

const FORMATO_MOEDA = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const FORMATO_DATA = "dd/mm/yyyy";
const FORMATO_PCT = "0.00%";
const FORMATO_NUM = "#,##0.##";

function paraNumero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "object" && v && typeof (v as { toString?: unknown }).toString === "function") {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** "YYYY-MM-DD..." → Date em UTC 00:00 do mesmo dia (o exceljs converte Date por UTC). */
function paraDataExcel(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function valorCelula(v: unknown, tipo: TipoColunaExport): unknown {
  switch (tipo) {
    case "moeda":
    case "numero":
      return paraNumero(v);
    case "percentual": {
      const n = paraNumero(v);
      return n === null ? null : n / 100;
    }
    case "data":
      return paraDataExcel(v) ?? (v === null || v === undefined ? null : String(v));
    default:
      if (v === null || v === undefined) return null;
      if (typeof v === "boolean") return v ? "Sim" : "Não";
      return String(v);
  }
}

function formatoDe(tipo: TipoColunaExport): string | undefined {
  if (tipo === "moeda") return FORMATO_MOEDA;
  if (tipo === "data") return FORMATO_DATA;
  if (tipo === "percentual") return FORMATO_PCT;
  if (tipo === "numero") return FORMATO_NUM;
  return undefined;
}

/** Nome de aba válido no Excel: até 31 caracteres, sem []:*?/\ e único no arquivo. */
function nomeAba(nome: string, usados: Set<string>): string {
  const base = (nome || "Planilha").replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Planilha";
  let n = base;
  let i = 2;
  while (usados.has(n.toLowerCase())) {
    const suf = ` (${i++})`;
    n = base.slice(0, 31 - suf.length) + suf;
  }
  usados.add(n.toLowerCase());
  return n;
}

function baixarBlob(blob: Blob, nome: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportarExcel({ nomeArquivo, abas }: OpcoesExportarExcel): Promise<void> {
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Avoce";
  wb.created = new Date();
  const usados = new Set<string>();

  for (const aba of abas) {
    const ws = wb.addWorksheet(nomeAba(aba.nome, usados), { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = aba.colunas.map((c) => {
      const tipo = c.tipo ?? "texto";
      let largura = c.largura;
      if (!largura) {
        const maxConteudo = aba.linhas.slice(0, 500).reduce((mx, l) => {
          const v = l[c.chave];
          const len = v === null || v === undefined ? 0 : String(v).length;
          return Math.max(mx, len);
        }, 0);
        const minimo = tipo === "moeda" ? 14 : tipo === "data" ? 12 : 10;
        largura = Math.min(60, Math.max(minimo, c.titulo.length + 2, maxConteudo + 2));
      }
      return { header: c.titulo, key: c.chave, width: largura, style: { numFmt: formatoDe(tipo) } };
    });
    for (const l of aba.linhas) {
      const row: Record<string, unknown> = {};
      for (const c of aba.colunas) row[c.chave] = valorCelula(l[c.chave], c.tipo ?? "texto");
      ws.addRow(row);
    }
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE5E7EB" } };
    header.alignment = { vertical: "middle", wrapText: true };
    if (aba.colunas.length) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: aba.colunas.length } };
    }
  }
  if (!abas.length) wb.addWorksheet("Planilha");

  const buf = await wb.xlsx.writeBuffer();
  const nome = /\.xlsx$/i.test(nomeArquivo) ? nomeArquivo : `${nomeArquivo}.xlsx`;
  baixarBlob(
    new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    nome.replace(/[\\/:*?"<>|]/g, "-"),
  );
}

/**
 * Imprime a tela atual (o usuário escolhe "Salvar como PDF" no diálogo). `titulo` vira o
 * document.title durante a impressão (nome sugerido do PDF e cabeçalho do navegador).
 */
export function imprimirPdf(titulo?: string): void {
  const anterior = document.title;
  if (titulo) document.title = titulo;
  const restaurar = () => {
    document.title = anterior;
    window.removeEventListener("afterprint", restaurar);
  };
  window.addEventListener("afterprint", restaurar);
  window.print();
  // Safari nem sempre dispara afterprint
  setTimeout(restaurar, 1500);
}
