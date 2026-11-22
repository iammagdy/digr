import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MissionEstimator from "../src/components/calculator/MissionEstimator";
import PublicCalculatorPage from "../src/app/calculator/page";

const html = renderToStaticMarkup(createElement(MissionEstimator));

describe("the public estimate form", () => {
  it("accepts the full request in Arabic and does not display a price before submit", () => {
    expect(html).toContain('data-testid="mission-estimator"');
    expect(html).toContain('id="estimate-request"');
    expect(html).toContain("اكتب طلب البحث");
    expect(html).not.toContain('data-testid="estimate-result"');
    expect(html).not.toMatch(/undefined|null|NaN|USD|\$|treg|scrapecreators|tikhub|serpapi|openai|anthropic/i);
  });

  it("keeps approval in chat and promises no charge before approval", () => {
    const page = renderToStaticMarkup(createElement(PublicCalculatorPage));
    expect(page).toContain("لا يُخصم أي رصيد أثناء المحادثة أو إعداد الخطة");
    const source = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(source).toContain('href="/register"');
    expect(source).toContain("/dashboard/chat?c=");
    expect(source).not.toContain('action: "approve"');
  });

  it("gets its numbers from the rate-limited owned reader, without client pricing", () => {
    const source = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(source).toContain("/api/calculator/estimate");
    expect(source).not.toMatch(/llm|openai|anthropic|executeTurn|resolvePlanningPending/i);
    expect(readFileSync("src/app/api/calculator/estimate/route.ts", "utf8")).toContain("createRateLimiter");
    expect(readFileSync("src/app/api/calculator/cap/route.ts", "utf8")).toContain("createRateLimiter");
  });

  it("the calculator page is this form and the accounting rules, with no second per-service calculator under it", () => {
    const page = renderToStaticMarkup(createElement(PublicCalculatorPage));
    expect(page).toContain('data-testid="mission-estimator"');
    expect(page).not.toContain("capability-select");
    expect(page).not.toContain("جدول التدقيق");
  });
});
