import { SERVICES_CATALOG, servicesByGroup, type CatalogPlatform, type CatalogSector } from "./servicesCatalog";
import { normalizeArabicSearch } from "./servicesCatalogText";
import { SITE_URL } from "./site";

/**
 * What the chat knows of the catalog, built from the SAME data module as /services (never typed twice):
 *  - a compact map (sector -> platforms, names only) that sits in the cached part of the prompt;
 *  - a slice (the services of ONE platform, names only) that is attached to a planning turn when the customer's message names that platform,
 *    found by code (no model call);
 *  - the answer to «what do you offer», built by code (zero model tokens).
 * Nothing here decides a price, a plan or a charge: those stay in code elsewhere.
 */

/** Short group names for the map (the long names stay on the page). */
const GROUP_SHORT_AR: Record<string, string> = {
  "الأشخاص وصناع القرار": "أشخاص وصناع قرار",
  "بيانات التواصل المهنية": "تواصل مهني",
  "الحسابات والملفات الشخصية": "حسابات",
  "المنشورات والمحتوى": "منشورات",
  "الفيديوهات والبث": "فيديوهات وبث",
  "التعليقات والردود": "تعليقات",
  "المتابعون والتفاعل": "متابعون وتفاعل",
  "البحث والاستكشاف": "بحث",
  "الترندات والأكثر رواجًا": "ترندات",
  "الإعلانات والحملات": "إعلانات",
  "المنتجات والأسعار": "منتجات وأسعار",
  "التقييمات والمراجعات": "تقييمات",
  "الشركات": "شركات",
  "الأماكن والأنشطة التجارية": "أماكن",
  "المواقع وتحليل الويب": "مواقع",
  "الكلمات المفتاحية ونتائج البحث": "كلمات مفتاحية",
  "الأسواق والأسعار المالية": "أسواق مالية",
  "الأبحاث والمعرفة": "أبحاث",
  "المطورون والأكواد": "أكواد",
  "توليد الوسائط": "توليد",
  "الإدارة والإعدادات": "إدارة",
};
const shortGroup = (group: string): string => GROUP_SHORT_AR[group] || group;

/**
 * The compact map: per sector, its platforms (names only). The service GROUPS of a platform arrive as a slice when the customer names it (below):
 * the cached prompt has room for about a thousand tokens more (see tests/prompt-token-breakdown.test.ts), and a map with the groups of all platforms is about twice that.
 */
export function catalogMapText(catalog: CatalogSector[] = SERVICES_CATALOG): string {
  return catalog.map((sector) => `${sector.nameAr}: ${sector.platforms.map((platform) => platform.nameAr).join("، ")}`).join("\n");
}

/** The fixed rules that go with the map (the prompt's own language is English; the map and the quoted words are Arabic). */
export const CATALOG_MAP_RULES = `SERVICE MAP RULES
- The map lists what exists: sector, then platforms. The service groups of a platform arrive as a slice when the customer names it. Say which platform and groups a request belongs to ("هذا الطلب ضمن منصة ... وخدمات ...").
- Never name or promise a platform, service or group that is not in the map or in an attached slice; if it is not there, say so and offer the closest listed one.
- The map is not a price, a plan or a delivery promise: price, plan, hold and charge come only from the server; plan steps come only from capability cards. For a listed service with no capability card add no plan step: say honestly you will look for a way to run it, that a plan with its price comes before any spend, and that the whole hold is released if nothing is delivered.
- People and professional contact data (work e-mail and phone, a verification status per field) are a core service: say so first for requests about people at companies.
- Arabic only: no provider names, ids or emoji.`;

/** The block that goes into the cached part of the prompt. */
export function catalogMapPromptText(catalog: CatalogSector[] = SERVICES_CATALOG): string {
  return `SERVICE CATALOG MAP (names only; sector, then its platforms)\n${catalogMapText(catalog)}\n\n${CATALOG_MAP_RULES}`;
}

/* ------------------------------------------------------------------ platform mention (by code) */

