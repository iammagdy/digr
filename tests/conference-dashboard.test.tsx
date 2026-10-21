import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ok: true,
  tables: {} as Record<string, any>,
  reads: [] as string[],
  real: null as null | { usd: number; at: number; source: "live" | "last_reading" },
  status: { todaySpendUsd: 0.2, todayCapUsd: 0.8, availableBalanceUsd: 0.5 } as any,
}));

vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: async () => state.ok ? { ok: true, ctx: {} } : { ok: false, response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) },
}));
vi.mock("../src/lib/supabase/server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      state.reads.push(table);
      const chain: any = {};
      for (const m of ["select", "eq", "lt", "gte", "in", "order", "limit", "range"]) chain[m] = () => chain;
      chain.then = (resolve: any, reject: any) => Promise.resolve(state.tables[table] ?? { data: [], error: null }).then(resolve, reject);
      return chain;
    },
  }),
}));
vi.mock("../src/functions/shared/providerSpend", () => ({
  getProviderBalanceStatus: async () => { if (state.status instanceof Error) throw state.status; return state.status; },
}));
vi.mock("../src/lib/server/realProviderBalance", () => ({ readRealProviderBalance: async () => state.real }));

import AdminConferencePage from "../src/app/admin/conference/page";
import { GET } from "../src/app/api/admin/conference/route";
import { CONFERENCE_CACHE_MS, resetConferenceCacheForTesting } from "../src/lib/server/conferenceCache";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import {
  MODEL_BUDGET_BAD_PERCENT, MODEL_BUDGET_WARN_PERCENT, NO_MODEL_BUDGET_AR, PENDING_TOPUPS_WARN, PROVIDER_CAP_WARN_PERCENT, QUEUED_JOBS_WARN,
  REAL_BALANCE_BAD_USD, REAL_BALANCE_MISSING_AR, REAL_BALANCE_WARN_USD, SIGNUPS_PER_MINUTE_WARN,
  bucketSignups, buildConferenceSnapshot, cairoStartOf, parseMonthlyBudgetUsd, type ConferenceInput,
} from "../src/lib/server/conferenceDashboard";

// Wednesday 21 October 2026, 12:00 UTC = 15:00 in Cairo (summer time, UTC+3, until the last Thursday of October).
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const MIN = 60_000;
const base = (extra: Partial<ConferenceInput> = {}): ConferenceInput => ({
  now: NOW, signups: null, messages: null, jobs: null, provider: null, ledger: null, modelUsage: null, monthlyBudgetUsd: null, topups: null, unserved: null, ...extra,
});
const texts = (input: Partial<ConferenceInput>) => buildConferenceSnapshot(base(input)).alerts;
const levels = (input: Partial<ConferenceInput>) => texts(input).map((a) => a.level);
const signupsAt = (count: number, ageMs = 5_000) => ({ rows: Array.from({ length: count }, () => ({ created_at: iso(-ageMs) })) });
const jobRow = (id: string, extra: Record<string, unknown> = {}) => ({ id, status: "queued", lease_until: null, updated_at: iso(-30_000), created_at: iso(-60_000), ...extra });

describe("Cairo day and month start", () => {
  it("midnight in Cairo, with the daylight-saving offset of that date", () => {
    // 21 Oct 2026 is still summer time (UTC+3): midnight Cairo is 21:00 UTC the day before.
    expect(new Date(cairoStartOf(NOW, "day")).toISOString()).toBe("2026-10-20T21:00:00.000Z");
    // 1 Oct 2026 00:00 Cairo (UTC+3).
    expect(new Date(cairoStartOf(NOW, "month")).toISOString()).toBe("2026-09-30T21:00:00.000Z");
    // Winter (UTC+2).
    expect(new Date(cairoStartOf(Date.UTC(2026, 11, 15, 10, 0, 0), "day")).toISOString()).toBe("2026-12-14T22:00:00.000Z");
  });
  it("a moment just after Cairo midnight belongs to the new Cairo day", () => {
    const justAfter = Date.UTC(2026, 9, 20, 21, 0, 30);
    expect(new Date(cairoStartOf(justAfter, "day")).toISOString()).toBe("2026-10-20T21:00:00.000Z");
    expect(new Date(cairoStartOf(Date.UTC(2026, 9, 20, 20, 59, 0), "day")).toISOString()).toBe("2026-10-19T21:00:00.000Z");
  });
});

