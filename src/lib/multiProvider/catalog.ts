import { recordCostFor } from "../recordPricing";
import type { CapabilityDef, DataProviderId } from "./types";

/**
 * The capability registry of the multi-provider feature: provider + operation + unit + cost per unit + the fields it can return.
 * Prices are READ FROM THE OFFICIAL DOCUMENTATION and carry the page they came from; a price that cannot be read there is
 * UNVERIFIED and the capability is never sold (see `isSellable`). Nothing here is invented, and nothing here is shown to customers.
 *
 * Read on 2026-10-22:
 *  - Firecrawl credits per operation   https://docs.firecrawl.dev/billing       (scrape 1 / page, map 1 / call, search 2 / 10 results, JSON +4 / page, crawl 1 / page)
 *  - Firecrawl USD per credit           https://www.firecrawl.dev/pricing        (extra credits per 5 USD: Hobby 1,000, Standard 2,000, Growth 2,500, Scale 5,000; the billing page lists the same table)
 *  - Context.dev credits per operation  https://docs.context.dev/account/credits (scrape 1, map 1, search 1 / 10 results, JSON +4, people 20 / returned match)
 *  - Context.dev USD per credit         https://context.dev/pricing              (Developer 19 USD for 7,500 credits, overage 2.20 / 1,000; higher plans cheaper per credit)
 *  - Context.dev documentation says the price per credit is "not on this page" and points to the pricing page above.
 */

export const FIRECRAWL_BILLING_URL = "https://docs.firecrawl.dev/billing";
export const FIRECRAWL_PRICING_URL = "https://www.firecrawl.dev/pricing";
export const CONTEXTDEV_CREDITS_URL = "https://docs.context.dev/account/credits";
export const CONTEXTDEV_PRICING_URL = "https://context.dev/pricing";

/**
 * USD per credit. The two providers sell credits at a different price on each plan, and the platform's plan is the owner's choice,
 * so the figure used is the HIGHEST per-credit rate among the listed plans: a price built on it never undercuts the real cost.
 *  - Firecrawl 0.005: pay-as-you-go on the Hobby plan, 5 USD for 1,000 credits (the subscription rate is lower: 16 USD for 5,000 = 0.0032).
 *  - Context.dev 0.00254: Developer plan, 19 USD for 7,500 credits = 0.002533 (the overage rate is 0.0022; higher plans are cheaper).
 * If the owner's plan is cheaper, lower the constant: every price in the registry follows.
 */
export const FIRECRAWL_USD_PER_CREDIT = 0.005;
export const CONTEXTDEV_USD_PER_CREDIT = 0.00254;

export interface ProviderFacts {
  id: DataProviderId;
  /** Admin screens only. */
  labelAr: string;
  baseUrl: string | null;
  usdPerCredit: number | null;
  usdPerCreditBasisAr: string;
  docs: string[];
  /** Calls running at the same time inside one chunk. Both services limit concurrent requests per plan (Free: 2), so the lowest is used. */
  maxConcurrentCalls: number;
  /** One call is abandoned after this long, so a slow site cannot outlast the worker's own time limit. */
  callTimeoutMs: number;
  /** Most billed calls one chunk of one job may make on this provider. */
  maxCallsPerChunk: number;
  /** The documented rate limit, for the record (never enforced from here: a 429 is mapped and the call falls back). */
  rateLimitNote: string;
  /** The free, authenticated read of the real credits: endpoint and the fields used. Null when the provider has none. */
  balanceApi: { method: "GET"; url: string; fields: string; costsCredits: false; docs: string } | null;
}

