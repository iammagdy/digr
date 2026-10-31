import { normCompany } from "./count";
import { colLetter, detectHeaderRow } from "./profile";
import { ROLES, type ParsedSheetFile, type Role, type SheetMapping, type UnmappedSheet } from "./types";

/**
 * The model may map only some of a workbook's sheets (it mapped ONE detail sheet of three and 149 companies became 36). The code looks at EVERY sheet and never skips one silently:
 *   1. a sheet nobody mapped whose HEADERS match a mapped sheet's (same column titles, any order) gets that mapping: it is the same kind of list. Reported as «inferred».
 *   2. otherwise, a sheet with real data (3 rows or more, 2 columns or more) is put to the owner as a question («أحسبها؟»);
 *   3. anything smaller (a cover page, a note) is listed as ignored, with its size.
 */
const headerKey = (h: string): string => normCompany(h).replace(/[()\[\]:.\-_/\\]/g, " ").replace(/\s+/g, " ").trim();

function headerOf(file: ParsedSheetFile, sheetName: string): { header: string[]; rows: number } {
  const sheet = file.sheets.find((s) => s.name === sheetName);
  const rows = sheet?.rows ?? [];
  const at = detectHeaderRow(rows);
  return { header: rows[at] ?? [], rows: Math.max(0, rows.length - at - 1) };
}

export interface CompletedMappings { mappings: SheetMapping[]; inferred: Set<string>; unmapped: UnmappedSheet[] }

export function completeMappings(files: ParsedSheetFile[], mapped: SheetMapping[]): CompletedMappings {
  const mappings = [...mapped];
  const inferred = new Set<string>();
  const unmapped: UnmappedSheet[] = [];
  const has = (file: string, sheet: string) => mappings.some((m) => m.file === file && m.sheet === sheet);
  for (const file of files) {
    for (const sheet of file.sheets) {
      if (has(file.name, sheet.name)) continue;
      const { header, rows } = headerOf(file, sheet.name);
      const keys = header.map(headerKey);
      const candidates = [...mappings.filter((m) => m.file === file.name), ...mappings.filter((m) => m.file !== file.name)];
      let found: SheetMapping | null = null;
      for (const m of candidates) {
        const src = files.find((f) => f.name === m.file);
        if (!src) continue;
        const srcHeader = headerOf(src, m.sheet).header.map(headerKey);
        const columns: Partial<Record<Role, string>> = {};
        let wanted = 0, matched = 0;
        for (const role of ROLES) {
          const letter = m.columns[role];
          if (!letter) continue;
          wanted += 1;
          const title = srcHeader[letter.toUpperCase().split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1];
          const at = title ? keys.indexOf(title) : -1;
          if (at >= 0) { columns[role] = colLetter(at); matched += 1; }
        }
        if (matched >= Math.max(2, Math.ceil(wanted * 0.6)) && (columns.company || columns.manager)) { found = { file: file.name, sheet: sheet.name, sectorName: columns.sector ? null : m.sectorName, columns }; break; }
      }
      if (found) { mappings.push(found); inferred.add(`${file.name}\u0000${sheet.name}`); continue; }
      const width = header.filter((h) => h !== "").length;
      unmapped.push({ file: file.name, sheet: sheet.name, rows, columns: width, status: rows >= 3 && width >= 2 ? "ask" : "ignored" });
    }
  }
  return { mappings, inferred, unmapped };
}
