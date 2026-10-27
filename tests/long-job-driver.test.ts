import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * The always-on driver (/api/cron/drive) against the REAL worker route, with a fake clock and an in-memory database whose
 * claim_job_chunk behaves like the real one (a 60 s lease and the expected step). The database functions that move money
 * (reserve, settle, release) are stand-ins here: this file proves the driver never moves money itself and that the existing worker
 * path settles once, with the delivered rows only, when a chain is resumed, killed, raced or stopped mid-job.
 */

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  notifications: [] as any[],
  unitPrice: 2,
  reserved: 69,
  spendAllowed: true,
  claimsRefused: [] as string[],
  killAfterClaim: false,
  dispatchLog: [] as Array<{ jobId: string; step: number }>,
}));

const nowMs = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** The few query shapes the driver and the worker use against `jobs`, evaluated for real. */
function jobsQuery() {
  const preds: Array<(row: any) => boolean> = [];
  let max = Infinity;
  let sortKey: string | null = null;
  const run = () => {
    let rows = db.jobs.filter((row) => preds.every((p) => p(row)));
    if (sortKey) rows = [...rows].sort((a, b) => String(a[sortKey!]).localeCompare(String(b[sortKey!])));
    return rows.slice(0, max);
  };
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { preds.push((row) => row[col] === val); return api; },
    in: (col: string, vals: unknown[]) => { preds.push((row) => vals.includes(row[col])); return api; },
    gt: (col: string, val: string) => { preds.push((row) => String(row[col]) > val); return api; },
    lt: (col: string, val: string) => { preds.push((row) => String(row[col]) < val); return api; },
    lte: () => api,
    not: () => api,
    or: (expr: string) => {
      const lease = /^lease_until\.is\.null,lease_until\.lt\.(.+)$/.exec(expr);
      if (lease) preds.push((row) => !row.lease_until || String(row.lease_until) < lease[1]);
      return api;
    },
    order: (col: string) => { sortKey = col; return api; },
    limit: (n: number) => { max = n; return api; },
    maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: run(), error: null }).then(resolve, reject),
  };
  return api;
}

function notificationsQuery() {
  const api: any = {
    select: () => api, eq: () => api, like: () => api,
    then: (resolve: any, reject: any) => Promise.resolve({ count: db.notifications.length, data: null, error: null }).then(resolve, reject),
    insert: async (row: any) => {
      if (db.notifications.some((existing) => existing.id === row.id)) return { error: { code: "23505" } };
      db.notifications.push(row);
      return { error: null };
    },
  };
  return api;
}

const jobRow = (id: string) => db.jobs.find((row) => row.id === id);

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      const job = jobRow(args?.p_job_id);
      if (name === "claim_job_chunk") {
        if (!job || !["queued", "running"].includes(job.status)) { db.claimsRefused.push("not_runnable"); return { data: { claimed: false, error: "job_not_runnable" }, error: null }; }
        if (job.lease_until && String(job.lease_until) > iso(nowMs())) { db.claimsRefused.push("lease_held"); return { data: { claimed: false, error: "lease_held" }, error: null }; }
        if (job.step !== args.p_expected_step) { db.claimsRefused.push("step_mismatch"); return { data: { claimed: false, error: "step_mismatch" }, error: null }; }
        Object.assign(job, { status: "running", lease_until: iso(nowMs() + args.p_lease_seconds * 1000), updated_at: iso(nowMs()) });
        return { data: { claimed: true, job_id: job.id, user_id: job.user_id, step: job.step, current_cursor: job.current_cursor, delivered_units: job.delivered_units, target_volume_max: job.target_volume_max, target_volume_min: 1, endpoint_id: "x-keyword-search", unit_price: db.unitPrice }, error: null };
      }
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: db.spendAllowed, cost_id: db.spendAllowed ? 11 : null }, error: null };
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        Object.assign(job, { step: job.step + 1, delivered_units: args.p_new_delivered_units, current_cursor: args.p_new_cursor, lease_until: null, updated_at: iso(nowMs()) });
        return { data: { success: true, delivered_units: job.delivered_units }, error: null };
      }
      if (name === "settle_job_atomic") {
        if (job.status === "completed") return { data: { success: true, already_settled: true, charged_credits: job.charged }, error: null };
        const charged = Math.min(Math.ceil(job.delivered_units * db.unitPrice), db.reserved);
        Object.assign(job, { status: "completed", lease_until: null, charged });
        return { data: { success: true, delivered_units: job.delivered_units, charged_credits: charged, released_credits: db.reserved - charged }, error: null };
      }
      if (name === "release_job_atomic") {
        if (job) Object.assign(job, { status: "failed", lease_until: null });
        return { data: { success: true, released_credits: db.reserved }, error: null };
      }
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => { store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); return { data: { path }, error: null }; },
          download: async (path: string) => {
            const buf = store.get(path);
            return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } };
          },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return jobsQuery();
      if (table === "notifications") return notificationsQuery();
      if (table === "plans_quotes") { const q: any = jobsQuery(); return { ...q, select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: async () => ({ data: db.quotes.find((row) => row.id === v) ?? null, error: null }), then: (r: any) => r({ data: db.quotes.filter((row) => row.id === v), error: null }) }) }) }; }
      if (table === "job_events" || table === "artifact_versions") {
        const base: any = { select: () => base, eq: () => base, in: () => base, order: () => base, limit: () => base, maybeSingle: async () => ({ data: null, error: null }), then: (r: any) => r({ data: table === "job_events" ? db.events : [], error: null }) };
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push({ created_at: iso(nowMs()), ...row }); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return jobsQuery();
    },
  })),
}));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async () => ({ ok: true })),
  getRecipient: vi.fn(async () => null),
}));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

