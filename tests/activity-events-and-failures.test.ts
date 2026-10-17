import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Worker-level behavior of activity events, the ETA and the three distinct ways a run can end without
 * rows: provider failure, a valid empty answer, and rows that arrived but did not match. Money moves
 * only through the approved RPCs, which are asserted through the mocked RPC calls.
 */

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  // state of the job being worked
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 10,
  unitPrice: 2,
  reserved: 30,
}));

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api,
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    in: () => api, or: () => api, not: () => api, order: () => api, limit: () => api,
    maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
    then: (resolve: any, reject: any) => Promise.resolve({ data: apply(), error: null }).then(resolve, reject),
  };
  return api;
}

vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: null }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (name: string, args: any) => {
      db.rpcCalls.push({ name, args });
      if (name === "claim_job_chunk") {
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: "x-keyword-search", unit_price: db.unitPrice }, error: null };
      }
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        db.step += 1;
        db.deliveredUnits = args.p_new_delivered_units;
        db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") {
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        return { data: { success: true, charged_credits: charged, refunded_credits: db.reserved - charged }, error: null };
      }
      if (name === "release_job_atomic") return { data: { success: true, released_credits: db.reserved }, error: null };
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
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push({ created_at: new Date().toISOString(), ...row }); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));

vi.mock("../src/lib/server/sendPlatformEmail", () => ({
  sendPlatformEmail: vi.fn(async () => undefined),
  getRecipient: vi.fn(async () => null),
}));

vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { estimateRemainingSecondsFromBatchDurations } from "../src/functions/shared/liveActivityFeed";
import { hasRecognizedProviderResultShape, setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import { jobIdForQuote } from "../src/lib/server/retryReuse";

const JOB = jobIdForQuote("quote_events");
const tweet = (id: string, extra: Record<string, unknown> = {}) => ({ tweet_id: id, text: `نص ${id}`, ...extra });

function resetDb(params: Record<string, unknown> = { query: "AI Trends" }, target = 20, createdSecondsAgo = 30) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", step: 0, current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date(Date.now() - createdSecondsAgo * 1000).toISOString(), updated_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_events", user_id: "user_1", items: [{ capabilitySlug: "x-keyword-search", endpointId: "treg.twitter.tweets", params, targetVolumeMax: target, paginationStrategy: "cursor" }], output_formats: ["csv"] }];
  db.partials.clear();
  db.results.clear();
  db.rpcCalls = [];
  db.events = [];
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = target;
  db.unitPrice = 2;
  db.reserved = Math.ceil(target * 2 * 1.15);
}

describe("estimateRemainingSecondsFromBatchDurations (remaining batches x measured duration)", () => {
  it("multiplies the remaining batches by the median measured batch duration", () => {
    // Durations measured on real jobs of this platform: 15.1 s per chunk (100 rows) and 30.4 s per chunk (50 rows).
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 40, pageSize: 10, measuredBatchSeconds: [15.1] })).toBe(61); // ceil(4 x 15.1)
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 25, pageSize: 10, measuredBatchSeconds: [12, 30, 14] })).toBe(42); // 3 batches x median 14
  });

  it("never invents a number: no measured batch, nothing remaining, or a bad page size gives null", () => {
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 10, pageSize: 10, measuredBatchSeconds: [] })).toBeNull();
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 0, pageSize: 10, measuredBatchSeconds: [10] })).toBeNull();
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 10, pageSize: 0, measuredBatchSeconds: [10] })).toBeNull();
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 10, pageSize: 10, measuredBatchSeconds: [NaN, -3, 0] })).toBeNull();
  });

  it("one slow cold-start batch does not dominate the estimate (median, not mean)", () => {
    expect(estimateRemainingSecondsFromBatchDurations({ remainingRows: 10, pageSize: 10, measuredBatchSeconds: [90, 10, 11] })).toBe(11);
  });
});

describe("provider result shape", () => {
  it("accepts the recognized result envelopes and rejects anything else", () => {
    expect(hasRecognizedProviderResultShape({ items: [] })).toBe(true);
    expect(hasRecognizedProviderResultShape({ data: { results: [{ a: 1 }] } })).toBe(true);
    expect(hasRecognizedProviderResultShape([])).toBe(true);
    expect(hasRecognizedProviderResultShape({ error: "bad request" })).toBe(false);
    expect(hasRecognizedProviderResultShape("<html>gateway</html>")).toBe(false);
    expect(hasRecognizedProviderResultShape(null)).toBe(false);
  });
});

