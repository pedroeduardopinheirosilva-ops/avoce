/**
 * Caminhos de anexos do financeiro/acordos (comprovantes, NF, autorizações). Puro.
 *
 * Os arquivos ficam em disco em `${UPLOADS_DIR}/fin/{emitenteId}/{AAAA-MM}/{arquivo}` e o banco
 * guarda só o caminho RELATIVO `fin/{emitenteId}/{AAAA-MM}/{arquivo}` (campos *Path) + o nome
 * original (campos *Nome). O emitente dono do arquivo sai do próprio caminho, então o download
 * checa o acesso a ele sem precisar saber qual registro referencia o arquivo.
 */

export const PREFIXO_ANEXO_FIN = "fin";

const RE_SEG = /^[A-Za-z0-9_.-]+$/;

/** Valida um caminho relativo de anexo e devolve o emitente dono. null se inválido. */
export function analisarPathAnexo(path: string | null | undefined): { emitenteId: string; partes: string[] } | null {
  if (!path || typeof path !== "string" || path.length > 300) return null;
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/")) return null;
  const partes = path.split("/");
  if (partes.length !== 4 || partes[0] !== PREFIXO_ANEXO_FIN) return null;
  for (const p of partes) {
    if (!p || p === "." || p === ".." || !RE_SEG.test(p)) return null;
  }
  if (!/^\d{4}-\d{2}$/.test(partes[2])) return null;
  return { emitenteId: partes[1], partes };
}

/** O caminho é um anexo válido deste emitente? */
export function pathAnexoDoEmitente(path: string | null | undefined, emitenteId: string): boolean {
  const a = analisarPathAnexo(path);
  return !!a && a.emitenteId === emitenteId;
}

/** Nome de arquivo seguro para disco (mantém a extensão, até 80 caracteres no nome-base). */
export function nomeArquivoSeguro(original: string, prefixo: string): string {
  const semDir = original.split(/[\\/]/).pop() || "arquivo";
  const dot = semDir.lastIndexOf(".");
  const ext = dot > 0 ? semDir.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) : "";
  const base = (dot > 0 ? semDir.slice(0, dot) : semDir)
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "arquivo";
  return `${prefixo}_${base}${ext ? `.${ext}` : ""}`;
}

export const EXTENSOES_ANEXO_FIN = new Set([
  "pdf", "png", "jpg", "jpeg", "webp", "gif", "heic",
  "doc", "docx", "xls", "xlsx", "csv", "odt", "ods", "txt", "xml", "ofx", "zip",
]);

export function extensaoPermitida(nome: string): boolean {
  const dot = nome.lastIndexOf(".");
  return dot > 0 && EXTENSOES_ANEXO_FIN.has(nome.slice(dot + 1).toLowerCase());
}
