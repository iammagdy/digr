import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * X ACCOUNT jobs through the real worker route (the live job of 2026-10-27 00:50 Cairo: 20 rows received, 20 held, 0 delivered). Only the provider call and the
 * row reviewer are faked; the strict review is forced ON, as in production.
 */

const db = vi.hoisted(() => ({
  jobs: [] as any[],
  quotes: [] as any[],
  partials: new Map<string, Buffer>(),
  results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>,
  events: [] as any[],
  step: 0,
  cursor: null as string | null,
  deliveredUnits: 0,
  targetVolumeMax: 20,
  unitPrice: 9,
  reserved: 207,
  slug: "social-youtube-comments",
  /** What `llm_usage` answers to the daily review guard: costs of today's review rows (null = the table is not stubbed), a failing read, and how many reads were made. */
  usage: { rows: null as number[] | null, fail: false, reads: 0 },
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
        return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: db.slug, unit_price: db.unitPrice }, error: null };
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
      if (table === "llm_usage" && db.usage.rows !== null) {
        const chain: any = {
          select: () => chain, like: () => chain, gte: () => chain, order: () => chain,
          range: async () => { db.usage.reads += 1; return db.usage.fail ? { data: null, error: { message: "read failed" } } : { data: (db.usage.rows ?? []).map((cost_usd) => ({ cost_usd })), error: null }; },
          insert: async (row: any) => ({ data: row, error: null }),
        };
        return chain;
      }
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


const JOB = jobIdForQuote("quote_social");
const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const ok = (data: any, costMicro = 900): SocialCallOutcome => ({ ok: true, httpStatus: 200, data, costMicro, tregCallId: "call_1" });
const comments = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ comment_id: `${prefix}${i + 1}`, text: `تعليق ${prefix}${i + 1}`, author: "أحمد", likes: i, published_date: "2026-09-10", url: `${YT}&lc=${prefix}${i + 1}` }));

function resetDb(slug: string, params: Record<string, unknown>, target: number, unitPrice: number) {
  db.slug = slug;
  db.jobs = [{ id: JOB, status: "running", current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_social", user_id: "user_1", items: [{ capabilitySlug: slug, endpointId: slug, params, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.0009, pricingUnit: "item" }], output_formats: ["csv", "xlsx"] }];
  db.partials.clear();
  db.results.clear();
  db.rpcCalls = [];
  db.events = [];
  db.usage = { rows: null, fail: false, reads: 0 };
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = target;
  db.unitPrice = unitPrice;
  db.reserved = Math.ceil(target * unitPrice * 1.15);
}

import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { setProviderAdapterForTesting, type ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { setReviewDailyGuardForTesting } from "../src/lib/server/reviewDailyGuard";
import { setRowAdvisorForTesting, setStrictSocialReviewForTesting, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { summarizeActivityCounts } from "../src/lib/activityCounts";
import { xAccountZeroDeliveryAr } from "../src/lib/server/zeroDeliveryDiagnostic";

const ACCOUNT = { channel: "@elonmusk" };
const usage = (costUsd: number) => ({ inputTokens: 2000, outputTokens: 500, costUsd, model: "claude-haiku-5-5", latencyMs: 20 });

/** The reviewer of production, with the account request's own text: with nothing to match against, it answers «uncertain» for every row (the live review said «The customer request is empty»). */
const emptyRequestReviewer = (seen: Array<{ customerRequest: string; rows: number }>): RowAdvisorFn => async (input) => {
  seen.push({ customerRequest: input.customerRequest, rows: input.rows.length });
  const empty = input.customerRequest.trim() === "";
  return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: empty ? ("uncertain" as const) : ("match" as const), reasonAr: empty ? "لا يوجد موضوع للمطابقة" : "من الحساب" }])), usage: usage(0.002), failure: null };
};

