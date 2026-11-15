import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentChatTurn, CONFIRM_UNDERSTANDING_AR, RESTATE_REQUEST_AR } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { renderRequestFromBrief, validateBrief, type ResearchBrief } from "../src/lib/agentMission/researchBrief";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { createMemoryDb } from "./helpers/memoryDb";

/**
 * P0, 15 NOV 2026: CONVERSATION CONTINUITY (production mission msn_8824508f840f703dee69, conversation b7abe45b18874b4b9d53; recorded evidence, zero paid calls).
 *
 * The conversation: «أريد ٤٠٠ تغريدة عن الشائعات الصحية عبر الصفحة الرسمية لوزارة الصحة السعودية أو أي تصحيح لشائعة صحية على إكس» → «طيب ابحث عن الشائعات فقط» (msn_dd7c2e9c131b8783bf2e, 79 tweets) → «زود العدد ل 400 تغريدة»
 * → «هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار بواقع 400 تغريدة».
 * Recorded: the chat model read the last message as a data request (log: type=data_request source=model); the brief it wrote was REJECTED by code (`brief: rejected_source_dropped`: the keyword reader did not find the account in the model's sentence), the turn fell
 * to the words path, and the mission was made of that one sentence: no topic, no account. The X search was sent with no query (`{"limit":20,"queryType":"Latest"}`), refused (`missing_params:query`), and the customer read «مصادرنا لا تخدم هذا الطلب».
 * Root cause: the model's understanding was a suggestion that a keyword reader could veto, and the veto fell back to the fragment instead of to the conversation.
 */
const USER = "8a2f1c3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const TURNS = [
  "أريد ٤٠٠ تغريدة عن الشائعات الصحية عبر الصفحة الرسمية لوزارة الصحة السعودية أو أي تصحيح لشائعة صحية على إكس.",
  "طيب ابحث عن الشائعات فقط",
  "زود العدد ل 400 تغريدة",
  "هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار بواقع 400 تغريدة",
];
const FOLLOW_UP = TURNS[3];
/** What the model understood: the earlier research carried into the follow-up (the account in `source`, the topic from earlier turns), in a sentence the keyword reader does not read back. */
const modelBrief = (over: Record<string, unknown> = {}) => ({
  status: "ready", request: "توسيع استخراج التغريدات من الصفحة الرسمية لوزارة الصحة السعودية بلا تكرار بواقع 400 تغريدة", platforms: ["x"], content: ["tweets"], count: 400, topic: "الشائعات الصحية",
  source: "وزارة الصحة السعودية", period: "", country: "", language: "", ...over,
});
const asBrief = (o: Record<string, unknown>): ResearchBrief => ({ v: 1, status: "ready", request: String(o.request), platforms: o.platforms as never, content: o.content as never, count: (o.count as number) ?? null, topic: (o.topic as string) || null, period: (o.period as string) || null, country: (o.country as string) || null, language: (o.language as string) || null, source: (o.source as string) || null });

function world(messages: string[]) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "c1", user_id: USER, title: "t", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 1000 }]);
  db.seed("agent_settings", [{ key: "chat_research_brief_v1", value: true }, { key: "capability_discovery_v1", value: true }]);
  db.seed("missions", []);
  db.seed("mission_events", []);
  const rows: Array<Record<string, unknown>> = [];
  messages.slice(0, -1).forEach((m, i) => {
    rows.push({ id: `u${i}`, conversation_id: "c1", user_id: USER, role: "user", content_ar: m, request_status: "planning", created_at: `2026-11-14T18:${String(10 + i).padStart(2, "0")}:00Z` });
    rows.push({ id: `a${i}`, conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.", plan: { agentMissionId: `msn_00000000000000000${i}00` }, created_at: `2026-11-14T18:${String(10 + i).padStart(2, "0")}:30Z` });
    db.rows("missions").push({ id: `msn_00000000000000000${i}00`, user_id: USER, conversation_id: "c1", status: "completed", request_text: m, plan: null, created_at: `2026-11-14T18:${String(10 + i).padStart(2, "0")}:00Z` });
  });
  rows.push({ id: "ucur", conversation_id: "c1", user_id: USER, role: "user", content_ar: messages[messages.length - 1], request_status: "planning", created_at: "2026-11-15T09:22:11Z" });
  rows.push({ id: "acur", conversation_id: "c1", user_id: USER, role: "assistant", content_ar: "…", created_at: "2026-11-15T09:22:11.5Z" });
  db.seed("messages", rows);
  return db;
}
const turn = (db: any) => agentChatTurn({ sb: db, userId: USER, conversationId: "c1", userMsgId: "ucur", assistantMsgId: "acur", message: FOLLOW_UP, conversationTitle: "t" });
const missionsOf = (db: any): Array<Record<string, unknown>> => db.rows("missions") as Array<Record<string, unknown>>;

describe("the follow-up of the incident, as the chat turn sees it", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); })); vi.spyOn(console, "info").mockImplementation(() => undefined); });
  afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const model = (brief: Record<string, unknown> | null) => setChatModelForTesting(async () => ({ ok: true, text: JSON.stringify({ type: "data_request", reason: "scripted", reply: "", count: 400, ...(brief ? { brief } : {}) }), usage: { inputTokens: 1, outputTokens: 1 } }));

  it("the model's reading (account in `source`, topic from the earlier turns) is not vetoed by the keyword reader: the mission request is rendered from the structured fields and carries topic, account, platform and count", async () => {
    model(modelBrief());
    const db = world(TURNS);
    const before = missionsOf(db).length;
    const r = await turn(db);
    const created = missionsOf(db).filter((m) => !String(m.id).startsWith("msn_00000000000000000"));
    expect(missionsOf(db).length).toBeGreaterThan(before);
    expect(created).toHaveLength(1);
    const request = String(created[0].request_text);
    expect(request).toContain("الشائعات الصحية");
    expect(request).toContain("وزارة الصحة السعودية");
    const ask = buildAsk(request, null, Date.parse("2026-11-15T09:22:19Z"));
    expect(ask).toMatchObject({ platform: "x", count: 400, source: { kind: "named", text: expect.stringContaining("وزارة الصحة السعودية") }, topic: { text: expect.stringContaining("الشائعات الصحية") } });
  });

  it("the model's reading cannot be used at all (a brief with no topic and no account): nothing is created; the customer is asked, and nothing is planned from the fragment", async () => {
    model(modelBrief({ topic: "", source: "", request: "توسيع استخراج التغريدات" }));
    const db = world(TURNS);
    const r = await turn(db);
    expect(missionsOf(db).filter((m) => !String(m.id).startsWith("msn_00000000000000000"))).toHaveLength(0);
    expect(r.contentAr).toBe(RESTATE_REQUEST_AR);
  });

  it("the model returned NO brief for a follow-up that names no topic: the same, never a mission from the fragment", async () => {
    model(null);
    const db = world(TURNS);
    const r = await turn(db);
    expect(missionsOf(db).filter((m) => !String(m.id).startsWith("msn_00000000000000000"))).toHaveLength(0);
    expect(r.contentAr).toBe(RESTATE_REQUEST_AR);
  });

  it("a message that stands on its own (its own topic) in a conversation with history is still planned from its own words, as before", async () => {
    model(null);
    const db = world([...TURNS.slice(0, 3), "عايز ٥٠ تغريدة عن الذكاء الاصطناعي على إكس"]);
    const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "c1", userMsgId: "ucur", assistantMsgId: "acur", message: "عايز ٥٠ تغريدة عن الذكاء الاصطناعي على إكس", conversationTitle: "t" });
    expect(r.contentAr).not.toBe(RESTATE_REQUEST_AR);
    expect(missionsOf(db).filter((m) => !String(m.id).startsWith("msn_00000000000000000")).length).toBeGreaterThanOrEqual(1);
  });
});