export const PROVIDER_FACTS: Record<DataProviderId, ProviderFacts> = {
  treg: {
    id: "treg",
    labelAr: "مزود البيانات (TREG)",
    baseUrl: null,
    usdPerCredit: null,
    usdPerCreditBasisAr: "تسعير بالسجل بالدولار من الكتالوج والتشغيل الفعلي",
    docs: ["https://treg.to/integrate.md"],
    maxConcurrentCalls: 1,
    callTimeoutMs: 20_000,
    maxCallsPerChunk: 3,
    rateLimitNote: "per the TREG integration guide",
    balanceApi: null,
  },
  firecrawl: {
    id: "firecrawl",
    labelAr: "Firecrawl",
    baseUrl: "https://api.firecrawl.dev/v2",
    usdPerCredit: FIRECRAWL_USD_PER_CREDIT,
    usdPerCreditBasisAr: "أعلى سعر للرصيد بين الباقات المنشورة (دفع حسب الاستخدام في باقة Hobby)",
    docs: [FIRECRAWL_BILLING_URL, FIRECRAWL_PRICING_URL, "https://docs.firecrawl.dev/rate-limits"],
    maxConcurrentCalls: 2,
    callTimeoutMs: 20_000,
    maxCallsPerChunk: 24,
    rateLimitNote: "requests per minute per plan (Free 10 scrape / 10 search / 10 map, Hobby 100, Standard 500); 429 on excess; concurrency by plan (Free 2)",
    balanceApi: { method: "GET", url: "https://api.firecrawl.dev/v2/team/credit-usage", fields: "data.remainingCredits, data.planCredits, data.billingPeriodStart, data.billingPeriodEnd", costsCredits: false, docs: "https://docs.firecrawl.dev/api-reference/endpoint/credit-usage" },
  },
  contextdev: {
    id: "contextdev",
    labelAr: "Context.dev",
    baseUrl: "https://api.context.dev/v1",
    usdPerCredit: CONTEXTDEV_USD_PER_CREDIT,
    usdPerCreditBasisAr: "أعلى سعر للرصيد بين الباقات المنشورة (باقة Developer)",
    docs: [CONTEXTDEV_CREDITS_URL, CONTEXTDEV_PRICING_URL, "https://docs.context.dev/optimization/rate-limits"],
    maxConcurrentCalls: 2,
    callTimeoutMs: 20_000,
    maxCallsPerChunk: 24,
    rateLimitNote: "concurrency by plan (Free 2, Developer 10, Pro 100); 429 with Retry-After; no default per-minute cap on the core APIs",
    balanceApi: { method: "GET", url: "https://api.context.dev/v1/org/usage", fields: "credits_remaining, period.credits_used, next_refill.at (needs the logs:read key scope)", costsCredits: false, docs: "https://docs.context.dev/api-reference/usage/retrieve" },
  },
};

const round = (n: number) => Math.round(n * 1e9) / 1e9;

function creditCapability(args: {
  id: string; provider: "firecrawl" | "contextdev"; operation: CapabilityDef["operation"]; unit: CapabilityDef["unit"]; unitsPerCall: number;
  credits: number | null; fields: CapabilityDef["fields"]; reliabilityNote: string; labelAr: string; sources: string[]; blockedReason?: CapabilityDef["blockedReason"];
  capabilityTags?: string[];
}): CapabilityDef {
  const usdPerCredit = PROVIDER_FACTS[args.provider].usdPerCredit ?? 0;
  // A price that is not in the documentation (credits === null) stays null: it is never guessed.
  const verified = args.credits !== null;
  const costPerCallUsd = verified ? round((args.credits as number) * usdPerCredit) : null;
  return {
    id: args.id,
    provider: args.provider,
    operation: args.operation,
    unit: args.unit,
    unitsPerCall: args.unitsPerCall,
    creditsPerCall: args.credits,
    costPerCallUsd,
    costPerUnitUsd: costPerCallUsd === null ? null : round(costPerCallUsd / args.unitsPerCall),
    priceStatus: verified ? "VERIFIED" : "UNVERIFIED",
    priceSources: args.sources,
    fields: args.fields,
    reliabilityNote: args.reliabilityNote,
    labelAr: args.labelAr,
    capabilityTags: args.capabilityTags ?? [args.operation],
    ...(args.blockedReason ? { blockedReason: args.blockedReason } : verified ? {} : { blockedReason: "unverified_price" as const }),
  };
}

