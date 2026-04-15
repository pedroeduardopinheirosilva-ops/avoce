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

/**
 * Extract structured data from a CNH-e digital PDF using the Python extractor.
 * Throws if the PDF is not a CNH-e (insufficient embedded images).
 */
export async function extractCNHData(
  pdfBuffer: Buffer,
  claudeApiKey?: string
): Promise<CNHExtractorResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), "cnh-"));
  const pdfPath = join(tmpDir, "cnh.pdf");
  await writeFile(pdfPath, pdfBuffer);

  try {
    const scriptPath = join(__dirname_local, "cnh_extractor.py");
    const args = [scriptPath, "--json", pdfPath];
    if (claudeApiKey) {
      args.push("--api-key", claudeApiKey);
    }

    const { stdout, stderr } = await execFileAsync("python3", args, {
      timeout: 90_000,
      env: { ...process.env },
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
