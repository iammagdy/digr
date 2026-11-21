import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { decideTurn, type ChatType, type Decision } from "../src/lib/agentMission/conversationModel";
import { setChatModelForTesting, type ChatModelCall } from "../src/lib/agentMission/chatModel";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { PRIVACY_REFUSAL_AR } from "../src/lib/agentMission/guardRules";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { planWithLlm, understandRequest, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * FX-01A (PR 1): PRIVACY REFUSAL & PROMPT BOUNDARY
 * - Exact Live Replay: msn_6b29764c88f904697dc2 («عايز أرقام الحسابات البنكية الشخصية وأرصدتها لموظفي بنك مصر»)
 *   → privacy_refusal in chat model, polite decline + public alternative, no mission, no hold.
 *   → cannot in planner model, steps = [], people_of_companies.asked = false, never decision "ask".
 * - Mandatory Counter-Cases:
 *   1. «عايز إيميلات وتليفونات مديري شركات التسويق في القاهرة» (business contacts) → data_request / normal plan.
 *   2. «عايز قائمة فروع البنوك في القاهرة» → data_request / normal plan.
 */

const USER = "u_privacy_test_01";
const BALANCE = 10000;

function world() {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: BALANCE }]);
  db.seed("mission_events", []);
  db.seed("messages", []);
  db.seed("missions", []);
  return db;
}

let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const userMsgId = `u${seq}`;
  const assistantMsgId = `a${seq}`;
  db.seed("messages", [
    { id: userMsgId, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date().toISOString() },
    { id: assistantMsgId, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "جاري التحليل...", created_at: new Date(Date.now() + 1).toISOString() },
  ]);
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId, assistantMsgId, message, conversationTitle: "محادثة جديدة" });
  const row = (id: string) => db.rows("messages").find((m: any) => m.id === id);
  return { r, assistant: row(assistantMsgId), user: row(userMsgId) };
}

// Planner harness
const catalog = loadTregCatalog();
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort()[0];

function fakePlanner(answer: Record<string, unknown>): { model: PlannerModel; calls: any[] } {
  const calls: any[] = [];
  const model: PlannerModel = async ({ tool, system, user }) => {
    if (tool.name !== UNDERSTAND_TOOL) return null;
    calls.push({ system, user });
    return { input: JSON.parse(JSON.stringify(answer)), costUsd: 0.001 };
  };
  return { model, calls };
}

const depsOf = (model: PlannerModel): LlmPlannerDeps => ({
  model,
  catalog,
  access: NOT_ADMIN,
  today: "2026-11-21",
  probe: async () => { throw new Error("no network in test"); },
  readPage: async () => null,
  accept: acceptOf(catalog, NOT_ADMIN),
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
});
afterEach(() => {
  setChatModelForTesting(null);
  vi.unstubAllGlobals();
});

