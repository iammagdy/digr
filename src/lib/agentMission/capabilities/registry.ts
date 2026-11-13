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
  // round 51: mobile apps in the stores, and their reviews (TREG store searches and reviews; Context.dev's store review parsers)
  "apps.discover",
  "apps.reviews",
] as const;
/**
 * INTERNAL OPERATIONS (Phase 2, docs/intelligence/PHASES-2-4-BASELINE.md): steps code adds INSIDE a chain, never a research objective the chat model may propose (the objective vocabulary stays exactly `OPERATIONS`).
 *   company.enrich: a company's OFFICIAL website from its name (TREG `companies.enrich`, e.g. the Context.dev brand API resold as `branddev.brand.retrieve-by-name`), between the companies and their public contacts; planned only when
 *   the `web_via_treg` switch is on and no companies source documents a website.
 */
export const INTERNAL_OPERATIONS = ["company.enrich"] as const;
export type Operation = (typeof OPERATIONS)[number] | (typeof INTERNAL_OPERATIONS)[number];

/** The classes of output field the stages need from one another and the customer needs in the file. */
export type OutputClass = "id" | "url" | "text" | "date" | "author" | "rating" | "name" | "website" | "email" | "phone" | "place_ref" | "comment_count" | "title" | "company" | "app_ref";
/** The classes of input a capability takes. `query` comes from the customer's topic; every other one must come from the parent stage's rows. */
export type InputClass = "query" | "url" | "post_ref" | "comment_ref" | "place_ref" | "domain" | "app_ref" | "company_name";

/** How a capability is reached: through the TREG gateway as one endpoint (`treg_direct`), through TREG as a ROUTED endpoint any of whose siblings may serve the call (`treg_routed`), or through Diger's own adapter with its own key (`direct`). */
export type CapabilityAccess = "treg_direct" | "treg_routed" | "direct";

/**
 * WHERE A PRICE COMES FROM (Phase 2, task 2.3). Never treated as a hard maximum by itself.
 *   verified    the catalog says the provider's price was checked against a real charge (TREG `cost_confidence: verified`);
 *   documented  the provider's documentation states it (TREG `documented`);
 *   estimated   derived by Diger: a routed endpoint priced at its dearest sibling (misses are billed too), a TREG `inferred` price, or a direct provider's credits × a USD-per-credit figure read on a date (plan-dependent);
 *   unknown     no usable price (no figure, or the catalog says unknown): never ranked above a priced capability, never production-eligible.
 */
export type PricingBasis = "verified" | "documented" | "estimated" | "unknown";
export interface CapabilityPricing {
  unit: string;
  /** USD per unit as recorded (null: none). */
  usd: number | null;
  basis: PricingBasis;
  /** Whether a failed or empty call is billed: true / false when documented, null when nothing says. */
  billedOnFailure: boolean | null;
}

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
  unavailable: null | "provider_key_missing" | "provider_daily_cap_zero" | "provider_daily_cap_exhausted" | "not_sellable" | "blocked" | "not_permitted";
  /** How it is reached (Phase 2). */
  access: CapabilityAccess;
  /** Where its price comes from (Phase 2, task 2.3). */
  pricing: CapabilityPricing;
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
  { re: /^(google-play|app-store)\.search\.apps$/, operation: "apps.discover" },
  { re: /^(google-play|app-store)\.reviews$/, operation: "apps.reviews" },
  { re: /^companies\.enrich$/, operation: "company.enrich" },
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
  ["app_ref", /^(app_?id|product_?id|bundle_?id)$/i],
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
  ["app_ref", /^(product_?id|app_?id|bundle_?id)$/i],
  ["comment_ref", /^(comment_?id|commentid|cid|parent_?comment_?id|comment)$/i],
  ["place_ref", /^(place_?id|placeid|place|cid|data_?id|fid|location_?id|business_?id|business|location)$/i],
  ["post_ref", /^(aweme_?id|video_?id|post_?id|tweet_?id|media_?id|shortcode|code|id|post|video|feedback_?id|item_?id|urn)$/i],
  ["domain", /^(domain|domainorcompany|website|company_?domain|company)$/i],
  ["url", /^(url|link|post_?url|video_?url|page_?url|place_?url|target)$/i],
];

/** The inputs of an enrichment endpoint that take a company's NAME (Phase 2): a name the parent companies stage gives. Read only for `company.enrich`, so no other operation's inputs change. */
const COMPANY_NAME_INPUT = /^(name|names|company_?name|companyName|companyNames|company)$/i;

