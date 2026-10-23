import { normalizeEasternArabicDigits } from "./arabicNumbers";

/**
 * What the customer's activity panel counts, read from the page lines of the run («الصفحة ١: استلمنا ٥٠ سجل · الجديد ٣ · ... ·
 * مكرر أو مستبعد ٧ · قيد المراجعة ٤٠ · ...»). Display only: the counts come from the lines the worker already wrote, never from a guess.
 * `received` and `underReview` are null until a page line says so (an empty panel shows a dash, not a zero).
 */
export interface ActivityCounts {
  /** Records the source returned, over every page line. */
  received: number | null;
  /** Records held for the review sheet, over every page line. */
  underReview: number | null;
  /** Records dropped as repeated or not matching. */
  excluded: number;
}

const numberAfter = (text: string, label: string): number | null => {
  const match = text.match(new RegExp(`${label}\\s+(\\d+)`));
  return match && match[1] ? parseInt(match[1], 10) : null;
};

export function summarizeActivityCounts(events: Array<{ textAr: string }> | null | undefined): ActivityCounts {
  let received: number | null = null;
  let underReview: number | null = null;
  let fromPages = 0;
  let fromAudit = 0;
  for (const event of events || []) {
    const text = normalizeEasternArabicDigits(String(event.textAr || ""));
    if (/^\s*الصفحة\s+\d+/.test(text)) {
      const got = numberAfter(text, "استلمنا");
      if (got !== null) received = (received ?? 0) + got;
      const held = numberAfter(text, "قيد المراجعة");
      if (held !== null) underReview = (underReview ?? 0) + held;
    }
    const page = numberAfter(text, "مكرر أو مستبعد");
    if (page !== null) fromPages += page;
    const audit = text.match(/استبعاد\s+(\d+)\s+سجل\s+مكرر/);
    if (audit && audit[1]) fromAudit += parseInt(audit[1], 10);
  }
  // Per-page lines already include every exclusion of that page, so they win over the separate audit line.
  return { received, underReview, excluded: fromPages > 0 ? fromPages : fromAudit };
}
