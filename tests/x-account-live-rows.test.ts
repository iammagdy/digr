import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The REAL rows of the X account source through the real worker route. The ten rows are the ones of the live job job_quote_9d57c296e200a155000fcf9dfb4bc7e4
 * (2026-10-27, @elonmusk, `uncertainRows` of its step file, after `flattenRow`): the keys and the texts are the real ones (a text is only the start the owner read);
 * ids, counts and dates are synthetic. Only the provider call and the row reviewer are faked; the strict review is forced ON, as in production.
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



/** Every row has exactly these keys, all strings: authorHandle has no «@», isReply is the text «True» / «False», a repost is only the text «RT @name: …», createdUtc is Unix seconds as text. */
const REAL_KEYS = ["authorHandle", "authorId", "authorImage", "authorName", "bookmarks", "conversationId", "createdUtc", "id", "isPinned", "isReply", "lang", "likes", "media", "quotes", "replies", "retweets", "source", "text", "url", "views"];
const LIVE_TEXTS: Array<[text: string, isReply: "True" | "False"]> = [
  ["Everyone should have at least a few penc", "False"],       // 1 own post
  ["@SERobinsonJr Remarkably accurate", "True"],              // 2 reply
  ["He's right", "False"],                                    // 3 own post
  ["RT @DataRepublican: Well.", "False"],                     // 4 repost
  ["@jdoliner", "True"],                                      // 5 reply
  ["@Not_the_Bee Log curve in blue", "True"],                 // 6 reply
  ["@ID_AA_Carmack How about the robot", "True"],             // 7 reply
  ["RT @ID_AA_Carmack: I see how some people", "False"],      // 8 repost
  ["@ID_AA_Carmack These are real benchmarks", "True"],       // 9 reply
  ["Cute", "False"],                                          // 10 own post
];
const NEWEST = 1792308962; // 2026-10-18, Unix seconds
const liveRows = (overrides: Array<Record<string, string>> = []) => LIVE_TEXTS.map(([text, isReply], i) => ({
  authorHandle: "elonmusk", authorId: `1000${i}`, authorImage: "https://example.test/a.jpg", authorName: "Elon Musk", bookmarks: "0", conversationId: `20${i}`,
  createdUtc: String(NEWEST - i * 3600), id: `30${i}`, isPinned: "False", isReply, lang: "en", likes: String(10 + i), media: "", quotes: "0", replies: "1",
  retweets: String(i), source: "web", text, url: `https://x.com/elonmusk/status/30${i}`, views: String(100 + i), ...(overrides[i] || {}),
}));

