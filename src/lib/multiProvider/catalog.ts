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
    ...(tregCompanyCost ? {} : { blockedReason: "unverified_price" as const }),
  },

  // ---- Firecrawl -------------------------------------------------------------------------------------------------------------
  creditCapability({
    id: "firecrawl.search", provider: "firecrawl", operation: "discover.web_search", unit: "result", unitsPerCall: 10, credits: 2,
    fields: ["business_name", "website", "description", "page_url"], labelAr: "بحث الويب (Firecrawl)",
    reliabilityNote: "Web results for a query: pages, not guaranteed companies; the results are filtered to company homepages by code. 2 credits per 10 results (11 results = 4 credits).",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/api-reference/endpoint/search"],
  }),
  creditCapability({
    id: "firecrawl.map", provider: "firecrawl", operation: "site.map", unit: "call", unitsPerCall: 1, credits: 1,
    fields: ["page_url"], labelAr: "خريطة موقع (Firecrawl)",
    reliabilityNote: "URLs of one website, optionally ordered by relevance to a word such as contact. 1 credit per call.",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/api-reference/endpoint/map"],
  }),
  creditCapability({
    id: "firecrawl.scrape", provider: "firecrawl", operation: "page.read", unit: "page", unitsPerCall: 1, credits: 1,
    fields: ["work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة (Firecrawl)",
    reliabilityNote: "One public page as text with its links. HTTP 200 does not prove the page loaded: data.metadata.statusCode is checked. The documentation does not say whether robots.txt is honoured, so the platform checks it itself before reading a page.",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/api-reference/endpoint/scrape", "https://docs.firecrawl.dev/features/scrape"],
  }),
  creditCapability({
    id: "firecrawl.scrape_json", provider: "firecrawl", operation: "page.read_structured", unit: "page", unitsPerCall: 1, credits: 5,
    fields: ["decision_maker", "work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة مهيكلة (Firecrawl)",
    reliabilityNote: "One public page read into structured fields by the provider's model: 1 credit + 4 for the JSON format. Used only for team pages.",
    sources: [FIRECRAWL_BILLING_URL, "https://docs.firecrawl.dev/features/scrape"],
  }),
  creditCapability({
    id: "firecrawl.extract", provider: "firecrawl", operation: "extract.run", unit: "call", unitsPerCall: 1, credits: null,
    fields: ["work_email", "office_phone", "decision_maker"], labelAr: "استخراج (Firecrawl)",
    reliabilityNote: "UNVERIFIED: the billing page does not state the cost of the Extract endpoint. Not sold.",
    sources: [FIRECRAWL_BILLING_URL],
  }),
  creditCapability({
    id: "firecrawl.agent", provider: "firecrawl", operation: "agent.run", unit: "call", unitsPerCall: 1, credits: null,
    fields: ["work_email", "office_phone", "decision_maker"], labelAr: "وكيل (Firecrawl)",
    reliabilityNote: "UNVERIFIED: the Agent costs are 'dynamic' (usage-based) and not a fixed price. Not sold.",
    sources: [FIRECRAWL_BILLING_URL],
  }),

  // ---- Context.dev -----------------------------------------------------------------------------------------------------------
  creditCapability({
    id: "contextdev.search", provider: "contextdev", operation: "discover.web_search", unit: "result", unitsPerCall: 10, credits: 1,
    fields: ["business_name", "website", "description", "page_url"], labelAr: "بحث الويب (Context.dev)",
    reliabilityNote: "Ranked web results; 1 credit per 10 results returned (markdown and highlights add more and are not requested). numResults is 10 to 100.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/search/overview"],
  }),
  creditCapability({
    id: "contextdev.map", provider: "contextdev", operation: "site.map", unit: "call", unitsPerCall: 1, credits: 1,
    fields: ["page_url"], labelAr: "خريطة موقع (Context.dev)",
    reliabilityNote: "URLs of one website (a site without a sitemap returns the links of its homepage). 1 credit per call, 2 with the search option, which is not used.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/map/overview"],
  }),
  creditCapability({
    id: "contextdev.scrape", provider: "contextdev", operation: "page.read", unit: "page", unitsPerCall: 1, credits: 1,
    fields: ["work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة (Context.dev)",
    reliabilityNote: "One public page as Markdown; each requested output reports its own success. 1 credit base (2 with browser actions, which are not used). Robots rules are checked by the platform before reading.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/api-reference/web-scraping/scrape"],
  }),
  creditCapability({
    id: "contextdev.scrape_json", provider: "contextdev", operation: "page.read_structured", unit: "page", unitsPerCall: 1, credits: 5,
    fields: ["decision_maker", "work_email", "office_phone", "profile_link", "page_url"], labelAr: "قراءة صفحة مهيكلة (Context.dev)",
    reliabilityNote: "One public page into a JSON schema: 1 credit + 4 for a successful JSON extraction. Used only for team pages.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/api-reference/web-scraping/scrape"],
  }),
  creditCapability({
    id: "contextdev.people_enrich", provider: "contextdev", operation: "people.enrich", unit: "match", unitsPerCall: 1, credits: 20,
    fields: ["decision_maker", "profile_link"], labelAr: "إثراء ملف شخص (Context.dev)",
    reliabilityNote: "20 credits per returned match. The documentation does not state where the profile data comes from, and it needs an email or profile URL as a clue: it is a profile database lookup, not a public business page. Blocked by the data policy.",
    sources: [CONTEXTDEV_CREDITS_URL, "https://docs.context.dev/people/overview"], blockedReason: "data_policy",
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
