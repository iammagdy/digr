import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ServicesCatalogPage from "../src/app/services/page";
import { CatalogBrowser } from "../src/components/services/CatalogBrowser";
import { buildPlatformGuideServices } from "../src/functions/shared/platformGuide";
import { cleanArText, getPublicCalculatorOptions } from "../src/lib/calculatorPricing";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { SERVICES_CATALOG, catalogCounts, coreServices } from "../src/lib/servicesCatalog";
import {
  AVAILABLE_NOW_REGISTRY_SLUGS, REGISTRY_SERVICE_MAP, SERVICE_ORDER_CTA_AR, SERVICE_SOON_LINE_AR, SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR,
  isAvailableNow, platformAvailableCount, platformsAvailableFirst, serviceStatus, statusCounts,
} from "../src/lib/servicesAvailability";
import { formatAr } from "../src/lib/arabicDigits";

const OWNER_LIST = ["icypeas-companies-search", "social-x-posts", "social-facebook-keyword-comments", "social-facebook-posts", "social-facebook-comments", "social-tiktok-comments"];
const allServices = SERVICES_CATALOG.flatMap((sector) => sector.platforms.flatMap((platform) => platform.services.map((service) => ({ platform: platform.slug, ...service }))));
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("service status: two values from one constant", () => {
  it("starts with exactly the owner's list (people search left out until it is proven live again), and every one of its slugs is a real registry slug", () => {
    expect([...AVAILABLE_NOW_REGISTRY_SLUGS].sort()).toEqual([...OWNER_LIST].sort());
    const registry = new Set(APPROVED_CAPABILITY_CATALOG.map((capability) => capability.slug));
    for (const slug of AVAILABLE_NOW_REGISTRY_SLUGS) expect(registry.has(slug), slug).toBe(true);
    // every other mapped id is a registry slug too, except the two named exceptions (a field of a registry service, and the contact chain that exists only behind its flag)
    for (const entry of REGISTRY_SERVICE_MAP) if (!entry.id.includes(":") && entry.id !== "mp-business-contacts") expect(registry.has(entry.id), entry.id).toBe(true);
  });

  it("every registry mapping names a service that exists in the catalog", () => {
    for (const entry of REGISTRY_SERVICE_MAP) expect(allServices.some((service) => service.platform === entry.platform && service.nameAr === entry.nameAr), entry.id).toBe(true);
  });

  it("each available slug maps to a catalog service, and the available services are exactly those", () => {
    const expected = new Set(REGISTRY_SERVICE_MAP.filter((entry) => AVAILABLE_NOW_REGISTRY_SLUGS.includes(entry.id)).map((entry) => `${entry.platform}|${entry.nameAr}`));
    for (const slug of AVAILABLE_NOW_REGISTRY_SLUGS) expect(REGISTRY_SERVICE_MAP.some((entry) => entry.id === slug), slug).toBe(true);
    const actual = new Set(allServices.filter((service) => isAvailableNow(service.platform, service.nameAr)).map((service) => `${service.platform}|${service.nameAr}`));
    expect(actual).toEqual(expected);
    expect(actual.size).toBe(6);
  });

  it("services that have an executor but were not proven live stay «قريبًا»", () => {
    for (const [platform, nameAr] of [["instagram", "بيانات ملف مستخدم عام"], ["instagram", "التعليقات على منشور"], ["youtube", "التعليقات على فيديو"], ["youtube", "البحث عن فيديوهات بكلمة مفتاحية"], ["reddit", "التعليقات على منشور"], ["linkedin", "ملف عضو"], ["tiktok", "بيانات ملف مستخدم عام"], ["tiktok", "البحث عن فيديوهات بكلمة مفتاحية"], ["people", "البريد المهني لشخص من الاسم أو نطاق الشركة أو الملف"], ["people", "رقم هاتف العمل لشخص"], ["people", "البحث عن أشخاص بالدور أو الشركة أو الموقع"]]) {
      expect(serviceStatus(platform, nameAr), `${platform} ${nameAr}`).toBe("soon");
    }
  });

  it("flipping a service is one line: adding its registry slug makes it available (the status is derived, never stored per service)", () => {
    const source = readFileSync("src/lib/servicesAvailability.ts", "utf8");
    expect(source).toContain("export const AVAILABLE_NOW_REGISTRY_SLUGS");
    expect(readFileSync("src/lib/servicesCatalog.ts", "utf8")).not.toMatch(/\bstatus\b|"available"|"soon"/i);
    expect(readFileSync("scripts/catalog/classification.json", "utf8")).not.toMatch(/"status"/);
  });
});

