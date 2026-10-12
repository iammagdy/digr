import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";
import { SITE_URL, SUPPORT_EMAIL } from "../src/lib/site";

describe("diger.tech domain readiness", () => {
  it("defaults the canonical origin and support mailbox to diger.tech", () => {
    expect(SITE_URL).toBe("https://diger.tech");
    expect(SUPPORT_EMAIL).toBe("support@diger.tech");
  });

  it("robots.txt keeps the signed-in areas out and points at the sitemap", () => {
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    expect(rule.disallow).toEqual(expect.arrayContaining(["/dashboard", "/admin", "/api"]));
    expect(r.sitemap).toBe("https://diger.tech/sitemap.xml");
  });

  it("sitemap lists only public pages on the canonical host", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls).toContain("https://diger.tech/");
    expect(urls.every((u) => u.startsWith("https://diger.tech/"))).toBe(true);
    expect(urls.some((u) => /dashboard|admin|api/.test(u))).toBe(false);
  });

  it("e-mailed links use the pinned site origin helper, not a hard-coded host", () => {
    for (const f of ["src/hooks/useUser.tsx", "src/app/verify/page.tsx", "src/app/forgot/page.tsx"]) {
      expect(readFileSync(f, "utf8")).toContain("appBaseUrl()");
    }
  });

  it("www redirects to the apex and private areas are noindex", () => {
    const cfg = readFileSync("next.config.mjs", "utf8");
    expect(cfg).toContain('value: "www.diger.tech"');
    expect(cfg).toContain("noindex");
  });
});
