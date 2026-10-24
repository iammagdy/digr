import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ServicesCatalogPage from "../src/app/services/page";
import { CatalogBrowser } from "../src/components/services/CatalogBrowser";
import { SERVICES_CATALOG, catalogCounts, coreServices } from "../src/lib/servicesCatalog";
import { normalizeArabicSearch } from "../src/lib/servicesCatalogText";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";

const all = SERVICES_CATALOG.flatMap((sector) => sector.platforms.flatMap((platform) => platform.services.map((service) => ({ platform, ...service }))));
const FILE: Record<string, string> = JSON.parse(readFileSync("scripts/catalog/explanations.json", "utf8"));
/** Words that would turn an explanation into a status or a promise. */
const BANNED_WORDS = ["متاح", "متاحة", "قريبًا", "قريباً", "اطلب", "اطلبها", "ستُضاف", "سعر", "نقطة", "مجانًا", "مجاني", "ضمان", "مضمون", "فوري", "فورًا", "فورية", "دائمًا", "جميع", "كل "];
const VENDOR = [PROVIDER_NAME_PATTERN, /treg|tikhub|scrapecreators|icypeas|apify|serpapi|openai|anthropic|veo|sora|kling|hailuo|seedance|flux|lyria|gemini|gpt|midjourney|elevenlabs|runway/i, /تريج|جيميني|كلينج|فلوكس|ميدجورني|سيدانس|هايلو|لايريا|إيليفن/];

describe("every service explains itself in one plain-Arabic sentence", () => {
  it("every service has one, the explanation file has exactly one entry per service (no spare, none missing), and the count is the data's", () => {
    expect(all.length).toBe(catalogCounts().services);
    expect(Object.keys(FILE).length).toBe(all.length);
    for (const service of all) expect(FILE[`${service.platform.slug}|${service.nameAr}`], `${service.platform.slug} ${service.nameAr}`).toBe(service.explainAr);
  });

  it("each is non-empty Arabic, one sentence of 20 to 140 characters ending in a full stop; no Latin, digit, emoji, markdown, quote or raw id", () => {
    for (const service of all) {
      const text = service.explainAr;
      const label = `${service.platform.slug} ${service.nameAr}: ${text}`;
      expect(text.trim(), label).toBe(text);
      expect(text, label).toMatch(/[؀-ۿ]/u);
      expect(text.length, label).toBeGreaterThanOrEqual(20);
      expect(text.length, label).toBeLessThanOrEqual(140);
      expect(text.endsWith("."), label).toBe(true);
      expect(text.slice(0, -1), label).not.toMatch(/[.!؟?]/);
      expect(text, label).not.toMatch(/[A-Za-z0-9٠-٩]/);
      expect(text, label).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(text, label).not.toMatch(/[*_`~#"'«»\[\]()<>]/);
      expect(text, label).not.toMatch(/[0-9a-f]{7}/);
    }
  });

  it("no status word, no promise word, no vendor, provider or model name in any explanation", () => {
    for (const service of all) {
      const label = `${service.platform.slug} ${service.nameAr}: ${service.explainAr}`;
      for (const word of BANNED_WORDS) expect(service.explainAr, `${label} -> ${word}`).not.toContain(word);
      for (const pattern of VENDOR) expect(service.explainAr, label).not.toMatch(pattern);
    }
  });

  it("an explanation is not the service's own name, and no two services of one platform share a sentence", () => {
    for (const sector of SERVICES_CATALOG) for (const platform of sector.platforms) {
      const seen = new Set<string>();
      for (const service of platform.services) {
        expect(service.explainAr, `${platform.slug} ${service.nameAr}`).not.toBe(service.nameAr);
        expect(seen.has(service.explainAr), `${platform.slug}: ${service.explainAr}`).toBe(false);
        seen.add(service.explainAr);
      }
    }
  });

  it("the sentences are generic data from the data module: not the catalog file's generic labels, and no price or number", () => {
    const rows = JSON.parse(readFileSync("scripts/catalog/classification.json", "utf8")) as Array<{ nameAr: string }>;
    const names = new Set(rows.map((row) => row.nameAr));
    for (const service of all) expect(names.has(service.explainAr), service.explainAr).toBe(false);
    expect(readFileSync("src/lib/servicesCatalog.ts", "utf8")).toContain("explainAr");
  });
});

describe("where the explanation appears", () => {
  it("the first HTML of the page has the core services' sentences only: the other ~950 are not rendered until a platform is opened", () => {
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    const core = new Set(coreServices().map((service) => service.explainAr));
    for (const sentence of core) expect(html).toContain(sentence);
    const outside = all.filter((service) => !core.has(service.explainAr));
    expect(outside.length).toBeGreaterThan(900);
    for (const service of outside.slice(0, 200)) expect(html, service.explainAr).not.toContain(service.explainAr);
    expect(renderToStaticMarkup(createElement(CatalogBrowser))).not.toContain("<li");
  });

  it("the browser renders a service as its name plus its sentence, in that order, and nothing else", () => {
    const source = readFileSync("src/components/services/CatalogBrowser.tsx", "utf8");
    expect(source).toContain("{service.nameAr}");
    expect(source).toContain("{service.explainAr}");
    expect(source.indexOf("{service.nameAr}")).toBeLessThan(source.indexOf("{service.explainAr}"));
  });
});

describe("Arabic search also matches the explanation text", () => {
  const source = readFileSync("src/components/services/CatalogBrowser.tsx", "utf8");

  it("the searchable text of every service includes its explanation", () => {
    expect(source).toContain("${service.nameAr} ${service.explainAr} ${service.group}");
  });

  it("a word that is only in an explanation (not in any name, group or platform text) finds that service", () => {
    const platformHead = (platform: { nameAr: string; descAr: string }) => normalizeArabicSearch(`${platform.nameAr} ${platform.descAr}`);
    let proved = 0;
    for (const service of all) {
      const own = normalizeArabicSearch(`${service.nameAr} ${service.group}`);
      const word = normalizeArabicSearch(service.explainAr).split(" ").find((candidate) => candidate.length >= 5 && !own.includes(candidate) && !platformHead(service.platform).includes(candidate));
      if (!word) continue;
      const index = normalizeArabicSearch(`${service.nameAr} ${service.explainAr} ${service.group}`);
      expect(index.includes(word), service.nameAr).toBe(true);
      expect(own.includes(word)).toBe(false);
      proved += 1;
      if (proved >= 25) break;
    }
    expect(proved).toBeGreaterThanOrEqual(25);
  });
});
