import {
  getLiveServicesCatalog,
  type CatalogPlatform,
  type CatalogSector,
  type CatalogService,
  type LiveServicesCatalog,
} from "./liveServicesCatalog";
import { isProven } from "./servicesAvailability";
import { loadTregCatalog } from "./treg/catalog";
import { toArabicDigits, formatAr } from "./arabicDigits";

export type { CatalogPlatform, CatalogSector, CatalogService };

export interface PlatformEntry {
  platform: CatalogPlatform;
  sector: CatalogSector;
}

export function getPlatformEntries(): PlatformEntry[] {
  const catalog = getLiveServicesCatalog();
  return catalog.sectors.flatMap((sector) =>
    sector.platforms.map((platform) => ({ platform, sector })),
  );
}

export function getPlatformEntryBySlug(slug: string): PlatformEntry | undefined {
  return getPlatformEntries().find((entry) => entry.platform.slug === slug);
}

/** Legacy array export kept for backwards-compatibility. Evaluated lazily to always reflect the live catalog. */
export const PLATFORM_ENTRIES: PlatformEntry[] = getPlatformEntries();

export const platformEntryBySlug = (slug: string): PlatformEntry | undefined =>
  getPlatformEntryBySlug(slug);

/** The path of a platform's own page. The slug is only part of the address, never shown as text. */
export const platformHref = (slug: string): string => `/services/${slug}`;

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

// ============================================================================
// Ph3 Data Contract Mapping (FX-CAT-Ph3-spec.md:39-65)
// ============================================================================

/** الواجهة البرمجية لعنصر القدرة/الخدمة الفردية */
export interface SellableCapabilityItem {
  id: string; // المعرف التقني الداخلي للقدرة (مثال: 'companies.discover')
  titleAr: string; // عنوان الخدمة بالعربية
  summaryAr: string; // شرح موجز في سطر واحد لما تنجزه الخدمة للعميل
  outputColumnsAr: string[]; // أسماء أعمدة ملف النتائج بكلمات واضحة للعميل
  sampleQueryAr: string; // نص الطلب الجاهز الذي يُملأ تلقائياً في المحادثة
  badgeAr?: string; // شارة اختيارية
  pricingUnitLabelAr?: string; // وحدة الاحتساب
}

/** الواجهة البرمجية لمجموعة القدرات المترابطة */
export interface SellableCapabilityGroup {
  id: string; // معرف المجموعة
  nameAr: string; // اسم المجموعة بالعربية
  descAr: string; // نبذة تعريفية قصيرة عن المجموعة
  iconName: "building" | "users" | "message" | "map-pin" | "globe" | "apps"; // اسم الأيقونة المعتمدة
  items: SellableCapabilityItem[]; // قائمة الخدمات والقدرات التابعة للمجموعة
}

/** الكائن الشامل الذي تتلقاه صفحة الخدمات */
export interface SellableCatalogViewData {
  groups: SellableCapabilityGroup[];
  totalCapabilitiesCount: number;
  lastUpdatedAr: string;
}

const SECTOR_ICON_MAP: Record<string, "building" | "users" | "message" | "map-pin" | "globe" | "apps"> = {
  s1: "globe", // SEO/AEO
  s2: "message", // Social
  s3: "message", // Advertising
  s4: "users", // Enrichment
  s5: "building", // E-commerce
  s6: "apps", // Reviews & Apps
  s7: "message", // Community
  s8: "apps", // AI generation
  s9: "apps", // Developer
  s10: "globe", // Market data
  s11: "globe", // Research & public data
};

export function getSellableCatalogView(catalog: LiveServicesCatalog = getLiveServicesCatalog()): SellableCatalogViewData {
  const groups: SellableCapabilityGroup[] = catalog.sectors.map((sector) => {
    const items: SellableCapabilityItem[] = sector.platforms.flatMap((platform) =>
      platform.services.map((service) => ({
        id: service.slug,
        titleAr: service.nameAr,
        summaryAr: service.explainAr,
        outputColumnsAr: [],
        sampleQueryAr: `أريد ${service.nameAr}`,
        badgeAr: undefined,
        pricingUnitLabelAr: service.startingUnitPoints ? `${formatAr(service.startingUnitPoints)} نقطة` : undefined,
      })),
    );

    return {
      id: sector.id,
      nameAr: sector.nameAr,
      descAr: sector.descAr,
      iconName: SECTOR_ICON_MAP[sector.id] ?? "globe",
      items,
    };
  }).filter((group) => group.items.length > 0);

  const treg = loadTregCatalog();
  const dateMatch = treg.source.match(/\d{4}-\d{2}-\d{2}/);
  const lastUpdatedAr = dateMatch ? toArabicDigits(dateMatch[0]) : "";

  return {
    groups,
    totalCapabilitiesCount: catalog.counts.services,
    lastUpdatedAr,
  };
}
