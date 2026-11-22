import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog, parseCatalog, type CatalogEndpoint, type CatalogCost } from "../src/lib/treg/catalog";
import {
  getLiveServicesCatalog,
  buildLiveServicesCatalog,
  liveServiceUnitPoints,
  isLiveCatalogEndpoint,
} from "../src/lib/liveServicesCatalog";
import { DEFAULT_MISSION_PRICING_SETTINGS, priceByRule } from "../src/lib/missionPricing";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";
import ServicesCatalogPage from "../src/app/services/page";
import PlatformServicesPage from "../src/app/services/[platform]/page";

function mockEndpoint(partial: {
  id: string;
  provider: string;
  platform: string;
  category: string;
  capability: string;
  name: string;
  cost: CatalogCost | null;
  method?: string;
  scope?: string;
  kind?: string;
}): CatalogEndpoint {
  return {
    method: "GET",
    path: `/${partial.id}`,
    kind: "direct",
    tier: null,
    async: false,
    async_config: null,
    inputs: [],
    pagination: [],
    observed: null,
    scope: "public",
    cost_confidence: null,
    siblings: [],
    test_request: null,
    list_path: null,
    cursor_path: null,
    item_fields: null,
    example_response_trimmed: null,
    summary: null,
    ...partial,
  };
}