describe("worker: the real rows of an X account", () => {
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
  const strictOn = (seen: Array<{ customerRequest: string; rows: number }>) => { setStrictSocialReviewForTesting(true); setRowAdvisorForTesting(emptyRequestReviewer(seen)); };

  it("the fixture is the live shape: twenty string keys, no repost flag, isReply as «True»/«False», authorHandle without «@»", () => {
    for (const row of liveRows()) {
      expect(Object.keys(row).sort()).toEqual([...REAL_KEYS].sort());
      expect(Object.values(row).every((value) => typeof value === "string")).toBe(true);
      expect(row.authorHandle).toBe("elonmusk");
      expect(["True", "False"]).toContain(row.isReply);
    }
    expect(liveRows().filter((row) => row.text.startsWith("RT @"))).toHaveLength(2);
    expect(liveRows().filter((row) => row.isReply === "True")).toHaveLength(5);
  });

  it("the ten live rows: 3 delivered (1, 3, 10), 5 replies and 2 reposts excluded, charge = ceil(3 x unit price) within the reserve, the topic review never asked", async () => {
    resetDb("social-x-posts", ACCOUNT, 10, 0.11715);
    const seen: Array<{ customerRequest: string; rows: number }> = [];
    strictOn(seen);
    useSource(async () => ok({ ok: true, rows: liveRows() }));

    const { json } = await runAllChunks();

    expect(seen).toEqual([]);
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(3);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    for (const text of ["Everyone should have at least a few penc", "He's right", "Cute"]) expect(csv).toContain(text);
    for (const text of ["Remarkably accurate", "@jdoliner", "Log curve in blue", "How about the robot", "These are real benchmarks", "RT @DataRepublican", "RT @ID_AA_Carmack"]) expect(csv).not.toContain(text);
    expect(db.rpcCalls.some((c) => c.name === "release_job_atomic")).toBe(false);
    expect(json.settle.charged_credits).toBe(Math.min(Math.ceil(3 * 0.11715), db.reserved));
    expect(json.settle.charged_credits).toBe(1);
    const page = lines().find((line) => line.startsWith("الصفحة ١"))!;
    expect(page).toContain("استلمنا ١٠ سجلات");
    expect(page).toContain("الجديد ٣");
    expect(page).toContain("غير مطابق ٧"); // 5 replies + 2 reposts
    expect(page).not.toContain("قيد المراجعة");
  });

  it("the same page inside a window: createdUtc (Unix seconds as TEXT) is read as seconds, so the three own posts are dated, not «without a date»", async () => {
    // rows 1, 3, 10 are 0, 2 and 9 hours before 2026-10-18T07:36Z: the window keeps the first two days; row 10 (2026-10-17T22:36Z) is outside «2026-10-18 to 2026-10-18»
    resetDb("social-x-posts", { ...ACCOUNT, dateFrom: "2026-10-18", dateTo: "2026-10-18" }, 10, 0.11715);
    useSource(async () => ok({ ok: true, rows: liveRows() }));
    const { json } = await runAllChunks();
    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(2);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    expect(csv).toContain("Everyone should have at least a few penc");
    expect(csv).toContain("He's right");
    expect(csv).not.toContain("Cute");
    const dateLine = lines().find((line) => line.includes("بسبب التاريخ"))!;
    expect(dateLine).toContain("خارج الفترة المطلوبة");
    expect(dateLine).not.toContain("بلا تاريخ نشر");
  });

  it("only replies and reposts (the live rows 2, 4, 5, 6, 7, 8, 9): nothing is delivered, nothing is charged, the reserve is released, and the sentence says exactly that", async () => {
    resetDb("social-x-posts", ACCOUNT, 10, 0.11715);
    useSource(async () => ok({ ok: true, rows: liveRows().filter((_, i) => [1, 3, 4, 5, 6, 7, 8].includes(i)) }));
    const seen: Array<{ customerRequest: string; rows: number }> = [];
    strictOn(seen);
    const { json } = await runAllChunks();
    expect(seen).toEqual([]);
    expect(json.released).toBe(true);
    expect(db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);
    const message = String(db.rpcCalls.find((c) => c.name === "release_job_atomic")!.args.p_error_message);
    expect(message).toBe(xAccountZeroDeliveryAr({ received: 7, held: 0, dateDropped: 0, replies: 5, reposts: 2 }));
    expect(message).toBe("استلمنا ٧ سجلات من الحساب المطلوب، لكنها كلها ردود على منشورات أخرى أو إعادات نشر، وليست منشورات كتبها الحساب نفسه (ردود: ٥، إعادات نشر: ٢)؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.");
    expect(message).not.toContain("موضوع طلبك");
    expect(message).not.toContain("أُحيل");
    expect(lines().some((line) => line.includes("لم يُسلَّم شيء") && line.includes("٥ ردًّا على منشورات أخرى") && line.includes("٢ إعادة نشر لمنشورات غيرها"))).toBe(true);
  });

  it("another account's post is excluded; a row with no readable author is held, not delivered and not charged", async () => {
    resetDb("social-x-posts", ACCOUNT, 10, 0.11715);
    const rows = liveRows().filter((_, i) => [0, 2, 9].includes(i));
    rows.push({ ...liveRows()[0], id: "other", authorHandle: "BillGates", text: "A post of another account" });
    const noAuthor: Record<string, any> = { ...liveRows()[0], id: "ghost", text: "A post with no author" };
    delete noAuthor.authorHandle;
    rows.push(noAuthor as any);
    useSource(async () => ok({ ok: true, rows }));
    const { json } = await runAllChunks();
    expect(json.deliveredUnits).toBe(3);
    const csv = db.results.get(`user_1/${JOB}/result.csv`)!.toString("utf-8");
    expect(csv).not.toContain("A post of another account");
    expect(csv).not.toContain("A post with no author");
    expect(json.settle.charged_credits).toBe(1);
    const page = lines().find((line) => line.startsWith("الصفحة ١"))!;
    expect(page).toContain("غير مطابق ١");
    expect(page).toContain("قيد المراجعة ١");
  });

  it("«@ElonMusk» or «elonmusk» in the plan reads the same account (case-insensitive, «@» stripped on both sides)", async () => {
    resetDb("social-x-posts", { channel: "@ELONMUSK" }, 10, 0.11715);
    useSource(async () => ok({ ok: true, rows: liveRows([{ authorHandle: "ElonMusk" }]) }));
    const { json } = await runAllChunks();
    expect(json.deliveredUnits).toBe(3);
  });
});