/** Other ways customers write a platform (normalised the same way as the text). The catalog's own Arabic names are always used too. */
const PLATFORM_ALIASES: Record<string, string[]> = {
  x: ["تويتر", "اكس", "إكس"],
  facebook: ["فيس بوك", "فيسبوك", "فيس", "فايسبوك"],
  instagram: ["انستجرام", "انستغرام", "إنستجرام", "انستا", "إنستا"],
  tiktok: ["تيكتوك", "تيك توك"],
  youtube: ["يوتوب", "يوتيوب"],
  linkedin: ["لينكد ان", "لينكدان", "لينكدإن", "لنكدان"],
  google: ["جوجل", "غوغل", "قوقل"],
  amazon: ["امازون", "أمازون"],
  reddit: ["ريدت", "ريديت"],
  telegram: ["تلجرام", "تلغرام", "تيليجرام"],
  snapchat: ["سناب", "سناب شات", "سنابشات"],
  github: ["جيتهاب", "جيت هب"],
  people: ["صناع القرار", "صانع القرار", "صناع قرار", "اصحاب القرار"],
};

/** Words that must not make a platform on their own (a name made of ordinary words). */
const MIN_NAME_LETTERS = 4;

const PREFIXES = ["", "ال", "و", "ب", "ل", "ف", "ك", "وال", "بال", "لل", "فال", "كال"];

interface Lexeme { platform: CatalogPlatform; tokens: string[] }

function tokensOf(text: string): string[] {
  return normalizeArabicSearch(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/u).filter(Boolean);
}

let LEXICON: Lexeme[] | null = null;
function lexicon(): Lexeme[] {
  if (LEXICON) return LEXICON;
  const out: Lexeme[] = [];
  for (const sector of SERVICES_CATALOG) {
    for (const platform of sector.platforms) {
      const names = new Set<string>();
      const base = platform.nameAr.replace(/\s*\([^)]*\)/g, "").trim();
      if (base) names.add(base);
      const inParens = /\(([^)]*)\)/.exec(platform.nameAr)?.[1];
      if (inParens) names.add(inParens.replace(/سابقًا|سابقا/g, "").trim());
      for (const alias of PLATFORM_ALIASES[platform.slug] || []) names.add(alias);
      for (const name of names) {
        const tokens = tokensOf(name);
        if (tokens.length === 0) continue;
        const isAlias = (PLATFORM_ALIASES[platform.slug] || []).some((alias) => tokensOf(alias).join(" ") === tokens.join(" "));
        if (!isAlias && tokens.join("").length < MIN_NAME_LETTERS) continue;
        out.push({ platform, tokens });
      }
    }
  }
  LEXICON = out.sort((a, b) => b.tokens.length - a.tokens.length);
  return LEXICON;
}

const tokenMatches = (messageToken: string, nameToken: string): boolean => PREFIXES.some((prefix) => messageToken === `${prefix}${nameToken}`);

/**
 * The platforms of the catalog a message names, in the order they are named (at most `limit`). Whole words only, with the usual Arabic prefixes
 * («بالفيسبوك», «على تيك توك», «للويب»): «إكسل» is not «إكس».
 */
export function detectCatalogPlatforms(message: string, limit = 2): CatalogPlatform[] {
  const tokens = tokensOf(message);
  if (tokens.length === 0) return [];
  const found: Array<{ at: number; platform: CatalogPlatform }> = [];
  for (const lexeme of lexicon()) {
    if (found.some((entry) => entry.platform.slug === lexeme.platform.slug)) continue;
    for (let start = 0; start + lexeme.tokens.length <= tokens.length; start++) {
      if (lexeme.tokens.every((nameToken, offset) => tokenMatches(tokens[start + offset], nameToken))) { found.push({ at: start, platform: lexeme.platform }); break; }
    }
  }
  return found.sort((a, b) => a.at - b.at).slice(0, limit).map((entry) => entry.platform);
}

/** At most this many characters of services per platform slice (the longest platform has far more services than a prompt should carry). */
export const SLICE_MAX_CHARS = 1200;