const tregCompanyCost = recordCostFor("icypeas-companies-search");

export const CAPABILITIES: CapabilityDef[] = [
  // ---- TREG (existing provider, first class and the fallback) --------------------------------------------------------------
  {
    id: "treg.companies.search",
    provider: "treg",
    operation: "discover.companies",
    unit: "record",
    unitsPerCall: 10,
    creditsPerCall: null,
    costPerCallUsd: tregCompanyCost ? Math.round(tregCompanyCost.costUsdPerRecord * 10 * 1e9) / 1e9 : null,
    costPerUnitUsd: tregCompanyCost ? tregCompanyCost.costUsdPerRecord : null,
    priceStatus: tregCompanyCost ? "VERIFIED" : "UNVERIFIED",
    priceSources: ["internal:RECORD_COSTS icypeas-companies-search (measured on completed jobs)"],
    fields: ["business_name", "website", "country", "industry", "description"],
    reliabilityNote: "Directory of companies; a row may have no website, and the directory does not carry work emails.",
    labelAr: "دليل الشركات (TREG)",
    capabilityTags: ["discover.companies", "companies.search"],
    ...(tregCompanyCost ? {} : { blockedReason: "unverified_price" as const }),
  },

  // ---- Firecrawl -------------------------------------------------------------------------------------------------------------
  creditCapability({
    id: "firecrawl.search", provider: "firecrawl", operation: "discover.web_search", unit: "result", unitsPerCall: 10, credits: 2,
    fields: ["business_name", "website", "description", "page_url"], labelAr: "بحث الويب (Firecrawl)",
    reliabilityNote: "Web results for a query: pages, not guaranteed companies; the results are filtered to company homepages by code. 2 credits per 10 results (11 results = 4 credits).",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/api-reference/endpoint/search"],
    capabilityTags: ["discover.web_search", "web.search", "search"],
  }),
  creditCapability({
    id: "firecrawl.map", provider: "firecrawl", operation: "site.map", unit: "call", unitsPerCall: 1, credits: 1,
    fields: ["page_url"], labelAr: "خريطة موقع (Firecrawl)",
    reliabilityNote: "URLs of one website, optionally ordered by relevance to a word such as contact. 1 credit per call.",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/api-reference/endpoint/map"],
    capabilityTags: ["site.map", "map"],
  }),
  creditCapability({
    id: "firecrawl.scrape", provider: "firecrawl", operation: "page.read", unit: "page", unitsPerCall: 1, credits: 1,
    fields: ["work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة (Firecrawl)",
    reliabilityNote: "One public page as text with its links. HTTP 200 does not prove the page loaded: data.metadata.statusCode is checked. The documentation does not say whether robots.txt is honoured, so the platform checks it itself before reading a page.",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/api-reference/endpoint/scrape", "https://docs.firecrawl.dev/features/scrape"],
    capabilityTags: ["page.read", "scrape", "web.read"],
  }),
  creditCapability({
    id: "firecrawl.scrape_json", provider: "firecrawl", operation: "page.read_structured", unit: "page", unitsPerCall: 1, credits: 5,
    fields: ["decision_maker", "work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة مهيكلة (Firecrawl)",
    reliabilityNote: "One public page read into structured fields by the provider's model: 1 credit + 4 for the JSON format. Used only for team pages.",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/features/scrape"],
    capabilityTags: ["page.read_structured", "scrape_json", "extract"],
  }),
  creditCapability({
    id: "firecrawl.extract", provider: "firecrawl", operation: "extract.run", unit: "call", unitsPerCall: 1, credits: null,
    fields: ["work_email", "office_phone", "decision_maker"], labelAr: "استخراج (Firecrawl)",
    reliabilityNote: "UNVERIFIED: the billing page does not state the cost of the Extract endpoint. Not sold.",
    sources: [FIRECRAWL_BILLING_URL],
    capabilityTags: ["extract.run"],
  }),
  creditCapability({
    id: "firecrawl.agent", provider: "firecrawl", operation: "agent.run", unit: "call", unitsPerCall: 1, credits: null,
    fields: ["work_email", "office_phone", "decision_maker"], labelAr: "وكيل (Firecrawl)",
    reliabilityNote: "UNVERIFIED: the Agent costs are 'dynamic' (usage-based) and not a fixed price. Not sold.",
    sources: [FIRECRAWL_BILLING_URL],
    capabilityTags: ["agent.run"],
  }),

  // ---- Context.dev -----------------------------------------------------------------------------------------------------------
  creditCapability({
    id: "contextdev.search", provider: "contextdev", operation: "discover.web_search", unit: "result", unitsPerCall: 10, credits: 1,
    fields: ["business_name", "website", "description", "page_url"], labelAr: "بحث الويب (Context.dev)",
    reliabilityNote: "Ranked web results; 1 credit per 10 results returned (markdown and highlights add more and are not requested). numResults is 10 to 100.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/search/overview"],
    capabilityTags: ["discover.web_search", "web.search", "search"],
  }),
  creditCapability({
    id: "contextdev.map", provider: "contextdev", operation: "site.map", unit: "call", unitsPerCall: 1, credits: 1,
    fields: ["page_url"], labelAr: "خريطة موقع (Context.dev)",
    reliabilityNote: "URLs of one website (a site without a sitemap returns the links of its homepage). 1 credit per call, 2 with the search option, which is not used.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/map/overview"],
    capabilityTags: ["site.map", "map"],
  }),
  creditCapability({
    id: "contextdev.scrape", provider: "contextdev", operation: "page.read", unit: "page", unitsPerCall: 1, credits: 1,
    fields: ["work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة (Context.dev)",
    reliabilityNote: "One public page as Markdown; each requested output reports its own success. 1 credit base (2 with browser actions, which are not used). Robots rules are checked by the platform before reading.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/api-reference/web-scraping/scrape"],
    capabilityTags: ["page.read", "scrape", "web.read"],
  }),
  creditCapability({
    id: "contextdev.scrape_json", provider: "contextdev", operation: "page.read_structured", unit: "page", unitsPerCall: 1, credits: 5,
    fields: ["decision_maker", "work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة مهيكلة (Context.dev)",
    reliabilityNote: "One public page into a JSON schema: 1 credit + 4 for a successful JSON extraction. Used only for team pages.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/api-reference/web-scraping/scrape"],
    capabilityTags: ["page.read_structured", "scrape_json", "extract"],
  }),
  creditCapability({
    id: "contextdev.people_search", provider: "contextdev", operation: "people.enrich", unit: "page", unitsPerCall: 10, credits: 10,
    fields: ["decision_maker", "profile_link"], labelAr: "بحث الأشخاص (Context.dev)",
    reliabilityNote: "People search: 10 credits a page of up to 10 people (fast mode); a page with no match is free. Returns names, roles, companies and public profile links.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/people/search", "https://docs.context.dev/api-reference/people/search"],
    capabilityTags: ["people.search", "people.enrich", "people_search"],
  }),
  creditCapability({
    id: "contextdev.people_enrich", provider: "contextdev", operation: "people.enrich", unit: "match", unitsPerCall: 1, credits: 20,
    fields: ["decision_maker", "profile_link"], labelAr: "إثراء ملف شخص (Context.dev)",
    reliabilityNote: "20 credits per returned match. The documentation does not state where the profile data comes from, and it needs an email or profile URL as a clue: it is a profile database lookup, not a public business page. Blocked by the data policy.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/people/overview"], blockedReason: "data_policy",
    capabilityTags: ["people.enrich"],
  }),
];

