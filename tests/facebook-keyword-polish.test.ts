import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * The Facebook keyword mission (polish batch) through the REAL worker route: spec resolution, the provider spend estimate, the post selection with a FAKE review model, the delivery
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
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async (token?: string) => ({ data: { user: token === "user-token" ? { id: "user_1", email: "c@example.test", app_metadata: {} } : null }, error: null })) } })),
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
import { FIXTURE_TOPIC, facebookKeywordWorld, fixtureComments, postNumberOf } from "./helpers/fakeFacebookKeyword";
import ExcelJS from "exceljs";
import { generateCsvReport, generateExcelReport } from "../src/functions/shared/fileGenerators";
import { normalizeDataset } from "../src/lib/server/normalizationPipeline";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { WELL_WISH_REASON_AR, isPureWellWish } from "../src/lib/server/commentQuality";
import { FACEBOOK_KEYWORD_SLUG, PAGED_FIRST_CHUNK_ROWS } from "../src/lib/facebookKeywordService";
import { readDiagnosticFile, totalDiagnostic } from "../src/lib/server/zeroDeliveryDiagnostic";

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



  const previewOf = async () => {
    const route = await import("../src/app/api/jobs/[id]/preview/route");
    db.jobs[0].user_id = "user_1"; db.jobs[0].step = db.step; db.jobs[0].delivered_units = db.deliveredUnits; db.jobs[0].endpoint_id = SLUG; db.jobs[0].status = "running";
    const res = await route.GET(new NextRequest(`http://127.0.0.1:3000/api/jobs/${JOB}/preview`, { headers: { authorization: "Bearer user-token" } }), { params: Promise.resolve({ id: JOB }) });
    return res.json();
  };
  const diagnosticTotal = async () => totalDiagnostic(await readDiagnosticFile({ download: async (path: string) => { const buf = db.partials.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]) } : { data: null }; }, upload: async () => ({}) }, JOB));
  const arm = () => strict(0.003);

  // ---- item 3: the live preview shows accepted comment rows while the job is still running ----
  it("ITEM 3 (live preview): a job of 25 comments is NOT one chunk any more: the first chunk is one post's share, so accepted rows exist while the job runs, and the preview route returns them with the post wording", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 5, region: "EG" }, 25);
    const world = facebookKeywordWorld({ postsAvailable: 100 });
    useSource(world.call);
    arm();

    const first = await callWorker();
    expect(first.status).toBe(200);
    expect(first.json.done).not.toBe(true);
    expect(db.deliveredUnits).toBeGreaterThan(0);
    expect(db.deliveredUnits).toBeLessThanOrEqual(PAGED_FIRST_CHUNK_ROWS);
    expect(world.reads()).toHaveLength(1); // one post read, once
    const preview = await previewOf();
    expect(preview.success).toBe(true);
    expect(preview.sample).not.toBeNull();
    expect(preview.sample.rows.length).toBeGreaterThan(0);
    expect(preview.sample.columns.map((c: any) => c.titleAr)).toContain("نص التعليق");
    expect(JSON.stringify(preview.sample)).not.toMatch(/الفيديو/);

    const rest = await runAllChunks();
    expect(rest.json.done).toBe(true);
    expect(rest.json.deliveredUnits).toBe(25);
    // each post was read ONCE (a chunk that ends inside a post never reads it again), 5 comments each
    const reads = world.reads().map((entry) => postNumberOf(entry.params.url));
    expect(new Set(reads).size).toBe(reads.length);
    expect(reads).toHaveLength(5);
    expect(rest.json.settle.charged_credits).toBe(chargeForUnits(25, UNIT));
  });

  it("ITEM 3: a job that fits in one share (5 comments) still finishes in one chunk, and a big job is not slowed: the first chunk is the only small one", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 1, region: "EG" }, 5);
    const world = facebookKeywordWorld({ postsAvailable: 100 });
    useSource(world.call);
    arm();
    const one = await runAllChunks();
    expect(one.json.done).toBe(true);
    expect(one.json.deliveredUnits).toBe(5);
    expect(one.chunks).toBe(1);

    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 20, region: "EG" }, 100);
    const world2 = facebookKeywordWorld({ postsAvailable: 400 });
    useSource(world2.call);
    arm();
    const many = await runAllChunks();
    expect(many.json.deliveredUnits).toBe(100);
    expect(many.chunks).toBeLessThanOrEqual(6); // one small first chunk, then the usual chunks: never one per post
    expect(world2.reads()).toHaveLength(20);
  });

  // ---- item 4: well-wishes are not delivered and not charged ----
  const REAL_WISHES = ["بالتوفيق والنجاح الدائم", "بالتوفيق والسداد والنجاح", "بالتوفيق معالي الوزير دكتور"];
  const REAL_KEPT = ["علاج السكر غير موجود تأمين صحي طنطا عيادة علي", "ياريت لو امكن ذيادة تعاقد الاطباء والفنيين فوق السن يومية"];

  it("ITEM 4 (the rule): the three real well-wishes are recognised, the two real comments are kept, and a wish that says something is kept", () => {
    for (const text of REAL_WISHES) expect(isPureWellWish(text), text).toBe(true);
    for (const text of REAL_KEPT) expect(isPureWellWish(text), text).toBe(false);
    expect(isPureWellWish("بالتوفيق للمنظومة الصحية في تقليل الانتظار")).toBe(false);
    expect(isPureWellWish("الوزير لازم يوضح موقفه")).toBe(false);
    expect(isPureWellWish("")).toBe(false);
  });

  it("ITEM 4 (the gate): rejected for the keyword service with its own reason, kept for the two real comments; the other services are untouched", () => {
    const params = { query: "الترندات الصحية", region: "EG" };
    const judge = (slug: string, text: string) => evaluateResearchRowRelevance({ comment_id: "c1", text, video_title: "نصائح لتغذية صحية", video_url: "https://www.facebook.com/p/1" }, { capabilitySlug: slug, endpointId: slug, params } as any);
    for (const text of REAL_WISHES) expect(judge(FACEBOOK_KEYWORD_SLUG, text), text).toMatchObject({ decision: "no_match", reasonAr: WELL_WISH_REASON_AR });
    for (const text of REAL_KEPT) expect(judge(FACEBOOK_KEYWORD_SLUG, text).decision, text).toBe("match");
    // TikTok and YouTube topic searches keep their rule (a short comment under an on-topic video is presumed on topic)
    for (const slug of ["social-tiktok-comments", "social-youtube-comments"]) expect(judge(slug, REAL_WISHES[0]).decision, slug).toBe("match");
  });

  it("ITEM 4 (the job): comments that are pure well-wishes are left out BEFORE the charge; only kept rows are delivered and charged at the unchanged unit price; the shortfall sentence says how many were left out", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 6, region: "EG" }, 30);
    // every post: three well-wishes first, then the two real comments, then six more ordinary comments (the source gives 10 a call)
    const comments = (post: number) => [
      ...REAL_WISHES.map((text, i) => ({ comment_id: `w_${post}_${i}`, text, author: `قارئ ${i}` })),
      ...REAL_KEPT.map((text, i) => ({ comment_id: `k_${post}_${i}`, text: `${text} ${post}`, author: `كاتب ${i}` })),
    ];
    const world = facebookKeywordWorld({ postsAvailable: 200, commentsOf: comments });
    useSource(world.call);
    arm();

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    // 6 posts x the 2 real comments each: the wishes are never counted, whatever the post's share
    expect(json.deliveredUnits).toBe(12);
    expect(json.settle.charged_credits).toBe(chargeForUnits(12, UNIT));
    expect(UNIT).toBe(12.925); // no price changed
    const total = await diagnosticTotal();
    expect(total.rows.byReason.well_wish).toBe(18);
    expect(total.rows.accepted).toBe(12);
    const shortfall = lines().find((line) => line.startsWith("المسلَّم ١٢ من ٣٠ مطلوب"));
    expect(shortfall).toBeDefined();
    expect(shortfall).toContain("واستُبعد ١٨ تعليقًا من الدعاء والمجاملة بلا مضمون");
    expect(shortfall).toContain("ولم يُحتسب عليك إلا ما سُلّم");
    expect(shortfall).not.toMatch(/[A-Za-z0-9]/);
  });

  // ---- item 2: why fewer arrived ----
  it("ITEM 2 (the sentence): approved posts, only some delivered: ONE Arabic sentence from the real counts (posts read, posts the source gave too few comments for, posts with too few worth keeping)", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 8, region: "EG" }, 40);
    // 8 on-topic posts (even numbers 0..14): posts 0,2,4 give 10 good comments; 6,8,10 give only 2 (the source's answer is short); 12,14 give 10 pure well-wishes
    const commentsOf = (post: number) =>
      post <= 4 ? fixtureComments(post, 10)
      : post <= 10 ? fixtureComments(post, 2)
      : Array.from({ length: 10 }, (_, i) => ({ comment_id: `w_${post}_${i}`, text: REAL_WISHES[i % 3], author: `قارئ ${i}` }));
    const world = facebookKeywordWorld({ postsAvailable: 16, commentsOf });
    useSource(world.call);
    arm();

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(3 * 5 + 3 * 2); // 21 of 40
    expect(json.settle.charged_credits).toBe(chargeForUnits(21, UNIT));
    const sentence = lines().find((line) => line.startsWith("المسلَّم ٢١ من ٤٠ مطلوب"));
    expect(sentence).toBeDefined();
    expect(sentence).toContain("قرأنا تعليقات ٨ منشورات");
    expect(sentence).toContain("٣ منها أعاد المصدر لها تعليقات أقل من المطلوب (٥ لكل منشور)");
    expect(sentence).toContain("٢ منها لم يكن فيها العدد المطلوب من التعليقات الصالحة");
    expect(sentence).toContain("واستُبعد ٢٠ تعليقًا من الدعاء والمجاملة بلا مضمون");
    expect(sentence).toContain("ولم يُحتسب عليك إلا ما سُلّم");
    expect(sentence).not.toMatch(/[A-Za-z]/);
    // every number in it is one the job counted
    const total = await diagnosticTotal();
    expect(total.postReads).toMatchObject({ read: 8, sourceShort: 3, filteredShort: 2, asked: 5 });
  });

  it("ITEM 2: a job that delivers everything says nothing extra", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 4, region: "EG" }, 20);
    const world = facebookKeywordWorld({ postsAvailable: 100 });
    useSource(world.call);
    arm();
    const { json } = await runAllChunks();
    expect(json.deliveredUnits).toBe(20);
    expect(lines().some((line) => /^المسلَّم .* من .* مطلوب/.test(line))).toBe(false);
  });
});

