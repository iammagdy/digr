import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadTregCatalog,
  isSellable,
  type CatalogEndpoint,
  type TregCatalog,
} from "./treg/catalog";
import { blockedEndpointReason } from "./treg/blockList";
import { categoryOf } from "./treg/dataPolicy";
import { PER_RECORD_UNITS, PER_CALL_UNITS } from "./modelPlanner/pricing";
import { checkCustomerText } from "./agentMission/text";
import { toArabicDigits } from "./arabicDigits";
import { PROVIDER_NAME_PATTERN } from "./publicCapabilityIds";
import { DEFAULT_MISSION_PRICING_SETTINGS, priceByRule } from "./missionPricing";

export interface CatalogService {
  /** Opaque and stable; never shown. */
  slug: string;
  nameAr: string;
  /** One plain-Arabic sentence: what the service does and what it helps the customer do. No promise, number or status. */
  explainAr: string;
  group: string;
  /** Core B2B: decision makers and professional contact data. */
  core?: true;
  /** Card-parity pricing helper; internal. */
  startingUnitPoints?: number;
}

export interface CatalogPlatform {
  slug: string;
  nameAr: string;
  descAr: string;
  services: CatalogService[];
}

export interface CatalogSector {
  id: string;
  nameAr: string;
  descAr: string;
  platforms: CatalogPlatform[];
}

export interface CatalogCounts {
  sectors: number;
  platforms: number;
  services: number;
  coreServices: number;
}

export interface LiveServicesCatalog {
  sectors: CatalogSector[];
  counts: CatalogCounts;
  core: Array<CatalogService & { platformAr: string; platformSlug: string }>;
}

export const SERVICE_STATUS_LINE_AR = "نعرض لك الخطة والسعر قبل أي خصم، ولا تدفع إلا على ما يُسلَّم فعلًا";

export const GROUP_ORDER: readonly string[] = [
  "الأشخاص وصناع القرار",
  "بيانات التواصل المهنية",
  "الحسابات والملفات الشخصية",
  "المنشورات والمحتوى",
  "الفيديوهات والبث",
  "التعليقات والردود",
  "المتابعون والتفاعل",
  "البحث والاستكشاف",
  "الترندات والأكثر رواجًا",
  "الإعلانات والحملات",
  "المنتجات والأسعار",
  "التقييمات والمراجعات",
  "الشركات",
  "الأماكن والأنشطة التجارية",
  "المواقع وتحليل الويب",
  "الكلمات المفتاحية ونتائج البحث",
  "الأسواق والأسعار المالية",
  "الأبحاث والمعرفة",
  "المطورون والأكواد",
  "توليد الوسائط",
  "الإدارة والإعدادات",
];

const SECTOR_ORDER: readonly string[] = [
  "SEO/AEO",
  "Social",
  "Advertising",
  "Enrichment",
  "E-commerce",
  "Reviews & Apps",
  "Community",
  "Developer",
  "Market data",
  "Research & public data",
];

const SECTOR_IDS: Readonly<Record<string, string>> = {
  "SEO/AEO": "s1",
  "Social": "s2",
  "Advertising": "s3",
  "Enrichment": "s4",
  "E-commerce": "s5",
  "Reviews & Apps": "s6",
  "Community": "s7",
  "AI generation": "s8",
  "Developer": "s9",
  "Market data": "s10",
  "Research & public data": "s11",
};

interface ClassificationRow {
  idx: number;
  sector: string;
  platform: string;
  key: string;
  en: string;
  cls: "read" | "core" | "write" | "own" | "private" | "helper";
  group: string;
  nameAr: string;
}

interface PlatformsMetadata {
  sectors: Record<string, { nameAr: string; descAr: string }>;
  platforms: Record<string, { nameAr: string; descAr: string }>;
}

let cachedMetadata: {
  classificationByKey: Map<string, ClassificationRow>;
  platformsFile: PlatformsMetadata;
  explanations: Record<string, string>;
} | null = null;

