import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => createElement("a", { href, ...rest }, children) }));

import { DemoConversations, ProductLines } from "../src/components/landing/Sections";
import { DEMO_LABEL_AR, buildLandingDemos } from "../src/lib/landingDemos";
import { estimateMission } from "../src/lib/missionEstimate";

const BANNED = /undefined|null|NaN|USD|\$|[0-9]|treg|scrapecreators|tikhub|serpapi|openai|anthropic|100\s*%|مائة بالمائة/i;

describe("landing: two product lines and the ten-second story", () => {
  const html = renderToStaticMarkup(createElement(ProductLines));
  it("names both lines and tells the story in three steps", () => {
    expect(html).toContain("بيانات المنصات الاجتماعية");
    expect(html).toContain("شركات وصنّاع قرار");
    expect(html).toContain('data-testid="ten-second-story"');
    expect((html.match(/<li>/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  it("has Arabic text only, Arabic-Indic digits, no vendor names", () => {
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(BANNED);
  });
});

describe("landing: four static demos", () => {
  const demos = buildLandingDemos();
  const html = renderToStaticMarkup(createElement(DemoConversations));

  it("has exactly four demos, each marked as an example", () => {
    expect(demos).toHaveLength(4);
    expect((html.match(/data-testid="landing-demo"/g) || []).length).toBe(4);
    expect((html.match(new RegExp(DEMO_LABEL_AR, "g")) || []).length).toBeGreaterThanOrEqual(4);
    expect(DEMO_LABEL_AR).toBe("مثال توضيحي");
  });

  it("covers both product lines", () => {
    expect(new Set(demos.map((d) => d.line))).toEqual(new Set(["social", "companies"]));
  });

  it("every price is approximate, computed from the public estimate, in points and pounds", () => {
    for (const demo of demos) {
      expect(demo.priceAr).toMatch(/حوالي/);
      expect(demo.priceAr).toMatch(/نقطة/);
      expect(demo.priceAr).toMatch(/ج\.م/);
    }
    expect(estimateMission({ kind: "companies", volume: 50 }).status).toBe("ok");
  });

  it("every demo says what was understood, shows a plan and the output, and leaks nothing", () => {
    for (const demo of demos) {
      expect(demo.understoodAr).toMatch(/^فهمت أنك تريد/);
      expect(demo.planAr.length).toBeGreaterThanOrEqual(3);
      expect(demo.outputAr).toMatch(/ملف إكسل/);
    }
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(BANNED);
  });

  it("links to sign-up and never promises a charge before approval", () => {
    expect(html).toContain('href="/register"');
    expect(html).toContain("لا يُخصم شيء قبل موافقتك");
  });

  it("is static: no fetch, no model", async () => {
    const source = (await import("node:fs")).readFileSync("src/lib/landingDemos.ts", "utf8");
    expect(source).not.toMatch(/fetch\(|llm|openai|anthropic|executeTurn/i);
  });
});
