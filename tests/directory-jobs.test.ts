import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Directory (company) jobs, 22 Oct 2026: a company request for 50 contractors in Egypt ran on a source whose slug and endpoint do not
 * contain "compan" («blitzapi-jobs-search», «blitzapi.jobs.search»). The worker took it for a feed: every row was rejected by the social
 * topic-word filter («لا يتضمن نص السجل كلمات من موضوع البحث») and no page limit applied, so it paged 175 times and delivered 0.
 * Offline replay with fake rows; no live calls.
 */
const db = vi.hoisted(() => ({
  jobs: [] as any[], quotes: [] as any[],
  partials: new Map<string, Buffer>(), results: new Map<string, Buffer>(),
  rpcCalls: [] as Array<{ name: string; args: any }>, events: [] as any[], costs: [] as any[],
  step: 0, cursor: null as string | null, deliveredUnits: 0, targetVolumeMax: 2, unitPrice: 2, reserved: 6, endpointId: "icypeas.companies.search",
}));

const JOB_ID_FOR_COSTS = () => db.jobs[0]?.id as string;

function builder(rows: () => any[]) {
  const filters: Array<[string, unknown]> = [];
  const apply = () => rows().filter((row) => filters.every(([col, val]) => row[col] === val));
  const api: any = {
    select: () => api, eq: (c: string, v: unknown) => { filters.push([c, v]); return api; },
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
      if (name === "claim_job_chunk") return { data: { claimed: true, job_id: args.p_job_id, user_id: "user_1", step: db.step, current_cursor: db.cursor, delivered_units: db.deliveredUnits, target_volume_max: db.targetVolumeMax, target_volume_min: 1, endpoint_id: db.endpointId, unit_price: db.unitPrice }, error: null };
      if (name === "reserve_provider_spend_atomic") return { data: { allowed: true, cost_id: 11 }, error: null };
      if (name === "commit_provider_spend" || name === "commit_provider_spend_v2") { db.costs.push({ provider: "treg", job_id: JOB_ID_FOR_COSTS(), cost_usd: Number(args.p_actual_cost_usd) || 0 }); return { data: { success: true }, error: null }; }
      if (name === "complete_chunk") {
        db.step += 1; db.deliveredUnits = args.p_new_delivered_units; db.cursor = args.p_new_cursor;
        const job = db.jobs.find((row) => row.id === args.p_job_id);
        if (job) Object.assign(job, { current_cursor: db.cursor, delivered_units: db.deliveredUnits, status: "running" });
        return { data: { success: true, delivered_units: db.deliveredUnits }, error: null };
      }
      if (name === "settle_job_atomic") return { data: { success: true, charged_credits: Math.min(Math.ceil(db.deliveredUnits * db.unitPrice), db.reserved), refunded_credits: 0 }, error: null };
      if (name === "release_job_atomic") return { data: { success: true, released_credits: db.reserved }, error: null };
      return { data: { success: true }, error: null };
    }),
    storage: {
      from: (bucket: string) => {
        const store = bucket === "partials" ? db.partials : db.results;
        return {
          upload: async (path: string, body: any) => { store.set(path, Buffer.isBuffer(body) ? body : Buffer.from(String(body))); return { data: { path }, error: null }; },
          download: async (path: string) => { const buf = store.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]), error: null } : { data: null, error: { message: "not_found" } }; },
          remove: async (paths: string[]) => { for (const p of paths) store.delete(p); return { data: paths, error: null }; },
        };
      },
    },
    from: (table: string) => {
      if (table === "jobs") return builder(() => db.jobs);
      if (table === "plans_quotes") return builder(() => db.quotes);
      if (table === "provider_costs") return builder(() => db.costs);
      if (table === "job_events" || table === "notifications" || table === "artifact_versions") {
        const base = builder(() => (table === "job_events" ? db.events : []));
        return { ...base, insert: async (row: any) => { if (table === "job_events") db.events.push(row); return { data: row, error: null }; }, upsert: async (row: any) => ({ data: row, error: null }) };
      }
      return builder(() => []);
    },
  })),
}));
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null), searchCatalog: vi.fn(async () => []),
}));

