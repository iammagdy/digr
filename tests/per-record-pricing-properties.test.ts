import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAndSaveManagedQuote } from "../src/functions/shared/planManager";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { calculateFinalSettlement, DEFAULT_PRICING_SETTINGS } from "../src/functions/shared/quotes";
import { computePublicCalculatorQuote } from "../src/lib/calculatorPricing";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";
import { chargeForUnits, maxRecordsInOneJob, reserveForUnits } from "../src/lib/recordPricing";

/**
 * The money properties at the TypeScript level, with the provider side out of the way (a high balance and daily limit) so the job cap is
 * the only ceiling: the quote writer and the public calculator are the same function; the 15% buffer is on the reserve only; the
 * reserve never passes the cap; the charge never passes the reserve. Sizes: M3 (37,500 X posts), M1 (25,000 comments), 1,000 records.
 */
const SLUGS = ["social-x-posts", "social-youtube-comments", "social-tiktok-comments", "social-facebook-comments", "social-facebook-posts", "icypeas-companies-search"] as const;
const mockTables: any = {
  from: () => {
    const chain: any = {
      select() { return this; }, eq() { return this; }, not() { return this; }, order() { return this; },
      limit: async () => ({ data: [], error: null }), insert: async () => ({ error: null }),
      update() { return this; }, in() { return this; }, then(resolve: any) { resolve({ error: null }); },
    };
    return chain;
  },
};
const writer = (slug: string, volume: number) =>
  createAndSaveManagedQuote(mockTables, {
    conversationId: `c_${slug}_${volume}`, userId: "u_prop", userBalance: 1_000_000, capabilities: APPROVED_CAPABILITY_CATALOG, pricingSettings: DEFAULT_PRICING_SETTINGS,
    plan: { summaryAr: "خطة", items: [{ capabilitySlug: slug, params: { query: "x", url: "https://www.youtube.com/watch?v=abc" }, targetVolumeMin: 1, targetVolumeMax: volume }], outputFormats: ["xlsx"] },
  });

beforeEach(() => setProviderBalanceForTesting(1000));
afterEach(() => resetProviderBalanceCacheForTesting());

describe("the quote writer and the public calculator are the same function (every per-record service, many sizes)", () => {
  for (const slug of SLUGS) {
    it(`${slug}: unit price, reserve, charge and the volume one job holds are equal`, async () => {
      for (const volume of [1, 7, 30, 100, 300, 1000, 4000, 10_000, 25_000, 37_500]) {
        const quote = await writer(slug, volume);
        const calc = computePublicCalculatorQuote(slug, volume, volume, undefined, undefined, undefined, 1000);
        expect(quote.unitPricePoints, `${slug} ${volume}`).toBe(calc.unitPricePoints);
        const held = calc.isCapped ? calc.maxCappedVolume! : volume;
        expect(quote.targetVolumeMax, `${slug} ${volume}`).toBe(held);
        expect(quote.quotedPoints, `${slug} ${volume}`).toBe(calc.isCapped ? calc.cappedReservedPoints! : calc.reservedPoints);
        expect(quote.expectedPoints, `${slug} ${volume}`).toBe(calc.isCapped ? calc.cappedChargedPoints! : calc.chargedPoints);
        // the reserve never passes the cap; the charge never passes the reserve; the buffer is on the reserve only
        expect(quote.quotedPoints).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP);
        expect(quote.expectedPoints).toBeLessThanOrEqual(quote.quotedPoints);
        expect(quote.expectedPoints).toBe(chargeForUnits(held, quote.unitPricePoints));
        expect(quote.quotedPoints).toBe(reserveForUnits(held, quote.unitPricePoints, 0.15));
        expect(calculateFinalSettlement(held, quote.unitPricePoints, quote.quotedPoints).chargePoints).toBe(quote.expectedPoints);
      }
    });
  }
});

describe("the sizes the owner named", () => {
  it("M3: 37,500 X posts are cut to 37,113 (4,348 charge, 5,000 held); the whole request would have held 5,053", async () => {
    const quote = await writer("social-x-posts", 37_500);
    expect(quote).toMatchObject({ targetVolumeMax: 37_113, expectedPoints: 4348, quotedPoints: 5000, pointsCap: 5000, pointsCapConstrained: true, requestedVolumeMax: 37_500 });
    expect(reserveForUnits(37_500, 0.11715)).toBe(5053);
    expect(chargeForUnits(37_500, 0.11715)).toBe(4394);
  });

  it("M1: 25,000 comments are cut to 15,810 (4,348 charge, 5,000 held)", async () => {
    const quote = await writer("social-youtube-comments", 25_000);
    expect(quote).toMatchObject({ targetVolumeMax: 15_810, expectedPoints: 4348, quotedPoints: 5000, pointsCapConstrained: true });
  });

  it("1,000 records of each service: charge and reserve", async () => {
    const expected: Record<string, [number, number]> = {
      "social-x-posts": [118, 135], "social-youtube-comments": [275, 317], "social-tiktok-comments": [275, 317],
      "social-facebook-comments": [1034, 1190], "social-facebook-posts": [3449, 3966], "icypeas-companies-search": [3168, 3644],
    };
    for (const slug of SLUGS) {
      const quote = await writer(slug, 1000);
      expect([quote.expectedPoints, quote.quotedPoints], slug).toEqual(expected[slug]);
      expect(quote.pointsCapConstrained, slug).toBe(false);
    }
  });

  it("the largest sellable job per service at the 5,000 cap, and what a 4,500-point mission needs", () => {
    const largest = Object.fromEntries(SLUGS.map((slug) => {
      const unit = computePublicCalculatorQuote(slug, 1).unitPricePoints;
      return [slug, { unit, records: maxRecordsInOneJob(unit), charge: chargeForUnits(maxRecordsInOneJob(unit), unit) }];
    }));
    expect(largest["social-x-posts"]).toEqual({ unit: 0.11715, records: 37_113, charge: 4348 });
    expect(largest["social-youtube-comments"]).toEqual({ unit: 0.275, records: 15_810, charge: 4348 });
    expect(largest["social-tiktok-comments"]).toEqual({ unit: 0.275, records: 15_810, charge: 4348 });
    expect(largest["social-facebook-comments"]).toEqual({ unit: 1.034, records: 4204, charge: 4347 });
    expect(largest["social-facebook-posts"]).toEqual({ unit: 3.4485, records: 1260, charge: 4346 });
    expect(largest["icypeas-companies-search"]).toEqual({ unit: 3.168, records: 1372, charge: 4347 });
    // a 4,500-point charge needs a 5,175-point reserve: it does not fit a 5,000 cap, a cap of 5,175 or more fits it
    expect(reserveForUnits(4500, 1)).toBe(5175);
  });
});

describe("a stored unit price is read back exactly: the quote item carries the fractional price the database will store", () => {
  it("the item unit price survives JSON, and charge / reserve recomputed from it equal the quote's own", async () => {
    const quote = await writer("social-x-posts", 1000);
    const stored = JSON.parse(JSON.stringify(quote.items))[0];
    expect(stored.unitPricePoints).toBe(0.11715);
    expect(stored.unitCostUsd).toBe(0.0000213);
    expect(chargeForUnits(1000, stored.unitPricePoints)).toBe(quote.expectedPoints);
    expect(reserveForUnits(1000, stored.unitPricePoints)).toBe(quote.quotedPoints);
    expect(String(stored.unitPricePoints).length).toBeLessThanOrEqual(8);
  });
});
