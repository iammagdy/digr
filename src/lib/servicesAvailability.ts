import type { CatalogPlatform } from "./servicesCatalog";

/**
 * INTERNAL knowledge about which catalog services are proven live. It is NEVER shown to customers: no status, chip, line or call to action per
 * service appears anywhere. It only orders the platform cards (platforms with a proven service first) and feeds docs/FUTURE_SERVICES.md.
 *
 * To mark a service proven after a live test, add its registry slug to PROVEN_REGISTRY_SLUGS (one line).
 */

/** The one primary call to action of the services page (top and bottom). */
export const SERVICES_PRIMARY_CTA_AR = "ابدأ طلبك";

/** The one honest line above the decision-makers block (page and landing page). It changes no price or call to action. */
export const DECISION_MAKERS_LINE_AR = "بيانات صناع القرار تُسلَّم الآن بحسب الطلب، وتُعرض خطتها وسعرها قبل أي خصم.";

/**
 * THE INTERNAL LIST. Registry slugs (see APPROVED_CAPABILITY_CATALOG in src/functions/shared/capabilityRegistry.ts) of the services proven live:
 * company search, X post search, Facebook keyword comments, Facebook page posts, Facebook post comments, TikTok video comments.
 * (People search, `professional-people-search`, is not here: it was not proven live after the latest fixes; add it back after a live test.) A slug here must exist in the registry (tests/services-availability.test.tsx proves it).
 */
export const PROVEN_REGISTRY_SLUGS: readonly string[] = [
  "icypeas-companies-search",
  "social-x-posts",
  "social-facebook-keyword-comments",
  "social-facebook-posts",
  "social-facebook-comments",
  "social-tiktok-comments",
];

export interface RegistryServiceEntry {
  /** A registry slug, or `slug:field` for a field of a registry service that is not itself a registry slug (never a slug that must exist). */
  id: string;
  /** The catalog platform and the service's Arabic name, as in servicesCatalog.ts. */
  platform: string;
  nameAr: string;
}

/**
 * Every catalog service that has a code executor in the registry, mapped by hand from its registry slug. A service is proven when ANY entry that
 * maps to it has its id in PROVEN_REGISTRY_SLUGS. Entries not in that list are services with an executor that was NOT proven live.
 */
export const REGISTRY_SERVICE_MAP: readonly RegistryServiceEntry[] = [
  { id: "icypeas-companies-search", platform: "companies", nameAr: "البحث عن شركات بالصناعة أو الحجم أو التقنية" },
  { id: "professional-people-search", platform: "people", nameAr: "البحث عن أشخاص بالدور أو الشركة أو الموقع" },
  { id: "icypeas-people-search", platform: "people", nameAr: "البحث عن أشخاص بالدور أو الشركة أو الموقع" },
  { id: "mp-business-contacts", platform: "people", nameAr: "البريد المهني لشخص من الاسم أو نطاق الشركة أو الملف" },
  { id: "professional-people-search:phone", platform: "people", nameAr: "رقم هاتف العمل لشخص" },
  { id: "social-x-posts", platform: "x", nameAr: "البحث عن منشورات بكلمة مفتاحية" },
  { id: "x-keyword-search", platform: "x", nameAr: "البحث عن منشورات بكلمة مفتاحية" },
  { id: "social-facebook-keyword-comments", platform: "facebook", nameAr: "البحث عن منشورات عامة بكلمة مفتاحية" },
  { id: "facebook-post-search", platform: "facebook", nameAr: "البحث عن منشورات عامة بكلمة مفتاحية" },
  { id: "social-facebook-posts", platform: "facebook", nameAr: "المنشورات العامة لحساب" },
  { id: "social-facebook-comments", platform: "facebook", nameAr: "التعليقات على منشور" },
  { id: "facebook-post-comments", platform: "facebook", nameAr: "التعليقات على منشور" },
  { id: "social-tiktok-comments", platform: "tiktok", nameAr: "التعليقات على فيديو" },
  { id: "tiktok-profile", platform: "tiktok", nameAr: "بيانات ملف مستخدم عام" },
  { id: "social-tiktok-videos", platform: "tiktok", nameAr: "البحث عن فيديوهات بكلمة مفتاحية" },
  { id: "instagram-profile", platform: "instagram", nameAr: "بيانات ملف مستخدم عام" },
  { id: "instagram-comments", platform: "instagram", nameAr: "التعليقات على منشور" },
  { id: "social-youtube-comments", platform: "youtube", nameAr: "التعليقات على فيديو" },
  { id: "youtube-comments", platform: "youtube", nameAr: "التعليقات على فيديو" },
  { id: "social-youtube-videos", platform: "youtube", nameAr: "البحث عن فيديوهات بكلمة مفتاحية" },
  { id: "youtube-search", platform: "youtube", nameAr: "البحث عن فيديوهات بكلمة مفتاحية" },
  { id: "reddit-post-comments", platform: "reddit", nameAr: "التعليقات على منشور" },
  { id: "linkedin-profile", platform: "linkedin", nameAr: "ملف عضو" },
];

const key = (platform: string, nameAr: string) => `${platform}|${nameAr}`;

const PROVEN_KEYS: ReadonlySet<string> = new Set(
  REGISTRY_SERVICE_MAP.filter((entry) => PROVEN_REGISTRY_SLUGS.includes(entry.id)).map((entry) => key(entry.platform, entry.nameAr)),
);
const EXECUTOR_KEYS: ReadonlySet<string> = new Set(REGISTRY_SERVICE_MAP.map((entry) => key(entry.platform, entry.nameAr)));

/** True when the service is proven live (internal). */
export const isProven = (platformSlug: string, nameAr: string): boolean => PROVEN_KEYS.has(key(platformSlug, nameAr));

/** True when a code executor exists for the service (proven live or not). Internal: used by the future-services document only. */
export const hasCodeExecutor = (platformSlug: string, nameAr: string): boolean => EXECUTOR_KEYS.has(key(platformSlug, nameAr));

/** Services of a platform that are proven (internal; never shown). */
export const platformProvenCount = (platform: CatalogPlatform): number => platform.services.filter((service) => isProven(platform.slug, service.nameAr)).length;

/** Platforms with at least one proven service first; the catalog's own order otherwise (stable). Only the order is visible to a customer. */
export function platformsProvenFirst<T extends CatalogPlatform>(platforms: readonly T[]): T[] {
  return [...platforms]
    .map((platform, index) => ({ platform, index, first: platformProvenCount(platform) > 0 ? 0 : 1 }))
    .sort((a, b) => a.first - b.first || a.index - b.index)
    .map((entry) => entry.platform);
}
