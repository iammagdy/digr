import { digitsOf } from "./mask";
import { colIndex, detectHeaderRow } from "./profile";
import { ROLES, type ContactRow, type CountResult, type ParsedSheetFile, type Role, type SectorCount, type SheetMapping, type SheetReport } from "./types";

/**
 * COUNTING IS DONE BY CODE. The model only says which column is which; these functions count the real cells, the way the owner's files are built:
 *   - row 1 may be a TITLE (merged across the table), the headers are the first wide text row, the data follows. Header and title rows are never counted.
 *   - a company row has the company name; the rows below it with an EMPTY company cell are MORE CONTACTS of the same company (continuation rows).
 *   - the same company in several sheets or files of one sector (the overall list and its detail sheets, 4 files of one sector) is ONE company: an Arabic name OR an English
 *     name that matches counts once (alef / ya / tashkeel / spacing / case ignored). Every repeat is reported («تم تجاهل ١٥١ تكرار»), never counted.
 *   - a contact is distinct per (company, name): the same person listed again in a detail sheet is ignored. A contact whose name starts with إدارة / قطاع / قسم /
 *     Department / Procurement… is a DEPARTMENT («جهة تواصل إدارية»), shown separately; the owner can move rows between the two lists.
 *   - e-mails and phones are information (a manager is ONE billable item with whatever contact data was found): distinct valid addresses, distinct numbers by their digits
 *     (several per cell separated by « / », «(Ext. 142)» ignored, +20 / 0020 / a lost leading 0 are one number; fewer than 7 digits are reported, not counted).
 */
const TASHKEEL = /[ً-ٰٟـ]/g;

/** one company name -> its comparison key */
export function normCompany(v: string): string {
  return v.normalize("NFKC").replace(TASHKEEL, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").replace(/^[\s.\-_,;:]+|[\s.\-_,;:]+$/g, "").toLowerCase();
}

/** «كهروميكانيكا ٢» / «كهروميكانيكا - ملف 3» / «petrol (2)» -> «كهروميكانيكا»: the parts of one sector are not different sectors */
export function sectorBase(name: string): string {
  const base = name.replace(/\s+/g, " ").trim().replace(/[\s\-_–—:]*[(\[]?\s*(?:ملف|جزء|الجزء|part|file)?\s*[0-9٠-٩]+\s*[)\]]?\s*$/i, "").trim();
  return base === "" ? name.trim() : base;
}
export const normSector = (name: string): string => normCompany(sectorBase(name));

const HONORIFIC = /^(?:م|د|أ|ا|مهندس|مهندسة|دكتور|دكتورة|استاذ|أستاذ|الأستاذ|الاستاذ|السيد|السيدة|eng|dr|mr|mrs|ms)(?:\.|\s)\s*/i;
/** a person's name key: honorifics («م.» «د.» «الأستاذ») and spacing do not make two people */
export function normName(v: string): string {
  let n = normCompany(v);
  for (let i = 0; i < 2; i++) n = n.replace(HONORIFIC, "");
  return n;
}

const DEPT_AR = /^(?:ال)?(?:ادارة|قطاع|قسم)(?=\s|$)/;
const DEPT_EN = /^(?:department|dept\.?|procurement|purchasing)(?=\s|$)/;
/** «إدارة المشتريات والعقود», «قطاع المشتريات…», «قسم التوريدات», «Procurement Department», «Department of Contracts» */
export function isDepartment(name: string): boolean {
  const n = normCompany(name);
  return DEPT_AR.test(n) || DEPT_EN.test(n);
}

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
/** an extension is not part of the number: «(Ext. 142)», «ext 5», «داخلي 12» are removed first */
const stripExtension = (s: string): string => s.replace(/\([^)]*\)/g, " ").replace(/(?:ext(?:ension)?|داخلي|تحويلة)\.?\s*[:.]?\s*[0-9٠-٩]+/gi, " ");
export function phonesIn(cell: string): { valid: string[]; ignored: number } {
  const valid: string[] = [];
  let ignored = 0;
  for (const part of cell.split(/[/;,،|\n]+/)) {
    const cleaned = stripExtension(part);
    if (cleaned.trim() === "") continue;
    const d = normPhone(cleaned);
    if (d.length >= 7) valid.push(d); else ignored += 1;
  }
  return { valid, ignored };
}

// ---------------------------------------------------------------- reading one sheet

interface Rec {
  sheet: number;
  sector: string;
  ar: string;
  en: string;
  contacts: string[];
  emails: string[];
  phones: string[];
  invalidEmails: number;
  ignoredPhones: number;
}
interface SheetData {
  m: SheetMapping;
  file: ParsedSheetFile;
  sheetName: string;
  headerIdx: number;
  dataRows: number;
  used: SheetReport["used"];
  hasSectorColumn: boolean;
  defaultSector: string;
  recs: Rec[];
  truncated: boolean;
}

