import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  VOLUME_PRICING_MARKUP_FLOOR,
  VOLUME_PRICING_TIERS,
  costPointsPerUnit,
  tierForVolume,
  tieredUnitPricePoints,
  volumePricingEnabled,
} from "../src/lib/volumePricing";
import { calculateCapabilityUnitPricePoints } from "../src/functions/shared/quotes";
import { LIVE_SOCIAL_SERVICES, proposalRowsFromLive } from "./fixtures/liveSocialCosts";

describe("9. volume pricing (proposal, flag off)", () => {
  it("is off by default and the live formula is untouched: cost x 55 x 10 / 0.10, rounded up", () => {
    expect(volumePricingEnabled({})).toBe(false);
    expect(volumePricingEnabled({ VOLUME_PRICING_ENABLED: "true" })).toBe(true);
    expect(calculateCapabilityUnitPricePoints(0.001)).toBe(6);
    expect(costPointsPerUnit(0.001)).toBeCloseTo(0.55, 10);
  });

  it("with the flag off every volume pays exactly today's price", () => {
    for (const s of LIVE_SOCIAL_SERVICES) {
      for (const volume of [1, 99, 100, 500, 1000, 100000]) {
        const price = tieredUnitPricePoints({ providerCostUsd: s.providerCostUsd, volume, currentUnitPricePoints: s.currentUnitPoints, enabled: false });
        expect(price.unitPricePoints).toBe(s.currentUnitPoints);
        expect(price.discountPercent).toBe(0);
      }
    }
  });

  it("nothing in the quote builder, the worker or the SQL calls it, so enabling the flag today changes no price", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
      });
    const users = walk("src").filter((f) => /volumePricing|tieredUnitPricePoints/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => f.replaceAll("\\", "/"))).toEqual(["src/lib/volumePricing.ts"]);
    expect(readFileSync("src/functions/shared/planManager.ts", "utf8")).not.toContain("volumePricing");
  });

  it("below the first tier the price is today's price even with the flag on", () => {
    expect(tierForVolume(99)).toBeNull();
    for (const s of LIVE_SOCIAL_SERVICES) {
      expect(tieredUnitPricePoints({ providerCostUsd: s.providerCostUsd, volume: 99, currentUnitPricePoints: s.currentUnitPoints, enabled: true }).unitPricePoints).toBe(s.currentUnitPoints);
    }
  });

  it("with the flag on the price never rises with volume, never exceeds today's, never goes below cost x the floor, never below 1 point", () => {
    for (const s of LIVE_SOCIAL_SERVICES) {
      const cost = costPointsPerUnit(s.providerCostUsd);
      let previous = s.currentUnitPoints;
      for (const volume of [1, 50, 99, 100, 250, 499, 500, 750, 999, 1000, 5000]) {
        const { unitPricePoints } = tieredUnitPricePoints({ providerCostUsd: s.providerCostUsd, volume, currentUnitPricePoints: s.currentUnitPoints, enabled: true });
        expect(unitPricePoints).toBeLessThanOrEqual(previous);
        expect(unitPricePoints).toBeLessThanOrEqual(s.currentUnitPoints);
        expect(unitPricePoints).toBeGreaterThanOrEqual(cost * VOLUME_PRICING_MARKUP_FLOOR);
        expect(unitPricePoints).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(unitPricePoints)).toBe(true);
        previous = unitPricePoints;
      }
    }
  });

  it("a deep tier cannot cut below the floor even for a very cheap service", () => {
    const cheap = tieredUnitPricePoints({ providerCostUsd: 0.0002, volume: 5000, currentUnitPricePoints: 4, enabled: true });
    expect(cheap.unitPricePoints).toBeGreaterThanOrEqual(Math.ceil(costPointsPerUnit(0.0002) * VOLUME_PRICING_MARKUP_FLOOR));
    expect(cheap.unitPricePoints).toBeGreaterThanOrEqual(1);
  });

  it("the proposed arithmetic for the live social services", () => {
    const rows = Object.fromEntries(proposalRowsFromLive().map((r) => [r.slug, r]));
    expect(VOLUME_PRICING_TIERS.map((t) => [t.minUnits, t.markup])).toEqual([[100, 8], [500, 6], [1000, 5]]);
    expect(rows["social-tiktok-comments"].tiers.map((t) => t.unitPoints)).toEqual([5, 4, 3]);
    expect(rows["social-tiktok-comments"].tiers.map((t) => t.discountPercent)).toEqual([17, 33, 50]);
    expect(rows["social-youtube-comments"].tiers.map((t) => t.unitPoints)).toEqual([4, 3, 3]);
    expect(rows["social-facebook-posts"].tiers.map((t) => t.unitPoints)).toEqual([9, 7, 6]);
    expect(rows["social-facebook-comments"].floorPoints).toBe(5);
  });

  it("under the live 600-point cap only the first tier is reachable, which is why the proposal needs the larger cap", () => {
    const cap = 600;
    for (const s of LIVE_SOCIAL_SERVICES) {
      const tier1 = tieredUnitPricePoints({ providerCostUsd: s.providerCostUsd, volume: 100, currentUnitPricePoints: s.currentUnitPoints, enabled: true }).unitPricePoints;
      const maxUnitsAtTier1 = Math.floor(cap / (tier1 * 1.15));
      expect(maxUnitsAtTier1).toBeLessThan(500);
    }
  });
});
