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
import { runSocialChunk, type SocialCall, type SocialCallOutcome } from "../src/lib/server/socialAdapter";
import { estimateSocialChunkCostUsd, getSocialCapability } from "../src/lib/socialSources";
import { setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import ExcelJS from "exceljs";
import { UNREVIEWED_SHEET_NOTICE_AR } from "../src/functions/shared/fileGenerators";
import { isCustomerVisibleJobEvent } from "../src/lib/reviewCostEvent";
import { setReviewDailyGuardForTesting } from "../src/lib/server/reviewDailyGuard";
import { replySampleOf, setRowAdvisorForTesting, setStrictSocialReviewForTesting, UNREVIEWED_BY_BUDGET_REASON_AR, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";

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
  describe("X with a time window", () => {
    const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const later = (n: number) => Array.from({ length: n }, (_, i) => ({ tweet_id: `later${i}`, text: `منشور ${i}`, createdUtc: secs("2026-10-12T07:00:00Z") + i * 3600 }));

    it("every row later than the window: the date operators are sent, each page says why, the sentence is plain, paging stops by the empty-page rule and nothing is charged", async () => {
      resetDb("social-x-posts", { query: "مباراة مصر والمغرب كأس العالم", dateFrom: "2026-06-11", dateTo: "2026-07-19" }, 50, 5);
      const sent: Array<Record<string, any>> = [];
      let n = 0;
      useSource(async (_source, params) => {
        sent.push(params);
        n++;
        return ok({ ok: true, rows: later(20), next_cursor: `cur_${n}` }, 600);
      });

      const { json } = await runAllChunks();

      expect(sent.length).toBeGreaterThan(0);
      for (const params of sent) expect(params.query).toBe("مباراة مصر والمغرب كأس العالم since:2026-06-11 until:2026-07-20");
      expect(sent).toHaveLength(3);
      const lines = db.events.map((event) => String(event.message));
      const pageLines = lines.filter((line) => line.includes("تم استبعاد ٢٠ سجل من هذه الصفحة"));
      expect(pageLines).toHaveLength(3);
      expect(pageLines[0]).toContain("٢٠ خارج الفترة المطلوبة");
      expect(pageLines[0]).toContain("أقدم تاريخ نشر ٢٠٢٦-١٠-١٢");
      expect(pageLines[0]).toContain("المصدر أعاد منشورات خارج الفترة التي حددتها");
      const release = db.rpcCalls.find((c) => c.name === "release_job_atomic");
      expect(release).toBeDefined();
      expect(String(release!.args.p_error_message)).toContain("المصدر أعاد منشورات خارج الفترة التي حددتها");
      expect(String(release!.args.p_error_message)).toContain("تم استرداد كامل الرصيد المحجوز دون أي خصم");
      expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
      expect(json.released).toBe(true);
      // The step file of a page that ended the chunk keeps at most three dates, never row content.
      const stepFile = JSON.parse(db.partials.get(`${JOB}/step_0.json`)!.toString("utf-8"));
      expect(stepFile.dateWindow).toEqual({ missing: 0, outside: 20, inside: 0, oldest: "2026-10-12", newest: "2026-10-13", sampleDates: ["2026-10-12", "2026-10-12", "2026-10-12"] });
    });

    it("a request that names a country sends the country's words with the topic and the date operators, on every page", async () => {
      resetDb("social-x-posts", { query: "كرة السلة", region: "EG", dateFrom: "2026-06-11", dateTo: "2026-07-19" }, 20, 5);
      const sent: Array<Record<string, any>> = [];
      useSource(async (_source, params) => {
        sent.push(params);
        return ok({ ok: true, rows: Array.from({ length: 20 }, (_, i) => ({ tweet_id: `eg${i}`, text: `كرة السلة ${i} مصر`, createdUtc: secs("2026-06-20T10:00:00Z") + i })) }, 600);
      });

      await runAllChunks();

      expect(sent.length).toBeGreaterThan(0);
      for (const params of sent) expect(params.query).toBe("كرة السلة (مصر OR مصري OR مصرية OR المصري OR المصرية OR egypt OR egyptian) since:2026-06-11 until:2026-07-20");
    });

    it("rows inside the window are delivered and charged as usual", async () => {
      resetDb("social-x-posts", { query: "كأس العالم", dateFrom: "2026-06-11", dateTo: "2026-07-19" }, 20, 5);
      useSource(async () => ok({ ok: true, rows: Array.from({ length: 20 }, (_, i) => ({ tweet_id: `in${i}`, text: `كأس العالم ${i}`, createdUtc: secs("2026-06-20T10:00:00Z") + i })) }, 600));

      await runAllChunks();

      expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
      const settle = db.rpcCalls.find((c) => c.name === "settle_job_atomic");
      expect(settle).toBeDefined();
      expect(db.events.some((event) => String(event.message).includes("وكلها داخل الفترة المطلوبة"))).toBe(true);
    });
  });
  describe("TikTok comments with a time window", () => {
    const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const WINDOW = { dateFrom: "2026-09-20", dateTo: "2026-10-20" };
    const VIDEO_ID = "7231337071831321900";
    type CommentSpec = { time?: string; text?: string };
    const runCommentsJob = async (opts: { videoTime?: string; videoDesc?: string; comments: CommentSpec[]; target?: number }) => {
      resetDb("social-tiktok-comments", { query: "كرة القدم", region: "EG", perVideo: 30, ...WINDOW }, opts.target ?? 30, 6);
      useSource(async (_source, params) => {
        if (params.aweme_id) {
          return ok({ data: { comments: opts.comments.map((c, i) => ({ cid: `c${i}`, text: c.text ?? `هدف رائع في مباراة كرة القدم ${i}`, user: { nickname: "منى", unique_id: "mona" }, digg_count: i, ...(c.time ? { create_time: secs(c.time) } : {}) })), cursor: 0, has_more: 0 } });
        }
        return ok({ aweme_list: [{ aweme_id: VIDEO_ID, desc: opts.videoDesc ?? "فيديو عن كرة القدم", share_url: `https://www.tiktok.com/@u/video/${VIDEO_ID}`, ...(opts.videoTime ? { create_time: secs(opts.videoTime) } : {}) }] });
      });
      return runAllChunks();
    };
    const lines = () => db.events.map((event) => String(event.message));
    const dateLines = () => lines().filter((line) => line.includes("من هذه الصفحة"));

    it("judges each comment by its own time, never by the video's: old video, recent comments are delivered", async () => {
      const { json } = await runCommentsJob({ videoTime: "2026-04-01T10:00:00Z", comments: Array.from({ length: 5 }, (_, i) => ({ time: `2026-10-0${i + 1}T10:00:00Z` })) });
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(5);
      expect(dateLines()[0]).toContain("وكلها داخل الفترة المطلوبة");
      expect(dateLines()[0]).toContain("أقدم تاريخ نشر ٢٠٢٦-١٠-٠١ وأحدث تاريخ ٢٠٢٦-١٠-٠٥");
      expect(lines().some((line) => line.includes("المصدر لا يعرض تاريخ كتابة التعليقات"))).toBe(false);
    });

    it("comments whose own time is outside the window are dropped, and the line never claims they are inside", async () => {
      const comments: CommentSpec[] = [
        ...Array.from({ length: 3 }, (_, i) => ({ time: `2026-10-1${i}T10:00:00Z` })),
        ...Array.from({ length: 4 }, (_, i) => ({ time: `2026-0${4 + i}-01T10:00:00Z` })),
      ];
      const { json } = await runCommentsJob({ videoTime: "2026-10-05T10:00:00Z", comments });
      expect(json.deliveredUnits).toBe(3);
      const line = dateLines()[0];
      expect(line).toContain("تم استبعاد ٤ سجل من هذه الصفحة بسبب التاريخ: ٤ خارج الفترة المطلوبة");
      expect(line).toContain("وبقي ٣ داخلها");
      expect(line).not.toContain("وكلها داخل");
    });

    it("all comments outside the window: the line says so and the reason says the same, not the topic", async () => {
      await runCommentsJob({ videoTime: "2026-10-05T10:00:00Z", comments: Array.from({ length: 6 }, (_, i) => ({ time: `2026-0${3 + (i % 4)}-15T10:00:00Z` })) });
      expect(dateLines()[0]).toContain("٦ خارج الفترة المطلوبة");
      expect(dateLines()[0]).toContain("المصدر أعاد منشورات خارج الفترة التي حددتها");
      expect(dateLines()[0]).not.toContain("وكلها داخل");
      const release = db.rpcCalls.find((c) => c.name === "release_job_atomic");
      expect(String(release!.args.p_error_message)).toContain("المصدر أعاد منشورات خارج الفترة التي حددتها");
    });

    it("no comment has a date of its own: the window is applied to the video's date, plainly said, and nothing internal is delivered", async () => {
      const { json } = await runCommentsJob({ videoTime: "2026-10-05T10:00:00Z", comments: Array.from({ length: 5 }, () => ({})) });
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(5);
      expect(dateLines()[0]).toContain("المصدر لا يعرض تاريخ كتابة التعليقات، فطبّقنا الفترة المطلوبة على تاريخ نشر الفيديو الذي كُتبت عليه (٥ تعليق)");
      const stored = [...db.partials.entries()].map(([, v]) => v.toString("utf-8")).join("\n");
      expect(stored).not.toContain("_date_basis");
      expect(stored).not.toContain("_video_published_at");
      expect(db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8")).not.toContain("_date_basis");
    });

    it("no comment date and the video itself is outside the window: nothing is delivered, said in plain Arabic, full release", async () => {
      await runCommentsJob({ videoTime: "2026-04-01T10:00:00Z", comments: Array.from({ length: 5 }, () => ({})) });
      expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
      expect(dateLines()[0]).toContain("٥ خارج الفترة المطلوبة");
      expect(dateLines()[0]).toContain("المصدر لا يعرض تاريخ كتابة التعليقات");
      expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(true);
    });

    it("no date anywhere (neither comments nor video): rows are excluded as undated and said so, never reported inside", async () => {
      await runCommentsJob({ comments: Array.from({ length: 4 }, () => ({})) });
      expect(dateLines()[0]).toContain("٤ بلا تاريخ نشر يمكن التحقق منه");
      expect(dateLines()[0]).not.toContain("وكلها داخل");
      expect(dateLines()[0]).toContain("لم يظهر تاريخ نشر في أي سجل");
    });

    it("dates are fine but no comment has any content (emoji only): the reason names the topic, not the scope or the dates", async () => {
      await runCommentsJob({ videoTime: "2026-10-05T10:00:00Z", videoDesc: "فيديو عام", comments: Array.from({ length: 6 }, (_, i) => ({ time: `2026-10-0${i + 1}T10:00:00Z`, text: "😂😂" })) });
      const release = db.rpcCalls.find((c) => c.name === "release_job_atomic");
      const reason = String(release!.args.p_error_message);
      expect(reason).toContain("وتواريخها داخل الفترة التي حددتها، لكن لم يتحقق في أيٍّ منها موضوع طلبك");
      expect(reason).not.toContain("نطاق طلبك");
      expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    });

    it("short real comments of a topic search are delivered even though they do not repeat the topic words", async () => {
      const { json } = await runCommentsJob({ videoTime: "2026-10-05T10:00:00Z", videoDesc: "فيديو عام", comments: ["ماتش حلو", "الأهلي أحسن", "جامد اوي", "هدف رائع", "بالتوفيق للمنتخب"].map((text, i) => ({ time: `2026-10-0${i + 1}T10:00:00Z`, text })) });
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(5);
      expect(json.settle.charged_credits).toBe(5 * 6);
    });
  });
  describe("TikTok comments by topic in a country: the videos are judged, then the comments of the selected videos are delivered", () => {
    const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    const VIDEOS = {
      onTopic: { id: "7231337071831321901", desc: "مباراة الأهلي والزمالك في الدوري المصري #كرة_القدم" },
      realMadrid: { id: "7231337071831321902", desc: "Real Madrid vs Barcelona highlights goal match #football" },
      noDescription: { id: "7231337071831321903", desc: "" },
    };
    const ON_TOPIC_COMMENTS = ["افتح التنزيل عليك الله", "حلو قوي", "😂😂", "للتواصل واتساب 01012345678 خصم خاص", "حلو قوي", "اتفقت"];
    const usage = (costUsd: number) => ({ inputTokens: 1500, outputTokens: 300, costUsd, model: "claude-haiku-5-5", latencyMs: 20 });
    const lines = () => db.events.map((event) => String(event.message));
    const csv = () => db.results.get(`user_1/${JOB}/result.csv`)?.toString("utf-8") ?? "";
    type Asked = { kind: string; customerRequest: string; rows: Array<{ index: number; row: Record<string, any> }> };

    const run = async (opts: { videos: Array<{ id: string; desc: string }>; comments: Record<string, string[]>; verdict?: (row: Record<string, any>) => "match" | "no_match" | "uncertain" | "missing"; target?: number }) => {
      resetDb("social-tiktok-comments", { query: "كرة القدم", region: "EG", perVideo: 30, dateFrom: "2026-09-20", dateTo: "2026-10-20" }, opts.target ?? 30, 6);
      const searchParams: Array<Record<string, any>> = [];
      useSource(async (_source, params) => {
        if (params.aweme_id) {
          const texts = opts.comments[String(params.aweme_id)] ?? [];
          return ok({ data: { comments: texts.map((text, i) => ({ cid: `${params.aweme_id}_${i}`, text, user: { nickname: "منى" }, create_time: secs("2026-10-05T10:00:00Z") })), cursor: 0, has_more: 0 } });
        }
        searchParams.push(params);
        return ok({ aweme_list: opts.videos.map((video) => ({ aweme_id: video.id, desc: video.desc, share_url: `https://www.tiktok.com/@u/video/${video.id}`, create_time: secs("2026-10-05T10:00:00Z") })) });
      });
      const asked: Asked[] = [];
      setStrictSocialReviewForTesting(true);
      setRowAdvisorForTesting(async (input) => {
        asked.push({ kind: input.kind, customerRequest: input.customerRequest, rows: input.rows });
        return {
          verdicts: new Map(input.rows.flatMap(({ index, row }) => {
            const v = (opts.verdict ?? ((r: Record<string, any>) => (/real madrid/i.test(String(r.title)) ? "no_match" : "match")))(row);
            return v === "missing" ? [] : [[index, { verdict: v, reasonAr: v === "no_match" ? "الفيديو عن نادٍ من دولة أخرى" : "عن كرة القدم في مصر" }]];
          })),
          usage: usage(0.003), failure: null,
        };
      });
      const result = await runAllChunks();
      return { ...result, searchParams, asked };
    };

    it("an on-topic video: its short, unrelated-looking comments are delivered; only the emoji, the ad and the duplicate are not, and no review call is needed", async () => {
      const { json, asked, searchParams } = await run({ videos: [VIDEOS.onTopic], comments: { [VIDEOS.onTopic.id]: ON_TOPIC_COMMENTS } });
      expect(searchParams[0].region).toBe("EG");
      expect(asked).toHaveLength(0);
      expect(json.deliveredUnits).toBe(3);
      expect(json.settle.charged_credits).toBe(3 * 6);
      const delivered = csv();
      for (const text of ["افتح التنزيل عليك الله", "حلو قوي", "اتفقت"]) expect(delivered).toContain(text);
      expect(delivered).not.toContain("😂");
      expect(delivered).not.toContain("واتساب");
      expect(delivered.split("حلو قوي").length - 1).toBe(1);
    });

    it("an off-topic video (Real Madrid highlights when Egypt was requested) is excluded with a plain Arabic reason; the on-topic one is delivered", async () => {
      const { json, asked } = await run({
        videos: [VIDEOS.realMadrid, VIDEOS.onTopic],
        comments: { [VIDEOS.realMadrid.id]: ["When Madrid was Madrid", "هلا مدريد", "سوي العراق ضد اليابان"], [VIDEOS.onTopic.id]: ["حلو قوي", "افتح التنزيل عليك الله"] },
      });
      expect(asked).toHaveLength(1);
      expect(asked[0].kind).toBe("social-tiktok-comments-video-list");
      expect(asked[0].customerRequest).toContain("الدولة المطلوبة: مصر");
      expect(asked[0].rows).toHaveLength(1);
      expect(String(asked[0].rows[0].row.title)).toContain("Real Madrid");
      expect(json.deliveredUnits).toBe(2);
      expect(json.settle.charged_credits).toBe(2 * 6);
      const delivered = csv();
      expect(delivered).not.toContain("هلا مدريد");
      expect(delivered).not.toContain("العراق ضد اليابان");
      const line = lines().find((entry) => entry.includes("راجعنا فيديوهات هذه الصفحة"))!;
      expect(line).toContain("اعتمدنا ١ فيديو");
      expect(line).toContain("واستبعدنا ١ لأنها لا تتناول موضوعك (الفيديو عن نادٍ من دولة أخرى)");
      expect(line).not.toMatch(/[A-Za-z]/);
    });

    it("every video is off topic: nothing is delivered or charged, and the full reserve is released", async () => {
      const { json } = await run({ videos: [VIDEOS.realMadrid], comments: { [VIDEOS.realMadrid.id]: ["When Madrid was Madrid", "هلا مدريد"] } });
      expect(json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
    });

    it("a video with no description is decided by the review, which sees its channel and a few of its comments", async () => {
      const { json, asked } = await run({
        videos: [VIDEOS.noDescription],
        comments: { [VIDEOS.noDescription.id]: ["ماتش الأهلي كان جامد", "حلو قوي", "برافو يا شباب"] },
        verdict: () => "match",
      });
      expect(asked).toHaveLength(1);
      expect(String(asked[0].rows[0].row.comments_sample)).toContain("ماتش الأهلي كان جامد");
      expect(json.deliveredUnits).toBe(3);
      expect(json.settle.charged_credits).toBe(3 * 6);
    });

    it("a video the review doubts, or that nobody could review, is not delivered (fail closed) and is not charged", async () => {
      const doubtful = await run({ videos: [VIDEOS.noDescription], comments: { [VIDEOS.noDescription.id]: ["حلو قوي", "برافو"] }, verdict: () => "uncertain" });
      expect(doubtful.json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      const silent = await run({ videos: [VIDEOS.noDescription], comments: { [VIDEOS.noDescription.id]: ["حلو قوي", "برافو"] }, verdict: () => "missing" });
      expect(silent.json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
    });

    it("videos whose own text shows the topic and the country are read first", async () => {
      const calls: string[] = [];
      resetDb("social-tiktok-comments", { query: "كرة القدم", region: "EG", perVideo: 30, dateFrom: "2026-09-20", dateTo: "2026-10-20" }, 30, 6);
      useSource(async (_source, params) => {
        if (params.aweme_id) { calls.push(String(params.aweme_id)); return ok({ data: { comments: [], cursor: 0, has_more: 0 } }); }
        return ok({ aweme_list: [VIDEOS.realMadrid, VIDEOS.noDescription, VIDEOS.onTopic].map((video) => ({ aweme_id: video.id, desc: video.desc, share_url: `https://www.tiktok.com/@u/video/${video.id}`, create_time: secs("2026-10-05T10:00:00Z") })) });
      });
      await runAllChunks();
      expect(calls[0]).toBe(VIDEOS.onTopic.id);
    });
  });
  describe("X posts of a topic search: the rows are presumed on topic, and the doubtful ones need the automatic review", () => {
    const TOPIC = "مباراة مصر والمغرب كأس العالم";
    const ordinary = (n: number) => Array.from({ length: n }, (_, i) => ({ tweet_id: `p${i}`, text: `منشور ${i} عن ${TOPIC} في البطولة` }));
    // Doubtful rows that reach the review: no word of the topic, but they name the requested country (a row with neither is excluded by code first).
    const reactions = (n: number) => Array.from({ length: n }, (_, i) => ({ tweet_id: `r${i}`, text: i % 2 ? "اتفقت يا مصر" : "اتفقت تماما يا مصر", is_reply: true }));
    const EGYPT_TOPIC = { query: TOPIC, region: "EG" };
    const usage = (costUsd: number) => ({ inputTokens: 2000, outputTokens: 500, costUsd, model: "claude-haiku-5-5", latencyMs: 20 });
    const strict = (advisor: RowAdvisorFn) => { setStrictSocialReviewForTesting(true); setRowAdvisorForTesting(advisor); };
    const lines = () => db.events.map((event) => String(event.message));

    it("ordinary rows are delivered (every row is checked); a doubtful one is delivered only when the review confirms it", async () => {
      resetDb("social-x-posts", EGYPT_TOPIC, 10, 5);
      const philosophical = { tweet_id: "f1", text: "الحياة في مصر رحلة طويلة والإنسان يبحث دائماً عن معنى لوجوده في هذا الكون الواسع" };
      useSource(async () => ok({ ok: true, rows: [...ordinary(8), philosophical, reactions(1)[0]] }, 600));
      const asked: Array<Array<{ index: number }>> = [];
      strict(async (input) => {
        asked.push(input.rows.map(({ index }) => ({ index })));
        return {
          verdicts: new Map(input.rows.map(({ index, row }) => [index, row.tweet_id === "f1" ? { verdict: "no_match" as const, reasonAr: "منشور فلسفي لا يتناول المباراة" } : { verdict: "match" as const, reasonAr: "رد على المباراة" }])),
          usage: usage(0.004), failure: null,
        };
      });

      const { json } = await runAllChunks();

      expect(json.done).toBe(true);
      // one call covers every row of the page: the two doubtful rows and the eight ordinary ones
      expect(asked).toHaveLength(1);
      expect(asked[0]).toHaveLength(10);
      expect(json.deliveredUnits).toBe(9);
      // charge = delivered matching rows x unit price (the settlement function, unchanged)
      expect(json.settle.charged_credits).toBe(9 * 5);
      expect(lines().some((line) => line.includes("قيد المراجعة ١"))).toBe(true);
    });

    it("a page of 30 ordinary rows is checked in full, in two calls (25 rows and 5), and delivered", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 30, 5);
      useSource(async () => ok({ ok: true, rows: ordinary(30) }, 600));
      const asked: number[] = [];
      strict(async (input) => { asked.push(input.rows.length); return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "يتناول المباراة" }])), usage: usage(0.004), failure: null }; });
      const { json } = await runAllChunks();
      expect(asked).toEqual([25, 5]);
      expect(json.deliveredUnits).toBe(30);
    });

    it("a review that cannot be read (after the one retry) holds the whole page back: nothing is delivered on the gate alone, the reserve is released and nothing is charged", async () => {
      resetDb("social-x-posts", EGYPT_TOPIC, 10, 5);
      useSource(async () => ok({ ok: true, rows: [...ordinary(6), ...reactions(4)] }, 600));
      let calls = 0;
      strict(async () => { calls += 1; return { verdicts: new Map(), usage: usage(0.002), failure: "bad_reply", stopReason: "max_tokens" }; });

      const { json } = await runAllChunks();

      expect(calls).toBe(2);
      expect(json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      expect(lines().some((line) => line.includes("تعذّر التحقق الآلي من ملاءمة ١٠ سجل"))).toBe(true);
    });

    it("a review that times out delivers nothing: the job never delivers a row it could not check", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      useSource(async () => ok({ ok: true, rows: ordinary(10) }, 600));
      let calls = 0;
      strict(async () => { calls += 1; return { verdicts: new Map(), usage: null, failure: "timeout" }; });

      const { json } = await runAllChunks();

      expect(calls).toBe(2);
      expect(json.released).toBe(true);
      expect(json.deliveredUnits ?? 0).toBe(0);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      expect(db.rpcCalls.some((call) => call.name === "release_job_atomic")).toBe(true);
    });

    it("a timeout on the first try and good answers on the retry: the page is delivered and charged per delivered row, and the retry is not the same request", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      useSource(async () => ok({ ok: true, rows: ordinary(10) }, 600));
      const seen: Array<{ rows: number; maxTokens: number | undefined }> = [];
      strict(async (input) => {
        seen.push({ rows: input.rows.length, maxTokens: input.maxTokens });
        if (seen.length === 1) return { verdicts: new Map(), usage: null, failure: "timeout" };
        return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "يتناول المباراة" }])), usage: usage(0.004), failure: null };
      });

      const { json } = await runAllChunks();

      // the first call (10 rows) timed out; the retry covers the same rows in two calls of 5 with more room
      expect(seen).toEqual([{ rows: 10, maxTokens: undefined }, { rows: 5, maxTokens: 6000 }, { rows: 5, maxTokens: 6000 }]);
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(10);
      expect(json.settle.charged_credits).toBe(10 * 5);
    });

    it("when nothing on the page could be delivered without the review and the review fails, the reserve is released and paging stops", async () => {
      resetDb("social-x-posts", EGYPT_TOPIC, 10, 5);
      let providerCalls = 0;
      useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: reactions(10), next_cursor: `c${providerCalls}` }, 600); });
      strict(async () => ({ verdicts: new Map(), usage: usage(0.002), failure: "bad_reply" }));

      const { json } = await runAllChunks();

      expect(json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      expect(providerCalls).toBe(1);
    });

    it("the review's budget per job is capped: rows past it are not delivered, go to the «غير مراجَع» sheet, and it is said plainly", async () => {
      resetDb("social-x-posts", EGYPT_TOPIC, 30, 5);
      useSource(async () => ok({ ok: true, rows: reactions(30) }, 600));
      strict(async (input) => ({ verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "رد على المباراة" }])), usage: usage(0.06), failure: null }));

      const { json } = await runAllChunks();

      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(25);
      expect(json.settle.charged_credits).toBe(25 * 5);
      expect(lines().some((line) => line.includes("وصل التحقق الآلي إلى الحد المسموح لهذا الطلب؛ وُضع ٥ سجل في ورقة «غير مراجَع» ولم يُحتسب"))).toBe(true);
    });

    it("an empty post, an emoji and an ad are dropped before anything else", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      const rows = [...ordinary(3), { tweet_id: "e1", text: "" }, { tweet_id: "e2", text: "😂😂" }, { tweet_id: "ad", text: "للتواصل واتساب 01012345678 خصم خاص" }];
      useSource(async () => ok({ ok: true, rows }, 600));
      const asked: number[][] = [];
      strict(async (input) => { asked.push(input.rows.map(({ index }) => index)); return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "يتناول المباراة" }])), usage: usage(0.003), failure: null }; });

      const { json } = await runAllChunks();

      expect(json.deliveredUnits).toBe(3);
      // only the three ordinary rows were ever shown to the reviewer: the empty, the emoji and the ad were dropped before
      expect(asked).toHaveLength(1);
      expect(asked[0]).toHaveLength(3);
    });

    it("what every review call did is kept in the step file: failure code, stop reason and tokens", async () => {
      resetDb("social-x-posts", EGYPT_TOPIC, 30, 5);
      let page = 0;
      useSource(async () => { page += 1; return ok({ ok: true, rows: page === 1 ? [...ordinary(2), ...reactions(2)] : [], next_cursor: page === 1 ? "next" : undefined }, 600); });
      // a reply cut in the middle: the verdicts it did carry (the ordinary rows) are kept, the rest has none; with no verdict at all the page would be held back and the job released
      const seen: Array<{ rows: number; maxTokens: number | undefined }> = [];
      strict(async (input) => {
        seen.push({ rows: input.rows.length, maxTokens: input.maxTokens });
        return { verdicts: new Map(input.rows.filter(({ row }) => String(row.tweet_id).startsWith("p")).map(({ index }) => [index, { verdict: "match" as const, reasonAr: "يتناول المباراة" }])), usage: { inputTokens: 900, outputTokens: 1200, costUsd: 0.003, model: "claude-haiku-5-5", latencyMs: 40 }, failure: "bad_reply", stopReason: "max_tokens", detail: "reply_chars=3100" };
      });

      await callWorker();

      const stepFile = JSON.parse(db.partials.get(`${JOB}/step_0.json`)!.toString("utf-8"));
      // the cut reply kept the two verdicts it carried; only the two rows without one are asked again (a smaller call, more room), and that retry fails the same way
      expect(seen).toEqual([{ rows: 4, maxTokens: undefined }, { rows: 2, maxTokens: 6000 }]);
      expect(stepFile.reviewFailures).toEqual(["bad_reply", "bad_reply"]);
      expect(stepFile.reviewCalls).toEqual([
        { rows: 4, failure: "bad_reply", stopReason: "max_tokens", detail: "reply_chars=3100", tokensIn: 900, tokensOut: 1200, latencyMs: 40 },
        { rows: 2, failure: "bad_reply", stopReason: "max_tokens", detail: "reply_chars=3100", tokensIn: 900, tokensOut: 1200, latencyMs: 40 },
      ]);
      expect(stepFile.reviewUsd).toBe(0.006);
    });

    describe("a review reply that is cut off (the 21 Oct 2026 failure): the complete verdicts are kept, only the missing rows are asked again, and the failure is recorded for the owner", () => {
      const internalFailures = () => db.events.filter((event) => event.event_type === "review_failure").map((event) => String(event.message));
      const customerLines = () => db.events.filter((event) => isCustomerVisibleJobEvent(event.event_type)).map((event) => String(event.message));
      const cutUsage = { inputTokens: 3325, outputTokens: 4000, costUsd: 0.0107, model: "claude-haiku-5-5", latencyMs: 9000 };
      type Seen = { indexes: number[]; maxTokens: number | undefined };
      /** The first call answers its first `answered` rows (a reply cut at the limit); a retry answers its first `answeredOnRetry` rows. */
      const cutReviewer = (answered: number, answeredOnRetry: number, seen: Seen[]): RowAdvisorFn => async (input) => {
        seen.push({ indexes: input.rows.map(({ index }) => index), maxTokens: input.maxTokens });
        const first = seen.length === 1;
        const rows = input.rows.slice(0, first ? answered : answeredOnRetry);
        return {
          verdicts: new Map(rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "مطابق لموضوع الطلب" }])),
          usage: cutUsage, failure: null, stopReason: first || rows.length < input.rows.length ? "max_tokens" : "end_turn", replyChars: first ? 2840 : 500,
        };
      };

      it("12 of 20 verdicts in the first reply: the 8 missing rows are asked again (one call, more room), all 20 are delivered and charged, and the owner's row says what was cut", async () => {
        resetDb("social-x-posts", { query: TOPIC }, 20, 5);
        useSource(async () => ok({ ok: true, rows: ordinary(20) }, 600));
        const seen: Seen[] = [];
        strict(cutReviewer(12, 99, seen));

        const { json } = await runAllChunks();

        expect(seen).toEqual([{ indexes: Array.from({ length: 20 }, (_, i) => i), maxTokens: undefined }, { indexes: [12, 13, 14, 15, 16, 17, 18, 19], maxTokens: 6000 }]);
        expect(json.done).toBe(true);
        expect(json.deliveredUnits).toBe(20);
        expect(json.settle.charged_credits).toBe(20 * 5);
        expect(internalFailures()).toEqual(["review_failure step=0 call=1 retry=0 rows=20 code=none stop=max_tokens in=3325 out=4000 max_tokens=4000 reply_chars=2840 missing=8"]);
        expect(db.events.filter((event) => event.event_type === "review_cost").map((event) => String(event.message))[0]).toContain("calls=2");
        expect(customerLines().some((line) => line.includes("review_failure") || line.includes("max_tokens"))).toBe(false);
      });

      it("the retry leaves 3 rows without a verdict: 17 are delivered and charged, the 3 are held (not delivered, not charged) in the «ورقة المراجعة», in Arabic, and no delivered row lacks a verdict", async () => {
        resetDb("social-x-posts", { query: TOPIC }, 20, 5);
        useSource(async () => ok({ ok: true, rows: ordinary(20) }, 600));
        const seen: Seen[] = [];
        strict(cutReviewer(12, 5, seen));

        const { json } = await runAllChunks();

        expect(seen.map((call) => call.indexes.length)).toEqual([20, 8]);
        expect(json.done).toBe(true);
        // 12 + 5 verdicts = 17 delivered; the 3 rows with none are not part of the delivered count or the charge
        expect(json.deliveredUnits).toBe(17);
        expect(json.settle.charged_credits).toBe(17 * 5);
        expect(customerLines()).toContain("تعذّر التحقق الآلي من ملاءمة ٣ سجل الآن؛ وُضعت في ورقة المراجعة ولم تُحتسب.");
        for (const line of customerLines()) expect(line).not.toContain("شيت");
        expect(internalFailures()).toEqual([
          "review_failure step=0 call=1 retry=0 rows=20 code=none stop=max_tokens in=3325 out=4000 max_tokens=4000 reply_chars=2840 missing=8",
          "review_failure step=0 call=2 retry=1 rows=8 code=none stop=max_tokens in=3325 out=4000 max_tokens=6000 reply_chars=500 missing=3",
        ]);
      });

      it("the reviewer answers nothing readable twice (the failure of 21 Oct): the job is released, nothing is delivered or charged, both calls are recorded, and the customer line says «ورقة المراجعة»", async () => {
        resetDb("social-x-posts", { query: TOPIC }, 20, 5);
        useSource(async () => ok({ ok: true, rows: ordinary(20) }, 600));
        const seen: Seen[] = [];
        strict(async (input) => {
          seen.push({ indexes: input.rows.map(({ index }) => index), maxTokens: input.maxTokens });
          return { verdicts: new Map(), usage: cutUsage, failure: "bad_reply", stopReason: "max_tokens", detail: "reply_chars=9120", replyChars: 9120 };
        });

        const { json } = await runAllChunks();

        expect(seen.map((call) => [call.indexes.length, call.maxTokens])).toEqual([[20, undefined], [10, 6000]]);
        expect(json.released).toBe(true);
        expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
        expect(customerLines()).toContain("تعذّر التحقق الآلي من ملاءمة ٢٠ سجل الآن؛ وُضعت في ورقة المراجعة ولم تُحتسب.");
        expect(internalFailures()).toEqual([
          "review_failure step=0 call=1 retry=0 rows=20 code=bad_reply stop=max_tokens in=3325 out=4000 max_tokens=4000 reply_chars=9120 missing=20",
          "review_failure step=0 call=2 retry=1 rows=10 code=bad_reply stop=max_tokens in=3325 out=4000 max_tokens=6000 reply_chars=9120 missing=10",
        ]);
      });
    });

    describe("the review cost cut: one call per page, early rejection of a long page, the low-yield stop, the «غير مراجَع» sheet and the review spend row", () => {
      /** Page `page` of `n` ordinary posts (each names the topic, so the pre-filter keeps all of them). */
      const pageRows = (page: number, n: number) => Array.from({ length: n }, (_, i) => ({ tweet_id: `q${page}_${i}`, text: `منشور ${page}-${i} عن ${TOPIC} في البطولة` }));
      /** Only the first post of each page is on topic. */
      const strictAdvisor = (calls: number[], costUsd: number): RowAdvisorFn => async (input) => {
        calls.push(input.rows.length);
        return { verdicts: new Map(input.rows.map(({ index, row }) => [index, String(row.tweet_id).endsWith("_0") ? { verdict: "match" as const, reasonAr: "يتناول المباراة" } : { verdict: "no_match" as const, reasonAr: "لا يتناول المباراة" }])), usage: usage(costUsd), failure: null };
      };
      const internal = () => db.events.filter((event) => event.event_type === "review_cost").map((event) => String(event.message));
      const customer = () => db.events.filter((event) => event.event_type !== "review_cost").map((event) => String(event.message));

      it("a page of 20 posts is ONE review call covering all of them; only the confirmed row is delivered and charged", async () => {
        resetDb("social-x-posts", EGYPT_TOPIC, 20, 5);
        useSource(async () => ok({ ok: true, rows: pageRows(1, 20) }, 600));
        const calls: number[] = [];
        strict(strictAdvisor(calls, 0.004));

        const { json } = await runAllChunks();

        expect(calls).toEqual([20]);
        expect(json.done).toBe(true);
        expect(json.deliveredUnits).toBe(1);
        expect(json.settle.charged_credits).toBe(1 * 5);
      });

      it("a long page (40 posts) whose first call is mostly unrelated: ONE call of 25, the other 15 are excluded unreviewed, the customer is told in Arabic, only the confirmed row is charged", async () => {
        resetDb("social-x-posts", EGYPT_TOPIC, 40, 5);
        useSource(async () => ok({ ok: true, rows: pageRows(1, 40) }, 600));
        const calls: number[] = [];
        strict(strictAdvisor(calls, 0.004));

        const { json } = await runAllChunks();

        expect(calls).toEqual([25]);
        expect(json.done).toBe(true);
        expect(json.deliveredUnits).toBe(1);
        expect(json.settle.charged_credits).toBe(1 * 5);
        expect(customer().some((line) => line.includes("استُبعدت بقية سجلاتها (١٥ سجل) دون مراجعة فردية ولم تُحتسب"))).toBe(true);
        for (const line of customer()) expect(line).not.toMatch(/usd|USD|\$/);
      });

      it("the first chunk's own record shows the rejected page: the 15 rows after the first call are excluded unreviewed, the 24 reviewed rows that said «no match» keep that verdict (review sheet)", async () => {
        resetDb("social-x-posts", EGYPT_TOPIC, 40, 5);
        useSource(async () => ok({ ok: true, rows: pageRows(1, 40), next_cursor: "next" }, 600));
        strict(strictAdvisor([], 0.004));

        await callWorker();

        const stepFile = JSON.parse(db.partials.get(`${JOB}/step_0.json`)!.toString("utf-8"));
        expect(stepFile.reviewSample).toMatchObject({ size: 25, reviewed: 25, off: 24, pageRejected: true });
        expect(stepFile.relevanceExcludedCount).toBe(15);
        expect(stepFile.uncertainRowsCount).toBe(24);
        expect(stepFile.unreviewedRowsCount).toBe(0);
        expect(stepFile.batchUnits).toBe(1);
        expect(stepFile.rowsSeen).toBe(40);
        expect(stepFile.reviewCallCount).toBe(1);
      });

      it("the review spend of the job is logged for the owner: one internal row per chunk with calls and USD, hidden from the customer", async () => {
        resetDb("social-x-posts", EGYPT_TOPIC, 40, 5);
        useSource(async () => ok({ ok: true, rows: pageRows(1, 40) }, 600));
        strict(strictAdvisor([], 0.004));

        await runAllChunks();

        expect(internal()).toEqual(["review_spend step=0 calls=1 usd=0.004000 total_calls=1 total_usd=0.004000 rows_seen=40 low_yield_stop=0"]);
        expect(db.events.filter((event) => event.event_type === "review_cost")).toHaveLength(1);
        expect(customer().every((line) => !line.startsWith("review_spend"))).toBe(true);
      });

      describe("the first reply of a job is kept once for the owner, scrubbed of row text (type review_sample, hidden from the customer)", () => {
        const sampleRows = () => db.events.filter((event) => event.event_type === "review_sample");
        /** A reviewer that thinks aloud and QUOTES the first post before its compact verdicts; it answers like the production call, sample included. */
        const thinkingReviewer = (calls: number[]): RowAdvisorFn => async (input) => {
          calls.push(input.rows.length);
          const reply = `Looking at the rows first. Row 0 says "${input.rows[0].row.text}" which is about the topic.\n{"reviews":[${input.rows.map(({ index }) => `{"index":${index},"verdict":"${index === 0 ? "match" : "no_match"}"}`).join(",")}]}`;
          return {
            verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: index === 0 ? "match" as const : "no_match" as const, reasonAr: "x" }])),
            usage: usage(0.004), failure: null, stopReason: "end_turn", replyChars: reply.length, replySample: replySampleOf(reply, input.rows, "x"),
          };
        };

        it("a job of several chunks writes ONE sample row, from its first call: numbers, the head of the reply, no row text", async () => {
          resetDb("social-x-posts", EGYPT_TOPIC, 40, 0.11715);
          let providerCalls = 0;
          useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
          const calls: number[] = [];
          strict(thinkingReviewer(calls));

          await runAllChunks();

          expect(calls.length).toBeGreaterThanOrEqual(3);
          const rows = sampleRows();
          expect(rows).toHaveLength(1);
          const message = String(rows[0].message);
          expect(message.startsWith("review_sample step=0 rows=20 stop=end_turn in=2000 out=500 reply_chars=")).toBe(true);
          expect(message).toContain("starts_json=0 reason_keys=0 head=");
          expect(message).toContain("Looking at the rows first.");
          expect(message).toContain("which is about the topic.");
          expect(message).not.toContain("في البطولة");
          expect(message).not.toContain(TOPIC);
          expect(rows[0].units).toBe(0);
          expect(db.events.filter((event) => isCustomerVisibleJobEvent(event.event_type)).some((event) => String(event.message).includes("review_sample"))).toBe(false);
        });

        it("a second job writes its own single row (the rule is per job, not per instance)", async () => {
          for (let run = 0; run < 2; run += 1) {
            resetDb("social-x-posts", EGYPT_TOPIC, 20, 0.11715);
            useSource(async () => ok({ ok: true, rows: pageRows(1, 20) }, 600));
            strict(thinkingReviewer([]));
            await runAllChunks();
            expect(sampleRows()).toHaveLength(1);
          }
        });

        it("no review call, no sample row", async () => {
          resetDb("social-x-posts", EGYPT_TOPIC, 20, 0.11715);
          useSource(async () => ok({ ok: true, rows: [] }, 600));
          strict(thinkingReviewer([]));
          await runAllChunks();
          expect(sampleRows()).toEqual([]);
        });
      });

      describe("the daily review guard: at the daily ceiling (or when it cannot be read) a job that has not started reviewing takes the previous budget rule", () => {
        const fallbackRows = () => db.events.filter((event) => event.event_type === "review_fallback").map((event) => String(event.message));
        /** 40 X posts at the real price (0.11715): the per-job budget is 0.03984 USD, the previous rule 0.0083 USD. Pages of 20 posts, one confirmed post each, 0.004 USD a call: three pages are bought and reviewed under the per-job budget. */
        const run = async (usageRows: number[] | null, options: { fail?: boolean } = {}) => {
          resetDb("social-x-posts", EGYPT_TOPIC, 40, 0.11715);
          db.usage = { rows: usageRows, fail: Boolean(options.fail), reads: 0 };
          setReviewDailyGuardForTesting("real");
          let providerCalls = 0;
          useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
          const calls: number[] = [];
          strict(strictAdvisor(calls, 0.004));
          const { json } = await runAllChunks();
          return { calls, json, providerCalls };
        };

        it("below the daily ceiling (11.99 of 12 USD) the job has the per-job budget and no fallback row is written", async () => {
          const { calls } = await run([11.99]);
          expect(calls).toEqual([20, 20, 20]);
          expect(fallbackRows()).toEqual([]);
          expect(db.usage.reads).toBe(1);
        });

        it("at the daily ceiling (12 USD) the job takes the previous rule: one full call only, ONE internal row says so, hidden from the customer", async () => {
          const { calls } = await run([12]);
          expect(calls).toEqual([20]);
          expect(fallbackRows()).toEqual(["review_fallback step=0 reason=daily_ceiling today_usd=12.000000 daily_ceiling_usd=12 job_cap_usd=0.008300"]);
          expect(db.events.filter((event) => isCustomerVisibleJobEvent(event.event_type)).every((event) => !String(event.message).startsWith("review_fallback"))).toBe(true);
          expect(db.usage.reads).toBe(1);
        });

        it("a spend several rows add up to the ceiling counts (6 + 6 USD), one cent under does not", async () => {
          expect((await run([6, 6])).calls).toEqual([20]);
          expect((await run([6, 5.99])).calls).toEqual([20, 20, 20]);
        });

        it("when today's spend cannot be read the previous rule applies, not the per-job budget, and the row says the read failed", async () => {
          const { calls, json } = await run([0], { fail: true });
          expect(calls).toEqual([20]);
          expect(fallbackRows()).toEqual(["review_fallback step=0 reason=read_failed today_usd=unknown daily_ceiling_usd=12 job_cap_usd=0.008300"]);
          expect(json.done).toBe(true);
        });

        it("the job keeps its rule for all its chunks: the first chunk's record carries it, and there is one row and one read however many chunks", async () => {
          resetDb("social-x-posts", EGYPT_TOPIC, 40, 0.11715);
          db.usage = { rows: [12], fail: false, reads: 0 };
          setReviewDailyGuardForTesting("real");
          let providerCalls = 0;
          useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
          strict(strictAdvisor([], 0.004));
          await callWorker();
          const stepFile = JSON.parse(db.partials.get(`${JOB}/step_0.json`)!.toString("utf-8"));
          expect(stepFile.reviewFallback).toBe(true);
          db.usage.rows = [0]; // the day looks empty from now on: the job still keeps the previous rule
          const { json } = await runAllChunks();
          expect(json.done).toBe(true);
          expect(fallbackRows()).toHaveLength(1);
          expect(db.usage.reads).toBe(1);
        });

        it("a job that began reviewing under the per-job budget keeps it even if the day reaches the ceiling meanwhile", async () => {
          resetDb("social-x-posts", EGYPT_TOPIC, 40, 0.11715);
          db.usage = { rows: [11.99], fail: false, reads: 0 };
          setReviewDailyGuardForTesting("real");
          let providerCalls = 0;
          useSource(async () => { providerCalls += 1; if (providerCalls === 2) db.usage.rows = [50]; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
          const calls: number[] = [];
          strict(strictAdvisor(calls, 0.004));
          await runAllChunks();
          expect(calls).toEqual([20, 20, 20]);
          expect(fallbackRows()).toEqual([]);
          expect(db.usage.reads).toBe(1);
        });

        it("the fallback changes only the review budget: the same posts are delivered and charged per delivered row", async () => {
          const normal = await run([0]);
          const normalCharge = normal.json.settle?.charged_credits;
          const fallback = await run([12]);
          expect(fallback.json.done).toBe(true);
          expect(fallback.json.deliveredUnits).toBe(1);
          expect(fallback.json.settle.charged_credits).toBe(Math.ceil(1 * 0.11715));
          expect(normalCharge).toBe(Math.ceil(normal.json.deliveredUnits * 0.11715));
        });
      });

      it("the review budget is used up and fewer than 10% of the rows seen were accepted: the next page goes to «غير مراجَع», paging stops, nothing more is charged, and it is said in Arabic", async () => {
        // 40 posts wanted at 5 points: the budget is 20% of 20 EGP of revenue in USD (about 0.07 USD); the first call spends 0.08
        resetDb("social-x-posts", EGYPT_TOPIC, 40, 5);
        let providerCalls = 0;
        useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
        const calls: number[] = [];
        strict(strictAdvisor(calls, 0.08));

        const { json } = await runAllChunks();

        // page 1: one call on its 20 rows (1 accepted = 5%); page 2: no call at all, its 20 rows are not delivered; no page 3 is bought
        expect(calls).toEqual([20]);
        expect(providerCalls).toBe(2);
        expect(json.done).toBe(true);
        expect(json.deliveredUnits).toBe(1);
        expect(json.settle.charged_credits).toBe(1 * 5);
        expect(customer().some((line) => line.includes("توقّف التحقق الآلي لأن نسبة السجلات المطابقة بقيت منخفضة جداً"))).toBe(true);
        expect(customer().some((line) => line.includes("ورقة «غير مراجَع»"))).toBe(true);
        expect(internal()).toEqual([
          "review_spend step=0 calls=1 usd=0.080000 total_calls=1 total_usd=0.080000 rows_seen=20 low_yield_stop=0",
          "review_spend step=1 calls=0 usd=0.000000 total_calls=1 total_usd=0.080000 rows_seen=20 low_yield_stop=1",
        ]);
      });

      it("the budget is used up but most rows were accepted: the page after it is NOT delivered (it was before), it goes to «غير مراجَع», paging stops, and the sheet says why", async () => {
        resetDb("social-x-posts", EGYPT_TOPIC, 40, 5);
        let providerCalls = 0;
        useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
        const calls: number[] = [];
        strict(async (input) => { calls.push(input.rows.length); return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "يتناول المباراة" }])), usage: usage(0.08), failure: null }; });

        const { json } = await runAllChunks();

        expect(calls).toEqual([20]);
        expect(providerCalls).toBe(2);
        expect(json.done).toBe(true);
        // only the 20 rows of the reviewed page are delivered and charged; the 20 of the next page were never reviewed
        expect(json.deliveredUnits).toBe(20);
        expect(json.settle.charged_credits).toBe(20 * 5);
        expect(customer().some((line) => line.includes("وصل التحقق الآلي إلى الحد المسموح لهذا الطلب؛ وُضع ٢٠ سجل في ورقة «غير مراجَع» ولم يُحتسب"))).toBe(true);
        expect(internal().some((line) => line.includes("low_yield_stop=1"))).toBe(false);
        // the files: 20 delivered rows in the main sheet and the CSV; the 20 unreviewed rows in their own sheet, with the Arabic notice
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(db.results.get(`user_1/${JOB}/result.xlsx`)! as any);
        expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(["المنشورات", "غير مراجَع"]);
        expect(workbook.getWorksheet("المنشورات")!.rowCount).toBe(1 + 20);
        const apart = workbook.getWorksheet("غير مراجَع")!;
        expect(String(apart.getCell(1, 1).value)).toBe(UNREVIEWED_SHEET_NOTICE_AR);
        expect(apart.rowCount).toBe(2 + 20);
        expect(String(apart.getCell(3, 4).value)).toBe(UNREVIEWED_BY_BUDGET_REASON_AR);
        const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
        expect(csv.split("\n").filter((line) => line.includes("منشور 1-"))).toHaveLength(20);
        expect(csv).not.toContain("منشور 2-");
      });

      it("a job that accepts at least 10% of what it sees is not stopped by the low-yield rule: it stops because the budget is used up", async () => {
        resetDb("social-x-posts", EGYPT_TOPIC, 40, 5);
        let providerCalls = 0;
        useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: pageRows(providerCalls, 20), next_cursor: `c${providerCalls}` }, 600); });
        // 4 of the 20 rows match (20%, above the 10% line)
        strict(async (input) => ({ verdicts: new Map(input.rows.map(({ index, row }) => [index, Number(String(row.tweet_id).split("_")[1]) < 4 ? { verdict: "match" as const, reasonAr: "يتناول المباراة" } : { verdict: "no_match" as const, reasonAr: "لا يتناول المباراة" }])), usage: usage(0.08), failure: null }));

        const { json } = await runAllChunks();

        expect(providerCalls).toBe(2);
        expect(json.deliveredUnits).toBe(4);
        expect(internal().some((line) => line.includes("low_yield_stop=1"))).toBe(false);
        expect(customer().some((line) => line.includes("ورقة «غير مراجَع»"))).toBe(true);
      });
    });
  });
  describe("YouTube comments by topic with a window: the source shows dates as «منذ …»", () => {
    const WINDOW = { dateFrom: "2026-09-20", dateTo: "2026-10-20" };
    const VIDEO = "dQw4w9WgXcQ";
    const runYoutube = async (opts: { videos: Array<Record<string, any>>; comments: Array<Record<string, any>> }) => {
      setRelativeDateClockForTesting(() => Date.parse("2026-10-20T12:00:00Z"));
      resetDb("social-youtube-comments", { query: "كرة القدم", ...WINDOW }, 30, 9);
      useSource(async (_source, params) => {
        if (params.video) return ok({ ok: true, rows: opts.comments });
        return ok({ ok: true, rows: opts.videos });
      });
      return runAllChunks();
    };
    const lines = () => db.events.map((event) => String(event.message));
    const comments = (n: number, extra: Record<string, any>) => Array.from({ length: n }, (_, i) => ({ comment_id: `yc${i}`, text: `تعليق ${i} على الماتش`, author: "أحمد", ...extra }));

    it("comments dated «منذ أسبوعين» are inside the last month: delivered, and the line says the dates are approximate", async () => {
      const { json } = await runYoutube({ videos: [{ video_id: VIDEO, title: "ملخص الماتش" }], comments: comments(6, { published_time_text: "منذ أسبوعين" }) });
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(6);
      expect(json.settle.charged_credits).toBe(6 * 9);
      const line = lines().find((entry) => entry.includes("من هذه الصفحة"))!;
      expect(line).toContain("وكلها داخل الفترة المطلوبة");
      expect(line).toContain("بعض التواريخ تقريبية لأن المصدر يعرضها بصيغة «منذ …»");
      expect(line).toContain("(٦ سجل)");
    });

    it("comments written «3 months ago» are outside the window: dropped, said plainly, nothing charged", async () => {
      const { json } = await runYoutube({ videos: [{ video_id: VIDEO, title: "ملخص الماتش" }], comments: comments(5, { time: "3 months ago" }) });
      expect(json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      expect(lines().some((entry) => entry.includes("٥ خارج الفترة المطلوبة"))).toBe(true);
    });

    it("comments with no date at all take the date of their video, read from its own «منذ …»", async () => {
      const { json } = await runYoutube({ videos: [{ video_id: VIDEO, title: "ملخص الماتش", published_time_text: "منذ ٣ أسابيع" }], comments: comments(4, {}) });
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(4);
      expect(lines().some((entry) => entry.includes("المصدر لا يعرض تاريخ كتابة التعليقات"))).toBe(true);
    });

    it("the first video's comments are all outside the window: the job goes on to the next video and delivers what is inside", async () => {
      setRelativeDateClockForTesting(() => Date.parse("2026-10-20T12:00:00Z"));
      resetDb("social-youtube-comments", { query: "كرة القدم", ...WINDOW }, 8, 9);
      const OTHER = "9bZkp7q19f0";
      const calls: string[] = [];
      useSource(async (_source, params) => {
        if (params.video) {
          calls.push(String(params.video));
          const old = String(params.video).includes(VIDEO);
          return ok({ ok: true, rows: Array.from({ length: 8 }, (_, i) => ({ comment_id: `${old ? "o" : "n"}${i}`, text: `تعليق ${old ? "قديم" : "جديد"} ${i} عن الماتش`, published_at: old ? "2026-08-06T10:00:00Z" : "2026-10-10T10:00:00Z" })) });
        }
        return ok({ ok: true, rows: [{ video_id: VIDEO, title: "مباراة قديمة" }, { video_id: OTHER, title: "مباراة حديثة" }] });
      });
      const { json } = await runAllChunks();
      expect(calls).toHaveLength(2);
      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(8);
      expect(json.settle.charged_credits).toBe(8 * 9);
      const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
      expect(csv).toContain("جديد");
      expect(csv).not.toContain("قديم");
    });

    it("every video is outside the window even though the search was asked for the newest: nothing charged, and the reason says what was tried and what to send instead", async () => {
      setRelativeDateClockForTesting(() => Date.parse("2026-10-20T12:00:00Z"));
      resetDb("social-youtube-comments", { query: "كرة القدم", ...WINDOW }, 8, 9);
      useSource(async (source, params) => {
        if (params.video) return ok({ ok: true, rows: Array.from({ length: 6 }, (_, i) => ({ comment_id: `o${i}`, text: `تعليق ${i} عن الماتش` })) });
        return ok({ ok: true, rows: [{ video_id: VIDEO, title: "مباراة قديمة", published_at: "2026-08-06T10:00:00Z" }] });
      });
      const { json } = await runAllChunks();
      expect(json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      const reason = String(release.args.p_error_message);
      expect(reason).toContain("المصدر أعاد منشورات خارج الفترة التي حددتها");
      expect(reason).toContain("ننصح بإرسال روابط الفيديوهات أو اسم القناة");
      expect(reason).toContain("تم استرداد كامل الرصيد المحجوز دون أي خصم");
    });

    it("a YouTube video about something else is excluded by the video review, and the comments of an on-topic video are delivered whatever they say", async () => {
      setRelativeDateClockForTesting(() => Date.parse("2026-10-20T12:00:00Z"));
      resetDb("social-youtube-comments", { query: "كرة القدم", ...WINDOW }, 10, 9);
      const OTHER = "9bZkp7q19f0";
      const asked: Array<{ kind: string; titles: string[] }> = [];
      setStrictSocialReviewForTesting(true);
      setRowAdvisorForTesting(async (input) => {
        asked.push({ kind: input.kind, titles: input.rows.map(({ row }) => String(row.title)) });
        return { verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "no_match" as const, reasonAr: "الفيديو عن موضوع آخر" }])), usage: { inputTokens: 500, outputTokens: 100, costUsd: 0.002, model: "claude-haiku-5-5", latencyMs: 10 }, failure: null };
      });
      useSource(async (_source, params) => {
        if (params.video) {
          const onTopic = String(params.video).includes(VIDEO);
          return ok({ ok: true, rows: (onTopic ? ["حلو قوي", "افتح التنزيل عليك الله", "شكرا"] : ["تعليق عن الطبخ", "وصفة حلوة"]).map((text, i) => ({ comment_id: `${onTopic ? "t" : "o"}${i}`, text, author: `قارئ ${i}`, published_at: "2026-10-10T10:00:00Z" })) });
        }
        return ok({ ok: true, rows: [{ video_id: OTHER, title: "طريقة عمل الكشري المصري" }, { video_id: VIDEO, title: "ملخص مباراة في كرة القدم" }] });
      });
      const { json } = await runAllChunks();
      expect(asked).toEqual([{ kind: "social-youtube-comments-video-list", titles: ["طريقة عمل الكشري المصري"] }]);
      expect(json.deliveredUnits).toBe(3);
      expect(json.settle.charged_credits).toBe(3 * 9);
      expect(db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8")).not.toContain("وصفة حلوة");
    });

    it("the search found no video: the reason says so (not «no matching data») and nothing is charged", async () => {
      const { json } = await runYoutube({ videos: [], comments: [] });
      expect(json.released).toBe(true);
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      expect(String(release.args.p_error_message)).toBe("لم يجد البحث أي فيديو عن موضوعك على يوتيوب الآن، فلم تُجمع تعليقات؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.");
      expect(String(release.args.p_error_message)).not.toContain("لم يُعثر على أي بيانات مطابقة");
    });
  });
});