const stem = (file: string): string => file.replace(/\.[A-Za-z0-9]+$/, "").trim();

function readSheet(file: ParsedSheetFile, m: SheetMapping, index: number): SheetData | null {
  const sheet = file.sheets.find((s) => s.name === m.sheet);
  if (!sheet) return null;
  const headerIdx = detectHeaderRow(sheet.rows);
  const header = sheet.rows[headerIdx] ?? [];
  const data = sheet.rows.slice(headerIdx + 1);
  const idx = {} as Partial<Record<Role, number>>;
  const used: SheetReport["used"] = {};
  for (const role of ROLES) {
    const letter = m.columns[role];
    if (letter) { idx[role] = colIndex(letter); used[role] = { col: letter.toUpperCase(), header: header[colIndex(letter)] ?? "" }; }
  }
  const defaultSector = ((m.sectorName && m.sectorName.trim()) || stem(file.name)).replace(/\s+/g, " ");
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  const cellOf = (row: string[], role: Role): string => (idx[role] === undefined ? "" : (row[idx[role] as number] ?? "").trim());
  for (const row of data) {
    const ar = cellOf(row, "company"), en = cellOf(row, "company_en");
    if (ar !== "" || en !== "") {
      const sectorCell = cellOf(row, "sector");
      cur = { sheet: index, sector: sectorCell !== "" ? sectorCell : defaultSector, ar, en, contacts: [], emails: [], phones: [], invalidEmails: 0, ignoredPhones: 0 };
      recs.push(cur);
    } else if (cur === null) {
      // contact rows before any company: they belong to no company (kept, never counted as a company)
      cur = { sheet: index, sector: cellOf(row, "sector") || defaultSector, ar: "", en: "", contacts: [], emails: [], phones: [], invalidEmails: 0, ignoredPhones: 0 };
      recs.push(cur);
    }
    const target = cur as Rec;
    const name = cellOf(row, "manager");
    if (name !== "") target.contacts.push(name);
    const mail = cellOf(row, "email");
    if (mail !== "") { const r = emailsIn(mail); target.emails.push(...r.valid); if (r.invalid > 0 && r.valid.length === 0) target.invalidEmails += 1; }
    const tel = cellOf(row, "phone");
    if (tel !== "") { const r = phonesIn(tel); target.phones.push(...r.valid); target.ignoredPhones += r.ignored; }
  }
  return { m, file, sheetName: m.sheet, headerIdx, dataRows: data.length, used, hasSectorColumn: idx.sector !== undefined, defaultSector, recs, truncated: sheet.truncatedColumns };
}

// ---------------------------------------------------------------- union-find over company keys

class Union {
  private parent = new Map<string, string>();
  find(k: string): string {
    if (!this.parent.has(k)) this.parent.set(k, k);
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cur = k;
    while (cur !== root) { const next = this.parent.get(cur) as string; this.parent.set(cur, root); cur = next; }
    return root;
  }
  join(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); // the smaller key is the representative: stable
  }
}
const keysOf = (r: Rec): string[] => [normCompany(r.ar) !== "" ? `a:${normCompany(r.ar)}` : "", normCompany(r.en) !== "" ? `e:${normCompany(r.en)}` : ""].filter(Boolean);

// ---------------------------------------------------------------- the count

interface SectorAcc { key: string; name: string; recs: Rec[] }

