import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world, loadFixture, type ReplayFixture } from "./helpers/replayWorld";

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
import { chargeForUnits, reserveForUnits } from "../src/lib/recordPricing";
import { createScriptedTransport, type ContentBlock } from "../src/lib/modelPlanner/transport";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { MODEL_PLAN_PARAM, MODEL_PLAN_SLUG, MODEL_PLANNER_ALLOWED_EMAILS, isModelPlannerAccount } from "../src/lib/modelPlanner/constants";
import { setRowAdvisorForTesting } from "../src/lib/server/rowReviewAdvisor";
import { describe as describeTool, propose, sample, search, xAccountPlan, X_REQUEST } from "./helpers/plannerKit";

let seq = 0;
let infoSpy: any;
const plannerLog = () => infoSpy.mock.calls.map((c: any[]) => String(c[0])).filter((l: string) => l.includes("model_planner_turn")).join(" | ");
async function chat(request: string, script: Array<ContentBlock[]>) {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the old model path must not run"); });
  const transport = createScriptedTransport(script as any, { model: "recorded" });
  handler.modelPlanner = { transport, client: world.mem, today: () => new Date("2026-10-27T12:00:00Z") };
  const conversationId = `conv_mp_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const r: any = await handler.handleUserMessage({ userId: "user_replay", userEmail: "magdy.saber@outlook.com", conversationId, message: request, userBalance: 40_000 });
  return { r, transport, db, handler };
}
const seedFromQuote = (item: any) => world.resetJob({ slug: item.capabilitySlug, endpointId: item.endpointId, params: item.params, target: item.targetVolumeMax, unitPrice: item.unitPricePoints, unitCostUsd: item.unitCostUsd });

describe("the model planner, end to end on the replay world (the gateway is a stub: zero real provider calls)", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "replay-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development"; process.env.TREG_LIVE = "true"; process.env.TREG_TOKEN = "replay-not-a-real-token";
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); setProviderAdapterForTesting(defaultTregAdapter);
    resetExplorationMemoryForTesting();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); setProviderAdapterForTesting(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetProviderBalanceCacheForTesting(); });

  it("ROLLOUT is by account: only the two allowlisted e-mails take the model path (case-insensitive, exact); everyone else, a guest and a missing e-mail keep the old path", () => {
    expect([...MODEL_PLANNER_ALLOWED_EMAILS]).toEqual(["magdy.saber@outlook.com", "iam.magdy+1@outlook.com"]);
    expect(isModelPlannerAccount({ email: "magdy.saber@outlook.com" })).toBe(true);
    expect(isModelPlannerAccount({ email: "iam.magdy+1@outlook.com" })).toBe(true);
    expect(isModelPlannerAccount({ email: "  Magdy.Saber@Outlook.com " })).toBe(true);
    for (const email of ["iam.magdy@outlook.com", "iam.magdy+2@outlook.com", "magdy.saber@outlook.com.evil.com", "xmagdy.saber@outlook.com", "", null, undefined]) expect(isModelPlannerAccount({ email }), String(email)).toBe(false);
    expect(isModelPlannerAccount({ email: "magdy.saber@outlook.com", isGuest: true })).toBe(false);
    expect(isModelPlannerAccount(null)).toBe(false);
  });

  it("X account, REAL rows: chat plans it from the catalog (the model, a sample call, validation, price by code), the worker interprets the approved plan, 3 own posts delivered, the charge is ceil(delivered x unit) within the hold", async () => {
    const fixture = loadFixture("real-rows_anyapi.x.user.posts");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    world.installFetch([fixture]);
    const { r, transport } = await chat(X_REQUEST, [search("x", ["user", "posts"]), describeTool("anyapi.x.user.posts"), sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())]);
    expect(r.outputType).toBe("propose_plan");
    expect(transport.requests).toHaveLength(4);
    const quote = r.planQuote;
    const item = quote.items[0];
    expect(item.capabilitySlug).toBe(MODEL_PLAN_SLUG);
    expect(item.endpointId).toBe("anyapi.x.user.posts");
    expect(Object.keys(item.params).every((k) => k.startsWith("_"))).toBe(true);
    // no period of any kind in the plan
    expect(JSON.stringify(item.params)).not.toMatch(/dateFrom|dateTo|date_window|datePosted|since:|until:/);
    // the price: the shared function of the cost per delivered record measured on the sample (0.0005 per call, 10 rows, 3 pass)
    expect(item.unitPricePoints).toBe(0.916667);
    expect(quote.quotedPoints).toBe(reserveForUnits(10, 0.916667));
    expect(quote.modelPlanned).toBe(true);
    expect(quote.sampleRows.rows).toHaveLength(3);
    expect(quote.sampleRows.columns.map((c: any) => c.titleAr)).toEqual(["نص المنشور", "الحساب", "تاريخ النشر", "الإعجابات", "الرابط"]);
    // tokens and cost of the planning turn, at the planner's own price
    expect(r.tokensUsed.input).toBeGreaterThan(1000);
    expect(r.tokensUsed.costUsd).toBeCloseTo((r.tokensUsed.input * 0.10 + r.tokensUsed.output * 0.50) / 1_000_000, 9);

    seedFromQuote(item);
    world.installFetch([fixture]);
    const out = await world.runWorker();
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["anyapi.x.user.posts"]);
    expect(out.json.deliveredUnits).toBe(3);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(3, item.unitPricePoints));
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(quote.quotedPoints);
    expect(Object.keys(world.stats.served[0].body).sort()).toEqual(["handle", "limit"]);
    // the first raw page is kept (on by default), masked
    expect(world.db.partials.has(`${world.JOB}/raw_first_page.json`)).toBe(true);
  });

  it("(a) the TikTok topic request: a listing step then the comments of each listed video; NO window is added, the sources get no date parameter, comments are delivered", async () => {
    const search1 = loadFixture("catalog-example_anyapi.tiktok.search.videos");
    const comments = loadFixture("catalog-example_tikhub.tiktok.video.comments");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 30, unitPrice: 1 });
    world.installFetch([search1, comments]);
    const request = "هات ٣٠ تعليق تيك توك عن كرة السلة في مصر";
    const twoStep = {
      summaryAr: "جمع ٣٠ تعليقًا عن كرة السلة في مصر على تيك توك", topic: "كرة السلة في مصر",
      steps: [
        { endpointId: "anyapi.tiktok.search.videos", volume: 30, params: [{ name: "query", value: "كرة السلة في مصر", source: "customer_text", quote: "كرة السلة في مصر" }], fieldMap: { columns: [{ field: "id", headerAr: "معرف المقطع", role: "id" }, { field: "caption", headerAr: "وصف المقطع", role: "title" }], pagination: { kind: "token", param: "cursor" } } },
        { endpointId: "tikhub.tiktok.video.comments", volume: 30, perItem: 10, params: [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }], fieldMap: { columns: [{ field: "text", headerAr: "نص التعليق", role: "text" }, { field: "digg_count", headerAr: "الإعجابات", role: "likes", transform: "number" }], pagination: { kind: "single" } } },
      ],
    };
    const { r } = await chat(request, [search("tiktok", ["comments"]), search("tiktok", ["search", "videos"]), sample("anyapi.tiktok.search.videos", [{ name: "query", value: "كرة السلة في مصر", source: "customer_text", quote: "كرة السلة في مصر" }]), sample("tikhub.tiktok.video.comments", [{ name: "aweme_id", source: "prior_step", fromStep: { step: 1, field: "id" } }]), propose(twoStep)]);
    expect(r.outputType, `${r.contentAr} ${plannerLog()}`).toBe("propose_plan");
    const item = r.planQuote.items[0];
    const stored = item.params[MODEL_PLAN_PARAM];
    expect(stored.steps).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toMatch(/dateFrom|dateTo|date_window|datePosted|آخر شهر/);
    expect(r.planQuote.window).toBeUndefined();
    // the two sample calls and nothing else were asked of the sources before approval
    const planningRequests = world.stats.served.map((s) => s.endpointId);
    expect(planningRequests).toEqual(["anyapi.tiktok.search.videos", "tikhub.tiktok.video.comments"]);
    for (const s of world.stats.served) expect(Object.keys(s.body)).not.toEqual(expect.arrayContaining(["datePosted"]));

    // the topic review: the reviewer gets the customer's REAL request text and confirms the rows (fail closed otherwise)
    const reviewed: any[] = [];
    setRowAdvisorForTesting(async (given) => { reviewed.push(given); return { verdicts: new Map(given.rows.map((row) => [row.index, { verdict: "match", reasonAr: "" }])) as any, usage: { inputTokens: 800, outputTokens: 40, costUsd: 0.0001, model: "claude-haiku-5-5", latencyMs: 300 }, failure: null }; });
    seedFromQuote(item);
    world.installFetch([search1, comments]);
    const out = await world.runWorker();
    setRowAdvisorForTesting(null);
    expect(world.stats.realCalls).toBe(0);
    expect(reviewed.length).toBeGreaterThanOrEqual(1);
    expect(reviewed[0].customerRequest).toBe(request);
    expect(out.json.deliveredUnits).toBeGreaterThanOrEqual(1);
    for (const s of world.stats.served) expect(JSON.stringify(s.body)).not.toMatch(/date|since|until|window/i);
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(r.planQuote.quotedPoints);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(out.json.deliveredUnits, item.unitPricePoints));
  });

  it("a RECIPE is saved after the job delivered rows (a template: no customer value), and not before the recipes table exists; the next similar request skips the sample call", async () => {
    const fixture = loadFixture("real-rows_anyapi.x.user.posts");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    world.installFetch([fixture]);
    world.mem.setMissing(["recipes"]);
    const first = await chat(X_REQUEST, [sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())]);
    seedFromQuote(first.r.planQuote.items[0]);
    world.mem.setMissing(["recipes"]);
    world.installFetch([fixture]);
    const noTable = await world.runWorker();
    expect(noTable.json.deliveredUnits).toBe(3); // the job is not affected by the missing table
    expect(world.mem.rows("recipes")).toHaveLength(0);

    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    seedFromQuote(first.r.planQuote.items[0]);
    world.mem.setMissing([]);
    world.installFetch([fixture]);
    const delivered = await world.runWorker();
    expect(delivered.json.deliveredUnits).toBe(3);
    const recipes = world.mem.rows("recipes");
    expect(recipes).toHaveLength(1);
    expect(recipes[0]).toMatchObject({ status: "draft", endpoint_id: "anyapi.x.user.posts", version: 1, created_by: "agent" });
    expect(recipes[0].slug).toMatch(/^auto-anyapi-x-user-posts-[0-9a-f]{8}$/);
    expect(JSON.stringify(recipes[0])).not.toMatch(/elonmusk/); // the customer's account is a slot, not a stored value
    expect(recipes[0].params_template.steps[0].handle).toEqual({ from: "customer_text" });
    expect(recipes[0].price_basis.measured[0]).toMatchObject({ rowsPerCall: 10, passRate: 0.3 });
    // a second job of the same plan saves nothing new
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    seedFromQuote(first.r.planQuote.items[0]);
    world.installFetch([fixture]);
    await world.runWorker();
    expect(world.mem.rows("recipes")).toHaveLength(1);

    // the next similar request: the model describes the endpoint, sees the recipe, and plans WITHOUT a sample call
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    world.mem.seed("recipes", recipes);
    world.installFetch([fixture]);
    const nextRequest = "اعطني ١٠ منشورات من حساب @NASA على إكس";
    const plan2 = xAccountPlan({ summaryAr: "جمع ١٠ منشورات من حساب @NASA" });
    (plan2.steps[0] as any).params = [{ name: "handle", value: "NASA", source: "customer_text", quote: "@NASA" }];
    (plan2.steps[0] as any).filters = [{ kind: "author_equals", field: "authorHandle", value: "NASA", quote: "@NASA" }, { kind: "exclude_true", field: "isReply" }];
    const second = await chat(nextRequest, [describeTool("anyapi.x.user.posts"), propose(plan2)]);
    expect(second.r.outputType, `${second.r.contentAr} ${plannerLog()}`).toBe("propose_plan");
    expect(world.stats.served).toHaveLength(0); // no sample call, nothing asked of any source
    expect(second.r.planQuote.sampleRows).toBeUndefined(); // no real rows to show without a sample
  });

  it("a SENSITIVE step in an approved job: an unverified account never reaches the source (zero requests, the reserve is released with the verified-business sentence); a verified account with a purpose does, with one audit row", async () => {
    const fixture: ReplayFixture = { name: "inline_reverse_phone", kind: "catalog example", endpointId: "enrichlayer.contacts.reverse-phone", costMicro: 300000, pages: [{ linkedin_profile_url: "https://linkedin.com/in/someone", twitter_profile_url: null, facebook_profile_url: null }] };
    const plan = {
      v: 1, measured: [{ rowsPerCall: 1, passRate: 1, costPerCallUsd: 0.3 }],
      steps: [{ endpointId: "enrichlayer.contacts.reverse-phone", volume: 1, params: [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }], fieldMap: { columns: [{ field: "linkedin_profile_url", headerAr: "رابط الملف", role: "url" }], pagination: { kind: "single" } }, filters: [], facts: { method: "POST", scope: "any_account", limitName: null, limitMax: null, listPath: null, cursorPath: null, itemFields: null, callEstimateUsd: 0.3 } }],
    };
    const params = { [MODEL_PLAN_PARAM]: plan, _purpose: "التواصل مع عميل محتمل" };
    world.resetJob({ slug: MODEL_PLAN_SLUG, endpointId: "enrichlayer.contacts.reverse-phone", params, target: 1, unitPrice: 1650, unitCostUsd: 0.3 });
    world.installFetch([fixture]);
    const denied = await world.runWorker();
    expect(world.stats.served).toHaveLength(0);
    expect(denied.json.released).toBe(true);
    expect(String(world.db.rpcCalls.find((c) => c.name === "release_job_atomic")!.args.p_error_message)).toContain("حسابات الأعمال الموثّقة");
    expect(world.db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(false);

    world.resetJob({ slug: MODEL_PLAN_SLUG, endpointId: "enrichlayer.contacts.reverse-phone", params, target: 1, unitPrice: 1650, unitCostUsd: 0.3 });
    world.mem.seed("verified_business_accounts", [{ user_id: "user_1", verified: true }]);
    world.installFetch([fixture]);
    const allowed = await world.runWorker();
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["enrichlayer.contacts.reverse-phone"]);
    expect(allowed.json.deliveredUnits).toBe(1);
    const audit = world.mem.rows("sensitive_lookup_audit");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ account_id: "user_1", endpoint_id: "enrichlayer.contacts.reverse-phone", endpoint_category: "reverse_lookup", masked_value: "***567", purpose: "التواصل مع عميل محتمل", outcome: "called" });
    // the raw page of a sensitive endpoint keeps no personal value
    const raw = JSON.parse(world.db.partials.get(`${world.JOB}/raw_first_page.json`)!.toString("utf-8"));
    expect(JSON.stringify(raw.body)).not.toContain("linkedin.com/in/someone");
  });

  it("BOTH SIDES of the rollout: an allowlisted account is planned by the model (transport asked); any other account is planned by the hand-coded path, byte for byte, and the planner transport is never asked", async () => {
    const run = async (email: string | null) => {
      const db: any = createChatDb();
      const handler = new ChatHandler(db);
      (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
      const transport = createScriptedTransport([[{ type: "text", text: "ما اسم الحساب؟" }]], { model: "recorded" });
      handler.modelPlanner = { transport, client: world.mem, today: () => new Date("2026-10-27T12:00:00Z") };
      const conversationId = `conv_roll_${++seq}`;
      await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
      clearBriefCacheForTesting();
      const r: any = await handler.handleUserMessage({ userId: "user_replay", ...(email ? { userEmail: email } : {}), conversationId, message: X_REQUEST, userBalance: 40_000 });
      return { r, transport };
    };
    const other = await run("someone.else@outlook.com");
    expect(other.transport.requests).toHaveLength(0);
    expect(other.r.outputType).toBe("propose_plan");
    expect(other.r.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
    expect(other.r.planQuote.modelPlanned).toBeUndefined();
    const none = await run(null);
    expect(none.transport.requests).toHaveLength(0);
    expect(none.r.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
    const allowed = await run("iam.magdy+1@outlook.com");
    expect(allowed.transport.requests.length).toBeGreaterThan(0);
    expect(allowed.r.planQuote?.items?.[0]?.capabilitySlug).not.toBe("social-x-posts");
    // the default handler of production holds a real planner config but the allowlist decides
    expect(new ChatHandler(createChatDb()).modelPlannerFor({ email: "other@x.com" })).toBe(false);
  });
});
