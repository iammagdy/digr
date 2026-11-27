import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { decideTurn, type OpenRequest } from "../src/lib/agentMission/conversationModel";
import { OPEN_KEPT_AR } from "../src/lib/agentMission/chatTurn";

/**
 * UL2a-1 K4 guard (D-0244: «one cancel/replace = FAIL»; the CTO's real-model replay of #713 head 09ecb36f: «كيف تعمل المنصة» with an unapproved card open was typed as the OPEN request's «collect tweets», the card was
 * cancelled and one mission queued; and a clear question answered in prose twice got «خلل مؤقت»). The guard is the model's own reading of the message ALONE (no open request, no earlier message) before a card is replaced, and
 * the same alone-reading when the model cannot be read: no word, no phrase list. Offline: the real ChatHandler, the agent switched on, a SCRIPTED chat model that answers per context (open request in the prompt, or none).
 */
const USER = "u1";
const OPEN_REQUEST = "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا";
const QUESTIONS = ["انت بتعمل ايه؟", "ما هي خدماتك", "كيف تعمل المنصة", "ازاي بتشتغل", "ماذا تقدم"];
const NEW_REQUEST = "هات كمان ٥٠ تعليق من يوتيوب عن نفس الموضوع";
const SERVICE_REPLY = "ديجر خدمة لجمع بيانات البحث من وسائل التواصل وتسليمها لك في ملف إكسل منظم. اكتب لي ما تحتاج جمعه وأجهّز لك الخطة قبل أي خصم.";
const MISTYPE = { type: "data_request", reason: "طلب جمع تغريدات عن موضوع محدد", reply: "", count: null, refers_to_open_request: false };
const SERVICE = { type: "service_question", reason: "سؤال عام", reply: SERVICE_REPLY, count: null, refers_to_open_request: false };
const DATA = { type: "data_request", reason: "طلب جمع بيانات", reply: "", count: null, refers_to_open_request: false };