export function countByMapping(files: ParsedSheetFile[], mappings: SheetMapping[], inferred: ReadonlySet<string> = new Set()): CountResult {
  const sheets: SheetData[] = [];
  const notes: string[] = [];
  mappings.forEach((m) => {
    const file = files.find((f) => f.name === m.file);
    const data = file ? readSheet(file, m, sheets.length) : null;
    if (data) { sheets.push(data); if (data.truncated) notes.push(`الورقة «${m.sheet}» فيها أعمدة كثيرة؛ قُرئت أول ٤٠ عمودًا فقط.`); }
  });

  // 1. one sector per file when its sheets (no sector column) list the same companies: «the overall list and its details» are one sector, whatever the model called each sheet
  const unionSheets = new Union();
  const companyKeys = sheets.map((s) => new Set(s.recs.flatMap(keysOf)));
  for (let i = 0; i < sheets.length; i++) for (let j = i + 1; j < sheets.length; j++) {
    if (sheets[i].file !== sheets[j].file || sheets[i].hasSectorColumn || sheets[j].hasSectorColumn) continue;
    const a = companyKeys[i], b = companyKeys[j];
    const small = Math.min(a.size, b.size);
    if (small === 0) continue;
    let both = 0;
    for (const k of a) if (b.has(k)) both += 1;
    if (both / small >= 0.5) unionSheets.join(String(i), String(j));
  }
  const sectorOfSheet = new Map<number, string>();
  sheets.forEach((s, i) => { if (!s.hasSectorColumn) { const group = sheets.map((_, k) => k).filter((k) => unionSheets.find(String(k)) === unionSheets.find(String(i)) && !sheets[k].hasSectorColumn); const lead = group.reduce((best, k) => (sheets[k].recs.length > sheets[best].recs.length ? k : best), group[0]); sectorOfSheet.set(i, sheets[lead].defaultSector); } });

  // 2. records per sector (the sector of a record is its sheet's, or its own sector cell)
  const sectors = new Map<string, SectorAcc>();
  const sectorKeyOfRec = new Map<Rec, string>();
  for (const [i, s] of sheets.entries()) {
    for (const r of s.recs) {
      const name = sectorBase(s.hasSectorColumn ? r.sector : sectorOfSheet.get(i) ?? s.defaultSector);
      const key = normSector(name);
      let acc = sectors.get(key);
      if (!acc) { acc = { key, name: name.replace(/\s+/g, " ").trim(), recs: [] }; sectors.set(key, acc); }
      acc.recs.push(r);
      sectorKeyOfRec.set(r, key);
    }
  }

  // 3. per sector: distinct companies (Arabic OR English name), distinct contacts per company, distinct e-mails and phones
  const out: SectorCount[] = [];
  const rootOfRec = new Map<Rec, string>();
  let duplicateCompanies = 0;
  for (const acc of sectors.values()) {
    const u = new Union();
    for (const r of acc.recs) { const ks = keysOf(r); ks.forEach((k) => u.find(k)); for (let i = 1; i < ks.length; i++) u.join(ks[0], ks[i]); }
    const withCompany = acc.recs.filter((r) => keysOf(r).length > 0);
    const roots = new Set(withCompany.map((r) => u.find(keysOf(r)[0])));
    const dupCompanies = withCompany.length - roots.size;
    duplicateCompanies += dupCompanies;
    const display = new Map<string, string>();
    for (const r of withCompany) { const root = u.find(keysOf(r)[0]); if (!display.has(root)) display.set(root, r.ar || r.en); }

    const contactIds = new Set<string>();
    const contacts: ContactRow[] = [];
    let contactRows = 0;
    const emails = new Set<string>(), phones = new Set<string>();
    let invalidEmails = 0, ignoredPhones = 0;
    for (const r of acc.recs) {
      const root = keysOf(r).length ? u.find(keysOf(r)[0]) : "~none";
      rootOfRec.set(r, root);
      for (const name of r.contacts) {
        contactRows += 1;
        const id = `${acc.key}|${root}|${normName(name)}`;
        if (contactIds.has(id)) continue;
        contactIds.add(id);
        contacts.push({ id, name, company: display.get(root) ?? "", kind: isDepartment(name) ? "department" : "person" });
      }
      r.emails.forEach((e) => emails.add(e)); r.phones.forEach((p) => phones.add(p));
      invalidEmails += r.invalidEmails; ignoredPhones += r.ignoredPhones;
    }
    out.push({
      sector: acc.name, companies: roots.size, managers: contacts.filter((c) => c.kind === "person").length, departments: contacts.filter((c) => c.kind === "department").length,
      emails: emails.size, phones: phones.size, duplicateCompanies: dupCompanies, duplicateContacts: contactRows - contacts.length, invalidEmails, ignoredPhones, contacts,
    });
  }

  // 4. which sheet is the OVERALL list: its companies contain those of the other sheets of the same file (they are its details)
  const sheetRoots = sheets.map((s) => new Set(s.recs.filter((r) => keysOf(r).length > 0).map((r) => `${sectorKeyOfRec.get(r)}|${rootOfRec.get(r)}`)));
  const roleOf: SheetReport["role"][] = sheets.map(() => "normal");
  for (const file of new Set(sheets.map((s) => s.file))) {
    const members = sheets.map((s, i) => (s.file === file ? i : -1)).filter((i) => i >= 0 && sheetRoots[i].size > 0);
    if (members.length < 2) continue;
    const overall = members.find((a) => members.every((b) => b === a || (sheetRoots[a].size > sheetRoots[b].size && [...sheetRoots[b]].filter((k) => !sheetRoots[a].has(k)).length / sheetRoots[b].size <= 0.05)));
    if (overall === undefined) continue;
    for (const i of members) roleOf[i] = i === overall ? "overall" : "detail";
  }

  const reports: SheetReport[] = sheets.map((s, i) => ({
    file: s.m.file, sheet: s.sheetName, dataRows: s.dataRows, headerRow: s.headerIdx + 1, companyRows: s.recs.filter((r) => keysOf(r).length > 0).length, role: roleOf[i],
    inferred: inferred.has(`${s.m.file}\u0000${s.sheetName}`), used: s.used, sector: s.hasSectorColumn ? null : sectorBase(sectorOfSheet.get(i) ?? s.defaultSector),
  }));
  return { sectors: out.filter((s) => s.companies + s.managers + s.departments + s.emails + s.phones > 0), sheets: reports, notes, duplicateCompanies };
}
