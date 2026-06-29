/**
 * Deal Anexos — saves media files received from leads to disk and indexes them in DB.
 * Called from stage-engine after a document/image is received and OCR'd.
 */

import path from "path";
import fs from "fs/promises";
import { prisma } from "../db.js";
import type { DocJsonResult } from "./types.js";

const UPLOADS_BASE = process.env.UPLOADS_DIR ?? "/opt/avoce/uploads";

function mimetypeToExt(mimetype: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  return map[mimetype] ?? "bin";
}

function resolverTipoDocumento(docJson: DocJsonResult | null, ocrTexto: string | null): string {
  if (docJson && docJson.tipo_documento && docJson.tipo_documento !== "OUTRO") {
    return docJson.tipo_documento;
  }
  if (!ocrTexto) return "OUTRO";
  const txt = ocrTexto.toLowerCase();
  if (/rescis[aã]o|trct|termo de rescis|aviso pr[eé]vio/.test(txt)) return "RESCISAO";
  if (/holerite|contracheque|folha de pagamento/.test(txt)) return "HOLERITE";
  if (/c[aá]lculo trabalhista|liquida[cç][aã]o|c[aá]lculo de verbas/.test(txt)) return "CALCULO";
  if (/contrato de trabalho|contrato individual/.test(txt)) return "CONTRATO";
  return "OUTRO";
}

export async function salvarAnexoDeal(
  dealId: string,
  buffer: Buffer,
  mimetype: string,
  originalName: string | undefined,
  ocrTexto: string | null,
  docJson: DocJsonResult | null,
): Promise<void> {
  try {
    const dir = path.join(UPLOADS_BASE, "deals", dealId);
    await fs.mkdir(dir, { recursive: true });

    const ext = originalName ? path.extname(originalName).replace(".", "") || mimetypeToExt(mimetype) : mimetypeToExt(mimetype);
    const baseName = originalName ? path.basename(originalName, path.extname(originalName)).replace(/[^a-zA-Z0-9_-]/g, "_") : "doc";
    const filename = `${Date.now()}_${baseName}.${ext}`;
    const filePath = path.join(dir, filename);

    await fs.writeFile(filePath, buffer);

    const tipoDocumento = resolverTipoDocumento(docJson, ocrTexto);
    const dadosExtraidos = docJson && docJson.tipo_documento !== "OUTRO" ? docJson : null;

    await prisma.dealAnexo.create({
      data: {
        dealId,
        nomeArquivo: originalName ?? filename,
        mimetype,
        tamanho: buffer.length,
        caminhoArquivo: filePath,
        ocrTexto: ocrTexto ?? undefined,
        tipoDocumento,
        dadosExtraidos: dadosExtraidos as any ?? undefined,
      },
    });

    console.log(`[DealAnexo] dealId=${dealId} tipo=${tipoDocumento} arquivo=${filename} (${buffer.length}B)`);
  } catch (e: any) {
    console.warn(`[DealAnexo] Falha ao salvar anexo para deal ${dealId}: ${e.message}`);
  }
}
