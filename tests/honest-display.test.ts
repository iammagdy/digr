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
  formatNumber,
  formatPoints,
  formatCurrency,
  formatDate,
  formatTime,
  JOB_STATUS_LABEL_MAP,
  JOB_STATUS_TONE_MAP,
  formatJobStatus,
  formatJobStatusTone,
  isInstapayAvailable,
  groupLedgerEntries,
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
    expect(withValues).toContain(`خصم ${formatNumber(10)} نقاط`);
    expect(withValues).toContain(formatNumber(290));
    expect(withValues).toContain("نص المنهجية");

    const missing = methodologyMessageText(undefined, undefined, "نص المنهجية");
    expect(missing).not.toContain("خصم");
    expect(missing).not.toContain("undefined");
    expect(missing).toContain("نص المنهجية");
  });
});

describe("shared numeral system (Arabic-Indic digits)", () => {
  it("formats integers consistently with Arabic-Indic numerals", () => {
    expect(formatNumber(4993)).toBe("٤٬٩٩٣");
    expect(formatNumber(0)).toBe("٠");
    expect(formatNumber(1000)).toBe("١٬٠٠٠");
  });

  it("formats decimals consistently with Arabic-Indic numerals and proper fraction digits", () => {
    expect(formatNumber(0.1, { minimumFractionDigits: 2 })).toBe("٠٫١٠");
    expect(formatNumber(499.3, { minimumFractionDigits: 2, maximumFractionDigits: 2 })).toBe("٤٩٩٫٣٠");
  });

  it("formats points with proper Arabic plurals and numerals", () => {
    expect(formatPoints(1)).toBe("١ نقطة");
    expect(formatPoints(2)).toBe("٢ نقطة");
    expect(formatPoints(5)).toBe("٥ نقاط");
    expect(formatPoints(10)).toBe("١٠ نقاط");
    expect(formatPoints(11)).toBe("١١ نقطة");
    expect(formatPoints(0)).toBe("٠ نقطة");
  });

  it("formats currency with Arabic-Indic numerals and EGP symbol", () => {
    expect(formatCurrency(499.3)).toBe("٤٩٩٫٣٠ ج.م");
    expect(formatCurrency(0)).toBe("٠٫٠٠ ج.م");
  });

  it("formats dates and times using Arabic-Indic digits", () => {
    const iso = "2026-10-11T12:30:00Z";
    const dateFormatted = formatDate(iso);
    expect(dateFormatted).toMatch(/[٠-٩]/);
    const timeFormatted = formatTime(iso);
    expect(timeFormatted).toMatch(/[٠-٩]/);
  });
});

describe("job status label mapping (no English)", () => {
  it("maps all supported job statuses to unambiguous Arabic terms", () => {
    expect(JOB_STATUS_LABEL_MAP.queued).toBe("في الانتظار");
    expect(JOB_STATUS_LABEL_MAP.running).toBe("قيد التنفيذ");
    expect(JOB_STATUS_LABEL_MAP.done).toBe("مكتمل");
    expect(JOB_STATUS_LABEL_MAP.failed).toBe("متعثر");
    expect(JOB_STATUS_LABEL_MAP.cancelled).toBe("ملغي");
  });

  it("formatJobStatus helper formats known and fallback statuses cleanly", () => {
    expect(formatJobStatus("queued")).toBe("في الانتظار");
    expect(formatJobStatus("running")).toBe("قيد التنفيذ");
    expect(formatJobStatus("done")).toBe("مكتمل");
    expect(formatJobStatus("failed")).toBe("متعثر");
    expect(formatJobStatus("cancelled")).toBe("ملغي");
    expect(formatJobStatus("custom_status")).toBe("غير معروف");
  });

  it("maps status tones accurately to UI status tones", () => {
    expect(JOB_STATUS_TONE_MAP.queued).toBe("warning");
    expect(JOB_STATUS_TONE_MAP.running).toBe("info");
    expect(JOB_STATUS_TONE_MAP.done).toBe("success");
    expect(JOB_STATUS_TONE_MAP.failed).toBe("danger");
    expect(JOB_STATUS_TONE_MAP.cancelled).toBe("neutral");
    expect(formatJobStatusTone("queued")).toBe("warning");
    expect(formatJobStatusTone("other")).toBe("neutral");
  });
});

describe("instapay placeholder guardrail", () => {
  it("returns false if handle or phone is missing or empty", () => {
    expect(isInstapayAvailable(undefined, undefined)).toBe(false);
    expect(isInstapayAvailable("", "")).toBe(false);
    expect(isInstapayAvailable("real@instapay", "")).toBe(false);
    expect(isInstapayAvailable("", "01012345678")).toBe(false);
  });

  it("returns false if handle or phone matches placeholder strings", () => {
    expect(isInstapayAvailable("digr@instapay", "01000000000")).toBe(false);
    expect(isInstapayAvailable("placeholder", "01012345678")).toBe(false);
    expect(isInstapayAvailable("real@instapay", "010xxxxxxxx")).toBe(false);
    expect(isInstapayAvailable("example@instapay", "1234567890")).toBe(false);
  });

  it("returns true only for non-placeholder, valid configured values", () => {
    expect(isInstapayAvailable("merchant_account@instapay", "01098765432")).toBe(true);
  });
});

describe("grouped ledger entries (one net row per job)", () => {
  it("groups hold, release, and charge movements into a single net customer row", () => {
    const rawEntries = [
      {
        $id: "e1",
        description: "خصم نهائي: تحليل حساب @iam_megz (2 نقطة)",
        delta: -2,
        balanceAfter: 298,
        referenceType: "job",
        referenceId: "chg_job_123",
        createdAt: "2026-10-10T12:05:00Z",
      },
      {
        $id: "e2",
        description: "تحرير الحجز: تحليل حساب @iam_megz",
        delta: 5,
        balanceAfter: 300,
        referenceType: "job",
        referenceId: "rel_job_123",
        createdAt: "2026-10-10T12:04:00Z",
      },
      {
        $id: "e3",
        description: "حجز مؤقت: تحليل حساب @iam_megz",
        delta: -5,
        balanceAfter: 295,
        referenceType: "job",
        referenceId: "res_job_123",
        createdAt: "2026-10-10T12:00:00Z",
      },
    ];

    const grouped = groupLedgerEntries(rawEntries);
    expect(grouped).toHaveLength(1);
    const row = grouped[0];
    expect(row.isJobGroup).toBe(true);
    expect(row.delta).toBe(-2);
    expect(row.title).toBe("خصم ٢ نقطة · تحليل @iam_megz");
    expect(row.movements).toHaveLength(3);
  });

  it("preserves non-job entries as independent rows", () => {
    const rawEntries = [
      {
        $id: "t1",
        description: "شحن رصيد معتمد",
        delta: 100,
        balanceAfter: 400,
        referenceType: "topup",
        referenceId: "topup_abc",
        createdAt: "2026-10-10T13:00:00Z",
      },
      {
        $id: "e1",
        description: "خصم نهائي: تحليل @test (1 نقطة)",
        delta: -1,
        balanceAfter: 300,
        referenceType: "job",
        referenceId: "chg_job_999",
        createdAt: "2026-10-10T12:00:00Z",
      },
    ];

    const grouped = groupLedgerEntries(rawEntries);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].isJobGroup).toBe(false);
    expect(grouped[0].delta).toBe(100);
    expect(grouped[0].title).toBe("شحن رصيد معتمد");
    expect(grouped[1].isJobGroup).toBe(true);
    expect(grouped[1].delta).toBe(-1);
  });
});

