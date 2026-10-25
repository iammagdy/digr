import { normalizeEasternArabicDigits } from "./arabicNumbers";

/**
 * What the customer's activity panel counts, read from the page lines of the run («الصفحة ١: استلمنا ٥٠ سجل · الجديد ٣ · ... ·
 * مكرر أو مستبعد ٧ · قيد المراجعة ٤٠ · ...»). Display only: the counts come from the lines the worker already wrote, never from a guess.
 * `received` and `underReview` are null until a page line says so (an empty panel shows a dash, not a zero).
 */
/** The label of the running total of received records the worker writes on every page line after the first. */
export const RECEIVED_SO_FAR_LABEL = "المستلم حتى الآن";
/** The label of the rows the date window removed on a page («خارج الفترة ٢٩»): counted with the other exclusions, so the panel's numbers add up. */
export const DATE_EXCLUDED_LABEL = "خارج الفترة";

export interface ActivityCounts {
  /** Records the source returned, over every page line. */
  received: number | null;
  /** Records held for the review sheet, over every page line. */
  underReview: number | null;
  /** Records dropped as repeated or not matching. */
  excluded: number;
}

/** The records of a page line: «استلمنا ٥٠ سجل», and the words a small count is written with («سجل واحد», «سجلين»). */
const receivedAfter = (text: string): number | null => {
  const digits = text.match(/استلمنا\s+(\d+)/);
  if (digits && digits[1]) return parseInt(digits[1], 10);
  if (/استلمنا\s+سجل\s+واحد/.test(text)) return 1;
  if (/استلمنا\s+سجلين/.test(text)) return 2;
  return null;
};

/** The repeated records the audit line removed: «استبعاد ٤ سجل مكرر», «٣ سجلات مكررة», «سجل واحد مكرر», «سجلين مكررين». */
const auditExcluded = (text: string): number | null => {
  const digits = text.match(/استبعاد\s+(\d+)\s+سجل(?:ات)?\s+مكرر/);
  if (digits && digits[1]) return parseInt(digits[1], 10);
  if (/استبعاد\s+سجل\s+واحد\s+مكرر/.test(text)) return 1;
  if (/استبعاد\s+سجلين\s+مكررين/.test(text)) return 2;
  return null;
};

const numberAfter = (text: string, label: string): number | null => {
  const match = text.match(new RegExp(`${label}\\s+(\\d+)`));
  return match && match[1] ? parseInt(match[1], 10) : null;
};

export function summarizeActivityCounts(events: Array<{ textAr: string }> | null | undefined): ActivityCounts {
  let received: number | null = null;
  let underReview: number | null = null;
  let fromPages = 0;
  let fromAudit = 0;
  // The panel reads only the newest events, so the page lines of a long job are not all there: the newest running total wins over a sum of
  // the lines that are. A job from before the total was written is summed as it always was.
  let runningTotal: number | null = null;
  for (const event of events || []) {
    const text = normalizeEasternArabicDigits(String(event.textAr || ""));
    if (/^\s*الصفحة\s+\d+/.test(text)) {
      const got = receivedAfter(text);
      if (got !== null) received = (received ?? 0) + got;
      const total = numberAfter(text, RECEIVED_SO_FAR_LABEL);
      if (total !== null) runningTotal = Math.max(runningTotal ?? 0, total);
      const held = numberAfter(text, "قيد المراجعة");
      if (held !== null) underReview = (underReview ?? 0) + held;
    }
    const page = numberAfter(text, "مكرر أو مستبعد");
    if (page !== null) fromPages += page;
    // A page line says «خارج الفترة N» for the rows the date window removed (only on lines that start with «الصفحة», like the other page counts).
    if (/^\s*الصفحة\s+\d+/.test(text)) {
      const byDate = numberAfter(text, DATE_EXCLUDED_LABEL);
      if (byDate !== null) fromPages += byDate;
    }
    const audit = auditExcluded(text);
    if (audit !== null) fromAudit += audit;
  }
  // Per-page lines already include every exclusion of that page, so they win over the separate audit line.
  return { received: runningTotal !== null ? Math.max(runningTotal, received ?? 0) : received, underReview, excluded: fromPages > 0 ? fromPages : fromAudit };
}
