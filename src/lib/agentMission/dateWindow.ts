import type { CatalogEndpoint } from "../treg/catalog";

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

/** The inputs of a window that reads `sinceDay` .. `endDay` (both days inclusive) from the same source: the first-page inputs with the window's days set. */
export function windowParams(window: DateWindow, base: Record<string, unknown>, sinceDay: string, endDay: string): Record<string, unknown> {
  if (window.kind === "range_params") return { ...base, [window.from]: asFormat(sinceDay, window.format, false), [window.to]: asFormat(endDay, window.format, true) };
  const text = String(base[window.param] ?? "");
  const cleaned = text.replace(/\s*\b(?:since|until):\S+/gi, "").replace(/\s+/g, " ").trim();
  // «until:» is exclusive: the end day itself is read by asking for the day after it
  return { ...base, [window.param]: `${cleaned} since:${sinceDay} until:${addDays(endDay, 1)}`.trim() };
}

/** The last day the FIRST read of the stage covers: the «until:» day before the end of the recorded text, else the day of `now` (a read with no end day starts from now). */
export function firstWindowEndDay(window: DateWindow, base: Record<string, unknown>, now: number): string {
  if (window.kind === "query_operators") {
    const m = /\buntil:(\d{4}-\d{2}-\d{2})/i.exec(String(base[window.param] ?? ""));
    return m ? addDays(m[1], -1) : dayOf(now);
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
