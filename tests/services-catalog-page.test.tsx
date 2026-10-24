import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ServicesCatalogPage from "../src/app/services/page";
import { CatalogBrowser } from "../src/components/services/CatalogBrowser";
import { SERVICES_CATALOG, SERVICE_STATUS_LINE_AR, catalogCounts, coreServices } from "../src/lib/servicesCatalog";
import { SERVICE_ORDER_CTA_AR, SERVICE_SOON_LINE_AR, SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR } from "../src/lib/servicesAvailability";
import { normalizeArabicSearch, platformsCountAr, sectorsCountAr, servicesCountAr } from "../src/lib/servicesCatalogText";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";

type Row = { idx: number; sector: string; platform: string; key: string; en: string; cls: string; group: string; nameAr: string };
const ROWS: Row[] = JSON.parse(readFileSync("scripts/catalog/classification.json", "utf8"));

/** Provider, endpoint and model-vendor words that must never reach a customer (Latin and Arabic spellings). */
const BANNED = [
  PROVIDER_NAME_PATTERN, /treg|tikhub|scrapecreators|icypeas|apify|serpapi|anyapi|crawl4ai|firecrawl|context\.dev|supabase|vercel|resend/i,
  /openai|anthropic|claude|haiku|sonnet|opus|gpt|gemini|veo|sora|kling|hailuo|seedance|wan\b|flux|lyria|fish ?audio|nano banana|midjourney|elevenlabs|runway/i,
  /usd|endpoint|capability|\bapi\b|json|sha-?256|containers\.|\.lookup/i,
  /تريج|تيك ?هب|أنثروبيك|كلود|هايكو|جيميني|سيدانس|هايلو|كلينج|فلوكس|لايريا|ميدجورني|إيليفن|أوبن ?إيه/,
];
const EMOJI = /\p{Extended_Pictographic}/u;
const MARKDOWN = /[*_`~#]|\]\(|\[\w/;
const LATIN = /[A-Za-z]/;
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");

const everyText = () => SERVICES_CATALOG.flatMap((sector) => [sector.nameAr, sector.descAr, ...sector.platforms.flatMap((platform) => [platform.nameAr, platform.descAr, ...platform.services.flatMap((service) => [service.nameAr, service.group])])]);

describe("/services: the full catalog, from one data module", () => {
  it("no English, no emoji, no markdown symbol, no banned word in any text of the data", () => {
    const texts = everyText();
    expect(texts.length).toBeGreaterThan(500);
    for (const text of texts) {
      expect(text, text).not.toMatch(LATIN);
      expect(text, text).not.toMatch(EMOJI);
      expect(text, text).not.toMatch(MARKDOWN);
      for (const pattern of BANNED) expect(text, text).not.toMatch(pattern);
    }
  });

  it("the rendered page and its search box carry no English and no banned word", () => {
    const page = textOf(renderToStaticMarkup(createElement(ServicesCatalogPage)));
    expect(page).not.toMatch(LATIN);
    expect(page).not.toMatch(EMOJI);
    for (const pattern of BANNED) expect(page).not.toMatch(pattern);
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(html.match(PROVIDER_NAME_PATTERN)).toBeNull();
  });

  it("every sector and platform has an Arabic name and a one-line Arabic description; slugs are opaque and unique", () => {
    const slugs = new Set<string>();
    for (const sector of SERVICES_CATALOG) {
      expect(sector.nameAr).toMatch(/[؀-ۿ]/u);
      expect(sector.descAr).toMatch(/[؀-ۿ]/u);
      expect(sector.platforms.length).toBeGreaterThan(0);
      for (const platform of sector.platforms) {
        expect(platform.nameAr.trim(), platform.slug).not.toBe("");
        expect(platform.nameAr, platform.slug).toMatch(/[؀-ۿ]/u);
        expect(platform.descAr, platform.slug).toMatch(/[؀-ۿ]/u);
        expect(platform.descAr, platform.slug).not.toMatch(/\n/);
        expect(platform.services.length, platform.slug).toBeGreaterThan(0);
        const names = new Set<string>();
        for (const service of platform.services) {
          expect(service.slug, service.nameAr).toMatch(/^[0-9a-f]{7}$/);
          expect(slugs.has(service.slug), service.slug).toBe(false);
          slugs.add(service.slug);
          expect(names.has(service.nameAr), `${platform.slug}: ${service.nameAr}`).toBe(false); // one line per distinct name inside a platform
          names.add(service.nameAr);
        }
      }
    }
  });

  it("every count on the page is computed from the data (and equals the classification file)", () => {
    const counts = catalogCounts();
    const included = ROWS.filter((row) => row.cls === "read" || row.cls === "core");
    const merged = new Set(included.map((row) => `${row.platform}|${row.nameAr}`));
    expect(counts.services).toBe(merged.size);
    expect(counts.platforms).toBe(new Set(included.map((row) => row.platform)).size);
    expect(counts.sectors).toBe(new Set(included.map((row) => row.sector)).size);
    expect(counts.platforms).toBe(SERVICES_CATALOG.reduce((sum, sector) => sum + sector.platforms.length, 0));
    expect(counts.services).toBe(SERVICES_CATALOG.reduce((sum, sector) => sum + sector.platforms.reduce((inner, platform) => inner + platform.services.length, 0), 0));
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    const line = /data-testid="services-counts"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
    expect(line).toBe(`تجد هنا ${sectorsCountAr(counts.sectors)} و${platformsCountAr(counts.platforms)} و${servicesCountAr(counts.services)}.`);
    // no hand-typed number of the source's header («٢٬٦٠٠») anywhere
    expect(JSON.stringify(everyText())).not.toMatch(/٢٬?٦٠٠|2,?600|١٬?٣٠٠/);
    expect(readFileSync("src/app/services/page.tsx", "utf8")).not.toMatch(/2,?600|2600/);
  });

  it("write, own-account, private and helper lines are absent; core B2B lines are present", () => {
    const shownNames = new Set(SERVICES_CATALOG.flatMap((sector) => sector.platforms.flatMap((platform) => platform.services.map((service) => `${platform.slug}|${service.nameAr}`))));
    for (const cls of ["write", "own", "private", "helper"]) {
      const rows = ROWS.filter((row) => row.cls === cls);
      expect(rows.length, cls).toBeGreaterThan(0);
      for (const row of rows) {
        const sharesNameWithShown = ROWS.some((other) => other.platform === row.platform && other.nameAr === row.nameAr && (other.cls === "read" || other.cls === "core"));
        if (!sharesNameWithShown) expect(shownNames.has(`${row.platform}|${row.nameAr}`), `${cls}: ${row.platform} ${row.en}`).toBe(false);
      }
    }
    // the platforms that are only the customer's own account have no card at all
    const platformSlugs = new Set(SERVICES_CATALOG.flatMap((sector) => sector.platforms.map((platform) => platform.slug)));
    for (const slug of ["google-analytics", "search-console", "google-tag-manager", "google-ads", "slack"]) expect(platformSlugs.has(slug), slug).toBe(false);
    // personal-contact and identifier lines the owner named
    const privateEn = ROWS.filter((row) => row.cls === "private").map((row) => row.en).join("\n");
    for (const needle of ["personal email", "hashed email", "advertising", "DISC", "postal address", "Where on the web an email address was seen", "social profiles"]) expect(privateEn).toContain(needle);

    const core = coreServices();
    expect(core.length).toBeGreaterThan(20);
    const coreNames = core.map((service) => service.nameAr).join("\n");
    for (const needle of ["بيانات التواصل المهنية", "رقم هاتف العمل لشخص", "البريد المهني لشخص", "البحث الجماعي عن البريد المهني", "ترتيب صناع القرار في شركة", "عناوين البريد الوظيفية لشركة", "صيغة البريد المهني لشركة", "موظفو شركة"]) expect(coreNames, needle).toContain(needle);
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(html).toContain('data-testid="core-b2b"');
    expect(html).toContain("صناع القرار وبيانات التواصل المهنية");
    for (const service of core) expect(html).toContain(service.nameAr);
  });

  it("one status line from one constant, and every listed service carries one of the two status constants", () => {
    expect(SERVICE_STATUS_LINE_AR).toBe("نعرض لك الخطة والسعر قبل أي خصم، ولا تدفع إلا على ما يُسلَّم فعلًا");
    expect([SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR, SERVICE_SOON_LINE_AR, SERVICE_ORDER_CTA_AR]).toEqual(["متاح الآن", "قريبًا", "ستُضاف تدريجيًا", "ابدأ طلبك"]);
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(html.split(SERVICE_STATUS_LINE_AR).length - 1).toBe(1);
    for (const forbidden of ["قريباً", "قيد التقييم", "قيد الدراسة", "سيتوفر"]) {
      expect(html).not.toContain(forbidden);
      expect(JSON.stringify(everyText())).not.toContain(forbidden);
    }
    // the page types no availability or delivery rate: the only percent sign or «٪» would be a number typed by hand
    expect(textOf(html)).not.toMatch(/[٪%]/);
    // the label text exists only through the constant
    const pageSource = readFileSync("src/app/services/page.tsx", "utf8") + readFileSync("src/components/services/CatalogBrowser.tsx", "utf8");
    expect(pageSource).not.toContain("اطلبها الآن");
    expect(pageSource).not.toContain("نعرض لك الخطة");
    for (const literal of [SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR, SERVICE_SOON_LINE_AR, SERVICE_ORDER_CTA_AR]) expect(pageSource, literal).not.toContain(literal);
  });

  it("the page is static and fast: force-static, no request data, and the platforms are collapsed (no service of a platform is in the first HTML)", () => {
    const source = readFileSync("src/app/services/page.tsx", "utf8");
    expect(source).toContain('export const dynamic = "force-static"');
    expect(source).not.toMatch(/cookies\(|headers\(|searchParams|noStore|revalidate/);
    const browser = renderToStaticMarkup(createElement(CatalogBrowser));
    expect(browser.match(/aria-expanded="false"/g)?.length).toBe(catalogCounts().platforms);
    expect(browser).not.toContain("<li");
    // the whole page stays small: far fewer elements than services
    const elements = renderToStaticMarkup(createElement(ServicesCatalogPage)).match(/<[a-z][^>]*>/g)?.length ?? 0;
    expect(elements).toBeLessThan(catalogCounts().services + 400);
  });

  it("the header links to «خدماتنا», the sitemap lists the page, and /pricing and /calculator are untouched", () => {
    const header = readFileSync("src/components/landing/GlassHeader.tsx", "utf8");
    expect(header).toContain('href="/services"');
    expect(header).toContain("خدماتنا");
    expect(header).toContain('href="/pricing"');
    expect(readFileSync("src/app/sitemap.ts", "utf8")).toContain("/services");
  });

  it("Arabic search: marks and spellings do not matter and every word of the query must be found", () => {
    expect(normalizeArabicSearch("  الْبَرِيدُ   المهنيّ ")).toBe("البريد المهني");
    expect(normalizeArabicSearch("إنستغرام")).toBe(normalizeArabicSearch("انستغرام"));
    expect(normalizeArabicSearch("مكتبة ٢")).toBe("مكتبه 2");
    const text = normalizeArabicSearch("البريد المهني لشخص");
    expect(["بريد", "مهني"].every((word) => text.includes(normalizeArabicSearch(word)))).toBe(true);
    expect(text.includes("هاتف")).toBe(false);
  });
});