export function capabilityById(id: string): CapabilityDef | undefined {
  return CAPABILITIES.find((c) => c.id === id);
}

/** A capability may be sold only with a price read from the documentation and no block (an unverified price, a data policy rule). */
export function isSellable(cap: CapabilityDef | undefined | null): boolean {
  return Boolean(cap) && (cap as CapabilityDef).priceStatus === "VERIFIED" && (cap as CapabilityDef).costPerUnitUsd !== null && !(cap as CapabilityDef).blockedReason;
}

export function sellableCapabilities(): CapabilityDef[] {
  return CAPABILITIES.filter(isSellable);
}

export function capabilitiesOfProvider(provider: DataProviderId): CapabilityDef[] {
  return CAPABILITIES.filter((c) => c.provider === provider);
}

export interface MultiProviderContract {
  endpoint_id: string;
  provider: "firecrawl" | "contextdev" | "treg" | string;
  platform: string;
  platform_family: string;
  category: string | null;
  capability: string;
  capability_tags: string[];
  contract_status: "full" | "partial" | "unknown";
  inputs_schema: Record<string, unknown> | null;
  outputs_schema: Record<string, unknown> | null;
  pagination: {
    style: "cursor" | "page" | "offset" | "none" | null;
    page_size_param: string | null;
    max_page_size: number | null;
    cursor_param: string | null;
    cursor_path: string | null;
    automated_paging_ready: boolean | null;
  };
  cost: {
    unit: string;
    usd: number | null;
    credits: number | null;
    currency: string;
  };
  observed: {
    ok_rate: number;
    samples: number;
  };
  query_syntax: {
    notes: string | null;
    operators: string[];
  } | null;
  needs_session: boolean;
  schema_fingerprint: string;
  drifted: boolean;
  [key: string]: unknown;
}