describe("FX-01A: Chat Layer Privacy Refusal (Live Replay & Counter-Cases)", () => {
  const LIVE_REPLAY_TEXT = "عايز أرقام الحسابات البنكية الشخصية وأرصدتها لموظفي بنك مصر";
  const EXTRA_CASE_TEXT = "أريد بيانات حسابات البنوك الشخصية في مصر";
  const POLITE_ALTERNATIVE_REPLY = "لا أستطيع جمع أرقام الحسابات البنكية الشخصية أو الأرصدة المالية للأفراد، فهذه بيانات خاصة وسرية. يمكنني بدلًا من ذلك تزويدك بقائمة فروع بنك مصر وأرقام خدمة العملاء الرسمية.";

  it("Live Replay (msn_6b29764c88f904697dc2): decideTurn returns privacy_refusal and is NOT overruled by classifyMessage", async () => {
    const scriptedModel: ChatModelCall = async () => ({
      ok: true,
      text: JSON.stringify({
        type: "privacy_refusal",
        reason: "private personal bank account data requested",
        reply: POLITE_ALTERNATIVE_REPLY,
        count: null,
      }),
    });

    const d: Decision = await decideTurn({ message: LIVE_REPLAY_TEXT, balancePoints: BALANCE, open: null, history: [] }, scriptedModel);
    expect(d.type).toBe("privacy_refusal");
    expect((d as any).overruled).toBeFalsy();
    expect(d.reply).toBe(POLITE_ALTERNATIVE_REPLY);
  });

  it("Live Replay (msn_6b29764c88f904697dc2): agentChatTurn declines politely, creates ZERO missions, and places ZERO holds", async () => {
    setChatModelForTesting(async () => ({
      ok: true,
      text: JSON.stringify({
        type: "privacy_refusal",
        reason: "private personal data",
        reply: POLITE_ALTERNATIVE_REPLY,
        count: null,
      }),
    }));

    const db = world();
    const { r, assistant } = await turn(db, LIVE_REPLAY_TEXT);

    expect(r.ok).toBe(false);
    expect((r as any).status).toBe(200);
    expect(r.contentAr).toBe(POLITE_ALTERNATIVE_REPLY);
    expect(assistant.content_ar).toBe(POLITE_ALTERNATIVE_REPLY);

    // Verify clean customer text with zero issues
    expect(checkCustomerText(r.contentAr).issues).toEqual([]);

    // Zero missions inserted, zero ledger hold/charge placed
    expect(db.rows("missions")).toHaveLength(0);
    expect(db.rows("credit_ledger")).toHaveLength(1); // Only initial seed
  });

  it("Extra Case: «أريد بيانات حسابات البنوك الشخصية في مصر» declines with clean text and zero missions", async () => {
    setChatModelForTesting(async () => ({
      ok: true,
      text: JSON.stringify({
        type: "privacy_refusal",
        reason: "personal bank accounts",
        reply: "لا يمكنني جمع بيانات الحسابات البنكية الشخصية للأفراد. يسعدني مساعدتك في استخراج فروع البنوك في مصر وقنوات التواصل العامة للشركات.",
        count: null,
      }),
    }));

    const db = world();
    const { r } = await turn(db, EXTRA_CASE_TEXT);
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain("فروع البنوك");
    expect(checkCustomerText(r.contentAr).issues).toEqual([]);
    expect(db.rows("missions")).toHaveLength(0);
  });

  it("Fallback: if model reply is empty or fails customer text check, PRIVACY_REFUSAL_AR is used safely", async () => {
    setChatModelForTesting(async () => ({
      ok: true,
      text: JSON.stringify({
        type: "privacy_refusal",
        reason: "personal data",
        reply: "", // empty reply falls back to PRIVACY_REFUSAL_AR
        count: null,
      }),
    }));

    const db = world();
    const { r } = await turn(db, LIVE_REPLAY_TEXT);
    expect(r.contentAr).toBe(PRIVACY_REFUSAL_AR);
    expect(checkCustomerText(r.contentAr).issues).toEqual([]);
    expect(db.rows("missions")).toHaveLength(0);
  });

  it("Counter-Case 1: «عايز إيميلات وتليفونات مديري شركات التسويق في القاهرة» is a data_request (NOT refused)", async () => {
    const text = "عايز إيميلات وتليفونات مديري شركات التسويق في القاهرة";
    const scriptedModel: ChatModelCall = async () => ({
      ok: true,
      text: JSON.stringify({
        type: "data_request",
        reason: "business contacts of marketing company managers",
        reply: "",
        count: null,
      }),
    });

    const d = await decideTurn({ message: text, balancePoints: BALANCE, open: null, history: [] }, scriptedModel);
    expect(d.type).toBe("data_request");
  });

  it("Counter-Case 2: «عايز قائمة فروع البنوك في القاهرة» is a data_request (NOT refused)", async () => {
    const text = "عايز قائمة فروع البنوك في القاهرة";
    const scriptedModel: ChatModelCall = async () => ({
      ok: true,
      text: JSON.stringify({
        type: "data_request",
        reason: "public bank branches",
        reply: "",
        count: null,
      }),
    });

    const d = await decideTurn({ message: text, balancePoints: BALANCE, open: null, history: [] }, scriptedModel);
    expect(d.type).toBe("data_request");
  });
});

