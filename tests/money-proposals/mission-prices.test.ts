import { describe, expect, it } from "vitest";
import { billedUnitMicro, blockPricePoints, chargePoints, unitPriceMicro, proposedPriceFor, reservePoints, PROPOSED_COST_BASIS } from "../../src/lib/money/pricingProposal";

/**
 * The numbers quoted in docs/proposals/PROPOSAL_NUMBERS.md, pinned so the document cannot drift from the code.
 * Volumes: M1/M2 use the comment caps in the golden examples (2,000 and 3,000); M3 is the owner's 37,500; M4 has no stated volume,
 * so 2,000 posts is an ASSUMPTION; the B2B row is 50 companies.
 */
const MISSIONS = [
  { id: "M1", slug: "social-youtube-comments", volume: 2000, today: 9 },
  { id: "M2", slug: "social-youtube-comments", volume: 3000, today: 9 },
  { id: "M3", slug: "social-x-posts", volume: 37_500, today: 5 },
  { id: "M4", slug: "social-facebook-posts", volume: 2000, today: 11 },
  { id: "B2B", slug: "icypeas-companies-search", volume: 50, today: 3 },
] as const;

const EXPECTED: Record<string, { usd: number; charge: number; reserve: number; todayCharge: number }> = {
  M1: { usd: 0.1, charge: 560, reserve: 644, todayCharge: 18_000 },
  M2: { usd: 0.15, charge: 840, reserve: 966, todayCharge: 27_000 },
  M3: { usd: 0.79875, charge: 4_500, reserve: 5_175, todayCharge: 187_500 },
  M4: { usd: 1.254, charge: 6_900, reserve: 7_935, todayCharge: 22_000 },
  B2B: { usd: 0.0288, charge: 159, reserve: 183, todayCharge: 150 },
};

describe("mission prices under the proposed unit prices", () => {
  it.each(MISSIONS)("$id: cost, proposed price, reserve and today's price", ({ id, slug, volume, today }) => {
    const price = proposedPriceFor(slug)!;
    const expected = EXPECTED[id];
    expect(volume * PROPOSED_COST_BASIS[slug].costUsdPerRecord).toBeCloseTo(expected.usd, 6);
    expect(chargePoints(volume, price.billedUnitMicro)).toBe(expected.charge);
    expect(reservePoints(volume, price.billedUnitMicro)).toBe(expected.reserve);
    expect(volume * today).toBe(expected.todayCharge);
    expect(billedUnitMicro(price.unitMicro)).toBe(price.billedUnitMicro);
  });

  it("the missions at their real sizes (the document's rows)", () => {
    const yt = proposedPriceFor("social-youtube-comments")!;
    expect([chargePoints(25_000, yt.billedUnitMicro), reservePoints(25_000, yt.billedUnitMicro)]).toEqual([7_000, 8_050]);
    expect([chargePoints(5_000, yt.billedUnitMicro), reservePoints(5_000, yt.billedUnitMicro)]).toEqual([1_400, 1_610]);
    // the first-path price (500 comments per call) is 28 times lower: 1 point per 100
    expect(blockPricePoints(unitPriceMicro(PROPOSED_COST_BASIS["social-youtube-comments"].primaryCostUsdPerRecord!))).toBe(1);
    expect(proposedPriceFor("social-x-posts")!.blockPoints).toBe(12);
    expect(blockPricePoints(unitPriceMicro(PROPOSED_COST_BASIS["social-x-posts"].primaryCostUsdPerRecord!))).toBe(9);
    expect(blockPricePoints(unitPriceMicro(PROPOSED_COST_BASIS["social-facebook-posts"].primaryCostUsdPerRecord!))).toBe(110);
  });

  it("the proposed price is never below the cost at 10x (margin at least 90% of the markup rule)", () => {
    for (const { slug } of MISSIONS) {
      const price = proposedPriceFor(slug)!;
      const costPerRecordEgp = PROPOSED_COST_BASIS[slug].costUsdPerRecord * 55;
      expect(price.billedUnitMicro / 10_000 * 0.1).toBeGreaterThanOrEqual(costPerRecordEgp * 10 - 1e-9);
    }
  });

  it("referral arithmetic: 300 points given on a first 100-pound top-up leaves 87% margin before fees", () => {
    const pointsIssued = 1000 + 200 + 100;
    const revenuePerPoint = 100 / pointsIssued;
    expect(1 - 0.01 / revenuePerPoint).toBeCloseTo(0.87, 2);
  });
});
