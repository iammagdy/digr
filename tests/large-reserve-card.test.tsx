import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { JOB_CONFIRM_ABOVE_POINTS, JOB_MAX_POINTS_CAP } from "../src/lib/jobPointsCap";

/** A reserve above 600 points needs the customer's own tick on the plan card before the approve button works. */
const quote = (extra: Partial<PlanQuoteData> = {}): PlanQuoteData => ({
  quoteId: "q1", summaryAr: "منشورات إكس", items: [{ capabilitySlug: "social-x-posts", params: { query: "x" }, targetVolumeMin: 1, targetVolumeMax: 37113 }],
  targetVolumeMax: 37113, unitPricePoints: 0.11715, expectedPoints: 4348, quotedPoints: 5000, isAffordable: true, userBalance: 9000, outputFormats: ["xlsx"],
  expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted", ...extra,
});
const render = (q: PlanQuoteData, available = 9000) =>
  renderToStaticMarkup(createElement(PlanQuoteCard, { quote: q, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));
const approveButton = (html: string) => html.match(/<button[^>]*>\s*أوافق وابدأ البحث\s*<\/button>/)?.[0] ?? "";

describe("above 600 points the plan shows the total hold, in points and pounds, and the approve button waits for the tick", () => {
  it("constants: 600 is the threshold, 5,000 the job cap", () => {
    expect(JOB_CONFIRM_ABOVE_POINTS).toBe(600);
    expect(JOB_MAX_POINTS_CAP).toBe(5000);
  });

  it("5,000 points held: the confirmation names the total in points and pounds, says only delivered records are charged, and the button is disabled", () => {
    const html = render(quote());
    expect(html).toContain('data-testid="large-reserve-confirm"');
    expect(html).toContain("٥٬٠٠٠ نقطة");
    expect(html).toContain("٥٠٠ ج.م");
    expect(html).toContain("لا يُخصم إلا ما يُسلَّم فعلًا من سجلات مطابقة");
    expect(html).toContain("أؤكد هذا الحجز");
    expect(html).toMatch(/type="checkbox"/);
    expect(html).not.toMatch(/checked=""/);
    expect(approveButton(html)).toMatch(/\sdisabled=""/);
  });

  it("600 points held or less: no confirmation, the button is enabled", () => {
    const html = render(quote({ quotedPoints: 600, expectedPoints: 522 }));
    expect(html).not.toContain('data-testid="large-reserve-confirm"');
    expect(approveButton(html)).not.toMatch(/\sdisabled=""/);
    const html601 = render(quote({ quotedPoints: 601 }));
    expect(html601).toContain('data-testid="large-reserve-confirm"');
    expect(approveButton(html601)).toMatch(/\sdisabled=""/);
  });

  it("the approve click carries the tick: the confirmation flag is true only when the card needs none or the customer ticked it", () => {
    const source = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8");
    expect(source).toContain("onStart(quote, { confirmedLargeReserve: !needsLargeConfirm || largeReserveConfirmed })");
    expect(source).toContain("disabled={isStarting || quote.isDependent || (needsLargeConfirm && !largeReserveConfirmed)}");
    // a new quote starts unticked
    expect(source).toContain("setLargeReserveConfirmed(false)");
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("confirmedLargeReserve: options?.confirmedLargeReserve === true");
  });

  it("a balance below the full reserve refuses the approval in plain Arabic and offers the top-up", () => {
    const html = render(quote(), 1200);
    expect(html).not.toContain(">أوافق وابدأ البحث<");
    expect(html).toContain("تحتاج");
    expect(html).toContain("شحن الرصيد");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/[A-Za-z]{2,}/);
  });

  it("the card states the price of one record, with at most two decimals and labelled as an estimate", () => {
    const html = render(quote());
    expect(html).toContain('data-testid="plan-unit-price"');
    expect(html).toContain("٠٫١٢ نقطة");
    expect(html).toContain("١١٫٧٢ نقطة لكل ١٠٠ سجل");
    expect(html).toContain("(تقديري)");
    expect(html).not.toContain("٠٫١١٧١٥");
  });
});
