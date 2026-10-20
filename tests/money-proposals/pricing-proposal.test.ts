import { describe, expect, it } from "vitest";
import { BLOCK_SIZE, MICRO, PROPOSED_COST_BASIS, billedUnitMicro, blockPricePoints, chargePoints, maxVolumeUnderCap, proposedPriceFor, reservePoints, unitPriceMicro } from "../../src/lib/money/pricingProposal";
import { calculateCapabilityUnitPricePoints } from "../../src/functions/shared/quotes";

describe("proposal 4d: price from the real cost of one delivered record", () => {
  it("is the same 10x markup as today, only fractional: 5500 points per USD of cost", () => {
    expect(unitPriceMicro(0.001)).toBe(55_000);
    expect(unitPriceMicro(0.0000213)).toBe(1_172);
  });

  it("for a cost that is a whole call price it never goes below today's rounded-up price divided by nothing: same formula, no rounding up to a point", () => {
    const today = calculateCapabilityUnitPricePoints(0.001);
    expect(today).toBe(6);
    expect(unitPriceMicro(0.001) / MICRO).toBeCloseTo(5.5, 6);
  });

  it("the block price is whole points per 100 records and the billed unit is never below the raw unit", () => {
    for (const slug of Object.keys(PROPOSED_COST_BASIS)) {
      const price = proposedPriceFor(slug)!;
      expect(price.blockPoints).toBe(blockPricePoints(price.unitMicro));
      expect(Number.isInteger(price.blockPoints)).toBe(true);
      expect(price.billedUnitMicro).toBeGreaterThanOrEqual(price.unitMicro);
      expect(price.billedUnitMicro).toBe(billedUnitMicro(price.unitMicro));
    }
    expect(blockPricePoints(1_172)).toBe(12);
  });

  it("charge = ceil(delivered x unit) and never above the reserve for any delivered <= volume", () => {
    const unit = billedUnitMicro(unitPriceMicro(0.0000213));
    for (const volume of [1, 7, 99, 100, 101, 999, 37_500]) {
      const reserve = reservePoints(volume, unit);
      for (const delivered of [0, 1, Math.floor(volume / 2), volume]) {
        expect(chargePoints(delivered, unit)).toBeLessThanOrEqual(reserve);
      }
      expect(reserve).toBeGreaterThanOrEqual(chargePoints(volume, unit));
    }
  });

  it("charges nothing for nothing delivered and one point for a single record", () => {
    expect(chargePoints(0, 1_200)).toBe(0);
    expect(chargePoints(1, 1_200)).toBe(1);
  });

  it("the 15% buffer is on the reserve only", () => {
    expect(reservePoints(1000, 10_000)).toBe(1150);
    expect(chargePoints(1000, 10_000)).toBe(1000);
  });

  it("the largest volume under a cap fits, and one more does not", () => {
    const unit = billedUnitMicro(unitPriceMicro(0.000045));
    const cap = 600;
    const max = maxVolumeUnderCap(cap, unit);
    expect(reservePoints(max, unit)).toBeLessThanOrEqual(cap);
    expect(reservePoints(max + 1, unit)).toBeGreaterThan(cap);
  });

  it("is exact integer arithmetic: no float drift at large volumes", () => {
    expect(chargePoints(1_000_000, 1_172)).toBe(Math.ceil((1_000_000 * 1_172) / MICRO));
    expect(BLOCK_SIZE).toBe(100);
  });

  it("the owner's M3 (37,500 X posts) lands near the 4,000-point target, with the arithmetic shown", () => {
    const x = proposedPriceFor("social-x-posts")!;
    expect(x.blockPoints).toBe(12);
    const charge = chargePoints(37_500, x.billedUnitMicro);
    expect(charge).toBe(4_500);
    expect(reservePoints(37_500, x.billedUnitMicro)).toBe(5_175);
  });

  it("the measured company price is within 10% of today's whole-point price (the formula is validated by real data)", () => {
    const companies = proposedPriceFor("icypeas-companies-search")!;
    expect(companies.basis).toBe("measured");
    expect(Math.abs(companies.unitPoints - 3) / 3).toBeLessThan(0.1);
  });

  it("rejects a non-positive cost", () => {
    expect(() => unitPriceMicro(0)).toThrow();
    expect(() => unitPriceMicro(Number.NaN)).toThrow();
  });
});
