/**
 * cnh-extractor.ts
 * TypeScript wrapper for cnh_extractor.py
 * Calls the Python multi-strategy extractor via child_process.
 * Handles CNH-e digital PDFs (Gov.br format with embedded JPEG images).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { join, dirname } from "path";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename);

export interface CNHExtractorResult {
  nome?: string;
  cpf?: string;
  rg?: string;
  orgao_emissor_rg?: string;
  uf_emissor_rg?: string;
  data_nascimento?: string;
  local_nascimento?: string;
  nacionalidade?: string;
  filiacao_pai?: string;
  filiacao_mae?: string;
  numero_registro?: string;
  categoria?: string;
  primeira_habilitacao?: string;
  data_emissao?: string;
  data_validade?: string;
}

function extensaoPara(mimetype?: string): string {
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
    "image/webp": "webp", "image/bmp": "bmp", "image/tiff": "tiff",
  };
  return map[(mimetype ?? "").toLowerCase()] ?? "bin";
}

/**
 * Extrai dados de CNH pelo extrator Python. Aceita o PDF da CNH-e digital e
 * também a foto da CNH física.
 *
 * `usarIa: false` (padrão) roda só o que é determinístico — MRZ + tesseract +
 * regex, com validação de dígito do CPF. Sem chamada a nenhuma API paga.
 */
export async function extractCNHData(
  buffer: Buffer,
  claudeApiKey?: string,
  opts: { mimetype?: string; usarIa?: boolean } = {}
): Promise<CNHExtractorResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "cnh-"));
  const arquivo = join(tmpDir, `cnh.${extensaoPara(opts.mimetype)}`);
  await writeFile(arquivo, buffer);

  try {
    const scriptPath = join(__dirname_local, "cnh_extractor.py");
    const args = [scriptPath, "--json", arquivo];
    if (!opts.usarIa) args.push("--no-ai");
    if (claudeApiKey && opts.usarIa) {
      args.push("--api-key", claudeApiKey);
    }

    const { stdout, stderr } = await execFileAsync("python3", args, {
      timeout: 90_000,
      // OMP_THREAD_LIMIT=1: o tesseract usa OpenMP e, sem limite, um único
      // documento abre uma thread por core e satura a CPU do servidor.
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
    });

    // Log Python stderr (debug info) through Node's console
    if (stderr) {
      for (const line of stderr.split("\n").filter(Boolean)) {
        console.log(`[CNHpy] ${line}`);
      }
    }

    const trimmed = stdout.trim();
    if (!trimmed) {
      throw new Error("Python extractor returned empty output");
    }

    return JSON.parse(trimmed) as CNHExtractorResult;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
