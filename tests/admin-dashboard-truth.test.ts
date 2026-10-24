import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMIN_JOB_STATE_LABEL_AR, ADMIN_JOB_TAB_STATES, adminJobState, releasedPoints, successRate, type AdminJobState } from "../src/lib/server/adminJobState";
import { QUEUED_STUCK_AFTER_MS, STALLED_AFTER_MS, classifyJob, type JobRowLite } from "../src/lib/server/adminOperations";
import { HIDE_TEST_ACCOUNTS_LABEL_AR, TEST_ACCOUNT_DOMAIN, TEST_ACCOUNT_EMAILS, hidesTestAccounts, isTestAccountEmail, testAccountIds } from "../src/lib/server/adminTestAccounts";
import { buildConferenceSnapshot, withoutTestAccounts, type ConferenceInput } from "../src/lib/server/conferenceDashboard";
import { STALL_AFTER_MS } from "../src/lib/jobStall";

const NOW = Date.parse("2026-10-24T10:00:00.000Z");
const MIN = 60_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const TEST_IDS = new Set(["test-concurrency", "test-magdy"]);

describe("one status per job, the same everywhere", () => {
  const base = { id: "j", lease_until: null, updated_at: at(-MIN), created_at: at(-2 * MIN) };
  const state = (extra: Record<string, unknown>) => adminJobState({ ...base, status: "completed", delivered_units: 0, charged_credits: 0, ...extra } as any, NOW);

  it("completed with delivered rows or a charge is done", () => {
    expect(state({ delivered_units: 31, charged_credits: 401 })).toBe("done");
    expect(state({ delivered_units: 0, charged_credits: 5 })).toBe("done");
  });
  it("completed with nothing delivered and nothing charged is a released hold, not running", () => {
    expect(state({ delivered_units: 0, charged_credits: 0 })).toBe("refunded");
    expect(state({ delivered_units: null, charged_credits: null })).toBe("refunded");
  });
  it("failed (with or without partial delivery) and refused are ended", () => {
    expect(state({ status: "failed", delivered_units: 8, charged_credits: 0 })).toBe("failed");
    expect(state({ status: "failed", delivered_units: 0 })).toBe("failed");
    expect(state({ status: "refused" })).toBe("refused");
  });
  it("running with a live lease is running", () => {
    expect(state({ status: "running", lease_until: at(30_000), updated_at: at(-12 * DAY) })).toBe("running");
  });
  it("running with no live lease and no progress for the admin threshold is stalled", () => {
    expect(state({ status: "running", lease_until: null, updated_at: at(-12 * DAY), created_at: at(-12 * DAY) })).toBe("stalled");
    expect(state({ status: "running", updated_at: at(-STALLED_AFTER_MS) })).toBe("stalled");
    expect(state({ status: "running", updated_at: at(-STALLED_AFTER_MS + 1000) })).toBe("running");
  });
  it("queued and old is «عالقة في الانتظار», never running or stalled", () => {
    expect(state({ status: "queued", created_at: at(-12 * DAY), updated_at: at(-12 * DAY) })).toBe("queued_stuck");
    expect(ADMIN_JOB_STATE_LABEL_AR.queued_stuck).toBe("عالقة في الانتظار");
  });
  it("queued and recent is queued", () => {
    expect(state({ status: "queued", created_at: at(-5 * MIN), updated_at: at(-MIN) })).toBe("queued");
  });
  it("an unknown status is shown as unknown, never as running", () => {
    expect(state({ status: "done" })).toBe("unknown");
    expect(state({ status: "cancelled" })).toBe("unknown");
  });

  it("the admin flags a stall at three minutes, the customer sees one at ten, the queue threshold is thirty", () => {
    expect(STALLED_AFTER_MS).toBe(3 * MIN);
    expect(STALL_AFTER_MS).toBe(10 * MIN);
    expect(QUEUED_STUCK_AFTER_MS).toBe(30 * MIN);
    const job = (extra: Partial<JobRowLite>): JobRowLite => ({ id: "j", status: "queued", lease_until: null, updated_at: at(0), created_at: at(0), ...extra });
    expect(classifyJob(job({ created_at: at(-QUEUED_STUCK_AFTER_MS + 1000) }), NOW)).toBe("queued");
    expect(classifyJob(job({ created_at: at(-QUEUED_STUCK_AFTER_MS) }), NOW)).toBe("queued_stuck");
  });

  it("every label is Arabic only, with no Latin letters and no emoji", () => {
    for (const label of Object.values(ADMIN_JOB_STATE_LABEL_AR)) {
      expect(label).not.toMatch(/[A-Za-z]/);
      expect(label).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("tab filters", () => {
  it("each tab names the states it shows", () => {
    expect(ADMIN_JOB_TAB_STATES.all).toBe("all");
    expect(ADMIN_JOB_TAB_STATES.running).toEqual(["running", "queued", "queued_stuck", "stalled"]);
    expect(ADMIN_JOB_TAB_STATES.done).toEqual(["done"]);
    expect(ADMIN_JOB_TAB_STATES.failed).toEqual(["failed", "refused"]);
    expect(ADMIN_JOB_TAB_STATES.refunded).toEqual(["refunded"]);
  });
});

describe("success rate and released points", () => {
  const rows = (states: Array<[AdminJobState, number]>) => states.map(([state, delivered]) => ({ state, delivered }));

  it("numerator = ended jobs with a delivered unit, denominator = ended jobs; live jobs are not counted", () => {
    const rate = successRate(rows([["done", 31], ["refunded", 0], ["failed", 8], ["refused", 0], ["running", 12], ["queued", 0], ["stalled", 0], ["queued_stuck", 0]]));
    expect(rate).toEqual({ numerator: 2, denominator: 4, percent: 50, failedWithDelivery: 1 });
  });
  it("no ended job gives no percentage at all, not zero", () => {
    expect(successRate(rows([["running", 3]]))).toEqual({ numerator: 0, denominator: 0, percent: null, failedWithDelivery: 0 });
  });
  it("released points are the sum of the release rows only", () => {
    const ledger = [
      { type: "release", delta: 300 },
      { type: "release", delta: 200 },
      { type: "charge", delta: -401 },
      { type: "reserve", delta: -2973 },
    ];
    expect(releasedPoints(ledger)).toEqual({ points: 500, rows: 2 });
    expect(releasedPoints([])).toEqual({ points: 0, rows: 0 });
  });
});

describe("test accounts", () => {
  it("lists the two owner test accounts and the @digr.local domain", () => {
    expect([...TEST_ACCOUNT_EMAILS].sort()).toEqual(["iam.magdy+1@outlook.com", "magdy.saber@outlook.com"]);
    expect(TEST_ACCOUNT_DOMAIN).toBe("@digr.local");
    expect(isTestAccountEmail("iam.magdy+1@outlook.com")).toBe(true);
    expect(isTestAccountEmail("MAGDY.SABER@outlook.com")).toBe(true);
    expect(isTestAccountEmail("test_concurrency@digr.local")).toBe(true);
  });
  it("never lists the real guest", () => {
    expect(isTestAccountEmail("hala.elalfy2026@gmail.com")).toBe(false);
    expect(TEST_ACCOUNT_EMAILS.join(" ")).not.toMatch(/hala/i);
  });
  it("is hidden unless the request asks for hideTest=0", () => {
    expect(hidesTestAccounts(null)).toBe(true);
    expect(hidesTestAccounts(undefined)).toBe(true);
    expect(hidesTestAccounts("1")).toBe(true);
    expect(hidesTestAccounts("0")).toBe(false);
  });
  it("collects only string ids of test profiles", () => {
    const ids = testAccountIds([{ id: "a", email: "x@digr.local" }, { id: "b", email: "hala.elalfy2026@gmail.com" }, { id: null, email: "magdy.saber@outlook.com" }, { id: 7, email: "magdy.saber@outlook.com" }]);
    expect([...ids]).toEqual(["a"]);
  });
  it("the toggle label is Arabic", () => {
    expect(HIDE_TEST_ACCOUNTS_LABEL_AR).toBe("إخفاء حسابات الاختبار");
  });
});

describe("conference counts with and without the test accounts", () => {
  const input = (extra: Partial<ConferenceInput>): ConferenceInput => ({
    now: NOW, signups: null, messages: null, jobs: null, provider: null, ledger: null, modelUsage: null, monthlyBudgetUsd: null, topups: null, unserved: null, notes: [], ...extra,
  });
  const jobs = [
    { id: "real-running", user_id: "hala-real", status: "running", lease_until: at(20_000), updated_at: at(-5_000), created_at: at(-MIN) },
    { id: "real-queued", user_id: "hala-real", status: "queued", lease_until: null, updated_at: at(-MIN), created_at: at(-MIN) },
    { id: "real-stalled", user_id: "guest-real-1", status: "running", lease_until: null, updated_at: at(-15 * MIN), created_at: at(-20 * MIN) },
    { id: "test-stalled", user_id: "test-concurrency", status: "running", lease_until: null, updated_at: at(-12 * DAY), created_at: at(-12 * DAY) },
    { id: "test-stuck", user_id: "test-concurrency", status: "queued", lease_until: null, updated_at: at(-12 * DAY), created_at: at(-12 * DAY) },
    { id: "test-stuck-2", user_id: "test-magdy", status: "queued", lease_until: null, updated_at: at(-12 * DAY), created_at: at(-12 * DAY) },
  ];

  it("counts the test leftovers as stalled and stuck when they are shown", () => {
    const snapshot = buildConferenceSnapshot(input({ jobs }));
    expect(snapshot.jobs).toEqual({ running: 1, queued: 1, stalled: 2 });
    expect(snapshot.jobList!.queuedStuck.map((item) => item.id)).toEqual(["test-stuck", "test-stuck-2"]);
    expect(snapshot.jobList!.stalled.map((item) => item.id)).toEqual(["real-stalled", "test-stalled"]);
    expect(snapshot.alerts.map((alert) => alert.textAr).join(" ")).toContain("عالق في الانتظار");
  });

  it("hiding the test accounts keeps every real guest's job and drops the leftovers from every count", () => {
    const hidden = buildConferenceSnapshot(withoutTestAccounts(input({ jobs }), TEST_IDS));
    expect(hidden.jobs).toEqual({ running: 1, queued: 1, stalled: 1 });
    expect(hidden.jobList!.running.map((item) => item.id)).toEqual(["real-running"]);
    expect(hidden.jobList!.queued.map((item) => item.id)).toEqual(["real-queued"]);
    expect(hidden.jobList!.stalled.map((item) => item.id)).toEqual(["real-stalled"]);
    expect(hidden.jobList!.queuedStuck).toEqual([]);
    expect(hidden.alerts.map((alert) => alert.textAr).join(" ")).not.toContain("عالق في الانتظار");
  });

  it("the stalled item tells the minutes idle; a queued item tells the minutes waiting", () => {
    const snapshot = buildConferenceSnapshot(input({ jobs: [jobs[2], jobs[1]] }));
    expect(snapshot.jobList!.stalled).toEqual([{ id: "real-stalled", minutes: 15 }]);
    expect(snapshot.jobList!.queued).toEqual([{ id: "real-queued", minutes: 1 }]);
  });

  it("removing the test accounts changes no input and returns the same object when nothing is a test account", () => {
    const source = input({ jobs });
    expect(withoutTestAccounts(source, new Set())).toBe(source);
    expect(source.jobs!.length).toBe(6);
  });

  it("the signups count drops the test signups that were counted", () => {
    const source = input({ signups: { rows: [{ id: "test-magdy", created_at: at(-1000) }, { id: "hala-real", created_at: at(-2000) }], total24h: 5 } });
    expect(withoutTestAccounts(source, TEST_IDS).signups).toEqual({ rows: [{ id: "hala-real", created_at: at(-2000) }], total24h: 4 });
  });
});

describe("admin jobs page source", () => {
  it("shows the toggle, on by default, and passes it to the route", () => {
    const source = readFileSync("src/app/admin/jobs/page.tsx", "utf8");
    expect(source).toContain("useState(true)");
    expect(source).toContain("HIDE_TEST_ACCOUNTS_LABEL_AR");
    expect(source).toContain("hideTest=${hideTest ? 1 : 0}");
  });
});

// ---- The route, end to end: the real adapter, the real queries, an in-memory Supabase-style client. ----

type Row = Record<string, any>;
const mock = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, auth: null as any }));

vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => ({}), createServerSideClient: async () => ({}) }));
vi.mock("../src/lib/server/adminAuth", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, authenticateAdmin: async () => mock.auth };
});

