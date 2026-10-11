/**
 * Regression tests for the PR #11 data-honesty corrections:
 *  - failed balance requests never display as zero
 *  - genuine zero and positive balances display correctly
 *  - derived amounts are suppressed when the balance is unknown
 *  - job totals come from the response total, never from the page length
 *  - activity timelines never claim unrecorded stage completion
 *  - limited event histories are always scope-labeled
 */
import { describe, it, expect } from "vitest";
import {
  balanceLoading,
  balanceReady,
  balanceFailed,
  balanceText,
  showDerivedAmounts,
  jobTotalFromResponse,
  jobCountText,
  timelineWaitingText,
  EVENT_HISTORY_LIMIT,
  eventHistoryScopeLabel,
  chronological,
  methodologyAlertText,
  methodologyMessageText,
} from "../src/lib/honestDisplay";

describe("balance states", () => {
  it("genuine zero balance displays as zero, not as unavailable", () => {
    const view = balanceReady(0);
    expect(balanceText(view)).toBe((0).toLocaleString("ar-EG"));
    expect(showDerivedAmounts(view)).toBe(true);
  });

  it("successful positive balance displays the real value", () => {
    const view = balanceReady(1500);
    expect(balanceText(view)).toBe((1500).toLocaleString("ar-EG"));
    expect(showDerivedAmounts(view)).toBe(true);
  });

  it("failed balance fetch never displays as zero", () => {
    const view = balanceFailed();
    expect(balanceText(view)).not.toContain("٠");
    expect(balanceText(view)).toBe("غير متاح");
    expect(view.value).toBeNull();
  });

  it("derived EGP amounts are suppressed when balance is unknown", () => {
    expect(showDerivedAmounts(balanceFailed())).toBe(false);
    expect(showDerivedAmounts(balanceLoading())).toBe(false);
    expect(showDerivedAmounts(balanceReady(0))).toBe(true);
  });

  it("loading state is distinguishable from failure", () => {
    expect(balanceText(balanceLoading())).toBe("…");
    expect(balanceText(balanceFailed())).toBe("غير متاح");
  });
});

describe("job totals", () => {
  it("uses the authoritative response total", () => {
    expect(jobTotalFromResponse(42)).toBe(42);
  });

  it("returns null for missing or invalid totals — never the page length", () => {
    expect(jobTotalFromResponse(undefined)).toBeNull();
    expect(jobTotalFromResponse(null)).toBeNull();
    expect(jobTotalFromResponse("42")).toBeNull();
    expect(jobTotalFromResponse(-1)).toBeNull();
    expect(jobTotalFromResponse(Number.NaN)).toBeNull();
  });

  it("renders unavailable text when the total is unknown", () => {
    expect(jobCountText(null)).toBe("غير متاح");
    expect(jobCountText(7)).toBe((7).toLocaleString("ar-EG"));
  });
});

describe("activity timeline honesty", () => {
  it("waiting text never claims a completed stage", () => {
    const statuses = ["queued", "running", "done", "failed", "cancelled"] as const;
    for (const s of statuses) {
      const text = timelineWaitingText(s);
      expect(text).not.toMatch(/مكتمل|اكتملت|✓/);
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it("waiting text references recorded events, not assumed stages", () => {
    expect(timelineWaitingText("running")).toContain("حدث مسجَّل");
    expect(timelineWaitingText("queued")).toContain("لم تُسجَّل");
  });
});

describe("event history scope", () => {
  it("limit constant and scope label stay in sync", () => {
    expect(EVENT_HISTORY_LIMIT).toBe(20);
    expect(eventHistoryScopeLabel()).toContain((20).toLocaleString("ar-EG"));
  });

  it("chronological() restores reading order from a desc-fetched page", () => {
    const desc = [{ id: 3 }, { id: 2 }, { id: 1 }];
    expect(chronological(desc).map((d) => d.id)).toEqual([1, 2, 3]);
    // does not mutate the input
    expect(desc.map((d) => d.id)).toEqual([3, 2, 1]);
  });
});

describe("methodology charge honesty (regression: hardcoded 10-point claim)", () => {
  it("reports the actual server-reported charge, whatever it is", () => {
    expect(methodologyAlertText(10)).toContain((10).toLocaleString("ar-EG"));
    expect(methodologyAlertText(25)).toContain((25).toLocaleString("ar-EG"));
    expect(methodologyAlertText(25)).not.toContain("اقتطاع 10");
    expect(methodologyAlertText(0)).toContain("اقتطاع");
  });

  it("makes no monetary claim when the server value is untrustworthy", () => {
    for (const bad of [undefined, null, Number.NaN, -5, "10", {}]) {
      const text = methodologyAlertText(bad as unknown);
      expect(text).not.toContain("اقتطاع");
      expect(text).not.toMatch(/\d/);
      expect(text).toContain("بنجاح");
    }
  });

  it("message includes charge and balance only when both are trustworthy", () => {
    const withValues = methodologyMessageText(10, 290, "نص المنهجية");
    expect(withValues).toContain("خصم 10 نقاط");
    expect(withValues).toContain("290");
    expect(withValues).toContain("نص المنهجية");

    const missing = methodologyMessageText(undefined, undefined, "نص المنهجية");
    expect(missing).not.toContain("خصم");
    expect(missing).not.toContain("undefined");
    expect(missing).toContain("نص المنهجية");
  });
});