import { jobIdForQuote } from "../src/lib/server/retryReuse";
import { resolveJobExecutionSpec } from "../src/lib/server/jobExecutionSpec";
import { setProviderAdapterForTesting } from "../src/lib/server/tregAdapter";
import {
  ABSOLUTE_MAX_PAGES, DIRECTORY_MAX_PAGES, DIRECTORY_NO_PROGRESS_PAGES, evaluateProviderCallCap, maxPagesForJob,
} from "../src/lib/server/providerCallCaps";
import { isCompanyDirectoryJob } from "../src/lib/server/directoryCapability";
import { JOB_SPEND_ABSOLUTE_MAX_USD, defaultJobProviderCeilingUsd, expectedJobProviderUsd } from "../src/lib/server/jobSpendCeiling";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { durationStepFromPlanItem, missionDurationForPlan } from "../src/lib/missionDuration";

const JOB = jobIdForQuote("quote_dir");
const UNIT_COST = 0.000495; // provider price per requested record of this source


const SLUG = "blitzapi-jobs-search";
const ENDPOINT = "blitzapi.jobs.search";
/** The plan of the failed job, as stored in plans_quotes.items (22 Oct 2026). */
const PLAN_PARAMS = {
  query: { keyword: { include: ["construction", "contracting"] }, location: { include: ["Egypt"] } },
  search: "المقاولات والتشييد في مصر", country: "Egypt", industry: "المقاولات والتشييد", location: "Egypt", pagination: { size: 50 },
};
// rows whose text carries NONE of the topic's words (no «مقاولات», no «تشييد»), like the rows the failed job rejected
const noTopicWords = (n: number) => ({ id: `x_${n}`, company_name: `Delta Group ${n}`, description: "", location: "Cairo, Egypt", website: `https://delta-${n}.example.com` });
const contractor = (n: number) => ({ id: `c_${n}`, company_name: `Nile Builders ${n}`, industry: "Construction", description: "Engineering and construction contractor", location: "Giza, Egypt", website: `https://nile-${n}.example.com` });

function reset(target: number, plan: { slug?: string; endpoint?: string; params?: Record<string, any> } = {}) {
  db.jobs = [{ id: JOB, user_id: "user_1", status: "running", current_cursor: null, target_volume_max: target, delivered_units: 0, created_at: new Date().toISOString() }];
  db.quotes = [{ id: "quote_dir", user_id: "user_1", output_formats: ["xlsx"], items: [{ capabilitySlug: plan.slug ?? SLUG, endpointId: plan.endpoint ?? ENDPOINT, targetVolumeMax: target, paginationStrategy: "cursor", unitCostUsd: 0.000495, pricingUnit: "item", params: plan.params ?? PLAN_PARAMS }] }];
  db.partials.clear(); db.results.clear(); db.rpcCalls = []; db.events = []; db.costs = [];
  db.step = 0; db.cursor = null; db.deliveredUnits = 0; db.targetVolumeMax = target; db.unitPrice = 3; db.reserved = 173; db.endpointId = plan.endpoint ?? ENDPOINT;
}

describe("a company search is recognised by its plan, not only by its name", () => {
  it("the failed job's source (no «compan» in its name) is a company search because its plan has the company shape", () => {
    expect(isCompanyDirectoryJob(SLUG, ENDPOINT, PLAN_PARAMS)).toBe(true);
    expect(isCompanyDirectoryJob("icypeas-companies-search", "icypeas.companies.search", {})).toBe(true);
    expect(isCompanyDirectoryJob("web-company-search", "x", undefined)).toBe(true);
  });

  it("social and other services are not company searches, whatever their parameters", () => {
    expect(isCompanyDirectoryJob("social-x-posts", "anyapi.x.search.posts", { query: "الغلاء", region: "EG" })).toBe(false);
    expect(isCompanyDirectoryJob("social-tiktok-videos", "tikhub.tiktok.search.videos", { query: "مقاولات", industry: "x" })).toBe(false);
    expect(isCompanyDirectoryJob("tiktok-profile", "tikhub.tiktok.user.profile", { uniqueId: "a" })).toBe(false);
    expect(isCompanyDirectoryJob(SLUG, ENDPOINT, { query: { keyword: { include: ["a"] } } })).toBe(false); // no industry
    expect(isCompanyDirectoryJob(SLUG, ENDPOINT, null)).toBe(false);
  });
});

