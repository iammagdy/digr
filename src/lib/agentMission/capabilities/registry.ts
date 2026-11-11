import { isSellable, type CatalogEndpoint, type TregCatalog } from "../../treg/catalog";
import { expectedCost, priorRowsPerCall } from "../sourceRanking";
import { canExpress, toolProfile } from "../toolProfile";
import { CONTEXTDEV_PARSE_USD_ESTIMATE, PARSERS, WEB_SOURCES, type ParserName } from "../sources";

/**
 * UNIFIED CAPABILITY REGISTRY (docs/UNIFIED-CAPABILITY-DISCOVERY.md). ONE list of what the existing providers can actually do, built from what the repository already holds, with no network and no paid call:
 *   - TREG: the attached catalog snapshot (`data/treg/*`, loaded by `loadTregCatalog`): each endpoint's capability string, its inputs (`toolProfile`), its documented output fields (`item_fields`), its paging and its price (`expectedCost`);
 *   - Firecrawl: the web search and page scrape the existing adapter calls (`sources.ts` WEB_SOURCES);
 *   - Context.dev: the web search, page scrape, the documented pre-built parsers and people search (`sources.ts` PARSERS / WEB_SOURCES).
 * Searching TREG's ENDPOINT CATALOG is a lookup in this local file; searching the PUBLIC WEB with Firecrawl or Context.dev is a paid operation those capabilities PERFORM. They are different things: the registry lists the second as capabilities, it never calls them.
 *
 * Each entry says, as data the code checks: which data OPERATION it performs, for which platform, which inputs it needs, which output fields it can return (and whether that is documented or unknown), whether it pages, which filters it can
 * express, its price per row, whether it touches private personal data, and whether it is available to this account now (sellable, not blocked, permitted by the account's data policy, the provider's key present, its daily cap above 0).
 * An endpoint whose capability string matches no operation below is not a candidate at all: nothing outside this list can be planned through discovery. Pure; never throws.
 */
export type CapabilityProvider = "treg" | "firecrawl" | "contextdev";

export const OPERATIONS = [
  "social.parents",
  "social.comments",
  "social.replies",
  "companies.discover",
  "company.contacts",
  "places.discover",
  "places.reviews",
  "web.search",
  "web.read",
  "people.discover",
] as const;
export type Operation = (typeof OPERATIONS)[number];

/** The classes of output field the stages need from one another and the customer needs in the file. */
export type OutputClass = "id" | "url" | "text" | "date" | "author" | "rating" | "name" | "website" | "email" | "phone" | "place_ref" | "comment_count" | "title" | "company";
/** The classes of input a capability takes. `query` comes from the customer's topic; every other one must come from the parent stage's rows. */
export type InputClass = "query" | "url" | "post_ref" | "comment_ref" | "place_ref" | "domain";

