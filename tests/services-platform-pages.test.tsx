import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import PlatformServicesPage, { dynamicParams, dynamic, generateMetadata, generateStaticParams } from "../src/app/services/[platform]/page";
import ServicesCatalogPage from "../src/app/services/page";
import sitemap from "../src/app/sitemap";
import { CatalogBrowser } from "../src/components/services/CatalogBrowser";
import { SERVICES_CATALOG, catalogCounts } from "../src/lib/servicesCatalog";
import { SERVICES_PRIMARY_CTA_AR, isProven } from "../src/lib/servicesAvailability";
import { PLATFORM_ENTRIES, featuredServices, platformEntryBySlug, platformHref, remainingServices } from "../src/lib/servicesCatalogView";
import { servicesCountAr } from "../src/lib/servicesCatalogText";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");
const renderPlatform = async (slug: string) => renderToStaticMarkup(await PlatformServicesPage({ params: Promise.resolve({ platform: slug }) }));
const STATUS_TEXT = ["متاح الآن", "قريبًا", "قريباً", "ستُضاف تدريجيًا", "اطلبها الآن"];

describe("one static page per platform", () => {
  it("generates exactly one page per platform of the catalog, static, and no other path", async () => {
    expect(dynamic).toBe("force-static");
    expect(dynamicParams).toBe(false);
    const params = generateStaticParams().map((entry) => entry.platform);
    expect(params).toHaveLength(catalogCounts().platforms);
    expect(new Set(params).size).toBe(params.length);
    expect(params.sort()).toEqual(SERVICES_CATALOG.flatMap((sector) => sector.platforms.map((platform) => platform.slug)).sort());
    expect(readFileSync("src/app/services/[platform]/page.tsx", "utf8")).not.toMatch(/cookies\(|headers\(|searchParams|noStore|revalidate/);
    await expect(renderPlatform("no-such-platform")).rejects.toThrow();
  });

  it("every platform page shows every one of its services once, as its name plus its sentence, and nothing about status or price", async () => {
    for (const { platform } of PLATFORM_ENTRIES) {
      const html = await renderPlatform(platform.slug);
      const text = textOf(html);
      expect(text, platform.slug).toContain(platform.nameAr);
      expect(text, platform.slug).toContain(servicesCountAr(platform.services.length));
      for (const service of platform.services) {
        expect(text.split(service.explainAr).length - 1, `${platform.slug}: ${service.explainAr}`).toBe(1);
        expect(text, `${platform.slug}: ${service.nameAr}`).toContain(service.nameAr);
      }
      for (const word of STATUS_TEXT) expect(text, `${platform.slug} ${word}`).not.toContain(word);
      expect(text, platform.slug).not.toMatch(/[A-Za-z]/);
      expect(text, platform.slug).not.toMatch(/\p{Extended_Pictographic}/u);
      // our own prices are never shown: the words are checked outside the services' own texts (a market-data service may be about the price of a product)
      const chrome = platform.services.reduce((rest, service) => rest.split(service.nameAr).join(" ").split(service.explainAr).join(" "), text);
      expect(chrome, platform.slug).not.toMatch(/نقطة|نقاط|ج\.م|جنيه|دولار|السعر/);
      expect(html.match(PROVIDER_NAME_PATTERN), platform.slug).toBeNull();
      expect(html, platform.slug).not.toMatch(/treg|tikhub|scrapecreators|icypeas|apify|serpapi|openai|anthropic/i);
    }
  });

  it("one primary call to action at the top and one at the bottom, none inside a service, and a way back to the catalog", async () => {
    const html = await renderPlatform("tiktok");
    const links = html.match(/<a [^>]*href="\/register"[^>]*>[^<]*<\/a>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toContain(SERVICES_PRIMARY_CTA_AR);
    expect(html.indexOf(links[0]!)).toBeLessThan(html.indexOf('data-testid="featured-services"'));
    expect(html.indexOf(links[1]!)).toBeGreaterThan(html.indexOf('data-testid="platform-bottom-cta"') - 1);
    for (const li of html.split("<li").slice(1).map((chunk) => chunk.split("</li>")[0]!)) expect(li).not.toMatch(/<a |href=/);
    expect(html).toContain('href="/services"');
  });

  it("the featured cards are the first six (the internal proven list orders them, nothing about it is shown), and the rest follow in the catalog's order", () => {
    for (const { platform } of PLATFORM_ENTRIES) {
      const featured = featuredServices(platform, 6);
      const rest = remainingServices(platform, featured);
      expect(featured.length + rest.length).toBe(platform.services.length);
      expect(featured.length).toBe(Math.min(6, platform.services.length));
      const flags = featured.map((service) => isProven(platform.slug, service.nameAr));
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
      expect(new Set([...featured, ...rest].map((service) => service.slug)).size).toBe(platform.services.length);
    }
    const tiktok = platformEntryBySlug("tiktok")!.platform;
    expect(isProven("tiktok", featuredServices(tiktok, 6)[0]!.nameAr)).toBe(true);
  });

  it("metadata carries the platform's Arabic name and description", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ platform: "tiktok" }) });
    const tiktok = platformEntryBySlug("tiktok")!.platform;
    expect(meta).toEqual({ title: `${tiktok.nameAr} — خدماتنا`, description: tiktok.descAr });
  });

  it("the sitemap lists every platform page, and the middleware already treats /services/ as public", () => {
    const urls = sitemap().map((entry) => entry.url);
    for (const { platform } of PLATFORM_ENTRIES) expect(urls.some((url) => url.endsWith(platformHref(platform.slug)))).toBe(true);
    expect(readFileSync("src/lib/publicPaths.ts", "utf8")).toContain('"/services/"');
  });
});

