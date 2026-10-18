import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Retry reuse: a retried job starts from the rows the failed run collected and
 * fetches only the deficit. Money still moves only through the approved RPCs
 * (reserve/settle/release are asserted through the mocked RPC calls).
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
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
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

import { jobIdForQuote, planParamsSignature, rowIdentity, readReusableRows, ensureRetrySeed, findRetryableJob } from "../src/lib/server/retryReuse";
import { resolveJobExecutionSpec } from "../src/lib/server/jobExecutionSpec";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";

const PREV_JOB = jobIdForQuote("quote_old");
const NEW_JOB = jobIdForQuote("quote_new");

const tweet = (id: string) => ({ tweet_id: id, text: `نص ${id} عن AI Trends` });
const putStep = (jobId: string, step: number, rows: any[], extra: Record<string, unknown> = {}) =>
  db.partials.set(`${jobId}/step_${step}.json`, Buffer.from(JSON.stringify({ jobId, step, rows, rawRowsCount: rows.length, ...extra })));

function quote(id: string, params: Record<string, unknown>, target = 10) {
  return {
    id,
    user_id: "user_1",
    items: [{ capabilitySlug: "x-keyword-search", endpointId: "treg.twitter.tweets", params, targetVolumeMax: target, paginationStrategy: "cursor" }],
    output_formats: ["csv"],
  };
}

function resetDb(retryParams: Record<string, unknown> = { query: "AI Trends", retryOfJobId: PREV_JOB }, prevOverrides: Record<string, unknown> = {}) {
  db.jobs = [{ id: PREV_JOB, user_id: "user_1", status: "failed", step: 1, delivered_units: 0, endpoint_id: "x-keyword-search", unit_price: 2, updated_at: new Date().toISOString(), created_at: new Date().toISOString(), ...prevOverrides }, { id: NEW_JOB, user_id: "user_1", status: "running", current_cursor: null, target_volume_max: 10, delivered_units: 0, created_at: new Date().toISOString() }];
  db.quotes = [quote("quote_old", { query: "AI Trends" }), quote("quote_new", retryParams)];
  db.partials.clear();
  db.results.clear();
  db.rpcCalls = [];
  db.events = [];
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = 10;
  db.unitPrice = 2;
  db.reserved = 30;
}

