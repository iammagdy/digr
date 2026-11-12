import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, CHAT_RESEARCH_BRIEF_FLAG_KEY, MODEL_RETRY_AR, missingQuestionAr } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";

/**
 * THE CODE'S FALLBACK QUESTION READS THE WHOLE CONVERSATION (round 53, real chat run a3, E1): «عايز داتا عن السياحة» → «تعليقات من تيك توك» → «آخر شهر». At turn 3 the real model returned no brief, the code asked its own question, and
 * built it from the LAST message only: it asked «من أنهي منصة؟» right after the customer said TikTok. The platform is now read from every turn; the question is otherwise unchanged.
 */
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const ask = (request: string, reply: string, b: Record<string, unknown> = {}) => ({ type: "data_request", reason: "x", reply, count: null, brief: briefOf({ status: "needs_clarification", request, ...b }) });
function scripted(steps: Array<Record<string, unknown>>) {
  const script = [...steps];
  setChatModelForTesting(async () => { const s = script.shift(); return s ? { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 420 } } : { ok: false, failure: "http_529" }; });
}
const USER = REPLAY_USER;
function world() {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER] } }]);
  const base = db.from;
  db.from = (name: string) => { const b = base(name); if (name === "missions") { const ins = b.insert; b.insert = (row: any) => ins(row.created_at ? row : { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); } return b; };
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const at = Date.parse("2026-11-12T09:00:00Z") + seq * 10_000;
  db.rows("messages").push(
    { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
  );
  return agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); vi.spyOn(console, "info").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const PLATFORM_Q = missingQuestionAr(buildRequestContract("آخر شهر"));

describe("a request is open and the model answers a follow-up with no brief: no second mission is made of the fragment", () => {
  it("the open request stays the only live one, unchanged; the customer is asked to send the message again", async () => {
    scripted([
      ask("داتا عن السياحة", "تحب نجمع إيه بالظبط؟"),
      ask("تعليقات تيك توك عن السياحة", "تحب أنهي فترة؟", { platforms: ["tiktok"], content: ["comments"] }),
      { type: "data_request", reason: "x", reply: "", count: null },
    ]);
    const db = world();
    await turn(db, "عايز داتا عن السياحة");
    await turn(db, "تعليقات من تيك توك عن السياحة");
    const live = () => db.rows("missions").filter((m: any) => m.status !== "cancelled").map((m: any) => m.request_text);
    expect(live()).toEqual(["تعليقات تيك توك عن السياحة"]);
    const third = await turn(db, "آخر شهر");
    expect(third.ok).toBe(false);
    expect(third.contentAr).toBe(MODEL_RETRY_AR);
    expect(live()).toEqual(["تعليقات تيك توك عن السياحة"]);
    expect(db.rows("missions").every((m: any) => !m.job_id)).toBe(true);
  });
  it("a follow-up that is itself a whole request still becomes one (the words name data)", async () => {
    scripted([
      ask("تعليقات تيك توك عن السياحة", "تحب أنهي فترة؟", { platforms: ["tiktok"], content: ["comments"] }),
      { type: "data_request", reason: "x", reply: "", count: null },
    ]);
    const db = world();
    await turn(db, "تعليقات من تيك توك عن السياحة");
    const second = await turn(db, "هات مطاعم المعادي وتقييماتها");
    expect(second.ok).toBe(true);
  });
});

describe("E1, turn 3 with no brief from the model: the question never asks for the platform the customer already gave", () => {
  it("the platform question is not asked after «تعليقات من تيك توك»", async () => {
    expect(PLATFORM_Q).toMatch(/أنهي منصة/);
    scripted([
      ask("داتا عن السياحة", "تحب نجمع إيه بالظبط؟"),
      // the real model at turn 2 asked for the TOPIC (its brief carried no topic), so nothing was prepared
      ask("تعليقات تيك توك", "عن أي موضوع تحديدًا؟", { platforms: ["tiktok"], content: ["comments"] }),
      // the real model's answer at turn 3: a request type, no reply, no brief
      { type: "data_request", reason: "x", reply: "", count: null },
    ]);
    const db = world();
    await turn(db, "عايز داتا عن السياحة");
    await turn(db, "تعليقات من تيك توك");
    const third = await turn(db, "آخر شهر");
    expect(third.ok).toBe(false);
    expect(third.contentAr).not.toBe(PLATFORM_Q);
    expect(third.contentAr).not.toMatch(/أنهي منصة/);
    expect(third.contentAr).toMatch(/[؟?]/);
    // nothing was prepared from a turn the model did not read
    expect(db.rows("missions").filter((m: any) => m.status !== "cancelled").every((m: any) => !m.job_id)).toBe(true);
  });
  it("with no platform anywhere in the conversation, the platform question is still asked", () => {
    expect(missingQuestionAr(buildRequestContract("عايز داتا عن السياحة آخر شهر"))).toBe(PLATFORM_Q);
  });
});
