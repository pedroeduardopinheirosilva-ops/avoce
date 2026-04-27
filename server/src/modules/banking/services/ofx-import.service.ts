import { createHash } from "node:crypto";
import Papa           from "papaparse";
import { prisma }     from "../../../db.js";

// ── OFX SGML parser ──────────────────────────────────────────────────────────

interface OfxTransaction {
  TRNTYPE?: string;
  DTPOSTED?: string;
  DTUSER?:   string;
  TRNAMT?:   string;
  FITID?:    string;
  NAME?:     string;
  MEMO?:     string;
  CHECKNUM?: string;
}

function parseOfxSgml(ofxContent: string): OfxTransaction[] {
  const results: OfxTransaction[] = [];
  // Match all STMTTRN blocks
  const blockRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(ofxContent)) !== null) {
    const block = blockMatch[1];
    const tx: OfxTransaction = {};

    const fieldRegex = /<(\w+)>([^<\r\n]*)/g;
    let fieldMatch;
    while ((fieldMatch = fieldRegex.exec(block)) !== null) {
      const key = fieldMatch[1].toUpperCase() as keyof OfxTransaction;
      tx[key] = fieldMatch[2].trim();
    }

    results.push(tx);
  }

  return results;
}

function parseOfxDate(dateStr: string | undefined): Date {
  if (!dateStr) return new Date();
  // Format: YYYYMMDDHHMMSS[.xxx][+TZ] or YYYYMMDD
  const clean = dateStr.replace(/[+\-]\d+:\d+$/, "").replace(/\.\d+$/, "");
  if (clean.length >= 8) {
    const year  = clean.slice(0, 4);
    const month = clean.slice(4, 6);
    const day   = clean.slice(6, 8);
    return new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  }
  return new Date(dateStr);
}

// ── CSV mapping ───────────────────────────────────────────────────────────────

export interface CsvMapping {
  dateCol:         string;
  amountCol:       string;
  descriptionCol:  string;
  entryTypeCol?:   string;   // Column that indicates debit/credit
  debitIndicator?: string;   // Value in entryTypeCol that means DEBIT
  creditIndicator?: string;  // Value in entryTypeCol that means CREDIT
  amountSignIndicatesType?: boolean; // If true, negative = DEBIT
  documentNumberCol?: string;
  counterpartyCol?:   string;
  dateFormat?:        string; // 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY'
}

function parseDate(value: string, format?: string): Date {
  if (!format || format === "YYYY-MM-DD") return new Date(value);
  if (format === "DD/MM/YYYY") {
    const [dd, mm, yyyy] = value.split("/");
    return new Date(`${yyyy}-${mm}-${dd}`);
  }
  if (format === "MM/DD/YYYY") {
    const [mm, dd, yyyy] = value.split("/");
    return new Date(`${yyyy}-${mm}-${dd}`);
  }
  return new Date(value);
}

// ── Service ───────────────────────────────────────────────────────────────────

