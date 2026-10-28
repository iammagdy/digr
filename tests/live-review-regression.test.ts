import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world, loadFixture } from "./helpers/replayWorld";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/replayWorld")).world.supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { setProviderAdapterForTesting, defaultTregAdapter } from "../src/lib/server/tregAdapter";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb } from "./helpers/chatSession";
import { createScriptedTransport, type ContentBlock } from "../src/lib/modelPlanner/transport";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { setRowAdvisorForTesting, type RowAdvisorFn } from "../src/lib/server/rowReviewAdvisor";
import { propose, sample, use } from "./helpers/plannerKit";
import { deterministicTopicVerdict, reviewTopicRows } from "../src/lib/modelPlanner/stageCall";

/**
 * REGRESSION of the live result of 28 Oct 2026 (test account). The jobs «تغريدات محمد صلاح بعد انتقاله لتركيا» (14 rows) and «ترند الجواز والطلاق» (6 comments) were all moved to «قيد المراجعة»:
 * after the plan's own topic review kept the rows, the worker's generic gate asked the legacy reviewer «is this row on topic?» with the request built from catalog-style parameters, which a
 * model plan does not have: an EMPTY request. The fixtures here are built from the catalog's example shapes with on-topic Arabic text (marked FIXTURE: the stored raw_first_page.json of
 * those jobs is private storage and could not be read from the build environment).
 */
const REQUEST = "هات ٢٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا";
const TOPIC = "محمد صلاح بعد انتقاله لتركيا";
const ON = [
  "محمد صلاح بعد انتقاله لتركيا يبدأ التدريبات مع فريقه الجديد", "انتقال محمد صلاح لتركيا يشعل الجماهير في إسطنبول", "صلاح في تركيا: أول ظهور بعد الانتقال",
  "رأيي في انتقال محمد صلاح لتركيا مفاجأة كبيرة", "هل ينجح محمد صلاح في تركيا بعد الانتقال؟", "محمد صلاح لتركيا الصفقة الأغلى هذا الموسم",
];
const OFF = ["أسعار الذهب اليوم في مصر", "مباراة الأهلي والزمالك غدًا"];
const tweet = (id: number, text: string) => ({ authorName: "x", authorUsername: `u${id}`, authorVerified: false, createdUtc: 1790000000 + id * 60, id: `${id}`, isReply: false, lang: "ar", likeCount: id, media: [], text, url: `https://x.com/i/web/status/${id}` });
const salahFixture = () => { const f: any = loadFixture("catalog-example_anyapi.x.search.posts"); f.pages = [{ ...f.pages[0], output: { data: { items: [...ON, ...OFF].map((t, i) => tweet(i + 1, t)), nextCursor: null } } }]; f.repeatLastPage = false; return f; };
const salahPlan = {
  summaryAr: "جمع ٢٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا", topic: TOPIC,
  steps: [{ endpointId: "anyapi.x.search.posts", volume: 20, params: [{ name: "query", value: TOPIC, source: "customer_text", quote: "محمد صلاح بعد انتقاله لتركيا" }], fieldMap: { columns: [{ field: "text", headerAr: "نص التغريدة", role: "text" }, { field: "authorUsername", headerAr: "الحساب", role: "author_handle" }, { field: "createdUtc", headerAr: "تاريخ النشر", role: "date", transform: "unix_s_to_iso" }, { field: "likeCount", headerAr: "الإعجابات", role: "likes", transform: "number" }, { field: "url", headerAr: "الرابط", role: "url" }], pagination: { kind: "token", param: "cursor" } }, filters: [] }],
};