describe("the rendering is checked, never trusted: the structured fields become the executable request only when every check the model's own sentence faces passes", () => {
  const ctx = { customerTurns: TURNS };
  it("renders the parent items of one platform in the form the worker's reader is built for, for every platform and kind", () => {
    const cases: Array<[Partial<ResearchBrief>, RegExp]> = [
      [{ platforms: ["x"], content: ["tweets"], topic: "الشائعات الصحية", source: "وزارة الصحة السعودية", count: 400 }, /جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية/],
      [{ platforms: ["tiktok"], content: ["videos"], topic: "الذكاء الاصطناعي", source: null, count: 20, period: "آخر ٣ أشهر" }, /جمع ٢٠ فيديو على تيك توك عن الذكاء الاصطناعي خلال آخر ٣ أشهر/],
      [{ platforms: ["facebook"], content: ["posts"], topic: null, source: "قناة العربية", count: null }, /جمع منشور على فيسبوك من حساب قناة العربية/],
    ];
    for (const [over, re] of cases) {
      const b = asBrief({ request: "x", platforms: [], content: [], ...over });
      expect(renderRequestFromBrief({ ...b, ...(over as object) } as ResearchBrief)).toMatch(re);
    }
  });
  it("renders nothing for what it cannot say: several platforms, comments or replies, several parts, or no topic and no source", () => {
    const base = asBrief({ request: "x", platforms: ["x"], content: ["tweets"], topic: "موضوع", count: 5 });
    expect(renderRequestFromBrief({ ...base, platforms: ["x", "tiktok"] })).toBeNull();
    expect(renderRequestFromBrief({ ...base, content: ["tweets", "replies"] })).toBeNull();
    expect(renderRequestFromBrief({ ...base, topic: null, source: null })).toBeNull();
  });
  it("the incident's brief is rejected as written (the production rejection, source_dropped) and accepted once rendered from its fields", () => {
    const b = asBrief(modelBrief());
    const v = validateBrief(b, ctx);
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.brief.request).toMatch(/وزارة الصحة السعودية/); expect(v.brief.request).not.toBe(b.request); }
  });
  it("a source the customer never wrote is still rejected (the rendering never launders an invented account)", () => {
    const v = validateBrief(asBrief(modelBrief({ source: "وزارة التعليم" })), ctx);
    expect(v.ok).toBe(false);
  });
  it("a number the customer never wrote is still rejected", () => {
    const v = validateBrief(asBrief(modelBrief({ count: 777 })), ctx);
    expect(v.ok).toBe(false);
  });
  it("a platform the customer never named is still rejected", () => {
    const v = validateBrief(asBrief(modelBrief({ platforms: ["tiktok"], content: ["videos"] })), ctx);
    expect(v.ok).toBe(false);
  });
});

describe("the confirmation sentence tells the customer the truth", () => {
  it("restates what was understood and says nothing was searched or charged", () => {
    const s = CONFIRM_UNDERSTANDING_AR("جمع ٤٠٠ تغريدة على إكس");
    expect(s).toContain("جمع ٤٠٠ تغريدة على إكس");
    expect(s).toContain("لم نبدأ بحثًا ولم يُخصم منك شيء");
  });
});
