import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { fakeMoneyClient, quoteJobId } from "./helpers/agentMoney";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { advanceMissionDelivery } from "../agent/src/missionSettlement";
import { buildMissionFiles } from "../agent/src/workbook";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { customerPlanView, type PricedPlan, type PricedStage, stagePriceInputs, validateAndPricePlan } from "../src/lib/agentMission/plan";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { selfReferenceQuestionAr } from "../src/lib/agentMission/selfReference";
import { pointsAr } from "../src/lib/pointsFormat";
import { POST } from "../src/app/api/calculator/estimate/route";

const { fixture, owner } = vi.hoisted(() => {
  const owner = "00000000-0000-0000-0000-0000000000aa";
  return { owner, fixture: { db: null as MemoryDb | null, viewer: owner, guest: false } };
});
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => fixture.db }));
vi.mock("../src/lib/server/missionViewer", async (original) => ({
  ...(await original<typeof import("../src/lib/server/missionViewer")>()),
  resolveMissionViewer: async () => ({ ok: true, viewer: { userId: fixture.viewer, isGuest: fixture.guest, emailVerified: !fixture.guest } }),
}));

const at = "2026-11-21T06:00:00.000Z";
const missionId = "msn_calculatorfixture";
function world() {
  const db = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: owner, title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: owner }]);
  db.seed("credit_ledger", [{ id: "topup_fixture", user_id: owner, delta: 40_000 }]);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [owner] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [owner] } }]);
  fixture.db = db;
  return db;
}

