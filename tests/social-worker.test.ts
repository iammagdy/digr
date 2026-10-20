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
import { setRelativeDateClockForTesting } from "../src/lib/server/relativeDate";
import { setRowAdvisorForTesting, setStrictSocialReviewForTesting, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";

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
    setRowAdvisorForTesting(null);
    setStrictSocialReviewForTesting(false);
    setRelativeDateClockForTesting(null);
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
  describe("X posts of a topic search: the rows are presumed on topic, and the doubtful ones need the automatic review", () => {
    const TOPIC = "مباراة مصر والمغرب كأس العالم";
    const ordinary = (n: number) => Array.from({ length: n }, (_, i) => ({ tweet_id: `p${i}`, text: `منشور ${i} عن ${TOPIC} في البطولة` }));
    const reactions = (n: number) => Array.from({ length: n }, (_, i) => ({ tweet_id: `r${i}`, text: i % 2 ? "اتفقت" : "اتفقت تماما", is_reply: true }));
    const usage = (costUsd: number) => ({ inputTokens: 2000, outputTokens: 500, costUsd, model: "claude-haiku-5-5", latencyMs: 20 });
    const strict = (advisor: RowAdvisorFn) => { setStrictSocialReviewForTesting(true); setRowAdvisorForTesting(advisor); };
    const lines = () => db.events.map((event) => String(event.message));

    it("ordinary rows are delivered without any review call; a doubtful one is delivered only when the review confirms it", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      const philosophical = { tweet_id: "f1", text: "الحياة رحلة طويلة والإنسان يبحث دائماً عن معنى لوجوده في هذا الكون الواسع" };
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
      expect(asked).toHaveLength(1);
      expect(asked[0]).toHaveLength(2);
      expect(json.deliveredUnits).toBe(9);
      // charge = delivered matching rows x unit price (the settlement function, unchanged)
      expect(json.settle.charged_credits).toBe(9 * 5);
      expect(lines().some((line) => line.includes("قيد المراجعة ١"))).toBe(true);
    });

    it("a page of ordinary rows never calls the reviewer", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      useSource(async () => ok({ ok: true, rows: ordinary(10) }, 600));
      let calls = 0;
      strict(async () => { calls += 1; return { verdicts: new Map(), usage: usage(0.004), failure: null }; });
      const { json } = await runAllChunks();
      expect(calls).toBe(0);
      expect(json.deliveredUnits).toBe(10);
    });

    it("a review that cannot be read holds the doubtful rows back but never the ordinary ones, and the job goes on", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      useSource(async () => ok({ ok: true, rows: [...ordinary(6), ...reactions(4)] }, 600));
      strict(async () => ({ verdicts: new Map(), usage: usage(0.002), failure: "bad_reply", stopReason: "max_tokens" }));

      const { json } = await runAllChunks();

      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(6);
      expect(json.settle.charged_credits).toBe(6 * 5);
      expect(lines().some((line) => line.includes("تعذّر التحقق الآلي من ملاءمة ٤ سجل"))).toBe(true);
    });

    it("when nothing on the page could be delivered without the review and the review fails, the reserve is released and paging stops", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      let providerCalls = 0;
      useSource(async () => { providerCalls += 1; return ok({ ok: true, rows: reactions(10), next_cursor: `c${providerCalls}` }, 600); });
      strict(async () => ({ verdicts: new Map(), usage: usage(0.002), failure: "bad_reply" }));

      const { json } = await runAllChunks();

      expect(json.released).toBe(true);
      expect(db.rpcCalls.some((call) => call.name === "settle_job_atomic")).toBe(false);
      expect(providerCalls).toBe(1);
    });

    it("the review's budget per job is capped: doubtful rows past it are not delivered, and it is said plainly", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 30, 5);
      useSource(async () => ok({ ok: true, rows: reactions(30) }, 600));
      strict(async (input) => ({ verdicts: new Map(input.rows.map(({ index }) => [index, { verdict: "match" as const, reasonAr: "رد على المباراة" }])), usage: usage(0.06), failure: null }));

      const { json } = await runAllChunks();

      expect(json.done).toBe(true);
      expect(json.deliveredUnits).toBe(25);
      expect(json.settle.charged_credits).toBe(25 * 5);
      expect(lines().some((line) => line.includes("وصل التحقق الآلي إلى الحد المسموح لهذا الطلب؛ وُضع ٥ سجل في شيت المراجعة ولم يُحتسب"))).toBe(true);
    });

    it("an empty post, an emoji and an ad are dropped before anything else", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 10, 5);
      const rows = [...ordinary(3), { tweet_id: "e1", text: "" }, { tweet_id: "e2", text: "😂😂" }, { tweet_id: "ad", text: "للتواصل واتساب 01012345678 خصم خاص" }];
      useSource(async () => ok({ ok: true, rows }, 600));
      let calls = 0;
      strict(async () => { calls += 1; return { verdicts: new Map(), usage: usage(0.003), failure: null }; });

      const { json } = await runAllChunks();

      expect(json.deliveredUnits).toBe(3);
      expect(calls).toBe(0);
    });

    it("what every review call did is kept in the step file: failure code, stop reason and tokens", async () => {
      resetDb("social-x-posts", { query: TOPIC }, 30, 5);
      let page = 0;
      useSource(async () => { page += 1; return ok({ ok: true, rows: page === 1 ? [...ordinary(2), ...reactions(2)] : [], next_cursor: page === 1 ? "next" : undefined }, 600); });
      strict(async () => ({ verdicts: new Map(), usage: { inputTokens: 900, outputTokens: 1200, costUsd: 0.003, model: "claude-haiku-5-5", latencyMs: 40 }, failure: "bad_reply", stopReason: "max_tokens", detail: "reply_chars=3100" }));

      await callWorker();

      const stepFile = JSON.parse(db.partials.get(`${JOB}/step_0.json`)!.toString("utf-8"));
      expect(stepFile.reviewFailures).toEqual(["bad_reply"]);
      expect(stepFile.reviewCalls).toEqual([{ rows: 2, failure: "bad_reply", stopReason: "max_tokens", detail: "reply_chars=3100", tokensIn: 900, tokensOut: 1200, latencyMs: 40 }]);
      expect(stepFile.reviewUsd).toBe(0.003);
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

    it("the search found no video: the reason says so (not «no matching data») and nothing is charged", async () => {
      const { json } = await runYoutube({ videos: [], comments: [] });
      expect(json.released).toBe(true);
      const release = db.rpcCalls.find((call) => call.name === "release_job_atomic")!;
      expect(String(release.args.p_error_message)).toBe("لم يجد البحث أي فيديو عن موضوعك على يوتيوب الآن، فلم تُجمع تعليقات؛ تم استرداد كامل الرصيد المحجوز دون أي خصم.");
      expect(String(release.args.p_error_message)).not.toContain("لم يُعثر على أي بيانات مطابقة");
    });
  });
});