describe("signups", () => {
  it("buckets per minute for the last 10 minutes, newest first, and ignores older rows", () => {
    const rows = [0, 30_000, 59_999, 60_000, 119_000, 540_000, 599_999, 600_000, 900_000].map((age) => ({ created_at: iso(-age) }));
    expect(bucketSignups(rows, NOW)).toEqual([3, 2, 0, 0, 0, 0, 0, 0, 0, 2]);
  });
  it("reports last minute, the 10-minute average and the 24 hour total", () => {
    const rows = [...signupsAt(5, 10_000).rows, ...signupsAt(15, 5 * MIN).rows, { created_at: iso(-3 * 3_600_000) }];
    const snapshot = buildConferenceSnapshot(base({ signups: { rows, total24h: 480 } }));
    expect(snapshot.signups).toEqual({ perMinute: [5, 0, 0, 0, 0, 15, 0, 0, 0, 0], lastMinute: 5, perMinuteAvg10: 2, total24h: 480 });
  });
  it("the total never falls under the rows it was given", () => {
    expect(buildConferenceSnapshot(base({ signups: { rows: signupsAt(3).rows, total24h: null } })).signups?.total24h).toBe(3);
  });
  it("warns above 40 a minute, not at or below it", () => {
    expect(SIGNUPS_PER_MINUTE_WARN).toBe(40);
    expect(levels({ signups: signupsAt(39) })).toEqual([]);
    expect(levels({ signups: signupsAt(40) })).toEqual([]);
    const above = texts({ signups: signupsAt(41) });
    expect(above.map((a) => a.level)).toEqual(["warn"]);
    expect(above[0].textAr).toContain("التسجيل أسرع من حد البريد المتوقع");
    expect(above[0].textAr).toContain("٤١");
  });
});

describe("active chats", () => {
  it("counts distinct users who sent a user message in the last 10 minutes and the messages of the last minute", () => {
    const messages = [
      { user_id: "a", role: "user", created_at: iso(-10_000) },
      { user_id: "a", role: "user", created_at: iso(-20_000) },
      { user_id: "b", role: "user", created_at: iso(-2 * MIN) },
      { user_id: "c", role: "assistant", created_at: iso(-10_000) },
      { user_id: "d", role: "user", created_at: iso(-10 * MIN) },
      { user_id: "e", role: "user", created_at: iso(-9 * MIN - 59_000) },
      { user_id: "f", role: "user", created_at: iso(-MIN) },
    ];
    expect(buildConferenceSnapshot(base({ messages })).activeChats).toEqual({ users: 4, messagesLastMinute: 2 });
  });
});

describe("jobs", () => {
  it("counts running, queued and stalled with the operations rules", () => {
    const jobs = [
      jobRow("r1", { status: "running", lease_until: iso(20_000) }),
      jobRow("q1"), jobRow("q2"),
      jobRow("s1", { status: "running", updated_at: iso(-10 * MIN) }),
    ];
    expect(buildConferenceSnapshot(base({ jobs })).jobs).toEqual({ running: 1, queued: 2, stalled: 1 });
  });
  it("any stalled job is bad; queued warns at 10 and not at 9", () => {
    expect(levels({ jobs: [jobRow("s", { updated_at: iso(-10 * MIN) })] })).toEqual(["bad"]);
    expect(QUEUED_JOBS_WARN).toBe(10);
    expect(levels({ jobs: Array.from({ length: 9 }, (_, i) => jobRow(`q${i}`)) })).toEqual([]);
    expect(levels({ jobs: Array.from({ length: 10 }, (_, i) => jobRow(`q${i}`)) })).toEqual(["warn"]);
    expect(levels({ jobs: Array.from({ length: 11 }, (_, i) => jobRow(`q${i}`)) })).toEqual(["warn"]);
  });
});

