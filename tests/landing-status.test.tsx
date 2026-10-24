import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Overview } from "../src/components/landing/Overview";
import { SERVICES_CATALOG, catalogCounts } from "../src/lib/servicesCatalog";
import { DECISION_MAKERS_LINE_AR } from "../src/lib/servicesAvailability";
import { platformsCountAr, sectorsCountAr } from "../src/lib/servicesCatalogText";

const html = renderToStaticMarkup(createElement(Overview));
const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const STATUS_TEXT = ["متاح الآن", "قريبًا", "قريباً", "ستُضاف تدريجيًا", "اطلبها الآن"];

describe("landing: no per-service status anywhere", () => {
  it("no status word, no status counts, no status block", () => {
    for (const word of STATUS_TEXT) {
      expect(text, word).not.toContain(word);
      expect(readFileSync("src/components/landing/Overview.tsx", "utf8"), word).not.toContain(word);
    }
    expect(html).not.toMatch(/landing-status-counts|landing-decision-status|data-status=/);
  });

  it("the sector and platform counts are computed from the data", () => {
    const counts = catalogCounts();
    expect(text).toContain(`${sectorsCountAr(counts.sectors)} من ${platformsCountAr(counts.platforms)}`);
    const chips = html.split('data-testid="landing-sectors"')[1].split("</ul>")[0].match(/<li/g) ?? [];
    expect(chips.length).toBe(SERVICES_CATALOG.length);
    for (const sector of SERVICES_CATALOG) expect(html).toContain(sector.nameAr);
  });

  it("the decision-makers card lists no service and has no call to action; the landing's own calls to action are unchanged (none added here)", () => {
    const block = /data-testid="landing-decision-makers"[\s\S]*?<ul[\s\S]*?<\/ul>/.exec(html)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).not.toContain("<a");
    expect(html).not.toContain('href="/register"');
    expect(html.match(/href="\/services"/g)?.length).toBe(1);
  });

  it("one honest line above the decision-makers card, from one constant, with no CTA, price or status", () => {
    expect(DECISION_MAKERS_LINE_AR).toBe("بيانات صناع القرار تُسلَّم الآن بحسب الطلب، وتُعرض خطتها وسعرها قبل أي خصم.");
    expect(html.split(DECISION_MAKERS_LINE_AR).length - 1).toBe(1);
    expect(html.indexOf(DECISION_MAKERS_LINE_AR)).toBeLessThan(html.indexOf('data-testid="landing-decision-makers"'));
    expect(/data-testid="landing-decision-makers-line"[^>]*>([^<]*)</.exec(html)?.[1]).toBe(DECISION_MAKERS_LINE_AR);
    expect(readFileSync("src/components/landing/Overview.tsx", "utf8")).not.toContain("بيانات صناع القرار تُسلَّم");
  });

  it("no English, no emoji, no price", () => {
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/نقطة|ج\.م/);
  });

  it("header, hero and the rest of the landing page are untouched by this change", () => {
    expect(readFileSync("src/components/landing/GlassHeader.tsx", "utf8")).toContain('href="/pricing"');
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain('export const dynamic = "force-static"');
  });
});