function loadMetadata() {
  if (cachedMetadata) return cachedMetadata;
  const dir = join(process.cwd(), "scripts", "catalog");
  const classPath = join(dir, "classification.json");
  const platPath = join(dir, "platforms.json");
  const expPath = join(dir, "explanations.json");

  const classificationRows: ClassificationRow[] = existsSync(classPath)
    ? JSON.parse(readFileSync(classPath, "utf8"))
    : [];
  const platformsFile: PlatformsMetadata = existsSync(platPath)
    ? JSON.parse(readFileSync(platPath, "utf8"))
    : { sectors: {}, platforms: {} };
  const explanations: Record<string, string> = existsSync(expPath)
    ? JSON.parse(readFileSync(expPath, "utf8"))
    : {};

  const classificationByKey = new Map<string, ClassificationRow>();
  for (const r of classificationRows) {
    classificationByKey.set(`${r.platform}|${r.key}`, r);
    classificationByKey.set(`${r.platform}|${r.platform}.${r.key}`, r);
    if (r.en) classificationByKey.set(`${r.platform}|${r.en.trim().toLowerCase()}`, r);
  }

  cachedMetadata = { classificationByKey, platformsFile, explanations };
  return cachedMetadata;
}

function findClassificationRow(e: CatalogEndpoint): ClassificationRow | undefined {
  const { classificationByKey } = loadMetadata();
  const cap = e.capability;
  if (cap) {
    const r1 = classificationByKey.get(`${e.platform}|${cap}`);
    if (r1) return r1;
    const withoutPlatform = cap.replace(/^[^.]+\./, "");
    const r2 = classificationByKey.get(`${e.platform}|${withoutPlatform}`);
    if (r2) return r2;
  }
  const byName = classificationByKey.get(`${e.platform}|${e.name.trim().toLowerCase()}`);
  if (byName) return byName;
  return undefined;
}

function getCatalogPollIds(catalog: TregCatalog): Set<string> {
  const pollIds = new Set<string>();
  for (const e of catalog.endpoints) {
    const pollEndpoint = (e.async_config as { poll?: { endpoint?: string } } | undefined)?.poll?.endpoint;
    if (pollEndpoint) pollIds.add(pollEndpoint);
  }
  return pollIds;
}

const MEDIA_GEN_PLATFORMS = new Set(["image-gen", "video-gen", "voice-gen", "music-gen"]);

