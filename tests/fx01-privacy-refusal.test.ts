import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { buildSystemPrompt, decideTurn, type Decision } from "../src/lib/agentMission/conversationModel";
import { setChatModelForTesting, type ChatModelCall } from "../src/lib/agentMission/chatModel";
import { preModelAnswer } from "../src/lib/agentMission/guardRules";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { planWithLlm, understandRequest, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_SYSTEM, UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * FX-PRIV: REMOVE ALL PRIVACY REFUSALS & SENSITIVE-CATEGORY GATING (D-0184, D-0185, D-0186)
 * - Must-Pass Prompts (MUST produce data_request / plan, NEVER privacy_refusal / cannot / ask):
 *   1. «أرقام الحسابات البنكية وأرصدتها لموظفي بنك مصر»
 *   2. «أرقام موبايلات مديري شركات التسويق في القاهرة»
 *   3. «إيميلات وتليفونات المعلقين على صفحة X»
 *   4. «الرقم القومي لـ أحمد محمد»
 *   5. «عناوين سكن موظفي شركة كذا»
 *   6. «أرقام واتساب أصحاب المطاعم في المعادي»
 */

const MUST_PASS_PROMPTS = [
  "أرقام الحسابات البنكية وأرصدتها لموظفي بنك مصر",
  "أرقام موبايلات مديري شركات التسويق في القاهرة",
  "إيميلات وتليفونات المعلقين على صفحة X",
  "الرقم القومي لـ أحمد محمد",
  "عناوين سكن موظفي شركة كذا",
  "أرقام واتساب أصحاب المطاعم في المعادي",
];

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
  today: "2026-11-22",
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

describe("FX-PRIV Phase 1: Revert PR #619 Privacy Refusals in Chat & Planner Prompts", () => {
  it("UNDERSTAND_SYSTEM contains no PRIVATE PERSONAL DATA RULE paragraph", () => {
    expect(UNDERSTAND_SYSTEM).not.toContain("PRIVATE PERSONAL DATA RULE");
    expect(UNDERSTAND_SYSTEM).not.toContain("For public/business staff and managers, never answer");
    expect(UNDERSTAND_SYSTEM).toContain("Never answer that these people or their contacts are unavailable.");
  });

  it("buildSystemPrompt contains no privacy_refusal chat type", () => {
    const prompt = buildSystemPrompt({ balancePoints: null, open: null });
    expect(prompt).not.toContain("privacy_refusal");
    expect(prompt).not.toContain("الممنوع فقط جمع البيانات الخاصة لأفراد عاديين");
  });

  for (const prompt of MUST_PASS_PROMPTS) {
    it(`decideTurn classifies «${prompt}» as data_request (never privacy_refusal)`, async () => {
      const scriptedModel: ChatModelCall = async () => ({
        ok: true,
        text: JSON.stringify({
          type: "data_request",
          reason: "customer requested data",
          reply: "",
          count: null,
        }),
      });

      const d: Decision = await decideTurn({ message: prompt, balancePoints: BALANCE, open: null, history: [] }, scriptedModel);
      expect(d.type).toBe("data_request");
      expect(d.type).not.toBe("privacy_refusal");
    });
  }

  it("Planner: bank accounts request is planned normally (decision: 'plan', never 'cannot' / 'ask')", async () => {
    const planPayload = {
      decision: "plan",
      understanding_ar: "أرقام الحسابات البنكية وأرصدتها لموظفي بنك مصر.",
      accepts_available: false,
      missing: [],
      steps: [{
        key: "accounts",
        title_ar: "بيانات الحسابات",
        platform: "companies",
        capability: COMPANIES_CAP,
        parent: "",
        deliver: true,
        count: { total: 10, all: false },
        search_terms: ["بنك مصر"],
      }],
      people_of_companies: { asked: false, title_ar: "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: [] },
    };

    const { model } = fakePlanner(planPayload);
    const deps = depsOf(model);

    const u = await understandRequest({ words: ["عايز أرقام الحسابات البنكية الشخصية وأرصدتها لموظفي بنك مصر"], request: "" }, deps);
    expect(u.ok).toBe(true);
    if (u.ok) {
      expect(u.value.decision).toBe("plan");
      expect(u.value.decision).not.toBe("cannot");
    }

    const r = await planWithLlm({ words: ["عايز أرقام الحسابات البنكية الشخصية وأرصدتها لموظفي بنك مصر"], request: "" }, deps);
    expect(r.kind).toBe("plan");
    expect((r as any).detail).not.toBe("model_cannot");
    expect((r as any).detail).not.toBe("ask_refused");
  });
});
