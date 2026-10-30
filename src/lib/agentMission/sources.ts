import { CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT } from "../multiProvider/catalog";

/**
 * THE AGENT'S WEB SOURCES, as data: the Context.dev pre-built parsers (read from https://docs.context.dev/scrape/prebuilt-parsers and each parser's page on 2026-10-28), the web search and page
 * scrape of Firecrawl and Context.dev, and Context.dev's people search (launched 2026-10-23). Pure: no network, no secret. The gateway (agent/src/webGateway.ts) is the only thing that calls them.
 *
 * PRICES. The documentation states the credit cost of a plain scrape (1 credit; 2 with browser actions) and of people search (10 per page fast, 50 ultra), but NOT a credit cost per parser. A parser call is
 * therefore recorded at the answer's own `key_metadata.credits_consumed` when it is present, and otherwise at the documented base scrape credit (1) as an ESTIMATE (the call row says `cost_basis: estimated`).
 */
export const CONTEXTDEV_PARSE_CREDITS = 1;
export const CONTEXTDEV_PEOPLE_SEARCH_CREDITS = 10;
export const CONTEXTDEV_PEOPLE_SEARCH_PAGE_ROWS = 10;
export const CONTEXTDEV_PARSE_USD_ESTIMATE = CONTEXTDEV_PARSE_CREDITS * CONTEXTDEV_USD_PER_CREDIT;

export type ParserName =
  | "google-maps" | "google-maps-reviews" | "google-play" | "google-play-reviews" | "app-store" | "app-store-reviews"
  | "instagram-profile" | "instagram-post" | "instagram-feed"
  | "tiktok-profile" | "tiktok-video" | "tiktok-feed" | "tiktok-comments" | "tiktok-followers" | "tiktok-following" | "tiktok-user-search"
  | "g2-reviews" | "emails" | "phone-numbers" | "links";

