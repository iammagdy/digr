import { readFileSync } from "fs";
import { join } from "path";
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
const seedFromQuote = (item: any) => world.resetJob({ slug: item.capabilitySlug, endpointId: item.endpointId, params: item.params, target: item.targetVolumeMax, unitPrice: item.unitPricePoints, unitCostUsd: item.unitCostUsd });
/**
 * UL2a-3 C-2a: the chat no longer plans with the model planner (the handler's `modelPlanner` contract is removed), so a job of a model plan is seeded from the quote item the planner used to store (captured once
 * from the pre-removal tree: fixtures/model-planner-stored-items.json). What these tests keep is the WORKER half: the interpreter runs the approved plan, the review, the charge, the recipe.
 */
const STORED: { x: { item: any; quotedPoints: number }; tiktok: { item: any; quotedPoints: number } } = JSON.parse(readFileSync(join(__dirname, "fixtures", "model-planner-stored-items.json"), "utf8"));

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

  it("X account, REAL rows: the worker interprets the approved (stored) plan, 3 own posts delivered, the charge is ceil(delivered x unit) within the hold", async () => {
    const fixture = loadFixture("real-rows_anyapi.x.user.posts");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    world.installFetch([fixture]);
    // (the planning half — the model, the sample call, the validation, the price by code — is retired with the chat's model planner: UL2a-3 C-2a)
    const item = STORED.x.item;
    const holdPoints = STORED.x.quotedPoints;
    expect(holdPoints).toBe(reserveForUnits(10, 0.916667));
    seedFromQuote(item);
    world.installFetch([fixture]);
    const out = await world.runWorker();
    expect(world.stats.realCalls).toBe(0);
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["anyapi.x.user.posts"]);
    expect(out.json.deliveredUnits).toBe(3);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(3, item.unitPricePoints));
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(holdPoints);
    expect(Object.keys(world.stats.served[0].body).sort()).toEqual(["handle", "limit"]);
    // the first raw page is kept (on by default), masked
    expect(world.db.partials.has(`${world.JOB}/raw_first_page.json`)).toBe(true);
  });

  it("(a) the TikTok topic request (stored plan): a listing step then the comments of each listed video; the sources get no date parameter, comments are delivered", async () => {
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
    // (the planning half — the two samples, the validation, no window on the plan — is retired with the chat's model planner: UL2a-3 C-2a)
    const item = STORED.tiktok.item;
    const holdPoints = STORED.tiktok.quotedPoints;
    expect(JSON.stringify(item.params[MODEL_PLAN_PARAM])).not.toMatch(/dateFrom|dateTo|date_window|datePosted|آخر شهر/);

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
    expect(out.json.settle.charged_credits).toBeLessThanOrEqual(holdPoints);
    expect(out.json.settle.charged_credits).toBe(chargeForUnits(out.json.deliveredUnits, item.unitPricePoints));
  });

  it("a RECIPE is saved after the job delivered rows (a template: no customer value), and not before the recipes table exists; the next similar request skips the sample call", async () => {
    const fixture = loadFixture("real-rows_anyapi.x.user.posts");
    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    world.installFetch([fixture]);
    world.mem.setMissing(["recipes"]);
    const firstItem = STORED.x.item;
    seedFromQuote(firstItem);
    world.mem.setMissing(["recipes"]);
    world.installFetch([fixture]);
    const noTable = await world.runWorker();
    expect(noTable.json.deliveredUnits).toBe(3); // the job is not affected by the missing table
    expect(world.mem.rows("recipes")).toHaveLength(0);

    world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 10, unitPrice: 1 });
    seedFromQuote(firstItem);
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
    seedFromQuote(firstItem);
    world.installFetch([fixture]);
    await world.runWorker();
    expect(world.mem.rows("recipes")).toHaveLength(1);

    // (the next similar request, planned by the chat WITHOUT a sample call from the saved recipe, is retired with the chat's model planner: UL2a-3 C-2a)
  });

  it("a reverse lookup step under FX-PRIV: runs without gating for any account and delivers rows", async () => {
    const fixture: ReplayFixture = { name: "inline_reverse_phone", kind: "catalog example", endpointId: "enrichlayer.contacts.reverse-phone", costMicro: 300000, pages: [{ linkedin_profile_url: "https://linkedin.com/in/someone", twitter_profile_url: null, facebook_profile_url: null }] };
    const plan = {
      v: 1, measured: [{ rowsPerCall: 1, passRate: 1, costPerCallUsd: 0.3 }],
      steps: [{ endpointId: "enrichlayer.contacts.reverse-phone", volume: 1, params: [{ name: "phone_number", value: "+201001234567", source: "customer_text", quote: "+201001234567" }], fieldMap: { columns: [{ field: "linkedin_profile_url", headerAr: "رابط الملف", role: "url" }], pagination: { kind: "single" } }, filters: [], facts: { method: "POST", scope: "any_account", limitName: null, limitMax: null, listPath: null, cursorPath: null, itemFields: null, callEstimateUsd: 0.3 } }],
    };
    const params = { [MODEL_PLAN_PARAM]: plan, _purpose: "التواصل مع عميل محتمل" };
    world.resetJob({ slug: MODEL_PLAN_SLUG, endpointId: "enrichlayer.contacts.reverse-phone", params, target: 1, unitPrice: 1650, unitCostUsd: 0.3 });
    world.installFetch([fixture]);
    const res = await world.runWorker();
    expect(world.stats.served.map((s) => s.endpointId)).toEqual(["enrichlayer.contacts.reverse-phone"]);
    expect(res.json.deliveredUnits).toBe(1);
    expect(world.db.rpcCalls.some((c) => c.name === "settle_job_atomic")).toBe(true);
  });
});
