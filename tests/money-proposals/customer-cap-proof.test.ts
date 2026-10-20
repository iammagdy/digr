import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAndSaveManagedQuote, type PlanState } from "../../src/functions/shared/planManager";
import type { Capability } from "../../src/functions/shared/capabilityRegistry";
import { DEFAULT_PRICING_SETTINGS } from "../../src/functions/shared/quotes";
import { resetProviderBalanceCacheForTesting } from "../../src/functions/shared/providerSpend";
import { applyCustomerCap, reserveForUnits, volumeForPointsCap } from "../../src/lib/pointsCap";

/**
 * Task 2f, proof that the customer's own budget cap can only LOWER volume. It never raises a unit price, a reserve or the job cap,
 * and it is applied BEFORE the reserve is computed. The real quote writer (createAndSaveManagedQuote) prices the plan in these tests.
 */
const db = () => ({ from: vi.fn(() => ({ update: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [], error: null })) })) })), insert: vi.fn(async (doc: any) => ({ data: doc, error: null })) })) });

const comments: Capability = {
  slug: "x-post-search", category: "x", nameAr: "البحث في تدوينات إكس", nameEn: "X Post Search", descriptionAr: "البحث في التغريدات العامة",
  paramsSchema: JSON.stringify({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
  tregEndpointId: "x.search.v1", tregMethod: "GET", pricingUnit: "item", unitCostUsd: 0.0016, maxRows: 5000, paginationType: "cursor", enabled: true,
};

const plan = (volume: number): PlanState => ({ summaryAr: "خطة", items: [{ capabilitySlug: "x-post-search", params: { query: "القهوة" }, targetVolumeMin: 1, targetVolumeMax: volume }], outputFormats: ["xlsx"] });
const quoteFor = (volume: number) => createAndSaveManagedQuote(db() as any, { conversationId: "c", userId: "u", plan: plan(volume), userBalance: 100_000, capabilities: [comments], pricingSettings: DEFAULT_PRICING_SETTINGS });

describe("the customer cap goes through the real quote writer", () => {
  beforeEach(() => resetProviderBalanceCacheForTesting());

  it("for many caps: same unit price, reserve never above the customer's cap, never above the plan without a cap, never above the job cap", async () => {
    const wanted = 500;
    const uncapped = await quoteFor(wanted);
    const unit = uncapped.unitPricePoints;
    expect(unit).toBeGreaterThan(0);
    for (const cap of [20, 50, 99, 150, 300, 450, 590, 600, 5000]) {
      const capped = applyCustomerCap({ capPoints: cap, unitPricePoints: unit, currentVolume: wanted });
      if (!capped.ok) continue;
      expect(capped.volume).toBeLessThanOrEqual(wanted);
      const quote = await quoteFor(capped.volume);
      expect(quote.unitPricePoints).toBe(unit);
      expect(quote.items[0].unitPricePoints).toBe(unit);
      expect(quote.quotedPoints).toBeLessThanOrEqual(Math.min(cap, quote.pointsCap ?? 600));
      expect(quote.quotedPoints).toBeLessThanOrEqual(uncapped.quotedPoints);
      expect(quote.targetVolumeMax).toBeLessThanOrEqual(uncapped.targetVolumeMax);
      expect(quote.pointsCap).toBe(uncapped.pointsCap);
      expect(quote.pointsCap).toBeLessThanOrEqual(600);
    }
  });

  it("a cap above the plan changes nothing: the volume stays what was asked", () => {
    for (const volume of [1, 30, 57, 200]) {
      expect(applyCustomerCap({ capPoints: 10_000_000, unitPricePoints: 9, currentVolume: volume })).toMatchObject({ ok: true, volume });
    }
  });

  it("the volume is the lesser of the cap's fit and the plan, for any cap and unit price (property check)", () => {
    for (const unit of [1, 3, 5, 6, 9, 11, 83, 193]) {
      for (let cap = 1; cap <= 3000; cap += 37) {
        for (const current of [1, 10, 57, 500]) {
          const result = applyCustomerCap({ capPoints: cap, unitPricePoints: unit, currentVolume: current });
          if (!result.ok) { expect(volumeForPointsCap(cap, unit)).toBeLessThan(1); continue; }
          expect(result.volume).toBeLessThanOrEqual(current);
          expect(result.volume).toBeLessThanOrEqual(volumeForPointsCap(cap, unit));
          expect(result.reservePoints).toBe(reserveForUnits(result.volume, unit));
          expect(result.reservePoints).toBeLessThanOrEqual(cap);
        }
      }
    }
  });
});

describe("the order in the edit route: cap -> volume -> quote writer (reserve)", () => {
  const route = readFileSync("src/app/api/chat/edit-plan/route.ts", "utf8");

  it("applyCustomerCap runs before applyPlanOperations, which runs before createAndSaveManagedQuote", () => {
    const cap = route.indexOf("applyCustomerCap({");
    const apply = route.indexOf("applyPlanOperations(currentPlan, operationsToApply)");
    const quote = route.indexOf("createAndSaveManagedQuote(adminClient");
    expect(cap).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(cap);
    expect(quote).toBeGreaterThan(apply);
  });

  it("the cap only ever writes a set_limit volume; the unit price comes from the stored quote and is recomputed by the quote writer", () => {
    const capBlock = route.slice(route.indexOf("if (requestedCap !== null)"), route.indexOf("const updatedPlan = applyPlanOperations"));
    expect(capBlock).toContain('action: "set_limit"');
    expect(capBlock).toContain("targetVolumeMax: capped.volume");
    expect(capBlock).not.toMatch(/unitPricePoints\s*=|unitCostUsd|pointsCap\s*=|reservedPoints|quotedPoints|safetyBuffer/);
    expect(capBlock).toContain("Number(capItem?.unitPricePoints)");
    const planner = readFileSync("src/functions/shared/planManager.ts", "utf8");
    expect(planner).toContain("it.unitPricePoints = effectiveItemUnitPrice;");
    expect(planner).toContain("const pointsCap = Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP);");
  });

  it("the cap helper imports no pricing constant and cannot touch the job cap", () => {
    const helper = readFileSync("src/lib/pointsCap.ts", "utf8");
    expect(helper).not.toMatch(/JOB_POINTS_CAP|DEFAULT_PRICING_SETTINGS|calculateCapabilityUnitPricePoints|unitCostUsd/);
  });
});
