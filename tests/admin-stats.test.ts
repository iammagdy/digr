import { describe, expect, it } from "vitest";
import { bucketDays, dayIndex, lastMonths, margin, monthLabelAr, netProfit, pctChange, refundPointsByJob, splitPeriods } from "../src/lib/server/adminStats";

const NOW = new Date("2026-10-11T12:00:00Z").getTime();
const ago = (days: number) => new Date(NOW - days * 86400000 - 1000).toISOString();

describe("admin stats helpers", () => {
  it("buckets rows by day and splits current vs previous period", () => {
    const rows = [
      { at: ago(0), v: 100 }, { at: ago(0), v: 50 }, { at: ago(1), v: 10 },   // current (R=2)
      { at: ago(2), v: 5 }, { at: ago(3), v: 5 },                              // previous
      { at: ago(9), v: 999 },                                                  // outside both windows
    ];
    const daily = bucketDays(rows, 2, NOW, (r) => r.at, (r) => r.v);
    expect(daily).toEqual([150, 10, 5, 5]);
    const { current, previous, sumCurrent, sumPrevious } = splitPeriods(daily, 2);
    expect(current).toEqual([10, 150]); // oldest → newest
    expect(previous).toEqual([5, 5]);
    expect(sumCurrent).toBe(160);
    expect(sumPrevious).toBe(10);
  });

  it("ignores future and missing timestamps", () => {
    expect(dayIndex(undefined, NOW)).toBe(-1);
    expect(dayIndex(new Date(NOW + 5000).toISOString(), NOW)).toBe(-1);
  });

  it("computes % change, profit and margin without dividing by zero", () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(5, 0)).toBe(0);
    expect(netProfit(1000, 300)).toBe(700);
    expect(margin(1000, 300)).toBe(70);
    expect(margin(0, 10)).toBeNull();
  });

  it("derives refunds from the ledger: release − charge per job (a failed job refunds everything)", () => {
    const refunds = refundPointsByJob([
      { type: "reserve", jobId: "a", delta: -85, createdAt: "2026-10-01" },
      { type: "release", jobId: "a", delta: 85, createdAt: "2026-10-02" },
      { type: "charge", jobId: "a", delta: -78, createdAt: "2026-10-02" },
      { type: "reserve", jobId: "b", delta: -45, createdAt: "2026-10-03" },
      { type: "release", jobId: "b", delta: 45, createdAt: "2026-10-03" },
      { type: "reserve", jobId: "c", delta: -45, createdAt: "2026-10-04" }, // still running: no release
    ]);
    expect(refunds.get("a")?.refund).toBe(7);
    expect(refunds.get("b")?.refund).toBe(45);
    expect(refunds.has("c")).toBe(false);
  });

  it("lists calendar months newest first with Arabic labels", () => {
    expect(lastMonths(3, new Date(2026, 9, 11))).toEqual(["2026-10", "2026-09", "2026-08"]);
    expect(monthLabelAr("2026-10", true)).toBe("أكتوبر ٢٠٢٦ (حتى الآن)");
    expect(monthLabelAr("2026-09", false)).toBe("سبتمبر ٢٠٢٦");
  });
});