/** The driver's only outbound call is the worker route: here it is the REAL route, run once per dispatch with no self-chain. */
vi.mock("../src/lib/server/workerDispatch", () => ({
  dispatchWorkerChunk: vi.fn(async (_base: string, jobId: string, expectedStep: number) => {
    db.dispatchLog.push({ jobId, step: expectedStep });
    if (db.killAfterClaim) {
      // the serverless instance dies right after it took the lease: the lease stays, no chunk is completed
      await (await import("../src/lib/supabase/server")).createAdminClient().rpc("claim_job_chunk", { p_job_id: jobId, p_expected_step: expectedStep, p_lease_seconds: 60 });
      throw new Error("instance killed");
    }
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer driver-test-secret" },
      body: JSON.stringify({ jobId, expectedStep, disableSelfChain: true }),
    }));
    const body = await res.json().catch(() => ({}));
    return { started: res.ok && body?.success === true && body?.claimed !== false, status: res.status, body };
  }),
}));

import { GET } from "../src/app/api/cron/drive/route";
import { DRIVER_DISPATCH_TIMEOUT_MS, MAX_IDLE_MS, MAX_JOBS_PER_TICK, MIN_IDLE_MS } from "../src/lib/server/driverLimits";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { STALL_AFTER_MS } from "../src/lib/jobStall";

const tweet = (id: string) => ({ tweet_id: id, text: `نص ${id} عن AI Trends` });
const page = (n: number, size = 10) => Array.from({ length: size }, (_, i) => tweet(`p${n}_${i + 1}`));

let providerCalls = 0;
/** A source of `pages` pages of 10 distinct records each, then the end. */
const feed = (pages: number, fail?: (call: number) => { httpStatus: number } | null) => setProviderAdapterForTesting(async (input) => {
  providerCalls += 1;
  const failure = fail?.(providerCalls);
  if (failure) return { ok: false, httpStatus: failure.httpStatus, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: `e${providerCalls}`, errorCode: "x", errorMessageAr: "تعذر الاتصال بالمصدر." };
  const n = input.cursor ? Number(String(input.cursor).replace("c", "")) : 1;
  return { ok: true, httpStatus: 200, rows: page(n), nextCursor: n < pages ? `c${n + 1}` : null, costUsd: 0.002, costMicro: 2000, tregCallId: `ok${providerCalls}` };
});

