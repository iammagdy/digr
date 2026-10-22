import { describe, expect, it } from "vitest";
import {
  CAPABILITIES, CONTEXTDEV_USD_PER_CREDIT, FIRECRAWL_USD_PER_CREDIT, PROVIDER_FACTS, capabilitiesOfProvider, capabilityById, isSellable, sellableCapabilities,
} from "../src/lib/multiProvider/catalog";
import { recordCostFor } from "../src/lib/recordPricing";

/** The capability registry: prices come from the official documentation, nothing is invented, an unverified price is never sold. */
describe("capability registry prices (read from the official docs on 2026-10-22)", () => {
  it("Firecrawl credits per call match the billing page: scrape 1, map 1, search 2 per 10 results, JSON scrape 1 + 4", () => {
    expect(capabilityById("firecrawl.scrape")?.creditsPerCall).toBe(1);
    expect(capabilityById("firecrawl.map")?.creditsPerCall).toBe(1);
    expect(capabilityById("firecrawl.search")?.creditsPerCall).toBe(2);
    expect(capabilityById("firecrawl.search")?.unitsPerCall).toBe(10);
    expect(capabilityById("firecrawl.scrape_json")?.creditsPerCall).toBe(5);
  });

  it("Context.dev credits per call match the credits page: scrape 1, map 1, search 1 per 10 results, JSON scrape 1 + 4, people 20 per match", () => {
    expect(capabilityById("contextdev.scrape")?.creditsPerCall).toBe(1);
    expect(capabilityById("contextdev.map")?.creditsPerCall).toBe(1);
    expect(capabilityById("contextdev.search")?.creditsPerCall).toBe(1);
    expect(capabilityById("contextdev.search")?.unitsPerCall).toBe(10);
    expect(capabilityById("contextdev.scrape_json")?.creditsPerCall).toBe(5);
    expect(capabilityById("contextdev.people_enrich")?.creditsPerCall).toBe(20);
  });

  it("the USD per credit is the HIGHEST listed plan rate, so a price never undercuts the real cost", () => {
    // Firecrawl: 5 USD for 1,000 credits (Hobby pay-as-you-go) is the dearest listed rate; the subscription Hobby rate 16/5,000 is lower.
    expect(FIRECRAWL_USD_PER_CREDIT).toBe(5 / 1000);
    expect(FIRECRAWL_USD_PER_CREDIT).toBeGreaterThanOrEqual(19 / 5000);
    // Context.dev: Developer 19 USD for 7,500 credits = 0.002533..., the overage 2.20 / 1,000 is lower.
    expect(CONTEXTDEV_USD_PER_CREDIT).toBeGreaterThanOrEqual(19 / 7500);
    expect(CONTEXTDEV_USD_PER_CREDIT).toBeGreaterThanOrEqual(2.2 / 1000);
    expect(capabilityById("firecrawl.scrape")?.costPerCallUsd).toBeCloseTo(0.005, 9);
    expect(capabilityById("firecrawl.search")?.costPerUnitUsd).toBeCloseTo(0.001, 9);
    expect(capabilityById("contextdev.scrape")?.costPerCallUsd).toBeCloseTo(0.00254, 9);
  });

  it("every credit-priced capability names the official page it was read from", () => {
    for (const cap of CAPABILITIES.filter((c) => c.provider !== "treg")) {
      expect(cap.priceSources.length).toBeGreaterThan(0);
      for (const source of cap.priceSources) expect(source).toMatch(/^https:\/\/(?:docs\.firecrawl\.dev|www\.firecrawl\.dev|docs\.context\.dev|context\.dev)\//);
    }
  });

  it("a price that is not in the documentation is UNVERIFIED, has no cost and is never sold", () => {
    for (const id of ["firecrawl.extract", "firecrawl.agent"]) {
      const cap = capabilityById(id)!;
      expect(cap.priceStatus).toBe("UNVERIFIED");
      expect(cap.creditsPerCall).toBeNull();
      expect(cap.costPerCallUsd).toBeNull();
      expect(cap.costPerUnitUsd).toBeNull();
      expect(cap.blockedReason).toBe("unverified_price");
      expect(isSellable(cap)).toBe(false);
    }
  });

  it("profile-database lookups are blocked by the data policy even with a verified price", () => {
    const cap = capabilityById("contextdev.people_enrich")!;
    expect(cap.priceStatus).toBe("VERIFIED");
    expect(cap.blockedReason).toBe("data_policy");
    expect(isSellable(cap)).toBe(false);
  });

  it("TREG's directory price is the measured cost per record already used by the shared pricing table", () => {
    const cap = capabilityById("treg.companies.search")!;
    expect(cap.costPerUnitUsd).toBe(recordCostFor("icypeas-companies-search")!.costUsdPerRecord);
    expect(isSellable(cap)).toBe(true);
  });

  it("only verified, unblocked capabilities are sellable, and each provider lists its own", () => {
    const sellable = sellableCapabilities().map((c) => c.id);
    expect(sellable).toContain("firecrawl.scrape");
    expect(sellable).toContain("contextdev.search");
    expect(sellable).not.toContain("firecrawl.extract");
    expect(sellable).not.toContain("contextdev.people_enrich");
    expect(capabilitiesOfProvider("firecrawl").every((c) => c.provider === "firecrawl")).toBe(true);
  });

  it("the balance APIs are the documented free reads; TREG's read lives in the existing status module", () => {
    expect(PROVIDER_FACTS.firecrawl.balanceApi).toMatchObject({ method: "GET", url: "https://api.firecrawl.dev/v2/team/credit-usage", costsCredits: false });
    expect(PROVIDER_FACTS.contextdev.balanceApi).toMatchObject({ method: "GET", url: "https://api.context.dev/v1/org/usage", costsCredits: false });
    expect(PROVIDER_FACTS.treg.balanceApi).toBeNull();
  });
});
