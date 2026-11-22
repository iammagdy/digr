import { CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT } from "../multiProvider/catalog";
import rawWebSources from "../../../data/capabilities/web-sources.json";

/**
 * THE AGENT'S WEB SOURCES, as data: pre-built page parsers, web search, page scrape,
 * and people search loaded dynamically from data/capabilities/web-sources.json.
 * Pure: no network, no secret. The gateway (agent/src/webGateway.ts) is the only thing that calls them.
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
  provider: string;
  platform: string;
  capability?: string;
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

export interface WebSourceSpec {
  id: string;
  provider: string;
  kind: "search" | "scrape" | "people_search";
  platform: string;
  capability?: string;
  usdPerCall: number;
  rowsPerCall: number;
  summary: string;
  inputs: string;
}

interface RawUrlRule {
  hosts?: string[];
  hostPattern?: string;
  pathPattern?: string;
  excludePathPattern?: string;
  requireQueryParam?: string;
}

interface RawParserItem {
  name: string;
  id: string;
  provider: string;
  platform: string;
  capability?: string;
  listPath: string | null;
  rowsPerCall: number;
  usdEstimate?: number;
  urlHint: string;
  params?: Array<"sort" | "limit">;
  summary: string;
  note: string;
  urlRules?: RawUrlRule[];
}

interface RawWebSourceItem {
  id: string;
  provider: string;
  kind: "search" | "scrape" | "people_search";
  platform: string;
  capability?: string;
  usdPerCall: number;
  rowsPerCall: number;
  summary: string;
  inputs: string;
}

const host = (u: URL) => u.hostname.toLowerCase().replace(/^www\./, "");
const pathname = (u: URL) => u.pathname;

function matchUrlRule(rule: RawUrlRule, u: URL): boolean {
  const h = host(u);
  const p = pathname(u);

  if (rule.hosts && rule.hosts.length > 0) {
    if (!rule.hosts.includes(h)) return false;
  }
  if (rule.hostPattern) {
    if (!new RegExp(rule.hostPattern).test(h)) return false;
  }
  if (rule.pathPattern) {
    if (!new RegExp(rule.pathPattern).test(p)) return false;
  }
  if (rule.excludePathPattern) {
    if (new RegExp(rule.excludePathPattern).test(p)) return false;
  }
  if (rule.requireQueryParam) {
    if (!u.searchParams.has(rule.requireQueryParam)) return false;
  }
  return true;
}

function compileAccepts(rules?: RawUrlRule[]): (u: URL) => boolean {
  if (!rules || rules.length === 0) return () => true;
  return (u: URL) => rules.some((rule) => matchUrlRule(rule, u));
}

export const PARSERS: Record<ParserName, ParserSpec> = Object.fromEntries(
  (rawWebSources.parsers as RawParserItem[]).map((raw) => [
    raw.name as ParserName,
    {
      name: raw.name as ParserName,
      id: raw.id,
      provider: raw.provider,
      platform: raw.platform,
      capability: raw.capability,
      listPath: raw.listPath,
      rowsPerCall: raw.rowsPerCall,
      urlHint: raw.urlHint,
      accepts: compileAccepts(raw.urlRules),
      params: raw.params,
      summary: raw.summary,
      note: raw.note,
    },
  ])
) as Record<ParserName, ParserSpec>;

export const PARSER_IDS: Record<string, ParserName> = Object.fromEntries(
  Object.values(PARSERS).map((p) => [p.id, p.name])
);

export const WEB_SOURCES: WebSourceSpec[] = (rawWebSources.webSources as RawWebSourceItem[]).map((raw) => ({
  id: raw.id,
  provider: raw.provider,
  kind: raw.kind,
  platform: raw.platform,
  capability: raw.capability,
  usdPerCall: raw.usdPerCall,
  rowsPerCall: raw.rowsPerCall,
  summary: raw.summary,
  inputs: raw.inputs,
}));

export const WEB_SOURCE_IDS: ReadonlySet<string> = new Set(WEB_SOURCES.map((s) => s.id));
export const isAgentSourceId = (id: string): boolean =>
  WEB_SOURCE_IDS.has(id) || Object.prototype.hasOwnProperty.call(PARSER_IDS, id);

export const WEB_PROVIDERS: readonly string[] = Array.from(
  new Set([...Object.values(PARSERS).map((p) => p.provider), ...WEB_SOURCES.map((s) => s.provider)])
);

/** Sources whose rows are work e-mails or phones: a mission that promises contacts needs one of these (or a TREG b2b_contact endpoint). */
export const CONTACT_PARSER_IDS: ReadonlySet<string> = new Set([
  PARSERS.emails.id,
  PARSERS["phone-numbers"].id,
]);

export function usdPerRowOfParser(spec: ParserSpec): number {
  return CONTEXTDEV_PARSE_USD_ESTIMATE / Math.max(1, spec.rowsPerCall);
}

export interface SourceCandidate {
  id: string;
  kind: "web_parser" | "web_search" | "web_scrape" | "people_search";
  platform: string;
  summary: string;
  usd_per_call: number;
  rows_per_call: number;
  usd_per_row: number;
  inputs: string;
}

const norm = (w: string) => w.trim().toLowerCase();

