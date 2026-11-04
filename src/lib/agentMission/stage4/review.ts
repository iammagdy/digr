import { normalizeDigits, toArabicDigits } from "../../arabicDigits";
import { COMMENT_KIND_COMMENT_AR, COMMENT_KIND_TITLE_AR, REPLY_TO_TITLE_AR } from "../taskContracts";
import { countedAr } from "./countAr";
import { ID_HEADER, PARENT_HEADER, type FileVersion } from "./versions";

/**
 * STAGE 4, THE REVIEW (docs/STAGE-4.md, FOUNDATION-PLAN PR 6): an optional paid check of a delivered file that gives a REPORT and a SCORE, column by column. It NEVER deletes or changes a row:
 * it reads a frozen version (versions.ts) and returns counts and row ids only. A fix the customer asks for after reading it is a NEW version (editVersion.ts); the delivered version stays.
 * The review's price is shown by code (quotes.ts `reviewQuote`); no charge is wired (the money PR). Pure, no model: the checks are the file's own rules, written in code.
 *
 * Checks (by the column's header): an empty cell with nothing said, an e-mail that is not one, a phone with fewer than 7 digits, a link that is not a web address, a date that is not a date,
 * and an exact duplicate (every value of a row the same as an earlier row's). A stated gap («غير متوفر», «غير متاح», «لم يكتمل البحث») is reported, never counted as a fault.
 * Score = the share of sound cells (0 to 100, rounded down); a duplicate row's cells count as faults.
 */
export const REVIEW_CODES = ["empty_cells", "invalid_email", "invalid_phone", "invalid_link", "invalid_date", "exact_duplicate", "stated_gap"] as const;
export type ReviewCode = (typeof REVIEW_CODES)[number];
export interface ReviewIssue { code: ReviewCode; sheet: string; column: string; count: number; /** The first 20 row ids. */ rowIds: string[] }
export interface ReviewResult {
  score: number;
  /** The readable cells reviewed (the id columns are not counted): the base of the review's price. */
  cells: number;
  rowsReviewed: number;
  issues: ReviewIssue[];
  reportAr: string[];
}

const n = (x: number): string => toArabicDigits(x);
/**
 * THE WHITELIST of the report's sentences: one per code. Each counts in correct Arabic (S5, countAr.ts: «خانة واحدة», «خانتان», «٣ خانات», «١١ خانة») and the words that agree with the count agree with it
 * (the dual takes the dual verb and adjective: «قيمتان لا تبدوان»; the elative «أقصر من» does not change).
 */
export const REVIEW_ISSUE_AR: Readonly<Record<ReviewCode, (column: string, count: number) => string>> = {
  empty_cells: (c, k) => `«${c}»: ${countedAr(k, { one: "خانة واحدة فارغة", two: "خانتان فارغتان", few: "خانات فارغة", many: "خانة فارغة" })} دون ذكر السبب.`,
  invalid_email: (c, k) => `«${c}»: ${countedAr(k, { one: "قيمة واحدة لا تبدو", two: "قيمتان لا تبدوان", few: "قيم لا تبدو", many: "قيمة لا تبدو" })} عنوان إيميل صحيحًا.`,
  invalid_phone: (c, k) => `«${c}»: ${countedAr(k, { one: "رقم هاتف واحد", two: "رقما هاتف", few: "أرقام هاتف", many: "رقم هاتف" })} أقصر من سبعة أرقام.`,
  invalid_link: (c, k) => `«${c}»: ${countedAr(k, { one: "قيمة واحدة ليست", two: "قيمتان ليستا", few: "قيم ليست", many: "قيمة ليست" })} رابطًا كاملًا.`,
  invalid_date: (c, k) => `«${c}»: ${countedAr(k, { one: "قيمة واحدة لا تُقرأ", two: "قيمتان لا تُقرآن", few: "قيم لا تُقرأ", many: "قيمة لا تُقرأ" })} كتاريخ.`,
  exact_duplicate: (c, k) => `«${c}»: ${countedAr(k, { one: "عنصر واحد مكرر", two: "عنصران مكرران", few: "عناصر مكررة", many: "عنصرًا مكررًا" })} تمامًا، ولم يُحذف شيء.`,
  stated_gap: (c, k) => `«${c}»: ${countedAr(k, { one: "خانة واحدة ذُكر فيها", two: "خانتان ذُكر فيهما", few: "خانات ذُكر فيها", many: "خانة ذُكر فيها" })} أن القيمة غير متاحة أو لم يكتمل البحث عنها.`,
};

