import { TablesDB } from "./dbCompat";

export type CapabilityStatus = "verified" | "pending_verification" | "planned";
export type CapabilityUnit = "page" | "query" | "profile" | "1000 items";
export type CapabilityPlatform =
  | "tiktok"
  | "facebook"
  | "x"
  | "youtube"
  | "instagram"
  | "reddit"
  | "linkedin"
  | "snapchat"
  | "telegram"
  | "web"
  | (string & {});

export interface RegistryPricingSettings {
  usdToEgp: number;
  markup: number;
  pointValueEgp: number;
  minimumOrderPoints: number;
}

export function getRegistryPricingSettings(
  overrides?: Partial<RegistryPricingSettings>
): RegistryPricingSettings {
  const envUsdToEgp = Number(process.env.USD_TO_EGP);
  const envMarkup = Number(process.env.REGISTRY_MARKUP);
  const envPointValueEgp = Number(process.env.POINT_VALUE_EGP);
  const envMinOrder = Number(process.env.MINIMUM_ORDER_POINTS);

  return {
    usdToEgp:
      overrides?.usdToEgp ??
      (Number.isFinite(envUsdToEgp) && envUsdToEgp > 0 ? envUsdToEgp : 55),
    markup:
      overrides?.markup ??
      (Number.isFinite(envMarkup) && envMarkup > 0 ? envMarkup : 10),
    pointValueEgp:
      overrides?.pointValueEgp ??
      (Number.isFinite(envPointValueEgp) && envPointValueEgp > 0 ? envPointValueEgp : 0.10),
    minimumOrderPoints:
      overrides?.minimumOrderPoints ??
      (Number.isFinite(envMinOrder) && envMinOrder > 0 ? envMinOrder : 50),
  };
}

/**
 * Pricing formula (data display only; does not change ledger/quote settlement logic):
 * points = ceil(cost_usd * usdToEgp * markup / pointValueEgp)
 */
export function computeRegistryPointsPerUnit(
  costUsd: number,
  settings: RegistryPricingSettings = getRegistryPricingSettings()
): number {
  return Math.ceil((costUsd * settings.usdToEgp * settings.markup) / settings.pointValueEgp);
}

export const VERIFICATION_NOTE = "to verify against the real charge of the first call";
export const UNVERIFIED_PLATFORM_MESSAGE_AR =
  "هتحقق من الطلب وأرجعلك";

/** Services that have been disabled after live customer testing exposed an unreliable execution path. */
export const UNAVAILABLE_CAPABILITY_SLUGS = new Set(["icypeas-people-search"]);

export interface Capability {
  id?: string;
  slug: string;
  platform?: CapabilityPlatform;
  category: CapabilityPlatform;
  status?: CapabilityStatus;
  unit?: CapabilityUnit;
  estimatedCostUsdPerUnit?: number;
  pointsPerUnit?: number;
  maxItemsPerCall?: number;
  estimatedSuccessRate?: number;
  verificationNote?: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  paramsSchema: string; // JSON string
  tregEndpointId: string;
  tregMethod: "GET" | "POST";
  pricingUnit: "call" | "item" | "page";
  unitCostUsd: number;
  /** Customer sale rate per delivered comment; provider cost remains unitCostUsd. */
  customerPriceUsdPerItem?: number;
  maxRows: number;
  paginationType: "cursor" | "offset" | "none";
  enabled: boolean;
}

/**
 * Diger's customer-facing comment rates, kept separate from live provider cost.
 * These preserve the existing customer rates (11 FB / 9 YouTube points per
 * comment at the default exchange, markup, and point value settings).
 */
export function getCustomerPriceUsdPerCatalogItem(
  endpoint: { id?: string; slug?: string; platform?: string; nameEn?: string; nameAr?: string }
): number | undefined {
  const identity = `${endpoint.id || ""} ${endpoint.slug || ""} ${endpoint.nameEn || ""} ${endpoint.nameAr || ""}`.toLowerCase();
  if (endpoint.platform?.toLowerCase() === "facebook" && /comment/.test(identity)) return 0.0019;
  if (endpoint.platform?.toLowerCase() === "youtube" && /comment/.test(identity)) return 0.0015;
  return undefined;
}

