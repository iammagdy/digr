import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createMemoryDb, type MemoryDb } from "./helpers/memoryDb";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { loadCustomerMission } from "../src/lib/agentMission/customerActions";
import { customerPlanView, type PricedPlan, type PricedStage, stagePriceInputs, validateAndPricePlan } from "../src/lib/agentMission/plan";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { selfReferenceQuestionAr } from "../src/lib/agentMission/selfReference";
import { pointsAr } from "../src/lib/pointsFormat";
import { POST } from "../src/app/api/calculator/estimate/route";

const fixture = vi.hoisted(() => ({ db: null as MemoryDb | null, viewer: "u1", guest: false }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => fixture.db }));
vi.mock("../src/lib/server/missionViewer", async (original) => ({
  ...(await original<typeof import("../src/lib/server/missionViewer")>()),
  resolveMissionViewer: async () => ({ ok: true, viewer: { userId: fixture.viewer, isGuest: fixture.guest, emailVerified: !fixture.guest } }),
}));

const at = "2026-11-21T06:00:00.000Z";
const missionId = "msn_calculatorfixture";
function world() {
  const db = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: "u1", title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: "u1" }]);
  db.seed("credit_ledger", [{ id: "topup_fixture", user_id: "u1", delta: 40_000 }]);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: ["u1"] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: ["u1"] } }]);
  fixture.db = db;
  return db;
}

beforeEach(() => {
  fixture.viewer = "u1";
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
  const row = { id, user_id: "u1", status: "plan_ready", plan, plan_public: customerPlanView(plan),
    created_at: at, updated_at: at, reserved_points: plan.price.reservePoints };
  const saved = db.rows("missions").find((r) => r.id === id);
  if (saved) Object.assign(saved, row);
  else db.rows("missions").push(row);
}

function noMoney(db: MemoryDb) {
  expect(db.rows("plans_quotes")).toEqual([]);
  expect(db.rows("jobs")).toEqual([]);
  expect(db.rows("credit_ledger")).toEqual([{ id: "topup_fixture", user_id: "u1", delta: 40_000 }]);
}

describe("calculator prices come only from the owned sealed card", () => {
  it.each([
    { build: (plan: PricedPlan) => plan, charge: 622, hold: 715 },
    { build: pricedBasket, charge: 2591, hold: 2980 },
    { build: fundedComments, charge: 207, hold: 752 },
  ])("projects the complete-delivery charge $charge and hold $hold as distinct facts", async ({ build, charge, hold }) => {
    const db = world();
    storeCard(db, build(companyPlan()));
    const expected = await loadCustomerMission(db, { id: missionId, userId: "u1" });
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
  const initial = { userId: "u1", conversationId: "conv1", userBalance: 40_000, isGuest: true, calculatorPlanOnly: true } as const;
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
    userId: "u1", message: "هات ٣٠٠ تغريدة عن محمد صلاح", calculatorPlanOnly: true,
  } as const)).rejects.toThrow();
  expect(db.rows("messages")).toEqual([]);
  expect(db.rows("missions")).toEqual([]);
  noMoney(db);
});
