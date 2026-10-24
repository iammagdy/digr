import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Overview } from "../src/components/landing/Overview";
import { APPROVED_CAPABILITY_CATALOG } from "../src/functions/shared/capabilityRegistry";
import { SERVICES_CATALOG, coreServices } from "../src/lib/servicesCatalog";
import { AVAILABLE_NOW_REGISTRY_SLUGS, DECISION_MAKERS_LINE_AR, SERVICE_SOON_LINE_AR, SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR, isAvailableNow, statusCounts } from "../src/lib/servicesAvailability";
import { formatAr } from "../src/lib/arabicDigits";

const html = renderToStaticMarkup(createElement(Overview));
const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("landing: the two statuses (from the catalog's one constant)", () => {
  it("every available-now slug is a real registry slug, and the list is the owner's", () => {
    const registry = new Set(APPROVED_CAPABILITY_CATALOG.map((capability) => capability.slug));
    for (const slug of AVAILABLE_NOW_REGISTRY_SLUGS) expect(registry.has(slug), slug).toBe(true);
    expect([...AVAILABLE_NOW_REGISTRY_SLUGS].sort()).toEqual(["icypeas-companies-search", "social-facebook-comments", "social-facebook-keyword-comments", "social-facebook-posts", "social-tiktok-comments", "social-x-posts"]);
  });

  it("the counts are computed from the data", () => {
    const counts = statusCounts(SERVICES_CATALOG);
    expect(html).toContain('data-testid="landing-status-counts"');
    expect(text).toContain(`${SERVICE_STATUS_AVAILABLE_AR}: ${formatAr(counts.available)}، ${SERVICE_STATUS_SOON_AR}: ${formatAr(counts.soon)}`);
  });

  it("the decision-makers card says which core services are available now (none today) and how many are coming, with no call to action", () => {
    const core = coreServices().map((service) => ({ service, available: isAvailableNow(service.platformSlug, service.nameAr) }));
    const available = core.filter((entry) => entry.available);
    // no core service is available now while people search is «قريبًا»: the card then says only how many are coming
    expect(available.length).toBe(core.filter((entry) => isAvailableNow(entry.service.platformSlug, entry.service.nameAr)).length);
    expect(core.length - available.length).toBeGreaterThan(0);
    const block = /data-testid="landing-decision-status"[\s\S]*?<\/div>/.exec(html)?.[0] ?? "";
    for (const entry of available) expect(block).toContain(entry.service.nameAr);
    expect(block).toContain(`${formatAr(core.length - available.length)} من خدمات التواصل المهنية. ${SERVICE_SOON_LINE_AR}`);
    expect(block).not.toContain("<a");
    expect(html).not.toContain('href="/register"');
  });

  it("one honest line above the decision-makers card, from one constant, with no CTA, price or status change", () => {
    expect(DECISION_MAKERS_LINE_AR).toBe("بيانات صناع القرار تُسلَّم الآن بحسب الطلب، وتُعرض خطتها وسعرها قبل أي خصم.");
    expect(html.split(DECISION_MAKERS_LINE_AR).length - 1).toBe(1);
    expect(html.indexOf(DECISION_MAKERS_LINE_AR)).toBeLessThan(html.indexOf('data-testid="landing-decision-makers"'));
    expect(/data-testid="landing-decision-makers-line"[^>]*>([^<]*)</.exec(html)?.[1]).toBe(DECISION_MAKERS_LINE_AR);
    expect(readFileSync("src/components/landing/Overview.tsx", "utf8")).not.toContain("بيانات صناع القرار تُسلَّم");
    expect(AVAILABLE_NOW_REGISTRY_SLUGS).not.toContain("professional-people-search");
  });

  it("the words come only from the constants; no English, no emoji, no price", () => {
    const source = readFileSync("src/components/landing/Overview.tsx", "utf8");
    for (const literal of [SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR, SERVICE_SOON_LINE_AR]) expect(source, literal).not.toContain(literal);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(/نقطة|ج\.م/);
  });

  it("header, hero and the rest of the landing page are untouched by this change", () => {
    expect(readFileSync("src/components/landing/GlassHeader.tsx", "utf8")).toContain('href="/pricing"');
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain('export const dynamic = "force-static"');
  });
});
