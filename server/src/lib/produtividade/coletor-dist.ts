import { join, resolve, sep } from "node:path";

export const ARQUIVOS_COLETOR = [
  "coletor-windows.exe",
  "coletor-mac-arm64",
  "coletor-mac-amd64",
  "instalar-mac.sh",
  "instalar-windows.ps1",
] as const;

export function dirColetorDist(): string {
  return process.env.COLETOR_DIST_DIR ?? "/opt/avoce/coletor-dist";
}

/** Caminho absoluto do arquivo permitido, ou null (nome fora da lista / fuga do diretório). */
export function caminhoColetor(nome: string, dir: string = dirColetorDist()): string | null {
  if (!(ARQUIVOS_COLETOR as readonly string[]).includes(nome)) return null;
  const base = resolve(dir);
  const alvo = resolve(join(base, nome));
  return alvo.startsWith(base + sep) ? alvo : null;
}
