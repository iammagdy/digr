import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import { ADMIN_GROUPS, ADMIN_LEGACY_ROUTES, ADMIN_PAGE_INFO, BOTTOM_BAR_PAGES, adminGroupOf } from "../src/components/admin/nav";
import { parseProvidersQuery, providerViews, providersQuery } from "../src/components/admin/providerViews";
import { TregKeyPool, shownLabel } from "../src/components/admin/TregKeyPool";
import type { PoolKeyView, PoolOverview } from "../src/lib/server/tregPoolAdmin";

const hOk = { ok: true, reason: "ok", httpStatus: 200, statusClass: "2xx", latencyMs: 10, checkedAt: "2026-10-23T09:00:00Z" };
const providers = {
  llm: { enabled: true, provider: "anthropic", model: "m", keyEnv: "K", modelEnv: "M", keyConfigured: true, keyLast4: "abcd", health: hOk, lastUsage: null, fallbackReason: null, callsToday: 0, costTodayEgp: 0 },
  treg: { live: true, tokenConfigured: true, tokenLast4: "1234", health: hOk, baseUrl: "https://treg.to", lastCall: null, callsToday: 0 },
};
vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ({ providers, refresh: () => {}, toast: () => {}, isMobile: false }) }));
vi.mock("../src/components/admin/ProviderTab", () => ({ ProviderTab: ({ provider, view }: { provider: string; view?: string }) => createElement("div", { "data-provider-panel": provider, "data-view": view }) }));
vi.mock("../src/lib/adminApi", () => ({ adminFetch: vi.fn(async () => providers) }));

/** Every admin address that existed before the reorganisation, written out here on purpose: the menu may move things, an address may not disappear. */
const OLD_ROUTES = [
  "/admin", "/admin/users", "/admin/topups", "/admin/jobs", "/admin/visitors", "/admin/operations", "/admin/finance", "/admin/promo-codes", "/admin/support",
  "/admin/providers", "/admin/calls-log", "/admin/audit", "/admin/requests", "/admin/conference", "/admin/reverse-lookup", "/admin/planner-selftest",
  "/admin/failures", "/admin/agent", "/admin/settings", "/admin/export",
];
/** Pages added on purpose after the reorganisation (each one is a decision, so each is written out here). */
const NEW_ROUTES = ["/admin/invoices"];

