import type { CatalogPlatform, CatalogSector } from "./servicesCatalog";

/**
 * The status of every service of the public catalog: TWO values, derived from ONE constant list, never typed per service.
 *
 *  «متاح الآن»  a service proven live (its registry slug is in AVAILABLE_NOW_REGISTRY_SLUGS below)
 *  «قريبًا»     every other service, including those that have a code executor that was not proven live
 *
 * To flip a service after a live test: add its registry slug to AVAILABLE_NOW_REGISTRY_SLUGS (one line). Nothing else changes: the page, the landing
 * page and the counts read this file. A «قريبًا» service shows no call to action, no price and no promise of delivery.
 */

export const SERVICE_STATUS_AVAILABLE_AR = "متاح الآن";
export const SERVICE_STATUS_SOON_AR = "قريبًا";
/** The one line under a «قريبًا» service. */
export const SERVICE_SOON_LINE_AR = "ستُضاف تدريجيًا";
/** The call to action of a «متاح الآن» service. */
export const SERVICE_ORDER_CTA_AR = "ابدأ طلبك";

export type ServiceStatus = "available" | "soon";

/**
 * THE CONSTANT. Registry slugs (see APPROVED_CAPABILITY_CATALOG in src/functions/shared/capabilityRegistry.ts) of the services proven live:
 * company search, X post search, Facebook keyword comments, Facebook page posts, Facebook post comments, TikTok video comments.
 * (People search, `professional-people-search`, is not here: it was not proven live after the latest fixes; add it back after a live test.) A slug here must exist in the registry (tests/services-availability.test.tsx proves it).
 */
export const AVAILABLE_NOW_REGISTRY_SLUGS: readonly string[] = [
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
 * Every catalog service that has a code executor in the registry, mapped by hand from its registry slug. A service is «متاح الآن» when ANY entry that
 * maps to it has its id in AVAILABLE_NOW_REGISTRY_SLUGS. Entries not in that list are services with an executor that was NOT proven live.
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

const AVAILABLE_KEYS: ReadonlySet<string> = new Set(
  REGISTRY_SERVICE_MAP.filter((entry) => AVAILABLE_NOW_REGISTRY_SLUGS.includes(entry.id)).map((entry) => key(entry.platform, entry.nameAr)),
);
const EXECUTOR_KEYS: ReadonlySet<string> = new Set(REGISTRY_SERVICE_MAP.map((entry) => key(entry.platform, entry.nameAr)));

export function serviceStatus(platformSlug: string, nameAr: string): ServiceStatus {
  return AVAILABLE_KEYS.has(key(platformSlug, nameAr)) ? "available" : "soon";
}

export const isAvailableNow = (platformSlug: string, nameAr: string): boolean => serviceStatus(platformSlug, nameAr) === "available";

/** True when a code executor exists for the service (proven live or not). Internal: used by the future-services document only. */
export const hasCodeExecutor = (platformSlug: string, nameAr: string): boolean => EXECUTOR_KEYS.has(key(platformSlug, nameAr));

/** Services of a platform that are «متاح الآن». */
export const platformAvailableCount = (platform: CatalogPlatform): number => platform.services.filter((service) => isAvailableNow(platform.slug, service.nameAr)).length;

export interface StatusCounts { available: number; soon: number; total: number }

export function statusCounts(catalog: CatalogSector[]): StatusCounts {
  let available = 0;
  let total = 0;
  for (const sector of catalog) for (const platform of sector.platforms) {
    total += platform.services.length;
    available += platformAvailableCount(platform);
  }
  return { available, soon: total - available, total };
}

/** Platforms with at least one «متاح الآن» service first; the catalog's own order otherwise (stable). */
export function platformsAvailableFirst<T extends CatalogPlatform>(platforms: readonly T[]): T[] {
  return [...platforms]
    .map((platform, index) => ({ platform, index, first: platformAvailableCount(platform) > 0 ? 0 : 1 }))
    .sort((a, b) => a.first - b.first || a.index - b.index)
    .map((entry) => entry.platform);
}
