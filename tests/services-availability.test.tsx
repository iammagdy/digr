import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ServicesCatalogPage from "../src/app/services/page";
import { CatalogBrowser } from "../src/components/services/CatalogBrowser";
import { buildPlatformGuideServices } from "../src/functions/shared/platformGuide";
import { cleanArText, computePublicCalculatorQuote, getPublicCalculatorOptions } from "../src/lib/calculatorPricing";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { unitPriceLabelAr } from "../src/lib/pointsFormat";
import { SERVICES_CATALOG, catalogCounts, coreServices } from "../src/lib/servicesCatalog";
import {
  PROVEN_REGISTRY_SLUGS, REGISTRY_SERVICE_MAP, SERVICES_PRIMARY_CTA_AR, DECISION_MAKERS_LINE_AR, isProven, platformProvenCount, platformsProvenFirst,
} from "../src/lib/servicesAvailability";

const OWNER_LIST = ["icypeas-companies-search", "social-x-posts", "social-facebook-keyword-comments", "social-facebook-posts", "social-facebook-comments", "social-tiktok-comments"];
const allServices = SERVICES_CATALOG.flatMap((sector) => sector.platforms.flatMap((platform) => platform.services.map((service) => ({ platform: platform.slug, ...service }))));
const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
/** Every status word, status line and per-service call to action that used to exist. None may be rendered or typed on the public surface any more. */
const STATUS_TEXT = ["متاح الآن", "قريبًا", "قريباً", "ستُضاف تدريجيًا", "اطلبها الآن", "قيد التقييم", "قيد الدراسة", "سيتوفر"];

describe("the internal proven list: it only orders the platforms, it is never shown", () => {
  it("is exactly the owner's list (people search left out until it is proven live again), and every slug is a real registry slug", () => {
    expect([...PROVEN_REGISTRY_SLUGS].sort()).toEqual([...OWNER_LIST].sort());
    const registry = new Set(APPROVED_CAPABILITY_CATALOG.map((capability) => capability.slug));
    for (const slug of PROVEN_REGISTRY_SLUGS) expect(registry.has(slug), slug).toBe(true);
    // every other mapped id is a registry slug too, except the two named exceptions (a field of a registry service, and the contact chain that exists only behind its flag)
    for (const entry of REGISTRY_SERVICE_MAP) if (!entry.id.includes(":") && entry.id !== "mp-business-contacts") expect(registry.has(entry.id), entry.id).toBe(true);
  });

  it("every registry mapping names a service that exists in the catalog, and the proven services are exactly the mapped proven slugs", () => {
    for (const entry of REGISTRY_SERVICE_MAP) expect(allServices.some((service) => service.platform === entry.platform && service.nameAr === entry.nameAr), entry.id).toBe(true);
    const expected = new Set(REGISTRY_SERVICE_MAP.filter((entry) => PROVEN_REGISTRY_SLUGS.includes(entry.id)).map((entry) => `${entry.platform}|${entry.nameAr}`));
    const actual = new Set(allServices.filter((service) => isProven(service.platform, service.nameAr)).map((service) => `${service.platform}|${service.nameAr}`));
    expect(actual).toEqual(expected);
    expect(actual.size).toBe(6);
  });

  it("services that have an executor but were not proven live are not on the proven list", () => {
    for (const [platform, nameAr] of [["instagram", "بيانات ملف مستخدم عام"], ["instagram", "التعليقات على منشور"], ["youtube", "التعليقات على فيديو"], ["youtube", "البحث عن فيديوهات بكلمة مفتاحية"], ["reddit", "التعليقات على منشور"], ["linkedin", "ملف عضو"], ["tiktok", "بيانات ملف مستخدم عام"], ["tiktok", "البحث عن فيديوهات بكلمة مفتاحية"], ["people", "البريد المهني لشخص من الاسم أو نطاق الشركة أو الملف"], ["people", "رقم هاتف العمل لشخص"], ["people", "البحث عن أشخاص بالدور أو الشركة أو الموقع"]]) {
      expect(isProven(platform, nameAr), `${platform} ${nameAr}`).toBe(false);
    }
    expect(PROVEN_REGISTRY_SLUGS).not.toContain("professional-people-search");
  });

  it("the catalog data and the classification file carry no status of any kind", () => {
    expect(readFileSync("src/lib/servicesCatalog.ts", "utf8")).not.toMatch(/\bstatus\??\s*:|"available"|"soon"|proven/i);
    expect(readFileSync("scripts/catalog/classification.json", "utf8")).not.toMatch(/"status"/);
  });

  it("inside a sector, platforms with at least one proven service come first; the catalog's own order otherwise", () => {
    for (const sector of SERVICES_CATALOG) {
      const ordered = platformsProvenFirst(sector.platforms);
      expect(ordered).toHaveLength(sector.platforms.length);
      const flags = ordered.map((platform) => platformProvenCount(platform) > 0);
      expect(flags).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
      const rest = ordered.filter((platform) => platformProvenCount(platform) === 0);
      expect(rest.map((platform) => platform.slug)).toEqual(sector.platforms.filter((platform) => platformProvenCount(platform) === 0).map((platform) => platform.slug));
    }
    // the rendered browser shows them in that order, and shows no sign of why
    const html = renderToStaticMarkup(createElement(CatalogBrowser));
    const social = SERVICES_CATALOG.find((sector) => sector.platforms.some((platform) => platform.slug === "tiktok"))!;
    const first = platformsProvenFirst(social.platforms)[0];
    expect(platformProvenCount(first)).toBeGreaterThan(0);
    expect(html.indexOf(first.nameAr)).toBeLessThan(html.indexOf(social.platforms.find((platform) => platformProvenCount(platform) === 0)!.nameAr));
  });
});

