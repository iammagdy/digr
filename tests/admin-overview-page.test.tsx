import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * DT-20261118-06 phase 1A: the overview page (spec §3.2). The test environment is node (no DOM library in the repository, and no new dependency), so effects do not run here:
 * the page's data step `loadOverviewSlots` is called with the mocked `adminFetch` (the same function the page's effects call), and its result is rendered by `OverviewView`,
 * the component the page renders. The page itself is rendered once to check its first (loading) screen.
 */
const NOW = Date.parse("2026-11-18T12:00:00Z");
const hOk = { ok: true, reason: "ok", httpStatus: 200, statusClass: "2xx", latencyMs: 10, checkedAt: "2026-11-18T09:00:00Z" };
const providersWith = (balanceUsd: number, lowBalance: boolean) => ({
  llm: { enabled: true, provider: "anthropic", model: "m", keyEnv: "K", modelEnv: "M", keyConfigured: true, keyLast4: "abcd", health: hOk, lastUsage: null, fallbackReason: null, callsToday: 3, costTodayEgp: 12 },
  treg: { live: true, tokenConfigured: true, tokenLast4: "1234", health: hOk, baseUrl: "https://treg.to", lastCall: null, callsToday: 2, balance: { available: true, balanceUsd, checkedAt: "2026-11-18T09:00:00Z" }, thresholdUsd: 25, lowBalance },
  limits: { level: "ok", percent: 56, llmLevel: "ok", llmPercent: 10 },
});
const ALERTS = { pendingTopups: [], pendingTotal: 3, newUsers: { total: 0, latest: null }, failedJobs: [], failedTotal: 0 };
const days = (n: number, v: (i: number) => number) => Array.from({ length: n }, (_, i) => v(i));
const STATS = {
  range: 30,
  totals: { users: 120, newUsers: 9, newUsersPrev: 6, active: 40, rev: 4800, cost: 1200, profit: 3600, margin: 75, jobs: 3, change: { users: 8.1, newUsers: 50, active: -3.2, rev: 12.5, profit: 10, jobs: 0 } },
  series: { rev: days(30, (i) => i * 10), cost: days(30, (i) => i * 2), newUsers: days(30, (i) => i % 3), active: days(30, () => 1), jobs: days(30, () => 0) },
  funnel: { signed: 9, asked: 5, paid: 2 },
  activity: [
    { type: "pay", who: "سارة", what: "أرسل طلب شحن عبر إنستاباي", at: "2026-11-18T11:00:00Z", when: "منذ ساعة", value: "+500 ج.م", tone: "gold" },
    { type: "jobs", who: "قديم", what: "بدأ بحثًا جديدًا", at: "2026-11-18T11:30:00Z", when: "منذ ٣٠ دقيقة", value: "−20 نقطة", tone: "ink" },
  ],
  topPayers: [{ id: "u1", name: "سارة علي", email: "sara@example.test", total: 1500, last: "أمس" }],
  pendingCount: 3,
};
const OVERVIEW = {
  range: 30,
  missions: { total: 52, ended: 47, succeeded: 42, failed: 5, successPct: 89.4, successPctPrev: 86.2, delivered: 1940, requested: 2200, released: 5, releasedPoints: 300 },
  live: { running: 4, stalled: 0, stalledMinMinutes: null, failed24h: 1 },
  truncated: false,
  recentMissions: [{ id: "msn_a1", status: "completed", created_at: "2026-11-18T11:45:00Z", delivered_units: 120, user_id: "u9" }],
};
const FINANCE = { range: 30, credit: { realIncome: { egp: 4800, points: 48000, count: 4 }, promoPoints: 0, adminGrantPoints: 0, consumedPoints: 36200, refundedPoints: 1200, outstandingPoints: 21500, from: null, to: null } };
const daily = days(14, (i) => ({ day: `2026-11-${String(5 + i).padStart(2, "0")}`, visits: 100 + i * 10, uniqueVisitors: 80 + i }));
const VISITS_14 = { available: true, summary: { range: "14d", visits: 2310, daily }, newAccounts: 30, submittedRequests: 12 };
const VISITS_TODAY = { available: true, summary: { range: "today", visits: 214, daily }, newAccounts: 9, submittedRequests: 2 };
const LIVE = { live: { running: 4, stalled: 0, stalledMinMinutes: null, failed24h: 1 } };