const STATED_GAP = /^(?:غير متوفر|غير متاح|غير متاح من المصدر|لم يكتمل البحث|غير محدد|غير محددة)$/;
const EMAIL_COL = /إيميل|ايميل|البريد/;
const PHONE_COL = /هاتف|محمول|موبايل|جوال/;
const LINK_COL = /رابط|الموقع الإلكتروني|الموقع الالكتروني/;
const DATE_COL = /تاريخ/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?$/;

type Check = Exclude<ReviewCode, "empty_cells" | "exact_duplicate" | "stated_gap">;
const checkOf = (header: string): Check | null => (EMAIL_COL.test(header) ? "invalid_email" : PHONE_COL.test(header) ? "invalid_phone" : LINK_COL.test(header) ? "invalid_link" : DATE_COL.test(header) ? "invalid_date" : null);
function faulty(check: Check, value: string): boolean {
  const parts = value.split(/[\n,;،]+/).map((p) => p.trim()).filter(Boolean);
  switch (check) {
    case "invalid_email": return parts.some((p) => !EMAIL.test(p.replace(/^mailto:/i, "")));
    case "invalid_phone": return parts.some((p) => normalizeDigits(p).replace(/\D/g, "").length < 7);
    case "invalid_link": return parts.some((p) => !/^https?:\/\/\S+$/i.test(p));
    case "invalid_date": return !DATE_VALUE.test(normalizeDigits(value.replace(/^تقريبًا\s*/, "").trim()));
  }
}

const readable = (headers: ReadonlyArray<string>): number[] => headers.map((h, i) => (h === ID_HEADER || h === PARENT_HEADER ? -1 : i)).filter((i) => i >= 0);

/** The readable cells of a version (every row times every column but the id columns): what the review is priced on. */
export const reviewCellsOf = (v: FileVersion): number => v.sheets.reduce((sum, s) => sum + s.rows.length * readable(s.headers).length, 0);

export function reviewFile(v: FileVersion): ReviewResult {
  const issues: ReviewIssue[] = [];
  let cells = 0;
  let faults = 0;
  let rowsReviewed = 0;
  const add = (code: ReviewCode, sheet: string, column: string, rowIds: string[]): void => { if (rowIds.length > 0) issues.push({ code, sheet, column, count: rowIds.length, rowIds: rowIds.slice(0, 20) }); };
  for (const s of v.sheets) {
    const cols = readable(s.headers);
    rowsReviewed += s.rows.length;
    cells += s.rows.length * cols.length;
    const faultyCell = new Set<string>();
    const kindAt = s.headers.indexOf(COMMENT_KIND_TITLE_AR);
    // empty BY DESIGN: «معرّف التعليق الأصلي» names the comment a REPLY answers; on a comment's own row the file leaves it empty
    const emptyByDesign = (header: string, cells: ReadonlyArray<string>): boolean => header === REPLY_TO_TITLE_AR && kindAt >= 0 && cells[kindAt] === COMMENT_KIND_COMMENT_AR;
    for (const i of cols) {
      const header = s.headers[i];
      const check = checkOf(header);
      const empty: string[] = [], gap: string[] = [], bad: string[] = [];
      for (const r of s.rows) {
        const value = String(r.cells[i] ?? "").trim();
        if (value === "") { if (!emptyByDesign(header, r.cells)) { empty.push(r.id); faultyCell.add(`${r.id}|${i}`); } continue; }
        if (STATED_GAP.test(value)) { gap.push(r.id); continue; }
        if (check && faulty(check, value)) { bad.push(r.id); faultyCell.add(`${r.id}|${i}`); }
      }
      add("empty_cells", s.nameAr, header, empty);
      if (check) add(check, s.nameAr, header, bad);
      add("stated_gap", s.nameAr, header, gap);
    }
    // exact duplicates: every readable value equal to an earlier row's (reported only; nothing is removed)
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const r of s.rows) {
      const key = JSON.stringify(cols.map((i) => String(r.cells[i] ?? "").trim()));
      if (seen.has(key)) { dups.push(r.id); for (const i of cols) faultyCell.add(`${r.id}|${i}`); } else seen.add(key);
    }
    add("exact_duplicate", s.nameAr, s.nameAr, dups);
    faults += faultyCell.size;
  }
  const score = cells === 0 ? 100 : Math.max(0, Math.min(100, Math.floor((100 * (cells - faults)) / cells)));
  const order = (c: ReviewCode) => REVIEW_CODES.indexOf(c);
  issues.sort((a, b) => (a.sheet < b.sheet ? -1 : a.sheet > b.sheet ? 1 : 0) || order(a.code) - order(b.code) || (a.column < b.column ? -1 : a.column > b.column ? 1 : 0));
  const reportAr = [`التقييم: ${n(score)} من ١٠٠.`, ...issues.map((i) => REVIEW_ISSUE_AR[i.code](i.column, i.count))];
  return { score, cells, rowsReviewed, issues, reportAr };
}