function fakeAdminClient(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const filters: Array<(row: Row) => boolean> = [];
      let order: { col: string; ascending: boolean } | null = null;
      let rangeFrom = 0;
      let rangeTo = Number.POSITIVE_INFINITY;
      const run = () => {
        let out = rows.filter((row) => filters.every((keep) => keep(row)));
        const count = out.length;
        if (order) {
          const { col, ascending } = order;
          out = [...out].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1));
        }
        const end = Number.isFinite(rangeTo) ? rangeTo + 1 : undefined;
        return { data: out.slice(rangeFrom, end), count, error: null };
      };
      const query: any = {
        select: () => query,
        eq: (col: string, value: unknown) => { filters.push((row) => row[col] === value); return query; },
        in: (col: string, values: unknown[]) => { filters.push((row) => values.includes(row[col])); return query; },
        gte: (col: string, value: string) => { filters.push((row) => row[col] >= value); return query; },
        lte: (col: string, value: string) => { filters.push((row) => row[col] <= value); return query; },
        order: (col: string, opts?: { ascending?: boolean }) => { order = { col, ascending: opts?.ascending !== false }; return query; },
        range: (from: number, to: number) => { rangeFrom = from; rangeTo = to; return query; },
        then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
      };
      return query;
    },
  };
}

const job = (id: string, user: string, extra: Row) => ({
  id, user_id: user, endpoint_id: "social-tiktok-comments", params: JSON.stringify({ query: "كرة السلة في مصر" }),
  target_volume_max: 50, reserved_credits: 0, charged_credits: 0, delivered_units: 0, lease_until: null,
  created_at: at(-2 * 60 * MIN), updated_at: at(-2 * 60 * MIN), status: "completed", ...extra,
});

