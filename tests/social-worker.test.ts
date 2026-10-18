import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Social jobs through the real worker route: spec resolution, the provider spend estimate, de-duplication,
 * the Arabic result files and settlement. Only the provider call is faked (the real source chain runs on top of it).
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
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { estimateSocialChunkCostUsd, getSocialCapability } from "../src/lib/socialSources";

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
  db.step = 0;
  db.cursor = null;
  db.deliveredUnits = 0;
  db.targetVolumeMax = target;
  db.unitPrice = unitPrice;
  db.reserved = Math.ceil(target * unitPrice * 1.15);
}

describe("worker: social jobs", () => {
  let originalEnv: Record<string, string | undefined>;
  const spendEstimates: number[] = [];

  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "social-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    spendEstimates.length = 0;
  });

  afterEach(() => {
    setProviderAdapterForTesting(null);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete (process.env as any)[key];
      else (process.env as any)[key] = value;
    }
  });

  const useSource = (call: SocialCall) => setProviderAdapterForTesting(async (input: ProviderAdapterCallInput) => runSocialChunk(input, { call }));

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

  it("comments of a link: delivers 20, charges per delivered comment, and the files are Arabic with one clean sheet", async () => {
    resetDb("social-youtube-comments", { url: YT }, 20, 9);
    useSource(async () => ok({ ok: true, rows: comments(20, "a") }));

    const { status, json } = await runAllChunks();

    expect(status).toBe(200);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(20);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);

    // The provider spend reserved for the chunk covers its worst case through the approved function.
    const reserve = db.rpcCalls.find((c) => c.name === "reserve_provider_spend_atomic")!;
    expect(reserve.args.p_estimated_cost_usd).toBeCloseTo(estimateSocialChunkCostUsd(getSocialCapability("social-youtube-comments")!), 6);
    expect(db.rpcCalls.find((c) => c.name === "settle_job_atomic")!.args.p_job_id).toBe(JOB);

    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    const header = csv.replace(/^﻿/, "").split("\n")[0];
    expect(header).toContain("نص التعليق");
    expect(header).toContain("تاريخ ووقت النشر");
    expect(header).not.toMatch(/[A-Za-z]/);
    expect(csv.split("\n").filter((line) => line.includes("تعليق a"))).toHaveLength(20);

    const data = JSON.parse(db.partials.get(`${JOB}/data.json`)!.toString("utf-8"));
    expect(data.metadata.socialKind).toBe("comments");
    expect(data.metadata.title).toBe("تعليقات يوتيوب");
    expect(data.metadata.platform).toBe("youtube");
  });

  it("a provider that repeats a page does not deliver or bill the same comment twice (across chunks)", async () => {
    const VIDEO = "https://www.tiktok.com/@u/video/7231337071831321903";
    resetDb("social-tiktok-comments", { url: VIDEO }, 60, 6);
    const rowsOf = (ids: string[]) => ids.map((id) => ({ cid: id, text: `نص ${id}`, digg_count: 1 }));
    const range = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);
    const pages = [
      { data: { comments: rowsOf(range("a", 1, 20)), cursor: 20, has_more: 1 } },
      { data: { comments: rowsOf(range("a", 21, 50)), cursor: 50, has_more: 1 } },
      // The next chunk's first page overlaps the end of the previous one by five comments.
      { data: { comments: rowsOf([...range("a", 46, 50), ...range("b", 1, 5)]), cursor: 60, has_more: 0 } },
    ];
    let page = 0;
    useSource(async () => ok(pages[Math.min(page++, pages.length - 1)]));

    const first = await callWorker();
    expect(first.json.deliveredUnits).toBe(50);
    expect(first.json.done).toBe(false);
    const second = await callWorker();

    // Five repeats are dropped and not billed: 55 unique comments delivered.
    expect(second.json.deliveredUnits).toBe(55);
    expect(second.json.done).toBe(true);
    expect(db.rpcCalls.filter((c) => c.name === "complete_chunk").map((c) => c.args.p_new_delivered_units)).toEqual([50, 55]);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    expect(csv.split("\n").filter((line) => /(^|,)"نص a46"/.test(line) || line.includes('"نص a46"'))).toHaveLength(1);
    expect(csv.split("\n").filter((line) => line.includes('"نص b1"'))).toHaveLength(1);
  });

  it("videos and their comments across chunks: the second chunk resumes from the cursor and the file marks each video", async () => {
    resetDb("social-tiktok-comments", { trending: true, region: "EG", perVideo: 10 }, 70, 6);
    let discoveries = 0;
    useSource(async (source, params) => {
      if (source.endpointId === "scrapecreators.x.v1-tiktok-get-trending-feed") {
        discoveries += 1;
        return ok({ aweme_list: Array.from({ length: 8 }, (_, i) => ({ aweme_id: `72313370718313219${String(i).padStart(2, "0")}`, desc: `فيديو ${i + 1}`, share_url: `https://www.tiktok.com/@u/video/72313370718313219${String(i).padStart(2, "0")}` })) });
      }
      return ok({ data: { comments: Array.from({ length: 10 }, (_, i) => ({ cid: `${params.aweme_id}_${i}`, text: `تعليق ${i}`, user: { nickname: "منى", unique_id: "mona" }, digg_count: i, create_time: 1760000000 })), cursor: 10, has_more: 0 } });
    });

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(70);
    expect(discoveries).toBe(1);
    expect(db.rpcCalls.filter((c) => c.name === "complete_chunk")).toHaveLength(2);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    expect(csv).toContain("رابط الفيديو أو المنشور");
    expect(csv).toContain("2025-10-09");
    expect(csv.split("\n").filter((line) => line.includes("https://www.tiktok.com/@u/video/7231337071831321900"))).toHaveLength(10);
    const data = JSON.parse(db.partials.get(`${JOB}/data.json`)!.toString("utf-8"));
    expect(data.metadata.title).toBe("تعليقات تيك توك");
  });

  it("when every source fails the full reserve is released with a plain Arabic reason and nothing is settled", async () => {
    resetDb("social-youtube-comments", { url: YT }, 20, 9);
    useSource(async () => ({ ok: false, httpStatus: 502, data: null, costMicro: 0, tregCallId: "", errorCode: "http_502", errorMessageAr: "تعذر استخراج البيانات من المصدر بعد عدة محاولات." }));

    const { json } = await runAllChunks();

    expect(json.done).not.toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    const release = db.rpcCalls.find((c) => c.name === "release_job_atomic");
    expect(release).toBeDefined();
    // The reason is the provider failure, in plain Arabic (not the empty-result reason).
    expect(String(release!.args.p_error_message)).toContain("تعذر استخراج البيانات من المصدر");
    expect(String(release!.args.p_error_message)).not.toMatch(/[A-Za-z]/);
    expect(String(release!.args.p_error_message)).not.toContain("لم يُعثر على أي بيانات مطابقة");
  });

  it("a valid empty answer from every source releases with the no-matching-data reason", async () => {
    resetDb("social-youtube-comments", { url: YT }, 20, 9);
    useSource(async () => ok({ rows: [] }));
    await runAllChunks();
    const release = db.rpcCalls.find((c) => c.name === "release_job_atomic");
    expect(release).toBeDefined();
    expect(String(release!.args.p_error_message)).toContain("لم يُعثر على أي بيانات مطابقة");
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
  });
});
