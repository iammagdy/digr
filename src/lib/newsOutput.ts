import { coverageText } from "./requestCoverage";

/**
 * The output standard of the data types the platform will sell once a source exists for them. Arabic column titles; pure functions that
 * shape and clean the rows a source returns, so the file looks the same whichever source answered.
 * News: date, outlet, headline, link, a SHORT excerpt and the matched keywords; never the full article text by default.
 * Price series: date, rate, source and the change from the previous period.
 */

export const NEWS_COLUMNS_AR = ["التاريخ", "الصحيفة", "العنوان", "الرابط", "مقتطف قصير", "الكلمات المطابقة"] as const;
export const PRICE_COLUMNS_AR = ["التاريخ", "السعر", "المصدر", "التغير عن الفترة السابقة"] as const;
export const EXCERPT_MAX_CHARS = 240;

export interface RawNewsItem { date?: string; outlet?: string; headline?: string; link?: string; excerpt?: string; body?: string }
export interface NewsRow { التاريخ: string; الصحيفة: string; العنوان: string; الرابط: string; "مقتطف قصير": string; "الكلمات المطابقة": string }

/** One address for one article: no tracking parameters, no fragment, one scheme, no «www.», no trailing slash. */
export function canonicalLink(link: string): string {
  const raw = String(link || "").trim();
  try {
    const url = new URL(raw);
    const kept = [...url.searchParams.entries()].filter(([key]) => !/^(?:utm_|fbclid|gclid|ref|source|amp$)/i.test(key)).sort(([a], [b]) => a.localeCompare(b));
    const query = kept.length ? `?${kept.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "")}${query}`;
  } catch {
    return raw.toLowerCase();
  }
}

const headlineKey = (headline: string) => coverageText(headline).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Share of the words two headlines have in common (the smaller headline's words): 1 means the same words. */
function headlineOverlap(a: string, b: string): number {
  const wa = new Set(a.split(" ").filter(Boolean));
  const wb = new Set(b.split(" ").filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let common = 0;
  for (const word of wa) if (wb.has(word)) common += 1;
  return common / Math.min(wa.size, wb.size);
}

/** At or above this share of common words (and at least four words) two headlines are one story told twice. */
export const NEAR_IDENTICAL_HEADLINE = 0.9;

/** Duplicates out: the same link, or a near-identical headline in the same outlet. The first row is kept. Returns what was removed too. */
export function dedupeNews<T extends RawNewsItem>(items: readonly T[]): { kept: T[]; removed: number } {
  const links = new Set<string>();
  const kept: Array<{ item: T; key: string; outlet: string }> = [];
  let removed = 0;
  for (const item of items) {
    const link = item.link ? canonicalLink(item.link) : "";
    const key = headlineKey(item.headline || "");
    const outlet = coverageText(item.outlet || "");
    if (link && links.has(link)) { removed += 1; continue; }
    const similar = key.split(" ").length >= 4 && kept.some((other) => other.outlet === outlet && (other.key === key || headlineOverlap(other.key, key) >= NEAR_IDENTICAL_HEADLINE));
    if (similar) { removed += 1; continue; }
    if (link) links.add(link);
    kept.push({ item, key, outlet });
  }
  return { kept: kept.map((entry) => entry.item), removed };
}

/** A short excerpt: the source's own excerpt, else the start of the body; cut at a word, never the whole article. */
export function shortExcerpt(item: RawNewsItem): string {
  const source = String(item.excerpt || item.body || "").replace(/\s+/g, " ").trim();
  if (source.length <= EXCERPT_MAX_CHARS) return source;
  const cut = source.slice(0, EXCERPT_MAX_CHARS);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), EXCERPT_MAX_CHARS - 30)).trim()}…`;
}

/** The keywords of the request that appear in the headline or the excerpt. */
export function matchedKeywords(item: RawNewsItem, keywords: readonly string[]): string[] {
  const haystack = coverageText(`${item.headline || ""} ${item.excerpt || item.body || ""}`);
  return keywords.filter((keyword) => coverageText(keyword).length >= 2 && haystack.includes(coverageText(keyword)));
}

/** The news file: deduplicated, newest first, with Arabic columns. The body of an article is never delivered. */
export function shapeNewsRows(items: readonly RawNewsItem[], keywords: readonly string[]): { rows: NewsRow[]; duplicatesRemoved: number } {
  const { kept, removed } = dedupeNews(items);
  const rows = kept
    .map((item) => ({
      التاريخ: String(item.date || "").slice(0, 10) || "تاريخ غير معروف",
      الصحيفة: String(item.outlet || "").trim(),
      العنوان: String(item.headline || "").replace(/\s+/g, " ").trim(),
      الرابط: String(item.link || "").trim(),
      "مقتطف قصير": shortExcerpt(item),
      "الكلمات المطابقة": matchedKeywords(item, keywords).join("، "),
    }))
    .sort((a, b) => (a.التاريخ < b.التاريخ ? 1 : a.التاريخ > b.التاريخ ? -1 : 0));
  return { rows, duplicatesRemoved: removed };
}

export interface RawPricePoint { date: string; rate: number; source: string }
export interface PriceRow { التاريخ: string; السعر: number; المصدر: string; "التغير عن الفترة السابقة": string }

const isoDay = (value: string) => String(value || "").slice(0, 10);

/** Monday-based week key (UTC) of a day. */
function weekKey(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

const formatChange = (change: number, percent: number) => `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(2)} (${percent >= 0 ? "+" : "−"}${Math.abs(percent).toFixed(2)}٪)`;

/**
 * A price series: one point per day or per week (the last of the period), oldest first, each with its change from the previous
 * period. The first point has no previous period and says so. Points with no date or no positive rate are dropped.
 */
export function shapePriceSeries(points: readonly RawPricePoint[], period: "daily" | "weekly"): PriceRow[] {
  const byPeriod = new Map<string, RawPricePoint>();
  for (const point of [...points].filter((p) => isoDay(p.date) && Number.isFinite(p.rate) && p.rate > 0).sort((a, b) => isoDay(a.date).localeCompare(isoDay(b.date)))) {
    byPeriod.set(period === "weekly" ? weekKey(isoDay(point.date)) : isoDay(point.date), point);
  }
  const rows: PriceRow[] = [];
  let previous: number | null = null;
  for (const point of byPeriod.values()) {
    rows.push({
      التاريخ: isoDay(point.date),
      السعر: point.rate,
      المصدر: point.source,
      "التغير عن الفترة السابقة": previous === null ? "لا توجد فترة سابقة" : formatChange(point.rate - previous, ((point.rate - previous) / previous) * 100),
    });
    previous = point.rate;
  }
  return rows;
}