export interface Capability {
  /** The id the plan, the gateway and the call log use: a catalog endpoint id, or a web source id (`firecrawl.search`, `contextdev.parse.google-maps-reviews` …). */
  id: string;
  provider: CapabilityProvider;
  operation: Operation;
  /** The platform the data comes from (`tiktok`, `x` …, `google_maps`, `web`, or null when the capability is not tied to one). */
  platform: string | null;
  /** The input classes it accepts (any one of them is enough). */
  takes: InputClass[];
  /** The output classes its rows carry. */
  outputs: OutputClass[];
  /** True when the outputs come from the provider's documentation or the catalog's recorded fields; false when the catalog records no fields (the outputs must be PROVEN on a sampled page before a plan may rely on them). */
  outputsKnown: boolean;
  /** A cursor or page input: more rows than one call gives can be collected. */
  pagination: boolean;
  /** Rows one call returns at most. */
  maxRowsPerCall: number;
  filters: { date: boolean; country: boolean; language: boolean };
  /** Expected USD per row (null: the catalog has no usable price; never ranked above a priced one). */
  usdPerRow: number | null;
  /** «private_personal»: it returns private personal data (a personal e-mail or phone, a private chat). Never eligible, whatever anyone selects. */
  privacy: "public" | "private_personal";
  /** Null when the capability can be used by this account now; otherwise why not. */
  unavailable: null | "provider_key_missing" | "provider_daily_cap_zero" | "not_sellable" | "blocked" | "not_permitted";
  /** A short English description for the planner (never shown to the customer). */
  summary: string;
  /** Documented limits («first 20 only», «one page», …). */
  limits: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// TREG: capability string → operation
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const SOCIAL = "(tiktok|x|instagram|facebook|youtube)";
const TREG_RULES: ReadonlyArray<{ re: RegExp; operation: Operation }> = [
  { re: new RegExp(`^${SOCIAL}\\.(search\\.(videos|posts|reels|general|shorts)|hashtag\\.(videos|posts)|user\\.(videos|posts|reels)|channel\\.videos|page\\.posts|group\\.posts)$`), operation: "social.parents" },
  { re: new RegExp(`^${SOCIAL}\\.(video|post)\\.comments$`), operation: "social.comments" },
  { re: new RegExp(`^${SOCIAL}\\.comment\\.replies$`), operation: "social.replies" },
  { re: /^(companies\.search|companies\.businesses\.search|linkedin\.search\.companies)$/, operation: "companies.discover" },
  { re: /^companies\.emails\.(list|role)$/, operation: "company.contacts" },
  { re: /^(google\.serp\.(maps|local)|bing\.maps\.search|tripadvisor\.search\.businesses|yelp\.business\.search|apple-maps\.places)$/, operation: "places.discover" },
  { re: /^(google\.maps\.reviews|tripadvisor\.business\.reviews|yelp\.business\.reviews|apple-maps\.reviews)$/, operation: "places.reviews" },
  { re: /^(web\.search|google\.serp\.organic|google\.serp\.news|bing\.serp\.organic|web\.search\.news)$/, operation: "web.search" },
  { re: /^(web\.extract|web\.scrape\.structured)$/, operation: "web.read" },
  { re: /^(people\.search|linkedin\.search\.people|companies\.employees(\.list|\.search)?|linkedin\.company\.people|people\.employees\.search|people\.decision_makers)$/, operation: "people.discover" },
];

/**
 * Capability strings that return PRIVATE PERSONAL data (a personal e-mail or phone, the person behind a phone number or an e-mail, home addresses, hashed audiences, private chats). They are never mapped to an operation and a selection of one
 * is refused by code (`selection.ts`), whatever a model or a plan says.
 */
export const PRIVATE_CAPABILITY = /(^|\.)personal(\.|$)|^people\.(profile\.from_phone|identity\.from_email|address\.|audience|audiences|email\.personal|phone\.find\.personal)|^x\.chat\.|\.chat\.(conversation|conversations|media)|^people\.phone\.live|^people\.phone\.network/;
export const isPrivateCapabilityString = (capability: string | null | undefined): boolean => PRIVATE_CAPABILITY.test(String(capability ?? ""));

export function operationOfCapability(capability: string | null | undefined): Operation | null {
  const c = String(capability ?? "");
  if (!c || isPrivateCapabilityString(c)) return null;
  for (const r of TREG_RULES) if (r.re.test(c)) return r.operation;
  return null;
}

const FIELD_RULES: ReadonlyArray<[OutputClass, RegExp]> = [
  ["place_ref", /^(place_?id|placeid|cid|data_?id|data_?cid|fid|google_?maps_?url|reviews_?link|place_?id_?search|place)$/i],
  ["comment_count", /^(comments?_?count|comment_?count|commentcount|num_?comments|reply_?count|replies_?count|comments)$/i],
  ["email", /e-?mails?|email_?domain|home_?page_?email/i],
  ["phone", /phone|^tel$|telephone/i],
  ["website", /website|domain|homepage|^urls?$|^company_?url$|^site$/i],
  ["rating", /^(rating|stars|max_?rating|score|rating_?value)$/i],
  ["date", /date|time|created|published|timestamp|_at$|^at$/i],
  ["author", /author|^user$|owner|reviewer|nickname|username|^by$/i],
  ["url", /url|link|permalink/i],
  ["text", /^(text|content|message|message_rich|caption|snippet|extracted_snippet|desc|description|body|comment|review|review_text|title|full_text|tweet)$/i],
  ["name", /^(name|title|company_?name|display_?name|organization|legal_?name|fullname|full_?name|business_?name)$/i],
  ["id", /^(id|uuid|cid|urn|.*_id|.*Id|aweme_?id|post_?id|video_?id|comment_?id|review_?id|tweet_?id)$/],
];

function outputsOfFields(fields: ReadonlyArray<string>): OutputClass[] {
  const out = new Set<OutputClass>();
  for (const f of fields) for (const [cls, re] of FIELD_RULES) if (re.test(f)) out.add(cls);
  return [...out];
}

const INPUT_RULES: ReadonlyArray<[InputClass, RegExp]> = [
  ["comment_ref", /^(comment_?id|commentid|cid|parent_?comment_?id|comment)$/i],
  ["place_ref", /^(place_?id|placeid|place|cid|data_?id|fid|location_?id|business_?id|business|location)$/i],
  ["post_ref", /^(aweme_?id|video_?id|post_?id|tweet_?id|media_?id|shortcode|code|id|post|video|feedback_?id|item_?id|urn)$/i],
  ["domain", /^(domain|domainorcompany|website|company_?domain|company)$/i],
  ["url", /^(url|link|post_?url|video_?url|page_?url|place_?url|target)$/i],
];

function takesOf(endpoint: CatalogEndpoint, operation: Operation): InputClass[] {
  const out = new Set<InputClass>();
  const profile = toolProfile(endpoint);
  if (profile.query) out.add("query");
  for (const input of endpoint.inputs) for (const [cls, re] of INPUT_RULES) if (re.test(input.name)) { out.add(cls); break; }
  // an endpoint with no input of its own (a routed search that takes filters only) is fed from the customer's words
  if ((operation === "companies.discover" || operation === "people.discover" || operation === "places.discover") && out.size === 0) out.add("query");
  return [...out];
}

export interface RegistryAvailability {
  /** The account's data policy and the block list, as the gateway applies them (a catalog id the account may not call is not available). */
  isAllowed: (endpointId: string) => boolean;
  /** Whether the worker has a key for each web provider (webAvailability.ts). Absent: unknown, counted as present (the gateway still refuses a call it cannot make). */
  webKeys?: Partial<Record<"firecrawl" | "contextdev", boolean>>;
  /** The provider's daily cap in USD (admin page, provider limits). 0 = spend nothing. Absent: unknown (the recorder still refuses a call over the cap). */
  dailyCapUsd?: Partial<Record<"firecrawl" | "contextdev", number>>;
}

function webUnavailable(provider: "firecrawl" | "contextdev", a: RegistryAvailability): Capability["unavailable"] {
  if (a.webKeys && a.webKeys[provider] === false) return "provider_key_missing";
  const cap = a.dailyCapUsd?.[provider];
  if (typeof cap === "number" && !(cap > 0)) return "provider_daily_cap_zero";
  return null;
}

/** The documented capabilities of Context.dev's pre-built parsers that serve an operation of the registry (sources.ts, read from docs.context.dev on 2026-10-28). Parsers not listed serve no operation here. */
const PARSER_CAPABILITIES: Partial<Record<ParserName, Array<{ operation: Operation; takes: InputClass[]; outputs: OutputClass[]; pagination: boolean }>>> = {
  "google-maps": [
    { operation: "places.discover", takes: ["query"], outputs: ["name", "rating", "website", "phone", "place_ref", "url"], pagination: false },
    { operation: "companies.discover", takes: ["query"], outputs: ["name", "website", "phone", "url"], pagination: false },
  ],
  "google-maps-reviews": [{ operation: "places.reviews", takes: ["place_ref", "url"], outputs: ["rating", "date", "text", "author", "url"], pagination: false }],
  "tiktok-feed": [{ operation: "social.parents", takes: ["query"], outputs: ["id", "url", "text", "author", "comment_count"], pagination: false }],
  "tiktok-comments": [{ operation: "social.comments", takes: ["url"], outputs: ["id", "text", "author", "date"], pagination: false }],
  "instagram-feed": [{ operation: "social.parents", takes: ["query"], outputs: ["id", "url", "text", "author", "comment_count"], pagination: false }],
  "instagram-post": [{ operation: "social.comments", takes: ["url"], outputs: ["id", "text", "author"], pagination: false }],
  emails: [{ operation: "company.contacts", takes: ["url", "domain"], outputs: ["email"], pagination: false }],
  "phone-numbers": [{ operation: "company.contacts", takes: ["url", "domain"], outputs: ["phone"], pagination: false }],
};

const WEB_CAPABILITIES: Record<string, { operation: Operation; takes: InputClass[]; outputs: OutputClass[]; pagination: boolean; country: boolean; maxRows: number }> = {
  "firecrawl.search": { operation: "web.search", takes: ["query"], outputs: ["url", "name", "text"], pagination: false, country: true, maxRows: 100 },
  "contextdev.search": { operation: "web.search", takes: ["query"], outputs: ["url", "name", "text"], pagination: false, country: true, maxRows: 100 },
  "firecrawl.scrape": { operation: "web.read", takes: ["url", "domain"], outputs: ["url", "text"], pagination: false, country: false, maxRows: 1 },
  "contextdev.scrape": { operation: "web.read", takes: ["url", "domain"], outputs: ["url", "text"], pagination: false, country: false, maxRows: 1 },
  "contextdev.people.search": { operation: "people.discover", takes: ["query"], outputs: ["name", "title", "company", "url"], pagination: true, country: true, maxRows: 10 },
};

export interface CapabilityRegistry {
  all: Capability[];
  byId: ReadonlyMap<string, Capability[]>;
}

/** Builds the registry. `catalog` is the local snapshot; nothing is fetched. */
export function buildCapabilityRegistry(catalog: TregCatalog, availability: RegistryAvailability): CapabilityRegistry {
  const all: Capability[] = [];
  for (const e of catalog.endpoints) {
    const operation = operationOfCapability(e.capability);
    if (!operation) continue;
    const platformOf = String(e.capability ?? "").split(".")[0];
    const profile = toolProfile(e);
    const fields = e.item_fields ? Object.keys(e.item_fields) : [];
    // a field that is an OBJECT (a wrapper such as `aweme_info` or `basic_info`) hides the row's real fields: the keys its example shows are read too, but the outputs are then UNPROVEN (proven on a sampled page before a plan relies on them)
    const objectFields = fields.filter((f) => e.item_fields![f].type === "object");
    const nested = objectFields.flatMap((f) => [...String(e.item_fields![f].example ?? "").matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]));
    const cost = expectedCost(e, catalog, undefined);
    const sellable = isSellable(e.id, catalog);
    let allowed = true;
    try { allowed = availability.isAllowed(e.id); } catch { allowed = false; }
    all.push({
      id: e.id,
      provider: "treg",
      operation,
      platform: operation.startsWith("social.") ? platformOf : operation.startsWith("places.") ? "google_maps" : operation.startsWith("web.") ? "web" : null,
      takes: takesOf(e, operation),
      outputs: outputsOfFields([...fields, ...nested]),
      outputsKnown: fields.length > 0 && objectFields.length === 0,
      pagination: profile.cursor !== null,
      maxRowsPerCall: priorRowsPerCall(e),
      filters: { date: canExpress(profile, "date"), country: canExpress(profile, "country"), language: canExpress(profile, "language") },
      usdPerRow: cost.usdPerItem,
      privacy: "public",
      unavailable: !sellable ? "not_sellable" : !allowed ? "not_permitted" : null,
      summary: String(e.summary ?? e.name ?? "").replace(/\s+/g, " ").slice(0, 160),
      limits: null,
    });
  }
  for (const p of Object.values(PARSERS)) {
    for (const spec of PARSER_CAPABILITIES[p.name] ?? []) {
      all.push({
        id: p.id, provider: "contextdev", operation: spec.operation, platform: p.platform, takes: spec.takes, outputs: spec.outputs, outputsKnown: true, pagination: spec.pagination, maxRowsPerCall: p.rowsPerCall,
        filters: { date: false, country: false, language: false }, usdPerRow: CONTEXTDEV_PARSE_USD_ESTIMATE / Math.max(1, p.rowsPerCall), privacy: "public", unavailable: webUnavailable("contextdev", availability), summary: p.summary.slice(0, 160), limits: p.note,
      });
    }
  }
  for (const s of WEB_SOURCES) {
    const spec = WEB_CAPABILITIES[s.id];
    if (!spec) continue;
    all.push({
      id: s.id, provider: s.provider, operation: spec.operation, platform: spec.operation === "people.discover" ? "people" : "web", takes: spec.takes, outputs: spec.outputs, outputsKnown: true, pagination: spec.pagination, maxRowsPerCall: spec.maxRows,
      filters: { date: false, country: spec.country, language: false }, usdPerRow: s.usdPerCall / Math.max(1, s.rowsPerCall), privacy: "public", unavailable: webUnavailable(s.provider, availability), summary: s.summary.slice(0, 160),
      limits: spec.operation === "people.discover" ? "no e-mail and no phone" : spec.operation === "web.read" ? "one public page per call" : null,
    });
  }
  const byId = new Map<string, Capability[]>();
  for (const c of all) byId.set(c.id, [...(byId.get(c.id) ?? []), c]);
  return { all, byId };
}

/** The capability string the catalog gives an id (null for a web source or an unknown id). */
export function catalogCapabilityOf(catalog: TregCatalog, id: string): string | null {
  return catalog.byId.get(id)?.capability ?? null;
}
