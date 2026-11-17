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
  spendAllowed: true,
  // DT-20261117-06 H1 (T2): the `record_chunk_failure` counter, the seam that rewrites the job row inside the 5th call, the jobs compare-and-set fake and its switches, and the `complete_chunk` count mismatch. The defaults keep every other test unchanged.
  failCount: 0,
  onFifthFailure: null as null | ((job: any) => void),
  casError: null as any,
  casThrows: false,
  updates: [] as Array<{ patch: any; filters: Array<[string, unknown]> }>,
  mismatchExtra: 0,
  // v7 (W-1): when set, `release_job_atomic` answers this error (a refused release); null keeps today's success answer.
  releaseError: null as any,
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

/** DT-20261117-06 H1 (T2): the `jobs.update(patch).eq().eq().eq().select()` compare-and-set of the worker. It records every attempt, can fail (returned error or thrown), and otherwise updates the rows that match ALL filters. */
function casChain(patch: any) {
  const filters: Array<[string, unknown]> = [];
  const api: any = {
    eq: (col: string, val: unknown) => { filters.push([col, val]); return api; },
    select: async () => {
      db.updates.push({ patch, filters: [...filters] });
      if (db.casThrows) throw new Error("cas_down");
      if (db.casError) return { data: null, error: db.casError };
      const hit = db.jobs.filter((row) => filters.every(([col, val]) => row[col] === val));
      for (const row of hit) Object.assign(row, patch);
      return { data: hit.map((row) => ({ id: row.id })), error: null };
    },
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
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: db.spendAllowed, cost_id: db.spendAllowed ? 11 : null }, error: null };
      if (name === "commit_provider_spend") return { data: { success: true }, error: null };
      if (name === "complete_chunk") {
        db.step += 1;
        db.deliveredUnits = args.p_new_delivered_units;
        db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits + db.mismatchExtra }, error: null };
      }
      if (name === "settle_job_atomic") {
        const charged = Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved);
        return { data: { success: true, charged_credits: charged, refunded_credits: db.reserved - charged }, error: null };
      }
      if (name === "release_job_atomic") {
        if (db.releaseError) return { data: null, error: db.releaseError };
        return { data: { success: true, released_credits: db.reserved }, error: null };
      }
      if (name === "record_chunk_failure") {
        db.failCount += 1;
        if (db.failCount < 5) return { data: { success: true, released: false, attempts: db.failCount }, error: null };
        // the 5th failure: the SQL releases the job and stores this exact text (migration 20261012135525:182-186)
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { status: "failed", error_message: `Exceeded maximum retry attempts (5): ${args.p_error_message}` });
        db.onFifthFailure?.(job);
        return { data: { success: true, released: true, released_credits: db.reserved, attempts: 5 }, error: null };
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
      if (table === "jobs") return { ...builder(() => db.jobs), update: (patch: any) => casChain(patch) };
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
import { REASON_AR, RELEASE_NEUTRAL_REASON_AR, RETRY_CAUSE_AR, releaseTextAr } from "../src/lib/releaseText";
import { normalizeReleaseWording } from "../src/lib/releaseWording";
import { emptyRunningSet, saveRunningSet } from "../src/lib/server/jobRunningSet";
import { emptyDiagnostic, recordRowGate, saveStepDiagnostic } from "../src/lib/server/zeroDeliveryDiagnostic";
import { PROVIDER_GENERIC_FAILURE_AR, PROVIDER_INPUT_REJECTED_AR, isDeterministicFailureAr } from "../src/lib/providerFailureText";
import { customerTexts, expectNoBareFailed, expectReleasedZeroOf } from "./helpers/noBareFailed";
import { PROVIDER_INCOMPATIBLE_ANSWER_AR } from "../src/lib/providerFailureText";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { pointsAr } from "../src/lib/pointsFormat";

