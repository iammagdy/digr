import { colIndex, detectHeaderRow } from "./profile";
import { digitsOf } from "./mask";
import { ROLES, type CountResult, type ParsedSheetFile, type Role, type SectorCount, type SheetMapping, type SheetReport } from "./types";

/**
 * COUNTING IS DONE BY CODE. The model only says which column is which; these functions count the real cells.
 *   companies  distinct non-empty company names in the sector (spelling variants of alef / ya / tashkeel / spaces / case count once)
 *   managers   non-empty manager cells (one per row: two rows for one company are two managers)
 *   emails     distinct VALID addresses (a cell may hold several, separated by ; , / space); text that is not an address is reported, not counted
 *   phones     distinct numbers by their digits (a cell may hold several, separated by / ; , |); +20, 0020, a lost leading 0 and spacing count as the same number;
 *              a value with fewer than 7 digits is reported, not counted
 * Several sheets or files for the same sector are merged: the distinct sets are shared, so a company in two files counts once.
 */
const TASHKEEL = /[ً-ٰٟـ]/g;

/** one company name -> its comparison key */
export function normCompany(v: string): string {
  return v.normalize("NFKC").replace(TASHKEEL, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").replace(/^[\s.\-_,;:]+|[\s.\-_,;:]+$/g, "").toLowerCase();
}
export const normSector = normCompany;

const EMAIL_RE = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/** every VALID address in a cell (lower-cased) and whether the cell had text that is not one */
export function emailsIn(cell: string): { valid: string[]; invalid: number } {
  const valid: string[] = [];
  let invalid = 0;
  for (const raw of cell.split(/[\s;,،/|]+/)) {
    const token = raw.replace(/^[<("']+|[>)"'.]+$/g, "");
    if (token === "") continue;
    if (EMAIL_RE.test(token)) valid.push(token.toLowerCase()); else invalid += 1;
  }
  return { valid, invalid };
}

/** a phone's digits in one canonical form: «٠١٠٠…», «+20 10 …», «0020 10…», and a lost leading zero (Excel numbers) all become 0XXXXXXXXXX */
export function normPhone(part: string): string {
  let d = digitsOf(part);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("20")) d = `0${d.slice(2)}`;
  if (d.length === 10 && /^1[0125]/.test(d)) d = `0${d}`;
  return d;
}
export function phonesIn(cell: string): { valid: string[]; ignored: number } {
  const valid: string[] = [];
  let ignored = 0;
  for (const part of cell.split(/[/;,،|\n]+/)) {
    if (part.trim() === "") continue;
    const d = normPhone(part);
    if (d.length >= 7) valid.push(d); else ignored += 1;
  }
  return { valid, ignored };
}

interface Acc { sector: string; companies: Set<string>; managers: number; emails: Set<string>; phones: Set<string>; invalidEmails: number; ignoredPhones: number }

const stem = (file: string): string => file.replace(/\.[A-Za-z0-9]+$/, "").trim();

export function countByMapping(files: ParsedSheetFile[], mappings: SheetMapping[]): CountResult {
  const accs = new Map<string, Acc>();
  const reports: SheetReport[] = [];
  const notes: string[] = [];
  const accFor = (name: string): Acc => {
    const key = normSector(name);
    let a = accs.get(key);
    if (!a) { a = { sector: name.trim().replace(/\s+/g, " "), companies: new Set(), managers: 0, emails: new Set(), phones: new Set(), invalidEmails: 0, ignoredPhones: 0 }; accs.set(key, a); }
    return a;
  };

  for (const m of mappings) {
    const file = files.find((f) => f.name === m.file);
    const sheet = file?.sheets.find((s) => s.name === m.sheet);
    if (!file || !sheet) continue;
    const headerIdx = detectHeaderRow(sheet.rows);
    const header = sheet.rows[headerIdx] ?? [];
    const data = sheet.rows.slice(headerIdx + 1);
    const idx = {} as Partial<Record<Role, number>>;
    const used: SheetReport["used"] = {};
    for (const role of ROLES) {
      const letter = m.columns[role];
      if (letter) { idx[role] = colIndex(letter); used[role] = { col: letter.toUpperCase(), header: header[colIndex(letter)] ?? "" }; }
    }
    const fallbackSector = (m.sectorName && m.sectorName.trim()) || stem(file.name);
    const rowSector = (row: string[]): string => {
      if (idx.sector === undefined) return fallbackSector;
      const v = (row[idx.sector] ?? "").trim();
      return v === "" ? fallbackSector : v;
    };
    for (const row of data) {
      const acc = accFor(rowSector(row));
      const cell = (role: Role): string => (idx[role] === undefined ? "" : (row[idx[role] as number] ?? "").trim());
      const company = cell("company");
      if (company !== "") acc.companies.add(normCompany(company));
      if (cell("manager") !== "") acc.managers += 1;
      const e = cell("email");
      if (e !== "") { const r = emailsIn(e); r.valid.forEach((v) => acc.emails.add(v)); acc.invalidEmails += r.invalid > 0 && r.valid.length === 0 ? 1 : 0; }
      const p = cell("phone");
      if (p !== "") { const r = phonesIn(p); r.valid.forEach((v) => acc.phones.add(v)); acc.ignoredPhones += r.ignored; }
    }
    reports.push({ file: m.file, sheet: m.sheet, dataRows: data.length, headerRow: headerIdx + 1, used, sector: idx.sector === undefined ? fallbackSector : null });
    if (sheet.truncatedColumns) notes.push(`الورقة «${m.sheet}» فيها أعمدة كثيرة؛ قُرئت أول ٤٠ عمودًا فقط.`);
  }

  const sectors: SectorCount[] = [...accs.values()].map((a) => ({
    sector: a.sector, companies: a.companies.size, managers: a.managers, emails: a.emails.size, phones: a.phones.size, invalidEmails: a.invalidEmails, ignoredPhones: a.ignoredPhones,
  })).filter((s) => s.companies + s.managers + s.emails + s.phones > 0);
  return { sectors, sheets: reports, notes };
}
