/**
 * Some sources (YouTube among them) show when something was written only as «3 weeks ago» / «منذ ٣ أسابيع». That is a real publication
 * date, only coarse: «3 weeks ago» means between three and four weeks. It is read against the time of collection, at the middle of
 * the period it names, and every line that reports dates says that such dates are approximate.
 */

const DAY = 86_400_000;
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY };

const ARABIC_UNITS: Array<[RegExp, string]> = [
  [/ثاني[ةه]|ثوان[يى]?/u, "second"],
  [/دقيق[ةه]|دقائق/u, "minute"],
  [/ساع[ةه]|ساعات/u, "hour"],
  [/يوم|ايام|أيام/u, "day"],
  [/اسبوع|أسبوع|اسابيع|أسابيع/u, "week"],
  [/شهر|اشهر|أشهر|شهور/u, "month"],
  [/سن[ةه]|سنوات|سنين|عام|اعوام|أعوام/u, "year"],
];
const ARABIC_DUALS: Array<[RegExp, string]> = [
  [/ساعتين|ساعتان/u, "hour"], [/يومين|يومان/u, "day"], [/اسبوعين|أسبوعين|اسبوعان|أسبوعان/u, "week"],
  [/شهرين|شهران/u, "month"], [/سنتين|سنتان|عامين|عامان/u, "year"],
];

function latinDigits(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function agoMs(count: number, unit: string, now: number): number {
  const size = UNIT_MS[unit];
  // Coarse units name a period, not an instant: take its middle.
  const middle = unit === "second" || unit === "minute" || unit === "hour" ? 0 : 0.5;
  return now - (count + middle) * size;
}

/** The time a «N units ago» text stands for, or null when the text is not of that form. */
export function parseRelativeDateMs(value: unknown, now: number = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const text = latinDigits(value).trim().toLowerCase().replace(/\s+/g, " ");
  if (!text || text.length > 60) return null;

  if (/^(?:just now|now|الآن|الان)$/.test(text)) return now;
  if (/^(?:today|اليوم)$/.test(text)) return now - DAY / 2;
  if (/^(?:yesterday|أمس|امس)$/.test(text)) return now - 1.5 * DAY;

  // English: «3 weeks ago», «a month ago», «1 year ago», «Streamed 2 days ago» (the words before the number are ignored).
  const english = /(?:(\d+)|\b(?:a|an|one)\b)\s*(second|minute|hour|day|week|month|year)s?\s+ago\b/.exec(text);
  if (english) return agoMs(english[1] ? Number(english[1]) : 1, english[2], now);

  // Arabic: «منذ ٣ أسابيع», «قبل أسبوعين», «منذ شهر».
  if (/(?:^|\s)(?:منذ|قبل)\s/.test(`${text} `) || /^(?:منذ|قبل)/.test(text)) {
    for (const [pattern, unit] of ARABIC_DUALS) if (pattern.test(text)) return agoMs(2, unit, now);
    const counted = /(?:منذ|قبل)\s*(\d+)\s*(\S+)/u.exec(text);
    if (counted) {
      for (const [pattern, unit] of ARABIC_UNITS) if (pattern.test(counted[2])) return agoMs(Number(counted[1]), unit, now);
    }
    const single = /(?:منذ|قبل)\s*(\S+)/u.exec(text);
    if (single) for (const [pattern, unit] of ARABIC_UNITS) if (pattern.test(single[1])) return agoMs(1, unit, now);
  }
  return null;
}

/** The fields sources use for that kind of text. */
export const RELATIVE_DATE_FIELDS = [
  "published_time", "publishedTime", "published_time_text", "publishedTimeText", "published_text", "publishedText", "published",
  "time_ago", "timeAgo", "relative_time", "relativeTime", "time_text", "timeText", "time", "age", "posted", "posted_text", "date_text", "dateText", "when",
];

let clock: () => number = Date.now;
/** Test-only: a fixed clock for the relative dates. */
export function setRelativeDateClockForTesting(next: (() => number) | null): void {
  clock = next ?? Date.now;
}

/** The time a row's relative text stands for, or null; also tells which field it came from. */
export function relativeRowDate(row: Record<string, unknown>): { ms: number; field: string } | null {
  for (const field of RELATIVE_DATE_FIELDS) {
    const ms = parseRelativeDateMs(row[field], clock());
    if (ms !== null) return { ms, field };
  }
  return null;
}