describe("counts and ordering come from the data", () => {
  it("available + coming = every shown service, computed", () => {
    const counts = statusCounts(SERVICES_CATALOG);
    expect(counts.total).toBe(catalogCounts().services);
    expect(counts.available).toBe(allServices.filter((service) => isAvailableNow(service.platform, service.nameAr)).length);
    expect(counts.soon).toBe(counts.total - counts.available);
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(html).toContain(`${SERVICE_STATUS_AVAILABLE_AR}: ${formatAr(counts.available)}، ${SERVICE_STATUS_SOON_AR}: ${formatAr(counts.soon)}`);
  });

  it("a platform card says how many of its services are available now; a platform with none says «قريبًا»", () => {
    const html = renderToStaticMarkup(createElement(CatalogBrowser));
    const withAvailable = SERVICES_CATALOG.flatMap((sector) => sector.platforms).filter((platform) => platformAvailableCount(platform) > 0);
    expect(withAvailable.length).toBeGreaterThan(0);
    expect(html.match(/data-testid="platform-available"/g)?.length).toBe(withAvailable.length);
    for (const platform of withAvailable) expect(html).toContain(`${SERVICE_STATUS_AVAILABLE_AR}: ${formatAr(platformAvailableCount(platform))} من ${formatAr(platform.services.length)}`);
    expect(html.match(/data-testid="platform-soon"/g)?.length).toBe(catalogCounts().platforms - withAvailable.length);
  });

  it("inside a sector, platforms with at least one available service come first; the catalog's own order otherwise", () => {
    for (const sector of SERVICES_CATALOG) {
      const ordered = platformsAvailableFirst(sector.platforms);
      expect(ordered).toHaveLength(sector.platforms.length);
      const flags = ordered.map((platform) => platformAvailableCount(platform) > 0);
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
      const rest = ordered.filter((platform) => platformAvailableCount(platform) === 0);
      expect(rest.map((platform) => platform.slug)).toEqual(sector.platforms.filter((platform) => platformAvailableCount(platform) === 0).map((platform) => platform.slug));
    }
    // the rendered browser shows them in that order: the first platform card of the social sector is one with an available service
    const html = renderToStaticMarkup(createElement(CatalogBrowser));
    const firstSocial = platformsAvailableFirst(SERVICES_CATALOG.find((sector) => sector.platforms.some((platform) => platform.slug === "tiktok"))!.platforms)[0];
    expect(platformAvailableCount(firstSocial)).toBeGreaterThan(0);
    expect(html.indexOf(firstSocial.nameAr)).toBeLessThan(html.indexOf(SERVICES_CATALOG.find((sector) => sector.platforms.some((platform) => platform.slug === "tiktok"))!.platforms.find((platform) => platformAvailableCount(platform) === 0)!.nameAr));
  });
});