export interface SanitizedCapabilityForLlm {
  id: string;
  slug: string;
  platform: string;
  category: string;
  status: CapabilityStatus;
  unit: CapabilityUnit;
  pointsPerUnit: number;
  maxItemsPerCall: number;
  estimatedSuccessRate: number;
  nameAr: string;
  descriptionAr: string;
  paramsSchema: any;
  maxRows: number;
  enabled: boolean;
}

export const RAW_SEED_CAPABILITIES: Array<Omit<Capability, "pointsPerUnit">> = [
  {
    id: "tiktok-profile",
    slug: "tiktok-profile",
    platform: "tiktok",
    category: "tiktok",
    status: "verified",
    unit: "profile",
    estimatedCostUsdPerUnit: 0.001,
    maxItemsPerCall: 1,
    estimatedSuccessRate: 0.95,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج ملف تيك توك الشخصي",
    nameEn: "TikTok User Profile",
    descriptionAr: "استخراج الإحصائيات الشاملة والنبذة التعريفية وحالة التوثيق لحساب تيك توك عام",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string", description: "اسم المستخدم بدون @" } },
      required: ["username"],
    }),
    tregEndpointId: "tikhub.tiktok.user.profile",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.001,
    maxRows: 1,
    paginationType: "none",
    enabled: true,
  },
  {
    id: "facebook-post-comments",
    slug: "facebook-post-comments",
    platform: "facebook",
    category: "facebook",
    status: "pending_verification",
    unit: "page",
    estimatedCostUsdPerUnit: 0.0019,
    maxItemsPerCall: 10,
    estimatedSuccessRate: 0.90,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج تعليقات منشورات فيسبوك العامة",
    nameEn: "Facebook Post Comments",
    descriptionAr: "جمع التعليقات العامة على منشورات فيسبوك (10 تعليقات لكل صفحة)",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        postUrl: { type: "string" },
        maxPages: { type: "integer", maximum: 50 },
      },
      required: ["postUrl"],
    }),
    tregEndpointId: "internal-facebook-post-comments",
    tregMethod: "GET",
    pricingUnit: "page",
    unitCostUsd: 0.0019,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "facebook-post-search",
    slug: "facebook-post-search",
    platform: "facebook",
    category: "facebook",
    status: "pending_verification",
    unit: "query",
    estimatedCostUsdPerUnit: 0.03,
    maxItemsPerCall: 20,
    estimatedSuccessRate: 0.88,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "بحث المنشورات العامة على فيسبوك",
    nameEn: "Facebook Public Post Search",
    descriptionAr: "البحث في المنشورات العامة على فيسبوك بالكلمات المفتاحية والنطاق الزمني",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "string" },
        dateFrom: { type: "string" },
        dateTo: { type: "string" },
      },
      required: ["query"],
    }),
    tregEndpointId: "internal-facebook-post-search",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.03,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "x-keyword-search",
    slug: "x-keyword-search",
    platform: "x",
    category: "x",
    status: "pending_verification",
    unit: "query",
    estimatedCostUsdPerUnit: 0.00075,
    maxItemsPerCall: 20,
    estimatedSuccessRate: 0.92,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "بحث منشورات منصة X (تويتر)",
    nameEn: "X / Twitter Keyword Search",
    descriptionAr: "البحث في المنشورات العامة على منصة X بالكلمات الدلالية (~20 منشور لكل طلب)",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", maximum: 500 },
      },
      required: ["query"],
    }),
    tregEndpointId: "internal-x-search",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.00075,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "youtube-comments",
    slug: "youtube-comments",
    platform: "youtube",
    category: "youtube",
    status: "pending_verification",
    unit: "page",
    estimatedCostUsdPerUnit: 0.0015,
    maxItemsPerCall: 20,
    estimatedSuccessRate: 0.92,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج تعليقات مقاطع يوتيوب",
    nameEn: "YouTube Video Comments",
    descriptionAr: "جمع التعليقات العامة على مقاطع الفيديو في يوتيوب",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        videoId: { type: "string" },
        count: { type: "integer", maximum: 500 },
      },
      required: ["videoId"],
    }),
    tregEndpointId: "internal-youtube-comments",
    tregMethod: "GET",
    pricingUnit: "page",
    unitCostUsd: 0.0015,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "youtube-search",
    slug: "youtube-search",
    platform: "youtube",
    category: "youtube",
    status: "pending_verification",
    unit: "query",
    estimatedCostUsdPerUnit: 0.0015,
    maxItemsPerCall: 20,
    estimatedSuccessRate: 0.92,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "بحث مقاطع يوتيوب العامة",
    nameEn: "YouTube Video Search",
    descriptionAr: "البحث في مقاطع يوتيوب العامة بالكلمات المفتاحية",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "string" },
        count: { type: "integer", maximum: 500 },
      },
      required: ["query"],
    }),
    tregEndpointId: "internal-youtube-search",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.0015,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "instagram-profile",
    slug: "instagram-profile",
    platform: "instagram",
    category: "instagram",
    status: "pending_verification",
    unit: "profile",
    estimatedCostUsdPerUnit: 0.0015,
    maxItemsPerCall: 1,
    estimatedSuccessRate: 0.90,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج ملف حساب إنستغرام العام",
    nameEn: "Instagram Public Profile",
    descriptionAr: "استخراج بيانات وإحصائيات حساب إنستغرام عام",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { username: { type: "string" } },
      required: ["username"],
    }),
    tregEndpointId: "internal-instagram-profile",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.0015,
    maxRows: 1,
    paginationType: "none",
    enabled: false,
  },
  {
    id: "instagram-comments",
    slug: "instagram-comments",
    platform: "instagram",
    category: "instagram",
    status: "pending_verification",
    unit: "page",
    estimatedCostUsdPerUnit: 0.002,
    maxItemsPerCall: 20,
    estimatedSuccessRate: 0.88,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج تعليقات منشورات إنستغرام",
    nameEn: "Instagram Post Comments",
    descriptionAr: "جمع التعليقات العامة على منشورات إنستغرام",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { postUrl: { type: "string" } },
      required: ["postUrl"],
    }),
    tregEndpointId: "internal-instagram-comments",
    tregMethod: "GET",
    pricingUnit: "page",
    unitCostUsd: 0.002,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "reddit-post-comments",
    slug: "reddit-post-comments",
    platform: "reddit",
    category: "reddit",
    status: "pending_verification",
    unit: "page",
    estimatedCostUsdPerUnit: 0.0015,
    maxItemsPerCall: 25,
    estimatedSuccessRate: 0.90,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج تعليقات منشورات ريديت (Reddit)",
    nameEn: "Reddit Post Comments",
    descriptionAr: "جمع التعليقات العامة على منشورات ريديت",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { postUrl: { type: "string" } },
      required: ["postUrl"],
    }),
    tregEndpointId: "internal-reddit-comments",
    tregMethod: "GET",
    pricingUnit: "page",
    unitCostUsd: 0.0015,
    maxRows: 500,
    paginationType: "cursor",
    enabled: false,
  },
  {
    id: "linkedin-profile",
    slug: "linkedin-profile",
    platform: "linkedin",
    category: "linkedin",
    status: "pending_verification",
    unit: "profile",
    estimatedCostUsdPerUnit: 0.002,
    maxItemsPerCall: 1,
    estimatedSuccessRate: 0.90,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "استخراج ملف حساب لينكد إن العام",
    nameEn: "LinkedIn Public Profile",
    descriptionAr: "استخراج بيانات الحساب الشخصي أو الشركة على لينكد إن",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: { profileUrl: { type: "string" } },
      required: ["profileUrl"],
    }),
    tregEndpointId: "internal-linkedin-profile",
    tregMethod: "GET",
    pricingUnit: "call",
    unitCostUsd: 0.002,
    maxRows: 1,
    paginationType: "none",
    enabled: false,
  },
  {
    id: "icypeas-companies-search",
    slug: "icypeas-companies-search",
    platform: "companies",
    category: "companies",
    status: "verified",
    unit: "1000 items",
    estimatedCostUsdPerUnit: 0.00038,
    maxItemsPerCall: 100,
    estimatedSuccessRate: 0.99,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "بحث واستخراج بيانات الشركات",
    nameEn: "Company & Business Research",
    descriptionAr: "البحث في بيانات وسجلات الشركات واستخراج معلومات التواصل والأنشطة",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "object", description: "معايير البحث والاستعلام (keyword, location, industry)" },
        pagination: { type: "object", description: "خيارات ترقيم الصفحات والحجم" },
      },
      required: ["query"],
    }),
    tregEndpointId: "icypeas.companies.search",
    tregMethod: "POST",
    pricingUnit: "item",
    unitCostUsd: 0.00038,
    maxRows: 500,
    paginationType: "none",
    enabled: true,
  },
  {
    id: "icypeas-people-search",
    slug: "icypeas-people-search",
    platform: "people",
    category: "people",
    status: "pending_verification",
    unit: "1000 items",
    estimatedCostUsdPerUnit: 0.00038,
    maxItemsPerCall: 100,
    estimatedSuccessRate: 0.99,
    verificationNote: VERIFICATION_NOTE,
    nameAr: "بحث صناع القرار والمهنيين",
    nameEn: "Decision Makers & People Search",
    descriptionAr: "البحث في بيانات صناع القرار والمهنيين والمسؤولين التنفيذيين بالمسمى والشركة والدولة",
    paramsSchema: JSON.stringify({
      type: "object",
      properties: {
        query: { type: "object", description: "معايير البحث والاستعلام (jobTitle, location, keyword)" },
        pagination: { type: "object", description: "خيارات ترقيم الصفحات والحجم" },
      },
      required: ["query"],
    }),
    tregEndpointId: "icypeas.people.search",
    tregMethod: "POST",
    pricingUnit: "item",
    unitCostUsd: 0.00038,
    maxRows: 500,
    paginationType: "none",
    enabled: false,
  },
];

