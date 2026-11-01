import { arabicShare, flagIsSet, isEnabled, startsWithHandle, filterVerdict, type StageFilter } from "./filters";

/**
 * THE MARKS OF A RAW ROW (docs/REDESIGN.md section 5, S1 items 1.1 and 1.2; owner decisions D7, D8). In raw delivery nothing is removed because of what it says; instead the row carries what is true of it, computed ONCE here and read by the
 * file builder: whether it is a reply or an original, a repost, the language of its text, whether it is inside the period asked, and whether it is from the source the customer named. A mark the request did not ask about and nothing in the row shows is `null`
 * (written «غير محدد»). Pure: no I/O.
 */
export const MARKS_KEY = "__marks";
export interface RowMarks { reply: boolean | null; repost: boolean | null; lang: "ar" | "other" | null; inPeriod: boolean | null; named: boolean | null }

const REPLY_FIELD = /^(is_?reply|reply|in_?reply_?to.*|is_?comment_?reply)$/i;
const REPOST_FIELD = /^(is_?repost|is_?retweet|retweeted|is_?share|reposted)$/i;
const LANG_FIELD = /^(lang|language|comment_?language|lang_?code)$/i;

const fieldOf = (row: Record<string, unknown>, re: RegExp): string | null => Object.keys(row).find((k) => re.test(k)) ?? null;
const langCode = (v: unknown): string | null => { const t = String(v ?? "").trim().toLowerCase(); return /^[a-z]{2,3}(-[a-z]{2,4})?$/.test(t) ? t.slice(0, 2) : null; };

/** What is true of one mapped row, from the stage's typed filters (their fields and values) and from the row itself when the stage declares no filter for it. Never removes anything. */
export function markVerdict(filters: ReadonlyArray<StageFilter> | undefined, mapped: Record<string, unknown>, ctx: { textKey: string | null; now: number; listing?: boolean }): RowMarks {
  const on = (filters ?? []).filter(isEnabled);
  const text = ctx.textKey ? String(mapped[ctx.textKey] ?? "") : "";
  const replyFilter = on.find((f) => f.kind === "exclude_replies");
  const replyField = replyFilter?.field ?? fieldOf(mapped, REPLY_FIELD);
  const reply = startsWithHandle(text) || (replyField ? flagIsSet(mapped[replyField]) : false);
  const repostFilter = on.find((f) => f.kind === "exclude_reposts");
  const repostField = repostFilter?.field ?? fieldOf(mapped, REPOST_FIELD);
  const repost = repostField ? flagIsSet(mapped[repostField]) : /^\s*RT\s+@/.test(text);
  const langFilter = on.find((f) => f.kind === "language");
  const langField = langFilter?.field ?? fieldOf(mapped, LANG_FIELD);
  const fromField = langField ? langCode(mapped[langField]) : null;
  let lang: RowMarks["lang"] = null;
  if (fromField) lang = fromField === "ar" ? "ar" : "other";
  else { const share = arabicShare(text); if (share !== null) lang = share >= 0.5 ? "ar" : "other"; }
  const period = on.find((f) => f.kind === "period");
  const inPeriod = period ? filterVerdict([period], mapped, { textKey: ctx.textKey, now: ctx.now, cairoDays: true }) === null : null;
  const account = on.find((f) => f.kind === "account" && (f.values ?? []).length > 0);
  const named = account ? filterVerdict([account], mapped, { textKey: ctx.textKey, now: ctx.now, ...(ctx.listing ? { listing: true } : {}) }) === null : null;
  return { reply, repost, lang, inPeriod, named };
}

/** The titles of the five mark columns, in the order they are added to the first sheet. */
export const MARK_COLUMNS_AR = { reply: "رد أم أصلي", repost: "إعادة نشر", lang: "لغة النص", inPeriod: "ضمن الفترة المطلوبة", named: "المصدر المسمّى" } as const;
export const MARK_COLUMN_ORDER: ReadonlyArray<keyof RowMarks> = ["reply", "repost", "lang", "inPeriod", "named"];
const UNKNOWN_AR = "غير محدد";
const yesNo = (v: boolean | null): string => (v === null ? UNKNOWN_AR : v ? "نعم" : "لا");

/** The cell a mark column shows for a row's marks. */
export function markCellAr(key: keyof RowMarks, marks: Partial<RowMarks> | null | undefined): string {
  const m = marks ?? {};
  switch (key) {
    case "reply": return m.reply === null || m.reply === undefined ? UNKNOWN_AR : m.reply ? "رد" : "أصلي";
    case "lang": return m.lang === "ar" ? "العربية" : m.lang === "other" ? "لغة أخرى" : UNKNOWN_AR;
    default: return yesNo((m[key] as boolean | null | undefined) ?? null);
  }
}
