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
 * reserve never passes the cap; the charge never passes the reserve. Sizes: M3 at several sizes up to 37,500 records.
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
        // the chat handler first holds a plan to the service's own record ceiling; the writer then holds it to the points cap
        const ceiling = APPROVED_CAPABILITY_CATALOG.find((c) => c.slug === slug)!.maxRows;
        const quote = await writer(slug, Math.min(volume, ceiling));
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

// writer-level: the quote writer holds a plan to the points cap only; the service's own record ceiling is applied before it (see the test above)
describe("the sizes at the 600-point cap", () => {
  it("37,500 X posts are cut to 4,453 (522 charge, 600 held); the whole request would have held 5,053", async () => {
    const quote = await writer("social-x-posts", 37_500);
    expect(quote).toMatchObject({ targetVolumeMax: 4453, expectedPoints: 522, quotedPoints: 600, pointsCap: 600, pointsCapConstrained: true, requestedVolumeMax: 37_500 });
    expect(reserveForUnits(37_500, 0.11715)).toBe(5053);
    expect(chargeForUnits(37_500, 0.11715)).toBe(4394);
  });

  it("25,000 comments are cut to 1,897 (522 charge, 600 held)", async () => {
    const quote = await writer("social-youtube-comments", 25_000);
    expect(quote).toMatchObject({ targetVolumeMax: 1897, expectedPoints: 522, quotedPoints: 600, pointsCapConstrained: true });
  });

  it("4,000 X posts fit one job: charge 469, reserve 539, not cut", async () => {
    const quote = await writer("social-x-posts", 4000);
    expect(quote).toMatchObject({ targetVolumeMax: 4000, expectedPoints: 469, quotedPoints: 539, pointsCapConstrained: false });
  });

  it("300 records of each tester service: charge and reserve", async () => {
    expect([(await writer("social-x-posts", 300)).expectedPoints, (await writer("social-x-posts", 300)).quotedPoints]).toEqual([36, 41]);
    for (const slug of ["social-youtube-comments", "social-tiktok-comments"]) {
      const quote = await writer(slug, 300);
      expect([quote.expectedPoints, quote.quotedPoints], slug).toEqual([83, 95]);
    }
  });

  it("1,000 records of each service: charge and reserve, and whether the cap cut the plan", async () => {
    // [charge, reserve, cut by the cap]: 1,000 Facebook, company and large per-record plans pass 600 points and are cut to what fits
    const expected: Record<string, [number, number, boolean]> = {
      "social-x-posts": [118, 135, false], "social-youtube-comments": [275, 317, false], "social-tiktok-comments": [275, 317, false],
      "social-facebook-comments": [522, 600, true], "social-facebook-posts": [521, 599, true], "icypeas-companies-search": [520, 598, true],
    };
    for (const slug of SLUGS) {
      const quote = await writer(slug, 1000);
      expect([quote.expectedPoints, quote.quotedPoints, Boolean(quote.pointsCapConstrained)], slug).toEqual(expected[slug]);
      expect(quote.quotedPoints, slug).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP);
    }
  });

  it("the largest sellable job per service at the 600 cap", () => {
    const largest = Object.fromEntries(SLUGS.map((slug) => {
      const unit = computePublicCalculatorQuote(slug, 1).unitPricePoints;
      return [slug, { unit, records: maxRecordsInOneJob(unit), charge: chargeForUnits(maxRecordsInOneJob(unit), unit) }];
    }));
    expect(largest["social-x-posts"]).toEqual({ unit: 0.11715, records: 4453, charge: 522 });
    expect(largest["social-youtube-comments"]).toEqual({ unit: 0.275, records: 1897, charge: 522 });
    expect(largest["social-tiktok-comments"]).toEqual({ unit: 0.275, records: 1897, charge: 522 });
    expect(largest["social-facebook-comments"]).toEqual({ unit: 1.034, records: 504, charge: 522 });
    expect(largest["social-facebook-posts"]).toEqual({ unit: 3.4485, records: 151, charge: 521 });
    expect(largest["icypeas-companies-search"]).toEqual({ unit: 3.168, records: 164, charge: 520 });
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