const HALA = "hala-real";
const GUEST = "guest-real-1";
const TEST_USER = "test-concurrency";
const TEST_MAGDY = "test-magdy";

function seed() {
  mock.tables = {
    jobs: [
      job("j-done", HALA, { delivered_units: 31, charged_credits: 401, reserved_credits: 2973, created_at: at(-2 * 60 * MIN) }),
      job("j-zero", GUEST, { status: "completed", reserved_credits: 300, created_at: at(-3 * 60 * MIN) }),
      job("j-fail-partial", GUEST, { status: "failed", delivered_units: 8, reserved_credits: 200, created_at: at(-90 * MIN), updated_at: at(-60 * MIN) }),
      job("j-refused", GUEST, { status: "refused", reserved_credits: 50, created_at: at(-4 * 60 * MIN) }),
      job("j-live", GUEST, { status: "running", delivered_units: 12, reserved_credits: 100, lease_until: at(30_000), updated_at: at(-10_000), created_at: at(-5 * MIN) }),
      job("j-queued-fresh", HALA, { status: "queued", reserved_credits: 60, created_at: at(-5 * MIN), updated_at: at(-MIN) }),
      job("j-stalled-real", GUEST, { status: "running", reserved_credits: 80, created_at: at(-20 * MIN), updated_at: at(-15 * MIN) }),
      job("t-stuck-queued", TEST_USER, { status: "queued", reserved_credits: 10, created_at: at(-12 * DAY), updated_at: at(-12 * DAY) }),
      job("t-stalled-running", TEST_USER, { status: "running", reserved_credits: 8, created_at: at(-12 * DAY), updated_at: at(-12 * DAY) }),
      job("t-done", TEST_MAGDY, { status: "completed", delivered_units: 5, charged_credits: 3, reserved_credits: 5, created_at: at(-MIN * 60) }),
    ],
    credit_ledger: [
      { id: "rel_j-zero", user_id: GUEST, delta: 300, type: "release", job_id: "j-zero", created_at: at(-3 * 60 * MIN) },
      { id: "rel_j-fail-partial", user_id: GUEST, delta: 200, type: "release", job_id: "j-fail-partial", created_at: at(-60 * MIN) },
      { id: "rel_t-done", user_id: TEST_MAGDY, delta: 50, type: "release", job_id: "t-done", created_at: at(-60 * MIN) },
      { id: "rel_old", user_id: GUEST, delta: 999, type: "release", job_id: "old", created_at: at(-40 * DAY) },
      { id: "charge_j-done", user_id: HALA, delta: -401, type: "charge", job_id: "j-done", created_at: at(-2 * 60 * MIN) },
    ],
    provider_costs: [
      { id: 1, job_id: "j-done", provider: "treg", cost_usd: 0.0123, created_at: at(-2 * 60 * MIN) },
      { id: 2, job_id: "j-done", provider: "treg", cost_usd: 0.02, created_at: at(-2 * 60 * MIN) },
      { id: 3, job_id: "j-done", provider: "llm", cost_usd: 0.9, created_at: at(-2 * 60 * MIN) },
      { id: 4, job_id: "t-done", provider: "treg", cost_usd: 0.5, created_at: at(-60 * MIN) },
    ],
    profiles: [
      { id: HALA, email: "hala.elalfy2026@gmail.com", name: "هالة" },
      { id: GUEST, email: "guest@example.com", name: "ضيف" },
      { id: TEST_USER, email: "test_concurrency@digr.local", name: "اختبار" },
      { id: TEST_MAGDY, email: "magdy.saber@outlook.com", name: "مجدي" },
    ],
  };
}