export function buildApprovedCatalog(
  settings: RegistryPricingSettings = getRegistryPricingSettings()
): Capability[] {
  return RAW_SEED_CAPABILITIES.map((entry) => ({
    ...entry,
    pointsPerUnit: computeRegistryPointsPerUnit(
      entry.estimatedCostUsdPerUnit ?? entry.unitCostUsd,
      settings
    ),
  }));
}

export const APPROVED_CAPABILITY_CATALOG: Capability[] = buildApprovedCatalog();

/**
 * Return the full approved capability catalog (verified, pending_verification, planned),
 * merging any status overrides from the database table when available.
 */
let memoryCachedCatalog: { data: Capability[]; expiresAt: number } | null = null;
const CATALOG_MEMORY_CACHE_TTL_MS = 60_000;

export async function getCatalogCapabilities(
  tables?: TablesDB | any,
  settings: RegistryPricingSettings = getRegistryPricingSettings()
): Promise<Capability[]> {
  const baseCatalog = buildApprovedCatalog(settings);
  if (!tables) return baseCatalog;

  if (memoryCachedCatalog && Date.now() < memoryCachedCatalog.expiresAt) {
    return memoryCachedCatalog.data;
  }

  try {
    let dbRows: Capability[] = [];
    if (typeof tables.from === "function") {
      const { data } = await tables.from("capability_registry").select("*");
      dbRows = (data || []).map((r: any) => {
        const seed = baseCatalog.find((s) => s.slug === r.slug);
        const resolvedCost = Number(
          r.unit_cost_usd ??
          r.unitCostUsd ??
          seed?.unitCostUsd ??
          (r.slug === "tiktok-profile" ? 0.001 : 0)
        );
        return {
          ...r,
          slug: r.slug,
          unitCostUsd: resolvedCost,
          nameAr: r.name_ar,
          descriptionAr: r.description_ar,
          tregEndpointId: r.endpoint_id,
          pricingUnit: r.pricing_unit,
          maxRows: r.max_rows,
          paginationType: r.pagination_type,
          enabled: Boolean(r.enabled),
        };
      });
    } else if (typeof tables.listRows === "function") {
      const res = await tables.listRows({
        databaseId: "digr",
        tableId: "capability_registry",
      });
      dbRows = (res?.rows || []) as unknown as Capability[];
    }
    if (dbRows.length === 0) return baseCatalog;

    const merged = new Map<string, Capability>();
    for (const item of baseCatalog) {
      merged.set(item.slug, item);
    }
    for (const row of dbRows) {
      const existing = merged.get(row.slug);
      const costUsd = Number(
        row.unitCostUsd ??
        row.estimatedCostUsdPerUnit ??
        existing?.estimatedCostUsdPerUnit ??
        existing?.unitCostUsd ??
        (row.slug === "tiktok-profile" ? 0.001 : 0)
      );
      const isValidCost = Number.isFinite(costUsd) && costUsd > 0;
      const status: CapabilityStatus =
        row.status || (row.enabled && isValidCost ? "verified" : existing?.status || "pending_verification");
      const forceUnavailable = UNAVAILABLE_CAPABILITY_SLUGS.has(row.slug);
      merged.set(row.slug, {
        ...(existing || {}),
        ...row,
        id: row.id || row.slug,
        platform: (row.platform || row.category || existing?.platform || "tiktok") as CapabilityPlatform,
        status: forceUnavailable ? "pending_verification" : status,
        unit: row.unit || existing?.unit || "profile",
        estimatedCostUsdPerUnit: isValidCost ? costUsd : 0,
        pointsPerUnit: isValidCost ? computeRegistryPointsPerUnit(costUsd, settings) : 0,
        maxItemsPerCall: row.maxItemsPerCall ?? existing?.maxItemsPerCall ?? row.maxRows ?? 1,
        estimatedSuccessRate: row.estimatedSuccessRate ?? existing?.estimatedSuccessRate ?? 0.9,
        verificationNote: row.verificationNote || existing?.verificationNote || VERIFICATION_NOTE,
        enabled: !forceUnavailable && isValidCost && (status === "verified" || Boolean(row.enabled)),
      });
    }
    const result = Array.from(merged.values());
    memoryCachedCatalog = { data: result, expiresAt: Date.now() + CATALOG_MEMORY_CACHE_TTL_MS };
    return result;
  } catch {
    return baseCatalog;
  }
}