function takesOf(endpoint: CatalogEndpoint, operation: Operation): InputClass[] {
  const out = new Set<InputClass>();
  if (operation === "company.enrich") {
    for (const input of endpoint.inputs) {
      if (COMPANY_NAME_INPUT.test(input.name)) out.add("company_name");
      else if (/^(domain|domains|website|company_?domain|companyDomain)$/i.test(input.name)) out.add("domain");
    }
    return [...out];
  }
  const profile = toolProfile(endpoint);
  if (profile.query) out.add("query");
  for (const input of endpoint.inputs) for (const [cls, re] of INPUT_RULES) if (re.test(input.name)) { out.add(cls); break; }
  // an endpoint with no input of its own (a routed search that takes filters only) is fed from the customer's words
  if ((operation === "companies.discover" || operation === "people.discover" || operation === "places.discover" || operation === "apps.discover") && out.size === 0) out.add("query");
  return [...out];
}

export interface RegistryAvailability {
  /** The account's data policy and the block list, as the gateway applies them (a catalog id the account may not call is not available). */
  isAllowed: (endpointId: string) => boolean;
  /** Whether the worker has a key for each web provider (webAvailability.ts). Absent: unknown, counted as present (the gateway still refuses a call it cannot make). */
  webKeys?: Partial<Record<"firecrawl" | "contextdev", boolean>>;
  /** The provider's daily cap in USD (admin page, provider limits). 0 = spend nothing. Absent: unknown (the recorder still refuses a call over the cap). */
  dailyCapUsd?: Partial<Record<"firecrawl" | "contextdev", number>>;
  /**
   * Phase 2 (task 2.2): what each provider has ALREADY SPENT today against its daily cap, read once before planning (`readProviderSpendToday`, read only). A provider whose cap is used up is unavailable for the rest of the day: a plan
   * is never built on a source the recorder will refuse at the first call. TREG included (its cap is `providerLimits.dailyUsd`). Absent or null: unknown (the recorder still refuses at call time).
   */
  spentTodayUsd?: Partial<Record<"treg" | "firecrawl" | "contextdev", number | null>>;
  /** TREG's own daily cap in USD, with `spentTodayUsd.treg`. Absent: unknown. */
  tregDailyCapUsd?: number;
}

/** Below this much room a provider's cap is used up for planning (the smallest call it could make costs about this). */
export const EXHAUSTED_CAP_MARGIN_USD = 0.0001;

function capUnavailable(cap: number | undefined, spent: number | null | undefined): Capability["unavailable"] {
  if (typeof cap === "number" && !(cap > 0)) return "provider_daily_cap_zero";
  if (typeof cap === "number" && typeof spent === "number" && Number.isFinite(spent) && cap - spent < EXHAUSTED_CAP_MARGIN_USD) return "provider_daily_cap_exhausted";
  return null;
}

function webUnavailable(provider: "firecrawl" | "contextdev", a: RegistryAvailability): Capability["unavailable"] {
  if (a.webKeys && a.webKeys[provider] === false) return "provider_key_missing";
  return capUnavailable(a.dailyCapUsd?.[provider], a.spentTodayUsd?.[provider]);
}

/** Whether a failed or empty call is billed, from the catalog's own words (null when they say nothing usable). */
function billedOnFailureOf(e: CatalogEndpoint): boolean | null {
  if (e.kind === "routed") return true; // «NOT free: misses are billed too» (every routed endpoint's billing note)
  const words = String((e.cost as { failed_or_empty_billed?: unknown } | undefined)?.failed_or_empty_billed ?? "").toLowerCase();
  if (!words) return null;
  if (/not billed|free|no charge|errors free/.test(words)) return false;
  if (/billed/.test(words)) return true;
  return null;
}

/** The pricing record of a TREG endpoint (task 2.3): the catalog's figure with its confidence, never upgraded. */
export function tregPricingOf(e: CatalogEndpoint): CapabilityPricing {
  const cost = (e.cost ?? {}) as { unit?: unknown; usd?: unknown };
  const usd = typeof cost.usd === "number" && Number.isFinite(cost.usd) ? cost.usd : null;
  const confidence = String((e as { cost_confidence?: unknown }).cost_confidence ?? "");
  const basis: PricingBasis = e.kind === "routed" ? "estimated" : usd === null ? "unknown" : confidence === "verified" ? "verified" : confidence === "documented" ? "documented" : confidence === "inferred" ? "estimated" : "unknown";
  return { unit: String(cost.unit ?? "call"), usd, basis, billedOnFailure: billedOnFailureOf(e) };
}

/**
 * ONE-RECORD OPERATIONS (Phase 2 finding, schema honesty): a page read or a company enrichment returns ONE record per input. The snapshot's `item_fields` describe the list at the endpoint's `list_path`; when that list is a SUB-LIST of the
 * record (the brand's colours `brand.colors`, the page's headings `metadata.headings`, a company's offices), its fields are NOT the record's: the outputs are then UNKNOWN (to be proven on a sample), never read from the sub-list.
 * A list of the records themselves (a batch: `results`, `data`, `companies`, `root` …) still documents them.
 */