export interface ParserSpec {
  name: ParserName;
  /** The id the plan and the call log use for this source. */
  id: string;
  platform: string;
  /** English words the agent's catalog search matches. */
  keywords: string[];
  /** The list inside `parsed.data` that holds the rows; null when the answer is ONE object (a profile, an app, a video). */
  listPath: string | null;
  /** What one call returns at most (documented), used for the cost per row. */
  rowsPerCall: number;
  /** The URL shapes the parser accepts. */
  urlHint: string;
  accepts: (url: URL) => boolean;
  /** Optional request parameters the parser documents (only google-maps-reviews takes them). */
  params?: Array<"sort" | "limit">;
  summary: string;
  /** What the parser reads from, for the admin trace. */
  note: string;
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
const path = (u: URL) => u.pathname;
const isGoogleMaps = (u: URL) => (/(^|\.)google\.[a-z.]+$/.test(host(u)) && /^\/maps/.test(path(u))) || host(u) === "maps.google.com" || host(u) === "maps.app.goo.gl" || (host(u) === "search.google.com" && /\/local\/reviews/.test(path(u)));
const ig = (u: URL) => host(u) === "instagram.com";
const tt = (u: URL) => host(u) === "tiktok.com";

export const PARSERS: Record<ParserName, ParserSpec> = {
  "google-maps": { name: "google-maps", id: "contextdev.parse.google-maps", platform: "google_maps", keywords: ["maps", "places", "business", "businesses", "local", "restaurants", "shops", "companies", "address", "phone"], listPath: "results", rowsPerCall: 10,
    urlHint: "https://www.google.com/maps/search/<business type> in <place>/  or  https://www.google.com/maps/place/?q=place_id:<ID>", accepts: (u) => isGoogleMaps(u),
    summary: "Google Maps businesses of a search or one place: name, rating, review count, website, phone, address, category, place id, reviews link.", note: "US exit; Arabic names may still appear" },
  "google-maps-reviews": { name: "google-maps-reviews", id: "contextdev.parse.google-maps-reviews", platform: "google_maps", keywords: ["maps", "reviews", "ratings", "place", "restaurant", "hotel", "shop"], listPath: "reviews", rowsPerCall: 1000,
    urlHint: "a Maps place URL, a CID URL, a reviews URL (search.google.com/local/reviews?placeid=...) or the google_reviews_url of a google-maps result", accepts: (u) => isGoogleMaps(u), params: ["sort", "limit"],
    summary: "Reviews of one Google Maps place (up to 1,000): rating, date, text, likes, reviewer, owner reply, link. Optional sort (newest, oldest, relevant, highest, lowest) and limit (1 to 1000, default 100).", note: "about 20 to 45 seconds for 1,000 reviews" },
  "google-play": { name: "google-play", id: "contextdev.parse.google-play", platform: "google_play", keywords: ["google", "play", "android", "app", "application", "store"], listPath: null, rowsPerCall: 1,
    urlHint: "https://play.google.com/store/apps/details?id=<package>[&hl=en&gl=us]", accepts: (u) => host(u) === "play.google.com" && /\/store\/apps\/details/.test(path(u)), summary: "One Android app: name, developer, rating, downloads, price, version, permissions.", note: "US exit" },
  "google-play-reviews": { name: "google-play-reviews", id: "contextdev.parse.google-play-reviews", platform: "google_play", keywords: ["google", "play", "android", "app", "reviews", "ratings"], listPath: "reviews", rowsPerCall: 200,
    urlHint: "https://play.google.com/store/apps/details?id=<package>[&hl=en&gl=us]", accepts: (u) => host(u) === "play.google.com" && /\/store\/apps\/details/.test(path(u)), summary: "Up to 200 newest reviews of one Android app: author, rating, text, date, thumbs up, app version, developer reply.", note: "US exit; no sort or limit" },
  "app-store": { name: "app-store", id: "contextdev.parse.app-store", platform: "app_store", keywords: ["app", "store", "ios", "iphone", "apple", "application"], listPath: null, rowsPerCall: 1,
    urlHint: "https://apps.apple.com/<country>/app/<name>/id<ID>", accepts: (u) => host(u) === "apps.apple.com", summary: "One iOS app: name, developer, rating, price, version, languages.", note: "US exit; the country in the path selects the storefront" },
  "app-store-reviews": { name: "app-store-reviews", id: "contextdev.parse.app-store-reviews", platform: "app_store", keywords: ["app", "store", "ios", "iphone", "apple", "reviews", "ratings"], listPath: "reviews", rowsPerCall: 500,
    urlHint: "https://apps.apple.com/<country>/app/<name>/id<ID>", accepts: (u) => host(u) === "apps.apple.com", summary: "Up to 500 recent reviews of one iOS app in one storefront: author, rating, title, text, date, version, helpful votes.", note: "US exit" },
  "instagram-profile": { name: "instagram-profile", id: "contextdev.parse.instagram-profile", platform: "instagram", keywords: ["instagram", "profile", "account", "followers", "bio", "posts"], listPath: "latest_posts", rowsPerCall: 12,
    urlHint: "https://www.instagram.com/<username>/", accepts: (u) => ig(u) && /^\/[A-Za-z0-9._]+\/?$/.test(path(u)) && !/^\/(explore|p|reel|tv|accounts)\b/.test(path(u)), summary: "A public Instagram profile: name, bio, followers, posts count, category, business address and its 12 latest posts.", note: "public data, no login" },
  "instagram-post": { name: "instagram-post", id: "contextdev.parse.instagram-post", platform: "instagram", keywords: ["instagram", "post", "reel", "comments", "likes"], listPath: "comments", rowsPerCall: 14,
    urlHint: "https://www.instagram.com/p/<code>/  or  /reel/<code>/  or  /tv/<code>/", accepts: (u) => ig(u) && /\/(p|reel|tv)\/[A-Za-z0-9_-]+/.test(path(u)), summary: "One public Instagram post or reel with its counts and its top comments (about 14; the rest need a login).", note: "public data, no login" },
  "instagram-feed": { name: "instagram-feed", id: "contextdev.parse.instagram-feed", platform: "instagram", keywords: ["instagram", "hashtag", "tag", "posts", "keyword", "location", "feed", "topic"], listPath: "posts", rowsPerCall: 12,
    urlHint: "https://www.instagram.com/explore/tags/<hashtag>/  or  /popular/<keyword>/  or  /explore/locations/<id>/<slug>/", accepts: (u) => ig(u) && /^\/(explore\/(tags|locations)|popular)\//.test(path(u)), summary: "Top public posts of an Instagram hashtag or keyword (about 12 to 200) or recent posts of a location (15 to 20).", note: "public data, no login; the first page only" },
  "tiktok-profile": { name: "tiktok-profile", id: "contextdev.parse.tiktok-profile", platform: "tiktok", keywords: ["tiktok", "profile", "account", "followers", "bio"], listPath: null, rowsPerCall: 1,
    urlHint: "https://www.tiktok.com/@<username>", accepts: (u) => tt(u) && /^\/@[^/]+\/?$/.test(path(u)), summary: "A public TikTok profile: name, bio, followers, likes, videos count, verified, category.", note: "public data, no login" },
  "tiktok-video": { name: "tiktok-video", id: "contextdev.parse.tiktok-video", platform: "tiktok", keywords: ["tiktok", "video", "stats", "views", "likes", "caption"], listPath: null, rowsPerCall: 1,
    urlHint: "https://www.tiktok.com/@<username>/video/<id>", accepts: (u) => tt(u) && /^\/@[^/]+\/(video|photo)\/\d+/.test(path(u)), summary: "One TikTok video: caption, hashtags, author, views, likes, comments, shares, saves, music.", note: "public data; short vm.tiktok.com links are not accepted" },
  "tiktok-feed": { name: "tiktok-feed", id: "contextdev.parse.tiktok-feed", platform: "tiktok", keywords: ["tiktok", "videos", "hashtag", "search", "topic", "keyword", "feed", "profile"], listPath: "videos", rowsPerCall: 12,
    urlHint: "https://www.tiktok.com/@<username> (latest 15)  or  https://www.tiktok.com/tag/<name> (top 30)  or  https://www.tiktok.com/search?q=<query> (top 12)", accepts: (u) => tt(u) && (/^\/@[^/]+\/?$/.test(path(u)) || /^\/tag\//.test(path(u)) || /^\/search(\/video)?\/?$/.test(path(u))), summary: "TikTok videos of a profile, a hashtag or a search, with their counts. The first page only.", note: "public data, no login" },
  "tiktok-comments": { name: "tiktok-comments", id: "contextdev.parse.tiktok-comments", platform: "tiktok", keywords: ["tiktok", "comments", "video"], listPath: "comments", rowsPerCall: 20,
    urlHint: "https://www.tiktok.com/@<username>/video/<id>", accepts: (u) => tt(u) && /^\/@[^/]+\/(video|photo)\/\d+/.test(path(u)), summary: "The first 20 top-level comments of one TikTok video (use the TREG comments sources for more).", note: "first page only; replies are not included" },
  "tiktok-followers": { name: "tiktok-followers", id: "contextdev.parse.tiktok-followers", platform: "tiktok", keywords: ["tiktok", "followers", "audience"], listPath: "users", rowsPerCall: 30,
    urlHint: "https://www.tiktok.com/@<username>", accepts: (u) => tt(u) && /^\/@[^/]+\/?$/.test(path(u)), summary: "Up to 30 followers of a TikTok profile (first page).", note: "empty when the profile hides the list" },
  "tiktok-following": { name: "tiktok-following", id: "contextdev.parse.tiktok-following", platform: "tiktok", keywords: ["tiktok", "following", "accounts"], listPath: "users", rowsPerCall: 30,
    urlHint: "https://www.tiktok.com/@<username>", accepts: (u) => tt(u) && /^\/@[^/]+\/?$/.test(path(u)), summary: "Up to 30 accounts a TikTok profile follows (first page).", note: "empty when the profile hides the list" },
  "tiktok-user-search": { name: "tiktok-user-search", id: "contextdev.parse.tiktok-user-search", platform: "tiktok", keywords: ["tiktok", "users", "accounts", "creators", "influencers", "search"], listPath: "users", rowsPerCall: 10,
    urlHint: "https://www.tiktok.com/search/user?q=<query>", accepts: (u) => tt(u) && /^\/search\/user\/?$/.test(path(u)) && u.searchParams.has("q"), summary: "The top 10 TikTok accounts for a search query: name, bio, followers, likes, verified.", note: "public data, no login" },
  "g2-reviews": { name: "g2-reviews", id: "contextdev.parse.g2-reviews", platform: "g2", keywords: ["g2", "software", "reviews", "product", "saas"], listPath: "reviews", rowsPerCall: 25,
    urlHint: "https://www.g2.com/products/<slug>/reviews", accepts: (u) => host(u) === "g2.com" && /^\/products\//.test(path(u)), summary: "The 25 most recent G2 reviews of a software product, optionally filtered by stars.", note: "25 at most; no paging" },
  "emails": { name: "emails", id: "contextdev.parse.emails", platform: "web", keywords: ["email", "emails", "contact", "website", "company", "mailto"], listPath: "emails", rowsPerCall: 5,
    urlHint: "any public page (a company's own contact page)", accepts: () => true, summary: "The e-mail addresses written on ONE public page (mailto links and visible text; deduplicated, placeholders removed). It does not crawl: open the company's own site, then its contact page.", note: "one page only" },
  "phone-numbers": { name: "phone-numbers", id: "contextdev.parse.phone-numbers", platform: "web", keywords: ["phone", "phones", "mobile", "tel", "contact", "website", "company", "numbers"], listPath: "phone_numbers", rowsPerCall: 3,
    urlHint: "any public page (a company's own contact page)", accepts: () => true, summary: "The phone numbers on ONE public page (tel links and visible text), normalized to international form. It does not crawl.", note: "one page only" },
  "links": { name: "links", id: "contextdev.parse.links", platform: "web", keywords: ["links", "urls", "contact", "page", "website", "navigation"], listPath: "links", rowsPerCall: 60,
    urlHint: "any public page", accepts: () => true, summary: "The links of ONE public page (url and visible text): use it to find a company's contact page. It does not crawl.", note: "one page only" },
};

export const PARSER_IDS: Record<string, ParserName> = Object.fromEntries(Object.values(PARSERS).map((p) => [p.id, p.name]));

export interface WebSourceSpec { id: string; provider: "firecrawl" | "contextdev"; kind: "search" | "scrape" | "people_search"; keywords: string[]; platform: string; usdPerCall: number; rowsPerCall: number; summary: string; inputs: string }

export const WEB_SOURCES: WebSourceSpec[] = [
  { id: "firecrawl.search", provider: "firecrawl", kind: "search", keywords: ["web", "search", "google", "pages", "articles", "news", "sites"], platform: "web", usdPerCall: 2 * FIRECRAWL_USD_PER_CREDIT, rowsPerCall: 10, summary: "Web search: title, address and description of up to 10 results (2 credits per 10).", inputs: "query, limit (10 to 100), country" },
  { id: "contextdev.search", provider: "contextdev", kind: "search", keywords: ["web", "search", "pages", "articles", "news", "sites"], platform: "web", usdPerCall: CONTEXTDEV_USD_PER_CREDIT, rowsPerCall: 10, summary: "Web search: title, address and description of up to 10 results (1 credit per 10).", inputs: "query, limit (10 to 100), country" },
  { id: "firecrawl.scrape", provider: "firecrawl", kind: "scrape", keywords: ["page", "read", "scrape", "website", "text", "markdown", "article"], platform: "web", usdPerCall: FIRECRAWL_USD_PER_CREDIT, rowsPerCall: 1, summary: "One public page as text with its links (1 credit).", inputs: "url" },
  { id: "contextdev.scrape", provider: "contextdev", kind: "scrape", keywords: ["page", "read", "scrape", "website", "text", "markdown", "article"], platform: "web", usdPerCall: CONTEXTDEV_USD_PER_CREDIT, rowsPerCall: 1, summary: "One public page as text with its links (1 credit).", inputs: "url" },
  { id: "contextdev.people.search", provider: "contextdev", kind: "people_search", keywords: ["people", "person", "professionals", "decision", "makers", "employees", "role", "title", "linkedin", "contact"], platform: "people", usdPerCall: CONTEXTDEV_PEOPLE_SEARCH_CREDITS * CONTEXTDEV_USD_PER_CREDIT, rowsPerCall: CONTEXTDEV_PEOPLE_SEARCH_PAGE_ROWS, summary: "Professionals found from a plain-language description (for example VPs of sales at solar companies in California): name, role, company, location, public profile links, 10 per page (10 credits). It returns NO e-mail and NO phone: use it to find people, and a contact source for their e-mails and phones.", inputs: "query (up to 500 characters), country (two letters, optional), cursor (the next_cursor of the previous page)" },
];

export const WEB_SOURCE_IDS: ReadonlySet<string> = new Set(WEB_SOURCES.map((s) => s.id));
export const isAgentSourceId = (id: string): boolean => WEB_SOURCE_IDS.has(id) || Object.prototype.hasOwnProperty.call(PARSER_IDS, id);

/** Sources whose rows are work e-mails or phones: a mission that promises contacts needs one of these (or a TREG b2b_contact endpoint). */
export const CONTACT_PARSER_IDS: ReadonlySet<string> = new Set([PARSERS.emails.id, PARSERS["phone-numbers"].id]);

export function usdPerRowOfParser(spec: ParserSpec): number { return CONTEXTDEV_PARSE_USD_ESTIMATE / Math.max(1, spec.rowsPerCall); }

export interface SourceCandidate { id: string; kind: "web_parser" | "web_search" | "web_scrape" | "people_search"; platform: string; summary: string; usd_per_call: number; rows_per_call: number; usd_per_row: number; inputs: string }

const norm = (w: string) => w.trim().toLowerCase();

/** The agent's web candidates for a search: matched on the platform and the English words, with a cost per row computed by code. Sorted cheapest first by the caller together with the TREG candidates. */
export function searchAgentSources(input: { words?: string[]; platform?: string; /** Only the sources this says are available are candidates (a provider the worker has no key for is not offered). */ isAvailable?: (id: string) => boolean }): SourceCandidate[] {
  const words = (input.words ?? []).map(norm).filter(Boolean);
  const platform = input.platform ? norm(input.platform) : "";
  const out: Array<SourceCandidate & { score: number }> = [];
  const consider = (c: SourceCandidate, keywords: string[], plat: string) => {
    if (input.isAvailable && !input.isAvailable(c.id)) return;
    const platformHit = platform && (plat === platform || keywords.includes(platform));
    const hits = words.filter((w) => keywords.includes(w)).length;
    // with a platform filter only that platform's sources are candidates (X, Facebook and YouTube have no parser: they stay on the catalog)
    if (platform) { if (!platformHit) return; } else if (hits === 0) return;
    out.push({ ...c, score: (platformHit ? 2 : 0) + hits });
  };
  for (const p of Object.values(PARSERS)) {
    const perRow = usdPerRowOfParser(p);
    consider({ id: p.id, kind: "web_parser", platform: p.platform, summary: p.summary, usd_per_call: CONTEXTDEV_PARSE_USD_ESTIMATE, rows_per_call: p.rowsPerCall, usd_per_row: perRow, inputs: `url (${p.urlHint})${p.params ? `; optional ${p.params.join(", ")}` : ""}` }, p.keywords, p.platform);
  }
  for (const s of WEB_SOURCES) {
    consider({ id: s.id, kind: s.kind === "search" ? "web_search" : s.kind === "scrape" ? "web_scrape" : "people_search", platform: s.platform, summary: s.summary, usd_per_call: s.usdPerCall, rows_per_call: s.rowsPerCall, usd_per_row: s.usdPerCall / Math.max(1, s.rowsPerCall), inputs: s.inputs }, s.keywords, s.platform);
  }
  return out.sort((a, b) => b.score - a.score || a.usd_per_row - b.usd_per_row).map(({ score: _score, ...c }) => c);
}

export function describeAgentSource(id: string): (SourceCandidate & { how: string; limits: string }) | null {
  const parserName = PARSER_IDS[id];
  if (parserName) {
    const p = PARSERS[parserName];
    return { id, kind: "web_parser", platform: p.platform, summary: p.summary, usd_per_call: CONTEXTDEV_PARSE_USD_ESTIMATE, rows_per_call: p.rowsPerCall, usd_per_row: usdPerRowOfParser(p), inputs: `url (${p.urlHint})${p.params ? `; optional ${p.params.join(", ")}` : ""}`, how: `call parse_page with parser "${p.name}" and the url; the answer's rows are in ${p.listPath ? `data.${p.listPath}` : "data (one object)"}; a parse that failed has no rows and costs nothing`, limits: p.note };
  }
  const s = WEB_SOURCES.find((x) => x.id === id);
  if (!s) return null;
  const tool = s.kind === "search" ? "web_search" : s.kind === "scrape" ? "web_scrape" : "people_search";
  return { id, kind: s.kind === "search" ? "web_search" : s.kind === "scrape" ? "web_scrape" : "people_search", platform: s.platform, summary: s.summary, usd_per_call: s.usdPerCall, rows_per_call: s.rowsPerCall, usd_per_row: s.usdPerCall / Math.max(1, s.rowsPerCall), inputs: s.inputs, how: `call ${tool}${s.kind === "people_search" ? "" : ` with provider "${s.provider}"`}`, limits: s.kind === "people_search" ? "10 people a page; at most 1,000 people for a query; no e-mail, no phone" : "a public page only" };
}

/**
 * SOURCES THAT REFUSE WHAT THEIR INPUT SCHEMA ACCEPTS. `crawl4ai.x.search.posts` takes `query` and `limit` (the payload is valid), but its catalog description says: "Without [an X login session] only from:<account> ...
 * in mode latest ... Other queries are refused, not billed." A topic search («محمد صلاح») therefore answers HTTP 400 and costs nothing (mission msn_480a44f90e1784edbc94: http 400, 905 ms, cost 0). A mission never has the
 * customer's own login, so the call is refused here, BEFORE it is made, with the reason the model needs to go on to the next source.
 */
export const SESSION_RESTRICTED_SOURCES: Readonly<Record<string, { param: string; allowed: RegExp; message: string }>> = {
  "crawl4ai.x.search.posts": {
    param: "query",
    allowed: /^\s*from:@?[A-Za-z0-9_]{1,15}(\s|$)/i,
    message: "this source answers only `from:<account>` searches (that account's timeline); a topic search needs the customer's own X login, which a mission never has, so it would be refused. It was NOT called and cost nothing: sample the next source of the ranking",
  },
};

/** The reason a call would be refused by the source itself (so it is not made), or null. */
export function sessionRestriction(endpointId: string, params: Record<string, unknown>): string | null {
  const rule = SESSION_RESTRICTED_SOURCES[endpointId];
  if (!rule) return null;
  const value = params[rule.param];
  return typeof value === "string" && rule.allowed.test(value) ? null : rule.message;
}