describe("retry reuse helpers", () => {
  beforeEach(() => resetDb());

  it("signature ignores paging and the retry marker but not the search itself", () => {
    const base = planParamsSignature("x-keyword-search", { query: "AI Trends", limit: 10 });
    expect(planParamsSignature("x-keyword-search", { limit: 50, query: "AI Trends", retryOfJobId: PREV_JOB })).toBe(base);
    expect(planParamsSignature("x-keyword-search", { query: "Other topic" })).not.toBe(base);
    expect(planParamsSignature("youtube-search", { query: "AI Trends" })).not.toBe(base);
  });

  it("derives the same job id the accept function derives from a quote", () => {
    expect(jobIdForQuote("quote_new")).toMatch(/^job_quote_[a-f0-9]{32}$/);
  });

  it("reads rows from consecutive step files, removes duplicates and caps at the target", async () => {
    putStep(PREV_JOB, 0, [tweet("1"), tweet("2"), tweet("3")], { uncertainRows: [{ tweet_id: "u1" }] });
    putStep(PREV_JOB, 1, [tweet("3"), tweet("4"), tweet("5")]);
    const all = await readReusableRows({ storage: { from: () => ({ download: async (k: string) => (db.partials.has(k) ? { data: new Blob([new Uint8Array(db.partials.get(k)!)]), error: null } : { data: null, error: { message: "x" } }) }) } }, PREV_JOB, 1, 10);
    expect(all.rows.map((r) => r.tweet_id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(all.uncertainRows).toHaveLength(1);
    const capped = await readReusableRows({ storage: { from: () => ({ download: async (k: string) => (db.partials.has(k) ? { data: new Blob([new Uint8Array(db.partials.get(k)!)]), error: null } : { data: null, error: { message: "x" } }) }) } }, PREV_JOB, 1, 3);
    expect(capped.rows).toHaveLength(3);
  });

  it("stops at a corrupt step file instead of using unreadable data", async () => {
    putStep(PREV_JOB, 0, [tweet("1")]);
    db.partials.set(`${PREV_JOB}/step_1.json`, Buffer.from("not json"));
    putStep(PREV_JOB, 2, [tweet("9")]);
    const result = await readReusableRows({ storage: { from: () => ({ download: async (k: string) => (db.partials.has(k) ? { data: new Blob([new Uint8Array(db.partials.get(k)!)]), error: null } : { data: null, error: { message: "x" } }) }) } }, PREV_JOB, 2, 10);
    expect(result.rows.map((r) => r.tweet_id)).toEqual(["1"]);
  });

  it("row identity prefers ids, then website domain, then name", () => {
    expect(rowIdentity({ id: "A1" })).toBe("id:a1");
    expect(rowIdentity({ website: "https://www.Example.com/x" })).toBe("domain:example.com");
    expect(rowIdentity({ company_name: "شركة النيل" })).toMatch(/^name:/);
    expect(rowIdentity({})).toBeNull();
  });

  it("finds the failed job of the latest quote of the conversation, and nothing when it did not fail", async () => {
    const client = {
      from: (table: string) => table === "messages"
        ? builder(() => [
            { user_id: "user_1", conversation_id: "conv_1", quote: { quoteId: "quote_old" } },
            { user_id: "user_1", conversation_id: "conv_1", quote: { quoteId: "quote_older" } },
          ])
        : builder(() => db.jobs),
    };
    const found = await findRetryableJob(client, "user_1", "conv_1");
    expect(found).toMatchObject({ jobId: PREV_JOB, quoteId: "quote_old" });

    db.jobs[0].status = "completed";
    expect(await findRetryableJob(client, "user_1", "conv_1")).toBeNull();

    db.jobs[0].status = "failed";
    db.jobs[0].updated_at = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    expect(await findRetryableJob(client, "user_1", "conv_1")).toBeNull();
  });

  it("the resolved spec carries the retry marker but never sends it to the provider as a parameter", async () => {
    const admin = (await import("../src/lib/supabase/server")).createAdminClient();
    const spec = await resolveJobExecutionSpec(admin, NEW_JOB, "user_1", "x-keyword-search", 2);
    expect(spec.retryOfJobId).toBe(PREV_JOB);
    expect(spec.params).not.toHaveProperty("retryOfJobId");
    expect(spec.params.query).toBe("AI Trends");
  });
});

describe("ensureRetrySeed validation (every check comes from the database)", () => {
  beforeEach(() => resetDb());
  const run = async (overrides: Record<string, unknown> = {}) => {
    const admin = (await import("../src/lib/supabase/server")).createAdminClient();
    const spec = await resolveJobExecutionSpec(admin, NEW_JOB, "user_1", "x-keyword-search", 2);
    return ensureRetrySeed(admin, { newJobId: NEW_JOB, userId: "user_1", retryOfJobId: PREV_JOB, currentStep: 0, targetMax: 10, newSpec: spec, ...overrides } as any);
  };

  it("creates a seed from a failed job of the same user with the same plan", async () => {
    putStep(PREV_JOB, 0, [tweet("1"), tweet("2")]);
    const result = await run();
    expect(result.seed?.rows).toHaveLength(2);
    expect(db.partials.has(`${NEW_JOB}/seed.json`)).toBe(true);
  });

  it("refuses another user's job", async () => {
    putStep(PREV_JOB, 0, [tweet("1")]);
    db.jobs[0].user_id = "someone_else";
    expect((await run()).seed).toBeNull();
  });

  it("refuses a job that did not fail", async () => {
    putStep(PREV_JOB, 0, [tweet("1")]);
    db.jobs[0].status = "completed";
    expect(await run()).toMatchObject({ seed: null, reason: "not_failed" });
  });

  it("refuses rows older than the freshness window", async () => {
    putStep(PREV_JOB, 0, [tweet("1")]);
    db.jobs[0].updated_at = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    expect(await run()).toMatchObject({ seed: null, reason: "too_old" });
  });

  it("refuses when the new plan searches for something different", async () => {
    putStep(PREV_JOB, 0, [tweet("1")]);
    db.quotes = [quote("quote_old", { query: "AI Trends" }), quote("quote_new", { query: "Different topic", retryOfJobId: PREV_JOB })];
    expect(await run()).toMatchObject({ seed: null, reason: "plan_changed" });
  });

  it("refuses when the failed run collected nothing", async () => {
    expect(await run()).toMatchObject({ seed: null, reason: "no_rows" });
  });
});

describe("worker: retried job fetches only the deficit", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "retry-test-secret";
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

  const callWorker = async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer retry-test-secret" },
      body: JSON.stringify({ jobId: NEW_JOB, expectedStep: 0, disableSelfChain: true }),
    }));
    return { status: res.status, json: await res.json() };
  };

  it("reuses 7 stored rows, asks the provider for 3, delivers 10 and settles on delivered rows", async () => {
    putStep(PREV_JOB, 0, Array.from({ length: 7 }, (_, i) => tweet(`old_${i + 1}`)));
    let asked = -1;
    let providerCalls = 0;
    setProviderAdapterForTesting(async (input) => {
      providerCalls += 1;
      asked = input.remainingNeeded;
      return { ok: true, httpStatus: 200, rows: [tweet("new_1"), tweet("new_2"), tweet("new_3")], nextCursor: null, costUsd: 0.003, costMicro: 3000, tregCallId: "call_1" };
    });

    const { status, json } = await callWorker();

    expect(status).toBe(200);
    expect(providerCalls).toBe(1);
    expect(asked).toBe(3); // deficit only, not 10
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(10);

    const complete = db.rpcCalls.find((call) => call.name === "complete_chunk")!;
    expect(complete.args.p_new_delivered_units).toBe(10);
    // Provider spend is reserved through the approved function, once, for this single page.
    expect(db.rpcCalls.filter((call) => call.name === "reserve_provider_spend_atomic")).toHaveLength(1);
    const settle = db.rpcCalls.find((call) => call.name === "settle_job_atomic")!;
    expect(settle.args.p_job_id).toBe(NEW_JOB);

    // Delivered CSV holds all 10 rows: 7 reused + 3 fetched.
    const csv = db.results.get(`user_1/${NEW_JOB}/result.csv`)!.toString("utf-8");
    for (const id of ["old_1", "old_7", "new_1", "new_3"]) expect(csv).toContain(id);
    expect(csv.split("\n").filter((line) => /old_|new_/.test(line))).toHaveLength(10);

    // Customer-visible event is plain Arabic and names the reused count.
    expect(db.events.some((event) => /أُعيد استخدام ٧ سجل/.test(String(event.message)))).toBe(true);

    // Nothing is left behind after settlement.
    expect(db.partials.has(`${NEW_JOB}/seed.json`)).toBe(false);
    expect(db.partials.has(`${PREV_JOB}/step_0.json`)).toBe(false);
    // No release was called on the success path.
    expect(db.rpcCalls.some((call) => call.name === "release_job_atomic")).toBe(false);
  });

  it("does not call the provider at all when the reused rows already cover the target", async () => {
    putStep(PREV_JOB, 0, Array.from({ length: 10 }, (_, i) => tweet(`old_${i + 1}`)));
    let providerCalls = 0;
    setProviderAdapterForTesting(async () => { providerCalls += 1; return { ok: true, httpStatus: 200, rows: [], nextCursor: null, costUsd: 0, costMicro: 0, tregCallId: "" }; });

    const { status, json } = await callWorker();

    expect(status).toBe(200);
    expect(providerCalls).toBe(0);
    expect(db.rpcCalls.some((call) => call.name === "reserve_provider_spend_atomic")).toBe(false);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(10);
  });

  it("drops fetched rows that repeat a reused row and does not charge for them", async () => {
    putStep(PREV_JOB, 0, Array.from({ length: 7 }, (_, i) => tweet(`old_${i + 1}`)));
    setProviderAdapterForTesting(async () => ({ ok: true, httpStatus: 200, rows: [tweet("old_1"), tweet("new_1"), tweet("new_2")], nextCursor: null, costUsd: 0.003, costMicro: 3000, tregCallId: "call_2" }));

    const { json } = await callWorker();

    expect(json.deliveredUnits).toBe(9); // 7 reused + 2 genuinely new
    const csv = db.results.get(`user_1/${NEW_JOB}/result.csv`)!.toString("utf-8");
    // One CSV line per row (each row mentions its id twice: id column and text).
    expect(csv.split("\n").filter((line) => line.includes("old_1"))).toHaveLength(1);
  });

  it("falls back to a normal full run when the plan changed", async () => {
    putStep(PREV_JOB, 0, Array.from({ length: 7 }, (_, i) => tweet(`old_${i + 1}`)));
    db.quotes = [quote("quote_old", { query: "AI Trends" }), quote("quote_new", { query: "Another subject", retryOfJobId: PREV_JOB })];
    let asked = -1;
    setProviderAdapterForTesting(async (input) => {
      asked = input.remainingNeeded;
      return { ok: true, httpStatus: 200, rows: Array.from({ length: 10 }, (_, i) => ({ tweet_id: `fresh_${i + 1}`, text: `Another subject fresh_${i + 1}` })), nextCursor: null, costUsd: 0.01, costMicro: 10000, tregCallId: "call_3" };
    });

    const { json } = await callWorker();

    expect(asked).toBe(10); // nothing reused
    expect(json.deliveredUnits).toBe(10);
    const csv = db.results.get(`user_1/${NEW_JOB}/result.csv`)!.toString("utf-8");
    expect(csv).not.toContain("old_1");
  });

  it("never reuses another user's partial rows", async () => {
    putStep(PREV_JOB, 0, Array.from({ length: 7 }, (_, i) => tweet(`old_${i + 1}`)));
    db.jobs[0].user_id = "someone_else";
    let asked = -1;
    setProviderAdapterForTesting(async (input) => {
      asked = input.remainingNeeded;
      return { ok: true, httpStatus: 200, rows: Array.from({ length: 10 }, (_, i) => tweet(`fresh_${i + 1}`)), nextCursor: null, costUsd: 0.01, costMicro: 10000, tregCallId: "call_4" };
    });

    await callWorker();

    expect(asked).toBe(10);
    const csv = db.results.get(`user_1/${NEW_JOB}/result.csv`)!.toString("utf-8");
    expect(csv).not.toContain("old_");
  });
});
