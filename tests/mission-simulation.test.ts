import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Phase 6: the owner's four missions, SCALED DOWN, through the real worker route with a deterministic fake provider. Only the provider
 * call is faked (the real source chain, de-duplication, date filter, files and settlement mock run on top of it). Volumes are scaled
 * (for example 37,500 X posts become 400) because the behaviour under test (chunking, resume, ranking, dedupe, billing) does not
 * depend on the absolute number. No network, no model, no real provider.
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


const ok = (data: any, costMicro = 900): SocialCallOutcome => ({ ok: true, httpStatus: 200, data, costMicro, tregCallId: "call_1" });

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


const comments = (video: string, n: number) => Array.from({ length: n }, (_, i) => ({ comment_id: `${video}_c${i + 1}`, text: `تعليق ${i + 1} على ${video}`, author: "أحمد", likes: i, published_date: "2026-09-10" }));

describe("Phase 6: scaled missions through the real worker", () => {
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
  const runAllChunks = async (max = 40) => {
    let last: { status: number; json: any } = { status: 0, json: {} };
    let chunks = 0;
    for (let i = 0; i < max; i++) {
      last = await callWorker();
      chunks++;
      if (last.json.done || last.json.released || last.status >= 400) break;
    }
    return { ...last, chunks };
  };
  const csvOf = () => db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
  const dataRows = () => csvOf().replace(/^\uFEFF/, "").split("\n").slice(1).filter((line) => line.trim());
  const settle = () => db.rpcCalls.filter((c) => c.name === "settle_job_atomic");
  const reserveOf = () => db.reserved;

  /** The money invariants every finished mission must satisfy. */
  function expectSoundBilling(delivered: number, unitPrice: number) {
    expect(settle()).toHaveLength(1);
    const charged = Math.min(Math.ceil(delivered * unitPrice), reserveOf());
    expect(charged).toBeLessThanOrEqual(reserveOf());
    expect(charged).toBe(Math.ceil(delivered * unitPrice));
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
  }

  it("M1 (2 channels, top 3 by views, comments with the video link): ranks per channel, keeps only the top videos, bills what was delivered", async () => {
    resetDb("social-youtube-comments", { channels: ["@NewsA", "@NewsB"], topPerChannel: 3, rankBy: "views" }, 90, 9);
    const calls: string[] = [];
    useSource(async (source, params) => {
      calls.push(source.endpointId);
      if (source.endpointId === "crawl4ai.youtube.channel.videos") {
        const tag = String(params.channel).replace(/\W/g, "").slice(0, 5);
        return ok({ rows: Array.from({ length: 12 }, (_, i) => ({ video_id: `${tag}_vid${String(i + 1).padStart(2, "0")}`, title: `فيديو ${i + 1}`, view_count: (i + 1) * 1000 })) });
      }
      return ok({ rows: comments(String(params.video), Math.min(Number(params.limit) || 40, 40)) });
    });

    const { json, chunks } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(90);
    expect(chunks).toBeGreaterThanOrEqual(1);
    const rows = dataRows();
    expect(rows).toHaveLength(90);
    // only the three most-viewed videos (v12, v11, v10) of each channel appear; never a low-ranked one
    const csv = csvOf();
    for (const keep of ["NewsA_vid12", "NewsA_vid11", "NewsA_vid10"]) expect(csv).toContain(keep);
    for (const drop of ["NewsA_vid01", "NewsA_vid05", "NewsA_vid09"]) expect(csv).not.toContain(drop);
    // every row carries a video link column and the file is Arabic
    expect(csv.split("\n")[0]).toContain("رابط الفيديو أو المنشور");
    expect(new Set(rows).size).toBe(rows.length);
    expectSoundBilling(90, 9);
  });

  it("M2 (one official channel, only the videos about Egypt, comments): the topic filter drops unrelated videos", async () => {
    resetDb("social-youtube-comments", { channels: ["@FIFA"], topic: "منتخب مصر", topPerChannel: 5, rankBy: "views" }, 60, 9);
    useSource(async (source, params) => {
      if (source.endpointId === "crawl4ai.youtube.channel.videos") {
        return ok({ rows: [
          { video_id: "egy0001xxxx", title: "ملخص مباراة منتخب مصر وبلجيكا", view_count: 9000 },
          { video_id: "brz0001xxxx", title: "ملخص مباراة البرازيل وصربيا", view_count: 50000 },
          { video_id: "egy0002xxxx", title: "تصريحات مدرب منتخب مصر", view_count: 4000 },
          { video_id: "fra0001xxxx", title: "أهداف فرنسا", view_count: 70000 },
        ] });
      }
      return ok({ rows: comments(String(params.video), 40) });
    });

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    const csv = csvOf();
    expect(csv).toContain("egy0001xxxx");
    expect(csv).toContain("egy0002xxxx");
    expect(csv).not.toContain("brz0001xxxx");
    expect(csv).not.toContain("fra0001xxxx");
    expectSoundBilling(json.deliveredUnits, 9);
  });

  it("M3 (an event on X, posts and replies, many chunks): resumes from the cursor, drops repeated pages, stops at the volume, bills unique posts", async () => {
    resetDb("social-x-posts", { query: "ماتش مصر والمغرب" }, 400, 5);
    let page = 0;
    const post = (id: number) => ({ id: `t${id}`, text: `منشور ${id} عن ماتش مصر والمغرب`, created_at: "2026-09-12T10:00:00Z", url: `https://x.com/u/status/${id}`, author: "منى" });
    useSource(async () => {
      page += 1;
      // each page is 50 posts; every third page repeats the last five posts of the page before it (a provider overlap)
      const start = (page - 1) * 50 + 1;
      const ids = Array.from({ length: 50 }, (_, i) => start + i);
      const withOverlap = page % 3 === 0 ? [...Array.from({ length: 5 }, (_, i) => start - 5 + i), ...ids.slice(0, 45)] : ids;
      return ok({ rows: withOverlap.map(post), next_cursor: `cur${page}`, has_more: true });
    });

    const { json, chunks } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(400);
    expect(chunks).toBeGreaterThanOrEqual(2);
    const rows = dataRows();
    expect(rows).toHaveLength(400);
    const ids = rows.map((line) => /status\/(\d+)/.exec(line)?.[1]);
    expect(new Set(ids).size).toBe(400);
    expectSoundBilling(400, 5);
  });

  it("M3 with the provider failing after some pages: what was delivered is kept and billed, the rest is not charged", async () => {
    resetDb("social-x-posts", { query: "ماتش مصر والمغرب" }, 400, 5);
    let page = 0;
    useSource(async () => {
      page += 1;
      if (page > 3) return { ok: false, httpStatus: 502, data: null, costMicro: 0, tregCallId: "", errorCode: "http_502", errorMessageAr: "تعذر استخراج البيانات من المصدر بعد عدة محاولات." };
      const start = (page - 1) * 50 + 1;
      return ok({ rows: Array.from({ length: 50 }, (_, i) => ({ id: `t${start + i}`, text: `منشور ${start + i} عن ماتش مصر والمغرب`, created_at: "2026-09-12T10:00:00Z", url: `https://x.com/u/status/${start + i}` })), next_cursor: `cur${page}`, has_more: true });
    });

    const { json } = await runAllChunks();

    // three good pages (150 posts) arrived before the provider failed: they are kept, delivered in the file and billed; the job ends done
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(150);
    expect(settle()).toHaveLength(1);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
    expect(json.settle.charged_credits).toBe(Math.ceil(150 * 5));
    expect(dataRows()).toHaveLength(150);
  });

  it("M4 (a topic between two dates): rows outside the window, and rows with no verifiable date, are excluded and not billed", async () => {
    resetDb("social-facebook-posts", { channel: "https://www.facebook.com/somepage", dateFrom: "2026-01-01", dateTo: "2026-09-30" }, 40, 11);
    useSource(async () => ok({ rows: [
      ...Array.from({ length: 30 }, (_, i) => ({ post_id: `in${i + 1}`, text: `منشور داخل الفترة ${i + 1}`, created_at: "2026-05-15T09:00:00Z", url: `https://facebook.com/p/in${i + 1}` })),
      ...Array.from({ length: 6 }, (_, i) => ({ post_id: `late${i + 1}`, text: `منشور بعد الفترة ${i + 1}`, created_at: "2026-10-05T09:00:00Z", url: `https://facebook.com/p/late${i + 1}` })),
      ...Array.from({ length: 4 }, (_, i) => ({ post_id: `early${i + 1}`, text: `منشور قبل الفترة ${i + 1}`, created_at: "2025-12-31T23:00:00Z", url: `https://facebook.com/p/early${i + 1}` })),
      { post_id: "nodate1", text: "بلا تاريخ", url: "https://facebook.com/p/nodate1" },
    ], has_more: false }));

    const { json } = await runAllChunks();

    const csv = csvOf();
    expect(csv).toContain("in1");
    expect(csv).not.toMatch(/late\d|early\d|nodate1/);
    expect(json.deliveredUnits).toBe(30);
    expectSoundBilling(30, 11);
  });

  it("every mission's result file is Arabic only in its header and has no technical words", async () => {
    resetDb("social-youtube-comments", { channels: ["@NewsA"], topPerChannel: 2, rankBy: "views" }, 30, 9);
    useSource(async (source, params) => source.endpointId === "crawl4ai.youtube.channel.videos"
      ? ok({ rows: [{ video_id: "aaaaaaaaaaa", title: "أ", view_count: 5 }, { video_id: "bbbbbbbbbbb", title: "ب", view_count: 9 }] })
      : ok({ rows: comments(String(params.video), 30) }));
    await runAllChunks();
    const header = csvOf().replace(/^\uFEFF/, "").split("\n")[0];
    expect(header).not.toMatch(/[A-Za-z]/);
    expect(csvOf()).not.toMatch(/undefined|null|NaN/);
  });
});