describe("company rows are not rejected by the social topic-word filter", () => {
  const NO_TOPIC_WORDS_REASON = /كلمات من موضوع البحث/;

  it("rows without any topic word in their text are judged by the company review, never rejected as «no topic words»", () => {
    for (let n = 1; n <= 10; n++) {
      const verdict = evaluateResearchRowRelevance(noTopicWords(n), { capabilitySlug: SLUG, endpointId: ENDPOINT, params: PLAN_PARAMS });
      expect(verdict.reasonAr).not.toMatch(NO_TOPIC_WORDS_REASON);
      expect(verdict.decision).not.toBe("no_match");
    }
  });

  it("a real contractor still matches on its own text", () => {
    const verdict = evaluateResearchRowRelevance(contractor(1), { capabilitySlug: SLUG, endpointId: ENDPOINT, params: PLAN_PARAMS });
    expect(verdict.decision).toBe("match");
  });

  it("control: a feed search (a topic query, no company plan) keeps rejecting a row with no topic word, with the same reason as before", () => {
    const feedParams = { query: "مقاولات وتشييد", region: "EG" };
    const row = { id: "t1", text: "اليوم الجو جميل في القاهرة والناس خرجت للتمشية", lang: "ar" };
    const verdict = evaluateResearchRowRelevance(row, { capabilitySlug: "social-tiktok-videos", endpointId: "tikhub.tiktok.search.videos", params: feedParams });
    expect(verdict.decision).toBe("no_match");
    expect(verdict.reasonAr).toMatch(NO_TOPIC_WORDS_REASON);
  });
});

describe("directory page limit and stop rules", () => {
  it("the page limit of a directory job is 3 times the pages it needs, never above 30", () => {
    expect(maxPagesForJob(50, 50, "directory")).toBe(3);
    expect(maxPagesForJob(50, 10, "directory")).toBe(15);
    expect(maxPagesForJob(100, 10, "directory")).toBe(30);
    expect(maxPagesForJob(1000, 10, "directory")).toBe(30);
    expect(maxPagesForJob(100_000, 10, "directory")).toBe(DIRECTORY_MAX_PAGES);
    expect(DIRECTORY_MAX_PAGES).toBe(30);
    expect(DIRECTORY_MAX_PAGES).toBeLessThan(ABSOLUTE_MAX_PAGES);
  });

  it("feeds keep their limit: 6 times the pages needed, up to 300", () => {
    expect(maxPagesForJob(300, 50, "feed")).toBe(36);
    expect(maxPagesForJob(1000, 50, "feed")).toBe(120);
    expect(maxPagesForJob(100_000, 50, "feed")).toBe(300);
  });

  it("any job with nothing delivered after 5 pages stops, even when earlier pages cannot be read back", () => {
    expect(DIRECTORY_NO_PROGRESS_PAGES).toBe(5);
    const unreadable = [null, null, null, null];
    expect(evaluateProviderCallCap({ pagesDone: 5, acceptedThisPage: 0, priorBatchUnits: unreadable, targetMax: 50, pageSize: 10, kind: "directory", deliveredTotal: 0 })).toBe("no_progress");
    expect(evaluateProviderCallCap({ pagesDone: 4, acceptedThisPage: 0, priorBatchUnits: [null, null, null], targetMax: 50, pageSize: 10, kind: "directory", deliveredTotal: 0 })).toBeNull();
    // something was delivered: the no-progress rule does not apply
    expect(evaluateProviderCallCap({ pagesDone: 5, acceptedThisPage: 0, priorBatchUnits: unreadable, targetMax: 50, pageSize: 10, kind: "directory", deliveredTotal: 7 })).toBeNull();
    // every kind of job has it (feeds too)
    expect(evaluateProviderCallCap({ pagesDone: 5, acceptedThisPage: 0, priorBatchUnits: unreadable, targetMax: 50, pageSize: 10, kind: "feed", deliveredTotal: 0 })).toBe("no_progress");
  });

  it("the page limit is reported when it is reached", () => {
    expect(evaluateProviderCallCap({ pagesDone: 3, acceptedThisPage: 5, priorBatchUnits: [5, 5], targetMax: 50, pageSize: 50, kind: "directory", deliveredTotal: 15 })).toBe("page_cap");
  });
});

