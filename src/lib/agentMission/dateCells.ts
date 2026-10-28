/**
 * DATES IN THE FILES, readable: a value that is a date and time (an ISO text, the long English form some sources return, a count of seconds or milliseconds since 1970) becomes a real spreadsheet date shown as
 * «٢٠٢٦-١٠-٢٨ ٢٣:٠٦» in Cairo time, so it sorts and filters; a CSV gets the same moment as a plain «2026-10-28 23:06». A value that is not a date is left exactly as it is.
 */
const CAIRO = "Africa/Cairo";

const DATE_WORDS_AR = /تاريخ|وقت|موعد|ساعة|نُشر|نشر|أُنشئ|أنشئ|نُشرت|تحديث/;
const DATE_KEY = /(^|_)(date|time|datetime|timestamp|created|createdat|created_at|createtime|create_time|published|publishedat|published_at|posted|postedat|posted_at|publish_time|updated|updated_at|when)(_|$)|(_at|time|date)$/i;

/** True when a column is about a moment: its Arabic title says so, or its key does. */
export const looksLikeDateColumn = (title: string, key?: string): boolean => DATE_WORDS_AR.test(title) || (key !== undefined && DATE_KEY.test(key));

/** The moment a value stands for, or null. Accepts ISO texts, «Wed Oct 28 20:06:00 +0000 2026», seconds and milliseconds since 1970 (only values in a sane range). */
export function parseMoment(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" || (typeof value === "string" && /^\d{9,13}$/.test(value.trim()))) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const ms = n >= 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100 ? d : null;
  }
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t || t.length > 64) return null;
  if (!/\d{4}|\d{1,2}:\d{2}/.test(t)) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000 || d.getUTCFullYear() > 2100 ? null : d;
}

/** The wall-clock reading of Cairo for a moment, as the pieces of a date. */
function cairoParts(d: Date): { y: number; mo: number; da: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: CAIRO, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(d)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, da: o.day, h: o.hour, mi: o.minute };
}

/** A date cell for a spreadsheet: the Cairo wall clock written as if it were UTC (a spreadsheet date has no zone), to be shown with DATE_NUMBER_FORMAT. */
export function cairoCellDate(d: Date): Date {
  const p = cairoParts(d);
  return new Date(Date.UTC(p.y, p.mo - 1, p.da, p.h, p.mi));
}
export const DATE_NUMBER_FORMAT = "yyyy-mm-dd hh:mm";

/** «2026-10-28 23:06» in Cairo time (the CSV). */
export function cairoText(d: Date): string {
  const p = cairoParts(d);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${z(p.mo)}-${z(p.da)} ${z(p.h)}:${z(p.mi)}`;
}

/** True when every filled value of the column is a moment (and the column is about a moment): only then the column is written as dates. */
export function isDateValues(title: string, key: string | undefined, values: unknown[]): boolean {
  if (!looksLikeDateColumn(title, key)) return false;
  const filled = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
  return filled.length > 0 && filled.every((v) => parseMoment(v) !== null);
}