export function isLiveCatalogEndpoint(
  e: CatalogEndpoint,
  catalog: TregCatalog,
  pollIds?: Set<string>,
): boolean {
  if (!e.platform || !e.id) return false;
  if (!isSellable(e.id, catalog)) return false;

  const block = blockedEndpointReason(e.id, e.scope ?? null);
  if (block && !(block === "not_sellable" && catalog.byId.has(e.id))) return false;

  if (categoryOf(e.id) === "blocked") return false;

  if (
    MEDIA_GEN_PLATFORMS.has(e.platform) ||
    /(^|\.)(image|video|voice|music)-gen(\.|$)/.test(e.capability ?? "") ||
    String(e.category ?? "").toLowerCase() === "ai generation"
  ) {
    return false;
  }

  const polls = pollIds ?? getCatalogPollIds(catalog);
  if (
    polls.has(e.id) ||
    /(^|[.-])task[.-]get([.-]|$)/i.test(e.id) ||
    /(^|[.-])task[.-]get([.-]|$)/i.test(e.capability ?? "")
  ) {
    return false;
  }

  if (e.async_config) {
    const pollEndpoint = (e.async_config as { poll?: { endpoint?: string } } | undefined)?.poll?.endpoint;
    if (!pollEndpoint || !isSellable(pollEndpoint, catalog)) return false;
  }

  const unitName = String(e.cost?.unit ?? "").toLowerCase();
  if (!PER_RECORD_UNITS.has(unitName) && !PER_CALL_UNITS.has(unitName)) return false;

  const usd = e.cost?.usd;
  if (usd === null || usd === undefined || typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return false;
  if (usd === 0 && e.cost?.type !== "free") return false;

  const row = findClassificationRow(e);
  if (row && (row.cls === "write" || row.cls === "own" || row.cls === "private" || row.cls === "helper")) return false;

  return true;
}

export function liveServiceUnitPoints(costPerRowUsd: number): number {
  if (costPerRowUsd <= 0) return DEFAULT_MISSION_PRICING_SETTINGS.minChargePoints;
  return priceByRule({ volume: 1, costPerRowUsd, settings: DEFAULT_MISSION_PRICING_SETTINGS }).unitPoints;
}

function sanitizeArabicCustomerText(raw: string): string {
  let s = toArabicDigits(String(raw ?? "")).replace(/[A-Za-z0-9]/g, "").trim();
  s = s.replace(/سجلات/g, "بيانات").replace(/السجل/g, "تاريخ").replace(/الصفوف/g, "النتائج");
  return s;
}

const ENTITY_TOKEN_MAP: Record<string, { entity: string; group: string }> = {
  reviews: { entity: "تقييمات ومراجعات", group: "التقييمات والمراجعات" },
  review: { entity: "تقييمات ومراجعات", group: "التقييمات والمراجعات" },
  comments: { entity: "تعليقات وردود", group: "التعليقات والردود" },
  comment: { entity: "تعليقات وردود", group: "التعليقات والردود" },
  replies: { entity: "تعليقات وردود", group: "التعليقات والردود" },
  reply: { entity: "تعليقات وردود", group: "التعليقات والردود" },
  posts: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  post: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  tweets: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  tweet: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  articles: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  article: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  feed: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  notes: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  note: { entity: "منشورات ومحتوى", group: "المنشورات والمحتوى" },
  videos: { entity: "مقاطع فيديو", group: "الفيديوهات والبث" },
  video: { entity: "مقاطع فيديو", group: "الفيديوهات والبث" },
  reels: { entity: "مقاطع فيديو", group: "الفيديوهات والبث" },
  reel: { entity: "مقاطع فيديو", group: "الفيديوهات والبث" },
  stream: { entity: "مقاطع فيديو", group: "الفيديوهات والبث" },
  followers: { entity: "متابعين وتفاعل", group: "المتابعون والتفاعل" },
  follower: { entity: "متابعين وتفاعل", group: "المتابعون والتفاعل" },
  following: { entity: "متابعين وتفاعل", group: "المتابعون والتفاعل" },
  likes: { entity: "متابعين وتفاعل", group: "المتابعون والتفاعل" },
  like: { entity: "متابعين وتفاعل", group: "المتابعون والتفاعل" },
  products: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  product: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  items: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  item: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  prices: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  price: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  shop: { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  profile: { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  user: { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  users: { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  account: { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  channel: { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  creator: { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  company: { entity: "بيانات شركات", group: "الشركات" },
  companies: { entity: "بيانات شركات", group: "الشركات" },
  business: { entity: "بيانات شركات", group: "الشركات" },
  people: { entity: "أشخاص وموظفين", group: "الأشخاص وصناع القرار" },
  employee: { entity: "أشخاص وموظفين", group: "الأشخاص وصناع القرار" },
  employees: { entity: "أشخاص وموظفين", group: "الأشخاص وصناع القرار" },
  contact: { entity: "أشخاص وموظفين", group: "الأشخاص وصناع القرار" },
  contacts: { entity: "أشخاص وموظفين", group: "الأشخاص وصناع القرار" },
  jobs: { entity: "وظائف معلنة", group: "المجتمعات المهنية والوظائف" },
  job: { entity: "وظائف معلنة", group: "المجتمعات المهنية والوظائف" },
  keywords: { entity: "كلمات مفتاحية ونتائج", group: "الكلمات المفتاحية ونتائج البحث" },
  keyword: { entity: "كلمات مفتاحية ونتائج", group: "الكلمات المفتاحية ونتائج البحث" },
  serp: { entity: "كلمات مفتاحية ونتائج", group: "الكلمات المفتاحية ونتائج البحث" },
  rankings: { entity: "كلمات مفتاحية ونتائج", group: "الكلمات المفتاحية ونتائج البحث" },
  rank: { entity: "كلمات مفتاحية ونتائج", group: "الكلمات المفتاحية ونتائج البحث" },
  trends: { entity: "موضوعات رائجة", group: "الترندات والأكثر رواجًا" },
  trend: { entity: "موضوعات رائجة", group: "الترندات والأكثر رواجًا" },
  trending: { entity: "موضوعات رائجة", group: "الترندات والأكثر رواجًا" },
  stocks: { entity: "أسعار وأسواق مالية", group: "الأسواق والأسعار المالية" },
  stock: { entity: "أسعار وأسواق مالية", group: "الأسواق والأسعار المالية" },
  market: { entity: "أسعار وأسواق مالية", group: "الأسواق والأسعار المالية" },
  repos: { entity: "مستودعات وبرمجيات", group: "المطورون والأكواد" },
  repo: { entity: "مستودعات وبرمجيات", group: "المطورون والأكواد" },
  commits: { entity: "مستودعات وبرمجيات", group: "المطورون والأكواد" },
  commit: { entity: "مستودعات وبرمجيات", group: "المطورون والأكواد" },
  ads: { entity: "إعلانات وحملات", group: "الإعلانات والحملات" },
  ad: { entity: "إعلانات وحملات", group: "الإعلانات والحملات" },
  campaigns: { entity: "إعلانات وحملات", group: "الإعلانات والحملات" },
  campaign: { entity: "إعلانات وحملات", group: "الإعلانات والحملات" },
  places: { entity: "أماكن ومواقع جغرافية", group: "الأماكن والأنشطة التجارية" },
  place: { entity: "أماكن ومواقع جغرافية", group: "الأماكن والأنشطة التجارية" },
  locations: { entity: "أماكن ومواقع جغرافية", group: "الأماكن والأنشطة التجارية" },
  location: { entity: "أماكن ومواقع جغرافية", group: "الأماكن والأنشطة التجارية" },
};

const CATEGORY_MAP: Record<string, { entity: string; group: string }> = {
  "E-commerce": { entity: "منتجات وأسعار", group: "المنتجات والأسعار" },
  "Social": { entity: "بيانات ملف وحساب", group: "الحسابات والملفات الشخصية" },
  "SEO/AEO": { entity: "كلمات مفتاحية ونتائج", group: "الكلمات المفتاحية ونتائج البحث" },
  "Reviews & Apps": { entity: "تقييمات ومراجعات", group: "التقييمات والمراجعات" },
  "Enrichment": { entity: "أشخاص وموظفين", group: "الأشخاص وصناع القرار" },
  "Financial": { entity: "أسعار وأسواق مالية", group: "الأسواق والأسعار المالية" },
  "Developer": { entity: "مستودعات وبرمجيات", group: "المطورون والأكواد" },
  "Advertising": { entity: "إعلانات وحملات", group: "الإعلانات والحملات" },
  "Jobs": { entity: "وظائف معلنة", group: "المجتمعات المهنية والوظائف" },
  "Real Estate": { entity: "أماكن ومواقع جغرافية", group: "الأماكن والأنشطة التجارية" },
};

function composeTier2(e: CatalogEndpoint): { nameAr: string; explainAr: string; group: string } {
  const capParts = (e.capability ?? "").toLowerCase().split(".").filter(Boolean);
  const inputNames = new Set((e.inputs ?? []).map((inp) => String(inp.name ?? "").toLowerCase()));

  let action = "استخراج";
  if (
    capParts.includes("search") ||
    capParts.includes("find") ||
    capParts.includes("query") ||
    inputNames.has("query") ||
    inputNames.has("q")
  ) {
    action = "البحث عن";
  } else if (capParts.includes("detail") || capParts.includes("details") || capParts.includes("info")) {
    action = "تفاصيل وبيانات";
  } else if (capParts.includes("list") || capParts.includes("all")) {
    action = "قائمة";
  } else if (capParts.includes("verify") || capParts.includes("validate")) {
    action = "التحقق من صحة";
  } else if (capParts.includes("enrich") || capParts.includes("lookup")) {
    action = "استكمال وتدقيق";
  }

  let entity = "بيانات عامة";
  let group = "البحث والاستكشاف";

  let found = false;
  for (let i = capParts.length - 1; i >= 0; i--) {
    const part = capParts[i];
    if (part && ENTITY_TOKEN_MAP[part]) {
      entity = ENTITY_TOKEN_MAP[part].entity;
      group = ENTITY_TOKEN_MAP[part].group;
      found = true;
      break;
    }
  }

  if (!found && e.category && CATEGORY_MAP[e.category]) {
    entity = CATEGORY_MAP[e.category].entity;
    group = CATEGORY_MAP[e.category].group;
  }

  let qualifier = "";
  if (inputNames.has("url") || inputNames.has("link")) {
    qualifier = " بالرابط";
  } else if (
    (inputNames.has("keyword") || inputNames.has("keywords") || inputNames.has("q")) &&
    action !== "البحث عن"
  ) {
    qualifier = " بالكلمة المفتاحية";
  } else if (inputNames.has("country") || inputNames.has("country_code") || inputNames.has("location_code")) {
    qualifier = " حسب الدولة";
  } else if (inputNames.has("category") || inputNames.has("category_id")) {
    qualifier = " حسب التصنيف";
  } else if (
    (inputNames.has("username") || inputNames.has("user") || inputNames.has("user_id") || inputNames.has("account_id")) &&
    !entity.includes("حساب")
  ) {
    qualifier = " للحساب";
  }

  const nameAr = `${action} ${entity}${qualifier}`.trim();
  const explainAr = `جمع ${nameAr} من هذه المنصة وإخراجها في ملف منظم جاهز للاستخدام.`;
  return { nameAr, explainAr, group };
}

interface ServiceCandidate {
  slug: string;
  nameAr: string;
  explainAr: string;
  group: string;
  core?: true;
  minCostUsd: number;
}

export function buildLiveServicesCatalog(catalog: TregCatalog): LiveServicesCatalog {
  const { platformsFile, explanations } = loadMetadata();
  const pollIds = getCatalogPollIds(catalog);
  const eligible = catalog.endpoints.filter((e) => isLiveCatalogEndpoint(e, catalog, pollIds));

  // Group endpoints by platform
  const byPlatform = new Map<string, CatalogEndpoint[]>();
  for (const e of eligible) {
    let list = byPlatform.get(e.platform);
    if (!list) {
      list = [];
      byPlatform.set(e.platform, list);
    }
    list.push(e);
  }

  // Build platform entries
  const platformEntries = new Map<string, CatalogPlatform & { sectorKey: string }>();

  for (const [platformSlug, endpoints] of byPlatform) {
    const rawCategory = endpoints[0]?.category ?? "Research & public data";
    const sectorKey = SECTOR_ORDER.includes(rawCategory) ? rawCategory : "Research & public data";

    const platMeta = platformsFile.platforms[platformSlug] ?? {
      nameAr: "منصة بيانات عامة",
      descAr: "جمع البيانات والمعلومات العامة المتاحة من هذه المنصة بصيغة منظمة.",
    };

    const byName = new Map<string, ServiceCandidate>();
    const seenExplains = new Set<string>();
    const seenSlugs = new Set<string>();

    for (const e of endpoints) {
      const row = findClassificationRow(e);
      let nameAr: string;
      let group: string;
      let isCore = false;
      let explainAr: string;

      if (row) {
        nameAr = row.nameAr;
        group = row.group;
        isCore = row.cls === "core";
        explainAr = explanations[`${e.platform}|${nameAr}`] ?? "";
      } else {
        const t2 = composeTier2(e);
        nameAr = t2.nameAr;
        group = t2.group;
        isCore = false;
        explainAr = t2.explainAr;
      }

      nameAr = sanitizeArabicCustomerText(nameAr);
      if (!nameAr || checkCustomerText(nameAr).issues.length > 0 || PROVIDER_NAME_PATTERN.test(nameAr)) {
        nameAr = "استخراج بيانات عامة من المنصة";
      }

      const costUsd = typeof e.cost?.usd === "number" ? e.cost.usd : 0;

      if (byName.has(nameAr)) {
        const existing = byName.get(nameAr)!;
        if (isCore) existing.core = true;
        existing.minCostUsd = Math.min(existing.minCostUsd, costUsd);
        continue;
      }

      if (!explainAr) {
        explainAr = `جمع ${nameAr} من هذه المنصة وإخراجها في ملف منظم جاهز للاستخدام.`;
      }
      explainAr = sanitizeArabicCustomerText(explainAr);
      if (!explainAr.endsWith(".")) explainAr += ".";
      if (
        explainAr.length < 20 ||
        explainAr.length > 140 ||
        checkCustomerText(explainAr).issues.length > 0 ||
        PROVIDER_NAME_PATTERN.test(explainAr)
      ) {
        explainAr = `جمع ${nameAr} من هذه المنصة وإخراجها في ملف منظم جاهز للاستخدام.`;
      }

      if (seenExplains.has(explainAr)) {
        explainAr = `استخراج وحفظ ${nameAr} من هذه المنصة في ملف منظم ومفصل.`;
      }
      seenExplains.add(explainAr);

      const capKey = e.capability ?? e.name ?? "";
      let slug = createHash("sha1").update(`${e.platform}|${capKey}`).digest("hex").slice(0, 7);
      let salt = 1;
      while (seenSlugs.has(slug)) {
        slug = createHash("sha1").update(`${e.platform}|${capKey}|${salt++}`).digest("hex").slice(0, 7);
      }
      seenSlugs.add(slug);

      byName.set(nameAr, {
        slug,
        nameAr,
        explainAr,
        group,
        ...(isCore ? { core: true as const } : {}),
        minCostUsd: costUsd,
      });
    }

    const services: CatalogService[] = [...byName.values()]
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group))
      .map((item) => ({
        slug: item.slug,
        nameAr: item.nameAr,
        explainAr: item.explainAr,
        group: item.group,
        ...(item.core ? { core: true as const } : {}),
        startingUnitPoints: liveServiceUnitPoints(item.minCostUsd),
      }));

    if (services.length > 0) {
      platformEntries.set(platformSlug, {
        slug: platformSlug,
        nameAr: sanitizeArabicCustomerText(platMeta.nameAr),
        descAr: sanitizeArabicCustomerText(platMeta.descAr),
        services,
        sectorKey,
      });
    }
  }

  // Group platforms into sectors preserving SECTOR_ORDER
  const sectors: CatalogSector[] = [];
  const knownSectorKeys = new Set(SECTOR_ORDER);

  for (const sectorKey of SECTOR_ORDER) {
    const platformsInSector: CatalogPlatform[] = [];
    for (const [_, entry] of platformEntries) {
      if (entry.sectorKey === sectorKey) {
        platformsInSector.push({
          slug: entry.slug,
          nameAr: entry.nameAr,
          descAr: entry.descAr,
          services: entry.services,
        });
      }
    }

    if (platformsInSector.length === 0) continue;

    const sectorMeta = platformsFile.sectors[sectorKey] ?? {
      nameAr: "بيانات ومنصات متخصصة",
      descAr: "جمع واستخراج البيانات المنظمة من المنصات المتخصصة.",
    };

    sectors.push({
      id: SECTOR_IDS[sectorKey] ?? `s${sectors.length + 1}`,
      nameAr: sanitizeArabicCustomerText(sectorMeta.nameAr),
      descAr: sanitizeArabicCustomerText(sectorMeta.descAr),
      platforms: platformsInSector,
    });
  }

  // Any leftover platforms with unknown sectors
  const unassignedPlatforms: CatalogPlatform[] = [];
  for (const [_, entry] of platformEntries) {
    if (!knownSectorKeys.has(entry.sectorKey)) {
      unassignedPlatforms.push({
        slug: entry.slug,
        nameAr: entry.nameAr,
        descAr: entry.descAr,
        services: entry.services,
      });
    }
  }

  if (unassignedPlatforms.length > 0) {
    sectors.push({
      id: `s${sectors.length + 1}`,
      nameAr: "بيانات ومنصات عامة",
      descAr: "جمع واستخراج البيانات المنظمة من المنصات العامة.",
      platforms: unassignedPlatforms,
    });
  }

  const counts = catalogCounts(sectors);
  const core = coreServices(sectors);

  return { sectors, counts, core };
}

const CATALOG_CACHE = new WeakMap<TregCatalog, LiveServicesCatalog>();

export function getLiveServicesCatalog(catalog: TregCatalog = loadTregCatalog()): LiveServicesCatalog {
  const cached = CATALOG_CACHE.get(catalog);
  if (cached) return cached;
  const built = buildLiveServicesCatalog(catalog);
  CATALOG_CACHE.set(catalog, built);
  return built;
}

export function catalogCounts(catalog: CatalogSector[] = getLiveServicesCatalog().sectors): CatalogCounts {
  let platforms = 0;
  let services = 0;
  let coreCount = 0;
  for (const sector of catalog) {
    platforms += sector.platforms.length;
    for (const platform of sector.platforms) {
      services += platform.services.length;
      coreCount += platform.services.filter((service) => service.core).length;
    }
  }
  return { sectors: catalog.length, platforms, services, coreServices: coreCount };
}

export function coreServices(
  catalog: CatalogSector[] = getLiveServicesCatalog().sectors,
): Array<CatalogService & { platformAr: string; platformSlug: string }> {
  const seen = new Set<string>();
  const result: Array<CatalogService & { platformAr: string; platformSlug: string }> = [];
  for (const sector of catalog) {
    for (const platform of sector.platforms) {
      for (const service of platform.services) {
        if (!service.core || seen.has(service.nameAr)) continue;
        seen.add(service.nameAr);
        result.push({ ...service, platformAr: platform.nameAr, platformSlug: platform.slug });
      }
    }
  }
  return result;
}

export const platformServiceCount = (platform: CatalogPlatform): number => platform.services.length;

export function servicesByGroup(
  platform: CatalogPlatform,
): Array<{ group: string; services: CatalogService[] }> {
  const groups: Array<{ group: string; services: CatalogService[] }> = [];
  for (const service of platform.services) {
    const last = groups[groups.length - 1];
    if (last && last.group === service.group) last.services.push(service);
    else groups.push({ group: service.group, services: [service] });
  }
  return groups;
}