function mockCost(cost: { type: string; usd: number | null; unit: string }): CatalogCost {
  return {
    type: cost.type,
    usd: cost.usd,
    unit: cost.unit,
    currency: "USD",
    value: cost.usd,
    per: 1,
    billing_note: null,
    failed_or_empty_billed: null,
  };
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ");

describe("FX-CAT Ph2: Live Services Catalog & Render Guards", () => {
  it("1. Live catalog completeness vs static snapshot (loadTregCatalog)", () => {
    const live = getLiveServicesCatalog();
    expect(live.sectors.length).toBeGreaterThanOrEqual(10);
    expect(live.counts.platforms).toBeGreaterThanOrEqual(80);
    expect(live.counts.services).toBeGreaterThanOrEqual(500);

    const platformSlugs = new Set(live.sectors.flatMap((s) => s.platforms.map((p) => p.slug)));
    // Live catalog includes platforms backed by sellable priced endpoints
    expect(platformSlugs.has("1688")).toBe(true);
    expect(platformSlugs.has("github")).toBe(true);
    expect(platformSlugs.has("telegram")).toBe(true);
    expect(platformSlugs.has("ai-search")).toBe(true);
    expect(platformSlugs.has("stocks")).toBe(true);
  });

  it("2. Paused-provider counter-case: synthetic catalog excludes paused providers", () => {
    const mockEndpoints: CatalogEndpoint[] = [
      mockEndpoint({
        id: "apollo.people.lookup",
        provider: "apollo",
        platform: "acme",
        category: "Enrichment",
        capability: "acme.secret.only",
        name: "Acme Secret Only",
        method: "POST",
        cost: mockCost({ type: "credit", usd: 0.02, unit: "record" }),
      }),
      mockEndpoint({
        id: "someprov.demo.public.posts",
        provider: "someprov",
        platform: "demo",
        category: "Social",
        capability: "demo.public.posts",
        name: "Demo Public Posts",
        cost: mockCost({ type: "credit", usd: 0.005, unit: "record" }),
      }),
    ];

    const syntheticCatalog = parseCatalog({ source: "test", count: 2, endpoints: mockEndpoints }, []);
    const live = buildLiveServicesCatalog(syntheticCatalog);

    const allServices = live.sectors.flatMap((s) => s.platforms.flatMap((p) => p.services));
    const allPlatforms = live.sectors.flatMap((s) => s.platforms.map((p) => p.slug));

    // Apollo is paused: acme.secret.only must NOT appear anywhere, and acme platform must be gone
    expect(allPlatforms).not.toContain("acme");
    expect(allServices.some((s) => s.nameAr.includes("Secret"))).toBe(false);

    // someprov is not paused: demo platform and its service must appear
    expect(allPlatforms).toContain("demo");
    expect(live.counts.platforms).toBe(1);
    expect(live.counts.services).toBe(1);
  });

  it("3. Blocked / own_account / not_sellable / write_action / policy_blocked counter-case", () => {
    const mockEndpoints: CatalogEndpoint[] = [
      mockEndpoint({
        id: "prov.own.account",
        provider: "prov",
        platform: "ownplat",
        category: "Developer",
        capability: "ownplat.user.info",
        name: "User Info",
        scope: "own_account",
        cost: mockCost({ type: "credit", usd: 0.01, unit: "record" }),
      }),
      mockEndpoint({
        id: "prov.write.action",
        provider: "prov",
        platform: "writeplat",
        category: "Social",
        capability: "writeplat.post.create",
        name: "Create Post",
        method: "POST",
        cost: mockCost({ type: "credit", usd: 0.01, unit: "call" }),
      }),
      mockEndpoint({
        id: "prov.media.gen",
        provider: "prov",
        platform: "image-gen",
        category: "AI generation",
        capability: "image-gen.create",
        name: "Image Generation",
        method: "POST",
        cost: mockCost({ type: "credit", usd: 0.05, unit: "call" }),
      }),
      mockEndpoint({
        id: "prov.poll.task",
        provider: "prov",
        platform: "asyncplat",
        category: "E-commerce",
        capability: "asyncplat.task.get",
        name: "Poll Task",
        cost: mockCost({ type: "credit", usd: 0.01, unit: "call" }),
      }),
      mockEndpoint({
        id: "prov.valid.endpoint",
        provider: "prov",
        platform: "validplat",
        category: "E-commerce",
        capability: "validplat.items.search",
        name: "Search Items",
        cost: mockCost({ type: "credit", usd: 0.01, unit: "record" }),
      }),
    ];

    const syntheticCatalog = parseCatalog(
      { source: "test", count: 5, endpoints: mockEndpoints },
      [{ id: "prov.write.action" }]
    );
    const live = buildLiveServicesCatalog(syntheticCatalog);

    const platformSlugs = live.sectors.flatMap((s) => s.platforms.map((p) => p.slug));
    expect(platformSlugs).not.toContain("ownplat");
    expect(platformSlugs).not.toContain("writeplat");
    expect(platformSlugs).not.toContain("image-gen");
    expect(platformSlugs).not.toContain("asyncplat");
    expect(platformSlugs).toContain("validplat");
    expect(live.counts.platforms).toBe(1);
    expect(live.counts.services).toBe(1);
  });

  it("4. Unpriced & v1.1 Free-Endpoint counter-cases", () => {
    const mockEndpoints: CatalogEndpoint[] = [
      mockEndpoint({
        id: "prov.null.price",
        provider: "prov",
        platform: "nullplat",
        category: "Developer",
        capability: "nullplat.data",
        name: "Null Price Endpoint",
        cost: mockCost({ type: "credit", usd: null, unit: "record" }),
      }),
      mockEndpoint({
        id: "prov.bad.unit",
        provider: "prov",
        platform: "badunitplat",
        category: "Developer",
        capability: "badunitplat.data",
        name: "Bad Unit Endpoint",
        cost: mockCost({ type: "credit", usd: 0.01, unit: "char" }),
      }),
      mockEndpoint({
        id: "prov.zero.credit",
        provider: "prov",
        platform: "zerocreditplat",
        category: "Developer",
        capability: "zerocreditplat.data",
        name: "Zero Non-Free Credit Endpoint",
        cost: mockCost({ type: "credit", usd: 0, unit: "call" }),
      }),
      mockEndpoint({
        id: "prov.free.v11",
        provider: "prov",
        platform: "freeplat",
        category: "Developer",
        capability: "freeplat.data",
        name: "Free v1.1 Endpoint",
        cost: mockCost({ type: "free", usd: 0, unit: "call" }),
      }),
      mockEndpoint({
        id: "prov.paid.priced",
        provider: "prov",
        platform: "paidplat",
        category: "Developer",
        capability: "paidplat.data",
        name: "Paid Priced Endpoint",
        cost: mockCost({ type: "credit", usd: 0.005, unit: "record" }),
      }),
    ];

    const syntheticCatalog = parseCatalog({ source: "test", count: 5, endpoints: mockEndpoints }, []);
    const live = buildLiveServicesCatalog(syntheticCatalog);

    const platformSlugs = live.sectors.flatMap((s) => s.platforms.map((p) => p.slug));
    // Null price, unsupported unit, and non-free credit zero are excluded
    expect(platformSlugs).not.toContain("nullplat");
    expect(platformSlugs).not.toContain("badunitplat");
    expect(platformSlugs).not.toContain("zerocreditplat");

    // v1.1 free endpoint (cost.type === "free" && cost.usd === 0) APPEARS
    expect(platformSlugs).toContain("freeplat");
    // Normal paid endpoint APPEARS
    expect(platformSlugs).toContain("paidplat");
  });

  it("5. Newly added sellable endpoint appears with ZERO code changes & zero English", () => {
    const mockEndpoints: CatalogEndpoint[] = [
      mockEndpoint({
        id: "prov.newshop.reviews",
        provider: "prov",
        platform: "newshop",
        category: "E-commerce",
        capability: "newshop.products.reviews",
        name: "Fetch product reviews",
        cost: mockCost({ type: "credit", usd: 0.01, unit: "record" }),
      }),
    ];

    const syntheticCatalog = parseCatalog({ source: "test", count: 1, endpoints: mockEndpoints }, []);
    const live = buildLiveServicesCatalog(syntheticCatalog);

    expect(live.sectors.length).toBe(1);
    const sector = live.sectors[0]!;
    expect(sector.nameAr).toContain("التجارة الإلكترونية");
    expect(sector.descAr.length).toBeGreaterThan(10);

    expect(sector.platforms.length).toBe(1);
    const platform = sector.platforms[0]!;
    expect(platform.slug).toBe("newshop");
    expect(platform.nameAr.length).toBeGreaterThan(0);
    expect(platform.descAr.length).toBeGreaterThan(0);

    expect(platform.services.length).toBe(1);
    const service = platform.services[0]!;
    expect(service.slug).toMatch(/^[0-9a-f]{7}$/);

    // Customer text checks on all fields
    const fieldsToCheck = [
      sector.nameAr,
      sector.descAr,
      platform.nameAr,
      platform.descAr,
      service.nameAr,
      service.explainAr,
      service.group,
    ];

    for (const text of fieldsToCheck) {
      const check = checkCustomerText(text);
      expect(check.issues, `issues for "${text}": ${check.issues.join(", ")}`).toEqual([]);
      expect(text).not.toMatch(/[A-Za-z]/);
      expect(text).not.toMatch(PROVIDER_NAME_PATTERN);
      expect(text).not.toContain("متاح الآن");
      expect(text).not.toContain("قريبًا");
      expect(text).not.toMatch(/سعر|نقطة|جنيه|دولار/);
    }

    // Name and explainAr must have NO ASCII digits or Latin
    expect(service.nameAr).not.toMatch(/[A-Za-z0-9]/);
    expect(service.explainAr).not.toMatch(/[A-Za-z0-9]/);

    // explainAr must be 20-140 chars and end with "."
    expect(service.explainAr.length).toBeGreaterThanOrEqual(20);
    expect(service.explainAr.length).toBeLessThanOrEqual(140);
    expect(service.explainAr.endsWith(".")).toBe(true);
  });

  it("6. Card-parity pricing helper (startingUnitPoints)", () => {
    // liveServiceUnitPoints must match priceByRule with DEFAULT_MISSION_PRICING_SETTINGS
    const unitPoints = liveServiceUnitPoints(0.002);
    const expected = priceByRule({ volume: 1, costPerRowUsd: 0.002, settings: DEFAULT_MISSION_PRICING_SETTINGS }).unitPoints;
    expect(unitPoints).toBe(expected);
    expect(unitPoints).toBe(11);
  });

  it("7. Render & performance guards", async () => {
    // 1. Caching proof: WeakMap reference equality
    const realCatalog = loadTregCatalog();
    const live1 = getLiveServicesCatalog(realCatalog);
    const live2 = getLiveServicesCatalog(realCatalog);
    expect(live1).toBe(live2);

    // 2. CatalogBrowser.tsx has NO top-level imports of liveServicesCatalog or treg_catalog_sellable.json
    const browserCode = readFileSync("src/components/services/CatalogBrowser.tsx", "utf8");
    expect(browserCode).not.toMatch(/from\s+["']@\/lib\/liveServicesCatalog["']/);
    expect(browserCode).not.toMatch(/treg_catalog_sellable\.json/);

    // 3. Render ServicesCatalogPage
    const catalogHtml = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(catalogHtml).toContain('dir="rtl"');
    expect(catalogHtml).toContain('lang="ar"');
    expect(catalogHtml).not.toMatch(PROVIDER_NAME_PATTERN);
    const catalogText = textOf(catalogHtml);
    expect(catalogText).not.toMatch(/[A-Za-z]/);
    expect(catalogText).not.toContain("متاح الآن");
    expect(catalogText).not.toContain("قريبًا");

    // 4. Render PlatformServicesPage for tiktok
    const platformHtml = renderToStaticMarkup(await PlatformServicesPage({ params: Promise.resolve({ platform: "tiktok" }) }));
    expect(platformHtml).toContain('dir="rtl"');
    expect(platformHtml).toContain('lang="ar"');
    expect(platformHtml).not.toMatch(PROVIDER_NAME_PATTERN);
    const platformText = textOf(platformHtml);
    expect(platformText).not.toMatch(/[A-Za-z]/);
    expect(platformText).not.toContain("متاح الآن");
    expect(platformText).not.toContain("قريبًا");
  });
});