describe("worker: X account jobs", () => {
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "social-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    setStrictSocialReviewForTesting(false);
    setReviewDailyGuardForTesting(undefined);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
  });

  const useSource = (call: SocialCall) => setProviderAdapterForTesting(async (input: ProviderAdapterCallInput) => runSocialChunk(input, { call, videoSelector: input.videoSelector }));
  const callWorker = async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
      method: "POST",
      headers: { authorization: "Bearer social-test-secret" },
      body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
    }));
    return { status: res.status, json: await res.json() };
  };
  const runAllChunks = async () => {
    let last: { status: number; json: any } = { status: 0, json: {} };
    for (let i = 0; i < 8; i++) {
      last = await callWorker();
      if (last.json.done || last.json.released || last.status >= 400) break;
    }
    return last;
  };
  const lines = () => db.events.map((event) => String(event.message));
  /** A row of the account's timeline in the provider's own spelling (the checked-in X post fixture: authorUsername, isReply, inReplyToId «0» for none). */
  const post = (id: string, over: Record<string, any> = {}) => ({ id, text: `منشور ${id}`, authorUsername: "elonmusk", isReply: false, inReplyToId: "0", createdUtc: 1792308962, ...over });

  it("the live job, replayed: ten rows with no readable author are held (not delivered, not charged), the strict review never runs, and the reserve is released in full", async () => {
    resetDb("social-x-posts", ACCOUNT, 10, 0.11715);
    const seen: Array<{ customerRequest: string; rows: number }> = [];
    setStrictSocialReviewForTesting(true);
    setRowAdvisorForTesting(emptyRequestReviewer(seen));
    useSource(async () => ok({ ok: true, rows: Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, text: `Yes ${i}` })) }));

    const { json } = await runAllChunks();

    expect(seen).toEqual([]); // account mode: the topic review is not asked (its request text would be empty)
    expect(json.released).toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    const release = db.rpcCalls.find((c) => c.name === "release_job_atomic")!;
    const message = String(release.args.p_error_message);
    expect(message).toBe(xAccountZeroDeliveryAr({ received: 10, held: 10, dateDropped: 0 }));
    expect(message).not.toContain("موضوع طلبك");
    expect(message).toContain("من الحساب المطلوب");
    expect(message).toContain("أُحيل ١٠ إلى المراجعة ولم يُحتسب");
    expect(message).toContain("حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد");
    expect(message).not.toMatch(/[A-Za-z]/);
    // the panel, the message and the job's own line agree
    expect(summarizeActivityCounts(lines().map((textAr) => ({ textAr }))).underReview).toBe(10);
    expect(lines().some((line) => line.includes("وأُحيل ١٠ إلى المراجعة ولم يُحتسب"))).toBe(true);
  });

  it("only rows whose author is the requested account (any letter case) are delivered; another author is excluded; no author, a reply and a reply target are held", async () => {
    resetDb("social-x-posts", ACCOUNT, 10, 0.11715);
    const seen: Array<{ customerRequest: string; rows: number }> = [];
    setStrictSocialReviewForTesting(true);
    setRowAdvisorForTesting(emptyRequestReviewer(seen));
    const rows = [
      post("e1"), post("e2"), post("e3"), post("e4"),
      post("e5", { authorUsername: "ElonMusk" }),                // the same account in another letter case: delivered
      post("o1", { authorUsername: "BillGates" }),               // another author: excluded
      post("rt1", { authorUsername: "BillGates", text: "RT @BillGates: hello" }), // a repost shows its original author: excluded
      { id: "n1", text: "no author at all" },                    // no readable author: held
      post("r1", { isReply: true }),                             // marked as a reply: held
      post("r2", { inReplyToId: "1892345678901234567" }),        // has a reply target: held
    ];
    useSource(async () => ok({ ok: true, rows }));

    const { json } = await runAllChunks();

    expect(seen).toEqual([]);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(5);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) expect(csv).toContain(`منشور ${id}`);
    for (const text of ["منشور o1", "RT @BillGates", "no author at all", "منشور r1", "منشور r2"]) expect(csv).not.toContain(text);
    // charge = delivered rows x unit price, never above the reserve (the settlement function is the approved one, unchanged)
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic")!;
    expect(settle).toBeDefined();
    expect(json.settle.charged_credits).toBe(Math.min(Math.ceil(5 * 0.11715), db.reserved));
    expect(lines().some((line) => line.includes("قيد المراجعة ٣"))).toBe(true);
  });

  it("a topic search of X keeps its strict review (the reviewer IS asked, with the topic as the request)", async () => {
    resetDb("social-x-posts", { query: "الذكاء الاصطناعي" }, 10, 0.11715);
    const seen: Array<{ customerRequest: string; rows: number }> = [];
    setStrictSocialReviewForTesting(true);
    setRowAdvisorForTesting(emptyRequestReviewer(seen));
    useSource(async () => ok({ ok: true, rows: Array.from({ length: 3 }, (_, i) => ({ tweet_id: `t${i}`, text: `منشور ${i} عن الذكاء الاصطناعي في التعليم` })) }));
    const { json } = await runAllChunks();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].customerRequest).toContain("الذكاء الاصطناعي");
    expect(json.deliveredUnits).toBe(3);
  });
});