describe("provider", () => {
  const status = (todaySpendUsd: number) => ({ todaySpendUsd, todayCapUsd: 0.8, availableBalanceUsd: 0.5 });
  const real = (usd: number) => ({ usd, at: NOW - 12_000, source: "live" as const });
  it("daily cap: ok below 80%, warn at 80%, bad when reached", () => {
    expect(PROVIDER_CAP_WARN_PERCENT).toBe(80);
    const level = (spend: number) => buildConferenceSnapshot(base({ provider: { real: real(5), status: status(spend) } })).provider?.spend?.level;
    expect([level(0.63), level(0.64), level(0.79), level(0.8), level(1.2)]).toEqual(["ok", "warn", "warn", "reached", "reached"]);
    expect(levels({ provider: { real: real(5), status: status(0.63) } })).toEqual([]);
    expect(levels({ provider: { real: real(5), status: status(0.64) } })).toEqual(["warn"]);
    expect(levels({ provider: { real: real(5), status: status(0.8) } })).toEqual(["bad"]);
    const full = buildConferenceSnapshot(base({ provider: { real: real(5), status: status(0.4) } })).provider!.spend!;
    expect(full.percentOfCap).toBe(50);
  });
  it("real balance: ok at 0.15, warn below it, bad below 0.05", () => {
    expect([REAL_BALANCE_WARN_USD, REAL_BALANCE_BAD_USD]).toEqual([0.15, 0.05]);
    const run = (usd: number) => levels({ provider: { real: real(usd), status: status(0.1) } });
    expect([run(0.2), run(0.15), run(0.1499), run(0.05), run(0.0499), run(0)]).toEqual([[], [], ["warn"], ["warn"], ["bad"], ["bad"]]);
    const snapshot = buildConferenceSnapshot(base({ provider: { real: real(0.12), status: status(0.1) } }));
    expect(snapshot.provider?.real).toEqual({ usd: 0.12, ageSeconds: 12, source: "live" });
    expect(snapshot.alerts[0].textAr).toContain("اشحنه");
  });
  it("a missing real balance says so and falls back to a labelled estimate", () => {
    const snapshot = buildConferenceSnapshot(base({ provider: { real: null, status: status(0.1) } }));
    expect(snapshot.provider?.real).toBeNull();
    expect(snapshot.provider?.realLabelAr).toBe(REAL_BALANCE_MISSING_AR);
    expect(snapshot.provider?.realLabelAr).toBe("الرصيد الحقيقي غير متاح الآن");
    expect(snapshot.provider?.estimate).toMatchObject({ usd: 0.5 });
    expect(snapshot.provider?.estimate?.labelAr).toContain("تقدير");
    expect(snapshot.alerts).toEqual([{ level: "info", textAr: expect.stringContaining(REAL_BALANCE_MISSING_AR) }]);
  });
  it("no estimate is shown while the real balance is there", () => {
    expect(buildConferenceSnapshot(base({ provider: { real: real(2), status: status(0.1) } })).provider?.estimate).toBeNull();
  });
});

describe("top spenders", () => {
  it("sums charges per user, orders by points, cuts at 10, shows 8 characters and the profile name", () => {
    const rows: any[] = [];
    for (let i = 0; i < 12; i += 1) rows.push({ user_id: `user${String(i).padStart(2, "0")}-aaaa-bbbb`, delta: -(10 + i), type: "charge" });
    rows.push({ user_id: "user00-aaaa-bbbb", delta: -100, type: "charge" }, { user_id: "user00-aaaa-bbbb", delta: -5, type: "charge" });
    rows.push({ user_id: "user11-aaaa-bbbb", delta: 500, type: "refund" }, { user_id: "user05-aaaa-bbbb", delta: 50, type: "charge" });
    const profiles = [{ id: "user00-aaaa-bbbb", email: "a@example.com", sender_name: "أمل سعيد" }];
    const top = buildConferenceSnapshot(base({ ledger: { rows, truncated: false, profiles } })).topSpenders!;
    expect(top.rows).toHaveLength(10);
    expect(top.rows[0]).toEqual({ shortId: "user00-a", name: "أمل سعيد", email: "a@example.com", points: 115 });
    expect(top.rows.map((r) => r.points)).toEqual([115, 21, 20, 19, 18, 17, 16, 15, 14, 13]);
    expect(top.rows[1]).toMatchObject({ shortId: "user11-a", name: null, email: null });
    expect(top.rows.every((r) => r.shortId.length === 8)).toBe(true);
  });
  it("carries the truncation flag", () => {
    expect(buildConferenceSnapshot(base({ ledger: { rows: [], truncated: true, profiles: [] } })).topSpenders).toEqual({ rows: [], truncated: true });
  });
});