describe("every old admin address still opens its page", () => {
  it("each old address has its page file with a default export, at the same path as before", () => {
    for (const route of OLD_ROUTES) {
      const file = path.join("src/app", route, "page.tsx");
      expect(existsSync(file), route).toBe(true);
      expect(readFileSync(file, "utf8"), route).toMatch(/export default (async )?function/);
    }
  });

  it("no page was added, removed or renamed: the page folders are exactly the old list", () => {
    const dirs = readdirSync("src/app/admin", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `/admin/${d.name}`);
    // «الفواتير» (/admin/invoices) is the one deliberate addition of the invoices feature; every old folder is still there
    expect([...dirs, "/admin"].sort()).toEqual([...OLD_ROUTES, ...NEW_ROUTES].sort());
    expect(existsSync("src/app/admin/page.tsx")).toBe(true);
  });

  it("the menu list produces exactly the old addresses and nothing was lost from it", () => {
    expect(ADMIN_PAGES.map(([id]) => adminHref(id)).sort()).toEqual([...OLD_ROUTES, ...NEW_ROUTES].sort());
    expect([...ADMIN_LEGACY_ROUTES].sort()).toEqual([...OLD_ROUTES].sort()); // the legacy list itself never changes
    expect(ADMIN_PAGES).toHaveLength(21);
  });

  it("no redirect was added that could send an old address somewhere else", () => {
    const next = readFileSync("next.config.mjs", "utf8") + readFileSync("vercel.json", "utf8");
    expect(next).not.toMatch(/\/admin[^"']*["'][^}]*destination/);
    for (const route of OLD_ROUTES) expect(readFileSync(path.join("src/app", route, "page.tsx"), "utf8"), route).not.toMatch(/redirect\(/);
  });
});

describe("the menu is a few clear sections", () => {
  it("six sections, each non-empty, every page in exactly one of them, most used first", () => {
    expect(ADMIN_GROUPS.map((g) => g.label)).toEqual(["نظرة عامة", "العملاء والطلبات", "الفلوس والشحن", "المزودون والمفاتيح", "الوكيل والجودة", "الإعدادات"]);
    const all = ADMIN_GROUPS.flatMap((g) => g.pages);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(ADMIN_PAGES.map(([id]) => id).sort());
    for (const g of ADMIN_GROUPS) expect(g.pages.length, g.id).toBeGreaterThan(0);
    expect(ADMIN_GROUPS[0].pages[0]).toBe("overview");
    expect(adminGroupOf("topups").label).toBe("الفلوس والشحن");
    expect(adminGroupOf("providers").pages).toEqual(["providers", "calls-log"]);
  });

  it("every page has one plain Arabic sentence saying what it is for, with no Latin digit", () => {
    for (const [id] of ADMIN_PAGES) {
      expect(ADMIN_PAGE_INFO[id], id).toMatch(/[؀-ۿ]/);
      expect(ADMIN_PAGE_INFO[id], id).not.toMatch(/[0-9]/);
    }
  });

  it("the phone's bottom bar keeps its four pages; the rest are under «المزيد»", () => {
    expect(BOTTOM_BAR_PAGES).toEqual(["overview", "users", "topups", "providers"]);
    const shell = readFileSync("src/components/admin/AdminShell.tsx", "utf8");
    expect(shell).toContain("NavGroups");
    expect(shell).toContain('!BOTTOM_BAR_PAGES.includes(page)');
    expect(shell).toContain('data-testid="admin-page-intro"');
  });
});

describe("«مزودو الخدمة» is split into short views", () => {
  it("every provider has the same four views; the model provider's last one is its activity", () => {
    for (const t of ["treg", "firecrawl", "contextdev"] as const) expect(providerViews(t).map(([, l]) => l)).toEqual(["الحالة والرصيد", "المفاتيح", "الحدود", "سجل المكالمات"]);
    expect(providerViews("anthropic").map(([id]) => id)).toEqual(["status", "keys", "limits", "calls"]);
    expect(providerViews("anthropic")[3][1]).toBe("آخر النشاط");
  });

  it("the address keeps the provider and the view; the plain address opens TREG status; anything unknown falls back", () => {
    expect(parseProvidersQuery("")).toEqual({ tab: "treg", view: "status" });
    expect(parseProvidersQuery("?p=treg&v=keys")).toEqual({ tab: "treg", view: "keys" });
    expect(parseProvidersQuery("?p=firecrawl&v=calls")).toEqual({ tab: "firecrawl", view: "calls" });
    expect(parseProvidersQuery("?p=nope&v=nope")).toEqual({ tab: "treg", view: "status" });
    expect(parseProvidersQuery("?p=anthropic&v=bogus")).toEqual({ tab: "anthropic", view: "status" });
    expect(providersQuery("treg", "status")).toBe("");
    expect(providersQuery("contextdev", "limits")).toBe("?p=contextdev&v=limits");
    expect(parseProvidersQuery(providersQuery("anthropic", "keys"))).toEqual({ tab: "anthropic", view: "keys" });
  });

  it("the page shows the provider tabs and, under them, the four views; the panel receives the open view", async () => {
    const { default: Page } = await import("../src/app/admin/providers/page");
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain('aria-label="مزودو الخدمة"');
    expect(html).toContain('aria-label="أقسام المزود"');
    for (const label of ["الحالة والرصيد", "المفاتيح", "الحدود", "سجل المكالمات"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('data-provider-panel="treg"');
    expect(html).toContain('data-view="status"');
  });

  it("the provider panel shows one group of sections per view and still shows everything when no view is given", () => {
    const src = readFileSync("src/components/admin/ProviderTab.tsx", "utf8");
    for (const v of ["status", "keys", "limits", "calls"]) expect(src).toContain(`show("${v}")`);
    expect(src).toContain("const show = (v: ProviderView) => !view || view === v;");
  });
});

const key = (over: Partial<PoolKeyView> & { number: number }): PoolKeyView => ({
  id: `id-${over.number}`, label: `اختبار-${over.number}`, isMain: false, inChain: true, chainPosition: over.number, isActive: false, last4: `k${over.number}x${over.number}`, accountEmail: `k${over.number}@example.test`,
  status: "connected", statusReason: null, statusCheckedAt: new Date(Date.now() - 120_000).toISOString(), balanceUsd: 0.91, balanceCheckedAt: null, spend: { calls: 0, usd: 0, todayUsd: 0, lastCallAt: null }, ...over,
});
const overview = (over: Partial<PoolOverview> = {}): PoolOverview => ({
  ready: true, rolloutOn: true, generation: 0, minBalanceUsd: 0.01, lastHealthRunAt: null, events: [], legacy: { source: "env", last4: "Az7w" }, workerEnvLast4: null, workerSeenAt: null, workerMismatch: false, noticesAr: [],
  keys: [key({ number: 1, isMain: true, label: "1", chainPosition: 9, balanceUsd: 12.4 }), key({ number: 2, isActive: true, label: "اختبار-2" }), key({ number: 3, status: "revoked", balanceUsd: null }), key({ number: 4, status: "out_of_balance", inChain: false })],
  activeKeyId: "id-2", ...over,
});
const html = (ov: PoolOverview) => renderToStaticMarkup(createElement(TregKeyPool, { initial: ov }));
const rowOf = (h: string, n: number) => h.split(`data-testid="pool-row-${n}"`)[1].split("</tr>")[0];

describe("the key pool table is readable at 1280 px and becomes cards at 390 px", () => {
  const h = html(overview());

  it("has no horizontal scroll and no fixed wide minimum; it uses the table-to-cards pattern", () => {
    const table = h.split('data-testid="pool-table"')[0].split("<table").pop()! + h.split('data-testid="pool-table"')[1].split(">")[0];
    expect(table).toContain("rtable");
    expect(table).not.toMatch(/min-w-\[/);
    expect(h).not.toContain("overflow-x-auto");
    expect(h).toContain("rtable-wrap");
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toContain("@container (max-width: 859px)");
    expect(css).toContain("content: attr(data-label)");
  });

  it("has one separate header cell per column, with clear words", () => {
    const heads = [...h.matchAll(/<th [^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["المفتاح", "بريد الحساب", "آخر ٤", "الرصيد المتبقي", "الحالة", "الاستهلاك", "إجراءات"]);
  });

  it("every value cell carries its column name for the card layout; the last 4 and the e-mail are separate cells", () => {
    const r = rowOf(h, 2);
    for (const label of ["بريد الحساب", "آخر ٤", "الرصيد المتبقي", "الحالة", "الاستهلاك"]) expect(r).toContain(`data-label="${label}"`);
    const email = r.split('data-label="بريد الحساب"')[1].split("</td>")[0];
    const last4 = r.split('data-label="آخر ٤"')[1].split("</td>")[0];
    expect(email).toContain("k2@example.test");
    expect(email).not.toContain("••••");
    expect(last4).toContain("••••k2x2");
    expect(last4).not.toContain("@");
  });

  it("shows the number once: a label that is only the number is dropped, digits in a name are Arabic-Indic", () => {
    expect(shownLabel({ number: 1, label: "1" })).toBe("");
    expect(shownLabel({ number: 1, label: "١" })).toBe("");
    expect(shownLabel({ number: 1, label: "رقم 1" })).toBe("");
    expect(shownLabel({ number: 2, label: "اختبار-2" })).toBe("اختبار-٢");
    expect(shownLabel({ number: 1, label: "الرئيسي" })).toBe("الرئيسي");
    const first = rowOf(h, 1).split("</td>")[0];
    expect((first.match(/>١</g) || []).length).toBe(1);
    expect(first).not.toMatch(/١\s*1|1\s*١/);
    expect(rowOf(h, 2)).toContain("اختبار-٢");
  });

  it("shows the status as a coloured badge, the main key clearly marked, the active key marked", () => {
    expect(rowOf(h, 3)).toMatch(/<span[^>]*background:[^>]*>[^<]*<span[^>]*><\/span>ملغى<\/span>|ملغى<\/span>/);
    expect(rowOf(h, 1)).toContain("★ الرئيسي / الافتراضي");
    expect(rowOf(h, 2)).toContain("نشط الآن");
    expect(rowOf(h, 4)).toContain("خارج السلسلة");
  });

  it("groups the actions: one main action visible, the rest in a small menu", () => {
    const active = rowOf(h, 2);
    const other = rowOf(h, 3);
    expect(other.split("<details")[0]).toContain(">تفعيل<");
    expect(other.split("<details")[0]).not.toContain(">حذف<");
    expect(other.split("<details")[1]).toContain(">حذف<");
    expect(active.split("<details")[0]).toContain(">افحص الآن<");
    expect(active.split("<details")[0]).not.toContain(">تفعيل<");
    expect(other).toContain("المزيد");
    expect((other.match(/<details/g) || []).length).toBe(1);
  });

  it("puts the rollout switch and «فحص الآن» at the top, above the table, with the active key in one line", () => {
    const top = h.split('data-testid="pool-table"')[0];
    expect(top).toContain('data-testid="rollout-off"');
    expect(top).toContain('data-testid="refresh-all"');
    const line = h.split('data-testid="active-key-line"')[1].split("</p>")[0];
    expect(line).toContain("المفتاح النشط الآن");
    expect(line).toContain("رقم ٢");
    expect(line).toContain("••••k2x2");
  });
});

describe("the admin pages share one look", () => {
  it("the shared pieces exist and the call logs use the same table-to-cards pattern", () => {
    expect(readFileSync("src/components/admin/ui.tsx", "utf8")).toContain("export function StatusBadge");
    for (const f of ["src/components/admin/ProviderCallLog.tsx", "src/components/admin/AllCallsLog.tsx", "src/components/admin/ProviderTab.tsx"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("rtable-wrap");
      expect(src, f).toContain('data-label="');
    }
  });
});
