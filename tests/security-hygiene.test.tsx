import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilitySlugFromPublicId, PROVIDER_NAME_PATTERN, publicCapabilityId } from "../src/lib/publicCapabilityIds";
import { CONTENT_SECURITY_POLICY_REPORT_ONLY, summarizeCspReport } from "../src/lib/contentSecurityPolicy";
import ServicesCatalogPage from "../src/app/services/page";
import PublicCalculatorPage from "../src/app/calculator/page";
import { POST as cspReport } from "../src/app/api/csp-report/route";

afterEach(() => vi.restoreAllMocks());

describe("14. no provider name in page markup", () => {
  it("maps the stored capability slug to an opaque public id and back", () => {
    expect(publicCapabilityId("icypeas-companies-search")).toBe("companies-search");
    expect(capabilitySlugFromPublicId("companies-search")).toBe("icypeas-companies-search");
    expect(publicCapabilityId("tiktok-profile")).toBe("tiktok-profile");
    expect(capabilitySlugFromPublicId("tiktok-profile")).toBe("tiktok-profile");
    expect(PROVIDER_NAME_PATTERN.test(publicCapabilityId("icypeas-companies-search"))).toBe(false);
  });

  it("the rendered /services page has no provider name anywhere in its markup", () => {
    const html = renderToStaticMarkup(createElement(ServicesCatalogPage));
    expect(html.length).toBeGreaterThan(1000);
    expect(html.match(PROVIDER_NAME_PATTERN)).toBeNull();
  });

  it("the rendered /calculator page has no provider name anywhere in its markup, and the option for companies still exists", () => {
    const html = renderToStaticMarkup(createElement(PublicCalculatorPage));
    expect(html.match(PROVIDER_NAME_PATTERN)).toBeNull();
    // UI pass 1 (item 10): the calculator offers platforms and kinds (no service list); companies and decision makers are one platform choice
    expect(html).toContain('value="companies"');
    expect(html).toContain("شركات وصناع قرار");
  });

  it("the calculator shows no stored service slug: it prices a platform and a kind through the server estimate", () => {
    const source = readFileSync("src/components/calculator/MissionEstimator.tsx", "utf8");
    expect(source).toContain('fetch("/api/calculator/estimate"');
    expect(source).not.toMatch(PROVIDER_NAME_PATTERN);
    expect(source).not.toContain("capabilitySlugFromPublicId");
  });
});

describe("14. Content-Security-Policy (report-only first)", () => {
  it("is sent as report-only on every path, never as an enforcing header", async () => {
    const config = (await import("../next.config.mjs")).default as any;
    const rules = await config.headers();
    const all = rules.find((r: any) => r.source === "/:path*").headers as Array<{ key: string; value: string }>;
    const csp = all.find((h) => h.key === "Content-Security-Policy-Report-Only");
    expect(csp?.value).toBe(CONTENT_SECURITY_POLICY_REPORT_ONLY);
    expect(all.some((h) => h.key === "Content-Security-Policy")).toBe(false);
  });

  it("is restrictive where it can be: same-origin by default, no plugins, no foreign framing, own Supabase only", () => {
    const policy = CONTENT_SECURITY_POLICY_REPORT_ONLY;
    for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors 'self'", "base-uri 'self'", "form-action 'self'", "report-uri /api/csp-report"]) {
      expect(policy).toContain(directive);
    }
    expect(policy).toContain("connect-src 'self' https://*.supabase.co wss://*.supabase.co");
    expect(policy).not.toMatch(/\*(?!\.supabase)/);
    expect(policy).not.toContain("'unsafe-eval'");
  });

  it("the report endpoint always answers 204 and logs only the directive and the blocked origin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await cspReport(new NextRequest("http://localhost/api/csp-report", {
      method: "POST",
      body: JSON.stringify({ "csp-report": { "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/path/x.js?token=secret", "script-sample": "alert(document.cookie)" } }),
    }));
    expect(res.status).toBe(204);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe("[csp:report] directive=script-src-elem blocked=https://evil.example");
    expect(line).not.toContain("secret");
    expect(line).not.toContain("cookie");
    expect((await cspReport(new NextRequest("http://localhost/api/csp-report", { method: "POST", body: "not json" }))).status).toBe(204);
    expect(summarizeCspReport({})).toBeNull();
  });
});
