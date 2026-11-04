import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { METHODOLOGY_BOUGHT_LINE_AR, METHODOLOGY_CONFIRM_LINE_AR, METHODOLOGY_PRICE_LINE_AR, MethodologyOfferBody } from "../src/components/mission/MethodologyOffer";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { METHODOLOGY_CHOOSER_SENTENCE_AR } from "../src/lib/agentMission/messageType";
import { checkCustomerText } from "../src/lib/agentMission/text";

/** ROUND 21, item 3: what the customer SEES of the methodology: the price line before anything is asked, the confirmation inside the page, the bought state with a free download. */
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const visible = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

describe("the offer", () => {
  it("before approval it says «منهجية الجمع لهذا الطلب: ٥٠ نقطة» and offers one button; nothing is charged by looking", () => {
    expect(METHODOLOGY_PRICE_LINE_AR).toBe("منهجية الجمع لهذا الطلب: ٥٠ نقطة");
    const markup = html(createElement(MethodologyOfferBody, { titleAr: "تعليقات منشورات - ٨", deliveredUnits: 8, purchased: false }));
    expect(visible(markup)).toContain(METHODOLOGY_PRICE_LINE_AR);
    expect(markup).toContain('data-testid="methodology-offer-ask"');
    expect(markup).not.toContain('data-testid="methodology-offer-confirm"');
    expect(markup).not.toContain('data-testid="methodology-offer-download"');
  });
  it("asking opens the confirmation inside the page: the amount, once for this request, and a cancel button; the charge is made only by the confirm button", () => {
    const markup = html(createElement(MethodologyOfferBody, { purchased: false, step: "confirm" }));
    expect(visible(markup)).toContain(METHODOLOGY_CONFIRM_LINE_AR);
    expect(METHODOLOGY_CONFIRM_LINE_AR).toContain("٥٠ نقطة");
    expect(markup).toContain('data-testid="methodology-offer-confirm"');
    expect(markup).toContain('data-testid="methodology-offer-cancel"');
  });
  it("bought: the price line is gone, the line says the download is free, and the button downloads", () => {
    const markup = html(createElement(MethodologyOfferBody, { purchased: true }));
    expect(visible(markup)).toContain(METHODOLOGY_BOUGHT_LINE_AR);
    expect(visible(markup)).not.toContain("٥٠ نقطة");
    expect(markup).toContain('data-testid="methodology-offer-download"');
    expect(markup).not.toContain('data-testid="methodology-offer-ask"');
  });
  it("every sentence is formal Arabic that passes the customer-text check (no provider, no dollars, no «صف» or «سجل»)", () => {
    for (const t of [METHODOLOGY_PRICE_LINE_AR, METHODOLOGY_BOUGHT_LINE_AR, METHODOLOGY_CONFIRM_LINE_AR, METHODOLOGY_CHOOSER_SENTENCE_AR]) expect(checkCustomerText(t, { maxChars: 400 }).issues, t).toEqual([]);
  });
  it("the offer's delivered count says «عناصر», never «سجل»", () => {
    expect(visible(html(createElement(MethodologyOfferBody, { titleAr: "طلب", deliveredUnits: 120, purchased: false })))).toContain("١٢٠ عنصرًا");
  });
});

describe("the mission card and the chat", () => {
  const delivered = () => customerMissionView({ mission: { id: "m1", status: "completed", question_ar: null, plan_public: { compiled: true, summary_ar: "ستستلم ملف إكسل.", stages: [] } as never, reserved_points: 230, unit_price_points: 4, delivered_units: 8, charged_points: 200, summary_ar: null, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }] as never, created_at: "2026-11-04T09:00:00Z" }, events: [], now: Date.parse("2026-11-04T10:00:00Z") });
  it("a delivered mission with the offer shows it under its files; one without the offer shows nothing", () => {
    const view = delivered();
    const withOffer = html(createElement(AgentMissionCardBody, { view, isGuest: false, methodology: { jobId: "job_1", titleAr: "طلب", purchased: false } }));
    const without = html(createElement(AgentMissionCardBody, { view, isGuest: false }));
    expect(withOffer).toContain('data-testid="methodology-offer"');
    expect(without).not.toContain('data-testid="methodology-offer"');
  });
  it("the chat page draws the chooser under the methodology answer, and the answer's sentence is the one the code writes", () => {
    const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(page).toContain("METHODOLOGY_CHOOSER_SENTENCE_AR");
    expect(page).toContain("<MethodologyChooser");
    // the old flows send the price they show, and download through the site's own response
    expect(page).toContain("expectedPoints: METHODOLOGY_POINTS");
    expect(page).toContain("methodology?file=1");
    expect(page).not.toContain("link.href = downloadUrl");
  });
  it("the purchase request of the offer names the price it showed and downloads through the site's own response", () => {
    const code = readFileSync("src/components/mission/MethodologyOffer.tsx", "utf8");
    expect(code).toContain("expectedPoints: METHODOLOGY_POINTS");
    expect(code).toContain("methodology?file=1");
  });
});
