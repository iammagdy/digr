import type { MetadataRoute } from "next";
import { SITE_URL } from "../lib/site";
import { SEGMENTS } from "../lib/segments";
import { PLATFORM_ENTRIES, platformHref } from "../lib/servicesCatalogView";

/** Public pages only; the app and admin areas are behind login. */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/services`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...PLATFORM_ENTRIES.map(({ platform }) => ({ url: `${SITE_URL}${platformHref(platform.slug)}`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.5 })),
    { url: `${SITE_URL}/pricing`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/calculator`, lastModified: now, changeFrequency: "monthly", priority: 0.6 },
    ...SEGMENTS.map((segment) => ({ url: `${SITE_URL}/for/${segment.slug}`, lastModified: now, changeFrequency: "monthly" as const, priority: 0.6 })),
    { url: `${SITE_URL}/register`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/login`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/contact`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/legal/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/legal/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
