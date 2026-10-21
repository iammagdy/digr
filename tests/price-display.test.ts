import { describe, expect, it } from "vitest";
import { unitPriceEgpLabelAr, unitPriceLabelAr } from "../src/lib/pointsFormat";
import { RECORD_COSTS, chargeForUnits, pricePer100Points, recordUnitPricePoints } from "../src/lib/recordPricing";

describe("a unit price is shown as the price of 100 records, never as a rounded per-record price", () => {
  it("fractional prices say «per 100», whole-point prices keep the per-record wording", () => {
    expect(unitPriceLabelAr(0.11715, "منشور")).toBe("حوالي ١١٫٧٢ نقطة لكل ١٠٠ منشور");
    expect(unitPriceLabelAr(0.275)).toBe("حوالي ٢٧٫٥ نقطة لكل ١٠٠ سجل");
    expect(unitPriceLabelAr(3.168)).toBe("حوالي ٣١٦٫٨ نقطة لكل ١٠٠ سجل");
    expect(unitPriceLabelAr(6, "فيديو")).toBe("٦ نقطة لكل فيديو");
    expect(unitPriceEgpLabelAr(0.11715)).toBe("١٫١٧٢ ج.م لكل ١٠٠ سجل");
  });

  it("the shown price of 100 records is within one point of the real charge at 100 and at 1,000 records, for every per-record service", () => {
    for (const slug of Object.keys(RECORD_COSTS)) {
      const unit = recordUnitPricePoints(slug)!;
      const per100 = pricePer100Points(unit);
      for (const n of [100, 1000]) {
        const real = chargeForUnits(n, unit);
        const fromShown = (per100 * n) / 100;
        expect(Math.abs(fromShown - real), `${slug} at ${n}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("a per-record price rounded to two decimals would drift further: up to 5 points at 1,000 comments (the reason the per-record price is not shown)", () => {
    const unit = recordUnitPricePoints("social-youtube-comments")!;
    const rounded = Math.round(unit * 100 + 1e-9) / 100;
    expect(Math.abs(rounded * 1000 - chargeForUnits(1000, unit))).toBeCloseTo(5, 6);
  });
});
