import { coverageText } from "./requestCoverage";
import { toArabicDigits } from "./arabicDigits";

/**
 * The newspapers and news sites the platform can name, per country, and the one question that lets a customer pick a set of sources
 * he did not name. The list is kept in code, not invented by the model: each entry says how it can be read by a machine (its search,
 * its sitemap, its feed), measured on the date below. A source with none of the three cannot be read, and is never sold.
 * A name the model suggests is marked «اقتراح» and checked against this list before a plan may use it.
 */

export interface NewsSource {
  id: string;
  nameAr: string;
  domain: string;
  country: "EG";
  /** A state-owned («قومية») newspaper: what «الجرايد الرسمية» means. */
  official: boolean;
  /** How the site can be read by a program, as found on `verifiedOn`: its search form, its sitemap and its feed (null = none found). */
  access: { search: string | null; sitemap: string | null; feed: string | null };
  /** Other ways the customer writes the name. */
  aliases: string[];
  verifiedOn: string;
}

export const NEWS_SOURCES_VERIFIED_ON = "2026-10-21";

const entry = (source: Omit<NewsSource, "country" | "verifiedOn">): NewsSource => ({ ...source, country: "EG", verifiedOn: NEWS_SOURCES_VERIFIED_ON });

/** Ordered by how much of the site a program can read, official newspapers marked. Re-measure before relying on a row after a month. */
export const EGYPT_NEWS_SOURCES: readonly NewsSource[] = [
  entry({ id: "youm7", nameAr: "اليوم السابع", domain: "www.youm7.com", official: false, access: { search: "/Home/Search", sitemap: "https://www.youm7.com/sitemap/SitemapNews", feed: "/rss/rss" }, aliases: ["youm7", "اليوم السابع"] }),
  entry({ id: "elbalad", nameAr: "صدى البلد", domain: "www.elbalad.news", official: false, access: { search: "/search/term", sitemap: "https://www.elbalad.news/sitemaps.xml", feed: "https://www.elbalad.news/rss.aspx" }, aliases: ["elbalad", "صدي البلد"] }),
  entry({ id: "cairo24", nameAr: "القاهرة ٢٤", domain: "www.cairo24.com", official: false, access: { search: "/search/term", sitemap: "https://www.cairo24.com/sitemaps.xml", feed: "/rss.aspx" }, aliases: ["cairo24", "القاهرة 24", "القاهره 24"] }),
  entry({ id: "dostor", nameAr: "الدستور", domain: "www.dostor.org", official: false, access: { search: "/search/term", sitemap: "https://www.dostor.org/sitemap.xml", feed: "https://www.dostor.org/rss.aspx" }, aliases: ["dostor", "الدستور"] }),
  entry({ id: "masrawy", nameAr: "مصراوي", domain: "www.masrawy.com", official: false, access: { search: null, sitemap: "https://www.masrawy.com/feeds/sitemap", feed: "https://www.masrawy.com/rss" }, aliases: ["masrawy", "مصراوي"] }),
  entry({ id: "almasryalyoum", nameAr: "المصري اليوم", domain: "www.almasryalyoum.com", official: false, access: { search: null, sitemap: "https://www.almasryalyoum.com/sitemap.xml", feed: "https://www.almasryalyoum.com/rss/rssfeeds" }, aliases: ["almasryalyoum", "المصري اليوم", "المصرى اليوم"] }),
  entry({ id: "shorouk", nameAr: "الشروق", domain: "www.shorouknews.com", official: false, access: { search: null, sitemap: null, feed: "/rss" }, aliases: ["shorouknews", "الشروق"] }),
  entry({ id: "elwatan", nameAr: "الوطن", domain: "www.elwatannews.com", official: false, access: { search: null, sitemap: "https://www.elwatannews.com/news-sitemap.xml", feed: null }, aliases: ["elwatannews", "الوطن"] }),
  entry({ id: "ahram", nameAr: "الأهرام", domain: "gate.ahram.org.eg", official: true, access: { search: null, sitemap: "https://gate.ahram.org.eg/ui/front/sitemapindex.aspx", feed: null }, aliases: ["ahram", "الاهرام", "الأهرام", "بوابة الأهرام", "بوابة الاهرام"] }),
  entry({ id: "gomhuria", nameAr: "الجمهورية", domain: "www.gomhuriaonline.com", official: true, access: { search: null, sitemap: "https://www.gomhuriaonline.com/sitemaps.xml", feed: null }, aliases: ["gomhuria", "gomhuriaonline", "الجمهورية", "الجمهوريه"] }),
  entry({ id: "akhbarelyom", nameAr: "أخبار اليوم", domain: "akhbarelyom.com", official: true, access: { search: null, sitemap: null, feed: null }, aliases: ["akhbarelyom", "اخبار اليوم", "أخبار اليوم", "الأخبار", "الاخبار"] }),
];