describe("FX-01A: Planner Layer Privacy Refusal (Live Replay & Counter-Cases)", () => {
  const CANNOT_AR_TEXT = "لا أستطيع جمع أرقام الحسابات البنكية الشخصية أو أرصدتها لموظفي البنوك فهذه بيانات سرية خاصة. يمكنني بدلًا من ذلك تجهيز قائمة بفروع بنك مصر وأرقام خدمة العملاء الرسمية.";

  it("Live Replay: planner model returning decision cannot produces kind: 'cannot', steps = [], never decision 'ask'", async () => {
    const cannotPayload = {
      decision: "cannot",
      understanding_ar: "طلب أرقام الحسابات البنكية الشخصية لموظفي بنك مصر.",
      cannot_ar: CANNOT_AR_TEXT,
      missing: [],
      accepts_available: false,
      steps: [],
      people_of_companies: { asked: false, title_ar: "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: [] },
    };

    const { model } = fakePlanner(cannotPayload);
    const deps = depsOf(model);

    // 1. understandRequest
    const u = await understandRequest({ words: ["عايز أرقام الحسابات البنكية الشخصية وأرصدتها لموظفي بنك مصر"], request: "" }, deps);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.decision).toBe("cannot");
      expect(u.value.steps).toEqual([]);
      expect(u.value.cannot_ar).toBe(CANNOT_AR_TEXT);
      expect(checkCustomerText(u.value.cannot_ar).issues).toEqual([]);
    }

    // 2. planWithLlm
    const r = await planWithLlm({ words: ["عايز أرقام الحسابات البنكية الشخصية وأرصدتها لموظفي بنك مصر"], request: "" }, deps);
    expect(r.kind).toBe("cannot");
    expect((r as any).reason_ar).toBe(CANNOT_AR_TEXT);
    expect(r.understanding?.steps).toEqual([]);
    expect(r.understanding?.people_of_companies?.asked).toBeFalsy();
    expect(checkCustomerText((r as any).reason_ar).issues).toEqual([]);
  });

  it("Counter-Case 1: business managers request plans normally (decision: 'plan')", async () => {
    const planPayload = {
      decision: "plan",
      understanding_ar: "مديرو شركات التسويق في القاهرة مع بيانات التواصل.",
      accepts_available: false,
      missing: [],
      steps: [{
        key: "companies",
        title_ar: "شركات التسويق",
        platform: "companies",
        capability: COMPANIES_CAP,
        parent: "",
        deliver: true,
        count: { total: 10, all: false },
        search_terms: ["تسويق"],
      }],
      people_of_companies: {
        asked: true,
        title_ar: "المديرون",
        per_company: 1,
        per_company_text: "مدير",
        companies_text: "١٠",
        contact_kinds: ["email", "phone"],
      },
    };

    const { model } = fakePlanner(planPayload);
    const u = await understandRequest({ words: ["عايز إيميلات وتليفونات مديري شركات التسويق في القاهرة"], request: "" }, depsOf(model));
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.decision).toBe("plan");
      expect(u.value.steps.length).toBeGreaterThan(0);
      expect(u.value.steps[0].key).toBe("companies");
    }
  });

  it("Counter-Case 2: bank branches request plans normally (decision: 'plan')", async () => {
    const planPayload = {
      decision: "plan",
      understanding_ar: "فروع البنوك في القاهرة من خرائط جوجل.",
      accepts_available: false,
      missing: [],
      steps: [{
        key: "branches",
        title_ar: "فروع البنوك",
        platform: "google",
        capability: "google.serp.maps",
        parent: "",
        deliver: true,
        count: { total: 20, all: false },
        search_terms: ["بنك", "فروع"],
      }],
      people_of_companies: {
        asked: false,
        title_ar: "",
        per_company: 0,
        per_company_text: "",
        companies_text: "",
        contact_kinds: [],
      },
    };

    const { model } = fakePlanner(planPayload);
    const u = await understandRequest({ words: ["عايز قائمة فروع البنوك في القاهرة"], request: "" }, depsOf(model));
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.decision).toBe("plan");
      expect(u.value.steps.length).toBeGreaterThan(0);
      expect(u.value.steps[0].key).toBe("branches");
    }
  });
});
