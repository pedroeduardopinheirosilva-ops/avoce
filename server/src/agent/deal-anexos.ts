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
  // Retry parcial: quando o docJson do CHAMADOR veio null (ex.: extração re-tentada falhou
  // no provedor de IA), mas um resumo estruturado de uma extração anterior bem-sucedida já
  // está no ocrTexto (formato "[Documento recebido — dados extraídos]\nTipo: X (ENUM)..."),
  // o rótulo vem no formato enum ("COMPROVANTE_ENDERECO", com underscore) e não bate com o
  // texto natural abaixo ("comprovante de endereço") — o doc virava "OUTRO" apesar de já lido.
  const tipoEnumMatch = /\btipo:\s*.\s*\(([a-z_]+)\)/i.exec(txt);
  if (tipoEnumMatch) {
    const enumTipo = tipoEnumMatch[1].toUpperCase();
    if (["CNH", "RG", "CTPS", "COMPROVANTE_ENDERECO", "RESCISAO", "HOLERITE", "CALCULO", "CONTRATO"].includes(enumTipo)) {
      return enumTipo;
    }
  }
  // Documentos pessoais primeiro: quando a extração por visão falha, o docJson vem "OUTRO"
  // e o anexo era arquivado como genérico — o loader de contexto do coleta_docs só olha
  // CNH/RG/IDENTIDADE/CTPS e COMPROVANTE_ENDERECO, então a foto lida virava dado perdido.
  if (/habilita[cç][aã]o|carteira nacional|\bcnh\b|permiss[aã]o para dirigir/.test(txt)) return "CNH";
  if (/registro geral|carteira de identidade|\brg\b\s*[:nº]/.test(txt)) return "RG";
  if (/carteira de trabalho|\bctps\b|previd[eê]ncia social/.test(txt)) return "CTPS";
  if (/comprovante de (endere[cç]o|resid[eê]ncia)|fatura|conta de (luz|[aá]gua|energia|g[aá]s)|neoenergia|coelba|embasa/.test(txt)) return "COMPROVANTE_ENDERECO";
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
  /** Quando o chamador já sabe o que é o documento (ex.: PDF assinado devolvido
   *  pelo PAKT), o tipo vem pronto em vez de ser deduzido do OCR. */
  tipoExplicito?: string,
): Promise<void> {
  try {
    const dir = path.join(UPLOADS_BASE, "deals", dealId);
    await fs.mkdir(dir, { recursive: true });

    const ext = originalName ? path.extname(originalName).replace(".", "") || mimetypeToExt(mimetype) : mimetypeToExt(mimetype);
    const baseName = originalName ? path.basename(originalName, path.extname(originalName)).replace(/[^a-zA-Z0-9_-]/g, "_") : "doc";
    const filename = `${Date.now()}_${baseName}.${ext}`;
    const filePath = path.join(dir, filename);

    await fs.writeFile(filePath, buffer);

    const tipoDocumento = tipoExplicito ?? resolverTipoDocumento(docJson, ocrTexto);
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