export const ofxImportService = {
  async importOfx(
    emitenteId:    string,
    bankAccountId: string,
    ofxContent:    string,
    importedBy?:   string
  ) {
    const transactions = parseOfxSgml(ofxContent);
    let recordsNew = 0;
    let recordsTotal = 0;

    for (const tx of transactions) {
      recordsTotal++;

      const fitid    = tx.FITID;
      const externalId = fitid ??
        createHash("sha256")
          .update(`${tx.DTPOSTED}:${tx.TRNAMT}:${tx.TRNTYPE}:${tx.MEMO ?? ""}`)
          .digest("hex")
          .slice(0, 40);

      const existing = await prisma.bankStatement.findFirst({
        where: { bankAccountId, externalId },
      });
      if (existing) continue;

      const rawAmount = parseFloat(tx.TRNAMT ?? "0");
      const amount    = Math.abs(rawAmount);
      const entryType: "DEBIT" | "CREDIT" =
        tx.TRNTYPE === "CREDIT" || rawAmount > 0 ? "CREDIT" : "DEBIT";

      await prisma.bankStatement.create({
        data: {
          emitenteId,
          bankAccountId,
          externalId,
          entryDate:       parseOfxDate(tx.DTPOSTED),
          valueDate:       tx.DTUSER ? parseOfxDate(tx.DTUSER) : undefined,
          amount,
          entryType,
          description:     tx.NAME ?? tx.MEMO ?? "",
          documentNumber:  tx.CHECKNUM,
          source:          "OFX_IMPORT",
          createdByUserId: importedBy,
          rawData:         tx as any,
        },
      });

      recordsNew++;
    }

    return { recordsTotal, recordsNew };
  },

  async importCsv(
    emitenteId:    string,
    bankAccountId: string,
    csvContent:    string,
    mapping:       CsvMapping,
    importedBy?:   string
  ) {
    const parsed = Papa.parse<Record<string, string>>(csvContent, {
      header:        true,
      skipEmptyLines: true,
      dynamicTyping: false,
    });

    const rows = parsed.data;
    let recordsNew = 0;
    let recordsTotal = 0;

    for (const row of rows) {
      recordsTotal++;

      const dateStr  = row[mapping.dateCol]        ?? "";
      const amtStr   = row[mapping.amountCol]      ?? "0";
      const desc     = row[mapping.descriptionCol] ?? "";

      const rawAmount = parseFloat(amtStr.replace(/[^0-9,.-]/g, "").replace(",", "."));
      if (isNaN(rawAmount)) continue;

      let entryType: "DEBIT" | "CREDIT" = "CREDIT";
      if (mapping.amountSignIndicatesType) {
        entryType = rawAmount < 0 ? "DEBIT" : "CREDIT";
      } else if (mapping.entryTypeCol) {
        const indicator = row[mapping.entryTypeCol] ?? "";
        entryType = indicator === (mapping.debitIndicator ?? "D") ? "DEBIT" : "CREDIT";
      }

      const amount = Math.abs(rawAmount);
      let   date: Date;
      try {
        date = parseDate(dateStr, mapping.dateFormat);
        if (isNaN(date.getTime())) continue;
      } catch {
        continue;
      }

      const externalId = createHash("sha256")
        .update(`${bankAccountId}:${dateStr}:${amtStr}:${desc}`)
        .digest("hex")
        .slice(0, 40);

      const existing = await prisma.bankStatement.findFirst({
        where: { bankAccountId, externalId },
      });
      if (existing) continue;

      await prisma.bankStatement.create({
        data: {
          emitenteId,
          bankAccountId,
          externalId,
          entryDate:        date,
          amount,
          entryType,
          description:      desc,
          documentNumber:   mapping.documentNumberCol ? row[mapping.documentNumberCol] : undefined,
          counterpartyName: mapping.counterpartyCol   ? row[mapping.counterpartyCol]   : undefined,
          source:           "OFX_IMPORT",
          createdByUserId:  importedBy,
          rawData:          row as any,
        },
      });

      recordsNew++;
    }

    return { recordsTotal, recordsNew };
  },

  async previewCsv(csvContent: string) {
    const parsed = Papa.parse<Record<string, string>>(csvContent, {
      header:        true,
      skipEmptyLines: true,
      preview:       11,
    });

    const headers = parsed.meta.fields ?? [];
    const rows    = parsed.data.slice(0, 10);

    // Suggest mapping based on header names
    const suggestedMapping: Partial<CsvMapping> = {};

    for (const h of headers) {
      const lower = h.toLowerCase();
      if (!suggestedMapping.dateCol && /data|date|dt/.test(lower)) {
        suggestedMapping.dateCol = h;
      }
      if (!suggestedMapping.amountCol && /valor|amount|value|vl/.test(lower)) {
        suggestedMapping.amountCol = h;
      }
      if (!suggestedMapping.descriptionCol && /desc|hist|memo|obs/.test(lower)) {
        suggestedMapping.descriptionCol = h;
      }
      if (!suggestedMapping.entryTypeCol && /tipo|type|operacao|op/.test(lower)) {
        suggestedMapping.entryTypeCol = h;
      }
      if (!suggestedMapping.counterpartyCol && /nome|name|pag|rec|favorecido/.test(lower)) {
        suggestedMapping.counterpartyCol = h;
      }
      if (!suggestedMapping.documentNumberCol && /doc|num|cheque|check/.test(lower)) {
        suggestedMapping.documentNumberCol = h;
      }
    }

    return { headers, rows, suggestedMapping };
  },
};