/** The services of one platform, by group, names only. Cut at `SLICE_MAX_CHARS`; a cut slice says so. */
export function catalogSliceText(platform: CatalogPlatform): string {
  const header = `خدمات منصة ${platform.nameAr} في الكتالوج (أسماء فقط، لا أسعار):`;
  const lines: string[] = [];
  let used = header.length;
  let cut = false;
  for (const { group, services } of servicesByGroup(platform)) {
    const names: string[] = [];
    for (const service of services) {
      if (used + service.nameAr.length + 3 > SLICE_MAX_CHARS) { cut = true; break; }
      names.push(service.nameAr);
      used += service.nameAr.length + 2;
    }
    if (names.length > 0) lines.push(`${shortGroup(group)}: ${names.join("؛ ")}`);
    if (cut) break;
  }
  return `${header}\n${lines.join("\n")}${cut ? "\n(القائمة مقتطعة؛ هناك خدمات أخرى في المنصة نفسها)" : ""}`;
}

/** The context attached to a planning turn when the message names a platform of the catalog; empty when it names none. */
export function catalogSliceForMessage(message: string): string {
  const platforms = detectCatalogPlatforms(message);
  if (platforms.length === 0) return "";
  return `[خدمات الكتالوج للمنصة المذكورة — داخلية: استخدمها لتقول لأي منصة وخدمات ينتمي الطلب، ولا تذكر خدمة غير مدرجة هنا ولا سعرًا]\n${platforms.map(catalogSliceText).join("\n\n")}`;
}

/* ------------------------------------------------------------------ «what do you offer» (by code, zero model tokens) */

const OFFER_PATTERNS: RegExp[] = [
  /^(?:ايه|إيه|ايش|إيش|شو|ما\s*هي|ما)\s+(?:هي\s+)?(?:ال)?خدمات(?:كم|نا|ك)?(?:\s+(?:المتاحه|المتاحة|اللي\s+عندكم|عندكم))?$/u,
  /^(?:بتعملوا|بتقدموا|بتقدمو|بتعملو|تعملوا|تقدموا|تقدمون|تعملون)\s+(?:ايه|إيه|ايش|إيش|شو|ماذا)$/u,
  /^(?:ايه|إيه|ايش|إيش|شو)\s+(?:اللي|الي)\s+(?:بتعملوه|بتقدموه|تقدروا\s+تعملوه|تقدرو\s+تعملوه|تقدروا\s+تقدموه)$/u,
  /^(?:عندكم|عندكو)\s+(?:ايه|إيه|ايش|إيش|شو)$/u,
  /^(?:ماذا|ما\s*الذي)\s+(?:تقدمون|تقدمه(?:ون)?|يقدمه\s+ديجر|يقدم\s+ديجر)$/u,
  /^(?:ديجر|دجر)\s+(?:بيعمل|بتعمل|بيقدم|بتقدم|يقدم|بيقدّم)\s+(?:ايه|إيه|ايش|إيش|ماذا)$/u,
];

/** True for a plain question about what Diger offers («إيه الخدمات؟», «بتعملوا إيه؟»). A question that names a platform is not one: it goes to the planner with that platform's slice. */
export function isOfferQuestion(message: string): boolean {
  const text = normalizeArabicSearch(message).replace(/[؟?!.،,]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!text || text.length > 60) return false;
  if (detectCatalogPlatforms(text, 1).length > 0) return false;
  return OFFER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The answer: short Arabic, by sector, decision makers first, and where the full list is. Built only from the catalog data and one fixed sentence about
 * the plan; no count, price or rate is typed here.
 */
export function offerAnswerAr(catalog: CatalogSector[] = SERVICES_CATALOG): string {
  const b2b = catalog.find((sector) => sector.platforms.some((platform) => platform.slug === "people"));
  const others = catalog.filter((sector) => sector !== b2b).map((sector) => `- ${sector.nameAr}`);
  return [
    "أجمع لك بيانات من مصادر متاحة وأسلّمها في ملف إكسل أو بي دي إف.",
    ...(b2b ? [`أولًا، ${b2b.nameAr}: من يقرر في الشركة وبريد عمله وهاتف مكتبه، وبجانب كل حقل حالة تحقق.`] : []),
    "وهذه بقية القطاعات:",
    ...others,
    "اكتب لي ما تريد معرفته وأجهز لك خطة وسعرها قبل أي خصم.",
    `القائمة الكاملة في صفحة «خدماتنا»: ${SITE_URL}/services`,
  ].join("\n");
}