let seq = 0;
async function plan(script: Array<ContentBlock[]>, request = REQUEST) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the old model path must not run"); });
  handler.modelPlanner = { transport: createScriptedTransport(script as any, { model: "recorded" }), client: world.mem, today: () => new Date("2026-10-28T12:00:00Z") };
  const conversationId = `conv_lr_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  return (await handler.handleUserMessage({ userId: "user_replay", userEmail: "magdy.saber@outlook.com", conversationId, message: request, userBalance: 40_000 }) as any);
}
const seedFromQuote = (item: any) => world.resetJob({ slug: item.capabilitySlug, endpointId: item.endpointId, params: item.params, target: item.targetVolumeMax, unitPrice: item.unitPricePoints, unitCostUsd: item.unitCostUsd });

/** A reviewer that, like the real one, can only confirm a row against the request it was GIVEN: with no request it confirms nothing (the live failure). */
const judging = (calls: Array<{ customerRequest: string; rows: number }>): RowAdvisorFn => async (input) => {
  calls.push({ customerRequest: input.customerRequest, rows: input.rows.length });
  const asked = String(input.customerRequest || "").trim();
  return { verdicts: new Map(input.rows.map((r) => [r.index, { verdict: asked && /صلاح/.test(JSON.stringify(r.row)) ? "match" : "no_match", reasonAr: "" }])) as any, usage: { inputTokens: 500, outputTokens: 40, costUsd: 0.0001, model: "claude-haiku-5-5", latencyMs: 200 }, failure: null };
};

beforeEach(() => {
  process.env.CRON_SECRET = "replay-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development"; process.env.TREG_LIVE = "true"; process.env.TREG_TOKEN = "replay-not-a-real-token";
  vi.stubEnv("JOB_MAX_POINTS_CAP", "");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
  resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); setProviderAdapterForTesting(defaultTregAdapter);
  resetExplorationMemoryForTesting();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { setRowAdvisorForTesting(null); vi.useRealTimers(); setProviderAdapterForTesting(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetProviderBalanceCacheForTesting(); });

const approved = async () => {
  world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 20, unitPrice: 1 });
  world.installFetch([salahFixture()]);
  const r = await plan([sample("anyapi.x.search.posts", [{ name: "query", value: TOPIC, source: "customer_text", quote: "محمد صلاح بعد انتقاله لتركيا" }]), propose(salahPlan)]);
  expect(r.outputType, r.contentAr).toBe("propose_plan");
  return r.planQuote.items[0];
};

describe("the Salah job: on-topic rows are delivered, never moved to «قيد المراجعة» by a reviewer that was given no request", () => {
  it("the topic review gets the customer's EXACT request, no other reviewer is asked anything (never with an empty request), and the 6 on-topic tweets are delivered, the 2 others are not", async () => {
    const item = await approved();
    const calls: Array<{ customerRequest: string; rows: number }> = [];
    setRowAdvisorForTesting(judging(calls));
    seedFromQuote(item);
    world.installFetch([salahFixture()]);
    const out = await world.runWorker();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const c of calls) expect(c.customerRequest).toBe(REQUEST);
    expect(out.json.deliveredUnits).toBe(6);
    const held = world.db.events.filter((e: any) => /قيد المراجعة/.test(String(e.message)) && /الصفحة/.test(String(e.message)));
    for (const e of held) expect(String(e.message)).toMatch(/قيد المراجعة ٠|^(?!.*قيد المراجعة [١-٩])/);
  });

  it("a review call that FAILS is retried once, then the fixed checks decide: the 6 on-topic tweets are delivered, the 2 others are not, and the review is marked PARTIAL (job note and methodology line)", async () => {
    const item = await approved();
    let calls = 0;
    setRowAdvisorForTesting(async () => { calls += 1; return { verdicts: new Map(), usage: { inputTokens: 300, outputTokens: 0, costUsd: 0.00003, model: "claude-haiku-5-5", latencyMs: 9000 }, failure: "timeout" as any }; });
    seedFromQuote(item);
    world.installFetch([salahFixture()]);
    const out = await world.runWorker();
    expect(calls).toBe(2); // one call and exactly one retry
    expect(out.json.deliveredUnits).toBe(6);
    const notes = world.db.events.filter((e: any) => e.event_type === "mission_note").map((e: any) => JSON.parse(e.message));
    const partial = notes.find((n: any) => n.kind === "review_partial");
    expect(partial?.textAr).toContain("التحقق من الملاءمة جزئي");
    expect(partial?.textAr).not.toMatch(/[A-Za-z]/);
    const keys = [...world.db.results.keys(), ...world.db.partials.keys()];
    const dataKey = keys.find((k: any) => String(k).endsWith("data.json"));
    expect(dataKey, keys.join(",")).toBeTruthy();
    const stored: any = world.db.results.get(dataKey as any) ?? world.db.partials.get(dataKey as any);
    const json = JSON.parse(typeof stored === "string" ? stored : Buffer.from(stored?.body ?? stored).toString("utf-8"));
    expect(json.metadata.reportContext.collection.reviewNoteAr).toContain("جزئي");
  });

  it("a reviewer that THROWS is treated the same way; a reviewer that answers only some rows is asked again for the rest", async () => {
    const item = await approved();
    setRowAdvisorForTesting(async () => { throw new Error("network"); });
    seedFromQuote(item);
    world.installFetch([salahFixture()]);
    const out = await world.runWorker();
    expect(out.json.deliveredUnits).toBe(6);

    const records = [...ON, ...OFF].map((text) => ({ text }));
    let n = 0;
    const partialAdvisor: RowAdvisorFn = async (input) => {
      n += 1;
      const answerOnly = n === 1 ? input.rows.slice(0, 3) : input.rows;
      return { verdicts: new Map(answerOnly.map((r) => [r.index, { verdict: /صلاح/.test(String(r.row.text)) ? "match" : "no_match", reasonAr: "" }])) as any, usage: null, failure: null };
    };
    const storedPlan: any = { v: 1, topic: TOPIC, steps: [], measured: [] };
    const res = await reviewTopicRows(records, storedPlan, { params: { _customerRequest: REQUEST } } as any, { next: null, page: 1, offset: 0 }, { advisor: partialAdvisor });
    expect(n).toBe(2);
    expect(res.kept).toHaveLength(6);
    expect(res.partial).toBeUndefined(); // the retry settled every row: nothing was judged by the fixed checks
  });

  it("past the job's review budget the fixed checks decide instead of holding everything; rows beyond the first 25 are no longer dropped without a look", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ text: i % 2 === 0 ? `محمد صلاح بعد انتقاله لتركيا ${i}` : `خبر آخر ${i}` }));
    const storedPlan: any = { v: 1, topic: TOPIC, steps: [], measured: [] };
    const broke = await reviewTopicRows(many, storedPlan, { params: { _customerRequest: REQUEST } } as any, { next: null, page: 1, offset: 0, reviewUsd: 10 }, { advisor: async () => { throw new Error("must not be called over budget"); } });
    expect(broke.kept).toHaveLength(30);
    expect(broke.partial).toMatchObject({ reason: "over_budget", byCheck: 60, kept: 30, dropped: 30 });
    let batches = 0;
    const all = await reviewTopicRows(many, storedPlan, { params: { _customerRequest: REQUEST } } as any, { next: null, page: 1, offset: 0 }, { advisor: async (i) => { batches += 1; return { verdicts: new Map(i.rows.map((r) => [r.index, { verdict: /صلاح/.test(String(r.row.text)) ? "match" : "no_match", reasonAr: "" }])) as any, usage: null, failure: null }; } });
    expect(batches).toBe(3);
    expect(all.kept).toHaveLength(30);
  });

  it("the fixed checks: the row has its text and the topic's words from the request are in it; a row with no text, or another subject, does not pass; a request with no topic words passes on the plan's filters alone", () => {
    expect(deterministicTopicVerdict({ text: ON[0] }, REQUEST)).toBe(true);
    expect(deterministicTopicVerdict({ text: OFF[0] }, REQUEST)).toBe(false);
    expect(deterministicTopicVerdict({ text: "" }, REQUEST)).toBe(false);
    expect(deterministicTopicVerdict({ _x: "صلاح", text: "." }, REQUEST)).toBe(false);
    expect(deterministicTopicVerdict({ text: "أي كلام" }, "هات ١٠ بوستات")).toBe(true);
  });
});

describe("source", () => {
  it("the worker does not run the catalog-style advisory for a model-planned job", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/worker/chunk/route.ts", "utf-8");
    expect(src).toContain("matchedForAdvice.length > 0 && !isChainJob && !xAccountJob && spec.capabilitySlug !== MODEL_PLAN_SLUG");
  });
});

import { asksForOfficialEntity, customerNamesPlatform, resolveFoundEntities } from "../src/lib/modelPlanner/validate";
import { stagesOfPlanQuote } from "../src/lib/missionPanelContent";
import { MODEL_PLAN_PARAM } from "../src/lib/modelPlanner/constants";
import { shouldSendStartedNotice } from "../src/lib/server/jobNotices";
import { missionView, type ProgressSnap } from "../src/lib/missionView";
import { readFileSync } from "node:fs";

const MARRIAGE = "هات ٥ فيديوهات تيك توك عن ترند الجواز والطلاق في مصر، وكل واحد معاه ١٠ كومنتات";
const marriagePlan = {
  summaryAr: "جمع ٥ فيديوهات عن الجواز والطلاق في مصر مع ١٠ تعليقات لكل فيديو", topic: "الجواز والطلاق في مصر",
  steps: [
    { endpointId: "anyapi.tiktok.search.videos", volume: 5, deliver: true, titleAr: "جمع الفيديوهات", params: [{ name: "query", value: "الجواز والطلاق في مصر", source: "customer_text", quote: "الجواز والطلاق في مصر" }], fieldMap: { columns: [{ field: "id", headerAr: "معرف المقطع", role: "id" }, { field: "caption", headerAr: "وصف المقطع", role: "title" }], pagination: { kind: "token", param: "cursor" } } },
    { endpointId: "tikhub.tiktok.video.comments", volume: 50, perItem: 10, deliver: true, titleAr: "جمع التعليقات", params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "digg_count", headerAr: "الإعجابات", role: "likes", transform: "number" }], pagination: { kind: "single" } } },
  ],
};

describe("the card adds up by code: the stages, the card total, the price and the hold are one number", () => {
  it("for N videos with M comments each: the card's total is the sum of the delivered stages as code counted them (never the model's declared volume), and a stage that gets fewer per parent than asked says why", async () => {
    const search1 = loadFixture("catalog-example_anyapi.tiktok.search.videos");
    const comments = loadFixture("catalog-example_tikhub.tiktok.video.comments");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 30, unitPrice: 1 });
    world.installFetch([search1, comments]);
    const r = await plan([sample("anyapi.tiktok.search.videos", [{ name: "query", value: "الجواز والطلاق في مصر", source: "customer_text", quote: "الجواز والطلاق في مصر" }]), sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }]), propose(marriagePlan)], MARRIAGE);
    expect(r.outputType, r.contentAr).toBe("propose_plan");
    const item = r.planQuote.items[0];
    const stages = stagesOfPlanQuote(r.planQuote)!;
    expect(stages).toHaveLength(2);
    const delivered = stages.reduce((n, s) => n + (s.deliver ? s.effVolume : 0), 0);
    // the card total, the quote's volume and the stored plan agree; the model's own volume (50) is not what the card shows
    expect(item.targetVolumeMax).toBe(delivered);
    expect(r.planQuote.targetVolumeMax).toBe(delivered);
    // stage 2 is never more than stage 1 x the rows one parent gives; when that is less than the 10 asked, the stage carries the asked number so the card can say why
    const stored = item.params[MODEL_PLAN_PARAM];
    expect(stages[0].effVolume).toBe(5);
    expect(stages[1].effVolume).toBeLessThanOrEqual(stages[0].effVolume * (stored.stages[1].perParent || 10));
    if (stored.stages[1].perParent < 10) expect(stored.stages[1].askedPerParent).toBe(10);
    else expect(stages[1].effVolume).toBe(50);
    const card = readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf-8");
    for (const needle of ["mission-stages-total", "askedPerParent", "platform-choice", "found-entities"]) expect(card, needle).toContain(needle);
  });
});

describe("which platform: stated on the card when the customer named none", () => {
  it("the words that name a platform are read; a plan on a social platform for a customer who named none is sent back until it says which platform and why, then it is shown on the card", async () => {
    expect(["بوستات عن الزواج على تيك توك", "فيديوهات يوتيوب", "من X", "حساب @elonmusk على اكس", "تعليقات فيسبوك", "هات ٢٠ تغريدة عن محمد صلاح"].map(customerNamesPlatform)).toEqual([true, true, true, true, true, true]);
    expect(["هات ٥ بوستات أو فيديوهات عن ترند الجواز والطلاق في مصر", "هات ٥ شركات"].map(customerNamesPlatform)).toEqual([false, false]);
    const request = "هات ٥ بوستات عن ترند الجواز والطلاق في مصر";
    const onX = (extra: Record<string, unknown> = {}) => ({
      summaryAr: "جمع ٥ بوستات عن الجواز والطلاق في مصر", topic: "الجواز والطلاق في مصر", ...extra,
      steps: [{ endpointId: "anyapi.x.search.posts", volume: 5, params: [{ name: "query", value: "الجواز والطلاق في مصر", source: "customer_text", quote: "الجواز والطلاق في مصر" }], fieldMap: { columns: [{ field: "text", headerAr: "نص التغريدة", role: "text" }, { field: "authorUsername", headerAr: "الحساب", role: "author_handle" }], pagination: { kind: "token", param: "cursor" } }, filters: [] }],
    });
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 5, unitPrice: 1 });
    world.installFetch([salahFixture()]);
    const s = sample("anyapi.x.search.posts", [{ name: "query", value: "الجواز والطلاق في مصر", source: "customer_text", quote: "الجواز والطلاق في مصر" }]);
    const withoutChoice = await plan([s, [use("propose_plan", onX())]], request);
    expect(withoutChoice.outputType).not.toBe("propose_plan"); // refused: the script has no second try
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 5, unitPrice: 1 });
    world.installFetch([salahFixture()]);
    const choice = "اخترنا منصة إكس لأنها الأنسب لتتبّع ما يُكتب عن موضوع رائج في مصر.";
    const withChoice = await plan([s, [use("propose_plan", onX({ platformChoiceAr: choice }))]], request);
    expect(withChoice.outputType, withChoice.contentAr).toBe("propose_plan");
    expect(withChoice.planQuote.items[0].params[MODEL_PLAN_PARAM].platformChoiceAr).toBe(choice);
    // a customer who names the platform needs none (covered by the existing plans)
  });
});

describe("the official channel / page / account is found by the search and shown for confirmation", () => {
  it("a request for «the official …» needs a found entity whose id is in a real sample answer; it is asked for a link only when the search finds nothing", () => {
    expect(["هات ٣ فيديوهات من قناة فيفا الرسمية على يوتيوب", "القناة الرسمية لفيفا", "الصفحة الرسمية لشركة أوبر", "الحساب الرسمي لنادي الأهلي"].map(asksForOfficialEntity)).toEqual([true, true, true, true]);
    expect(["هات ٣ فيديوهات من قناة الجزيرة", "بوستات من حساب @NASA"].map(asksForOfficialEntity)).toEqual([false, false]);
    const request = "هات ٣ فيديوهات من قناة فيفا الرسمية على يوتيوب عن منتخب مصر";
    const body = { data: { channels: [{ channelId: "UCpcTrCXblq78GZrTUTLWeBw", title: "FIFA", subscribers: 8000000 }] } };
    expect(resolveFoundEntities("هات ٥ شركات", [], undefined)).toEqual({ ok: true });
    expect(resolveFoundEntities(request, [body], undefined)).toMatchObject({ ok: false, issue: { code: "entity_not_confirmed" } });
    expect(resolveFoundEntities(request, [body], [{ kindAr: "قناة", nameAr: "FIFA", id: "UCinvented000" }])).toMatchObject({ ok: false, issue: { code: "entity_not_in_sample" } });
    const ok = resolveFoundEntities(request, [body], [{ kindAr: "قناة", nameAr: "FIFA", id: "UCpcTrCXblq78GZrTUTLWeBw" }]);
    expect(ok).toEqual({ ok: true, entities: [{ kindAr: "قناة", nameAr: "FIFA", id: "UCpcTrCXblq78GZrTUTLWeBw" }] });
    // an edit of an approved plan keeps what its own sample found
    expect(resolveFoundEntities(request, [], [{ kindAr: "قناة", nameAr: "FIFA", id: "UCpcTrCXblq78GZrTUTLWeBw" }], true)).toMatchObject({ ok: true });
    const prompt = readFileSync("src/lib/modelPlanner/planner.ts", "utf-8");
    expect(prompt).toContain("THE OFFICIAL CHANNEL, PAGE OR ACCOUNT");
    expect(prompt).toContain("do not ask the customer for a link");
  });
});

describe("the driver notice and the plan panel after approval", () => {
  it("the «you can close the page» notice is sent for ANY model-planned job while the driver is live, and for no job while it is not (unless the job is long)", () => {
    const base = { workerStarted: true, volume: 20, isLongJob: false, isModelPlanned: true };
    expect(shouldSendStartedNotice({ ...base, driver: "cron" })).toBe(true);
    expect(shouldSendStartedNotice({ ...base, driver: "tab" })).toBe(false);
    expect(shouldSendStartedNotice({ ...base, driver: "cron", workerStarted: false })).toBe(false);
    expect(shouldSendStartedNotice({ ...base, isModelPlanned: false, driver: "cron" })).toBe(false);
    expect(shouldSendStartedNotice({ ...base, isModelPlanned: false, isLongJob: true, driver: "tab" })).toBe(true);
    expect(readFileSync("src/app/api/chat/accept-quote/route.ts", "utf-8")).toContain("shouldSendStartedNotice(");
    // the line in the chat stays when the driver is live (a job that ends in seconds must not erase it) and goes with the job otherwise
    expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf-8")).toContain('progressNotice: normalizeDriverMode(data.driverMode) !== "cron"');
  });

  it("the driver is live right after /api/cron/drive wrote its heartbeat and not when the last tick is older than 3 minutes", async () => {
    const { recordDriverTick, liveDriverMode, resetDriverModeCache } = await import("../src/lib/server/driverHeartbeat");
    const { createMemoryDb } = await import("./helpers/memoryDb");
    const db = createMemoryDb();
    resetDriverModeCache();
    expect(await liveDriverMode(db, Date.parse("2026-10-28T09:19:17Z"), {})).toBe("tab"); // nothing written yet
    await recordDriverTick(db, 0, Date.parse("2026-10-28T09:19:00Z"));
    resetDriverModeCache();
    expect(await liveDriverMode(db, Date.parse("2026-10-28T09:19:17Z"), {})).toBe("cron"); // the production heartbeat read 17 s old
    resetDriverModeCache();
    expect(await liveDriverMode(db, Date.parse("2026-10-28T09:23:00Z"), {})).toBe("tab");
    expect(readFileSync("src/app/api/cron/drive/route.ts", "utf-8")).toContain("recordDriverTick(");
  });

  it("a failed or stopped mission keeps every stage on the panel with its state, its count and the honest reason; the panel is pinned on approval and keeps the last good view", () => {
    const stages = [{ titleAr: "جمع الفيديوهات", deliver: true, effVolume: 5 }, { titleAr: "جمع التعليقات", deliver: true, effVolume: 40 }];
    const snaps: ProgressSnap[] = [{ at: 1, delivered: 6, stages: [{ c: 1, d: 0, x: 2, e: 5, q: 0, done: true }, { c: 6, d: 6, x: 0, e: 40, q: 0, done: true }] }];
    const reason = "استلمنا ٦ سجلاً من المصدر لكن لم يطابق أيٌّ منها نطاق طلبك؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
    const failed = missionView({ stages, snaps, phase: "failed", now: 1000, failureReasonAr: reason });
    expect(failed.steps.map((s) => [s.id, s.state])).toEqual([["stage-1", "done"], ["stage-2", "done"], ["review", "stopped"], ["files", "stopped"]]);
    expect(failed.steps[0].countAr).toBeTruthy();
    expect(failed.steps[2].reasonAr).toBe(reason);
    const early = missionView({ stages, snaps: [{ at: 1, delivered: 0, stages: [{ c: 1, d: 0, x: 0, e: 5, q: 0, done: false, stopped: "المصدر لم يرد في الوقت المناسب" }, { c: 0, d: 0, x: 0, e: 40, q: 0, done: false }] }], phase: "failed", now: 1000, failureReasonAr: reason });
    expect(early.steps[0]).toMatchObject({ state: "stopped", reasonAr: "المصدر لم يرد في الوقت المناسب" });
    expect(early.steps[1]).toMatchObject({ state: "stopped" });
    expect(early.steps[1].reasonAr).toBeTruthy();
    const hook = readFileSync("src/hooks/useMissionPanel.ts", "utf-8");
    expect(hook).toContain("lastMission");
    expect(readFileSync("src/app/dashboard/chat/page.tsx", "utf-8")).toContain("changeMissionPanel({ expanded: true, pinned: true })");
    expect(readFileSync("src/lib/missionPanelContent.ts", "utf-8")).toContain('"review_partial"');
  });
});

describe("the other two live jobs, replayed (fixtures built from the catalog's example shapes: marked as such)", () => {
  it("the marriage / divorce mission: the comments of the listed videos are delivered, never moved to «قيد المراجعة» by a reviewer that was given no request", async () => {
    const search1 = loadFixture("catalog-example_anyapi.tiktok.search.videos");
    const comments = loadFixture("catalog-example_tikhub.tiktok.video.comments");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 30, unitPrice: 1 });
    world.installFetch([search1, comments]);
    const r = await plan([sample("anyapi.tiktok.search.videos", [{ name: "query", value: "الجواز والطلاق في مصر", source: "customer_text", quote: "الجواز والطلاق في مصر" }]), sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }]), propose(marriagePlan)], MARRIAGE);
    expect(r.outputType, r.contentAr).toBe("propose_plan");
    const asked: string[] = [];
    setRowAdvisorForTesting(async (input) => { asked.push(input.customerRequest); return { verdicts: new Map(input.rows.map((row) => [row.index, { verdict: String(input.customerRequest).trim() ? "match" : "no_match", reasonAr: "" }])) as any, usage: null, failure: null }; });
    seedFromQuote(r.planQuote.items[0]);
    world.installFetch([search1, comments]);
    const out = await world.runWorker();
    expect(asked.length).toBeGreaterThanOrEqual(1);
    expect(asked.every((q) => q === MARRIAGE)).toBe(true);
    expect(out.json.deliveredUnits).toBeGreaterThanOrEqual(1);
  });

  it("the natgeo profile: one record read as one row (the answer is the record itself), delivered with no review (an account has no topic)", async () => {
    const profile = { name: "inline_natgeo_profile", kind: "catalog example", endpointId: "crawl4ai.instagram.user.profile", costMicro: 900, pages: [{ username: "natgeo", full_name: "National Geographic", followers: 268273892, is_verified: true }] };
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 1, unitPrice: 1 });
    world.installFetch([profile as any]);
    const r = await plan([sample("crawl4ai.instagram.user.profile", [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }]), propose({ summaryAr: "بيانات حساب انستقرام natgeo", steps: [{ endpointId: "crawl4ai.instagram.user.profile", volume: 1, params: [{ name: "username", value: "natgeo", source: "customer_text", quote: "@natgeo" }], fieldMap: { columns: [{ field: "username", headerAr: "اسم المستخدم", role: "author_handle" }, { field: "followers", headerAr: "المتابعون", role: "followers", transform: "number" }], pagination: { kind: "single" } }, filters: [] }] })], "هات بيانات حساب انستقرام @natgeo");
    expect(r.outputType, r.contentAr).toBe("propose_plan");
    let advisorCalls = 0;
    setRowAdvisorForTesting(async () => { advisorCalls += 1; return { verdicts: new Map(), usage: null, failure: null }; });
    seedFromQuote(r.planQuote.items[0]);
    world.installFetch([profile as any]);
    const out = await world.runWorker();
    expect(out.json.deliveredUnits).toBe(1);
    expect(advisorCalls).toBe(0);
  });
});