describe("model spend", () => {
  const rows = [
    { cost_usd: "0.5", created_at: iso(-60_000) }, // today (after 21:00 UTC the day before)
    { cost_usd: 0.25, created_at: iso(-14 * 3_600_000) }, // 22:00 UTC the day before = 01:00 Cairo today
    { cost_usd: 1, created_at: iso(-16 * 3_600_000) }, // 20:00 UTC the day before = before Cairo midnight, this month
    { cost_usd: 2, created_at: iso(-20 * 86_400_000) }, // 1 October (this month) at 12:00 UTC
    { cost_usd: 9, created_at: iso(-22 * 86_400_000) }, // 29 September, last month
    { cost_usd: null, created_at: iso(-1000) },
  ];
  it("sums today and this calendar month apart", () => {
    const spend = buildConferenceSnapshot(base({ modelUsage: { rows, truncated: false } })).modelSpend!;
    expect(spend.todayUsd).toBeCloseTo(0.75, 6);
    expect(spend.monthUsd).toBeCloseTo(3.75, 6);
    expect(spend.truncated).toBe(false);
  });
  it("carries the truncation flag", () => {
    expect(buildConferenceSnapshot(base({ modelUsage: { rows: [], truncated: true } })).modelSpend?.truncated).toBe(true);
  });
  it("without a budget it says so and raises no alert, however large the spend", () => {
    const snapshot = buildConferenceSnapshot(base({ modelUsage: { rows: [{ cost_usd: 1000, created_at: iso(-1000) }], truncated: false } }));
    expect(snapshot.modelSpend?.budget).toEqual({ monthlyUsd: null, percentUsed: null, noteAr: NO_MODEL_BUDGET_AR });
    expect(NO_MODEL_BUDGET_AR).toBe("لم تُضبط ميزانية النموذج الشهرية");
    expect(snapshot.alerts).toEqual([]);
  });
  it("with a budget it warns at 80% and is bad at 100%", () => {
    expect([MODEL_BUDGET_WARN_PERCENT, MODEL_BUDGET_BAD_PERCENT]).toEqual([80, 100]);
    const run = (month: number) => levels({ monthlyBudgetUsd: 10, modelUsage: { rows: [{ cost_usd: month, created_at: iso(-1000) }], truncated: false } });
    expect([run(7.9), run(8), run(9.9), run(10), run(12)]).toEqual([[], ["warn"], ["warn"], ["bad"], ["bad"]]);
  });
  it("only a positive number is a budget", () => {
    expect([parseMonthlyBudgetUsd(undefined), parseMonthlyBudgetUsd(""), parseMonthlyBudgetUsd("0"), parseMonthlyBudgetUsd("-5"), parseMonthlyBudgetUsd("abc"), parseMonthlyBudgetUsd("25")]).toEqual([null, null, null, null, null, 25]);
  });
});