// ---- items 1, 5, 6: the customer files of this service ----
describe("the customer files of the Facebook keyword service", () => {
  const POSTS = [
    { url: "https://www.facebook.com/healthpage/posts/10", text: "نصائح لتغذية صحية للأطفال في المدارس وأثرها على التركيز في الفصل الدراسي وما يجب أن يعرفه كل أب وأم", date: "2026-10-20" },
    { url: "https://www.facebook.com/healthpage/posts/12", text: "حملة التطعيم ضد الإنفلونزا الموسمية تبدأ الأسبوع القادم", date: "2026-10-21" },
  ];
  const BASE64_ID = "Y29tbWVudDoyMDI2MTAyNF8x";
  const raw = (post: number, i: number) => ({
    comment_id: `${BASE64_ID}${post}${i}`, text: `تعليق ${i} على المنشور ${post} طويل بما يكفي ليُقبل`, author: `قارئ ${i}`, created_at: "2026-10-22T09:00:00Z", likes: i,
    video_url: POSTS[post].url, video_title: POSTS[post].text, video_published_at: POSTS[post].date,
  });
  const rowsOf = [0, 0, 0, 1, 1].map((post, i) => raw(post, i));
  const payload = (template: string) => ({
    metadata: { platform: "facebook", socialKind: "comments", template, title: "تعليقات فيسبوك", collectedAt: "2026-10-24T00:00:00Z" },
    rows: rowsOf,
    uncertainRows: [{ ...raw(0, 9), _relevance_reason: "غير مؤكد" }],
  });
  const load = async (buffer: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as any); return wb; };
  const headerOf = (sheet: ExcelJS.Worksheet) => (sheet.getRow(1).values as any[]).slice(1).map((v) => String(v));

  it("ITEM 1: the post's columns say «المنشور», in the data, the CSV and the workbook; the other services keep their headers", async () => {
    const keyword = normalizeDataset(payload(FACEBOOK_KEYWORD_SLUG));
    const title = (norm: ReturnType<typeof normalizeDataset>, field: string) => norm.codebook.find((entry) => entry.field === field)?.titleAr;
    expect(title(keyword, "video_title")).toBe("عنوان المنشور");
    expect(title(keyword, "video_published_at")).toBe("تاريخ نشر المنشور");
    expect(title(keyword, "video_url")).toBe("رابط المنشور");
    const other = normalizeDataset(payload("social-facebook-comments"));
    expect(title(other, "video_title")).toBe("عنوان الفيديو أو المنشور");
    expect(title(other, "video_published_at")).toBe("تاريخ نشر الفيديو");
    expect(title(other, "video_url")).toBe("رابط الفيديو أو المنشور");
    const csv = generateCsvReport(payload(FACEBOOK_KEYWORD_SLUG)).toString("utf-8").split("\n")[0];
    for (const wanted of ["عنوان المنشور", "تاريخ نشر المنشور", "رابط المنشور", "رقم المنشور"]) expect(csv).toContain(wanted);
    expect(csv).not.toMatch(/الفيديو/);
    const csvOther = generateCsvReport(payload("social-youtube-comments")).toString("utf-8").split("\n")[0];
    expect(csvOther).toContain("رابط الفيديو أو المنشور");
  });

  it("ITEM 5: no internal source id in any customer file of this service (the comments, the CSV, the review sheet), while the other services keep theirs", async () => {
    const wb = await load(await generateExcelReport(payload(FACEBOOK_KEYWORD_SLUG)));
    const csv = generateCsvReport(payload(FACEBOOK_KEYWORD_SLUG)).toString("utf-8");
    for (const sheet of wb.worksheets) {
      sheet.eachRow((row) => row.eachCell((cell) => { expect(String(cell.value ?? "")).not.toContain(BASE64_ID); expect(String(cell.value ?? "")).not.toContain("معرف المصدر"); }));
    }
    expect(csv).not.toContain(BASE64_ID);
    expect(csv).not.toContain("معرف المصدر الأصلي");
    const other = await load(await generateExcelReport(payload("social-youtube-comments")));
    expect(headerOf(other.getWorksheet("التعليقات")!)).toContain("معرف المصدر الأصلي");
    expect(generateCsvReport(payload("social-youtube-comments")).toString("utf-8")).toContain(BASE64_ID);
    // the stored data (what the job keeps internally) still has the id
    expect(JSON.stringify(payload(FACEBOOK_KEYWORD_SLUG).rows)).toContain(BASE64_ID);
  });

  it("ITEM 6: two sheets, «التعليقات» linked to «المنشورات» by the post number; the post text is written once; header frozen, filter on, right to left", async () => {
    const wb = await load(await generateExcelReport(payload(FACEBOOK_KEYWORD_SLUG)));
    const comments = wb.getWorksheet("التعليقات")!;
    const posts = wb.getWorksheet("المنشورات")!;
    expect(wb.worksheets.slice(0, 2).map((sheet) => sheet.name)).toEqual(["التعليقات", "المنشورات"]);
    const commentHeaders = headerOf(comments);
    expect(commentHeaders).toContain("رقم المنشور");
    expect(commentHeaders).toContain("نص التعليق");
    for (const gone of ["عنوان المنشور", "تاريخ نشر المنشور", "رابط المنشور", "معرف المصدر الأصلي"]) expect(commentHeaders).not.toContain(gone);
    expect(headerOf(posts)).toEqual(["رقم المنشور", "نص المنشور", "رابط المنشور", "تاريخ نشر المنشور", "عدد التعليقات المسلَّمة"]);
    // 5 comments, 2 posts: the numbers tie them together
    const numberColumn = commentHeaders.indexOf("رقم المنشور") + 1;
    const numbers: number[] = [];
    comments.eachRow((row, rowNumber) => { if (rowNumber > 1) numbers.push(Number(row.getCell(numberColumn).value)); });
    expect(numbers).toEqual([1, 1, 1, 2, 2]);
    expect(posts.rowCount).toBe(3);
    expect(Number(posts.getRow(2).getCell(1).value)).toBe(1);
    expect(Number(posts.getRow(2).getCell(5).value)).toBe(3);
    expect(Number(posts.getRow(3).getCell(5).value)).toBe(2);
    // the long post text is in the posts sheet once and nowhere in the comments sheet
    let inComments = 0;
    comments.eachRow((row) => row.eachCell((cell) => { if (String(cell.value ?? "").includes("نصائح لتغذية صحية")) inComments += 1; }));
    expect(inComments).toBe(0);
    expect(String(posts.getRow(2).getCell(2).value)).toContain("نصائح لتغذية صحية");
    for (const sheet of [comments, posts]) {
      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, rightToLeft: true });
      expect(sheet.autoFilter).toBeTruthy();
    }
    // the review sheet lists the doubtful comment with a record number, never the platform id
    const review = wb.worksheets.find((sheet) => sheet.name !== "التعليقات" && sheet.name !== "المنشورات")!;
    expect(review).toBeDefined();
    expect(String(review.getRow(3).getCell(1).value)).toBe("1");
  });

  it("the other services' workbooks are unchanged: one sheet «التعليقات» with the video columns", async () => {
    const wb = await load(await generateExcelReport(payload("social-youtube-comments")));
    expect(wb.worksheets.map((sheet) => sheet.name).filter((name) => name === "التعليقات" || name === "المنشورات")).toEqual(["التعليقات"]);
    const headers = headerOf(wb.getWorksheet("التعليقات")!);
    expect(headers).toEqual(expect.arrayContaining(["عنوان الفيديو أو المنشور", "تاريخ نشر الفيديو", "رابط الفيديو أو المنشور"]));
    expect(headers).not.toContain("رقم المنشور");
  });
});