/**
 * Fetch all enabled (verified) capabilities from the server-only capability_registry table,
 * falling back to verified entries in APPROVED_CAPABILITY_CATALOG if the table is empty.
 */
export async function getEnabledCapabilities(tables?: TablesDB | any): Promise<Capability[]> {
  if (memoryCachedCatalog && Date.now() < memoryCachedCatalog.expiresAt) {
    return memoryCachedCatalog.data.filter((c) => c.enabled);
  }

  if (tables && typeof tables.from === "function") {
    try {
      const { data } = await tables.from("capability_registry").select("*").eq("enabled", true);
      if (data && data.length > 0) {
        const settings = getRegistryPricingSettings();
        const validCapabilities: Capability[] = [];
        for (const c of data) {
          if (UNAVAILABLE_CAPABILITY_SLUGS.has(c.slug)) continue;
          const seed = APPROVED_CAPABILITY_CATALOG.find((s) => s.slug === c.slug);
          const costUsd = Number(
            c.unit_cost_usd ??
            c.unitCostUsd ??
            seed?.unitCostUsd ??
            seed?.estimatedCostUsdPerUnit ??
            (c.slug === "tiktok-profile" ? 0.001 : 0)
          );
          if (!Number.isFinite(costUsd) || costUsd <= 0) {
            continue; // Fail closed: missing or unverified costs cannot be enabled
          }
          validCapabilities.push({
            ...(seed || {}),
            slug: c.slug,
            nameAr: c.name_ar || seed?.nameAr || "",
            nameEn: c.name_en || seed?.nameEn || "",
            descriptionAr: c.description_ar || seed?.descriptionAr || "",
            tregEndpointId: c.endpoint_id || seed?.tregEndpointId || c.slug,
            id: c.slug,
            category: (c.category || seed?.category || "tiktok") as CapabilityPlatform,
            platform: (c.category || seed?.platform || "tiktok") as CapabilityPlatform,
            status: "verified" as CapabilityStatus,
            unit: (c.pricing_unit || seed?.unit || "call") as CapabilityUnit,
            pricingUnit: (c.pricing_unit || seed?.pricingUnit || "call") as "call" | "item" | "page",
            tregMethod: (c.tregMethod || seed?.tregMethod || "GET") as "GET" | "POST",
            unitCostUsd: costUsd,
            estimatedCostUsdPerUnit: costUsd,
            pointsPerUnit: Number(c.unit_price_credits ?? computeRegistryPointsPerUnit(costUsd, settings)),
            maxItemsPerCall: Number(c.max_rows ?? seed?.maxItemsPerCall ?? 1),
            maxRows: Number(c.max_rows ?? seed?.maxRows ?? 1),
            paginationType: (c.pagination_type || seed?.paginationType || "none") as "cursor" | "offset" | "none",
            estimatedSuccessRate: 0.95,
            verificationNote: VERIFICATION_NOTE,
            paramsSchema: c.params_schema ? (typeof c.params_schema === "string" ? c.params_schema : JSON.stringify(c.params_schema)) : (seed?.paramsSchema || "{}"),
            enabled: true,
          });
        }
        return validCapabilities;
      }
    } catch {
      // fallback
    }
  } else if (tables && typeof tables.listRows === "function") {
    const res = await tables.listRows({
      databaseId: "digr",
      tableId: "capability_registry",
    });
    const rows = (res.rows as unknown as Capability[]).filter((c) => c.enabled);
    if (rows.length > 0) {
      const settings = getRegistryPricingSettings();
      const validCapabilities: Capability[] = [];
      for (const c of rows) {
        const seed = APPROVED_CAPABILITY_CATALOG.find((s) => s.slug === c.slug);
        const costUsd = Number(
          c.estimatedCostUsdPerUnit ??
          c.unitCostUsd ??
          seed?.unitCostUsd ??
          (c.slug === "tiktok-profile" ? 0.001 : 0)
        );
        if (!Number.isFinite(costUsd) || costUsd <= 0) {
          continue; // Fail closed
        }
        validCapabilities.push({
          ...(seed || {}),
          ...c,
          id: c.id || c.slug,
          platform: (c.platform || c.category || seed?.platform || "tiktok") as CapabilityPlatform,
          status: c.status || "verified",
          unit: c.unit || seed?.unit || "profile",
          estimatedCostUsdPerUnit: costUsd,
          pointsPerUnit: computeRegistryPointsPerUnit(costUsd, settings),
          maxItemsPerCall: c.maxItemsPerCall ?? seed?.maxItemsPerCall ?? c.maxRows ?? 1,
          estimatedSuccessRate: c.estimatedSuccessRate ?? seed?.estimatedSuccessRate ?? 0.95,
          verificationNote: c.verificationNote || VERIFICATION_NOTE,
          enabled: true,
        });
      }
      return validCapabilities;
    }
  }
  return buildApprovedCatalog().filter((c) => c.status === "verified" && c.enabled);
}

