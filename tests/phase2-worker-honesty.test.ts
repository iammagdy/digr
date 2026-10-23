import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * PHASE 2: honest counters and messages when the date window removes rows, and generic supplications never fill or charge a topic search.
 * Same fake database and fake provider as social-worker.test.ts; no live call.
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
import { summarizeActivityCounts } from "../src/lib/activityCounts";
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

const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const WINDOW = { dateFrom: "2026-09-20", dateTo: "2026-10-20" };
const VIDEO_ID = "7231337071831321900";
type CommentSpec = { time?: string; text?: string };

describe("worker: the date window and the generic comments, told honestly", () => {
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    originalEnv = { CRON_SECRET: process.env.CRON_SECRET, ENABLE_MOCK_PROVIDER: process.env.ENABLE_MOCK_PROVIDER, NODE_ENV: process.env.NODE_ENV, VERCEL_ENV: process.env.VERCEL_ENV };
    process.env.CRON_SECRET = "social-test-secret";
    process.env.ENABLE_MOCK_PROVIDER = "true";
    (process.env as any).NODE_ENV = "test";
    process.env.VERCEL_ENV = "development";
    setRelativeDateClockForTesting(() => Date.parse("2026-10-21T12:00:00Z"));
  });
  afterEach(() => {
    setProviderAdapterForTesting(null);
    setRowAdvisorForTesting(null);
    setStrictSocialReviewForTesting(false);
    setReviewDailyGuardForTesting(undefined);
    setRelativeDateClockForTesting(null);
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete (process.env as any)[key]; else (process.env as any)[key] = value; }
  });

  const useSource = (call: SocialCall) => setProviderAdapterForTesting(async (input: ProviderAdapterCallInput) => runSocialChunk(input, { call, videoSelector: input.videoSelector }));
  const callWorker = async () => {
    const route = await import("../src/app/api/worker/chunk/route");
    const res = await route.POST(new NextRequest("http://127.0.0.1:3000/api/worker/chunk", { method: "POST", headers: { authorization: "Bearer social-test-secret" }, body: JSON.stringify({ jobId: JOB, expectedStep: db.step, disableSelfChain: true }) }));
    return { status: res.status, json: await res.json() };
  };
  const runAllChunks = async () => {
    let last: { status: number; json: any } = { status: 0, json: {} };
    for (let i = 0; i < 8; i++) { last = await callWorker(); if (last.json.done || last.json.released || last.status >= 400) break; }
    return last;
  };
  const runCommentsJob = async (comments: CommentSpec[], target: number, params: Record<string, unknown> = {}) => {
    resetDb("social-tiktok-comments", { query: "كرة القدم", region: "EG", perVideo: 50, ...WINDOW, ...params }, target, 6);
    useSource(async (_source, p) => {
      if (p.aweme_id) {
        return ok({ data: { comments: comments.map((c, i) => ({ cid: `c${i}`, text: c.text ?? `هدف رائع في مباراة كرة القدم ${i}`, user: { nickname: "منى", unique_id: "mona" }, digg_count: i, ...(c.time ? { create_time: secs(c.time) } : {}) })), cursor: 0, has_more: 0 } });
      }
      return ok({ aweme_list: [{ aweme_id: VIDEO_ID, desc: "فيديو عن كرة القدم", share_url: `https://www.tiktok.com/@u/video/${VIDEO_ID}`, create_time: secs("2026-10-05T10:00:00Z") }] });
    });
    return runAllChunks();
  };
  const lines = () => db.events.map((event) => String(event.message));
  const inside = (i: number): CommentSpec => ({ time: `2026-10-0${(i % 9) + 1}T10:00:00Z` });
  const outside = (i: number): CommentSpec => ({ time: `2026-0${(i % 8) + 1}-01T10:00:00Z` });

  it("29 of 30 rows removed by date, the 1 left does not match: the message says what was removed, never that the dates are inside", async () => {
    const comments: CommentSpec[] = [{ ...inside(0), text: "اللهم صل على النبي" }, ...Array.from({ length: 29 }, (_, i) => outside(i))];
    const { json } = await runCommentsJob(comments, 30);
    expect(json.released).toBe(true);
    const reason = String(db.rpcCalls.find((c) => c.name === "release_job_atomic")!.args.p_error_message);
    expect(reason).toContain("استلمنا ٣٠ سجلاً");
    expect(reason).toContain("استُبعد منها ٢٩");
    expect(reason).toContain("خارج الفترة التي حددتها");
    expect(reason).toContain("بقي ١ داخل الفترة");
    expect(reason).not.toContain("وتواريخها داخل الفترة");
    expect(reason).toContain("تم استرداد كامل الرصيد المحجوز دون أي خصم");
  });

  it("the activity lines count the date-removed rows with the other exclusions, so the panel and the final message add up", async () => {
    const comments: CommentSpec[] = [{ ...inside(0), text: "اللهم صل على النبي" }, ...Array.from({ length: 29 }, (_, i) => outside(i))];
    await runCommentsJob(comments, 30);
    const page = lines().find((line) => /^الصفحة ١:/.test(line))!;
    expect(page).toContain("استلمنا ٣٠ سجل");
    expect(page).toContain("خارج الفترة ٢٩");
    const counts = summarizeActivityCounts(db.events.map((event) => ({ textAr: String(event.message) })));
    expect(counts.received).toBe(30);
    expect(counts.excluded).toBeGreaterThanOrEqual(29);
  });

  it("fewer rows than asked because most were removed by date: the shortfall line says so with the job's totals", async () => {
    const comments: CommentSpec[] = [...Array.from({ length: 3 }, (_, i) => inside(i)), ...Array.from({ length: 7 }, (_, i) => outside(i))];
    const { json } = await runCommentsJob(comments, 10);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(3);
    const shortfall = lines().find((line) => line.startsWith("المسلَّم ٣ من ١٠ مطلوب"))!;
    expect(shortfall).toContain("استُبعد ٧ من ١٠ سجلاً وصل");
    expect(shortfall).toContain("خارج الفترة التي حددتها");
    expect(shortfall).toContain("وسّع الفترة");
    expect(shortfall).not.toContain("لم يتوفر في المصدر عدد أكبر");
    expect(json.settle.charged_credits).toBe(3 * 6);
  });

  it("no window, no date line and no date wording: the old shortfall sentence is unchanged", async () => {
    resetDb("social-tiktok-comments", { query: "كرة القدم", region: "EG", perVideo: 50 }, 10, 6);
    useSource(async (_s, p) => p.aweme_id
      ? ok({ data: { comments: Array.from({ length: 3 }, (_, i) => ({ cid: `c${i}`, text: `هدف رائع في مباراة كرة القدم ${i}`, user: { nickname: "منى", unique_id: "mona" } })), cursor: 0, has_more: 0 } })
      : ok({ aweme_list: [{ aweme_id: VIDEO_ID, desc: "فيديو عن كرة القدم", share_url: `https://www.tiktok.com/@u/video/${VIDEO_ID}` }] }));
    const { json } = await runAllChunks();
    expect(json.deliveredUnits).toBe(3);
    const shortfall = lines().find((line) => line.startsWith("المسلَّم ٣ من ١٠ مطلوب"))!;
    expect(shortfall).toContain("لم يتوفر في المصدر عدد أكبر يطابق طلبك");
    expect(shortfall).not.toContain("الفترة");
  });

  it("generic supplications are not delivered and not charged; real comments are, and the volume is not filled by the generic ones", async () => {
    const generic = ["اللهم صل على النبي", "اللهم انصر الاسلام", "ما شاء الله تبارك الله", "تسلم ايدك", "جزاك الله خيرا"];
    const real = ["هدف رائع في مباراة كرة القدم ٠", "الحكم ظلمنا في الماتش", "ماتش حلو"];
    const comments: CommentSpec[] = [...generic, ...real].map((text, i) => ({ ...inside(i), text }));
    const { json } = await runCommentsJob(comments, 8);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(3);
    expect(json.settle.charged_credits).toBe(3 * 6);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    for (const text of generic) expect(csv, text).not.toContain(text);
    for (const text of real) expect(csv, text).toContain(text);
  });

  it("a supplication that names the topic is judged as a topical comment (delivered)", async () => {
    const comments: CommentSpec[] = [{ ...inside(0), text: "اللهم انصر منتخبنا في كرة القدم" }];
    const { json } = await runCommentsJob(comments, 1);
    expect(json.deliveredUnits).toBe(1);
  });
});