describe("the public page shows no status, no per-service call to action", () => {
  const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
  const text = textOf(html);

  it("no status text of any kind is rendered (page, browser, or the source of either), and no status marker attribute exists", () => {
    const browser = renderToStaticMarkup(createElement(CatalogBrowser));
    for (const word of STATUS_TEXT) {
      expect(text, word).not.toContain(word);
      expect(browser, word).not.toContain(word);
      for (const file of ["src/app/services/page.tsx", "src/components/services/CatalogBrowser.tsx", "src/lib/servicesCatalog.ts", "src/lib/servicesAvailability.ts"]) expect(readFileSync(file, "utf8"), `${file}: ${word}`).not.toContain(word);
    }
    expect(html).not.toMatch(/data-status=|platform-available|platform-soon|services-status-counts/);
    // the only count line is the one computed from the data: sectors, platforms, services
    expect(html.match(/data-testid="[a-z-]*counts"/g)).toEqual(['data-testid="services-counts"']);
  });

  it("one primary call to action «ابدأ طلبك», at the top and at the bottom, and none inside any service row", () => {
    expect(SERVICES_PRIMARY_CTA_AR).toBe("ابدأ طلبك");
    const links = html.match(/<a [^>]*href="\/register"[^>]*>[^<]*<\/a>/g) ?? [];
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toContain(SERVICES_PRIMARY_CTA_AR);
    expect(html.indexOf(links[0]!)).toBeLessThan(html.indexOf('data-testid="core-b2b"'));
    expect(html.indexOf(links[1]!)).toBeGreaterThan(html.lastIndexOf("</article>"));
    for (const li of html.split("<li").slice(1).map((chunk) => chunk.split("</li>")[0])) {
      expect(li).not.toContain("<a");
      expect(li).not.toContain("href=");
      expect(li).not.toContain(SERVICES_PRIMARY_CTA_AR);
    }
    expect(readFileSync("src/components/services/CatalogBrowser.tsx", "utf8")).not.toMatch(/SERVICES_PRIMARY_CTA_AR|\/register|next\/link/);
  });

  it("the core list shows every decision-makers / contact service with its explanation, and nothing else per row", () => {
    const core = coreServices();
    const items = html.split('<ul class="m-0 grid list-none').slice(1).map((chunk) => chunk.split("</ul>")[0])[0].split("<li").slice(1);
    expect(items).toHaveLength(core.length);
    core.forEach((service, index) => {
      const row = textOf(items[index]).replace(/^[^>]*>/, "").trim();
      expect(row, service.nameAr).toBe(`${service.nameAr} ${service.explainAr}`);
    });
  });

  it("counts equal the data, with nothing about status", () => {
    const counts = catalogCounts();
    expect(counts.services).toBe(allServices.length);
    expect(counts.platforms).toBe(SERVICES_CATALOG.reduce((sum, sector) => sum + sector.platforms.length, 0));
    expect(counts.sectors).toBe(SERVICES_CATALOG.length);
  });

  it("prices only through the shared pricing function, for the options that already have one; the page types no price of its own", () => {
    const source = readFileSync("src/app/services/page.tsx", "utf8");
    expect(source).toContain("computePublicCalculatorQuote");
    expect(source).toContain("getPublicCalculatorOptions");
    expect(source).not.toContain("PROVEN_REGISTRY_SLUGS");
    expect(source).not.toMatch(/\d+\s*(نقطة|ج\.م|جنيه)/);
    const optionSlugs = new Set(getPublicCalculatorOptions().map((option) => option.slug));
    const priced = buildPlatformGuideServices().filter((service) => optionSlugs.has(service.slug));
    const cards = html.split("<article").slice(1).filter((chunk) => chunk.includes("السعر:"));
    expect(cards.length).toBe(priced.length);
    for (const service of priced) {
      const card = cards.find((chunk) => chunk.includes(`>${cleanArText(service.nameAr)}<`));
      expect(card, service.slug).toBeDefined();
      const quote = computePublicCalculatorQuote(service.slug, 1, 1);
      if (quote && service.slug !== "professional-people-search") expect(card).toContain(unitPriceLabelAr(quote.unitPricePoints, getPublicCalculatorOptions().find((option) => option.slug === service.slug)?.unitLabelAr || "سجل"));
    }
    // a catalog service row never carries a price
    const browser = renderToStaticMarkup(createElement(CatalogBrowser));
    expect(browser).not.toContain("السعر");
  });

  it("no English, no emoji, no provider word in the rendered text of the page", () => {
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/treg|tikhub|scrapecreators|icypeas|apify|serpapi|openai|anthropic/i);
  });

  it("the page stays static and the header is untouched", () => {
    expect(readFileSync("src/app/services/page.tsx", "utf8")).toContain('export const dynamic = "force-static"');
    const header = readFileSync("src/components/landing/GlassHeader.tsx", "utf8");
    expect(header).toContain('href="/services"');
    expect(header).toContain("min-[520px]:flex min-[760px]:px-3.5");
  });
});

