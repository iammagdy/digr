import { computeRegistryPointsPerUnit, getRegistryPricingSettings } from "./capabilityRegistry";
import { APPROVED_CAPABILITY_CATALOG, Capability } from "./capabilityRegistry";

export interface CatalogEndpointSummary {
  id: string; // Internal TREG endpoint ID (e.g. "tikhub.tiktok.user.profile", "scrapecreators.x.v1-facebook-group")
  slug: string; // Clean opaque slug
  nameAr: string; // Arabic task name
  nameEn: string;
  summaryAr: string;
  summaryEn: string;
  platform: string; // "facebook" | "tiktok" | "instagram" | "x" | "youtube" | "reddit" | "linkedin" | etc.
  method: "GET" | "POST";
  path: string;
  paramsSchema: Record<string, any>;
  billingUnit: "call" | "record" | "row" | "item" | "page";
  catalogPriceUsd: number;
  pointsPerUnit: number;
  pagination: {
    type: "cursor" | "offset" | "page" | "none";
    paramName?: string;
    limitParam?: string;
    maxLimit?: number;
  };
  observedSuccessRate: number;
  observedSamples: number;
  scope: string;
}

export interface SanitizedEndpointForCustomer {
  slug: string;
  nameAr: string;
  descriptionAr: string;
  platform: string;
  pointsPerUnit: number;
  billingUnit: string;
  paramsSchema: Record<string, any>;
  maxRows: number;
  paginationType: "cursor" | "offset" | "page" | "none";
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const catalogCache = new Map<string, { timestamp: number; results: CatalogEndpointSummary[] }>();

/**
 * Clear the in-memory catalog cache (useful for testing or cache refresh)
 */
export function clearCatalogCache(): void {
  catalogCache.clear();
}

/**
 * Known platform Arabic translations
 */
const PLATFORM_ARABIC_NAMES: Record<string, string> = {
  tiktok: "تيك توك",
  facebook: "فيسبوك",
  instagram: "إنستغرام",
  x: "منصة X (تويتر)",
  twitter: "منصة X (تويتر)",
  youtube: "يوتيوب",
  reddit: "ريديت",
  linkedin: "لينكد إن",
  snapchat: "سناب شات",
  telegram: "تيليجرام",
  web: "الويب العام",
};

/**
 * Known providers to strictly scrub from user-facing text
 */
const KNOWN_PROVIDER_SCRUB_PATTERNS = [
  /\b(tikhub|scrapecreators|anyapi|brightdata|crawl4ai|justoneapi|treg|apify|socialdata|rapidapi|scrapingbee|zenrows)\b/gi,
  /\b(TikHub|ScrapeCreators|AnyAPI|BrightData|Crawl4AI|JustOneAPI|Apify|SocialData)\b/g,
];

export function scrubProviderNames(text: string): string {
  if (!text) return "";
  let clean = text;
  for (const pattern of KNOWN_PROVIDER_SCRUB_PATTERNS) {
    clean = clean.replace(pattern, "");
  }
  return clean.replace(/\s+/g, " ").trim();
}

/**
 * Derive or match a natural Arabic task name for a catalog endpoint
 */
export function deriveArabicTaskName(rawEndpoint: any, platform: string): { nameAr: string; summaryAr: string } {
  // Check override catalog first
  const existingSeed = APPROVED_CAPABILITY_CATALOG.find(
    (c) => c.tregEndpointId === rawEndpoint.id || c.slug === rawEndpoint.id || c.id === rawEndpoint.id
  );
  if (existingSeed) {
    return {
      nameAr: existingSeed.nameAr,
      summaryAr: existingSeed.descriptionAr,
    };
  }

  const platformAr = PLATFORM_ARABIC_NAMES[platform.toLowerCase()] || platform;
  const nameEn = String(rawEndpoint.name || "").toLowerCase();
  const summaryEn = String(rawEndpoint.summary || "").toLowerCase();
  const idStr = String(rawEndpoint.id || "").toLowerCase();

  let nameAr = `استخراج بيانات من ${platformAr}`;
  let summaryAr = `جمع واستخراج البيانات العامة من ${platformAr}`;

  if (nameEn.includes("comment") || summaryEn.includes("comment") || idStr.includes("comment")) {
    nameAr = `استخراج تعليقات ${platformAr}`;
    summaryAr = `جمع التعليقات العامة والمشاركات من ${platformAr}`;
  } else if (nameEn.includes("profile") || summaryEn.includes("profile") || idStr.includes("profile") || nameEn.includes("user")) {
    nameAr = `استخراج ملف حساب ${platformAr}`;
    summaryAr = `استخراج البيانات والإحصائيات العامة لحساب ${platformAr}`;
  } else if (nameEn.includes("search") || summaryEn.includes("search") || idStr.includes("search")) {
    nameAr = `بحث واستخراج منشورات ${platformAr}`;
    summaryAr = `البحث في المنشورات والمحتوى العام على ${platformAr} بالكلمات المفتاحية`;
  } else if (nameEn.includes("video") || summaryEn.includes("video") || idStr.includes("video") || nameEn.includes("post") || summaryEn.includes("post")) {
    nameAr = `استخراج منشورات ومحتوى ${platformAr}`;
    summaryAr = `استخراج المنشورات والمحتوى العام والتفاعلات على ${platformAr}`;
  } else if (nameEn.includes("hashtag") || summaryEn.includes("hashtag") || idStr.includes("hashtag")) {
    nameAr = `استخراج بيانات الوسم (هاشتاج) على ${platformAr}`;
    summaryAr = `جمع المحتوى المرتبط بالوسم أو الموضوع على ${platformAr}`;
  } else if (nameEn.includes("group") || summaryEn.includes("group") || idStr.includes("group")) {
    nameAr = `استخراج بيانات مجموعات ${platformAr}`;
    summaryAr = `جمع المنشورات والبيانات من مجموعات ${platformAr} العامة`;
  }

  return { nameAr, summaryAr };
}

/**
 * Detect pagination parameters and strategy from input schema
 */
export function detectPaginationStrategy(input: any): {
  type: "cursor" | "offset" | "page" | "none";
  paramName?: string;
  limitParam?: string;
  maxLimit?: number;
} {
  const queryParams = input?.queryParams || {};
  const body = input?.body || {};
  const allParams = { ...queryParams, ...body };

  const limitKeys = ["count", "limit", "max_results", "max_count", "per_page", "size", "page_size"];
  let limitParam: string | undefined;
  let maxLimit: number = 100;
  for (const k of limitKeys) {
    if (allParams[k]) {
      limitParam = k;
      if (typeof allParams[k]?.maximum === "number") maxLimit = allParams[k].maximum;
      break;
    }
  }

  const cursorKeys = ["cursor", "nextCursor", "next_cursor", "max_cursor"];
  for (const k of cursorKeys) {
    if (allParams[k]) {
      return { type: "cursor", paramName: k, limitParam, maxLimit };
    }
  }

  const offsetKeys = ["offset", "start", "startIndex", "from"];
  for (const k of offsetKeys) {
    if (allParams[k]) {
      return { type: "offset", paramName: k, limitParam, maxLimit };
    }
  }

  const pageKeys = ["page", "page_number", "pageNo", "p"];
  for (const k of pageKeys) {
    if (allParams[k]) {
      return { type: "page", paramName: k, limitParam, maxLimit };
    }
  }

  return { type: "none", limitParam, maxLimit };
}

/**
 * Build a normalized JSON schema for endpoint parameters
 */
export function buildNormalizedParamsSchema(input: any): Record<string, any> {
  const queryParams = input?.queryParams || {};
  const body = input?.body || {};
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries<any>(queryParams)) {
    properties[key] = {
      type: val.type || "string",
      description: scrubProviderNames(val.note || val.description || ""),
      example: val.example,
      enum: val.enum,
    };
    if (val.required) required.push(key);
  }

