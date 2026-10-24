/**
 * The registry of vetted PUBLIC Facebook Pages the report browses, per country and topic area. A data module: no database, no SQL.
 *
 * Why a registry: Facebook posts cannot be searched by topic cheaply (a search call costs about ten times a Page-browsing call and returns a handful of posts), and a
 * hand-picked list of Pages is what the owner's own run browsed. The list is the OWNER'S to review and extend (`docs/FACEBOOK_REPORT_PAGES.md`): every entry starts
 * with `ownerReviewed: false`.
 *
 * Rules the module holds:
 *  - only public Pages are listed, never a personal profile (the page-posts source reads public Pages only; the two doctors' links of the owner's run were
 *    personal profiles and returned nothing);
 *  - a Page is used for a request only when its country is the request's country and its topic tags cover the request's topic area;
 *  - `status` says whether the entry may be browsed: `ok`, `invalid` (the URL is not a valid Page address for the source: needs the correct URL) or
 *    `not_public` (a profile or a closed Page). Entries that are not `ok` are skipped, counted and reported, never browsed;
 *  - the Page's display name is the PUBLISHER of its posts (content in the customer's report); its id and the source's names never appear in a customer text.
 */
export type RegistryStatus = "ok" | "invalid" | "not_public";

export interface FacebookPageEntry {
  /** Stable internal id (never shown to a customer). */
  id: string;
  /** Arabic display name: what the report shows as the publisher. */
  nameAr: string;
  /** Other spellings of the Page's name that a search result may carry (matched on the normalised name), so one publisher is counted once. */
  aliases?: string[];
  /** The public Page address. */
  url: string;
  /** ISO 3166-1 alpha-2 code of the country the Page serves. */
  country: string;
  /** Topic areas the Page covers (see TOPIC_AREAS). */
  topics: string[];
  status: RegistryStatus;
  /** True only after the owner has looked at the Page and confirmed it (all false at the start). */
  ownerReviewed: boolean;
  /** Internal note for the owner (never shown to a customer). */
  note?: string;
}

/** Topic areas the registry knows, with the words (normalised, see `normalizeAr`) that place a request's topic in the area. */
export const TOPIC_AREAS: Record<string, { nameAr: string; words: string[] }> = {
  health: {
    nameAr: "الصحة",
    words: ["صح", "طب", "دوا", "ادوي", "علاج", "مرض", "امراض", "مستشف", "اطباء", "دكتور", "تغذي", "سمن", "تخسيس", "قلب", "سكر", "انفلونز", "لقاح", "فيروس", "صيدل", "نفسي", "اكتئاب", "وباء", "جلط"],
  },
};

/** Arabic normalisation used by every matcher of the report: no diacritics or tatweel, one alef, one yaa, one taa marbuta, lower case. */
export function normalizeAr(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase();
}

/**
 * Seeded from the owner's audit of the Egypt health run (`facebook_pages_and_queries_audit.csv`). The Ministry of Health Page is listed WITH the flag the audit
 * found: the address was not a valid Page id for the source (it answered «not found»), so it needs the correct Page URL before it can be used. The two
 * doctors of the audit are personal profiles and are NOT listed: a personal profile is never added.
 */
export const FACEBOOK_PAGE_REGISTRY: readonly FacebookPageEntry[] = [
  { id: "eg_health_el_consolto", nameAr: "الكونسلتو الطبي", aliases: ["el consolto", "الكونسلتو"], url: "https://www.facebook.com/ElConsolto", country: "EG", topics: ["health", "news"], status: "ok", ownerReviewed: false, note: "Audit: 75 page calls gave 225 of the 305 posts (74%): general medical coverage." },
  { id: "eg_health_drug_authority", nameAr: "هيئة الدواء المصرية", aliases: ["egyptian drug authority", "هيئه الدواء"], url: "https://www.facebook.com/EgyptianDrugAuthority", country: "EG", topics: ["health", "official"], status: "ok", ownerReviewed: false, note: "Audit: 3 posts in the preliminary check, 0 in the final file (the script stopped at its global quota)." },
  { id: "eg_health_medical_syndicate", nameAr: "النقابة العامة لأطباء مصر", aliases: ["egyptian medical syndicate", "نقابه اطباء مصر", "النقابه العامه للاطباء"], url: "https://www.facebook.com/Egyptian.Medical.Syndicate", country: "EG", topics: ["health", "official"], status: "ok", ownerReviewed: false, note: "Audit: 3 posts in the preliminary check, 0 in the final file." },
  { id: "eg_health_cairo24", nameAr: "القاهرة ٢٤", aliases: ["cairo 24", "cairo24", "القاهره 24", "القاهره ٢٤"], url: "https://www.facebook.com/cairo24", country: "EG", topics: ["health", "news"], status: "ok", ownerReviewed: false, note: "Audit: 3 posts in the preliminary check, 0 in the final file. A general news Page: its health posts are a share of its feed." },
  { id: "eg_health_masrawy", nameAr: "مصراوي", aliases: ["masrawy", "مصراوي"], url: "https://www.facebook.com/masrawy", country: "EG", topics: ["health", "news"], status: "ok", ownerReviewed: false, note: "Audit: 3 posts in the preliminary check, 0 in the final file. A general news Page." },
  { id: "eg_health_mohp", nameAr: "وزارة الصحة والسكان المصرية", aliases: ["egyptian mohp", "وزاره الصحه والسكان"], url: "https://www.facebook.com/EgyptianMOHP", country: "EG", topics: ["health", "official"], status: "invalid", ownerReviewed: false, note: "URL invalid, needs the correct Page URL: the audit's address answered «not_found» (it was not a valid Page id for the source)." },
];