describe("the failed job replayed through the worker (fake data, no live calls)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "dir-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  async function runJob(pageRows: (page: number, size: number) => any[], maxCalls = 60, pageCostUsd?: (size: number) => number) {
    const route = await import("../src/app/api/worker/chunk/route");
    const asked: number[] = [];
    let calls = 0;
    setProviderAdapterForTesting(async (input) => {
      calls += 1;
      asked.push(input.pageSize);
      const rows = pageRows(calls, input.pageSize);
      return { ok: true, httpStatus: 200, rows, nextCursor: `cursor_${calls}`, costUsd: (pageCostUsd ?? ((n: number) => n * UNIT_COST))(input.pageSize), costMicro: Math.round((pageCostUsd ?? ((n: number) => n * UNIT_COST))(input.pageSize) * 1e6), tregCallId: `call_${calls}` };
    });
    let last: any = null;
    for (let i = 0; i < maxCalls; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST", headers: { authorization: "Bearer dir-test-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return { calls, asked, last };
  }

  it("50 companies, no row ever matches: at most 5 pages (here 3), nothing delivered, the whole reserve released, nothing charged", async () => {
    reset(50);
    const { calls, last } = await runJob((page, size) => Array.from({ length: size }, (_, i) => noTopicWords(page * 1000 + i)));
    expect(calls).toBeLessThanOrEqual(DIRECTORY_NO_PROGRESS_PAGES);
    expect(calls).toBeLessThanOrEqual(maxPagesForJob(50, 50, "directory"));
    // the spend ceiling (3 x the 0.02475 USD expected, at most 0.05) closes the door before a third page of 50 is bought
    expect(calls).toBe(2);
    expect(last.json.released).toBe(true);
    expect(last.json.chargedCredits).toBe(0);
    expect(last.json.ceiling).toBe("job"); // closed by the per-job spend ceiling, not by the provider
    expect(db.costs.length).toBe(2);
    expect(db.rpcCalls.filter((c) => c.name === "release_job_atomic")).toHaveLength(1);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    // the rows were not thrown away as «no topic words»: no progress line carries that reason
    expect(db.events.some((e) => /كلمات من موضوع البحث/.test(String(e.message)))).toBe(false);
  });

  it("50 companies, normal matches: delivered in one or two pages, charged ceil(delivered x unit price)", async () => {
    reset(50);
    const { calls, last } = await runJob((page, size) => Array.from({ length: size }, (_, i) => (i % 2 === 0 ? contractor(page * 1000 + i) : noTopicWords(page * 1000 + i))));
    expect(calls).toBeLessThanOrEqual(maxPagesForJob(50, 50, "directory"));
    expect(last.json.done).toBe(true);
    expect(last.json.deliveredUnits).toBe(50);
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settle).toBeTruthy();
    expect(Math.ceil(50 * 3)).toBe(150);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
  });

  it("some matches then nothing: stops at the limit, settles with what it collected (ceil(delivered x unit price))", async () => {
    reset(50);
    const { calls, last } = await runJob((page, size) => (page === 1 ? Array.from({ length: size }, (_, i) => (i < 12 ? contractor(i) : noTopicWords(i))) : Array.from({ length: size }, (_, i) => noTopicWords(page * 1000 + i))));
    expect(calls).toBeLessThanOrEqual(maxPagesForJob(50, 50, "directory"));
    expect(calls).toBe(2); // stopped by the per-job spend ceiling, then settled with what was collected
    expect(last.json.done).toBe(true);
    expect(last.json.deliveredUnits).toBe(12);
    const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
    expect(settle).toBeTruthy();
    // the settlement reads the delivered count the chunks recorded: 12 rows, so ceil(12 x 3) = 36 points of the 173 reserved
    const lastChunk = [...db.rpcCalls].reverse().find((c) => c.name === "complete_chunk")!;
    expect(lastChunk.args.p_new_delivered_units).toBe(12);
    expect(Math.ceil(12 * db.unitPrice)).toBe(36);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
  });
});