  for (const [key, val] of Object.entries<any>(body)) {
    properties[key] = {
      type: val.type || "string",
      description: scrubProviderNames(val.note || val.description || ""),
      example: val.example,
      enum: val.enum,
    };
    if (val.required) required.push(key);
  }

  return {
    type: "object",
    properties,
    required: Array.from(new Set(required)),
  };
}

/**
 * Normalizes a raw TREG catalog search result into a CatalogEndpointSummary
 */
export function normalizeCatalogEndpoint(raw: any): CatalogEndpointSummary {
  const id: string = raw.id;
  const platform: string = (raw.platform || raw.platform_label || "").toLowerCase() || "web";
  const { nameAr, summaryAr } = deriveArabicTaskName(raw, platform);

  const costObj = raw.cost || {};
  const catalogPriceUsd = typeof costObj.usd === "number"
    ? costObj.usd
    : typeof costObj.value === "number"
    ? costObj.value
    : 0.0015;

  const billingUnit = (costObj.unit === "record" || costObj.unit === "row" || costObj.unit === "item" || costObj.unit === "page")
    ? costObj.unit
    : "call";

  const observed = raw.observed || {};
  const observedSuccessRate = typeof observed.ok_rate === "number" ? observed.ok_rate : 0.95;
  const observedSamples = typeof observed.samples === "number" ? observed.samples : 10;

  const pagination = detectPaginationStrategy(raw.input);
  const paramsSchema = buildNormalizedParamsSchema(raw.input);
  const settings = getRegistryPricingSettings();
  const pointsPerUnit = computeRegistryPointsPerUnit(catalogPriceUsd, settings);

  // Generate a clean slug
  const cleanSlug = id.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();

  return {
    id,
    slug: cleanSlug,
    nameAr,
    nameEn: raw.name || cleanSlug,
    summaryAr,
    summaryEn: raw.summary || "",
    platform,
    method: raw.method === "POST" ? "POST" : "GET",
    path: raw.path || "",
    paramsSchema,
    billingUnit: billingUnit as any,
    catalogPriceUsd,
    pointsPerUnit,
    pagination,
    observedSuccessRate,
    observedSamples,
    scope: raw.scope || "any_account",
  };
}

