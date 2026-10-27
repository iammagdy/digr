import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { closePageLineAr } from "../src/lib/driverMode";
import { POST_APPROVAL_CRON_AR, POST_APPROVAL_TAB_AR } from "../src/lib/postApproval";
import { jobStartedNotice } from "../src/lib/server/jobNotices";
import { expiryShortAr } from "../src/lib/quoteApprovalState";

/**
 * Task D of the remaining failures: the customer's text says what is true. A temporary hold is RELEASED, never «refunded» (the wallet already says
 * «تحرير حجز مؤقت»); the page guidance never promises the job continues when the page is closed while the page is what drives it; the offer's
 * countdown moves with the clock; the plan card labels the hold.
 */
const SRC = (file: string) => readFileSync(file, "utf8");
const CUSTOMER_FILES = [
  "src/app/api/worker/chunk/route.ts",
  "src/lib/server/providerLimits.ts",
  "src/lib/server/providerGate.ts",
  "src/lib/server/multiProvider/chainRunner.ts",
  "src/lib/server/multiProvider/chainAdapter.ts",
  "src/app/api/admin/jobs/recover/route.ts",
  "src/functions/shared/multiStepWorker.ts",
  "src/functions/job-worker/src/main.ts",
  "src/app/dashboard/chat/components/ResearchDocument.tsx",
];

describe("D1: «استرداد» is gone from what a failed or empty job says; the hold is released", () => {
  it("no customer-facing worker, gate or limit message says refund (استرداد / استرجاع / استُرد)", () => {
    for (const file of CUSTOMER_FILES) expect(SRC(file), file).not.toMatch(/استرداد|استرجاع|استُرد/);
  });

  it("the replacement sentence is the honest one, in every message that carried the old one", () => {
    const worker = SRC("src/app/api/worker/chunk/route.ts");
    expect(worker.match(/حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد/g)!.length).toBeGreaterThanOrEqual(10);
    expect(worker).toContain("(حجز مؤقت مُحرَّر ${pointsAr(Math.round(releasedCredits), toArabicDigits)}، ولم يُخصم شيء)");
    expect(SRC("src/lib/server/providerLimits.ts")).toContain("حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد");
    expect(SRC("src/lib/server/providerGate.ts")).toContain("حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد");
  });
});

describe("D2: the page guidance says one thing", () => {
  it("while the page drives the job (the default), the only guidance is «أبقِ الصفحة مفتوحة حتى تكتمل المهمة»", () => {
    expect(closePageLineAr("tab")).toBe("أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    expect(POST_APPROVAL_TAB_AR).toBe("جاري سحب البيانات. أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    for (const driver of ["tab", undefined] as const) {
      const body = jobStartedNotice({ targetVolumeMax: 1500, driver }).body;
      expect(body).toContain("أبقِ الصفحة مفتوحة حتى تكتمل المهمة");
      expect(body).not.toMatch(/عودتك|فستكمل|إغلاق الصفحة|أغلقتها/);
    }
    for (const text of [closePageLineAr("tab"), POST_APPROVAL_TAB_AR]) expect(text).not.toMatch(/عودتك|فستكمل|تقفل|إغلاق الصفحة|أغلقتها/);
  });

  it("the always-on driver keeps its own sentence (closing the page is allowed only then)", () => {
    expect(closePageLineAr("cron")).toBe("تقدر تقفل الصفحة وتروح تشرب قهوة، هنكمّل الشغل وهنبعتلك إيميل أول ما نخلص.");
    expect(POST_APPROVAL_CRON_AR).toContain("تقدر تقفل الصفحة");
  });
});

describe("D3: the offer's countdown is read from the quote's own expiry and the clock", () => {
  const expires = "2026-10-23T12:30:00.000Z";
  const at = (iso: string) => new Date(iso).getTime();
  it("it moves with the clock: ٢٩ → ٢٨ → ١٥ → ١ minutes, then nothing once the offer expired", () => {
    expect(expiryShortAr(expires, at("2026-10-23T12:00:30.000Z"))).toBe("ينتهي العرض خلال ٢٩ دقيقة");
    expect(expiryShortAr(expires, at("2026-10-23T12:01:30.000Z"))).toBe("ينتهي العرض خلال ٢٨ دقيقة");
    expect(expiryShortAr(expires, at("2026-10-23T12:15:00.000Z"))).toBe("ينتهي العرض خلال ١٥ دقيقة");
    expect(expiryShortAr(expires, at("2026-10-23T12:29:40.000Z"))).toBe("ينتهي العرض خلال ١ دقيقة");
    expect(expiryShortAr(expires, at("2026-10-23T12:30:00.000Z"))).toBe("");
    expect(expiryShortAr(expires, at("2026-10-23T13:00:00.000Z"))).toBe("");
    expect(expiryShortAr("not a date", at("2026-10-23T12:00:00.000Z"))).toBe("");
  });

  it("an offer that lasts hours says hours", () => {
    expect(expiryShortAr("2026-10-23T15:00:00.000Z", at("2026-10-23T12:00:30.000Z"))).toBe("ينتهي العرض خلال ٢ ساعة");
  });
});

describe("D4: the plan card labels the hold", () => {
  const card = (extra: Partial<PlanQuoteData> = {}) => renderToStaticMarkup(createElement(PlanQuoteCard, {
    quote: {
      quoteId: "q_hold", summaryAr: "سحب تعليقات", items: [{ capabilitySlug: "social-tiktok-comments", params: { query: "كرة السلة", region: "EG" }, targetVolumeMin: 1, targetVolumeMax: 100 }],
      targetVolumeMax: 100, unitPricePoints: 3, expectedPoints: 300, quotedPoints: 345, isAffordable: true, userBalance: 5000, outputFormats: ["xlsx"],
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), status: "quoted", ...extra,
    } as PlanQuoteData,
    locked: false, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {},
  } as any));

  it("the hold, what is charged and that only a delivered record is charged are said ONCE (one price, one hold figure, one deduct sentence)", () => {
    const html = card();
    expect(html).toContain('data-testid="plan-price-vs-hold"');
    expect(html).toContain("السعر التقديري ٣٠٠ نقطة");
    expect(html).toContain("ويُخصم منه فقط ما يُسلَّم فعلًا");
    expect(html).toContain("والحجز المؤقت ٣٤٥ نقطة هو هذا السعر مع احتياطي ١٥٪ على الحجز وحده");
    expect(html.split("٣٤٥ نقطة").length - 1).toBe(1);
    expect(html.split("يُخصم فقط مقابل").length - 1).toBe(0);
    expect(html).not.toContain('data-testid="plan-hold-line"');
    expect(html).not.toContain('data-testid="plan-cap-line"');
    expect(html).not.toMatch(/استرداد|استرجاع/);
  });
});