/** A program can read the site only if it has a search, a sitemap or a feed. */
export const hasMachineAccess = (source: NewsSource): boolean => Boolean(source.access.search || source.access.sitemap || source.access.feed);

/** Whether a service that reads web pages is enabled for the platform. None is today: see docs/CAPABILITY_COVERAGE.md. */
export function newsReaderAvailable(capabilities: ReadonlyArray<{ slug?: string; platform?: string; category?: string }>): boolean {
  return capabilities.some((capability) => /web[-_.]?(?:extract|article|read|crawl)|news|rss|sitemap/i.test(`${capability.slug ?? ""} ${capability.platform ?? ""} ${capability.category ?? ""}`));
}

const OFFICIAL_RE = /(?:رسميه|الحكوميه|القوميه|الحكومي|القومي|الدوله)/u;
const normalize = (value: string) => coverageText(value).replace(/[^\p{L}\p{N}\s.]/gu, " ").replace(/\s+/g, " ").trim();

/** Up to four real candidates for a request that names no newspaper: the official ones when the request says so, else the most readable. */
export function newsCandidates(requestText: string, limit = 4): NewsSource[] {
  const official = OFFICIAL_RE.test(coverageText(requestText));
  const pool = EGYPT_NEWS_SOURCES.filter((source) => (official ? source.official : true));
  return [...pool]
    .sort((a, b) => Number(hasMachineAccess(b)) - Number(hasMachineAccess(a)) || accessScore(b) - accessScore(a))
    .slice(0, limit);
}

const accessScore = (source: NewsSource) => Number(Boolean(source.access.feed)) + Number(Boolean(source.access.sitemap)) + Number(Boolean(source.access.search));

export interface SourcePickQuestion {
  id: "news_sources_pick";
  textAr: string;
  options: string[];
  allowOther: true;
  candidates: NewsSource[];
}

/** The ONE question: «تقصد هذه المصادر (١، ٢، ٣، ٤) أم لديك مصادر معينة؟» with the numbered list, and room to type his own. */
export function sourceSetQuestion(candidates: readonly NewsSource[]): SourcePickQuestion {
  const numbers = candidates.map((_, i) => toArabicDigits(i + 1)).join("، ");
  const lines = candidates.map((source, i) => `${toArabicDigits(i + 1)}) ${source.nameAr}`);
  return {
    id: "news_sources_pick",
    textAr: `تقصد هذه المصادر (${numbers}) أم لديك مصادر معينة؟\n${lines.join("\n")}`,
    options: [...candidates.map((source) => source.nameAr), "لدي مصادر أخرى سأكتبها"],
    allowOther: true,
    candidates: [...candidates],
  };
}

const ALL_WORDS = /^(?:كلها|الكل|كلهم|نعم|ايوه|أيوه|اه|آه|هذه|دي|دول|هذه المصادر|تمام|موافق)$/u;

export interface SourceAnswer {
  chosen: NewsSource[];
  /** Names the customer typed that are not in the verified list: never used in a plan until verified. */
  unverified: string[];
}

const toLatinDigits = (value: string) => value.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