describe("top-ups and unserved", () => {
  it("counts pending top-ups and sums EGP; warns at 5, not at 4", () => {
    expect(PENDING_TOPUPS_WARN).toBe(5);
    const topups = (n: number) => ({ rows: Array.from({ length: n }, () => ({ amount_egp: "100.5" })) });
    expect(buildConferenceSnapshot(base({ topups: topups(2) })).pendingTopups).toEqual({ count: 2, totalEgp: 201 });
    expect(levels({ topups: topups(4) })).toEqual([]);
    expect(levels({ topups: topups(5) })).toEqual(["warn"]);
    expect(levels({ topups: topups(6) })).toEqual(["warn"]);
  });
  it("summarises the unserved requests, top 5 families", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ id: String(i), user_id: "u", query: "موضوع غير معروف", created_at: iso(-1000) }));
    const unserved = buildConferenceSnapshot(base({ unserved: rows })).unserved!;
    expect(unserved.total).toBe(8);
    expect(unserved.families.length).toBeLessThanOrEqual(5);
    expect(unserved.families[0]).toMatchObject({ count: 8 });
  });
});

describe("alerts", () => {
  it("are ordered bad, warn, info and each carries an Arabic sentence of what to do", () => {
    const snapshot = buildConferenceSnapshot(base({
      signups: signupsAt(60),
      jobs: [jobRow("s", { updated_at: iso(-10 * MIN) })],
      provider: { real: null, status: { todaySpendUsd: 0.1, todayCapUsd: 0.8, availableBalanceUsd: 0.5 } },
    }));
    expect(snapshot.alerts.map((a) => a.level)).toEqual(["bad", "warn", "info"]);
    for (const alert of snapshot.alerts) expect(alert.textAr).toMatch(/[؀-ۿ]/);
  });
  it("sections that were not read stay null", () => {
    const snapshot = buildConferenceSnapshot(base({ notes: ["x"] }));
    expect([snapshot.signups, snapshot.activeChats, snapshot.jobs, snapshot.provider, snapshot.topSpenders, snapshot.modelSpend, snapshot.pendingTopups, snapshot.unserved]).toEqual(Array(8).fill(null));
    expect(snapshot.notes).toEqual(["x"]);
  });
});