function seedJob(id: string, extra: Record<string, unknown> = {}, target = 30) {
  db.jobs.push({ id, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, lease_until: null, next_attempt_at: null, created_at: iso(T0 - 3_600_000), updated_at: iso(T0 - 5 * 60_000), ...extra });
}
const QUOTE = "quote_driver";
const JOB = jobIdForQuote(QUOTE);
function seed(target = 30, extra: Record<string, unknown> = {}) {
  seedJob(JOB, extra, target);
  db.quotes = [{ id: QUOTE, user_id: "user_1", items: [{ capabilitySlug: "x-keyword-search", endpointId: "treg.twitter.tweets", params: { query: "AI Trends" }, targetVolumeMax: target, paginationStrategy: "cursor" }], output_formats: ["csv"] }];
  db.reserved = Math.ceil(target * db.unitPrice * 1.15);
}

const tick = async () => {
  const res = await GET(new NextRequest("http://127.0.0.1:3000/api/cron/drive", { headers: { authorization: "Bearer driver-test-secret" } }));
  return { status: res.status, json: await res.json() };
};
const advance = (ms: number) => vi.setSystemTime(nowMs() + ms);
const calls = (name: string) => db.rpcCalls.filter((call) => call.name === name);
/** Every stored snapshot of the job's rows (a file per chunk, each holding the rows so far): the ids of each, in order. */
const storedSnapshots = () => [...db.partials.entries()]
  .filter(([key]) => key.includes("step_") || key.endsWith("data.json"))
  .map(([key, buf]) => {
    try {
      const parsed = JSON.parse(buf.toString());
      return { key, ids: (parsed.rows ?? (Array.isArray(parsed) ? parsed : [])).map((row: any) => String(row.tweet_id)) as string[] };
    } catch { return { key, ids: [] as string[] }; }
  });

let originalEnv: Record<string, string | undefined>;
beforeEach(() => {
  originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV, LONG_JOB_DRIVER: process.env.LONG_JOB_DRIVER };
  process.env.CRON_SECRET = "driver-test-secret";
  process.env.ENABLE_MOCK_PROVIDER = "true";
  (process.env as any).NODE_ENV = "test";
  process.env.VERCEL_ENV = "development";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  Object.assign(db, { jobs: [], quotes: [], rpcCalls: [], events: [], notifications: [], unitPrice: 2, reserved: 69, spendAllowed: true, claimsRefused: [], killAfterClaim: false, dispatchLog: [] });
  db.partials.clear();
  db.results.clear();
  providerCalls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  setProviderAdapterForTesting(null);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete (process.env as any)[key];
    else (process.env as any)[key] = value;
  }
});