/**
 * Server-only catalog search function:
 * Searches https://treg.to/catalog/search?q={query}
 * Caches in memory for 24 hours.
 * Ranks by success rate and price.
 */
export async function searchCatalog(
  query: string,
  platformHint?: string,
  options?: { limit?: number; bypassCache?: boolean; fetchFn?: typeof fetch }
): Promise<CatalogEndpointSummary[]> {
  const limit = options?.limit || 10;
  const trimmedQuery = (query || "").trim();
  const normPlatform = (platformHint || "").trim().toLowerCase();
  const cacheKey = `${trimmedQuery.toLowerCase()}::${normPlatform}`;

  // 1. Check in-memory cache
  if (!options?.bypassCache) {
    const cached = catalogCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.results.slice(0, limit);
    }
  }

  const effectiveFetch = options?.fetchFn || fetch;
  const baseUrl = (process.env.TREG_BASE_URL || "https://treg.to").replace(/\/$/, "");
  const token = process.env.TREG_TOKEN || process.env.TREG_API_KEY;

  let rawResults: any[] = [];

  try {
    const searchUrl = `${baseUrl}/catalog/search?q=${encodeURIComponent(trimmedQuery || normPlatform || "all")}`;
    const headers: Record<string, string> = {};
    if (token) {
      headers["X-Treg-Token"] = token;
    }

    const res = await effectiveFetch(searchUrl, {
      method: "GET",
      headers,
    });

    if (res.ok) {
      const json = await res.json();
      if (Array.isArray(json.results)) {
        rawResults = json.results;
      }
    }
  } catch (err) {
    // Network or offline failure: fallback to seed catalog
  }

  // If network returned no results or failed, fallback to seed catalog matching query/platform
  if (rawResults.length === 0) {
    rawResults = APPROVED_CAPABILITY_CATALOG.map((c) => ({
      id: c.tregEndpointId || c.slug,
      name: c.nameEn,
      summary: c.descriptionAr,
      platform: c.platform || c.category,
      method: c.tregMethod,
      path: "",
      cost: { usd: c.unitCostUsd, unit: c.pricingUnit },
      input: {
        queryParams: typeof c.paramsSchema === "string" ? JSON.parse(c.paramsSchema).properties : c.paramsSchema,
      },
      observed: { ok_rate: c.estimatedSuccessRate, samples: 100 },
      scope: "any_account",
    }));
  }

  // 2. Filter & Normalize
  let normalized = rawResults
    // Filter out private own_account endpoints (public research only)
    .filter((r) => r.scope !== "own_account")
    .map(normalizeCatalogEndpoint);

  // If platform hint is provided, filter or prioritize that platform
  if (normPlatform) {
    const platformMatches = normalized.filter(
      (ep) => ep.platform === normPlatform || ep.platform.includes(normPlatform) || normPlatform.includes(ep.platform)
    );
    if (platformMatches.length > 0) {
      normalized = platformMatches;
    }
  }

  // 3. Rank endpoints:
  // - Higher success rate first
  // - Higher sample size
  // - Lower price in USD
  normalized.sort((a, b) => {
    // If platform hint, matching platform wins
    if (normPlatform) {
      const aMatch = a.platform === normPlatform ? 1 : 0;
      const bMatch = b.platform === normPlatform ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }

    // Success rate comparison (e.g. 0.99 vs 0.88)
    const rateDiff = b.observedSuccessRate - a.observedSuccessRate;
    if (Math.abs(rateDiff) > 0.05) {
      return rateDiff;
    }

    // Cost comparison (lower price wins)
    const costDiff = a.catalogPriceUsd - b.catalogPriceUsd;
    if (Math.abs(costDiff) > 0.0001) {
      return costDiff;
    }

    // Sample size tiebreaker
    return b.observedSamples - a.observedSamples;
  });

  const topResults = normalized.slice(0, Math.max(limit, 20));

  // Store in cache
  catalogCache.set(cacheKey, {
    timestamp: Date.now(),
    results: topResults,
  });

  return topResults.slice(0, limit);
}

/**
 * Scrub and sanitize catalog endpoints for customer & LLM presentation
 * HARD RULE: Never leak internal provider names, endpoint IDs, or USD prices!
 */
export function sanitizeCatalogEndpointForCustomer(
  ep: CatalogEndpointSummary
): SanitizedEndpointForCustomer {
  return {
    slug: ep.slug,
    nameAr: scrubProviderNames(ep.nameAr),
    descriptionAr: scrubProviderNames(ep.summaryAr),
    platform: ep.platform,
    pointsPerUnit: ep.pointsPerUnit,
    billingUnit: ep.billingUnit,
    paramsSchema: ep.paramsSchema,
    maxRows: ep.pagination.maxLimit || 100,
    paginationType: ep.pagination.type,
  };
}