/**
 * THE GATE of the capability. The report is offered, planned and priced to customers only when the owner has reviewed at least one usable Page (`ownerReviewed: true` on an
 * entry whose status is `ok`). With none, the capability does not exist for the rest of the platform: it is not in the service list (calculator, catalog, plans), the report
 * words are not a report request, and every request behaves exactly as it did before the report was added. Turning it on is ONE line: set `ownerReviewed: true` on a Page above.
 * Read once when the module loads (the registry is data in the code, so the answer is the same for the whole life of a deployment).
 */
export const reportEnabledFor = (registry: readonly FacebookPageEntry[]): boolean => registry.some((entry) => entry.ownerReviewed === true && entry.status === "ok");
export const FACEBOOK_REPORT_ENABLED: boolean = reportEnabledFor(FACEBOOK_PAGE_REGISTRY);

export interface PageSelection {
  /** Pages to browse, in registry order. */
  usable: FacebookPageEntry[];
  /** Pages of the right country and topic that cannot be browsed (invalid or not public): counted and reported, never called. */
  skipped: FacebookPageEntry[];
  /** Pages of other countries or other topic areas (not counted anywhere: they are simply not this request's Pages). */
  excludedCount: number;
}

/** The topic areas a request's topic text belongs to (empty when none of the known areas fits). */
export function topicAreasOf(topicText: string): string[] {
  // every word without its Arabic prefixes («الصحية», «للصحة», «بالأدوية»): the stems of an area are matched at the start of the bare word
  const words = normalizeAr(topicText).split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((word) => word.replace(/^(?:[وفبكل]|لل)?(?:ال)?/u, "") || word);
  return Object.entries(TOPIC_AREAS)
    .filter(([, area]) => area.words.some((stem) => words.some((word) => word.startsWith(stem))))
    .map(([id]) => id);
}

/** An ISO country code from the request (`EG`), or null. A request with no country gets no Page: the country is asked, never guessed. */
export const normalizeCountry = (value: unknown): string | null => {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
};

/**
 * The Pages for a request. A Page is used ONLY if its country matches the request's country (a non-Egyptian Page is never used for Egypt) and it covers the topic area.
 * `registry` is a parameter so the tests can pass a fixture; production uses the seeded list.
 */
export function selectPages(request: { country: unknown; topic: string }, registry: readonly FacebookPageEntry[] = FACEBOOK_PAGE_REGISTRY): PageSelection {
  const country = normalizeCountry(request.country);
  const areas = topicAreasOf(request.topic);
  const usable: FacebookPageEntry[] = [];
  const skipped: FacebookPageEntry[] = [];
  let excludedCount = 0;
  for (const entry of registry) {
    const matches = country !== null && normalizeCountry(entry.country) === country && entry.topics.some((topic) => areas.includes(topic));
    if (!matches) { excludedCount += 1; continue; }
    (entry.status === "ok" ? usable : skipped).push(entry);
  }
  return { usable, skipped, excludedCount };
}

/** Whether the report can be offered for this country and topic: at least one usable Page. */
export function reportCoverage(request: { country: unknown; topic: string }, registry: readonly FacebookPageEntry[] = FACEBOOK_PAGE_REGISTRY): { covered: boolean; usablePages: number } {
  const { usable } = selectPages(request, registry);
  return { covered: usable.length > 0, usablePages: usable.length };
}

/** Registry hygiene checked by the tests: a profile is never listed, ids are unique, URLs are Facebook addresses. */
export function registryProblems(registry: readonly FacebookPageEntry[] = FACEBOOK_PAGE_REGISTRY): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry) {
    if (seen.has(entry.id)) problems.push(`duplicate id ${entry.id}`);
    seen.add(entry.id);
    if (!/^https:\/\/(?:www\.)?facebook\.com\/[A-Za-z0-9._-]+\/?$/.test(entry.url)) problems.push(`${entry.id}: not a plain Page address`);
    if (/profile\.php|\/people\/|\/groups\//i.test(entry.url)) problems.push(`${entry.id}: a profile or group is never listed`);
    if (!/^[A-Z]{2}$/.test(entry.country)) problems.push(`${entry.id}: country must be an ISO code`);
    if (entry.topics.length === 0) problems.push(`${entry.id}: no topic`);
    if (!/[؀-ۿ]/.test(entry.nameAr)) problems.push(`${entry.id}: the display name must be Arabic`);
  }
  return problems;
}

/**
 * The publisher of a post: a registry Page's own Arabic name when the post was read from it (or when a search result's page name is one of its spellings), else the
 * name the source gave. `key` is what the cap and the concentration table count, so a Page that also shows up in the search is counted ONCE.
 */
export function publisherOf(rawName: string, pageId: string | undefined, registry: readonly FacebookPageEntry[] = FACEBOOK_PAGE_REGISTRY): { name: string; key: string } {
  const byId = pageId ? registry.find((entry) => entry.id === pageId) : undefined;
  if (byId) return { name: byId.nameAr, key: `page:${byId.id}` };
  const clean = String(rawName ?? "").replace(/\s+/g, " ").trim();
  const norm = normalizeAr(clean);
  const byName = norm
    ? registry.find((entry) => [entry.nameAr, ...(entry.aliases ?? [])].some((alias) => { const a = normalizeAr(alias); return a.length >= 4 && (norm === a || norm.includes(a)); }))
    : undefined;
  if (byName) return { name: byName.nameAr, key: `page:${byName.id}` };
  return { name: clean || "ناشر غير معروف", key: `name:${norm || "unknown"}` };
}