const JOB = jobIdForQuote("quote_events");
const tweet = (id: string, extra: Record<string, unknown> = {}) => ({ tweet_id: id, text: `نص ${id} عن AI Trends`, ...extra });

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
  db.spendAllowed = true;
  db.failCount = 0;
  db.onFifthFailure = null;
  db.casError = null;
  db.casThrows = false;
  db.updates = [];
  db.mismatchExtra = 0;
  db.releaseError = null;
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

  const callWorker = async (step = 0, extra: Record<string, unknown> = {}) => {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer events-test-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: step, disableSelfChain: true, ...extra }),
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
    expect(json.error).toBe(releaseTextAr(reason, db.targetVolumeMax));
    expect(db.rpcCalls.some((call) => call.name === "record_chunk_failure")).toBe(true);
    const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
    expect(release.args).toMatchObject({ p_job_id: JOB, p_error_message: releaseTextAr(reason, db.targetVolumeMax) });
    expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
    expect(messages().some((line) => line.includes(reason) && line.includes("حجز مؤقت مُحرَّر"))).toBe(true);
  });

  it("valid empty answer: released with a different reason (no matching records), not a failure message", async () => {
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "z1" }));

    const { status, json } = await callWorker();

    expect(status).toBe(422);
    expect(json).toMatchObject({ success: false, released: true, chargedCredits: 0 });
    expect(json.error).toBe("لم يُعثر على أي بيانات مطابقة من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
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
    expect(json.error).toContain("حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد");
    expect(json.error).not.toBe("لم يُعثر على أي بيانات مطابقة من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
    expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
  });

  it("continues to page two after four of five trending rows fail relevance, then settles the requested five matches", async () => {
    resetDb({ trending: true, region: "EG" }, 5);
    db.unitPrice = 6;
    db.reserved = 35;
    db.quotes[0].items[0] = {
      capabilitySlug: "social-tiktok-videos",
      endpointId: "scrapecreators.x.v1-tiktok-get-trending-feed",
      params: { trending: true, region: "EG" },
      targetVolumeMax: 5,
      paginationStrategy: "cursor",
    };

    const firstPageRows = [
      { video_id: "reject_1", title: "محتوى رائج", country_code: "SA" },
      { video_id: "reject_2", title: "محتوى رائج", country: "United States" },
      { video_id: "reject_3", title: "محتوى رائج", region: "AE" },
      { video_id: "reject_4", title: "محتوى رائج", location: "Riyadh, Saudi Arabia" },
      { video_id: "match_1", title: "محتوى رائج", country: "Egypt" },
    ];
    const secondPageRows = [
      { video_id: "match_2", title: "محتوى رائج" },
      { video_id: "match_3", title: "محتوى رائج", country_code: "EG" },
      { video_id: "match_4", title: "محتوى رائج", location: "Cairo" },
      { video_id: "match_5", title: "محتوى رائج", published_at: "2025-01-01" },
    ];
    const pageCursors: Array<string | null> = [];
    setProviderAdapterForTesting(async (input) => {
      pageCursors.push(input.cursor);
      return input.cursor
        ? { ok: true, httpStatus: 200, rows: secondPageRows, nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "page_2" }
        : { ok: true, httpStatus: 200, rows: firstPageRows, nextCursor: "page_2_cursor", costUsd: 0.001, costMicro: 1000, tregCallId: "page_1" };
    });

    const first = await callWorker(0);
    expect(first.json).toMatchObject({ done: false, deliveredUnits: 1, targetMax: 5 });
    expect(messages().some((line) => line.includes("استلمنا ٥ سجل") && line.includes("غير مطابق ٤"))).toBe(true);

    const second = await callWorker(1);
    expect(second.json).toMatchObject({ done: true, deliveredUnits: 5 });
    expect(pageCursors).toEqual([null, "page_2_cursor"]);
    expect(db.rpcCalls.filter((call) => call.name === "settle_job_atomic")).toHaveLength(1);
    expect(db.rpcCalls.find((call) => call.name === "settle_job_atomic")?.args).toMatchObject({ p_points_cap: 25000 });
    const result = JSON.parse(db.partials.get(`user_1/${JOB}/data.json`)?.toString() || "{}");
    expect(result.rows).toHaveLength(5);
    expect(result.rows.map((row: any) => row.video_id)).not.toContain("reject_1");
  });

  it("stops before another provider call when the daily spend reservation is denied, settling rows already collected", async () => {
    resetDb({ trending: true, region: "EG" }, 5);
    db.unitPrice = 6;
    db.reserved = 35;
    db.quotes[0].items[0] = {
      capabilitySlug: "social-tiktok-videos",
      endpointId: "scrapecreators.x.v1-tiktok-get-trending-feed",
      params: { trending: true, region: "EG" },
      targetVolumeMax: 5,
      paginationStrategy: "cursor",
    };
    let providerCalls = 0;
    setProviderAdapterForTesting(async () => {
      providerCalls += 1;
      return { ok: true, httpStatus: 200, rows: [{ video_id: "match_1", title: "محتوى رائج" }], nextCursor: "page_2_cursor", costUsd: 0.001, costMicro: 1000, tregCallId: "page_1" };
    });

    const first = await callWorker(0);
    expect(first.json.done).toBe(false);
    db.spendAllowed = false;

    const second = await callWorker(1);
    expect(second.json).toMatchObject({ done: true, deliveredUnits: 1 });
    expect(providerCalls).toBe(1);
    expect(db.rpcCalls.filter((call) => call.name === "settle_job_atomic")).toHaveLength(1);
    expect(messages().some((line) => line.includes("توقف الجمع عند الحد اليومي الآمن"))).toBe(true);
    expect(db.rpcCalls.some((call) => call.name === "release_job_atomic")).toBe(false);
  });

  it("ends as partial when the provider repeats a previously seen cursor instead of looping", async () => {
    resetDb({ trending: true, region: "EG" }, 5);
    db.unitPrice = 6;
    db.reserved = 35;
    db.quotes[0].items[0] = {
      capabilitySlug: "social-tiktok-videos",
      endpointId: "scrapecreators.x.v1-tiktok-get-trending-feed",
      params: { trending: true, region: "EG" },
      targetVolumeMax: 5,
      paginationStrategy: "cursor",
    };
    let providerCalls = 0;
    setProviderAdapterForTesting(async () => {
      providerCalls += 1;
      return { ok: true, httpStatus: 200, rows: [{ video_id: "one", title: "رائج" }], nextCursor: "same_cursor", costUsd: 0.001, costMicro: 1000, tregCallId: `page_${providerCalls}` };
    });

    expect((await callWorker(0)).json.done).toBe(false);
    const second = await callWorker(1);
    expect(second.json).toMatchObject({ done: true, deliveredUnits: 1 });
    expect(providerCalls).toBe(2);
    expect(messages().some((line) => line.includes("توقف الجمع لأن المصدر كرر صفحة سبق استلامها"))).toBe(true);
    expect(db.rpcCalls.filter((call) => call.name === "settle_job_atomic")).toHaveLength(1);
  });

  describe("T2 worker release text (DT-06)", () => {
    it("T2(i)+(vii) a count mismatch releases with the count text and every other argument unchanged", async () => {
      resetDb(undefined, 1);
      db.mismatchExtra = 5;
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [tweet("m1")], nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "mm" }));
      await callWorker();
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      expect(release.args).toEqual({ p_job_id: JOB, p_error_message: releaseTextAr("عدم تطابق في عدد السجلات المجمعة (1) مع الوحدات المسجلة (6)؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.", 1), p_force: true });
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
    });

    it("T2(ii) a generic throw at attempt 1 reaches no customer text", async () => {
      setProviderAdapterForTesting(async () => { throw new Error("settle_failed"); });
      const { json } = await callWorker();
      const failures = db.rpcCalls.filter((call) => call.name === "record_chunk_failure");
      expect(failures).toHaveLength(1);
      expect(failures[0].args).toEqual({ p_job_id: JOB, p_error_message: RETRY_CAUSE_AR });
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      expect(release.args).toEqual({ p_job_id: JOB, p_error_message: releaseTextAr(RELEASE_NEUTRAL_REASON_AR, 20), p_force: true });
      expect(json.error).toBe(releaseTextAr(RELEASE_NEUTRAL_REASON_AR, 20));
      expect(db.updates).toEqual([]);
      expect(JSON.stringify([db.rpcCalls, db.events])).not.toContain("settle_failed");
    });

    // T2(iii)-(v): P10's compare-and-set, ONE it.each over four outcomes.
    const RETRY_TEXT = `Exceeded maximum retry attempts (5): ${RETRY_CAUSE_AR}`;
    const FINAL = releaseTextAr(RELEASE_NEUTRAL_REASON_AR, 20);
    const OTHER = "لم يُعثر على أي بيانات مطابقة من المصدر؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
    it.each([
      { name: "match", arrange: () => undefined, stored: FINAL, finalEvents: 1, warned: false },
      { name: "other writer", arrange: () => { db.onFifthFailure = (job) => { job.error_message = OTHER; }; }, stored: OTHER, finalEvents: 0, warned: false },
      { name: "returned error", arrange: () => { db.casError = { message: "x" }; }, stored: RETRY_TEXT, finalEvents: 1, warned: true },
      { name: "thrown", arrange: () => { db.casThrows = true; }, stored: RETRY_TEXT, finalEvents: 1, warned: true },
    ])("T2(iii)-(v) compare-and-set: $name", async ({ arrange, stored, finalEvents, warned }) => {
      db.failCount = 4;
      arrange();
      setProviderAdapterForTesting(async () => { throw new Error("settle_failed"); });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const { json } = await callWorker();
        expect(json.released).toBe(true);
        expect(json.error).toBe(FINAL);
        expect(db.rpcCalls.some((call) => call.name === "release_job_atomic")).toBe(false);
        expect(db.updates).toHaveLength(1);
        expect(db.updates[0]).toEqual({ patch: { error_message: FINAL }, filters: [["id", JOB], ["status", "failed"], ["error_message", RETRY_TEXT]] });
        expect(db.jobs[0].error_message).toBe(stored);
        expect(messages().filter((line) => line === FINAL)).toHaveLength(finalEvents);
        expect(warn.mock.calls.some((args) => args[0] === "[worker:retry_text_cas_failed]")).toBe(warned);
        if (warned) expect(normalizeReleaseWording(db.jobs[0].error_message)).toBe(RETRY_CAUSE_AR);
      } finally {
        warn.mockRestore();
      }
    });

    // T2(vi): leak and retry-button rule, ONE it.each over two rows.
    it.each([
      { name: "a provider name is not shown", input: "تعذّر الاتصال بتومبا", expected: releaseTextAr(REASON_AR.provider_unavailable, 20), leak: "تومبا", deterministic: null },
      { name: "a reviewed deterministic sentence keeps its text", input: PROVIDER_INPUT_REJECTED_AR, expected: releaseTextAr(PROVIDER_INPUT_REJECTED_AR, 20), leak: null, deterministic: true },
    ])("T2(vi) leak and retry rule: $name", async ({ input, expected, leak, deterministic }) => {
      setProviderAdapterForTesting(async () => ({ ok: false, httpStatus: 503, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "e", errorCode: "x", errorMessageAr: input }));
      const { json } = await callWorker();
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      expect(release.args.p_error_message).toBe(expected);
      if (leak) expect(JSON.stringify([db.rpcCalls, db.events, json, db.jobs])).not.toContain(leak);
      if (deterministic !== null) expect(isDeterministicFailureAr(release.args.p_error_message)).toBe(deterministic);
    });

    // T2(viii) (W-1): the composed adapter text carries NO release claim before a confirmed release. ONE it.each over the four paths.
    const COMPOSED = `${PROVIDER_INCOMPATIBLE_ANSWER_AR}؛ تم إيقاف الطلب: حجز مؤقت مُحرَّر.`;
    const CLAIM = /حجز مؤقت مُحرَّر|تم إيقاف الطلب/;
    const BASE20 = releaseTextAr(PROVIDER_INCOMPATIBLE_ANSWER_AR, 20);
    type Seen = { json: any; failures: Array<{ name: string; args: any }>; releases: Array<{ name: string; args: any }> };
    const retryOnlyChecks = ({ json, failures, releases }: Seen) => {
      expect(failures).toHaveLength(1);
      expect(failures[0].args).toEqual({ p_job_id: JOB, p_error_message: PROVIDER_INCOMPATIBLE_ANSWER_AR });
      expect(CLAIM.test(failures[0].args.p_error_message)).toBe(false);
      expect(isDeterministicFailureAr(failures[0].args.p_error_message)).toBe(true);
      expect(releases).toHaveLength(0);
      expect(messages().filter((line) => CLAIM.test(line))).toEqual([]);
      expect(CLAIM.test(String(json.error))).toBe(false);
      expect(CLAIM.test(String(db.jobs[0].error_message ?? ""))).toBe(false);
    };
    it.each([
      { name: "retry-only, attempt 1", failCount: 0, retryOnly: true, releaseError: null as any, check: retryOnlyChecks },
      { name: "retry-only, attempt 2", failCount: 1, retryOnly: true, releaseError: null as any, check: retryOnlyChecks },
      { name: "retry-only, attempt 3", failCount: 2, retryOnly: true, releaseError: null as any, check: retryOnlyChecks },
      { name: "retry-only, attempt 4", failCount: 3, retryOnly: true, releaseError: null as any, check: retryOnlyChecks },
      {
        name: "confirmed release", failCount: 0, retryOnly: false, releaseError: null as any,
        check: ({ json, failures, releases }: Seen) => {
          expect(failures).toHaveLength(1);
          expect(failures[0].args.p_error_message).toBe(PROVIDER_INCOMPATIBLE_ANSWER_AR);
          expect(releases).toHaveLength(1);
          expect(releases[0].args).toEqual({ p_job_id: JOB, p_error_message: BASE20, p_force: true });
          const line = `${BASE20} (حجز مؤقت مُحرَّر ${pointsAr(Math.round(db.reserved), toArabicDigits)}، ولم يُخصم شيء).`;
          expect(messages().filter((message) => CLAIM.test(message))).toEqual([line]);
          expect(json.error).toBe(BASE20);
          expect(isDeterministicFailureAr(BASE20)).toBe(true);
        },
      },
      {
        name: "release refused", failCount: 0, retryOnly: false, releaseError: { message: "refused" } as any,
        check: ({ json, failures, releases }: Seen) => {
          expect(releases).toHaveLength(1);
          expect(messages().filter((message) => CLAIM.test(message))).toEqual([]);
          expect(json.error).toBe("تعذر تأكيد الحجز المؤقت المُحرَّر للمهمة.");
          expect(failures[0].args.p_error_message).toBe(PROVIDER_INCOMPATIBLE_ANSWER_AR);
        },
      },
      {
        name: "5th attempt, SQL release", failCount: 4, retryOnly: true, releaseError: null as any,
        check: ({ json, releases }: Seen) => {
          expect(db.jobs[0].error_message).toBe(BASE20);
          for (const text of [String(db.jobs[0].error_message), String(json.error), ...messages()]) expect(text).not.toContain("تم إيقاف الطلب");
          expect(releases).toHaveLength(0);
        },
      },
    ])("T2(viii) composed adapter text: $name", async ({ failCount, retryOnly, releaseError, check }) => {
      db.failCount = failCount;
      db.releaseError = releaseError;
      setProviderAdapterForTesting(async () => ({ ok: false, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "inc", errorCode: "invalid_provider_payload", errorMessageAr: COMPOSED }));
      const { json } = await callWorker(0, retryOnly ? { retryOnly: true } : {});
      check({
        json,
        failures: db.rpcCalls.filter((call) => call.name === "record_chunk_failure"),
        releases: db.rpcCalls.filter((call) => call.name === "release_job_atomic"),
      });
    });
  });
  describe("T3 zero delivery, non-chain (DT-06 M3)", () => {
    it.each([
      { name: "known total, held", seeded: true, expected: releaseTextAr("استلمنا من المصدر نتائج عددها ١٢ خلال هذا الطلب، ولم يُسلَّم منها شيء لأنها لم تجتز التحقق من مطابقة طلبك (منها ٣ أُحيلت إلى المراجعة ولم تُحتسب)؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.", 20), absent: null },
      { name: "total unknown", seeded: false, expected: releaseTextAr("لم يُسلَّم أي عنصر مطابق لطلبك؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.", 20), absent: "استلمنا" },
    ])("T3 $name", async ({ seeded, expected, absent }) => {
      resetDb();
      const partials = (await import("../src/lib/supabase/server")).createAdminClient().storage.from("partials");
      db.step = 1;
      db.cursor = "c1";
      Object.assign(db.jobs[0], { step: 1, current_cursor: "c1" });
      if (seeded) {
        await saveRunningSet(partials, JOB, { ...emptyRunningSet(), step: 0, cursors: ["c1"], batchUnits: [0], received: 12 });
        await saveStepDiagnostic(partials, JOB, 0, recordRowGate(emptyDiagnostic(), { received: 12, outsideWindow: 0, accepted: 0, excluded: [], held: 3, unreviewed: 0 }));
      }
      setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "z" }));
      await callWorker(1);
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      expect(release.args.p_error_message).toBe(expected);
      if (absent) expect(release.args.p_error_message).not.toContain(absent);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
    });
  });

  describe("T-M keyword search (DT-06)", () => {
    it.each(["EMPTY", "ERROR", "DAILY CAP", "TIMEOUT", "CRASH"] as const)("T-M keyword search %s ends released with no failure word and a zero count", async (mode) => {
      let last: { status: number; json: any };
      if (mode === "CRASH") {
        setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: Array.from({ length: 10 }, (_, i) => tweet(`c1_${i + 1}`)), nextCursor: "next", costUsd: 0.002, costMicro: 2000, tregCallId: "c1" }));
        expect((await callWorker()).json.done).toBe(false);
        db.failCount = 4;
        setProviderAdapterForTesting(async () => { throw new Error("boom"); });
        last = await callWorker(1);
      } else {
        if (mode === "DAILY CAP") db.spendAllowed = false;
        if (mode === "ERROR") setProviderAdapterForTesting(async () => ({ ok: false, httpStatus: 500, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "e", errorCode: "x", errorMessageAr: PROVIDER_GENERIC_FAILURE_AR }));
        else if (mode === "TIMEOUT") setProviderAdapterForTesting(async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
        else setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0.001, costMicro: 1000, tregCallId: "z" }));
        last = await callWorker();
      }
      expectNoBareFailed(customerTexts({ rpcCalls: db.rpcCalls, events: db.events, jobs: db.jobs, json: last.json }));
      const releases = db.rpcCalls.filter((call) => call.name === "release_job_atomic");
      expectReleasedZeroOf(mode === "CRASH" ? db.jobs[0].error_message : releases[releases.length - 1]?.args.p_error_message, 20);
    });
  });
});
