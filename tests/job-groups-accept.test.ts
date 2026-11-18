import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isGroupQuoteItems, planSplit } from "../src/lib/server/multiProvider/jobGroupPlan";
import { reserveForUnits, DEFAULT_PRICING_BASIS } from "../src/lib/recordPricing";

describe("DT-05 PR-9 group approval", () => {
  it.each([
    [[], false],
    [null, false],
    [{ params: { split: { v: 3 } } }, false],
    [[{ params: {} }], false],
    [[{ params: { split: { v: 2 } } }], false],
    [[{ params: { split: { v: "3" } } }], false],
    [[{ params: { split: { v: 3 } } }, { params: { split: { v: 3 } } }], false],
    [[{ params: { split: { v: 3, part: 1 } } }], true],
  ])("isGroupQuoteItems(%j) is %s", (items, expected) => {
    expect(isGroupQuoteItems(items)).toBe(expected);
  });

  // plan T3 (a): the planSplit table, V = 40, unit 7, the pricing basis' own buffer
  const V = 40, UNIT = 7, BUF = DEFAULT_PRICING_BASIS.safetyBuffer;
  it.each([
    ["X = V + 1", V + 1, 41, 2, [40, 1]],
    ["X = 3V", 3 * V, 120, 3, [40, 40, 40]],
    ["X = 40V", 40 * V, 1600, 40, Array(40).fill(40)],
    ["X = 40V + 1 (beyond the part limit)", 40 * V + 1, 1600, 40, Array(40).fill(40)],
  ] as Array<[string, number, number, number, number[]]>)("(T3 a) planSplit %s", (_n, X, Y, K, volumes) => {
    const r = planSplit({ X, V, unit: UNIT, safetyBuffer: BUF });
    expect(r.Y).toBe(Y);
    expect(r.K).toBe(K);
    expect(r.partVolumes).toEqual(volumes);
    expect(r.partReserves).toEqual(volumes.map((v) => Math.max(1, reserveForUnits(v, UNIT, BUF))));
    expect(r.hold).toBe(r.partReserves.reduce((a, b) => a + b, 0));
    expect(r.partReserves[0]).toBe(Math.max(1, reserveForUnits(V, UNIT, BUF))); // = the single-job item reservation

    // Addendum A1 (N1): literal pins
    if (X === V + 1) {
      expect(r.partReserves).toEqual([322, 9]);
      expect(r.hold).toBe(331);
    } else if (X === 3 * V) {
      expect(r.hold).toBe(966);
    } else if (X === 40 * V) {
      expect(r.hold).toBe(12_880);
    }
  });
});
