import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BANNED_ENGLISH_UI, BANNED_PROVIDER_WORDS, PRIVATE_PATHS, PUBLIC_PAGES, checkPage, checkPrivate, visibleTextOf } from "../scripts/site-health";

const CLEAN = `<!doctype html><html lang="ar" dir="rtl"><head><title>خدماتنا</title><script>window.__x={"Login":1,"Loading":2}</script></head><body><main><h1>خدماتنا</h1><input placeholder="اسأل ديجر" aria-label="سؤالك"/><a href="/register">ابدأ طلبك</a></main></body></html>`;

describe("scripts/site-health.ts (read-only; the checks themselves, on fixtures, no network)", () => {
  it("covers exactly the public pages and the admin paths the owner named", () => {
    expect([...PUBLIC_PAGES]).toEqual(["/", "/services", "/pricing", "/calculator", "/contact", "/login", "/register"]);
    expect(PRIVATE_PATHS.some((path) => path.startsWith("/admin"))).toBe(true);
    expect(PRIVATE_PATHS.some((path) => path.startsWith("/api/admin/"))).toBe(true);
  });

  it("a clean Arabic page passes; scripts and the head do not count as visible text", () => {
    expect(checkPage("/services", 200, CLEAN)).toEqual({ path: "/services", status: 200, ok: true, problems: [] });
    expect(visibleTextOf(CLEAN)).not.toContain("Login");
  });

  it("HTTP status other than 200 fails", () => {
    expect(checkPage("/pricing", 500, "").ok).toBe(false);
    expect(checkPage("/pricing", 404, "").problems[0]).toContain("HTTP 404");
  });

  it("every banned provider or model word is caught anywhere in the HTML (as a word)", () => {
    for (const word of BANNED_PROVIDER_WORDS) {
      const finding = checkPage("/", 200, CLEAN.replace("<main>", `<main><div data-x="${word}">`));
      expect(finding.ok, word).toBe(false);
      expect(finding.problems.join(" "), word).toContain(`«${word}»`);
    }
    // a word inside another word is not a hit
    expect(checkPage("/", 200, CLEAN.replace("<main>", "<main><p>fluxion</p>")).problems.filter((p) => p.includes("flux"))).toEqual([]);
  });

  it("every English UI string of the list is caught in visible text and in visible attributes", () => {
    for (const phrase of BANNED_ENGLISH_UI) {
      expect(checkPage("/login", 200, CLEAN.replace("ابدأ طلبك", phrase)).ok, `text ${phrase}`).toBe(false);
      expect(checkPage("/login", 200, CLEAN.replace('placeholder="اسأل ديجر"', `placeholder="${phrase}"`)).ok, `attribute ${phrase}`).toBe(false);
    }
    expect(checkPage("/", 200, CLEAN.replace("ابدأ طلبك", "إكسل")).ok).toBe(true);
  });

  it("a page not marked Arabic fails", () => {
    expect(checkPage("/", 200, CLEAN.replace('lang="ar"', 'lang="en"')).ok).toBe(false);
  });

  it("private paths: a redirect to sign-in, 401, 403 and 404 pass; 200 and any other redirect fail", () => {
    expect(checkPrivate("/admin", 307, "/login?next=%2Fadmin").ok).toBe(true);
    expect(checkPrivate("/admin", 307, "https://diger.tech/login").ok).toBe(true);
    expect(checkPrivate("/api/admin/jobs", 401, null).ok).toBe(true);
    expect(checkPrivate("/api/admin/jobs", 403, null).ok).toBe(true);
    expect(checkPrivate("/admin/x", 404, null).ok).toBe(true);
    expect(checkPrivate("/admin", 200, null).ok).toBe(false);
    expect(checkPrivate("/api/admin/jobs", 200, null).ok).toBe(false);
    expect(checkPrivate("/admin", 307, "/dashboard").ok).toBe(false);
    expect(checkPrivate("/admin", 500, null).ok).toBe(false);
  });

  it("the script is read-only: GET only, no cookie, no key, no body, no write", () => {
    const source = readFileSync("scripts/site-health.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).toContain('method: "GET"');
    expect(source).not.toMatch(/method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
    expect(source).not.toMatch(/process\.env|cookie|authorization|apikey|secret|writeFile|appendFile|body:/i);
  });
});
