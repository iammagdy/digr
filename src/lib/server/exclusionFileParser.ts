import ExcelJS from "exceljs";
import {
  EntityRecord,
  normalizeDomain,
  normalizeArabicText,
  extractBrandTokens,
  generateEntityFingerprint,
} from "./negativeListEngine";

export interface ExclusionSpec {
  baselineRowCount: number;
  companyNames: string[];
  corporateDomains: string[];
  normalizedEntities: EntityRecord[];
  brandFingerprints: string[];
}

const COMPANY_NAME_COLUMN_PATTERNS = [
  /اسم\s*(?:الشركة|المؤسسة|المنشأة|الكيان|الجهة)/i,
  /^الشركة$/i,
  /^المؤسسة$/i,
  /company\s*name/i,
  /^company$/i,
  /^organization$/i,
  /^org$/i,
  /^name$/i,
];

const DOMAIN_COLUMN_PATTERNS = [
  /الموقع\s*(?:الإلكتروني|الالكتروني|الرسمي)?/i,
  /^النطاق$/i,
  /^الرابط$/i,
  /^domain$/i,
  /^website$/i,
  /^url$/i,
  /^web$/i,
];

const CR_COLUMN_PATTERNS = [
  /السجل\s*التجاري/i,
  /الرقم\s*الضريبي/i,
  /^cr(?:\s*number|_number)?$/i,
  /cr\s*number/i,
  /^tax_id$/i,
  /tax\s*id/i,
  /^registration(?:\s*number)?$/i,
];

/**
 * Parses an uploaded exclusion spreadsheet (.xlsx or .csv) and produces
 * a privacy-safe, minimal ExclusionSpec containing only organization-level identifiers.
 * 
 * Strict privacy boundary:
 * - Never extracts or logs personal contact info (personal emails, personal phones, national IDs).
 * - Only permitted organizational attributes (company name, corporate domain, CR number).
 */
export async function parseExclusionFile(
  fileBuffer: Buffer,
  fileType: "xlsx" | "csv"
): Promise<ExclusionSpec> {
  const records: EntityRecord[] = [];

  if (fileType === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(fileBuffer as any);
    const ws = wb.worksheets[0];
    if (!ws) {
      return { baselineRowCount: 0, companyNames: [], corporateDomains: [], normalizedEntities: [], brandFingerprints: [] };
    }

    let headerRowIdx = 1;
    let nameColIdx = -1;
    let domainColIdx = -1;
    let crColIdx = -1;

    // Detect header row in first 5 rows
    for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
      const row = ws.getRow(r);
      row.eachCell((cell, colNumber) => {
        const val = String(cell.value || "").trim();
        if (COMPANY_NAME_COLUMN_PATTERNS.some((p) => p.test(val)) && nameColIdx === -1) {
          nameColIdx = colNumber;
          headerRowIdx = r;
        }
        if (DOMAIN_COLUMN_PATTERNS.some((p) => p.test(val)) && domainColIdx === -1) {
          domainColIdx = colNumber;
        }
        if (CR_COLUMN_PATTERNS.some((p) => p.test(val)) && crColIdx === -1) {
          crColIdx = colNumber;
        }
      });
      if (nameColIdx !== -1) break;
    }

    // Default to column 1 if no explicit header found
    if (nameColIdx === -1) nameColIdx = 1;

    ws.eachRow((row, rowNumber) => {
      if (rowNumber <= headerRowIdx) return;
      const rawName = String(row.getCell(nameColIdx).value || "").trim();
      if (!rawName || rawName.length < 2) return;

      const rawDomain = domainColIdx !== -1 ? String(row.getCell(domainColIdx).value || "").trim() : "";
      const rawCr = crColIdx !== -1 ? String(row.getCell(crColIdx).value || "").trim() : "";

      records.push({
        id: `base_${rowNumber}`,
        name: rawName,
        domain: normalizeDomain(rawDomain) || undefined,
        crNumber: rawCr || undefined,
      });
    });
  } else {
    // CSV Parsing
    const text = fileBuffer.toString("utf-8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) {
      return { baselineRowCount: 0, companyNames: [], corporateDomains: [], normalizedEntities: [], brandFingerprints: [] };
    }

    const header = lines[0].split(/[,;\t]/).map((h) => h.replace(/^["']|["']$/g, "").trim());
    let nameColIdx = header.findIndex((h) => COMPANY_NAME_COLUMN_PATTERNS.some((p) => p.test(h)));
    let domainColIdx = header.findIndex((h) => DOMAIN_COLUMN_PATTERNS.some((p) => p.test(h)));
    let crColIdx = header.findIndex((h) => CR_COLUMN_PATTERNS.some((p) => p.test(h)));

    if (nameColIdx === -1) nameColIdx = 0;

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/[,;\t]/).map((p) => p.replace(/^["']|["']$/g, "").trim());
      const rawName = parts[nameColIdx] || "";
      if (!rawName || rawName.length < 2) continue;

      const rawDomain = domainColIdx !== -1 ? parts[domainColIdx] || "" : "";
      const rawCr = crColIdx !== -1 ? parts[crColIdx] || "" : "";

      records.push({
        id: `base_${i}`,
        name: rawName,
        domain: normalizeDomain(rawDomain) || undefined,
        crNumber: rawCr || undefined,
      });
    }
  }

  const companyNames = Array.from(new Set(records.map((r) => r.name)));
  const corporateDomains = Array.from(new Set(records.map((r) => r.domain).filter(Boolean) as string[]));
  const brandFingerprints = Array.from(new Set(records.map((r) => generateEntityFingerprint(r.name, r.domain))));

  return {
    baselineRowCount: records.length,
    companyNames,
    corporateDomains,
    normalizedEntities: records,
    brandFingerprints,
  };
}