/** The customer's answer to the pick question: numbers, «all», names, or his own list. */
export function resolveSourceAnswer(answer: string, candidates: readonly NewsSource[]): SourceAnswer {
  const text = toLatinDigits(String(answer || "").trim());
  const chosen = new Map<string, NewsSource>();
  const unverified: string[] = [];
  if (ALL_WORDS.test(normalize(text))) return { chosen: [...candidates], unverified };
  for (const number of text.match(/\d+/g) ?? []) {
    const picked = candidates[Number(number) - 1];
    if (picked) chosen.set(picked.id, picked);
  }
  const remainder = text.replace(/\d+/g, " ");
  for (const part of remainder.split(/[،,؛;\n]|\sو(?=\S)|\sو\s|\+|\sأو\s|\sاو\s/u).map((value) => value.trim()).filter((value) => normalize(value).length >= 2)) {
    const found = findSource(part);
    if (found) chosen.set(found.id, found);
    else if (!/^(?:و|ثم|مع|فقط|بس|لا|نعم)$/u.test(normalize(part))) unverified.push(part.replace(/^و/u, "").trim());
  }
  return { chosen: [...chosen.values()], unverified: unverified.filter(Boolean) };
}

/** A newspaper by name, alias or address, or null: a name that is not in the verified list is never guessed into a plan. */
export function findSource(value: string): NewsSource | null {
  const needle = normalize(value).replace(/^(?:جريده|جريدة|موقع|صحيفه|بوابه)\s+/u, "");
  if (!needle) return null;
  for (const source of EGYPT_NEWS_SOURCES) {
    const names = [source.nameAr, source.domain, source.id, ...source.aliases].map(normalize);
    if (names.some((name) => name === needle || (needle.length >= 4 && (name.includes(needle) || needle.includes(name))))) return source;
  }
  return null;
}

/** What a model-suggested source name is shown as, until the code has verified it. */
export const SUGGESTION_LABEL_AR = "اقتراح";
export function markSuggestions(names: readonly string[]): Array<{ name: string; label: typeof SUGGESTION_LABEL_AR; verified: NewsSource | null }> {
  return names.map((name) => ({ name, label: SUGGESTION_LABEL_AR, verified: findSource(name) }));
}

/** The honest sentence for a newspaper the platform cannot read, or null when it can. */
export function unreadableSentenceAr(source: NewsSource, readerAvailable: boolean): string | null {
  if (!readerAvailable) return `قراءة مواقع الصحف غير مفعّلة بعد في ديجر، فلا نستطيع قراءة «${source.nameAr}» الآن.`;
  if (!hasMachineAccess(source)) return `لا نستطيع قراءة «${source.nameAr}» الآن: موقعه لا يوفّر بحثًا أو خريطة موقع أو خلاصة يمكن قراءتها آليًا، فلن نُسعِّره.`;
  return null;
}

export type NewsSourceDecision =
  | { kind: "unavailable" }
  | { kind: "ask"; question: SourcePickQuestion }
  | { kind: "ready"; sources: NewsSource[]; notesAr: string[] }
  | { kind: "none_readable"; notesAr: string[] };

/**
 * Where a news request stands on its sources. No reader enabled: unavailable (the plain answer is given). Sources not named: the ONE
 * pick question. Named, or answered: the readable ones go on, and every one that cannot be read says why.
 */
export function newsSourceDecision(requestText: string, options: { readerAvailable: boolean; answer?: string | null; named?: string[] }): NewsSourceDecision {
  if (!options.readerAvailable) return { kind: "unavailable" };
  const candidates = newsCandidates(requestText);
  const named = (options.named ?? []).map((name) => findSource(name)).filter((source): source is NewsSource => Boolean(source));
  const typed = options.answer ? resolveSourceAnswer(options.answer, candidates) : { chosen: named, unverified: [] as string[] };
  if (typed.chosen.length === 0 && typed.unverified.length === 0) return { kind: "ask", question: sourceSetQuestion(candidates) };
  const notes: string[] = [];
  const readable: NewsSource[] = [];
  for (const source of typed.chosen) {
    const sentence = unreadableSentenceAr(source, true);
    if (sentence) notes.push(sentence);
    else readable.push(source);
  }
  for (const name of typed.unverified) notes.push(`«${name}» ليس في قائمة المصادر الموثقة لدينا، فلا نعتمده في الخطة قبل التحقق منه.`);
  return readable.length > 0 ? { kind: "ready", sources: readable, notesAr: notes } : { kind: "none_readable", notesAr: notes };
}