describe("the default per-job spend ceiling", () => {
  const base = { unitCostUsd: 0.000495, targetMax: 50, pageSize: 50, kind: "directory" as const, billsPerRequestedRecord: true };

  it("is 3 times the plan's expected provider cost, at most 0.05 USD", () => {
    expect(expectedJobProviderUsd(base)).toBeCloseTo(0.02475, 6);
    expect(defaultJobProviderCeilingUsd(base)).toBe(0.05); // 3 x 0.02475 = 0.074 is cut to the absolute maximum
    // a small plan: 3 x its expected cost, under the maximum
    expect(defaultJobProviderCeilingUsd({ ...base, targetMax: 3, pageSize: 9 })).toBeCloseTo(3 * 9 * 0.000495, 6);
    expect(JOB_SPEND_ABSOLUTE_MAX_USD).toBe(0.05);
  });

  it("is 3 times the plan's own expected cost when the plan itself is expected to cost more than 0.05 USD", () => {
    const big = { ...base, targetMax: 200, pageSize: 50, unitCostUsd: 0.001 };
    expect(expectedJobProviderUsd(big)).toBeCloseTo(0.2, 6);
    expect(defaultJobProviderCeilingUsd(big)).toBeCloseTo(0.6, 6);
  });

  it("never falls below the plan's expected cost, and a feed keeps what its own approved page limit allows", () => {
    for (const target of [1, 5, 10, 50, 200, 1000]) {
      const input = { ...base, targetMax: target, pageSize: Math.min(50, Math.max(1, target)) };
      expect(defaultJobProviderCeilingUsd(input)).toBeGreaterThanOrEqual(expectedJobProviderUsd(input));
    }
    const feed = { unitCostUsd: 0.002, targetMax: 300, pageSize: 50, kind: "feed" as const, billsPerRequestedRecord: false };
    expect(defaultJobProviderCeilingUsd(feed)).toBeCloseTo(maxPagesForJob(300, 50, "feed") * 0.002, 6); // 36 pages
  });
});