type Answer = object | "prose" | "fail";
interface Script { open: (message: string) => Answer; alone: (message: string) => Answer }
const lastUser = (input: ChatModelInput) => [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
function scriptedModel(script: Script) {
  const calls: Array<{ message: string; open: boolean }> = [];
  const call = async (input: ChatModelInput) => {
    const message = lastUser(input);
    const open = /OPEN_REQUEST: (?!none)/.test(input.system);
    calls.push({ message, open });
    const a = open ? script.open(message) : script.alone(message);
    if (a === "fail") return { ok: false as const, failure: "http_529" };
    if (a === "prose") return { ok: true as const, text: "أنا مساعد ديجر وأجمع لك بيانات البحث وأسلمها في ملف إكسل.", usage: { inputTokens: 900, outputTokens: 40 } };
    return { ok: true as const, text: JSON.stringify(a), usage: { inputTokens: 900, outputTokens: 80 } };
  };
  return { call, calls };
}
function world(model: ReturnType<typeof scriptedModel>, state: "plan_ready" | "needs_input" | "planning" = "plan_ready") {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: USER, email: "a@example.com" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 11676 }]);
  for (const t of ["plans_quotes", "jobs", "missions"]) db.seed(t, []);
  setChatModelForTesting(model.call as any);
  const handler = new ChatHandler(db);
  const oldPath = vi.fn(async () => { throw new Error("the old model path ran"); });
  (handler as any).llm.executeTurn = oldPath;
  handler.agentChat = { enabled: true };
  const ledger = JSON.stringify(db.rows("credit_ledger"));
  const ask = (message: string) => handler.handleUserMessage({ userId: USER, conversationId: "conv1", message, userBalance: 40_000 }) as Promise<any>;
  return {
    db, oldPath, ask, ledgerUnchanged: () => JSON.stringify(db.rows("credit_ledger")) === ledger,
    /** The first message makes the open request; its mission is then put in `state` (a plan card for plan_ready). */
    async openCard() {
      await ask(OPEN_REQUEST);
      const m = (db.rows("missions") as any[])[0];
      m.status = state === "needs_input" ? "needs_input" : state === "planning" ? "queued" : "plan_ready";
      if (state === "plan_ready") m.plan_public = m.plan_public ?? { price: { total_points: 100 } };
      if (state === "needs_input") m.question_ar = "على أي منصة تريد الجمع؟";
      return { m, snapshot: () => JSON.stringify((db.rows("missions") as any[]).map((x) => [x.id, x.status, x.request_text, x.plan_public])) };
    },
  };
}
const nothingStarted = (w: ReturnType<typeof world>) => { expect(w.db.rows("plans_quotes")).toHaveLength(0); expect(w.db.rows("jobs")).toHaveLength(0); expect(w.ledgerUnchanged()).toBe(true); expect(w.oldPath).not.toHaveBeenCalled(); };
beforeEach(() => { clearBriefCacheForTesting(); vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

describe("K4: a general question with an unapproved plan card open never cancels or replaces the card", () => {
  it.each(QUESTIONS)("(1) «%s»: the model mistypes it from the open request; the second, isolated reading is a conversation; card byte-unchanged, 0 quotes/jobs/ledger", async (q) => {
    const model = scriptedModel({ open: (m) => (m === q ? MISTYPE : DATA), alone: (m) => (m === q ? SERVICE : DATA) });
    const w = world(model);
    const card = await w.openCard();
    const before = card.snapshot();
    const r = await w.ask(q);
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(SERVICE_REPLY);
    expect(card.snapshot()).toBe(before);
    expect(w.db.rows("missions")).toHaveLength(1);
    nothingStarted(w);
    // the isolated reading is the model's own call on the message with NO open request in its prompt
    expect(model.calls.filter((c) => c.message === q)).toEqual([{ message: q, open: true }, { message: q, open: false }]);
  });

  it("(2) a REAL new data request with the card open still becomes a request as today: the isolated reading agrees (a data request), the card is replaced by one queued mission", async () => {
    const model = scriptedModel({ open: (m) => (m === NEW_REQUEST ? DATA : DATA), alone: () => DATA });
    const w = world(model);
    const card = await w.openCard();
    const r = await w.ask(NEW_REQUEST);
    expect(r.outputType).toBe("agent_mission");
    const missions = w.db.rows("missions") as any[];
    expect(missions).toHaveLength(2);
    expect(missions.filter((m) => m.status === "cancelled")).toHaveLength(1);
    expect(missions.find((m) => m.id !== card.m.id).status).toBe("queued");
    nothingStarted(w);
  });

  it("(3) an explicit edit of the open card still edits, with ONE model call (no second reading); a data request the model says refers to the open request is not re-read either", async () => {
    const edit = scriptedModel({ open: () => ({ type: "edit_of_open_request", reason: "تعديل العدد", reply: "", count: 500, count_text: "٥٠٠", refers_to_open_request: true }), alone: () => DATA });
    const w = world(edit);
    await w.openCard();
    const callsBefore = edit.calls.length;
    const r = await w.ask("خليهم ٥٠٠");
    expect(edit.calls.length - callsBefore).toBe(1);
    expect(edit.calls.at(-1)!.open).toBe(true);
    // the stub card has no stored plan, so the real edit routine (customerActions) refuses: the edit path WAS reached, exactly as before the guard; no mission was added
    expect(r.contentAr).toBe("لا يمكن تعديل الخطة الآن.");
    expect(w.db.rows("missions")).toHaveLength(1);
    nothingStarted(w);
    const refers = scriptedModel({ open: () => ({ ...DATA, refers_to_open_request: true }), alone: (m) => (m === OPEN_REQUEST ? DATA : SERVICE) });
    const w2 = world(refers);
    await w2.openCard();
    const before2 = refers.calls.length;
    await w2.ask("ضيف عليهم عدد الإعجابات");
    expect(refers.calls.length - before2).toBe(1);
  });

  it("(4) the second reading could not be made (model down): the card is kept with the fixed «kept» answer, never replaced, nothing started", async () => {
    let n = 0;
    const model = scriptedModel({ open: (m) => (m === QUESTIONS[2] ? MISTYPE : DATA), alone: (m) => (m === QUESTIONS[2] ? (n++, "fail") : DATA) });
    const w = world(model);
    const card = await w.openCard();
    const before = card.snapshot();
    const r = await w.ask(QUESTIONS[2]);
    expect(n).toBeGreaterThan(0);
    expect(r.contentAr).toBe(OPEN_KEPT_AR);
    expect(card.snapshot()).toBe(before);
    expect(w.db.rows("missions")).toHaveLength(1);
    nothingStarted(w);
  });

  it("(5) a plain-text (non-JSON) reply twice on a clear question: the isolated reading gives the answer, never «خلل مؤقت»; card unchanged", async () => {
    const model = scriptedModel({ open: (m) => (m === QUESTIONS[0] ? "prose" : DATA), alone: (m) => (m === QUESTIONS[0] ? SERVICE : DATA) });
    const w = world(model);
    const card = await w.openCard();
    const before = card.snapshot();
    const r = await w.ask(QUESTIONS[0]);
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(SERVICE_REPLY);
    expect(r.contentAr).not.toContain("خلل مؤقت");
    expect(card.snapshot()).toBe(before);
    nothingStarted(w);
  });

  it("(5b) counter-case: plain text twice AND the isolated reading is a data request: the card is kept with the fixed answer, never replaced (as before)", async () => {
    const model = scriptedModel({ open: (m) => (m === QUESTIONS[0] ? "prose" : DATA), alone: () => DATA });
    const w = world(model);
    const card = await w.openCard();
    const before = card.snapshot();
    const r = await w.ask(QUESTIONS[0]);

    expect(r.contentAr).toBe(OPEN_KEPT_AR);
    expect(card.snapshot()).toBe(before);
    expect(w.db.rows("missions")).toHaveLength(1);
    nothingStarted(w);
  });

  it("counter-case: while the agent WAITS FOR AN ANSWER (needs_input) the guard is not applied: one model call, as before", async () => {
    const model = scriptedModel({ open: () => DATA, alone: (m) => (m === OPEN_REQUEST ? DATA : SERVICE) });
    const w = world(model, "needs_input");
    await w.openCard();
    const before = model.calls.length;
    await w.ask("تيك توك");
    expect(model.calls.slice(before).filter((c) => !c.open)).toHaveLength(0);
  });

  it("with NO card open nothing changes: a general question is one call, a request is one call", async () => {
    const model = scriptedModel({ open: () => DATA, alone: (m) => (m === QUESTIONS[0] ? SERVICE : DATA) });
    const w = world(model);
    const a = await w.ask(QUESTIONS[0]);
    expect(a.outputType).toBe("answer_question");
    expect(model.calls).toHaveLength(1);
    const b = await w.ask("هات ١٠ تعليقات من تيك توك عن السياحة");
    expect(b.outputType).toBe("agent_mission");
    expect(model.calls).toHaveLength(2);
    nothingStarted(w);
  });
});

describe("decideTurn: the alone reading, at the unit level", () => {
  const OPEN: OpenRequest = { id: "m1", state: "plan_ready", requestText: OPEN_REQUEST };
  const turn = async (open: OpenRequest | null, script: Script, history?: Array<{ role: "user" | "assistant"; content: string }>) => {
    const model = scriptedModel(script);
    const decision = await decideTurn({ message: QUESTIONS[2], balancePoints: 100, open, ...(history ? { history } : {}) }, model.call as any);
    return { decision, calls: model.calls };
  };
  it("a mistype with a card open: the decision is the isolated reading (service question, its reply), two calls, the second without the open request", async () => {
    const { decision, calls } = await turn(OPEN, { open: () => MISTYPE, alone: () => SERVICE });
    expect(decision).toMatchObject({ type: "service_question", source: "model", reply: SERVICE_REPLY });
    expect(calls.map((c) => c.open)).toEqual([true, false]);
  });
  it("the isolated reading is a data request: the first decision stands; with no open request there is no second call at all", async () => {
    const a = await turn(OPEN, { open: () => MISTYPE, alone: () => DATA });
    expect(a.decision.type).toBe("data_request");
    const b = await turn(null, { open: () => DATA, alone: () => DATA });
    expect(b.calls).toHaveLength(1);
  });
  it("research-brief mode (off in production) keeps today's single call: no second reading", async () => {
    const model = scriptedModel({ open: () => MISTYPE, alone: () => SERVICE });
    const decision = await decideTurn({ message: QUESTIONS[2], balancePoints: 100, open: OPEN, brief: { enabled: true, soFar: null } }, model.call as any);
    expect(model.calls).toHaveLength(1);
    expect(decision.type).toBe("data_request");
  });
  it("no open request, prose twice, with earlier messages: the isolated reading answers; with no earlier message there is nothing to isolate (keyword rules as before)", async () => {
    const hist = [{ role: "user" as const, content: "مرحبا" }, { role: "assistant" as const, content: "أهلًا بك" }];
    const a = await turn(null, { open: () => "prose", alone: () => SERVICE }, hist);
    // no open request in the prompt => the scripted model's `alone` branch answers every call: prose is not scripted there, so the first two calls are readable and the type stands
    expect(a.decision.type).toBe("service_question");
    const b = await turn(null, { open: () => "prose", alone: () => "prose" });
    expect(b.decision.source).toBe("keyword");
    expect(b.calls).toHaveLength(2);
  });
});

describe("the root of the K4 replay: a message and its answer are written in the same instant", () => {
  it("equal created_at (the database returns ties in no fixed order; here the answer comes back first): the model still reads the new message alone as the last turn, and the earlier exchange as context (never «open request + new question» as one message)", async () => {
    const model = scriptedModel({ open: () => DATA, alone: (m) => (m === QUESTIONS[2] ? SERVICE : DATA) });
    const w = world(model);
    const at = "2026-11-27T10:00:00.000Z";
    w.db.seed("messages", [
      { id: "u1", conversation_id: "conv1", user_id: USER, role: "user", content_ar: OPEN_REQUEST, created_at: at },
      { id: "a1", conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.", created_at: at },
    ]);
    const prompts: string[] = [];
    setChatModelForTesting(((input: ChatModelInput) => { prompts.push(input.system); return model.call(input); }) as any);
    const r = await w.ask(QUESTIONS[2]);
    expect(r.outputType).toBe("answer_question");
    expect(model.calls[0].message).toBe(QUESTIONS[2]);
    expect(prompts[0]).toContain(`العميل: «${OPEN_REQUEST}»`);
    expect(prompts[0].indexOf(`العميل: «${OPEN_REQUEST}»`)).toBeLessThan(prompts[0].indexOf("المساعد: «بدأ الوكيل"));
  });
});