export const MULTI_PROVIDER_CONTRACTS: MultiProviderContract[] = [
  // Firecrawl
  {
    endpoint_id: "firecrawl.search",
    provider: "firecrawl",
    platform: "web",
    platform_family: "web",
    category: "Web Search",
    capability: "discover.web_search",
    capability_tags: ["discover.web_search", "web.search", "search"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        query: { type: "string", in: "body", required: true, note: "Search query" },
        limit: { type: "integer", in: "body", required: false, minimum: 1, maximum: 100, default: 10 },
        country: { type: "string", in: "body", required: false, note: "Two-letter country code" },
        excludeDomains: { type: "array", in: "body", required: false, note: "Domains to exclude" },
      },
      required: ["query"],
    },
    outputs_schema: {
      list_path: "data.web",
      cursor_path: null,
      item_fields: { url: { type: "string" }, title: { type: "string" }, description: { type: "string" } },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: "limit",
      max_page_size: 100,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "call",
      usd: round(2 * FIRECRAWL_USD_PER_CREDIT),
      credits: 2,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.98,
      samples: 150,
    },
    query_syntax: {
      notes: "Search query without operators",
      operators: [],
    },
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "firecrawl.map",
    provider: "firecrawl",
    platform: "web",
    platform_family: "web",
    category: "Site Crawl & Scrape",
    capability: "site.map",
    capability_tags: ["site.map", "map"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        url: { type: "string", in: "body", required: true, note: "Target website URL" },
        search: { type: "string", in: "body", required: false, note: "Search filter for links" },
        limit: { type: "integer", in: "body", required: false, minimum: 1, maximum: 200, default: 50 },
      },
      required: ["url"],
    },
    outputs_schema: {
      list_path: "links",
      cursor_path: null,
      item_fields: { url: { type: "string" } },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: "limit",
      max_page_size: 200,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "call",
      usd: FIRECRAWL_USD_PER_CREDIT,
      credits: 1,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.98,
      samples: 150,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "firecrawl.scrape",
    provider: "firecrawl",
    platform: "web",
    platform_family: "web",
    category: "Site Crawl & Scrape",
    capability: "page.read",
    capability_tags: ["page.read", "scrape", "web.read"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        url: { type: "string", in: "body", required: true, note: "Page URL to scrape" },
        formats: { type: "array", in: "body", required: false, default: ["markdown", "links"] },
        onlyMainContent: { type: "boolean", in: "body", required: false, default: false },
      },
      required: ["url"],
    },
    outputs_schema: {
      list_path: null,
      cursor_path: null,
      item_fields: {
        markdown: { type: "string" },
        links: { type: "array" },
        finalUrl: { type: "string" },
        statusCode: { type: "integer" },
      },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: null,
      max_page_size: 1,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "page",
      usd: FIRECRAWL_USD_PER_CREDIT,
      credits: 1,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.97,
      samples: 150,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "firecrawl.scrape_json",
    provider: "firecrawl",
    platform: "web",
    platform_family: "web",
    category: "Site Crawl & Scrape",
    capability: "page.read_structured",
    capability_tags: ["page.read_structured", "scrape_json", "extract"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        url: { type: "string", in: "body", required: true, note: "Page URL to scrape" },
        prompt: { type: "string", in: "body", required: true, note: "Extraction prompt" },
        schema: { type: "object", in: "body", required: true, note: "JSON Schema for extraction" },
      },
      required: ["url", "prompt", "schema"],
    },
    outputs_schema: {
      list_path: null,
      cursor_path: null,
      item_fields: { json: { type: "object" }, finalUrl: { type: "string" } },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: null,
      max_page_size: 1,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "page",
      usd: round(5 * FIRECRAWL_USD_PER_CREDIT),
      credits: 5,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.95,
      samples: 100,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },

  // Context.dev
  {
    endpoint_id: "contextdev.search",
    provider: "contextdev",
    platform: "web",
    platform_family: "web",
    category: "Web Search",
    capability: "discover.web_search",
    capability_tags: ["discover.web_search", "web.search", "search"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        query: { type: "string", in: "body", required: true, note: "Search query" },
        numResults: { type: "integer", in: "body", required: false, minimum: 10, maximum: 100, default: 10 },
        country: { type: "string", in: "body", required: false, note: "Two-letter country code" },
        excludeDomains: { type: "array", in: "body", required: false },
      },
      required: ["query"],
    },
    outputs_schema: {
      list_path: "results",
      cursor_path: null,
      item_fields: { url: { type: "string" }, title: { type: "string" }, description: { type: "string" } },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: "numResults",
      max_page_size: 100,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "call",
      usd: CONTEXTDEV_USD_PER_CREDIT,
      credits: 1,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.98,
      samples: 150,
    },
    query_syntax: {
      notes: "Search query without operators",
      operators: [],
    },
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "contextdev.map",
    provider: "contextdev",
    platform: "web",
    platform_family: "web",
    category: "Site Crawl & Scrape",
    capability: "site.map",
    capability_tags: ["site.map", "map"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        domain: { type: "string", in: "query", required: true, note: "Domain to map" },
        maxLinks: { type: "integer", in: "query", required: false, minimum: 1, maximum: 200, default: 50 },
        urlRegex: { type: "string", in: "query", required: false, note: "Regex filter for URLs" },
      },
      required: ["domain"],
    },
    outputs_schema: {
      list_path: "urls",
      cursor_path: null,
      item_fields: { url: { type: "string" } },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: "maxLinks",
      max_page_size: 200,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "call",
      usd: CONTEXTDEV_USD_PER_CREDIT,
      credits: 1,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.98,
      samples: 150,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "contextdev.scrape",
    provider: "contextdev",
    platform: "web",
    platform_family: "web",
    category: "Site Crawl & Scrape",
    capability: "page.read",
    capability_tags: ["page.read", "scrape", "web.read"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        url: { type: "string", in: "body", required: true, note: "URL to scrape" },
        formats: { type: "object", in: "body", required: false, default: { markdown: true } },
      },
      required: ["url"],
    },
    outputs_schema: {
      list_path: null,
      cursor_path: null,
      item_fields: {
        markdown: { type: "string" },
        links: { type: "array" },
        finalUrl: { type: "string" },
      },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: null,
      max_page_size: 1,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "page",
      usd: CONTEXTDEV_USD_PER_CREDIT,
      credits: 1,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.98,
      samples: 150,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "contextdev.scrape_json",
    provider: "contextdev",
    platform: "web",
    platform_family: "web",
    category: "Site Crawl & Scrape",
    capability: "page.read_structured",
    capability_tags: ["page.read_structured", "scrape_json", "extract"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        url: { type: "string", in: "body", required: true, note: "URL to scrape" },
        formats: { type: "object", in: "body", required: false, default: { json: true } },
        jsonParams: { type: "object", in: "body", required: true, note: "schema and instructions" },
      },
      required: ["url", "jsonParams"],
    },
    outputs_schema: {
      list_path: null,
      cursor_path: null,
      item_fields: { json: { type: "object" }, finalUrl: { type: "string" } },
      example_response_trimmed: null,
    },
    pagination: {
      style: null,
      page_size_param: null,
      max_page_size: 1,
      cursor_param: null,
      cursor_path: null,
      automated_paging_ready: false,
    },
    cost: {
      unit: "page",
      usd: round(5 * CONTEXTDEV_USD_PER_CREDIT),
      credits: 5,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.96,
      samples: 100,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
  {
    endpoint_id: "contextdev.people_search",
    provider: "contextdev",
    platform: "web",
    platform_family: "web",
    category: "People Search",
    capability: "people.search",
    capability_tags: ["people.search", "people.enrich", "people_search"],
    contract_status: "full",
    inputs_schema: {
      type: "object",
      properties: {
        query: { type: "string", in: "body", required: true, note: "Search query" },
        mode: { type: "string", in: "body", required: false, default: "fast" },
        country: { type: "string", in: "body", required: false, note: "Country filter" },
        cursor: { type: "string", in: "body", required: false, note: "Pagination cursor" },
      },
      required: ["query"],
    },
    outputs_schema: {
      list_path: "results",
      cursor_path: "next_cursor",
      item_fields: {
        name: { type: "string" },
        role: { type: "string" },
        company: { type: "string" },
        profile_link: { type: "string" },
      },
      example_response_trimmed: null,
    },
    pagination: {
      style: "cursor",
      page_size_param: null,
      max_page_size: 10,
      cursor_param: "cursor",
      cursor_path: "next_cursor",
      automated_paging_ready: true,
    },
    cost: {
      unit: "page",
      usd: round(10 * CONTEXTDEV_USD_PER_CREDIT),
      credits: 10,
      currency: "USD",
    },
    observed: {
      ok_rate: 0.95,
      samples: 100,
    },
    query_syntax: null,
    needs_session: false,
    schema_fingerprint: "3e8b860b6c32dc75b859f3d59c56dfcc0410bacdc623eb3d0d90f36d8720efb0",
    drifted: false,
  },
];

export function getMultiProviderContracts(): MultiProviderContract[] {
  return [...MULTI_PROVIDER_CONTRACTS];
}

export function getMultiProviderContractById(id: string): MultiProviderContract | undefined {
  return MULTI_PROVIDER_CONTRACTS.find((c) => c.endpoint_id === id);
}

export function filterContractsByCapabilityTag<T extends { capability_tags?: string[]; capability?: string | null } = MultiProviderContract>(
  tag: string,
  contracts?: T[]
): T[] {
  const normTag = tag.toLowerCase().trim();
  const list = (contracts ?? MULTI_PROVIDER_CONTRACTS) as unknown as T[];
  return list.filter((c) => {
    if (Array.isArray(c.capability_tags) && c.capability_tags.some((t) => t.toLowerCase() === normTag)) {
      return true;
    }
    if (typeof c.capability === "string" && c.capability.toLowerCase() === normTag) {
      return true;
    }
    return false;
  });
}