/**
 * Convert capabilities into a sanitized format for the LLM.
 * HARD RULE R1: Never leak endpoint IDs, provider names, USD costs, or pagination internals.
 */
export function sanitizeCapabilitiesForLlm(capabilities: Capability[]): SanitizedCapabilityForLlm[] {
  const settings = getRegistryPricingSettings();
  return capabilities.map((c) => {
    let parsedSchema: any = {};
    try {
      parsedSchema = typeof c.paramsSchema === "string" ? JSON.parse(c.paramsSchema) : c.paramsSchema;
    } catch {
      parsedSchema = {};
    }
    const seed = APPROVED_CAPABILITY_CATALOG.find((s) => s.slug === c.slug || s.id === c.id);
    const costUsd = Number(
      c.estimatedCostUsdPerUnit ??
      c.unitCostUsd ??
      seed?.unitCostUsd ??
      (c.slug === "tiktok-profile" ? 0.001 : 0)
    );
    const isValidCost = Number.isFinite(costUsd) && costUsd > 0;
    const status: CapabilityStatus = c.status || (c.enabled && isValidCost ? "verified" : "pending_verification");
    return {
      id: c.id || c.slug,
      slug: c.slug,
      platform: c.platform || c.category,
      category: c.category,
      status,
      unit: c.unit || "profile",
      pointsPerUnit: isValidCost ? (c.pointsPerUnit ?? computeRegistryPointsPerUnit(costUsd, settings)) : 0,
      maxItemsPerCall: c.maxItemsPerCall ?? c.maxRows,
      estimatedSuccessRate: c.estimatedSuccessRate ?? 0.9,
      nameAr: c.nameAr,
      descriptionAr: c.descriptionAr,
      paramsSchema: parsedSchema,
      maxRows: c.maxRows,
      enabled: status === "verified" && Boolean(c.enabled),
    };
  });
}

