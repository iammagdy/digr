import type { CatalogEndpoint } from "../treg/catalog";
import { cairoDayEndExclusiveMs, cairoDayStartMs, operatorStampUtc } from "./cairoTime";

/**
 * READING A PERIOD IN DATE WINDOWS. A source that returns its results newest first and stops after a fixed depth (a search that ends after about two thousand results) cannot reach the start of a long period by paging: the live request for
 * «٢٠٠٠ تغريدة عن حرب إيران وإسرائيل آخر ٣ شهور» read 1,984 tweets, all of the last two days, and the source then returned nothing more.
 *
 * The engine therefore WALKS BACK: when a stage with a period filter has not reached its target and the source has ended, it asks the SAME source again with the end of the window moved back to the oldest day it has read, using the source's OWN
 * date inputs from the catalog (two inputs that take a start and an end day, or the «since:» and «until:» operators the catalog documents inside the search text). Items are de-duplicated by id as always, so the overlapping day costs nothing.
 *
 * Pure: no I/O.
 */
export type DateWindow =
  /** The search text itself takes «since:YYYY-MM-DD» and «until:YYYY-MM-DD» (the end day is exclusive). */
  | { kind: "query_operators"; param: string }
  /** Two inputs take the first and the last day (inclusive), written as `format` says. */
  | { kind: "range_params"; from: string; to: string; format: "date" | "compact" | "iso" };

const DAY_MS = 86_400_000;
const RANGE_PAIRS: ReadonlyArray<readonly [string, string]> = [["startDate", "endDate"], ["start_date", "end_date"], ["startDay", "endDay"], ["publishedAfter", "publishedBefore"]];
const QUERY_INPUTS = ["query", "q", "search_query", "keyword", "keywords", "search"];
const OPERATOR = /\b(?:since|until):/i;

/** The day «YYYY-MM-DD» of a moment (UTC). */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const dayStartMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, n: number): string => dayOf(dayStartMs(day) + n * DAY_MS);

function formatOf(note: string | null | undefined, name: string): "date" | "compact" | "iso" | null {
  const t = String(note ?? "");
  if (/y{4}-MM-dd|YYYY-MM-DD/i.test(t)) return "date";
  if (/yyyyMMdd|YYYYMMDD/.test(t)) return "compact";
  if (/RFC\s?3339|ISO\s?8601/i.test(t) || /^published(After|Before)$/.test(name)) return "iso";
  return null;
}

/**
 * The date window the endpoint offers, from the catalog and the recorded first-page inputs, or null when the source has none that is documented. Nothing is guessed: an input pair is used only when its own note says how the day is written, and
 * the operators only when the catalog's text for the endpoint names them.
 */
export function dateWindowOf(endpoint: Pick<CatalogEndpoint, "inputs" | "summary">, params: Record<string, unknown>): DateWindow | null {
  const inputs = new Map(endpoint.inputs.map((i) => [i.name, i]));
  for (const [from, to] of RANGE_PAIRS) {
    const a = inputs.get(from);
    const b = inputs.get(to);
    if (!a || !b || a.type === "integer" || b.type === "integer") continue;
    const format = formatOf(a.note, from);
    if (format) return { kind: "range_params", from, to, format };
  }
  const operatorsDocumented = OPERATOR.test(endpoint.summary ?? "") || endpoint.inputs.some((i) => OPERATOR.test(String(i.note ?? "")));
  if (operatorsDocumented) {
    const param = QUERY_INPUTS.find((n) => inputs.has(n) && typeof params[n] === "string");
    if (param) return { kind: "query_operators", param };
  }
  return null;
}

const asFormat = (day: string, format: "date" | "compact" | "iso", end: boolean): string => (format === "compact" ? day.replace(/-/g, "") : format === "iso" ? `${day}T${end ? "23:59:59" : "00:00:00"}Z` : day);

/**
 * THE CUSTOMER'S PERIOD AS MOMENTS (S10): the first moment of the period and the first moment AFTER it, converted from the customer's Cairo days with the zone's own rules (cairoTime.ts). A window never starts before the first, nor ends after the second: the
 * days the walk uses to page are UTC days, but the boundary of the customer's period is Cairo's, so a window that reaches it is cut there (live: until at UTC midnight let a tweet of 2026-11-01 00:14 Cairo into October).
 */
export interface PeriodBounds { startMs: number | null; endExclusiveMs: number | null }

