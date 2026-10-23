import { describe, expect, it } from "vitest";
import {
  capNeededForCharge, chargeForUnits, maxChargeInOneJob, maxRecordsInOneJob, maxVolumeUnderCap, pointsDisplay, pricePer100Points,
  recordUnitPricePoints, RECORD_COSTS, reserveForUnits, unitPricePointsFromCost,
} from "../src/lib/recordPricing";
import { JOB_MAX_POINTS_CAP, effectiveJobPointsCap } from "../src/lib/jobPointsCap";

describe("unit price = cost per delivered record x 5,500, fractional", () => {
  it("the six capabilities price exactly as the owner's formula says", () => {
    expect(recordUnitPricePoints("social-x-posts")).toBe(0.11715);
    expect(recordUnitPricePoints("social-youtube-comments")).toBe(0.275);
    expect(recordUnitPricePoints("social-tiktok-comments")).toBe(0.275);
    expect(recordUnitPricePoints("social-facebook-comments")).toBe(1.034);
    expect(recordUnitPricePoints("social-facebook-posts")).toBe(3.4485);
    expect(recordUnitPricePoints("icypeas-companies-search")).toBe(3.168);
  });
  it("a capability with no per-record cost keeps its old rule (null here)", () => {
    expect(recordUnitPricePoints("professional-people-search")).toBeNull();
    expect(recordUnitPricePoints("social-youtube-videos")).toBeNull();
    expect(recordUnitPricePoints(undefined)).toBeNull();
  });
  it("every cost carries its basis, MEASURED or ASSUMED", () => {
    expect(Object.fromEntries(Object.entries(RECORD_COSTS).map(([k, v]) => [k, v.basis]))).toEqual({
      "social-x-posts": "MEASURED", "social-youtube-comments": "ASSUMED", "social-tiktok-comments": "ASSUMED",
      "social-facebook-comments": "ASSUMED", "social-facebook-posts": "ASSUMED", "icypeas-companies-search": "MEASURED",
    });
  });
  it("the price never undercuts its cost (rounded up at the sixth decimal)", () => {
    for (const cost of [0.0000213, 0.00005, 0.000188, 0.000627, 0.000576, 1e-7, 0.123456789]) {
      expect(unitPricePointsFromCost(cost)).toBeGreaterThanOrEqual(cost * 5500 - 1e-12);
      expect(unitPricePointsFromCost(cost) - cost * 5500).toBeLessThan(1.0001e-6);
    }
    expect(() => unitPricePointsFromCost(0)).toThrow();
  });
});

describe("charge = ceil(delivered x unit), reserve = ceil(volume x unit x 1.15), exact", () => {
  it("fractions that float arithmetic gets wrong are exact here", () => {
    // 0.1 x 3 is 0.30000000000000004 in floating point: a float ceil would charge 1 point more than the exact 0.3
    expect(chargeForUnits(3, 0.1)).toBe(1);
    expect(chargeForUnits(10, 0.1)).toBe(1);          // float: 1.0000000000000002 would ceil to 2? the exact product is 1
    expect(chargeForUnits(100, 0.12)).toBe(12);
    expect(chargeForUnits(25, 0.12)).toBe(3);
    expect(chargeForUnits(1000, 0.28)).toBe(280);
    expect(chargeForUnits(1, 3.17)).toBe(4);
    expect(chargeForUnits(100, 3.17)).toBe(317);
    expect(chargeForUnits(7, 193)).toBe(1351);
    expect(chargeForUnits(0, 0.12)).toBe(0);
    expect(chargeForUnits(-5, 0.12)).toBe(0);
  });
  it("the 15% buffer is on the reserve only", () => {
    expect(chargeForUnits(1000, 0.28)).toBe(280);
    expect(reserveForUnits(1000, 0.28)).toBe(322);       // 280 x 1.15 = 322 exactly
    expect(reserveForUnits(1000, 0.28, 0)).toBe(280);
    expect(reserveForUnits(37_500, 0.11715)).toBe(5053);   // 4393.125 x 1.15 = 5052.09375
    expect(chargeForUnits(37_500, 0.11715)).toBe(4394);
  });
  it("charge never exceeds reserve for any delivered <= volume (20,000 random cases)", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 20_000; i += 1) {
      const unit = Math.max(1, Math.floor(rnd() * 250_000)) / 1000;
      const volume = 1 + Math.floor(rnd() * 100_000);
      const delivered = Math.floor(rnd() * (volume + 1));
      expect(chargeForUnits(delivered, unit)).toBeLessThanOrEqual(reserveForUnits(volume, unit));
    }
  });
});