async function readJobs(query: string) {
  const { GET } = await import("../src/app/api/admin/jobs/route");
  const req = { nextUrl: new URL(`https://digr.test/api/admin/jobs?${query}`), headers: new Headers() } as any;
  const res = await GET(req);
  return { status: res.status, body: await res.json() };
}

describe("admin jobs route on the database shape", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    seed();
    const { createSupabaseTablesAdapter } = await import("../src/lib/server/adminAuth");
    const tables = createSupabaseTablesAdapter(fakeAdminClient(mock.tables));
    const users = { get: async ({ userId }: { userId: string }) => { const p = mock.tables.profiles.find((row) => row.id === userId); return { name: p?.name ?? "", email: p?.email ?? "" }; } };
    mock.auth = { ok: true, ctx: { tables, users } };
  });
  afterEach(() => { vi.useRealTimers(); });

  it("with the test accounts hidden (the default): statuses, cards and rows come from the real states, the real guest stays", async () => {
    const { status, body } = await readJobs("status=all");
    expect(status).toBe(200);
    expect(body.hideTest).toBe(true);

    const byId = Object.fromEntries(body.jobs.map((row: any) => [row.id, row]));
    expect(Object.keys(byId).sort()).toEqual(["j-done", "j-fail-partial", "j-live", "j-queued-fresh", "j-refused", "j-stalled-real", "j-zero"]);
    expect(byId["j-done"].status).toBe("done");
    expect(byId["j-zero"].status).toBe("refunded");
    expect(byId["j-fail-partial"].status).toBe("failed");
    expect(byId["j-refused"].status).toBe("refused");
    expect(byId["j-live"].status).toBe("running");
    expect(byId["j-queued-fresh"].status).toBe("queued");
    expect(byId["j-stalled-real"].status).toBe("stalled");

    // Delivered comes from delivered_units, the requested volume from the job, the cost in USD from cost_usd of the TREG rows only.
    expect(byId["j-done"]).toMatchObject({ delivered: 31, requested: 50, held: 2973, charged: 401 });
    expect(byId["j-done"].costUsd).toBeCloseTo(0.0323, 6);
    expect(byId["j-zero"].costUsd).toBeNull();

    // last 30 days: the seven real jobs (the 12-day leftovers are hidden, the 40-day-old release is out of the period).
    expect(body.stats.last30).toBe(7);
    // open: the live job and the fresh queued job; the stalled real job is stalled, not running.
    expect(body.stats.runningNow).toBe(2);
    expect(body.stats.stalled).toBe(1);
    expect(body.stats.queuedStuck).toBe(0);
    expect(body.open.map((o: any) => o.id).sort()).toEqual(["j-live", "j-queued-fresh", "j-stalled-real"]);
    // success: ended = done, refunded, failed, refused (4); with a delivered unit = 2 (31 rows, 8 rows before a failure).
    expect(body.stats.success).toEqual({ numerator: 2, denominator: 4, percent: 50, failedWithDelivery: 1 });
    // released: the two real release rows (300 + 200); the test release (50) and the 40-day-old one are not in the figure.
    expect(body.stats.released).toEqual({ points: 500, rows: 2 });
  });

  it("with the toggle off, the leftovers show with their own states and the cards count them", async () => {
    const { body } = await readJobs("status=all&hideTest=0");
    expect(body.hideTest).toBe(false);
    const byId = Object.fromEntries(body.jobs.map((row: any) => [row.id, row]));
    expect(byId["t-stuck-queued"].status).toBe("queued_stuck");
    expect(byId["t-stalled-running"].status).toBe("stalled");
    expect(byId["t-done"].status).toBe("done");
    expect(body.stats.last30).toBe(10);
    expect(body.stats.stalled).toBe(2);
    expect(body.stats.queuedStuck).toBe(1);
    expect(body.stats.released).toEqual({ points: 550, rows: 3 });
  });

  it("a tab shows only its states", async () => {
    const running = await readJobs("status=running");
    expect(running.body.jobs.map((row: any) => row.id).sort()).toEqual(["j-live", "j-queued-fresh", "j-stalled-real"]);
    const refunded = await readJobs("status=refunded");
    expect(refunded.body.jobs.map((row: any) => row.id)).toEqual(["j-zero"]);
    const failed = await readJobs("status=failed");
    expect(failed.body.jobs.map((row: any) => row.id).sort()).toEqual(["j-fail-partial", "j-refused"]);
  });
});
