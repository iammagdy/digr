import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Admin tab «مزودو الخدمة»: every provider tab is named by the provider's own name (admin only). No customer route, page or component may
 * contain a provider name or one of these labels.
 */
const hOk = { ok: true, reason: "ok", httpStatus: 200, statusClass: "2xx", latencyMs: 10, checkedAt: "2026-10-23T09:00:00Z" };
const providers = {
  llm: { enabled: true, provider: "anthropic", model: "m", keyEnv: "K", modelEnv: "M", keyConfigured: true, keyLast4: "abcd", health: hOk, lastUsage: null, fallbackReason: null, callsToday: 0, costTodayEgp: 0 },
  treg: { live: true, tokenConfigured: true, tokenLast4: "1234", health: hOk, baseUrl: "https://treg.to", lastCall: null, callsToday: 0 },
};
vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ({ providers, refresh: () => {}, toast: () => {}, isMobile: false }) }));
vi.mock("../src/components/admin/ProviderTab", () => ({ ProviderTab: ({ provider }: { provider: string }) => createElement("div", { "data-provider-panel": provider }) }));
vi.mock("../src/lib/adminApi", () => ({ adminFetch: vi.fn(async () => providers) }));

const ROOT = path.resolve(__dirname, "..");
const LABELS = { treg: "TREG: مزود البيانات", firecrawl: "Firecrawl: مزود قراءة المواقع", contextdev: "Context.dev: مزود البحث والقراءة" } as const;

describe("admin tab «مزودو الخدمة»: every provider is named", () => {
  it("renders one tab per provider, in this order, each labelled with the provider's name", async () => {
    const { default: Page } = await import("../src/app/admin/providers/page");
    const html = renderToStaticMarkup(createElement(Page));
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*id="tab-([a-z]+)"[^>]*>([^<]*)<\/button>|<button[^>]*id="tab-([a-z]+)"[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1] ?? m[3], m[2] ?? m[4]]);
    expect(tabs.map(([id]) => id)).toEqual(["treg", "firecrawl", "contextdev", "anthropic"]);
    expect(Object.fromEntries(tabs)).toMatchObject(LABELS);
    expect(tabs.find(([id]) => id === "anthropic")![1]).toBe("مزود النموذج الذكي");
    expect(new Set(tabs.map(([, label]) => label)).size).toBe(4);
  });

  it("the TREG tab still renders the same TREG panel (only its label changed)", async () => {
    const { default: Page } = await import("../src/app/admin/providers/page");
    expect(renderToStaticMarkup(createElement(Page))).toContain('data-provider-panel="treg"');
  });

  it("the tab list keeps its accessible name", async () => {
    const { default: Page } = await import("../src/app/admin/providers/page");
    expect(renderToStaticMarkup(createElement(Page))).toContain('aria-label="مزودو الخدمة"');
  });
});

describe("no customer route, page or component names a provider or carries an admin tab label", () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
    return out;
  };
  const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
  const customer = [...walk(path.join(ROOT, "src/app")), ...walk(path.join(ROOT, "src/components"))].map(rel).filter((f) =>
    !f.startsWith("src/app/admin/") && !f.startsWith("src/app/api/admin/") && !f.startsWith("src/app/api/worker/") && !f.startsWith("src/app/api/cron/") && !f.startsWith("src/components/admin/"));

  it("there are customer files to check (the scan is not empty)", () => {
    expect(customer.length).toBeGreaterThan(50);
    expect(customer.some((f) => f.startsWith("src/app/api/chat/"))).toBe(true);
  });

  it("none contains Firecrawl or Context.dev (any spelling), nor any admin tab label", () => {
    const offenders = customer.filter((f) => {
      const text = readFileSync(path.join(ROOT, f), "utf8");
      return /firecrawl|context\.?dev|contextdev/i.test(text) || Object.values(LABELS).some((label) => text.includes(label));
    });
    expect(offenders).toEqual([]);
  });

  it("TREG appears in customer files only as an internal identifier (an endpoint id, a field name) or inside the sanitizer that REMOVES it from text, never as visible wording", () => {
    // The three known internal uses already on main: `treg.people.search` (an id compared in code), `tregEndpointId` (a field name) and the
    // sanitizer regex that replaces the name with «منصة ديجر». Once those are set aside, no customer file may contain the name at all.
    const INTERNAL = /treg\.people\.search|tregEndpointId|\(\?:openai\|chatgpt\|gpt\[-\\s\]\?\[3456\]\[\\w\.-\]\*\|treg\|tikhub\|serpapi\)/gi;
    const offenders = customer.filter((f) => /treg/i.test(readFileSync(path.join(ROOT, f), "utf8").replace(INTERNAL, "")));
    expect(offenders).toEqual([]);
  });

  it("the labels live only in the admin page (and its contract test)", () => {
    const holders = walk(path.join(ROOT, "src")).map(rel).filter((f) => Object.values(LABELS).some((label) => readFileSync(path.join(ROOT, f), "utf8").includes(label)));
    expect(holders).toEqual(["src/app/admin/providers/page.tsx"]);
  });
});