const PLATFORM_PATTERNS: Array<{ platform: string; labelAr: string; regex: RegExp }> = [
  { platform: "companies", labelAr: "قواعد بيانات الشركات والأعمال (B2B Databases)", regex: /شركات|شركة|مؤسسات|مؤسسة|أعمال|business|companies|company|\bb2b\b/i },
  { platform: "tiktok", labelAr: "تيك توك (TikTok)", regex: /تيك\s*توك|tiktok/i },
  { platform: "facebook", labelAr: "فيسبوك (Facebook)", regex: /فيسبوك|فيس\s*بوك|facebook|\bfb\b/i },
  { platform: "x", labelAr: "منصة X (تويتر)", regex: /تويتر|تغريد|twitter|منصة\s*x|\bx\.com\b/i },
  { platform: "youtube", labelAr: "يوتيوب (YouTube)", regex: /يوتيوب|youtube/i },
  { platform: "instagram", labelAr: "إنستغرام (Instagram)", regex: /انستغرام|إنستغرام|انستجرام|إنستجرام|instagram|\binsta\b/i },
  { platform: "reddit", labelAr: "ريديت (Reddit)", regex: /ريديت|reddit/i },
  { platform: "linkedin", labelAr: "لينكد إن (LinkedIn)", regex: /لينكد\s*إن|لينكدإن|linkedin/i },
  { platform: "snapchat", labelAr: "سناب شات (Snapchat)", regex: /سناب\s*شات|سناب|snapchat/i },
  { platform: "telegram", labelAr: "تيليجرام (Telegram)", regex: /تيليجرام|تلغرام|تليجرام|telegram/i },
];