function extractTokens(parts: Array<string | undefined | null>): Set<string> {
  const set = new Set<string>();
  for (const part of parts) {
    if (!part) continue;
    const lower = part.toLowerCase();
    const rawTokens = lower.split(/[^a-z0-9_-]+/);
    for (const t of rawTokens) {
      if (!t) continue;
      set.add(t);
      if (t.length > 3 && t.endsWith("s")) {
        set.add(t.slice(0, -1));
        if (t.endsWith("es")) set.add(t.slice(0, -2));
      }
      if (t.includes("-") || t.includes("_")) {
        for (const sub of t.split(/[-_]+/)) {
          if (sub) {
            set.add(sub);
            if (sub.length > 3 && sub.endsWith("s")) {
              set.add(sub.slice(0, -1));
            }
          }
        }
      }
    }
  }
  return set;
}

/** The agent's web candidates for a search: matched on the platform and English words, with a cost per row computed by code. Sorted cheapest first by the caller together with the TREG candidates. */
export function searchAgentSources(input: {
  words?: string[];
  platform?: string;
  /** Only the sources this says are available are candidates (a provider the worker has no key for is not offered). */
  isAvailable?: (id: string) => boolean;
}): SourceCandidate[] {
  const words = (input.words ?? []).map(norm).filter(Boolean);
  const platform = input.platform ? norm(input.platform) : "";
  const out: Array<SourceCandidate & { score: number }> = [];

  const consider = (c: SourceCandidate, tokens: Set<string>, plat: string) => {
    if (input.isAvailable && !input.isAvailable(c.id)) return;
    const platformHit = Boolean(platform && (plat === platform || tokens.has(platform)));
    const hits = words.filter((w) => tokens.has(w) || (w.endsWith("s") && tokens.has(w.slice(0, -1)))).length;
    // with a platform filter only that platform's sources are candidates (X, Facebook and YouTube have no parser: they stay on the catalog)
    if (platform) {
      if (!platformHit) return;
    } else if (hits === 0) {
      return;
    }
    out.push({ ...c, score: (platformHit ? 2 : 0) + hits });
  };

  for (const p of Object.values(PARSERS)) {
    const perRow = usdPerRowOfParser(p);
    const tokens = extractTokens([p.platform, p.capability, p.id, p.summary, p.name]);
    consider(
      {
        id: p.id,
        kind: "web_parser",
        platform: p.platform,
        summary: p.summary,
        usd_per_call: CONTEXTDEV_PARSE_USD_ESTIMATE,
        rows_per_call: p.rowsPerCall,
        usd_per_row: perRow,
        inputs: `url (${p.urlHint})${p.params ? `; optional ${p.params.join(", ")}` : ""}`,
      },
      tokens,
      p.platform
    );
  }

  for (const s of WEB_SOURCES) {
    const tokens = extractTokens([s.platform, s.capability, s.id, s.summary]);
    consider(
      {
        id: s.id,
        kind: s.kind === "search" ? "web_search" : s.kind === "scrape" ? "web_scrape" : "people_search",
        platform: s.platform,
        summary: s.summary,
        usd_per_call: s.usdPerCall,
        rows_per_call: s.rowsPerCall,
        usd_per_row: s.usdPerCall / Math.max(1, s.rowsPerCall),
        inputs: s.inputs,
      },
      tokens,
      s.platform
    );
  }

  return out.sort((a, b) => b.score - a.score || a.usd_per_row - b.usd_per_row).map(({ score: _score, ...c }) => c);
}

export function describeAgentSource(id: string): (SourceCandidate & { how: string; limits: string }) | null {
  const parserName = PARSER_IDS[id];
  if (parserName) {
    const p = PARSERS[parserName];
    return {
      id,
      kind: "web_parser",
      platform: p.platform,
      summary: p.summary,
      usd_per_call: CONTEXTDEV_PARSE_USD_ESTIMATE,
      rows_per_call: p.rowsPerCall,
      usd_per_row: usdPerRowOfParser(p),
      inputs: `url (${p.urlHint})${p.params ? `; optional ${p.params.join(", ")}` : ""}`,
      how: `call parse_page with parser "${p.name}" and the url; the answer's rows are in ${p.listPath ? `data.${p.listPath}` : "data (one object)"}; a parse that failed has no rows and costs nothing`,
      limits: p.note,
    };
  }
  const s = WEB_SOURCES.find((x) => x.id === id);
  if (!s) return null;
  const tool = s.kind === "search" ? "web_search" : s.kind === "scrape" ? "web_scrape" : "people_search";
  return {
    id,
    kind: s.kind === "search" ? "web_search" : s.kind === "scrape" ? "web_scrape" : "people_search",
    platform: s.platform,
    summary: s.summary,
    usd_per_call: s.usdPerCall,
    rows_per_call: s.rowsPerCall,
    usd_per_row: s.usdPerCall / Math.max(1, s.rowsPerCall),
    inputs: s.inputs,
    how: `call ${tool}${s.kind === "people_search" ? "" : ` with provider "${s.provider}"`}`,
    limits: s.kind === "people_search" ? "10 people a page; at most 1,000 people for a query; no e-mail, no phone" : "a public page only",
  };
}

export type WebProvider = "firecrawl" | "contextdev";

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