describe("the catalog page: platform cards", () => {
  const browser = renderToStaticMarkup(createElement(CatalogBrowser));

  it("one card per platform: name, description, number of services, and a link to its page; no other text", () => {
    const cards = browser.split("<a ").slice(1).filter((chunk) => /href="\/services\/[a-z0-9-]+"/.test(chunk)).map((chunk) => chunk.split("</a>")[0]!);
    expect(cards).toHaveLength(catalogCounts().platforms);
    for (const { platform } of PLATFORM_ENTRIES) {
      const card = cards.find((chunk) => chunk.includes(`href="${platformHref(platform.slug)}"`));
      expect(card, platform.slug).toBeDefined();
      const words = textOf(card!).replace(/^[^>]*>/, "").trim();
      expect(words, platform.slug).toBe(`${platform.nameAr} ${platform.descAr} ${servicesCountAr(platform.services.length)} ←`.replace(/\s+/g, " "));
    }
  });

  it("no letter tile: neither the cards nor a platform page carry a tile or a lone letter, and the sector chips carry the platform counts", async () => {
    expect(browser).not.toMatch(/aria-hidden="true"[^>]*>[؀-ۿ]<\/span>/);
    expect(await renderPlatform("tiktok")).not.toMatch(/aria-hidden="true"[^>]*>[؀-ۿ]<\/span>/);
    for (const file of ["src/components/services/CatalogBrowser.tsx", "src/app/services/[platform]/page.tsx", "src/lib/servicesCatalogView.ts"]) expect(readFileSync(file, "utf8"), file).not.toMatch(/PlatformTile|platformInitial|sectorHue/);
    const nav = browser.split('aria-label="القطاعات"')[1]!.split("</nav>")[0]!;
    expect(nav.match(/href="#s\d+"/g)).toHaveLength(SERVICES_CATALOG.length);
  });

  it("the catalog page itself links to no service, only platforms; the cards are the way in", () => {
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    const hrefs = (html.match(/href="\/services\/[a-z0-9-]+"/g) ?? []).map((href) => href.slice(6, -1));
    expect(new Set(hrefs).size).toBe(catalogCounts().platforms);
  });
});