describe("worker: activity events, ETA and distinct failure paths", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "events-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    resetDb();
  });

  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
  });

  const callWorker = async (step = 0) => {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer events-test-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: step, disableSelfChain: true }),
    }));
    return { status: res.status, json: await res.json() };
  };
  const messages = () => db.events.map((event) => String(event.message));

  it("writes one plain Arabic line per page with the running total and the measured-time estimate", async () => {
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: Array.from({ length: 10 }, (_, i) => tweet(`p1_${i + 1}`)), nextCursor: "next", costUsd: 0.002, costMicro: 2000, tregCallId: "c1" }));

    const { json } = await callWorker();
    expect(json.done).toBe(false);

    const pageLines = messages().filter((line) => line.startsWith("الصفحة"));
    expect(pageLines).toHaveLength(1);
    const line = pageLines[0];
    expect(line).toContain("الصفحة ١: استلمنا ١٠ سجل");
    expect(line).toContain("الجديد ١٠");
    expect(line).toContain("الإجمالي ١٠");
    // Estimate from the measured batch (job created 30 s ago): 1 remaining batch of 10 rows.
    const eta = /الوقت المتوقع بحسب زمن الصفحات المسجل: نحو ([٠-٩]+) ثانية/u.exec(line);
    expect(eta).not.toBeNull();
    const seconds = Number(eta![1].replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))));
    expect(seconds).toBeGreaterThanOrEqual(30);
    expect(seconds).toBeLessThanOrEqual(40);
  });

  it("every event line of a finished run is Arabic: no Latin letters or digits, no provider or technical words", async () => {
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: Array.from({ length: 20 }, (_, i) => tweet(`only_${i + 1}`)), nextCursor: null, costUsd: 0.002, costMicro: 2000, tregCallId: "c2" }));
    const { json } = await callWorker();
    expect(json.done).toBe(true);
    for (const line of messages()) {
      expect(line, line).not.toMatch(/[A-Za-z0-9]/);
      expect(line, line).not.toMatch(/treg|icypeas|anthropic|usd|\$|http|rpc|json/i);
    }
    expect(messages().some((line) => /^تم إكمال استخراج ٢٠ سجل/.test(line))).toBe(true);
  });

  it("provider failure: full reserve released through the approved function with the provider's clear Arabic reason and no charge", async () => {
    const reason = "المصدر مشغول حالياً بعد استنفاد محاولات الإعادة.";
    setProviderAdapterForTesting(async () => ({ ok: false, httpStatus: 503, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "e1", errorCode: "busy", errorMessageAr: reason }));

    const { status, json } = await callWorker();

    expect(status).toBe(500);
    expect(json).toMatchObject({ success: false, released: true, chargedCredits: 0 });
    expect(json.error).toBe(reason);
    expect(db.rpcCalls.some((call) => call.name === "record_chunk_failure")).toBe(true);
    const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
    expect(release.args).toMatchObject({ p_job_id: JOB, p_error_message: reason });
    expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
    expect(messages().some((line) => line.includes(reason) && line.includes("تم استرداد"))).toBe(true);
  });

  it("valid empty answer: released with a different reason (no matching records), not a failure message", async () => {
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "z1" }));

    const { status, json } = await callWorker();

    expect(status).toBe(422);
    expect(json).toMatchObject({ success: false, released: true, chargedCredits: 0 });
    expect(json.error).toBe("لم يُعثر على أي بيانات مطابقة من المصدر؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.");
    expect(db.rpcCalls.some((call) => call.name === "record_chunk_failure")).toBe(false);
    expect(db.rpcCalls.filter((call) => call.name === "release_job_atomic")).toHaveLength(1);
    expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
  });

  it("records arrived but none matched: released with a reason that says how many arrived", async () => {
    resetDb({ query: "AI Trends", dateFrom: "2020-01-01", dateTo: "2020-12-31" });
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [tweet("a"), tweet("b"), tweet("c")], nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "m1" }));

    const { status, json } = await callWorker();

    expect(status).toBe(422);
    expect(json.released).toBe(true);
    expect(json.error).toContain("استلمنا ٣ سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك");
    expect(json.error).toContain("تم استرداد كامل الرصيد المحجوز دون أي خصم");
    expect(json.error).not.toBe("لم يُعثر على أي بيانات مطابقة من المصدر؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.");
    expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
  });
});