describe("the sizes at the 600-point cap", () => {
  it("maxVolumeUnderCap is the exact largest volume whose reserve fits", () => {
    for (const unit of [0.11715, 0.275, 1.034, 3.168, 3.4485, 193, 0.5, 1, 5]) {
      const n = maxVolumeUnderCap(JOB_MAX_POINTS_CAP, unit);
      expect(reserveForUnits(n, unit)).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP);
      expect(reserveForUnits(n + 1, unit)).toBeGreaterThan(JOB_MAX_POINTS_CAP);
    }
    expect(maxVolumeUnderCap(0, 1)).toBe(0);
    expect(maxVolumeUnderCap(10, 100)).toBe(0);
  });
  it("the largest sellable job has a charge of about 521 (the buffer is held back): per capability", () => {
    expect(maxRecordsInOneJob(1)).toBe(521);
    expect(maxChargeInOneJob(1)).toBe(521);
    expect(maxRecordsInOneJob(0.11715)).toBe(4453);
    expect(maxChargeInOneJob(0.11715)).toBe(522);
    expect(maxRecordsInOneJob(0.275)).toBe(1897);
    expect(maxRecordsInOneJob(1.034)).toBe(504);
    expect(maxRecordsInOneJob(3.168)).toBe(164);
    expect(maxRecordsInOneJob(3.4485)).toBe(151);
  });
  it("an X job of 4,000 posts holds 539 points (charge 469): it fits the cap", () => {
    expect(chargeForUnits(4000, 0.11715)).toBe(469);
    expect(reserveForUnits(4000, 0.11715)).toBe(539);
    expect(reserveForUnits(4000, 0.11715)).toBeLessThanOrEqual(JOB_MAX_POINTS_CAP);
  });
  it("a 500-point mission needs a reserve of 575: a cap of 575 or more fits it, the cap of 600 does", () => {
    expect(capNeededForCharge(500)).toBe(575);
    expect(reserveForUnits(500, 1)).toBe(575);
    expect(maxChargeInOneJob(1, 574)).toBeLessThan(500);
    expect(maxChargeInOneJob(1, 575)).toBeGreaterThanOrEqual(500);
    expect(maxChargeInOneJob(1)).toBeGreaterThanOrEqual(500);
  });
  it("the shared cap constant is 25,000 and the environment can only lower it", () => {
    expect(JOB_MAX_POINTS_CAP).toBe(25000);
    expect(effectiveJobPointsCap({})).toBe(25000);
    expect(effectiveJobPointsCap({ JOB_MAX_POINTS_CAP: "300" })).toBe(300);
    expect(effectiveJobPointsCap({ JOB_MAX_POINTS_CAP: "600" })).toBe(600);
    expect(effectiveJobPointsCap({ JOB_MAX_POINTS_CAP: "99999" })).toBe(25000);
    expect(effectiveJobPointsCap({ JOB_MAX_POINTS_CAP: "abc" })).toBe(25000);
  });
});

describe("what the customer reads", () => {
  it("points show at most two decimals, only where needed, rounded up", () => {
    expect(pointsDisplay(12)).toBe("12");
    expect(pointsDisplay(0.11715)).toBe("0.12");
    expect(pointsDisplay(3.168)).toBe("3.17");
    expect(pointsDisplay(0.275)).toBe("0.28");
    expect(pointsDisplay(1.5)).toBe("1.5");
    expect(pointsDisplay(193)).toBe("193");
  });
  it("price per 100 records", () => {
    expect(pricePer100Points(0.11715)).toBe(11.72);
    expect(pricePer100Points(0.275)).toBe(27.5);
    expect(pricePer100Points(3.168)).toBe(316.8);
    expect(pricePer100Points(193)).toBe(19300);
  });
});
