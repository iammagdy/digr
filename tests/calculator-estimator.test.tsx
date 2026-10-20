import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MissionEstimator from "../src/components/calculator/MissionEstimator";
import PublicCalculatorPage from "../src/app/calculator/page";

const html = renderToStaticMarkup(createElement(MissionEstimator));

describe("the public estimate form", () => {
  it("offers a free-text box and structured fields, in Arabic only", () => {
    expect(html).toContain('data-testid="mission-estimator"');
    expect(html).toContain("اكتب طلبك");
    expect(html).toContain("نوع البيانات");
    expect(html).toContain("ميزانيتك بالنقاط");
    expect(html).not.toMatch(/undefined|null|NaN|USD|\$|treg|scrapecreators|tikhub|serpapi|openai|anthropic/i);
  });

  it("promises no charge before approval and offers sign-up", () => {
    expect(html).toContain("دون أي خصم من رصيدك");
    const source = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(source).toContain('href="/register"');
    expect(source).toContain("لا يُخصم شيء إلا بعد موافقتك على الخطة");
    expect(source).toContain("FAILURE_STATE_AR");
  });

  it("gets its numbers from the rate-limited code-only endpoint, never from a model", () => {
    const source = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(source).toContain("/api/calculator/estimate");
    expect(source).not.toMatch(/llm|openai|anthropic|executeTurn/i);
    expect(readFileSync("src/app/api/calculator/estimate/route.ts", "utf8")).toContain("createRateLimiter");
    expect(readFileSync("src/app/api/calculator/cap/route.ts", "utf8")).toContain("createRateLimiter");
  });

  it("the calculator page mounts it above the exact per-service calculator", () => {
    const page = renderToStaticMarkup(createElement(PublicCalculatorPage));
    expect(page.indexOf('data-testid="mission-estimator"')).toBeGreaterThan(0);
    expect(page.indexOf('data-testid="mission-estimator"')).toBeLessThan(page.indexOf("capability-select"));
  });
});