describe("what a service shows", () => {
  it("collapsed by default, as before", () => {
    const html = renderToStaticMarkup(createElement(CatalogBrowser));
    expect(html.match(/aria-expanded="false"/g)?.length).toBe(catalogCounts().platforms);
    expect(html).not.toContain("<li");
  });

  it("the page: an available service has the call to action, a coming one has the chip and the one line and nothing else (no CTA, no price)", () => {
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    const items = html.split('<li data-status="').slice(1).map((chunk) => chunk.split("</li>")[0]);
    const available = items.filter((item) => item.startsWith("available"));
    const soon = items.filter((item) => item.startsWith("soon"));
    // the list on the page is the core list: its available items are exactly the core services that are available now (none while people search is «قريبًا»)
    expect(available.length).toBe(coreServices().filter((service) => isAvailableNow(service.platformSlug, service.nameAr)).length);
    expect(soon.length).toBe(coreServices().length - available.length);
    expect(readFileSync("src/components/services/CatalogBrowser.tsx", "utf8")).toContain("SERVICE_ORDER_CTA_AR");
    for (const item of available) { expect(item).toContain(SERVICE_STATUS_AVAILABLE_AR); expect(item).toContain(SERVICE_ORDER_CTA_AR); expect(item).toContain('href="/register"'); }
    for (const item of soon) {
      const text = textOf(item);
      const name = /<span>([^<]*)<\/span>/.exec(item)?.[1] ?? "";
      expect(name).not.toBe("");
      // after the service's own name there is the chip and the one line, nothing else
      expect(text.replace(name, "").replace(/^\s*soon"[^>]*>/, "").replace(/\s+/g, " ").trim()).toBe(`${SERVICE_STATUS_SOON_AR} ${SERVICE_SOON_LINE_AR}`);
      expect(item).not.toContain("<a");
      expect(item).not.toContain(SERVICE_ORDER_CTA_AR);
      expect(item).not.toContain('href=');
      expect(item).not.toContain("السعر");
      expect(text).not.toContain(SERVICE_STATUS_AVAILABLE_AR);
    }
    // the core list holds the available ones first
    const firstSoon = items.findIndex((item) => item.startsWith("soon"));
    expect(items.slice(firstSoon).some((item) => item.startsWith("available"))).toBe(false);
  });

  it("the priced cards of the page are only for available services (a coming service shows no price)", () => {
    const source = readFileSync("src/app/services/page.tsx", "utf8");
    expect(source).toContain("AVAILABLE_NOW_REGISTRY_SLUGS.includes(service.slug)");
    const optionSlugs = new Set(getPublicCalculatorOptions().map((option) => option.slug));
    const all = buildPlatformGuideServices().filter((service) => optionSlugs.has(service.slug));
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    const priced = html.split("<article").slice(1).filter((chunk) => chunk.includes("السعر:"));
    const shown = all.filter((service) => AVAILABLE_NOW_REGISTRY_SLUGS.includes(service.slug));
    const hidden = all.filter((service) => !AVAILABLE_NOW_REGISTRY_SLUGS.includes(service.slug));
    expect(priced.length).toBe(shown.length);
    for (const service of shown) expect(html).toContain(cleanArText(service.nameAr));
    for (const service of hidden) expect(priced.some((chunk) => chunk.includes(`>${cleanArText(service.nameAr)}<`)), service.slug).toBe(false);
  });

  it("the status constants are the only place the words exist: the page and the browser import them", () => {
    for (const file of ["src/app/services/page.tsx", "src/components/services/CatalogBrowser.tsx", "src/lib/servicesCatalog.ts"]) {
      const source = readFileSync(file, "utf8");
      for (const literal of [SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR, SERVICE_SOON_LINE_AR]) expect(source, `${file}: ${literal}`).not.toContain(literal);
    }
    expect(readFileSync("src/app/services/page.tsx", "utf8")).toContain("SERVICE_STATUS_AVAILABLE_AR");
    expect(readFileSync("src/components/services/CatalogBrowser.tsx", "utf8")).toContain("SERVICE_SOON_LINE_AR");
  });

  it("no English, no emoji, no provider word in the rendered text of the page", () => {
    for (const html of [renderToStaticMarkup(createElement(ServicesCatalogPage))]) {
      const text = textOf(html);
      expect(text).not.toMatch(/[A-Za-z]/);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text).not.toMatch(/treg|tikhub|scrapecreators|icypeas|apify|serpapi|openai|anthropic/i);
    }
  });

  it("the page stays static and the header is untouched", () => {
    expect(readFileSync("src/app/services/page.tsx", "utf8")).toContain('export const dynamic = "force-static"');
    const header = readFileSync("src/components/landing/GlassHeader.tsx", "utf8");
    expect(header).toContain('href="/services"');
    expect(header).toContain("min-[520px]:flex min-[760px]:px-3.5");
  });
});

describe("docs/FUTURE_SERVICES.md (generated from the same data)", () => {
  const doc = readFileSync("docs/FUTURE_SERVICES.md", "utf8");
  const counts = statusCounts(SERVICES_CATALOG);

  it("its counts equal the data, and it carries the sections the owner asked for", () => {
    expect(doc).toContain(`| ${SERVICE_STATUS_AVAILABLE_AR} | ${counts.available} |`);
    expect(doc).toContain(`| ${SERVICE_STATUS_SOON_AR} | ${counts.soon} |`);
    expect(doc).toContain(`| total shown | ${counts.total} |`);
    expect(doc).toContain("## Prerequisites");
    for (const step of ["discovery", "entry persistence", "input mapping", "row reading", "unit counting", "price basis", "safety"]) expect(doc, step).toContain(step);
    expect(doc).toContain("## Proposed rollout order");
    expect(doc).toContain("Keyword-search services on text-bearing endpoints");
    expect(doc).toContain("One small live test per service BEFORE it is flipped");
    expect(doc).toContain("## ما يجب قياسه");
    expect(doc).toContain("cost per DELIVERED record");
    expect(doc).toContain("UNKNOWN");
  });

  it("it lists every «قريبًا» service once, by sector and platform, with its class, and none that is available now", () => {
    const soonEntries = doc.split("## «قريبًا» services by sector and platform")[1];
    expect(soonEntries).toBeDefined();
    const lines = soonEntries.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.length).toBeGreaterThanOrEqual(counts.soon);
    for (const line of lines) expect(line).toMatch(/\[(read|core)\]/);
    for (const sector of SERVICES_CATALOG) expect(soonEntries).toContain(`### ${sector.nameAr}`);
    // the seven services available now are not in the coming list
    const rows = JSON.parse(readFileSync("scripts/catalog/classification.json", "utf8")) as Array<{ platform: string; nameAr: string; en: string; cls: string }>;
    for (const row of rows.filter((entry) => (entry.cls === "read" || entry.cls === "core") && isAvailableNow(entry.platform, entry.nameAr))) {
      const block = soonEntries.split("#### ").find((chunk) => chunk.includes(`(${row.platform}) - `)) ?? "";
      expect(block.includes(`- ${row.en} [`), `${row.platform} ${row.en}`).toBe(false);
    }
  });
});
