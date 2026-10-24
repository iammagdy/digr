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
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { facebookCommentDropReason, isGenericComment, isPureWellWish } from "../src/lib/server/commentQuality";
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

describe("worker: the Facebook keyword mission, comment quality", () => {
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




  const LIVE_WISHES = [
    "بسم لله ما شاء الله حفظك الله ورعاك",
    "بالتوفيق ان شاء الله يا دكتر",
    "بالتوفيق دائما يارب العالمين ومن نجاح لنجاح إن شاءالله وربنا يحفظك ...",
    "والله أنتا إبن حلال وتستاهل كل خير ربنا يوفقك ويكرمك ويسعدك يارب العالمين",
    "بالتوفيق الدائم إن شاءالله يا دكتور",
    "تحيا مصر تحيا مصر تحيا مصر بالتوفيق دائما والله المستعان",
  ];
  const LIVE_KEPT = [
    "علاج السكر غير موجود تأمين صحي طنطا عيادة علي",
    "العدل مش إن جزء من الدفعة يبدأ حياته المهنية وجزء تاني يفضل واقف مكانه",
    "علاج السكر والضغط ليس موجود وتكلفته غالى جدا على أصحاب المعاش ...",
    "ياريت لو امكن ذيادة تعاقد الاطباء والفنيين فةق السن يومية",
    "ياريت يافندم صدور قرار بإلغاء العرض علي لجنه العجز الطبي كل سنه ...",
  ];
  const TOPIC = "الترندات الصحية";
  const ar = (n: number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
  const diagnostic = async () => totalDiagnostic(await readDiagnosticFile({ download: async (path: string) => { const buf = db.partials.get(path); return buf ? { data: new Blob([new Uint8Array(buf)]) } : { data: null }; }, upload: async () => ({}) }, JOB));

  it("THE 3rd LIVE RUN: the six pleasantries that were delivered and charged are now rejected, the five informative comments are kept", () => {
    for (const text of LIVE_WISHES) expect(isPureWellWish(text, { topic: TOPIC }), text).toBe(true);
    for (const text of LIVE_KEPT) expect(isPureWellWish(text, { topic: TOPIC }), text).toBe(false);
    // the earlier fixtures still behave
    for (const text of ["بالتوفيق والنجاح الدائم", "بالتوفيق والسداد والنجاح", "بالتوفيق معالي الوزير دكتور"]) expect(isPureWellWish(text, { topic: TOPIC }), text).toBe(true);
    for (const text of ["علاج السكر غير موجود تأمين صحي طنطا عيادة علي", "ياريت لو امكن ذيادة تعاقد الاطباء والفنيين فوق السن يومية"]) expect(isPureWellWish(text, { topic: TOPIC }), text).toBe(false);
  });

  it("typos, a stretched word, tatweel, a glued formula, a repeated phrase and emoji do not hide a pleasantry", () => {
    const wishes = [
      "بالتوفيييييق يا دكتووور", "بـــالتــوفــيــق والنجــاح", "بالتوفيق 🌹🌹🌹 ان شاء الله 🙏", "🌹 بالتوفيق 🌹", "ربنا يوفقك ربنا يوفقك ربنا يوفقك",
      "ماشاءالله ماشاءالله ماشاء الله ربنا يحفظك", "الحمدلله ربنا يبارك فيك يا دكتور", "جزاك الله خيرا", "شكرا يا دكتور وبالتوفيق دائما", "تحياتي لحضرتك وبالتوفيق ان شاء الله",
      "ان شاءالله ربنا يوفقك وينصرك", "بالتوفيق يا دكتر 💐💐", "ربنا يوفقك يا دكتور ❤️❤️❤️", "انشالله بالتوفيق دايما", "بسم الله ماشاء الله تبارك الله",
    ];
    for (const text of wishes) expect(isPureWellWish(text, { topic: TOPIC }), text).toBe(true);
  });

  it("a polite word inside an informative comment keeps it: a question, a number, a request, a complaint, a duty, an opinion or a word of the topic", () => {
    const informative = [
      "بالتوفيق للمنظومة الصحية في تقليل الانتظار", "شكرا يا دكتور بس المستشفى محتاجة اجهزة", "ربنا يوفقكم بس لازم تحسنوا الخدمة", "الحمد لله تم الشفاء بعد ٣ جلسات علاج",
      "جزاك الله خيرا هل الدواء متوفر؟", "بالتوفيق ان شاء الله وياريت تنظروا في المعاشات", "الوزير لازم يوضح موقفه", "تحيا مصر بس الاسعار نار", "بالتوفيق 😊 ممكن رقم التواصل؟",
      "ربنا يحفظك يا دكتور لو سمحت رد علينا", "شكرا لكن الخدمة سيئة", "بالتوفيق ان شاء الله ومحتاجين تعيين ٥٠٠ طبيب",
    ];
    for (const text of informative) expect(isPureWellWish(text, { topic: TOPIC }), text).toBe(false);
    // the topic's own word keeps a comment even when everything else is a wish
    expect(isPureWellWish("بالتوفيق للصحة", { topic: TOPIC })).toBe(false);
  });

  it("nothing is decided on empty or connecting words alone", () => {
    for (const text of ["", "   ", "🌹🌹🌹", "ان", "يا", "و في من", "..."]) expect(isPureWellWish(text, { topic: TOPIC }), JSON.stringify(text)).toBe(false);
  });

  it("facebookCommentDropReason: only an empty text and a bare link are dropped", () => {
    for (const text of ["", "   ", "\n\t"]) expect(facebookCommentDropReason(text), JSON.stringify(text)).toBe("empty");
    for (const text of ["https://example.com/x", "  www.example.com/x  ", "https://a.example/x https://b.example/y", "https://a.example/x ..."]) expect(facebookCommentDropReason(text), text).toBe("link_only");
    for (const text of ["ok", "👍", "@أحمد", "١٢٣", "بالتوفيق", "شوفوا https://example.com/x", ...LIVE_WISHES, ...LIVE_KEPT]) expect(facebookCommentDropReason(text), text).toBeNull();
  });

  it("OWNER DECISION: the keyword service delivers the comments of an adopted post as they are (no pleasantry, reaction, supplication, short-comment or topic judgment); only an empty comment or a bare link is left out; TikTok and YouTube judge exactly as before", () => {
    const params = { query: TOPIC, region: "EG" };
    const judge = (slug: string, text: string) => evaluateResearchRowRelevance({ comment_id: "c1", text, video_title: "نصائح لتغذية صحية", video_url: "https://www.facebook.com/p/1" }, { capabilitySlug: slug, endpointId: slug, params } as any);
    for (const text of [...LIVE_WISHES, ...LIVE_KEPT, "ok", "👍", "اللهم صل على محمد", "@أحمد", "https://example.com/x شوفوا ده"]) expect(judge(FACEBOOK_KEYWORD_SLUG, text), text).toMatchObject({ decision: "match" });
    for (const text of ["", "   ", "https://example.com/x", "www.example.com", "https://example.com/x https://example.org/y"]) expect(judge(FACEBOOK_KEYWORD_SLUG, text).decision, JSON.stringify(text)).toBe("no_match");
    for (const slug of ["social-tiktok-comments", "social-youtube-comments"]) for (const text of LIVE_WISHES) expect(judge(slug, text).decision, `${slug} ${text}`).toBe("match");
    expect(judge("social-tiktok-comments", "ok").decision).toBe("no_match"); // the short-comment rule of the other services is untouched
    expect(isGenericComment("بالتوفيق ان شاء الله يا دكتر")).toBe(false); // the shared rule of the other services is untouched
  });

  /** The 11 comments of the live run, in three posts (the source returned fewer than the 5 asked for each): 6 pleasantries and 5 informative. */
  const liveComments = (post: number) => {
    const w = LIVE_WISHES, k = LIVE_KEPT;
    const rows = post === 0 ? [w[0], k[0], w[1], k[1]] : post === 2 ? [w[2], w[3], k[2], k[3]] : post === 4 ? [w[4], w[5], k[4]] : [];
    return rows.map((text, i) => ({ comment_id: `live_${post}_${i}`, text, author: `قارئ ${i}` }));
  };

  it("THE LIVE EXAMPLE THROUGH THE WORKER (owner decision: all comments): 11 comments read, all 11 delivered, charge = ceil(11 x 12.925) = 143, below the hold, with ONE honest sentence from the real counts and no word about pleasantries", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 5, region: "EG" }, 25);
    const world = facebookKeywordWorld({ postsAvailable: 6, commentsOf: liveComments }); // posts 0, 2 and 4 are about the topic
    useSource(world.call);
    strict(0.003);

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(11);
    expect(UNIT).toBe(12.925); // no price changed
    expect(chargeForUnits(11, UNIT)).toBe(143);
    expect(json.settle.charged_credits).toBe(143);
    expect(json.settle.charged_credits).toBeLessThanOrEqual(db.reserved);
    expect(json.settle.refunded_credits).toBe(db.reserved - 143);
    const total = await diagnostic();
    expect(total.rows.byReason.well_wish ?? 0).toBe(0);
    expect(total.rows.excluded).toBe(0);
    expect(total.rows.accepted).toBe(11);
    expect(total.postReads).toMatchObject({ read: 3, sourceShort: 3, sourceMissing: 4, filteredShort: 0, asked: 5 });
    const sentence = lines().find((line) => line.startsWith("المسلَّم ١١ من ٢٥ مطلوب"));
    expect(sentence).toBe("المسلَّم ١١ من ٢٥ مطلوب. اعتمدنا ٣ منشورات؛ قرأنا تعليقات ٣ منشورات؛ ٣ منها أعاد المصدر لها تعليقات أقل من المطلوب (٥ لكل منشور)؛ ونقص ما أعاده المصدر ٤ تعليقات عن المطلوب؛ ولم يُحتسب عليك إلا ما سُلّم.");
    expect(sentence).not.toMatch(/[A-Za-z]/);
    expect(sentence).not.toMatch(/دعاء|مجاملة/);
  });

  it("WHY APPROVED POSTS GAVE NO COMMENTS: many posts are approved but a job reads only the posts the customer asked for (5), and two of those five gave nothing but empty or link-only comments; the sentence says both, from counts", async () => {
    resetDb({ query: FIXTURE_TOPIC, perVideo: 5, videoCount: 5, region: "EG" }, 25);
    // on-topic posts are the even ones, read in the order 0, 2, 4, 6, 8: the posts 6 and 8 return only empty and link-only comments
    const commentsOf = (post: number) => (post === 6 || post === 8 ? Array.from({ length: 10 }, (_, i) => ({ comment_id: `w_${post}_${i}`, text: i % 2 === 0 ? "   " : `https://example.com/p${post}/${i}`, author: `قارئ ${i}` })) : fixtureComments(post, 10));
    const world = facebookKeywordWorld({ postsAvailable: 40, commentsOf });
    useSource(world.call);
    strict(0.003);

    const { json } = await runAllChunks();

    expect(json.done).toBe(true);
    expect(json.deliveredUnits).toBe(15); // 3 posts x 5
    expect(world.reads()).toHaveLength(5); // the customer asked for 5 posts: the other approved posts are not read
    const total = await diagnostic();
    expect(total.posts.adopted).toBeGreaterThan(5);
    const sentence = lines().find((line) => line.startsWith("المسلَّم ١٥ من ٢٥ مطلوب"))!;
    expect(sentence).toBeDefined();
    expect(sentence).toContain(`اعتمدنا ${ar(total.posts.adopted)} ${total.posts.adopted > 10 ? "منشورًا" : "منشورات"}`);
    expect(sentence).toContain("قرأنا تعليقات ٥ منشورات");
    expect(sentence).toContain("ولم تُقرأ تعليقات بقية المنشورات المعتمدة لأنك طلبت ٥ منشورات");
    expect(sentence).toContain("ولم يُسلَّم أي تعليق من منشورين منها");
    expect(sentence).toContain("واستُبعد ٢٠ تعليقًا (فارغ أو رابط فقط)");
    expect(sentence).toContain("ولم يُحتسب عليك إلا ما سُلّم");
    expect(sentence).not.toMatch(/[A-Za-z]/);
    expect(json.settle.charged_credits).toBe(chargeForUnits(15, UNIT));
  });
});
