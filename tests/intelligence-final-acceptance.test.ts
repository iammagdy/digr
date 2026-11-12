import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { selfReferenceOf, selfReferenceQuestionAr, selfReferenceUnresolved } from "../src/lib/agentMission/selfReference";

/**
 * THE INTELLIGENCE LAYER, FINAL ACCEPTANCE (docs/DIGER-INTELLIGENCE-FINAL-ACCEPTANCE.md), OFFLINE. Each test scripts the chat model with the shape the real model wrote and runs the REAL chat turn over an in-memory database.
 * No network, no paid call.
 */
const USER = REPLAY_USER;
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const o = (id: string, operation: string, x: Record<string, unknown> = {}) => ({ id, operation, platform: null, parent: null, contacts: [], what: "", ...x });
function scripted(steps: Array<Record<string, unknown>>) {
  const script = [...steps];
  setChatModelForTesting(async () => { const s = script.shift(); return s ? { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 420 } } : { ok: false, failure: "http_529" }; });
}
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
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  // the stored answer is what the next turn reads as the assistant's question
  const a = db.rows("messages").find((m: any) => m.id === `a${seq}`);
  if (a && a.content_ar === "…") a.content_ar = r.contentAr;
  return r;
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
let infos: string[] = [];
const lastLog = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line) : null; };
beforeEach(() => {
  infos = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { infos.push(String(line)); });
});
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const D2 = "محتاج معلومات عن منافسين شركتي";

describe("D2: a request about the customer's own business that nobody named is asked IN THE CHAT, never a mission whose card asks", () => {
  for (const [name, status, op, content] of [
    ["round-9 shape: needs_clarification, no question, companies", "needs_clarification", "companies.discover", ["companies"]],
    ["needs_clarification, no question, web research", "needs_clarification", "web.search", ["articles"]],
    ["the model says ready", "ready", "companies.discover", ["companies"]],
  ] as const) {
    it(name, async () => {
      scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status, request: "معلومات عن منافسين شركتي", content, topic: "منافسين شركتي", objectives: [o("o1", op, { what: "منافسين شركتي" })] }) }]);
      const db = world();
      const r = await turn(db, D2);
      expect(r.ok).toBe(false);
      expect(r.contentAr).toBe(selfReferenceQuestionAr("company"));
      expect(missions(db)).toHaveLength(0);
      expect(lastLog()?.brief).toBe("clarify_self_reference_company");
    });
  }
  it("the model's OWN question is used when it wrote one", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "إيه مجال شركتك؟", count: null, brief: briefOf({ status: "needs_clarification", request: "معلومات عن منافسين شركتي", content: ["companies"], objectives: [o("o1", "companies.discover")] }) }]);
    const db = world();
    const r = await turn(db, D2);
    expect(r.contentAr).toBe("إيه مجال شركتك؟");
    expect(missions(db)).toHaveLength(0);
  });
  it("the customer's answer resolves it: the next ready brief becomes ONE mission, no duplicate", async () => {
    scripted([
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "معلومات عن منافسين شركتي", content: ["companies"], objectives: [o("o1", "companies.discover")] }) },
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "شركات السياحة المنافسة في الغردقة", content: ["companies"], topic: "شركات السياحة", country: "الغردقة", objectives: [o("o1", "companies.discover", { what: "شركات سياحة منافسة" })] }) },
    ]);
    const db = world();
    await turn(db, D2);
    expect(missions(db)).toHaveLength(0);
    const r = await turn(db, "شركة سياحة في الغردقة");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
  });
  it("a business described in the SAME message is not asked", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "شركات السياحة المنافسة في الغردقة", content: ["companies"], topic: "شركات السياحة", country: "الغردقة", objectives: [o("o1", "companies.discover")] }) }]);
    const db = world();
    const r = await turn(db, "عايز أعرف منافسين شركتي، إحنا شركة سياحة في الغردقة");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
  });
  it("English: «my company's competitors» is asked too", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "competitors of my company", content: ["companies"], objectives: [o("o1", "companies.discover")] }) }]);
    const db = world();
    const r = await turn(db, "I want data about the competitors of my company");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toBe(selfReferenceQuestionAr("company"));
    expect(missions(db)).toHaveLength(0);
  });
  it("inside a multi-part request only the own-business part is asked; the other parts are prepared", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({
      request: "منافسين شركتي، وآخر أخبار السياحة في مصر", content: ["companies", "articles"],
      objectives: [o("o1", "companies.discover", { request: "شركات منافسة لشركتي", what: "منافسين شركتي" }), o("o2", "web.search", { request: "آخر أخبار السياحة في مصر", what: "أخبار السياحة" })],
    }) }]);
    const db = world();
    const r = await turn(db, "عايز منافسين شركتي، وآخر أخبار السياحة في مصر");
    expect(live(db)).toHaveLength(1);
    expect(live(db)[0].request_text).toContain("أخبار السياحة");
    expect(r.contentAr).toContain(selfReferenceQuestionAr("company"));
  });
});

describe("selfReference: precise, never a false question on research about OTHER businesses", () => {
  it.each([
    ["منافسين شركتي", "company"], ["رأي الناس في البراند بتاعنا", "brand"], ["تقييمات مطعمي على جوجل", "venue"], ["تعليقات الناس على صفحتي في فيسبوك", "account"],
    ["what people say about our brand", "brand"], ["reviews of my restaurant", "venue"], ["3ayez a3raf mona7sin sherkety", "company"],
  ])("%s → %s", (text, kind) => expect(selfReferenceOf(text)).toBe(kind));
  it.each([
    "عايز أعرف الناس بتقول إيه عن سامسونج", "عايز شركات سياحة في الغردقة وإيميلاتها", "بيانات منتجي الأفلام في مصر", "نسبة الإشغال في القطاع الفندقي", "تعليقات تيك توك مع متوسط حسابي للإعجابات",
    "عايز تقييمات فنادق الغردقة", "هات آخر أخبار شركات الاتصالات", "comments about company layoffs",
  ])("%s → null", (text) => expect(selfReferenceOf(text)).toBeNull());
  it("resolved by identification in the same turn or by any later turn", () => {
    expect(selfReferenceUnresolved(["منافسين شركتي"])).toBe("company");
    expect(selfReferenceUnresolved(["منافسين شركتي", "سياحة في الغردقة"])).toBeNull();
    expect(selfReferenceUnresolved(["منافسين شركتي اسمها النيل للسياحة"])).toBeNull();
    expect(selfReferenceUnresolved(["تقييمات مطعمي", "رابطه www.example-food.com"])).toBeNull();
    expect(selfReferenceUnresolved(["تعليقات تيك توك عن السياحة", "وكمان تعليقات على صفحتي"])).toBe("account");
    expect(selfReferenceUnresolved(["تعليقات تيك توك عن السياحة"])).toBeNull();
  });
});