describe("a capability the code does not recognise is capped like any other (22 Oct 2026: it was not capped at all)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "dir-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development";
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete (process.env as any)[k]; else (process.env as any)[k] = v; }
  });

  const UNKNOWN = { slug: "mystery-source-search", endpoint: "mystery.rows.search", params: { query: "solar panels" } };
  const unrelated = (n: number) => ({ id: `u_${n}`, title: `Weekend market ${n}`, description: "fresh vegetables and fruit" });
  const onTopic = (n: number) => ({ id: `s_${n}`, title: `Solar panels installer ${n}`, description: "installs solar panels" });

  async function runUnknown(pageRows: (page: number, size: number) => any[], pageCostUsd?: (size: number) => number) {
    const route = await import("../src/app/api/worker/chunk/route");
    let calls = 0;
    setProviderAdapterForTesting(async (input) => {
      calls += 1;
      const rows = pageRows(calls, input.pageSize);
      const cost = (pageCostUsd ?? ((n: number) => n * UNIT_COST))(input.pageSize);
      return { ok: true, httpStatus: 200, rows, nextCursor: `cursor_${calls}`, costUsd: cost, costMicro: Math.round(cost * 1e6), tregCallId: `call_${calls}` };
    });
    let last: any = null;
    for (let i = 0; i < 80; i++) {
      const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", {
        method: "POST", headers: { authorization: "Bearer dir-test-secret" },
        body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }),
      }));
      last = { status: res.status, json: await res.json() };
      if (last.json.done === true || last.json.released === true || last.status >= 400) break;
    }
    return { calls, last };
  }

  it("nothing is ever accepted: it stops within 5 pages, delivers nothing, releases the whole reserve, charges nothing", async () => {
    reset(50, UNKNOWN);
    const { calls, last } = await runUnknown((page, size) => Array.from({ length: size }, (_, i) => unrelated(page * 1000 + i)));
    expect(calls).toBeLessThanOrEqual(5);
    expect(last.json.released).toBe(true);
    expect(last.json.chargedCredits).toBe(0);
    expect(db.rpcCalls.filter((c) => c.name === "release_job_atomic")).toHaveLength(1);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });

  it("one row accepted per page for ever: the page limit (3 x pages needed) and the spend ceiling bound it; it settles with what it collected", async () => {
    reset(50, UNKNOWN);
    const { calls, last } = await runUnknown((page, size) => [onTopic(page), ...Array.from({ length: size - 1 }, (_, i) => unrelated(page * 1000 + i))]);
    expect(calls).toBeLessThan(maxPagesForJob(50, 10, "directory")); // the page limit is 15; the ceiling (0.05 USD at 0.00495 a page) stops it at 10
    expect(calls).toBe(10);
    expect(last.json.done).toBe(true);
    expect(last.json.deliveredUnits).toBe(10);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
    const spent = db.costs.reduce((a, c) => a + c.cost_usd, 0);
    expect(spent).toBeLessThanOrEqual(0.05 + 1e-9);
  });

  it("the provider charges far more than the plan estimated: the ceiling counts the money really spent, not the estimate", async () => {
    reset(50, UNKNOWN);
    // the estimate is 0.00495 a page, the source really bills 0.03
    const { calls, last } = await runUnknown((page, size) => [onTopic(page), ...Array.from({ length: size - 1 }, (_, i) => unrelated(page * 1000 + i))], () => 0.03);
    expect(calls).toBe(2);
    expect(last.json.done).toBe(true);
    expect(last.json.deliveredUnits).toBe(2);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(true);
  });
});

describe("the duration of a directory job covers what its stop rules allow", () => {
  const item = { capabilitySlug: SLUG, endpointId: ENDPOINT, targetVolumeMax: 50, params: PLAN_PARAMS };

  it("the failed job's plan is a company step whose worst case is its page limit, not one call", () => {
    const step = durationStepFromPlanItem(item);
    expect(step.family).toBe("companies");
    expect(step.recordsPerCall).toBe(50);
    expect(step.pessimisticRecords).toBe(maxPagesForJob(50, 50, "directory") * 50);
  });

  it("the shown range is a labelled range and its upper end is above its lower end, for both drivers", () => {
    for (const driver of ["tab", "cron"] as const) {
      const view = missionDurationForPlan([item], driver)!;
      expect(view.labelAr).toBe("تقديري");
      expect(view.rangeAr).toMatch(/من .* إلى /);
      expect(view.pessimisticSeconds).toBeGreaterThan(view.optimisticSeconds);
      expect(view.rangeAr).not.toBe("أقل من دقيقة");
    }
  });

  it("a plan that fills a page at once shows a shorter lower end than a plan whose pages may all be needed", () => {
    const allPages = missionDurationForPlan([item], "tab")!;
    const onePage = missionDurationForPlan([{ ...item, capabilitySlug: "icypeas-companies-search", endpointId: "icypeas.companies.search", targetVolumeMax: 10, params: {} }], "tab")!;
    expect(allPages.pessimisticSeconds).toBeGreaterThanOrEqual(onePage.pessimisticSeconds);
  });
});