beforeEach(() => {
  fixture.viewer = owner;
  fixture.guest = false;
  vi.stubEnv("JOB_MAX_POINTS_CAP", "");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
});
afterEach(() => {
  setChatModelForTesting(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function request(body: unknown) {
  return POST(new NextRequest("http://localhost/api/calculator/estimate", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
}

function companyPlan() {
  const endpointId = "treg.aiark.company.search";
  const checked = validateAndPricePlan({
    summary_ar: "ستحصل على شركات المقاولات.",
    stages: [{
      key: "companies", title_ar: "الشركات", endpoint_id: endpointId, expected_rows: 20, parent_key: null, deliver: true,
      columns: [{ key: "name", title_ar: "الاسم" }, { key: "created_at", title_ar: "التاريخ" }],
      sample_rows: [{ name: "شركة مثال", created_at: at }], measured_by: ["call_0001"], filters: [{ kind: "period", days: 30 }],
    }],
  }, {
    call: () => ({ id: "call_0001", endpointId, ok: true, costUsd: 0.05, rows: 10 }),
    evidenceText: () => `شركة مثال ${at}`,
    endpointAllowed: () => true,
  });
  if (!checked.ok) throw new Error(checked.issues.join(", "));
  return checked.plan;
}

function pricedBasket(base: PricedPlan): PricedPlan {
  const root = { ...base.stages[0], planned_rows: 10, expected_rows: 10, measured_cost_per_row_usd: 0.018 };
  const people: PricedStage = { ...root, key: "people", title_ar: "المسؤولون", parent_key: root.key, per_parent_rows: 1, role_preference: { role: "manager" }, measured_cost_per_row_usd: 0.01643 };
  const stages = [root, people];
  const contact_steps: NonNullable<PricedPlan["contact_steps"]> = [
    { stage_key: people.key, kind: "email", column_key: "email", status_key: "email_status", per_person_usd: 0.004, finders: [] },
    { stage_key: people.key, kind: "phone", column_key: "phone", status_key: "phone_status", per_person_usd: 0.006, finders: [] },
  ];
  return { ...base, stages, contact_steps, price: priceMissionByCode(stagePriceInputs(stages, contact_steps)) };
}

function fundedComments(base: PricedPlan): PricedPlan {
  const stages: PricedStage[] = [
    { ...base.stages[0], key: "posts", title_ar: "منشورات", planned_rows: 20, expected_rows: 20,
      deliver: false, measured_cost_per_row_usd: 0.002 / 3, execution_funding: [{ rowsPerPage: 3, callUsdMicro: 2000, mode: "paged" }] },
    { ...base.stages[0], key: "comments", title_ar: "تعليقات", parent_key: "posts", planned_rows: 200, expected_rows: 200,
      measured_cost_per_row_usd: 0.00188 / 2, listed_rate: { unitPoints: 1.034, nounAr: "تعليق" }, execution_funding: [{ rowsPerPage: 2, callUsdMicro: 1880, mode: "paged" }] },
  ];
  return { ...base, stages, price: priceMissionByCode(stagePriceInputs(stages)) };
}

function storeCard(db: MemoryDb, plan: PricedPlan, id = missionId) {
  const row = { id, user_id: owner, status: "plan_ready", plan, plan_public: customerPlanView(plan),
    created_at: at, updated_at: at, reserved_points: plan.price.reservePoints };
  const saved = db.rows("missions").find((r) => r.id === id);
  if (saved) Object.assign(saved, row);
  else db.rows("missions").push(row);
}

function noMoney(
  db: MemoryDb,
  expectedLedger: Array<Record<string, unknown>> = [{ id: "topup_fixture", user_id: owner, delta: 40_000 }],
) {
  expect(db.rows("plans_quotes")).toEqual([]);
  expect(db.rows("jobs")).toEqual([]);
  expect(db.rows("credit_ledger")).toEqual(expectedLedger);
}

describe("calculator prices come only from the owned sealed card", () => {
  it.each([
    { build: (plan: PricedPlan) => plan, charge: 622, hold: 715 },
    { build: pricedBasket, charge: 2591, hold: 2980 },
    { build: fundedComments, charge: 207, hold: 752 },
  ])("projects the complete-delivery charge $charge and hold $hold as distinct facts", async ({ build, charge, hold }) => {
    const db = world();
    storeCard(db, build(companyPlan()));
    const expected = await loadCustomerMission(db, { id: missionId, userId: owner });
    if (!expected.ok) throw new Error(expected.error);
    const response = await request({ missionIds: [missionId] });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.cards[0].card.priceFacts).toEqual(expected.view.priceFacts);
    expect(result.cards[0].card.priceFacts).toEqual(expect.arrayContaining([
      { labelAr: "السعر حتى", valueAr: pointsAr(charge) },
      { labelAr: "حجز مؤقت", valueAr: pointsAr(hold) },
    ]));
    expect(response.headers.get("cache-control")).toContain("no-store");
    noMoney(db);
  });

  it("keeps all figures private when any requested card is foreign and rejects guessed input", async () => {
    const db = world();
    storeCard(db, companyPlan());
    db.rows("missions").push({ id: "msn_foreignfixture", user_id: "u2", status: "plan_ready" });
    const denied = await request({ missionIds: [missionId, "msn_foreignfixture"] });
    expect(denied.status).toBe(404);
    expect(await denied.json()).not.toHaveProperty("cards");
    expect((await request({ text: "هات ٢٠ شركة" })).status).toBe(400);
    noMoney(db);
  });

  it("reproduces 746 / 858 at markup 12, tracks a saved edit, guest preview, unaffordable wallet, and 429 Retry-After", async () => {
    const db = world();
    const base = companyPlan();
    const repriced: PricedPlan = {
      ...base,
      price: priceMissionByCode(stagePriceInputs(base.stages), { settings: { markup: 12, minChargePoints: 200 } }),
    };
    storeCard(db, repriced);
    fixture.guest = true;
    const guestRes = await request({ missionIds: [missionId] });
    expect(guestRes.status).toBe(200);
    const guestJson = await guestRes.json();
    expect(guestJson.cards[0].card.priceFacts).toEqual(expect.arrayContaining([
      { labelAr: "السعر حتى", valueAr: pointsAr(746) },
      { labelAr: "حجز مؤقت", valueAr: pointsAr(858) },
    ]));

    fixture.guest = false;
    const edited = applyPlanEdits(repriced, { count: 10 });
    if (!edited.ok) throw new Error(edited.errorAr);
    storeCard(db, edited.plan);
    const editedRes = await request({ missionIds: [missionId] });
    const editedJson = await editedRes.json();
    expect(editedJson.cards[0].card.priceFacts).toEqual(expect.arrayContaining([
      { labelAr: "السعر حتى", valueAr: pointsAr(edited.plan.price.maxChargePoints) },
      { labelAr: "حجز مؤقت", valueAr: pointsAr(edited.plan.price.reservePoints) },
    ]));

    db.seed("credit_ledger", [{ id: "topup_small", user_id: owner, delta: 199 - 40_000 }]);
    const overLimit = await request({ missionIds: [missionId] });
    const overJson = await overLimit.json();
    expect(overJson.cards[0].card.affordability).toMatchObject({ mode: "top_up" });

    let limited: Response | null = null;
    for (let i = 0; i <= 305; i += 1) {
      const r = await POST(new NextRequest("http://localhost/api/calculator/estimate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.77" },
        body: JSON.stringify({ missionIds: [missionId] }),
      }));
      if (r.status === 429) { limited = r; break; }
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
    noMoney(db, [
      { id: "topup_fixture", user_id: owner, delta: 40_000 },
      { id: "topup_small", user_id: owner, delta: 199 - 40_000 },
    ]);
  });
});

function scriptBriefs(...briefs: Array<Record<string, unknown>>) {
  setChatModelForTesting(async () => {
    const brief = briefs.shift();
    return brief ? { ok: true, text: JSON.stringify({ type: "data_request", reason: "fixture", reply: "", count: null, brief }), usage: { inputTokens: 100, outputTokens: 20 } } : { ok: false, failure: "http_529" };
  });
}

const brief = (request: string, status: "ready" | "needs_clarification") => ({
  status, platforms: [], count: null, topic: "شركات سياحة", period: "", country: "", language: "",
  content: ["companies"], request, objectives: [{ id: "o1", operation: "companies.discover", platform: null, parent: null, contacts: [], what: request }],
});

it("answers a calculator clarification before creating a mission, then retains its conversation and card", async () => {
  const db = world();
  const handler = new ChatHandler(db as never);
  handler.agentChat = { enabled: true };
  const text = "محتاج معلومات عن منافسين شركتي";
  const clarified = "شركات السياحة المنافسة في الغردقة";
  scriptBriefs(brief(text, "needs_clarification"), brief(clarified, "ready"));
  const initial = { userId: owner, conversationId: "conv1", userBalance: 40_000, isGuest: true, calculatorPlanOnly: true } as const;
  const question = await handler.handleUserMessage({ ...initial, message: text });
  expect(question).toMatchObject({ conversationId: "conv1", contentAr: selfReferenceQuestionAr("company"), calculatorReplyScope: "single" });
  expect(question).not.toHaveProperty("agentMission");
  expect(db.rows("missions")).toEqual([]);
  noMoney(db);
  const answer = await handler.handleUserMessage({ ...initial, message: "شركة سياحة في الغردقة" });
  expect(answer.conversationId).toBe(question.conversationId);
  expect(answer.agentMission?.id).toBe(db.rows("missions")[0].id);
  expect(db.rows("missions")).toHaveLength(1);
  noMoney(db);
});

it("keeps an agent-only request out of legacy planning when the agent is disabled", async () => {
  const db = world();
  const handler = new ChatHandler(db as never);
  handler.agentChat = { enabled: false };
  await expect(handler.handleUserMessage({
    userId: owner, message: "هات ٣٠٠ تغريدة عن محمد صلاح", calculatorPlanOnly: true,
  } as const)).rejects.toThrow();
  expect(db.rows("messages")).toEqual([]);
  expect(db.rows("missions")).toEqual([]);
  noMoney(db);
});

it("keeps a split summary with one unresolved part and retains existing owned cards on follow-up", async () => {
  const db = world();
  const handler = new ChatHandler(db as never);
  handler.agentChat = { enabled: true };
  scriptBriefs(
    {
      status: "ready", platforms: [], count: null, topic: "منافسين شركتي وقطاع التجزئة", period: "", country: "", language: "",
      content: ["companies", "articles"], request: "منافسين شركتي وأخبار التجزئة في مصر",
      objectives: [
        { id: "o1", operation: "companies.discover", platform: null, parent: null, contacts: [], request: "منافسين شركتي", what: "منافسين شركتي" },
        { id: "o2", operation: "web.search", platform: null, parent: null, contacts: [], request: "أخبار التجزئة في مصر", what: "أخبار التجزئة" },
      ],
    },
    {
      status: "ready", platforms: [], count: null, topic: "شركات السياحة وأخبار التجزئة", period: "", country: "", language: "",
      content: ["companies", "articles"], request: "إحنا شركة سياحة في الغردقة",
      objectives: [
        { id: "o1", operation: "companies.discover", platform: null, parent: null, contacts: [], request: "شركات السياحة في الغردقة", what: "شركات سياحة" },
        { id: "o2", operation: "web.search", platform: null, parent: null, contacts: [], request: "أخبار التجزئة في مصر", what: "أخبار التجزئة" },
      ],
    },
  );
  const base = { userId: owner, conversationId: "conv1", userBalance: 40_000, calculatorPlanOnly: true } as const;
  const first = await handler.handleUserMessage({ ...base, message: "عايز منافسين شركتي وأخبار التجزئة في مصر" });
  expect(first).toMatchObject({ conversationId: "conv1", calculatorReplyScope: "split" });
  expect(first.contentAr).toContain(selfReferenceQuestionAr("company"));
  const initialMissions = db.rows("missions").map((m) => m.id);
  expect(initialMissions).toHaveLength(1);

  const followUp = await handler.handleUserMessage({ ...base, message: "إحنا شركة سياحة في الغردقة" });
  expect(followUp).toMatchObject({ conversationId: "conv1", calculatorReplyScope: "split" });
  expect(db.rows("missions").map((m) => m.id)).toEqual(expect.arrayContaining(initialMissions));
  expect(db.rows("missions")).toHaveLength(2);
  noMoney(db);
});

it("never enters modelPlanner or pending session for marked calculator turns even when modelPlanner is configured", async () => {
  const db = world();
  const handler = new ChatHandler(db as never);
  handler.agentChat = { enabled: true };
  const transport = vi.fn(async () => ({ stopReason: "end_turn", text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }));
  handler.modelPlannerFor = () => true;
  handler.modelPlanner = {
    transport: { model: "fixture", call: transport } as never,
    limits: { maxSteps: 4, wallMs: 5_000, llmBudgetUsd: 0.05 },
  } as never;
  scriptBriefs(brief("عايز ٢٠ شركة مقاولات", "ready"));
  const res = await handler.handleUserMessage({
    userId: owner, conversationId: "conv1", userBalance: 40_000,
    message: "عايز ٢٠ شركة مقاولات", calculatorPlanOnly: true,
  });
  expect(res.outputType).toBe("agent_mission");
  expect(transport).not.toHaveBeenCalled();
  expect(db.rows("missions")).toHaveLength(1);
  noMoney(db);
});

it.each([
  { count: 162, expectedCharge: 168, expectedRefund: 584, debits: 1 },
  { count: 0, expectedCharge: 0, expectedRefund: 752, debits: 0 },
])("settles funded comments parity replay at $count delivered rows ($expectedCharge charged / $expectedRefund refunded)", async ({ count, expectedCharge, expectedRefund, debits }) => {
  const plan = fundedComments(companyPlan());
  const start = Date.now();
  const store = createMemoryStore();
  const money = fakeMoneyClient({ balance: 2_000 });
  const quoteId = `quote_fx_m2_${count}`;
  const msnId = `msn_fx_m2_${count}`;
  const jobId = quoteJobId(quoteId);
  await money.client.rpc("create_quote_atomic", {
    p_quote_id: quoteId, p_user_id: owner, p_quote_hash: "c".repeat(64), p_total_points: plan.price.reservePoints,
    p_items: [{ endpointId: "agent-mission", missionId: msnId, unitPricePoints: plan.price.unitPricePoints, targetVolumeMin: 1, targetVolumeMax: plan.price.deliveredRows }],
    p_output_formats: ["xlsx", "csv"], p_expires_at: new Date(start + 3_600_000).toISOString(),
  });
  await money.client.rpc("accept_quote_atomic", { p_quote_id: quoteId, p_user_id: owner, p_expected_quote_hash: "c".repeat(64) });
  await money.client.rpc("claim_job_chunk", { p_job_id: jobId, p_expected_step: 0, p_lease_seconds: 21_600 });
  const mission = newMission({
    id: msnId, user_id: owner, request_text: "٢٠٠ تعليق", plan, status: "executing",
    worker_id: "w1", job_id: jobId, quote_id: quoteId,
    lease_until: new Date(start + 120_000).toISOString(),
    reserved_points: plan.price.reservePoints, unit_price_points: plan.price.unitPricePoints,
  });
  store.missions.set(msnId, mission);
  money.bindDeliveryMissions({
    get: (id) => store.missions.get(id),
    park: (id, due) => Object.assign(store.missions.get(id)!, { status: "approved", worker_id: null, lease_until: due }),
  });
  const comments = Array.from({ length: count }, (_, i) => ({ name: `ع${i}`, created_at: at }));
  const deps = { store, client: money.client, ownerId: "w1" };
  const settle = await advanceMissionDelivery(deps, { ...mission }, async () => ({
    workbook: count === 0 ? null : await buildMissionFiles(plan, { posts: [], comments }),
    notes: { date: "2026-11-22", llm: 0, executionTregUsd: 0, summary: null, outputError: null, costUsd: 0 },
  }));
  expect(settle).toMatchObject({ receipt: { physical_units: count, charged_credits: expectedCharge, refunded_credits: expectedRefund } });
  const dup = await advanceMissionDelivery(deps, { ...mission });
  expect(dup).toMatchObject({ receipt: { physical_units: count, charged_credits: expectedCharge, refunded_credits: expectedRefund } });
  expect(money.ledger.filter((e) => e.job_id === jobId && e.type === "charge")).toHaveLength(debits);
  expect(money.ledger.filter((e) => e.job_id === jobId && e.type === "release")).toHaveLength(1);
});