describe("the route", () => {
  const req = () => ({ headers: new Headers() }) as any;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    resetConferenceCacheForTesting();
    state.ok = true;
    state.reads = [];
    state.real = { usd: 3.21, at: NOW - 5000, source: "live" };
    state.status = { todaySpendUsd: 0.2, todayCapUsd: 0.8, availableBalanceUsd: 0.5 };
    state.tables = {
      profiles: { data: [{ created_at: iso(-10_000) }, { created_at: iso(-70_000) }], error: null, count: 250 },
      messages: { data: [{ user_id: "u1", role: "user", created_at: iso(-5000) }], error: null },
      jobs: { data: [jobRow("j1")], error: null },
      credit_ledger: { data: [{ user_id: "secretuser-1234", delta: -40, type: "charge" }], error: null },
      llm_usage: { data: [{ cost_usd: 0.5, created_at: iso(-1000) }], error: null },
      topups: { data: [{ amount_egp: 300 }], error: null, count: 1 },
      capability_requests: { data: [], error: null },
    };
    delete process.env.MODEL_MONTHLY_BUDGET_USD;
  });
  afterEach(() => { vi.useRealTimers(); });

  it("gives an admin the snapshot", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.signups).toMatchObject({ lastMinute: 1, total24h: 250 });
    expect(body.activeChats).toEqual({ users: 1, messagesLastMinute: 1 });
    expect(body.jobs).toEqual({ running: 0, queued: 1, stalled: 0 });
    expect(body.provider.real.usd).toBe(3.21);
    expect(body.provider.spend.level).toBe("ok");
    expect(body.topSpenders.rows[0]).toMatchObject({ shortId: "secretus", points: 40 });
    expect(body.modelSpend.monthUsd).toBe(0.5);
    expect(body.modelSpend.budget.noteAr).toBe(NO_MODEL_BUDGET_AR);
    expect(body.pendingTopups).toEqual({ count: 1, totalEgp: 300 });
    expect(body.notes).toEqual([]);
  });

  it("applies the monthly budget from the environment", async () => {
    process.env.MODEL_MONTHLY_BUDGET_USD = "0.5";
    const body = await (await GET(req())).json();
    expect(body.alerts.some((a: any) => a.level === "bad" && a.textAr.includes("الميزانية"))).toBe(true);
  });

  it("refuses a non-admin with 403 and no data, and reads nothing", async () => {
    state.ok = false;
    const res = await GET(req());
    expect(res.status).toBe(403);
    const text = await res.text();
    for (const leak of ["secretus", "3.21", "signups", "topSpenders", "lastMinute"]) expect(text).not.toContain(leak);
    expect(state.reads).toEqual([]);
  });

  it("a failing read makes only that section null, with a note", async () => {
    state.tables.credit_ledger = { data: null, error: { message: "boom" } };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.topSpenders).toBeNull();
    expect(body.notes).toEqual(["تعذّر قراءة أكثر المستخدمين استهلاكًا الآن."]);
    expect(body.signups).not.toBeNull();
    expect(body.jobs).not.toBeNull();
    expect(body.modelSpend).not.toBeNull();
  });

  it("when the provider spend read fails the real balance still shows", async () => {
    state.status = new Error("down");
    const body = await (await GET(req())).json();
    expect(body.provider.real.usd).toBe(3.21);
    expect(body.provider.spend).toBeNull();
    expect(body.notes).toEqual(["تعذّر قراءة إنفاق المزود اليوم."]);
  });

  it("the cache serves a second call within 8 seconds without new reads, then reads again", async () => {
    await GET(req());
    const first = state.reads.length;
    expect(first).toBeGreaterThanOrEqual(7);
    vi.setSystemTime(NOW + CONFERENCE_CACHE_MS - 1);
    await GET(req());
    expect(state.reads.length).toBe(first);
    vi.setSystemTime(NOW + CONFERENCE_CACHE_MS);
    await GET(req());
    expect(state.reads.length).toBeGreaterThan(first);
  });

  it("two simultaneous calls share one set of reads", async () => {
    await Promise.all([GET(req()), GET(req()), GET(req())]);
    expect(state.reads.filter((t) => t === "jobs")).toHaveLength(1);
  });

  it("is read only: no write, no rpc in the route source, no model call, no migrations", () => {
    const source = readFileSync("src/app/api/admin/conference/route.ts", "utf8");
    for (const forbidden of [".insert(", ".update(", ".upsert(", ".delete(", ".rpc("]) expect(source).not.toContain(forbidden);
    expect(source).toContain('dynamic = "force-dynamic"');
    expect(source).toContain("authenticateAdmin");
    expect(source).toContain("Promise.all");
    expect(source).toContain(".limit(");
  });
});

describe("the page and the menu", () => {
  it("is in the admin menu", () => {
    expect(ADMIN_PAGES.find(([id]) => id === "conference")![1]).toBe("لوحة المؤتمر");
    expect(adminHref("conference")).toBe("/admin/conference");
    const shell = readFileSync("src/components/admin/AdminShell.tsx", "utf8");
    expect(shell).toContain('"requests", "conference", "settings"');
  });

  it("renders its Arabic sections", () => {
    const html = renderToStaticMarkup(createElement(AdminConferencePage));
    for (const text of ["تنبيهات", "التسجيل في آخر ١٠ دقائق", "المحادثات النشطة", "المزود والحد اليومي", "أكثر المستخدمين استهلاكًا للنقاط اليوم", "إنفاق النموذج", "طلبات الشحن المعلقة", "طلبات لا نبيعها", "حدود التنبيه"]) expect(html).toContain(text);
    expect((html.match(/data-testid="conf-tile"/g) || []).length).toBe(5);
    expect(html).not.toMatch(/treg/i);
  });

  it("polls every 10 s with a 0-2 s jitter and stops while the page is hidden", () => {
    const source = readFileSync("src/app/admin/conference/page.tsx", "utf8");
    expect(source).toContain("POLL_MS = 10_000");
    expect(source).toContain("JITTER_MS = 2_000");
    expect(source).toContain("Math.random()");
    expect(source).toContain("document.hidden");
    expect(source).toContain("visibilitychange");
  });
});