const ctl = vi.hoisted(() => ({ fail: new Set<string>(), calls: [] as string[], ctx: null as any }));
vi.mock("../src/lib/adminApi", () => ({
  adminFetch: vi.fn(async (path: string) => {
    ctl.calls.push(path);
    const base = path.split("?")[0] + (path.includes("part=live") ? "#live" : path.includes("range=today") ? "#today" : path.includes("range=14d") ? "#14d" : "");
    if (ctl.fail.has(base)) throw new Error("تعذّر الاتصال");
    const table: Record<string, unknown> = {
      "/api/admin/stats": STATS, "/api/admin/overview": OVERVIEW, "/api/admin/overview#live": LIVE, "/api/admin/finance": FINANCE,
      "/api/admin/visitors#14d": VISITS_14, "/api/admin/visitors#today": VISITS_TODAY,
    };
    if (!(base in table)) throw new Error(`unexpected ${path}`);
    return table[base];
  }),
}));
vi.mock("../src/components/admin/AdminShell", () => ({ useAdmin: () => ctl.ctx }));
vi.mock("../src/components/admin/UserSheet", () => ({ UserSheet: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/admin" }));

import { adminFetch } from "../src/lib/adminApi";
import AdminOverview from "../src/app/admin/page";
import { OverviewView, loadOverviewSlots } from "../src/components/admin/OverviewCards";

beforeEach(() => {
  ctl.fail = new Set();
  ctl.calls = [];
  ctl.ctx = { range: 30, setRange: () => {}, isMobile: true, alerts: ALERTS, providers: providersWith(80, false), refresh: () => {}, toast: () => {} };
});

async function renderLoaded(providers = providersWith(80, false)) {
  const slots = await loadOverviewSlots(30, adminFetch);
  return renderToStaticMarkup(createElement(OverviewView, { range: 30, isMobile: true, alerts: ALERTS as any, providers: providers as any, slots, liveAt: null, liveStale: false, now: NOW, onRetry: () => {}, onRefreshLive: () => {} }));
}
/** The markup of one card (its `data-card` wrapper). */
const cardOf = (html: string, id: string) => {
  const start = html.indexOf(`data-card="${id}"`);
  const next = html.indexOf("data-card=", start + 10);
  return start < 0 ? "" : html.slice(start, next < 0 ? undefined : next);
};
/** The visible text, without the text of `dir="ltr"` elements (e-mails and the existing amount pills, which keep their Latin digits on purpose). */
function textOutsideLtr(html: string): string {
  const VOID = new Set(["br", "img", "input", "hr", "meta", "link", "path", "circle", "rect", "line", "polyline"]);
  const stack: boolean[] = [];
  let out = "";
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) { if (!stack.includes(true)) out += ` ${m[5]}`; continue; }
    const [, close, tag, attrs, selfClose] = m;
    if (close) { stack.pop(); continue; }
    if (selfClose || VOID.has(tag.toLowerCase())) continue;
    stack.push(/\bdir="ltr"/.test(attrs));
  }
  return out;
}

describe("the overview page", () => {
  it("asks the six sources: stats, overview, finance, visitors (14 days and today) and the live part", async () => {
    await loadOverviewSlots(30, adminFetch);
    expect(ctl.calls.sort()).toEqual(["/api/admin/finance?range=30", "/api/admin/overview?part=live", "/api/admin/overview?range=30", "/api/admin/stats?range=30", "/api/admin/visitors?range=14d", "/api/admin/visitors?range=today"]);
  });

  it("first screen: every card has its own skeleton, in the order attention, today, missions, points, providers, visits, then the existing money cards", () => {
    ctl.ctx = { ...ctl.ctx, alerts: null, providers: null };
    const html = renderToStaticMarkup(createElement(AdminOverview));
    const order = ["attention", "today", "missions", "points", "providers", "visits", "money", "growth", "activity", "payers"].map((id) => html.indexOf(`data-card="${id}"`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const id of ["attention", "missions", "points", "providers", "visits", "money"]) expect(cardOf(html, id)).toMatch(/motion-safe:animate-pulse/);
    expect(html).not.toContain('role="alert"');
  });

  it("loaded: attention, then the four live tiles, then the missions card with the hand-made numbers", async () => {
    const html = await renderLoaded();
    const at = (s: string) => html.indexOf(s);
    expect(at('data-card="attention"')).toBeLessThan(at('data-card="today"'));
    expect(at('data-card="today"')).toBeLessThan(at('data-card="missions"'));
    const today = cardOf(html, "today");
    for (const [label, value] of [["زيارات اليوم", "٢١٤"], ["حسابات جديدة", "٩"], ["مهام تعمل الآن", "٤"], ["طلبات شحن معلّقة", "٣"]]) {
      expect(today).toContain(label);
      expect(today).toContain(`>${value}<`);
    }
    const missions = cardOf(html, "missions");
    expect(missions).toContain("نسبة النجاح");
    expect(missions).toContain("سُلِّم ١٬٩٤٠ من ٢٬٢٠٠ نتيجة مطلوبة");
    expect(missions).toContain("نجحت ٤٢");
    expect(missions).toContain("فشلت ٥");
    expect(missions).toContain("حجز مُحرَّر ٥");
    expect(missions).toMatch(/role="progressbar"/);
    const points = cardOf(html, "points");
    for (const v of ["٤٨٬٠٠٠", "٣٦٬٢٠٠", "١٬٢٠٠", "٢١٬٥٠٠"]) expect(points).toContain(v);
    // the activity feed's request line comes from recentMissions, the stale jobs line of /api/admin/stats is gone
    const activity = cardOf(html, "activity");
    expect(activity).toContain("سارة");
    expect(activity).not.toContain("قديم");
    expect(activity).toContain("١٢٠ نتيجة");
    // the money numbers are the same as before (moved, not changed)
    const money = cardOf(html, "money");
    expect(money).toContain("٤٬٨٠٠");
    expect(money).toContain("٣٬٦٠٠");
  });

  it("a TREG balance below its threshold shows the attention sentence and «منخفض» on the providers card; a healthy balance shows neither", async () => {
    const low = await renderLoaded(providersWith(12.4, true));
    expect(cardOf(low, "attention")).toContain("رصيد مزود البيانات منخفض: متبقٍ ١٢٫٤٠ دولار والحد المنبّه ٢٥ دولار.");
    expect(cardOf(low, "providers")).toContain(">منخفض<");
    const healthy = await renderLoaded(providersWith(80, false));
    expect(healthy).not.toContain("منخفض");
    expect(cardOf(healthy, "attention")).not.toContain("رصيد مزود البيانات");
  });

  it("a failing /api/admin/finance shows the points card's error with «أعد المحاولة»; every other card still renders", async () => {
    ctl.fail.add("/api/admin/finance");
    const html = await renderLoaded();
    const points = cardOf(html, "points");
    expect(points).toContain("تعذّر تحميل هذه البطاقة.");
    expect(points).toMatch(/<button[^>]*min-h-11[^>]*>أعد المحاولة<\/button>/);
    expect(cardOf(html, "missions")).toContain("نسبة النجاح");
    expect(cardOf(html, "today")).toContain("٢١٤");
    expect(cardOf(html, "visits")).toContain('role="group"');
    expect(cardOf(html, "money")).toContain("الإيرادات والتكاليف");
    expect(html.match(/تعذّر تحميل هذه البطاقة\./g)).toHaveLength(1);
  });

  it("every digit on the page is Arabic-Indic, except inside dir=ltr elements; no emoji; no physical left/right classes", async () => {
    const html = await renderLoaded(providersWith(12.4, true));
    expect(textOutsideLtr(html)).not.toMatch(/[0-9]/);
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(html).not.toMatch(/\b(?:ml|mr|pl|pr)-\S|\btext-(?:left|right)\b|\b(?:left|right)-[0-9]/);
  });
});