export function detectMentionedPlatforms(text: string): string[] {
  if (!text || typeof text !== "string") return [];
  const found: string[] = [];
  for (const entry of PLATFORM_PATTERNS) {
    if (entry.regex.test(text)) {
      found.push(entry.platform);
    }
  }
  return found;
}

export function getPlatformLabelAr(platform: string): string {
  const match = PLATFORM_PATTERNS.find((p) => p.platform === platform.toLowerCase());
  return match ? match.labelAr : platform;
}

export function inferCapabilityPlatform(
  capabilitySlug: string,
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG
): string {
  const matched = resolveCapabilityReference(capabilitySlug, capabilities) ||
    resolveCapabilityReference(capabilitySlug, APPROVED_CAPABILITY_CATALOG);
  if (matched) {
    return (matched.platform || matched.category).toLowerCase();
  }
  const embeddedPlatform = PLATFORM_PATTERNS.find((platform) => platform.regex.test(capabilitySlug));
  return embeddedPlatform?.platform || capabilitySlug.split("-")[0]?.toLowerCase() || "";
}

function normalizeCapabilityReference(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

/** Resolve exact IDs first, then an unambiguous fully-qualified slug embedded in a model label. */
export function resolveCapabilityReference(
  reference: string,
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG,
): Capability | undefined {
  const raw = (reference || "").trim();
  if (!raw) return undefined;
  const exact = capabilities.find((capability) =>
    capability.slug === raw || capability.id === raw || capability.tregEndpointId === raw,
  );
  if (exact) return exact;

  const normalized = normalizeCapabilityReference(raw).replace(/^(?:منصة-)?(?:diger|ديجر)-/i, "");
  const matches = capabilities.filter((capability) => {
    const identifiers = [capability.slug, capability.id, capability.tregEndpointId]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map(normalizeCapabilityReference);
    return identifiers.some((identifier) => identifier.length >= 10 && (
      normalized.includes(identifier) ||
      identifier.includes(normalized) ||
      identifier.endsWith(`-${normalized}`) ||
      normalized.endsWith(`-${identifier}`)
    ));
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const firstPlatform = (matches[0].platform || matches[0].category || "").toLowerCase();
    const samePlatformAndTask = matches.every((capability) => {
      const platform = (capability.platform || capability.category || "").toLowerCase();
      const identifiers = [capability.slug, capability.id, capability.tregEndpointId]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .map(normalizeCapabilityReference);
      return platform === firstPlatform && identifiers.some((identifier) =>
        identifier.endsWith(`-${normalized}`) || identifier === normalized,
      );
    });
    // Search results are ordered by catalog quality and price. Use that ordering
    // only when every candidate is the same platform and exact task suffix.
    if (samePlatformAndTask) return matches[0];
  }
  return undefined;
}

/**
 * Deterministic check: the platform(s) the user mentioned in their message
 * must match the platform(s) in the proposed plan, else block the plan.
 */
export function validatePlanPlatformMatch(
  userMessage: string,
  planItems: Array<{ capabilitySlug: string; endpointId?: string }>,
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG
): {
  valid: boolean;
  userPlatforms: string[];
  planPlatforms: string[];
  errorAr?: string;
} {
  const userPlatforms = detectMentionedPlatforms(userMessage);
  const planPlatforms = Array.from(
    new Set(
      planItems
        .map((item) => inferCapabilityPlatform(item.capabilitySlug || item.endpointId || "", capabilities))
        .filter(Boolean)
    )
  );

  if (userPlatforms.length === 0) {
    return { valid: true, userPlatforms, planPlatforms };
  }

  // 1. Every platform requested by the user must have an enabled, verified capability available
  const unverifiedUserPlatforms = userPlatforms.filter((plat) => {
    return !capabilities.some((c) => {
      const p = (c.platform || c.category || "").toLowerCase();
      return (
        (p === plat.toLowerCase() || c.slug.includes(plat.toLowerCase())) &&
        c.status === "verified" &&
        c.enabled !== false
      );
    });
  });

  if (unverifiedUserPlatforms.length > 0) {
    const askedLabels = unverifiedUserPlatforms.map(getPlatformLabelAr).join("، ");
    return {
      valid: false,
      userPlatforms,
      planPlatforms,
      errorAr: `${UNVERIFIED_PLATFORM_MESSAGE_AR} (${askedLabels}).`,
    };
  }

  // 2. Every platform in the proposed plan must be one the user asked for,
  // and every platform the user asked for must be represented if only 1 platform was requested
  const hasUnrequestedPlatform = planPlatforms.some((p) => !userPlatforms.includes(p));
  const missingRequestedPlatform =
    planPlatforms.length === 0 || !userPlatforms.some((u) => planPlatforms.includes(u));

  if (hasUnrequestedPlatform || missingRequestedPlatform) {
    const askedLabels = userPlatforms.map(getPlatformLabelAr).join("، ");
    return {
      valid: false,
      userPlatforms,
      planPlatforms,
      errorAr: `${UNVERIFIED_PLATFORM_MESSAGE_AR} (${askedLabels}).`,
    };
  }

  // 3. Every plan item capability must itself be verified and enabled
  const hasUnverifiedPlanItem = planItems.some((item) => {
    const cap = resolveCapabilityReference(item.capabilitySlug, capabilities) ||
      (item.endpointId ? resolveCapabilityReference(item.endpointId, capabilities) : undefined);
    return !cap || cap.status !== "verified" || cap.enabled === false;
  });

  if (hasUnverifiedPlanItem) {
    const askedLabels = userPlatforms.map(getPlatformLabelAr).join("، ");
    return {
      valid: false,
      userPlatforms,
      planPlatforms,
      errorAr: `${UNVERIFIED_PLATFORM_MESSAGE_AR} (${askedLabels || "الخدمة المطلوبة"}).`,
    };
  }

  return { valid: true, userPlatforms, planPlatforms };
}

export function getClosestVerifiedCapability(
  capabilities: Capability[] = APPROVED_CAPABILITY_CATALOG
): Capability {
  return (
    capabilities.find((c) => c.status === "verified" && c.enabled !== false) ||
    APPROVED_CAPABILITY_CATALOG.find((c) => c.status === "verified" && c.enabled !== false) ||
    APPROVED_CAPABILITY_CATALOG[0]
  );
}

/**
 * Server-side parameter validation for a given capability slug
 */
export function validateCapabilityParams(
  capability: Capability,
  params: Record<string, any>
): { valid: boolean; errors?: string[] } {
  try {
    let schemaObj: any = {};
    try {
      schemaObj = typeof capability.paramsSchema === "string" ? JSON.parse(capability.paramsSchema) : capability.paramsSchema;
    } catch {
      return { valid: false, errors: ["Invalid capability schema configuration"] };
    }

    const errors: string[] = [];
    const required: string[] = schemaObj.required || [];

    for (const req of required) {
      if (params[req] === undefined || params[req] === null || params[req] === "") {
        errors.push(`الحقل المطلوب '${req}' مفقود`);
      }
    }

    const properties = schemaObj.properties || {};
    for (const [key, val] of Object.entries(params)) {
      const propDef = properties[key];
      if (propDef) {
        if (propDef.type === "string" && typeof val !== "string") {
          errors.push(`الحقل '${key}' يجب أن يكون نصاً`);
        } else if (propDef.type === "integer" && (!Number.isInteger(val) || typeof val !== "number")) {
          errors.push(`الحقل '${key}' يجب أن يكون رقماً صحيحاً`);
        }
        if (propDef.maximum !== undefined && typeof val === "number" && val > propDef.maximum) {
          errors.push(`الحقل '${key}' يتجاوز الحد الأقصى المسموح به (${propDef.maximum})`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (err: any) {
    return { valid: false, errors: [err.message] };
  }
}