const ONE_RECORD_OPERATIONS: ReadonlySet<Operation> = new Set<Operation>(["web.read", "company.enrich"]);
const RECORD_LIST_LEAF = /^(results|items|data|companies|objects|organizations|root|list)$/i;
export function subListSchema(e: CatalogEndpoint, operation: Operation): boolean {
  if (!ONE_RECORD_OPERATIONS.has(operation)) return false;
  const path = String((e as { list_path?: unknown }).list_path ?? "").trim();
  if (!path || path === "NOT FOUND") return false;
  const leaf = path.split(".").pop() ?? "";
  return !RECORD_LIST_LEAF.test(leaf);
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
  "google-play-reviews": [{ operation: "apps.reviews", takes: ["url"], outputs: ["rating", "date", "text", "author"], pagination: false }],
  "app-store-reviews": [{ operation: "apps.reviews", takes: ["url"], outputs: ["rating", "date", "text", "author"], pagination: false }],
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
    // a sub-list schema documents nothing of the record (see `subListSchema`): no field is read from it
    const fields = e.item_fields && !subListSchema(e, operation) ? Object.keys(e.item_fields) : [];
    // a field that is an OBJECT (a wrapper such as `aweme_info` or `basic_info`) hides the row's real fields: the keys its example shows are read too, but the outputs are then UNPROVEN (proven on a sampled page before a plan relies on them)
    // (a LIST wrapper named items / results / data / list hides them the same way: round 51, the Google Play app searches)
    const objectFields = fields.filter((f) => e.item_fields![f].type === "object" || (e.item_fields![f].type === "array" && /^(items|results|data|list)$/i.test(f)));
    const nested = objectFields.flatMap((f) => [...String(e.item_fields![f].example ?? "").matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]));
    const cost = expectedCost(e, catalog, undefined);
    const sellable = isSellable(e.id, catalog);
    let allowed = true;
    try { allowed = availability.isAllowed(e.id); } catch { allowed = false; }
    const tregCap = capUnavailable(availability.tregDailyCapUsd, availability.spentTodayUsd?.treg);
    all.push({
      id: e.id,
      provider: "treg",
      operation,
      platform: operation.startsWith("social.") ? platformOf : operation.startsWith("places.") ? "google_maps" : operation.startsWith("web.") ? "web" : operation.startsWith("apps.") ? platformOf.replace("-", "_") : null,
      takes: takesOf(e, operation),
      outputs: outputsOfFields([...fields, ...nested]),
      outputsKnown: fields.length > 0 && objectFields.length === 0,
      pagination: profile.cursor !== null,
      maxRowsPerCall: priorRowsPerCall(e),
      filters: { date: canExpress(profile, "date"), country: canExpress(profile, "country"), language: canExpress(profile, "language") },
      usdPerRow: cost.usdPerItem,
      privacy: "public",
      unavailable: !sellable ? "not_sellable" : !allowed ? "not_permitted" : tregCap,
      summary: String(e.summary ?? e.name ?? "").replace(/\s+/g, " ").slice(0, 160),
      limits: e.kind === "routed" ? "routed: any sibling may serve the call; misses of earlier siblings are billed up to the route cap" : null,
      access: e.kind === "routed" ? "treg_routed" : "treg_direct",
      pricing: tregPricingOf(e),
    });
  }
  for (const p of Object.values(PARSERS)) {
    for (const spec of PARSER_CAPABILITIES[p.name] ?? []) {
      all.push({
        id: p.id, provider: "contextdev", operation: spec.operation, platform: p.platform, takes: spec.takes, outputs: spec.outputs, outputsKnown: true, pagination: spec.pagination, maxRowsPerCall: p.rowsPerCall,
        filters: { date: false, country: false, language: false }, usdPerRow: CONTEXTDEV_PARSE_USD_ESTIMATE / Math.max(1, p.rowsPerCall), privacy: "public", unavailable: webUnavailable("contextdev", availability), summary: p.summary.slice(0, 160), limits: p.note,
        // no credit cost per parser is documented: the base scrape credit × a USD-per-credit figure read on 2026-10-22 (sources.ts)
        access: "direct", pricing: { unit: "call", usd: CONTEXTDEV_PARSE_USD_ESTIMATE, basis: "estimated", billedOnFailure: null },
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
      // documented credits × a USD-per-credit figure read on 2026-10-22 that depends on the plan (multiProvider/catalog.ts): an estimate, not a verified price
      access: "direct", pricing: { unit: "call", usd: s.usdPerCall, basis: "estimated", billedOnFailure: null },
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