/** The inputs of a window that reads `sinceDay` .. `endDay` (both days inclusive) from the same source: the first-page inputs with the window's days set; with the period's `bounds`, the period's own first and last moments instead of the UTC midnights. */
export function windowParams(window: DateWindow, base: Record<string, unknown>, sinceDay: string, endDay: string, bounds?: PeriodBounds): Record<string, unknown> {
  const startMs = bounds?.startMs ?? null;
  const pageEndMs = dayStartMs(addDays(endDay, 1));
  const endMs = bounds?.endExclusiveMs != null && bounds.endExclusiveMs < pageEndMs ? bounds.endExclusiveMs : pageEndMs;
  if (window.kind === "range_params") {
    if (window.format === "iso" && bounds) {
      const stamp = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
      return { ...base, [window.from]: startMs !== null ? stamp(startMs) : asFormat(sinceDay, window.format, false), [window.to]: bounds.endExclusiveMs != null && bounds.endExclusiveMs < pageEndMs ? stamp(endMs - 1000) : asFormat(endDay, window.format, true) };
    }
    // a source that takes only days gets the UTC days that cover the window, and never a day past the one that holds the last moment of the period
    const lastCovering = bounds?.endExclusiveMs != null ? dayOf(bounds.endExclusiveMs - 1000) : null;
    return { ...base, [window.from]: asFormat(sinceDay, window.format, false), [window.to]: asFormat(lastCovering !== null && lastCovering < endDay ? lastCovering : endDay, window.format, true) };
  }
  const text = String(base[window.param] ?? "");
  const cleaned = text.replace(/\s*\b(?:since|until):\S+/gi, "").replace(/\s+/g, " ").trim();
  // the period's moments are written as stamps (UTC, with the time of day); without bounds the window is the UTC days, as it always was («until:» is exclusive: the end day itself is read by asking for the day after it)
  if (bounds) return { ...base, [window.param]: `${cleaned} since:${startMs !== null ? operatorStampUtc(startMs) : sinceDay} until:${operatorStampUtc(endMs)}`.trim() };
  return { ...base, [window.param]: `${cleaned} since:${sinceDay} until:${addDays(endDay, 1)}`.trim() };
}

/**
 * THE CUSTOMER'S CAIRO DAYS IN A MODEL-WRITTEN QUERY (live finding B, 2026-11-03, flags off). On the old path the first request is the model's own sample: `since:2026-10-01 until:2026-10-31`, day only. The source read `until:2026-10-31` as the WHOLE
 * UTC day, so a tweet of 2026-11-01 00:14 Cairo (22:14 UTC on the 31st) came back, and `since:2026-10-01` starts at UTC midnight, so the first three hours of 1 October in Cairo were never asked for. Only the DAY-ONLY operators are rewritten: a bare `since:` is the
 * first moment of the period's first Cairo day; a bare `until:` day D is the end of that UTC day (the way the source reads it), never past the end of the period's last Cairo day. A moment stamp written by code is left as it is (a walk back through windows moves
 * `until:` and must keep it); an operator the query lacks is added. Nothing else in the query changes. Pure.
 */
export function alignQueryToCairoPeriod(query: string, period: { from?: string; to?: string }): string {
  const startMs = period.from ? cairoDayStartMs(period.from) : Number.NaN;
  const endExclusiveMs = period.to ? cairoDayEndExclusiveMs(period.to) : Number.NaN;
  let out = String(query ?? "");
  const BARE_SINCE = /(^|\s)since:(\d{4}-\d{2}-\d{2})(?=\s|$)/gi;
  const BARE_UNTIL = /(^|\s)until:(\d{4}-\d{2}-\d{2})(?=\s|$)/gi;
  if (Number.isFinite(startMs)) out = out.replace(BARE_SINCE, (_m, lead: string) => `${lead}since:${operatorStampUtc(startMs)}`);
  if (Number.isFinite(endExclusiveMs)) out = out.replace(BARE_UNTIL, (_m, lead: string, day: string) => `${lead}until:${operatorStampUtc(Math.min(dayStartMs(addDays(day, 1)), endExclusiveMs))}`);
  if (Number.isFinite(startMs) && !/(^|\s)since:/i.test(out)) out = `${out.trim()} since:${operatorStampUtc(startMs)}`;
  if (Number.isFinite(endExclusiveMs) && !/(^|\s)until:/i.test(out)) out = `${out.trim()} until:${operatorStampUtc(endExclusiveMs)}`;
  return out.replace(/\s+/g, " ").trim();
}

/** The last day the FIRST read of the stage covers: the «until:» day before the end of the recorded text, else the day of `now` (a read with no end day starts from now). */
export function firstWindowEndDay(window: DateWindow, base: Record<string, unknown>, now: number): string {
  if (window.kind === "query_operators") {
    // «until:» is exclusive: the last day read is the day that holds the last moment before it (a stamp written by code carries the time: until:2026-10-31_22:00:00_UTC ends on the 31st; a bare day ends on the day before)
    const m = /\buntil:(\d{4}-\d{2}-\d{2})(?:_(\d{2}:\d{2}:\d{2})(?:_UTC)?)?/i.exec(String(base[window.param] ?? ""));
    if (!m) return dayOf(now);
    if (m[2] !== undefined) { const ms = Date.parse(`${m[1]}T${m[2]}Z`); if (Number.isFinite(ms)) return dayOf(ms - 1000); }
    return addDays(m[1], -1);
  }
  const raw = String(base[window.to] ?? "");
  const m = /(\d{4})-?(\d{2})-?(\d{2})/.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : dayOf(now);
}

/**
 * THE NEXT WINDOW after a read that ended: it ends on the oldest day read so far (that day is read again from its start; items already stored are ignored), and when that does not go back a day from the window that just ended (a single
 * day gave more than the source returns) it ends the day before. Null when the period's first day is reached, or when nothing was read to go back from.
 */
export function nextWindowEndDay(input: { oldestMs: number | null; lastEndDay: string; sinceDay: string }): string | null {
  if (input.oldestMs === null) return null;
  // a read that came down to the first day of the period has covered it (the source gives its results newest first)
  if (dayOf(input.oldestMs) <= input.sinceDay) return null;
  let end = dayOf(input.oldestMs);
  if (end >= input.lastEndDay) end = addDays(input.lastEndDay, -1);
  return end < input.sinceDay ? null : end;
}
