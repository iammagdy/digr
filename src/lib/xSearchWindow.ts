import { regionEvidenceWords, regionNameAr } from "./regionNames";

/**
 * The X search returns the LATEST posts first, so a window in the past ("the match in June") is only reachable
 * when the dates travel inside the search text. The stored window is never changed; only the text sent to the
 * source gets the operators, and the worker's date filter stays behind it as a safety net.
 */

/**
 * X reads `until:` as exclusive (the day itself is not included), so the last wanted day is sent as the NEXT day.
 * If the first live test shows the operator is inclusive, this one number is the only thing to change.
 */
export const X_UNTIL_DAYS_AFTER_DATE_TO = 1;

const DAY_MS = 86_400_000;

function dateOnly(value: string | undefined | null): string | null {
  const match = /^\s*(\d{4}-\d{2}-\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const parsed = Date.parse(`${match[1]}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? match[1] : null;
}

/** The `until:` day for a stored `dateTo`: the given day moved forward by X_UNTIL_DAYS_AFTER_DATE_TO, as YYYY-MM-DD (UTC). */
export function xUntilDay(dateTo: string | undefined | null): string | null {
  const day = dateOnly(dateTo);
  if (!day) return null;
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + X_UNTIL_DAYS_AFTER_DATE_TO * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The search text with the window appended: `<query> since:<dateFrom> until:<day after dateTo>`.
 * A side without a usable date adds nothing; a query that already carries its own operator is left as the customer wrote it.
 */
export function withXDateOperators(query: string, dateFrom?: string | null, dateTo?: string | null): string {
  const since = dateOnly(dateFrom);
  const until = xUntilDay(dateTo);
  const parts = [query.trim()];
  if (since && !/(^|\s)since:/i.test(query)) parts.push(`since:${since}`);
  if (until && !/(^|\s)until:/i.test(query)) parts.push(`until:${until}`);
  return parts.join(" ");
}

/**
 * X has no reliable country filter (`place_country:` matches only the few geotagged posts), so a request that names a country is narrowed
 * with the country's own words: `<query> (مصر OR مصري OR مصرية OR المصري OR المصرية OR egypt OR egyptian)`. The posts returned then
 * mention the country by name or by its adjective. A query that already carries one of those words, or an unknown region, is left as it is.
 */
export function withXCountryTerms(query: string, region?: string | null): string {
  const terms = [...new Set(regionEvidenceWords(region))].filter((word) => word.trim().length > 0 && !/\s/.test(word));
  const text = query.trim();
  if (terms.length === 0 || !text) return text;
  const lower = text.toLowerCase();
  if (terms.some((word) => lower.includes(word.toLowerCase()))) return text;
  return `${text} (${terms.join(" OR ")})`;
}

/**
 * A topic search for videos (YouTube, TikTok) has no country filter the sources apply reliably (YouTube's search takes none; TikTok's region filter is
 * only on one source), so a request that names a country puts the country's Arabic name in the search text: `<query> مصر`. The stored plan query is
 * never changed (the reviewers read it as the customer's topic); only the text sent to the source carries the word. A query that already names the
 * country by one of its words, a request with no country and an unknown region are left as they are.
 */
export function withTopicCountryWord(query: string, region?: string | null): string {
  const text = query.trim();
  const name = regionNameAr(region);
  if (!name || !text) return text;
  const lower = text.toLowerCase();
  if (regionEvidenceWords(region).some((word) => word.trim().length > 0 && lower.includes(word.toLowerCase()))) return text;
  return `${text} ${name}`;
}
