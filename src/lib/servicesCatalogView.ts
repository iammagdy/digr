import { SERVICES_CATALOG, type CatalogPlatform, type CatalogSector, type CatalogService } from "@/lib/servicesCatalog";
import { isProven } from "@/lib/servicesAvailability";

/** Hand-written helpers over the generated catalog, shared by the catalog page and the platform pages. Nothing here is shown as a status. */

export interface PlatformEntry { platform: CatalogPlatform; sector: CatalogSector }

export const PLATFORM_ENTRIES: PlatformEntry[] = SERVICES_CATALOG.flatMap((sector) => sector.platforms.map((platform) => ({ platform, sector })));

export const platformEntryBySlug = (slug: string): PlatformEntry | undefined => PLATFORM_ENTRIES.find((entry) => entry.platform.slug === slug);

/** The path of a platform's own page. The slug is only part of the address, never shown as text. */
export const platformHref = (slug: string): string => `/services/${slug}`;

/** The letter on a platform's tile: its first Arabic letter, without the article. */
export function platformInitial(nameAr: string): string {
  const bare = nameAr.trim().replace(/^ال(?=\S{2})/u, "");
  return Array.from(bare)[0] ?? "؟";
}

/** A fixed hue per sector (the tiles of one sector share a colour). */
export const sectorHue = (sectorId: string): number => (Number(sectorId.replace(/\D/g, "")) * 47 + 160) % 360;

/** The first services of a platform, ordered by the internal proven list (never shown) and then by the catalog's own order. */
export function featuredServices(platform: CatalogPlatform, count: number): CatalogService[] {
  return platform.services
    .map((service, index) => ({ service, index, proven: isProven(platform.slug, service.nameAr) }))
    .sort((a, b) => Number(b.proven) - Number(a.proven) || a.index - b.index)
    .slice(0, count)
    .map((entry) => entry.service);
}

/** The services after the featured ones, in the catalog's order. */
export function remainingServices(platform: CatalogPlatform, featured: CatalogService[]): CatalogService[] {
  const taken = new Set(featured.map((service) => service.slug));
  return platform.services.filter((service) => !taken.has(service.slug));
}

/** The decision-makers services shown as cards at the top of the catalog page; the rest of the core list sits behind «عرض الكل». Every name must exist in the core list (a test checks). */
export const FEATURED_CORE_NAMES: readonly string[] = [
  "البحث عن أشخاص بالدور أو الشركة أو الموقع",
  "ترتيب صناع القرار في شركة",
  "البريد المهني لشخص من الاسم أو نطاق الشركة أو الملف",
  "رقم هاتف العمل لشخص",
  "بيانات التواصل المهنية لشخص",
  "التحقق من صحة بريد إلكتروني وقابليته للتوصيل",
];
