/**
 * CAIRO TIME (S1 live findings fix 5, docs/S1-LIVE-FINDINGS.md section 6 item 9). The dates a customer gives («أكتوبر ٢٠٢٦», «من ١ إلى ٣١ أكتوبر») are days in Cairo. Egypt keeps summer time (UTC+3) between the last Friday of April and the last Thursday of October and UTC+2 the rest of the year, so the
 * boundaries are converted with the zone's own rules (the platform's time zone data), never a fixed offset. A day's start is the first moment whose Cairo date is that day (the day summer time starts has no 00:00: it begins at 01:00 local). Pure.
 */
export const CAIRO_TZ = "Africa/Cairo";
const DAY_MS = 86_400_000;
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: CAIRO_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The Cairo calendar day (YYYY-MM-DD) of a moment. */
export const cairoDayOf = (ms: number): string => dayFormat.format(ms);

/** The first moment (ms) of a Cairo day given as YYYY-MM-DD: the smallest second whose Cairo date is that day or later. */
export function cairoDayStartMs(day: string): number {
  if (!ISO_DAY.test(day)) return Number.NaN;
  const [y, m, d] = day.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d);
  let lo = noonUtc - 14 * 3_600_000; // a moment that is certainly on an earlier Cairo day
  let hi = noonUtc + 14 * 3_600_000; // a moment that is certainly on this Cairo day or later
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (cairoDayOf(mid) >= day) hi = mid; else lo = mid;
  }
  return hi;
}

/** The first moment AFTER a Cairo day (the start of the next day): the exclusive end of the day. */
export function cairoDayEndExclusiveMs(day: string): number {
  if (!ISO_DAY.test(day)) return Number.NaN;
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
  return cairoDayStartMs(next);
}

/** A range of Cairo days (both inclusive) as moments: [startMs, endExclusiveMs). */
export const cairoRangeOf = (fromDay: string, toDay: string): { startMs: number; endExclusiveMs: number } => ({ startMs: cairoDayStartMs(fromDay), endExclusiveMs: cairoDayEndExclusiveMs(toDay) });

const pad = (n: number): string => String(n).padStart(2, "0");
/** `YYYY-MM-DD_HH:MM:SS_UTC`: the moment as a search operator takes it. */
export const operatorStampUtc = (ms: number): string => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}_UTC`; };
/** The UTC day (YYYY-MM-DD) of a moment. */
export const utcDayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