describe("the honest line above the decision-makers block", () => {
  it("is one constant, shown once, above the block, with no status, price or call to action of its own", () => {
    expect(DECISION_MAKERS_LINE_AR).toBe("بيانات صناع القرار تُسلَّم الآن بحسب الطلب، وتُعرض خطتها وسعرها قبل أي خصم.");
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(html.split(DECISION_MAKERS_LINE_AR).length - 1).toBe(1);
    expect(html.indexOf(DECISION_MAKERS_LINE_AR)).toBeLessThan(html.indexOf('data-testid="core-b2b"'));
    const line = /data-testid="decision-makers-line"[^>]*>([^<]*)</.exec(html)?.[1] ?? "";
    expect(line).toBe(DECISION_MAKERS_LINE_AR);
    expect(readFileSync("src/app/services/page.tsx", "utf8")).not.toContain("بيانات صناع القرار تُسلَّم");
  });
});

describe("docs/FUTURE_SERVICES.md (internal, generated from the same data)", () => {
  const doc = readFileSync("docs/FUTURE_SERVICES.md", "utf8");
  const total = allServices.length;
  const proven = allServices.filter((service) => isProven(service.platform, service.nameAr)).length;

  it("says at its top that it is internal and never shown to customers, and its counts equal the data", () => {
    expect(doc.split("\n").slice(0, 4).join("\n")).toContain("INTERNAL, not shown to customers");
    expect(doc).toContain(`| total shown | ${total} |`);
    expect(doc).toContain(`| متاح الآن | ${proven} |`);
    expect(doc).toContain(`| قريبًا | ${total - proven} |`);
  });

  it("it carries the sections the owner asked for", () => {
    expect(doc).toContain("## Prerequisites");
    for (const step of ["discovery", "entry persistence", "input mapping", "row reading", "unit counting", "price basis", "safety"]) expect(doc, step).toContain(step);
    expect(doc).toContain("## Proposed rollout order");
    expect(doc).toContain("Keyword-search services on text-bearing endpoints");
    expect(doc).toContain("One small live test per service BEFORE it is flipped");
    expect(doc).toContain("## ما يجب قياسه");
    expect(doc).toContain("cost per DELIVERED record");
    expect(doc).toContain("UNKNOWN");
  });

  it("it lists every not-yet-proven service once, by sector and platform, with its class, and none that is proven", () => {
    const entries = doc.split("## «قريبًا» services by sector and platform")[1];
    expect(entries).toBeDefined();
    const lines = entries.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.length).toBeGreaterThanOrEqual(total - proven);
    for (const line of lines) expect(line).toMatch(/\[(read|core)\]/);
    for (const sector of SERVICES_CATALOG) expect(entries).toContain(`### ${sector.nameAr}`);
    const rows = JSON.parse(readFileSync("scripts/catalog/classification.json", "utf8")) as Array<{ platform: string; nameAr: string; en: string; cls: string }>;
    for (const row of rows.filter((entry) => (entry.cls === "read" || entry.cls === "core") && isProven(entry.platform, entry.nameAr))) {
      const block = entries.split("#### ").find((chunk) => chunk.includes(`(${row.platform}) - `)) ?? "";
      expect(block.includes(`- ${row.en} [`), `${row.platform} ${row.en}`).toBe(false);
    }
  });
});