describe("the driver route: who it drives and how much per call", () => {
  it("refuses without the cron secret and touches nothing", async () => {
    seed();
    const res = await GET(new NextRequest("http://127.0.0.1:3000/api/cron/drive", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(db.dispatchLog).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
  });

  it("drives a job whose lease expired, not one with a live lease, not one still in its retry backoff, not a finished one", async () => {
    seedJob("expired", { lease_until: iso(T0 - 1000) });
    seedJob("live", { lease_until: iso(T0 + 30_000) });
    seedJob("backoff", { next_attempt_at: iso(T0 + 60_000) });
    seedJob("done", { status: "completed" });
    seedJob("failed", { status: "failed" });
    seedJob("queued", { status: "queued" });
    feed(1);
    const { json } = await tick();
    expect(db.dispatchLog.map((entry) => entry.jobId).sort()).toEqual(["expired", "queued"]);
    expect(json).toMatchObject({ success: true, dispatched: 2 });
  });

  it("leaves a job that moved a moment ago (a healthy chain between two chunks) and a job idle past the watchdog window", async () => {
    seedJob("between_chunks", { updated_at: iso(T0 - (MIN_IDLE_MS - 1000)) });
    seedJob("just_due", { updated_at: iso(T0 - MIN_IDLE_MS - 1000) });
    seedJob("left_to_watchdog", { updated_at: iso(T0 - MAX_IDLE_MS - 1000) });
    feed(1);
    await tick();
    expect(db.dispatchLog.map((entry) => entry.jobId)).toEqual(["just_due"]);
  });

  it("does at most MAX_JOBS_PER_TICK chunks per call, the longest idle first, and one chunk per job", async () => {
    for (let i = 0; i < 9; i += 1) seedJob(`j${i}`, { updated_at: iso(T0 - (60 + i) * 1000) });
    feed(1);
    const { json } = await tick();
    expect(json.dispatched).toBe(MAX_JOBS_PER_TICK);
    expect(db.dispatchLog).toHaveLength(MAX_JOBS_PER_TICK);
    expect(new Set(db.dispatchLog.map((entry) => entry.jobId)).size).toBe(MAX_JOBS_PER_TICK);
    expect(db.dispatchLog.map((entry) => entry.jobId)).toEqual(["j8", "j7", "j6", "j5", "j4"]);
  });

  it("a dispatch that throws never fails the call, and the other jobs still run", async () => {
    seedJob("a");
    seedJob("b");
    const { dispatchWorkerChunk } = await import("../src/lib/server/workerDispatch");
    (dispatchWorkerChunk as any).mockImplementationOnce(async () => { throw new Error("network"); });
    feed(1);
    const { status, json } = await tick();
    expect(status).toBe(200);
    expect(json.dispatched).toBe(2);
    expect(json.started).toBeLessThanOrEqual(1);
  });

  it("reports whether the driver is live (the tick it just made), runs the same whatever it is, and a forced «tab» wins", async () => {
    feed(1);
    seedJob("a");
    delete process.env.LONG_JOB_DRIVER;
    expect((await tick()).json.mode).toBe("cron");
    process.env.LONG_JOB_DRIVER = "tab";
    expect((await tick()).json.mode).toBe("tab");
  });

  it("one call stays inside the platform limit: the dispatch timeout is below the 60 s function limit and above the worker's own 45 s deadline", () => {
    expect(DRIVER_DISPATCH_TIMEOUT_MS).toBeGreaterThan(45_000);
    expect(DRIVER_DISPATCH_TIMEOUT_MS).toBeLessThan(60_000);
    const vercel = JSON.parse(readFileSync("vercel.json", "utf8"));
    expect(vercel.crons).toHaveLength(1); // the platform cron stays the daily watchdog; the driver is called by the database scheduler
  });
});

describe("a job driven to the end by the driver alone (the page is closed)", () => {
  it("a broken chain is resumed minute by minute until the job completes, settled once, charged for what was delivered", async () => {
    seed(30);
    feed(10);
    const seen: number[] = [];
    for (let minute = 0; minute < 8 && jobRow(JOB).status !== "completed"; minute += 1) {
      await tick();
      seen.push(jobRow(JOB).delivered_units);
      advance(60_000);
    }
    expect(seen).toEqual([10, 20, 30]);
    expect(jobRow(JOB).status).toBe("completed");
    expect(providerCalls).toBe(3);
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
    expect(jobRow(JOB).charged).toBe(Math.min(Math.ceil(30 * db.unitPrice), db.reserved));
    expect(jobRow(JOB).charged).toBeLessThanOrEqual(db.reserved);
    // more ticks after completion do nothing: no provider call, no second settlement
    await tick();
    advance(60_000);
    await tick();
    expect(providerCalls).toBe(3);
    expect(calls("settle_job_atomic")).toHaveLength(1);
  });

  it("kill and resume: an instance that dies holding the lease is waited out (no second runner), then resumed at the same step with no duplicate records", async () => {
    seed(30);
    feed(10);
    await tick();
    expect(jobRow(JOB).delivered_units).toBe(10);
    advance(60_000);

    db.killAfterClaim = true;
    await tick(); // takes the lease and dies
    expect(jobRow(JOB).step).toBe(1);
    expect(jobRow(JOB).lease_until).not.toBeNull();
    db.killAfterClaim = false;

    advance(20_000); // the lease is still live: the driver must not start a second runner
    db.dispatchLog = [];
    await tick();
    expect(db.dispatchLog).toEqual([]);
    expect(providerCalls).toBe(1);

    advance(45_000); // the lease has expired: resumed at the very same step
    await tick();
    expect(db.dispatchLog).toEqual([{ jobId: JOB, step: 1 }]);
    advance(60_000);
    await tick();
    expect(jobRow(JOB).status).toBe("completed");
    expect(jobRow(JOB).delivered_units).toBe(30);
    expect(providerCalls).toBe(3);
    const snapshots = storedSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    for (const { key, ids } of snapshots) expect(new Set(ids).size, key).toBe(ids.length); // no record twice in any snapshot
    const final = JSON.parse(db.partials.get(`user_1/${JOB}/data.json`)?.toString() || "{}");
    expect(final.rows).toHaveLength(30); // three pages of ten, each page taken once although one chunk died
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
  });

  it("two drivers at the same moment run one chunk, not two: the lease refuses the second", async () => {
    seed(30);
    feed(10);
    const [a, b] = await Promise.all([tick(), tick()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(db.dispatchLog).toHaveLength(2); // both asked ...
    expect(providerCalls).toBe(1); // ... one ran
    expect(db.claimsRefused).toEqual(["lease_held"]);
    expect(jobRow(JOB).delivered_units).toBe(10);
    expect(jobRow(JOB).step).toBe(1);
    expect(a.json.started + b.json.started).toBe(1);
  });

  it("a driver that arrives with a stale step (the chain moved on) is refused and changes nothing", async () => {
    seed(30);
    feed(10);
    const { dispatchWorkerChunk } = await import("../src/lib/server/workerDispatch");
    await tick();
    advance(60_000);
    const stale = await (dispatchWorkerChunk as any)("https://x", JOB, 0, {});
    expect(stale.started).toBe(false);
    expect(db.claimsRefused).toContain("step_mismatch");
    expect(providerCalls).toBe(1);
    expect(jobRow(JOB).delivered_units).toBe(10);
  });

  it("a job that completed between the driver's read and its dispatch is not run or settled again", async () => {
    seed(10);
    feed(1);
    await tick();
    expect(jobRow(JOB).status).toBe("completed");
    const settleBefore = calls("settle_job_atomic").length;
    const { dispatchWorkerChunk } = await import("../src/lib/server/workerDispatch");
    const late = await (dispatchWorkerChunk as any)("https://x", JOB, 0, {});
    expect(late.started).toBe(false);
    expect(calls("settle_job_atomic")).toHaveLength(settleBefore);
    expect(providerCalls).toBe(1);
    expect(db.claimsRefused).toContain("not_runnable");
  });
});

describe("a source or a budget that stops mid-job: the rows already delivered are settled once through the existing path", () => {
  const settledOnce = (delivered: number) => {
    expect(calls("settle_job_atomic")).toHaveLength(1);
    expect(calls("release_job_atomic")).toHaveLength(0);
    expect(jobRow(JOB).status).toBe("completed");
    expect(jobRow(JOB).delivered_units).toBe(delivered);
    expect(jobRow(JOB).charged).toBe(Math.min(Math.ceil(delivered * db.unitPrice), db.reserved));
    expect(jobRow(JOB).charged).toBeLessThanOrEqual(db.reserved);
  };

  it("the daily provider cap closes after the first chunk: no further provider call, partial settlement, nothing more on the next ticks", async () => {
    seed(30);
    feed(10);
    await tick();
    advance(60_000);
    db.spendAllowed = false;
    await tick();
    expect(providerCalls).toBe(1);
    settledOnce(10);
    advance(60_000);
    await tick();
    await tick();
    expect(providerCalls).toBe(1);
    expect(calls("settle_job_atomic")).toHaveLength(1);
  });

  for (const httpStatus of [402, 429]) {
    it(`the source answers ${httpStatus} after the first chunk: the job stops with what it has, settled once, never released after delivery`, async () => {
      seed(30);
      feed(10, (call) => (call >= 2 ? { httpStatus } : null));
      await tick();
      advance(60_000);
      await tick();
      expect(providerCalls).toBe(2);
      settledOnce(10);
      advance(60_000);
      await tick();
      expect(providerCalls).toBe(2);
      expect(calls("settle_job_atomic")).toHaveLength(1);
    });
  }

  it(`the source answers 402 or 429 before anything was delivered: the whole reserve is released with no charge, and the driver leaves the job alone afterwards`, async () => {
    seed(30);
    feed(10, () => ({ httpStatus: 429 }));
    await tick();
    expect(calls("release_job_atomic")).toHaveLength(1);
    expect(calls("settle_job_atomic")).toHaveLength(0);
    expect(jobRow(JOB).status).toBe("failed");
    advance(60_000);
    db.dispatchLog = [];
    await tick();
    expect(db.dispatchLog).toEqual([]);
    expect(calls("release_job_atomic")).toHaveLength(1);
  });
});

describe("the driver tells the customer of a stalled job, once", () => {
  it("a job idle for the stall time with no live lease gets one in-app notice, however many ticks follow", async () => {
    seed(30, { updated_at: iso(T0 - STALL_AFTER_MS - 60_000), status: "queued", next_attempt_at: iso(T0 + 3_600_000) });
    feed(10);
    const first = await tick();
    expect(first.json.stalledNotices).toMatchObject({ considered: 1, notified: 1 });
    expect(db.notifications).toHaveLength(1);
    expect(db.notifications[0]).toMatchObject({ user_id: "user_1", link: "/dashboard/requests" });
    expect(db.notifications[0].body).toContain("المهمة متوقفة مؤقتًا، ولن يُخصم أكثر من المُسلَّم");
    advance(60_000);
    await tick();
    await tick();
    expect(db.notifications).toHaveLength(1);
  });

  it("a healthy job (recent progress or a live lease) is not announced as stalled", async () => {
    seed(30, { updated_at: iso(T0 - 2 * 60_000) });
    feed(10);
    const { json } = await tick();
    expect(json.stalledNotices).toMatchObject({ notified: 0 });
    expect(db.notifications).toHaveLength(0);
  });
});

describe("the driver moves no money and adds no money path", () => {
  it("its source reads and writes no ledger, calls no database function and imports no pricing", () => {
    const route = readFileSync("src/app/api/cron/drive/route.ts", "utf8");
    const limits = readFileSync("src/lib/server/driverLimits.ts", "utf8");
    expect(route).not.toMatch(/credit_ledger|\.rpc\(|reserve_credits|settle_job|release_job|approve_topup|pricing|unitPrice|\.insert\(|\.update\(|\.delete\(|\.upsert\(/i);
    expect(limits).not.toMatch(/price|credit|points|cap/i);
    // its only writes are the stalled notices, through the existing notice helper
    expect(route).toContain("notifyStalledJobs");
  });

  it("the money functions and constants were not touched by this change", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain('rpc("settle_job_atomic"');
    expect(worker).toContain('rpc("release_job_atomic"');
    expect(readFileSync("vercel.json", "utf8")).toContain("/api/cron/watchdog");
  });
});

describe("the setup proposal is a proposal: not applied, locked down, reversible", () => {
  const sql = readFileSync("docs/proposals/08_pg_cron_driver.sql", "utf8");
  const guide = readFileSync("docs/proposals/08_long_job_driver_setup.md", "utf8");

  it("is not a migration, grants the function to the service role only, and writes nothing but the schedule", async () => {
    const { readdirSync } = await import("node:fs");
    for (const file of readdirSync("supabase/migrations")) expect(readFileSync(`supabase/migrations/${file}`, "utf8")).not.toContain("drive_jobs_tick");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.drive_jobs_tick() FROM PUBLIC, anon, authenticated;");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.drive_jobs_tick() TO service_role;");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).not.toMatch(/credit_ledger|settle_job_atomic|release_job_atomic|approve_topup|UPDATE public\.|INSERT INTO|DELETE FROM/i);
    expect(sql).toContain("cron.unschedule('diger-drive-jobs')");
  });

  it("keeps secrets in the vault: the file and the guide never contain a secret value", () => {
    expect(sql).toContain("vault.decrypted_secrets");
    for (const text of [sql, guide]) expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sk_[A-Za-z0-9]{10,}|re_[A-Za-z0-9]{10,}/);
    expect(guide).toContain("diger-cron-secret");
    expect(guide).toContain("diger-app-base-url");
  });

  it("tells the owner how to verify and how to turn it off, and names the Vercel Pro alternative", () => {
    expect(guide).toContain("cron.job_run_details");
    expect(guide).toContain("net._http_response");
    expect(guide).toContain("select cron.unschedule('diger-drive-jobs');");
    expect(guide).toContain("LONG_JOB_DRIVER");
    expect(guide).toContain("Vercel Pro");
  });

  it("the SQL's idle window is the route's window (15 s to 25 minutes)", () => {
    expect(MIN_IDLE_MS).toBe(15_000);
    expect(MAX_IDLE_MS).toBe(25 * 60 * 1000);
    expect(sql).toContain("interval '25 minutes'");
    expect(sql).toContain("interval '15 seconds'");
  });
});
