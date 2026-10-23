import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The Facebook keyword mission through the REAL worker route: spec resolution, the provider spend estimate, the post selection with a FAKE review model, the delivery
 * of comments of adopted posts only, the stop notes, and the settlement arithmetic (the mocked settlement applies the money rule: charge = ceil(delivered x unit price),
 * never above the hold). The provider is the fixture of helpers/fakeFacebookKeyword.ts. No model, no provider, no SQL.
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

import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { setProviderAdapterForTesting, type ProviderAdapterCallInput } from "../src/lib/server/tregAdapter";
import { runSocialChunk, type SocialCall } from "../src/lib/server/socialAdapter";
import { estimateSocialChunkCostUsd, getSocialCapability } from "../src/lib/socialSources";
import { setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import { setReviewDailyGuardForTesting } from "../src/lib/server/reviewDailyGuard";
import { REVIEW_CALL_COST_ESTIMATE_USD, REVIEW_JOB_CEILING_USD, REVIEW_PAGED_JOB_CEILING_USD, setRowAdvisorForTesting, setStrictSocialReviewForTesting, socialReviewCapUsd, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { POST_REVIEW_BUDGET_NOTE_AR, maxPagesForJob } from "../src/lib/server/providerCallCaps";
import { chargeForUnits, reserveForUnits, recordUnitPricePoints } from "../src/lib/recordPricing";
import { FIXTURE_TOPIC, facebookKeywordWorld, postNumberOf } from "./helpers/fakeFacebookKeyword";

const SLUG = "social-facebook-keyword-comments";
const UNIT = recordUnitPricePoints(SLUG)!;
const JOB = jobIdForQuote("quote_fb_keyword");

function resetDb(params: Record<string, unknown>, target: number) {
  db.slug = SLUG;
  db.jobs = [{ id: JOB, status: "running", current_cursor: null, delivered_units: 0, target_volume_max: target, created_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_fb_keyword", user_id: "user_1", items: [{ capabilitySlug: SLUG, endpointId: SLUG, params, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.00235, pricingUnit: "item" }], output_formats: ["csv", "xlsx"] }];
  db.partials.clear();
  db.results.clear();
  db.rpcCalls = [];
  db.events = [];
  db.usage = { rows: null, fail: false, reads: 0 };
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = target;
  db.unitPrice = UNIT;
  db.reserved = reserveForUnits(target, UNIT);
}

describe("worker: the Facebook keyword mission", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "social-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    setRelativeDateClockForTesting(() => Date.parse("2026-10-23T12:00:00Z"));
  });

  afterEach(() => {
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    setStrictSocialReviewForTesting(false);
    setReviewDailyGuardForTesting(undefined);
    setRelativeDateClockForTesting(null);
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

  const runAllChunks = async (maxChunks = 120) => {
    let last: { status: number; json: any } = { status: 0, json: {} };
    let chunks = 0;
    for (; chunks < maxChunks; chunks++) {
      last = await callWorker();
      if (last.json.done || last.json.released || last.status >= 400) { chunks += 1; break; }
    }
    return { ...last, chunks };
  };

  const usage = (costUsd: number) => ({ inputTokens: 1500, outputTokens: 300, costUsd, model: "claude-haiku-5-5", latencyMs: 20 });
  /** The fake review model: it is only ever shown POSTS (the titles of the list), and says no to every one it is shown (the on-topic posts never reach it: their own text settles them). */
  const asked: Array<{ kind: string; titles: string[] }> = [];
  const strict = (costPerCallUsd: number) => {
    asked.length = 0;
    setStrictSocialReviewForTesting(true);
    const advisor: RowAdvisorFn = async (input) => {
      asked.push({ kind: input.kind, titles: input.rows.map(({ row }) => String(row.title)) });
      return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "no_match" as const, reasonAr: "المنشور عن موضوع آخر" }])), usage: usage(costPerCallUsd), failure: null };
    };
    setRowAdvisorForTesting(advisor);
  };
  const lines = () => db.events.map((event) => String(event.message));
  const csv = () => db.results.get(`user_1/${JOB}/result.csv`)?.toString("utf-8") ?? "";

  it("a job of 100 comments (20 posts x 5): done, only adopted posts were read, the review model saw posts and never a comment, the charge is ceil(100 x 12.925) and below the hold", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 20, region: "EG" }, 100);
    const world = facebookKeywordWorld({ postsAvailable: 400 });
    useSource(world.call);
    strict(0.003);

    const { status, json } = await runAllChunks();

    expect(status).toBe(200);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(100);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
    // comments only under on-topic (even) posts, 20 posts, one call each
    const readPosts = world.reads().map((entry) => postNumberOf(entry.params.url));
    expect(readPosts).toHaveLength(20);
    expect(readPosts.every((n) => n % 2 === 0)).toBe(true);
    // the review model was shown posts (the title list of a page), never a comment, and only the posts the text could not settle
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((entry) => entry.kind === `${SLUG}-video-list`)).toBe(true);
    expect(asked.flatMap((entry) => entry.titles).every((title) => /موضوع آخر/.test(title))).toBe(true);
    // the money: charge = ceil(delivered x unit price), never above the hold; the rest of the hold goes back
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic")!;
    expect(settle).toBeDefined();
    expect(json.settle.charged_credits).toBe(chargeForUnits(100, UNIT));
    expect(json.settle.charged_credits).toBe(1293);
    expect(json.settle.charged_credits).toBeLessThanOrEqual(db.reserved);
    expect(json.settle.refunded_credits).toBe(db.reserved - 1293);
    // the chunk's provider spend is reserved at its worst case (the dearest search call times the calls a chunk may make)
    const reserve = db.rpcCalls.find((c) => c.name === "reserve_provider_spend_atomic")!;
    expect(reserve.args.p_estimated_cost_usd).toBeCloseTo(estimateSocialChunkCostUsd(getSocialCapability(SLUG)!), 6);
    // the file is Arabic and carries the post link of every comment
    expect(csv()).toContain("نص التعليق");
    expect(csv().split("\n").filter((line) => line.includes("/healthpage/posts/")).length).toBeGreaterThanOrEqual(100);
  });

  it("THE OWNER'S JOB, chunk by chunk through the worker: 300 posts x 5 comments = 1,500 comments, done in fewer chunks than the page allowance, charge 19,388 under the hold of 22,296", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 300, region: "EG" }, 1500);
    const world = facebookKeywordWorld({ postsAvailable: 1200 });
    useSource(world.call);
    strict(0.003);

    const { json, chunks } = await runAllChunks(400);
    require("fs").writeFileSync("/tmp/claude-0/-home-user-digr/3c709a42-0c09-5aa4-a35d-235166849e78/scratchpad/w2.json", JSON.stringify({ json, chunks, tail: db.events.slice(-14).map((e: any) => e.message), searches: world.searches().length, reads: world.reads().length }, null, 1));

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(1500);
    expect(world.reads()).toHaveLength(300);
    expect(world.searches()).toHaveLength(100);
    expect(chunks).toBeLessThanOrEqual(maxPagesForJob(1500, 50, "feed")); // the page allowance of a 1,500-comment job (180)
    expect(db.reserved).toBe(22_296);
    expect(json.settle.charged_credits).toBe(19_388);
    expect(json.settle.charged_credits).toBe(chargeForUnits(1500, UNIT));
    expect(json.settle.refunded_credits).toBe(22_296 - 19_388);
    // the review model judged only the posts the text could not settle (the off-topic ones), 25 to a call, in about one call per list of 50 posts
    expect(asked.flatMap((entry) => entry.titles).length).toBeGreaterThanOrEqual(290);
    expect(asked.flatMap((entry) => entry.titles).length).toBeLessThanOrEqual(300);
    expect(asked.every((entry) => entry.titles.length <= 25)).toBe(true);
    expect(asked.length).toBeLessThanOrEqual(Math.ceil(300 / 25) + 13); // at most one call more than full for each of the 13 lists
    expect(asked.length * REVIEW_CALL_COST_ESTIMATE_USD).toBeLessThan(socialReviewCapUsd(1500, UNIT, "paged_post"));
    expect(db.rpcCalls.filter((c) => c.name === "release_job_atomic")).toHaveLength(0);
  });

  it("WORST CASE FOR THE REVIEW BUDGET: no post names the country, so the model must judge all 600 posts at the measured 0.0083 USD a call: the job still completes inside the 0.25 USD ceiling of a paged job (the 0.15 ceiling of other jobs would have stopped it)", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 300, region: "EG" }, 1500);
    const world = facebookKeywordWorld({ postsAvailable: 1200 });
    // the text of an on-topic post says the topic but not the country: the text alone cannot settle it
    useSource(async (source, params, ctx) => {
      const outcome = await world.call(source, params, ctx);
      if (outcome.ok && /search/.test(source.endpointId)) outcome.data.rows = outcome.data.rows.map((row: any) => ({ ...row, message: String(row.message).replace(" في مصر", "") }));
      return outcome;
    });
    asked.length = 0;
    setStrictSocialReviewForTesting(true);
    setRowAdvisorForTesting(async (input) => {
      asked.push({ kind: input.kind, titles: input.rows.map(({ row }) => String(row.title)) });
      return { verdicts: new Map(input.rows.map(({ index, row }) => [index, { verdict: /الترندات الصحية/.test(String(row.title)) ? ("match" as const) : ("no_match" as const), reasonAr: "تقدير آلي" }])), usage: usage(REVIEW_CALL_COST_ESTIMATE_USD), failure: null };
    });

    const { json } = await runAllChunks(400);

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(1500);
    const spent = asked.length * REVIEW_CALL_COST_ESTIMATE_USD;
    expect(asked.flatMap((entry) => entry.titles).length).toBeGreaterThanOrEqual(590); // every listed post went to the model
    expect(spent).toBeGreaterThan(REVIEW_JOB_CEILING_USD); // more than the ordinary ceiling would have paid
    expect(spent).toBeLessThanOrEqual(REVIEW_PAGED_JOB_CEILING_USD);
    expect(socialReviewCapUsd(1500, UNIT, "paged_post")).toBe(REVIEW_PAGED_JOB_CEILING_USD);
    expect(socialReviewCapUsd(1500, UNIT, "post")).toBe(REVIEW_JOB_CEILING_USD);
    expect(json.settle.charged_credits).toBe(19_388);
  });

  it("STALL GUARD: a source that repeats its first page ends the job with what it delivered; the charge is only for those comments and the rest of the hold goes back", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 20, region: "EG" }, 100);
    const world = facebookKeywordWorld({ postsAvailable: 400, repeatsFirstPage: true });
    useSource(world.call);
    strict(0.003);

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(15); // the 3 on-topic posts of the one real page, 5 comments each
    expect(world.searches()).toHaveLength(3);
    expect(json.settle.charged_credits).toBe(chargeForUnits(15, UNIT));
    expect(json.settle.charged_credits).toBe(194);
    expect(json.settle.refunded_credits).toBe(db.reserved - 194);
    expect(lines().some((line) => /المسلَّم ١٥ من ١٠٠ مطلوب/.test(line))).toBe(true);
  });

  it("REVIEW BUDGET: when the budget for judging posts is spent the search stops, the stop sentence is the posts' one, and only delivered comments are charged", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 20, region: "EG" }, 100);
    const world = facebookKeywordWorld({ postsAvailable: 400 });
    useSource(world.call);
    // one review call costs the whole budget of the job (20% of its revenue, at most 0.15 USD): the next page has nothing left to pay for its review
    strict(socialReviewCapUsd(100, UNIT, "paged_post"));

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBeLessThan(100);
    expect(json.deliveredUnits).toBeGreaterThan(0);
    expect(lines().some((line) => line.includes(POST_REVIEW_BUDGET_NOTE_AR))).toBe(true);
    expect(json.settle.charged_credits).toBe(chargeForUnits(json.deliveredUnits, UNIT));
    expect(json.settle.charged_credits).toBeLessThanOrEqual(db.reserved);
    // nothing was read under a post nobody reviewed
    expect(world.reads().map((entry) => postNumberOf(entry.params.url)).every((n) => n % 2 === 0)).toBe(true);
  });

  it("NOTHING ADOPTED: no post is about the topic, no comment is read or paid for, the whole hold is released and the customer is told so in one Arabic sentence", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 20, region: "EG" }, 100);
    const world = facebookKeywordWorld({ postsAvailable: 400, onTopic: () => false });
    useSource(world.call);
    strict(0.003);

    const { json } = await runAllChunks();

    expect(json.released).toBe(true);
    expect(json.chargedCredits).toBe(0);
    expect(world.reads()).toHaveLength(0);
    expect(String(json.error)).toMatch(/^راجعنا [٠-٩]+ منشور عن بحثك على فيسبوك ولم نتمكن من تأكيد أيٍّ منها/);
    expect(String(json.error)).toContain("حُرّر الحجز المؤقت كاملًا ولم يُخصم أي رصيد");
    expect(String(json.error)).not.toMatch(/[A-Za-z]/);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });
});
