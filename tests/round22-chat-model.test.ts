import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { CORPUS, FOLLOW_UPS, ROUND22_LIVE, AMBIGUOUS_DATA, ROUND21_CORPUS } from "./helpers/chatCorpus";
import { fakeChatModel } from "./helpers/fakeChatModel";
import { validateAndPricePlan, type PlanLookup, type PricedPlan, customerPlanView } from "../src/lib/agentMission/plan";
import { CHAT_TYPES, buildSystemPrompt, decideTurn, guardReply, parseModelAnswer, type OpenRequest } from "../src/lib/agentMission/conversationModel";
import { callClaudeChatWith, CHAT_MODEL_MAX_TOKENS, setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { agentChatTurn, REVISION_JOINER_AR, REVISION_STARTED_AR } from "../src/lib/agentMission/chatTurn";
import { METHODOLOGY_CHOOSER_SENTENCE_AR, otherReplyAr } from "../src/lib/agentMission/messageType";

/**
 * ROUND 22: THE CHAT TALKS LIKE AN ASSISTANT (the chat model writes the reply and names the type of the message), WITH CODE AS THE GUARD. Live after #372, «يعني ايه ديجر الذكي» got «لم أفهم من رسالتك أنها طلب لجمع بيانات»,
 * and a terse follow-up on an open plan («خليها ٥ تعليقات بس») got the same short reply instead of editing the plan. The model's type is validated against a fixed set by code; only CODE routes to planning; the model decides no money;
 * its reply is checked before it is shown (provider names, dollars, Latin digits, emoji, numbers it was not given) and a blocked reply is replaced by a fixed one. No paid call: a fake model answers in the real format.
 */
const USER = "u1";
const BALANCE = 11676;

const sample = (n: number) => ({ id: `s${n}`, text: `محمد صلاح يسجل هدفًا رقم ${n} مع ليفربول`, url: `https://x.example/s/${n}`, author: `fan${n}`, created_at: "2026-10-20T10:00:00Z", is_reply: "لا" });
const mapped = [1, 2, 3, 4, 5, 6, 7, 8].map(sample);
const xLookup = (): PlanLookup => ({
  call: (id) => (id === "call_0001" ? { id, endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } } : null),
  evidenceText: (id) => (id === "out_0001" ? JSON.stringify(mapped) : `${JSON.stringify(mapped)} https://x.example/s/1 https://x.example/s/2 s1 s2`),
  endpointAllowed: () => true, requestText: "هات ٣٠٠ تغريدة عن محمد صلاح",
});
const xPlan = (): PricedPlan => {
  const r = validateAndPricePlan({
    summary_ar: "ستحصل على ٣٠٠ تغريدة عربية عن محمد صلاح دون الردود.",
    assumptions_ar: ["المقصود: لاعب كرة القدم محمد صلاح.", "تغريدات عربية، الأحدث أولًا."],
    stages: [{
      key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 300, parent_key: null, deliver: true,
      columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created_at", title_ar: "التاريخ والوقت" }],
      sample_rows: mapped.slice(0, 2), measured_by: ["call_0001", "out_0001"], how_ar: "بحث بالاسم، عربي ودون الردود.",
      relevance: { subject_ar: "لاعب كرة القدم محمد صلاح", terms: ["محمد صلاح"], text_columns: ["text"], min_own_words: 0 }, yield_from: "out_0001",
      filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }],
    }],
  }, xLookup());
  if (!r.ok) throw new Error(r.issues.join("; "));
  return r.plan;
};

type Seed = { status?: string; question_ar?: string | null; plan?: PricedPlan };
function world(seed?: Seed) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: BALANCE }]);
  db.seed("mission_events", []);
  db.seed("messages", []);
  db.seed("missions", []);
  if (seed) {
    const plan = seed.plan ?? (seed.status === "plan_ready" ? xPlan() : null);
    db.seed("missions", [{ id: "msn_open123456", user_id: USER, status: seed.status ?? "plan_ready", request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", question_ar: seed.question_ar ?? null, plan, plan_public: plan ? customerPlanView(plan) : null, created_at: new Date().toISOString() }]);
    db.seed("messages", [{ id: "a0", conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.", plan: { agentMissionId: "msn_open123456" }, created_at: new Date(Date.now() - 60_000).toISOString() }]);
  }
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const userMsgId = `u${seq}`;
  const assistantMsgId = `as${seq}`;
  db.seed("messages", [
    { id: userMsgId, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date().toISOString() },
    { id: assistantMsgId, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "جاري التفكير وتحليل طلبك...", created_at: new Date(Date.now() + 1).toISOString() },
  ]);
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId, assistantMsgId, message, conversationTitle: "محادثة جديدة" });
  const row = (id: string) => db.rows("messages").find((m: any) => m.id === id);
  return { r, assistant: row(assistantMsgId), user: row(userMsgId) };
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the permanent corpus (at least 60 messages) against a fake model that answers in the real structured format", () => {
  it("has at least 60 messages, keeps the round-21 corpus, adds the live messages, the follow-ups and the ambiguous data requests, and covers every type", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
    expect(ROUND21_CORPUS.length).toBeGreaterThanOrEqual(50);
    for (const m of ["هاي", "انت مين", "يعني ايه ديجر الذكي", "ممكن تساعدني في رسالة الماجستير؟", "خليها ٥ تعليقات بس", "خليها ٥٠٠"]) expect(CORPUS.some((e) => e.text === m), m).toBe(true);
    expect(FOLLOW_UPS.length).toBeGreaterThanOrEqual(10);
    expect(AMBIGUOUS_DATA.length).toBeGreaterThanOrEqual(5);
    for (const t of CHAT_TYPES) expect(CORPUS.some((e) => e.type === t), t).toBe(true);
  });

  it.each(CORPUS.map((e) => [e.text, e.type, e.open ?? "no open request", e] as const))("«%s» is %s (%s)", async (text, type, _open, entry) => {
    const model = fakeChatModel();
    const open: OpenRequest | null = entry.open ? { id: "msn_open123456", state: entry.open, questionAr: entry.open === "needs_input" ? "أي بلد تقصد؟" : null } : null;
    const d = await decideTurn({ message: text, balancePoints: BALANCE, open, history: [] }, model.call);
    expect(d.source).toBe("model");
    expect(d.type).toBe(type);
    expect(CHAT_TYPES).toContain(d.type);
    expect(model.calls).toHaveLength(1);
  });
});

describe("the live messages after #372", () => {
  it("«يعني ايه ديجر الذكي» is a normal question: a natural answer written by the model, never «لم أفهم من رسالتك»", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world();
    const { r, assistant } = await turn(db, "يعني ايه ديجر الذكي");
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toContain("ديجر");
    expect(assistant.content_ar).not.toContain("لم أفهم من رسالتك");
    expect(assistant.content_ar).not.toContain("مصادرنا لا تخدم");
    expect(db.rows("missions")).toHaveLength(0);
    expect(model.calls).toHaveLength(1);
  });
  it("«ممكن تساعدني في رسالة الماجستير؟» gets an honest, helpful reply and opens no mission", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world();
    const { r, assistant, user } = await turn(db, "ممكن تساعدني في رسالة الماجستير؟");
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toMatch(/جمع/);
    expect(user.request_status).toBe("completed");
    expect(db.rows("missions")).toHaveLength(0);
  });
  it("«هاي» and «انت مين»: the model's own words, no mission, one model call each", async () => {
    for (const m of ["هاي", "انت مين"]) {
      const model = fakeChatModel();
      setChatModelForTesting(model.call);
      const db = world();
      const { r, assistant } = await turn(db, m);
      expect(r.ok).toBe(false);
      expect(assistant.content_ar.length).toBeGreaterThan(40);
      expect(db.rows("missions")).toHaveLength(0);
      expect(model.calls).toHaveLength(1);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the type is the model's, VALIDATED by code", () => {
  const ctx = (message: string, open: OpenRequest | null = null) => ({ message, balancePoints: BALANCE, open, history: [] });
  it("an unknown type, a missing type, an unreadable reply or a failed call falls back to the keyword rules (the round-21 classifier), and says so", async () => {
    const unknown = fakeChatModel([], { override: () => ({ type: "refund_request" }) });
    expect((await decideTurn(ctx("هات ٣٠٠ تغريدة عن محمد صلاح"), unknown.call))).toMatchObject({ type: "data_request", source: "keyword" });
    const garbage = fakeChatModel([], { override: () => "garbage" });
    expect((await decideTurn(ctx("السلام عليكم"), garbage.call))).toMatchObject({ type: "greeting_or_small_talk", source: "keyword" });
    const failing = fakeChatModel([], { override: () => "fail" });
    expect((await decideTurn(ctx("بكام النقطة؟"), failing.call))).toMatchObject({ type: "service_question", source: "keyword" });
    const throwing = async () => { throw new Error("socket hang up"); };
    expect((await decideTurn(ctx("اكتب لي المنهجية"), throwing))).toMatchObject({ type: "methodology_request", source: "keyword" });
  });
  it("the keyword fallback keeps every round-21 type (greeting, service, methodology, data, other) for the whole round-21 corpus when the model is down", async () => {
    const failing = fakeChatModel([], { override: () => "fail" });
    const map: Record<string, string> = { greeting_or_small_talk: "greeting_or_small_talk" };
    for (const e of ROUND21_CORPUS) {
      const d = await decideTurn(ctx(e.text), failing.call);
      expect(d.source).toBe("keyword");
      expect(d.type, e.text).toBe(map[e.type] ?? e.type);
    }
  });
  it("a model type of the fixed set only: «edit_of_open_request» with NO open request is a data request (never a lost message)", async () => {
    const model = fakeChatModel();
    const d = await decideTurn(ctx("خليها ٥ تعليقات بس"), model.call);
    expect(d.type).toBe("data_request");
  });
  it("WHEN UNSURE THE ANSWER IS «data_request»: a message the keyword rules read as a clear request is never refused, whatever the model said", async () => {
    for (const wrong of ["other", "greeting_or_small_talk", "service_question", "methodology_request"]) {
      const model = fakeChatModel([], { override: () => ({ type: wrong, reply: "أهلًا بك في ديجر." }) });
      const d = await decideTurn(ctx("هات ٥٠ تعليق من فيسبوك عن الغلاء"), model.call);
      expect(d.type, wrong).toBe("data_request");
    }
  });
  it("…but with an OPEN request the model's «edit» wins over the keywords («خليها ٥٠٠ تعليق» reads as a request to the keywords)", async () => {
    const model = fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: 500 }) });
    const d = await decideTurn(ctx("خليها ٥٠٠ تعليق", { id: "msn_open123456", state: "plan_ready" }), model.call);
    expect(d.type).toBe("edit_of_open_request");
    expect(d.count).toBe(500);
  });
  it("the count of an edit must be a number the customer WROTE (a count the model invented is dropped)", async () => {
    const open: OpenRequest = { id: "msn_open123456", state: "plan_ready" };
    const invented = fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: 700 }) });
    expect((await decideTurn(ctx("خليها ٥ تعليقات بس", open), invented.call)).count).toBeNull();
    const supported = fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: 5 }) });
    expect((await decideTurn(ctx("خليها ٥ تعليقات بس", open), supported.call)).count).toBe(5);
    // a period is not a count: the model leaves it null and the code does not pick the number up
    const period = fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: null }) });
    expect((await decideTurn(ctx("خليها آخر ٣ شهور", open), period.call)).count).toBeNull();
    const none = fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: 700 }) });
    expect((await decideTurn(ctx("خليها بالعربي بس", open), none.call)).count).toBeNull();
    const two = fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: null }) });
    expect((await decideTurn(ctx("من ١٠ إلى ٢٠", open), two.call)).count).toBeNull();
  });
  it("the fallback with an open request: an answer to a question, or a short edit with a number, is the edit of that request (not a new one, not a generic reply)", async () => {
    const failing = fakeChatModel([], { override: () => "fail" });
    expect(await decideTurn(ctx("السعودية", { id: "msn_open123456", state: "needs_input", questionAr: "أي بلد؟" }), failing.call)).toMatchObject({ type: "edit_of_open_request", source: "keyword" });
    expect(await decideTurn(ctx("خليها ٥ تعليقات بس", { id: "msn_open123456", state: "plan_ready" }), failing.call)).toMatchObject({ type: "edit_of_open_request", count: 5 });
    expect(await decideTurn(ctx("خليها ٥٠٠", { id: "msn_open123456", state: "plan_ready" }), failing.call)).toMatchObject({ type: "edit_of_open_request", count: 500 });
    // a greeting stays a greeting
    expect(await decideTurn(ctx("شكرًا", { id: "msn_open123456", state: "plan_ready" }), failing.call)).toMatchObject({ type: "greeting_or_small_talk" });
  });
  it("parseModelAnswer reads the one line of JSON (also inside a code fence or after a few words) and rejects anything else", () => {
    expect(parseModelAnswer('{"type":"greeting_or_small_talk","reason":"hi","reply":"أهلًا","count":null}')).toMatchObject({ type: "greeting_or_small_talk", reply: "أهلًا" });
    expect(parseModelAnswer('```json\n{"type":"data_request","reason":"x","reply":"","count":null}\n```')).toMatchObject({ type: "data_request" });
    expect(parseModelAnswer('النتيجة: {"type":"other","reason":"x","reply":"حسنًا"}')).toMatchObject({ type: "other" });
    expect(parseModelAnswer('{"type":"nonsense","reply":"x"}')).toBeNull();
    expect(parseModelAnswer("no json here")).toBeNull();
    expect(parseModelAnswer("")).toBeNull();
    expect(parseModelAnswer('{"type":"other","reply":42}')).toMatchObject({ type: "other", reply: "" });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the reply guard: what the model wrote is checked before the customer reads it", () => {
  const allowed = { message: "كيف تعملون؟", balancePoints: BALANCE };
  const ok = (t: string) => guardReply(t, allowed);
  it("lets a normal Arabic answer through, with the facts the code gave (200, 0.10, 50, the balance)", () => {
    const r = ok("قيمة النقطة الواحدة ٠٫١٠ جنيه مصري، وأقل طلب ٢٠٠ نقطة، ومنهجية جمع البيانات ٥٠ نقطة، ورصيدك الآن ١١٬٦٧٦ نقطة.");
    expect(r.ok).toBe(true);
  });
  it.each([
    ["a provider name", "نجمع البيانات عبر TREG بسرعة."],
    ["a provider in Arabic letters", "نجمع البيانات عبر تريغ بسرعة."],
    ["another source name", "نستخدم tikhub لذلك."],
    ["dollars (word)", "السعر بالدولار الأمريكي مناسب."],
    ["dollars (sign)", "تكلفة الطلب $5 فقط."],
    ["USD", "السعر 5 USD لكل ألف."],
    ["a Latin digit", "أقل طلب 200 نقطة."],
    ["an emoji", "أهلًا بك 😀 في ديجر."],
    ["a model's name", "أنا نموذج Claude من شركة أخرى."],
    ["a model's maker in Arabic", "أنا نموذج من أنثروبيك."],
    ["a model's name in Arabic", "أنا نموذج هايكو."],
    ["an endpoint id", "نستخدم anyapi.x.search.posts لذلك."],
    ["an internal id", "رقم مهمتك msn_abcdef12345."],
    ["Latin words", "نسلّمك ملف Excel جاهزًا."],
    ["a price the code never gave", "السعر ٣٠٠ نقطة لكل ألف تعليق."],
    ["a delivery count promised", "سنسلّمك ١٠٠٠ تعليق بالتأكيد."],
    ["an empty reply", "   "],
    ["no Arabic at all", "Welcome to the service"],
    ["a reply that is far too long", "كلمة ".repeat(400)],
    ["the words «صف» or «سجل»", "نسلّمك ١٠٠ سجلات منظمة."],
  ])("blocks %s", (_what, text) => {
    const r = ok(text);
    expect(r.ok, text).toBe(false);
  });
  it("lets through a number the customer wrote in their own message (so the answer can repeat it), and never a Latin one", () => {
    expect(guardReply("نعم، يمكننا جمع ٥٠٠ تعليق إن توفرت.", { message: "هل تجمعون 500 تعليق؟", balancePoints: null }).ok).toBe(true);
    expect(guardReply("نعم، يمكننا جمع 500 تعليق إن توفرت.", { message: "هل تجمعون 500 تعليق؟", balancePoints: null }).ok).toBe(false);
  });
  it("a blocked reply is replaced by the fixed reply of its type, end to end (and the customer never reads the blocked words)", async () => {
    for (const bad of ["نجمع البيانات عبر TREG بسرعة.", "السعر $5 فقط 😀", "أقل طلب 200 نقطة", "السعر ٣٠٠ نقطة"]) {
      setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "service_question", reply: bad }) }).call);
      const db = world();
      const { assistant } = await turn(db, "بكام النقطة؟");
      expect(assistant.content_ar, bad).not.toBe(bad);
      expect(assistant.content_ar).toContain("٠٫١٠ جنيه");
      expect(assistant.content_ar).toContain("٢٠٠ نقطة");
      expect(assistant.content_ar).not.toMatch(/TREG|\$|😀|[0-9]/);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the system prompt is built BY CODE from facts of the code", () => {
  const prompt = buildSystemPrompt({ balancePoints: BALANCE, open: null });
  it("says who Diger is, what it does, the five platforms and companies, and the fixed facts: 200 points minimum, 1 point = 0.10 EGP, nothing before approval, only what is delivered, the methodology PDF at 50 points", () => {
    expect(prompt).toContain("ديجر");
    for (const p of ["تيك توك", "إكس", "إنستجرام", "فيسبوك", "يوتيوب"]) expect(prompt).toContain(p);
    expect(prompt).toContain("الشركات");
    expect(prompt).toContain("٢٠٠");
    expect(prompt).toContain("٠٫١٠");
    expect(prompt).toContain("٥٠ نقطة");
    expect(prompt).toMatch(/قبل موافقة/);
    expect(prompt).toMatch(/ما سُلّم/);
    expect(prompt).toContain("١١٬٦٧٦");
    expect(prompt).toContain("OPEN_REQUEST: none");
  });
  it("carries the strict rules: formal friendly Arabic, short, no emoji, Arabic-Indic numerals, no provider/endpoint/dollar/model names, no invented numbers or prices, no promised counts, offer a request", () => {
    for (const rule of ["العربية الفصحى", "قصير", "إيموجي", "الأرقام الهندية", "لا تذكر", "لا تخترع", "لا تَعِد", "اعرض"]) expect(prompt, rule).toContain(rule);
  });
  it("names no provider, no model and no key, and the type set is the code's", () => {
    expect(prompt).not.toMatch(/TREG|tikhub|scrapecreators|anyapi|apify|sk-ant|api[_-]?key|claude|haiku|anthropic|openai/i);
    for (const t of CHAT_TYPES) expect(prompt).toContain(t);
  });
  it("tells the model about an OPEN request (its state and, for a question card, the question) so a short follow-up is read as its edit", () => {
    const p = buildSystemPrompt({ balancePoints: null, open: { id: "msn_open123456", state: "needs_input", questionAr: "أي بلد تقصد؟", requestText: "اجمع شركات مقاولات" } });
    expect(p).toContain("OPEN_REQUEST: needs_input");
    expect(p).toContain("أي بلد تقصد؟");
    expect(p).toContain("اجمع شركات مقاولات");
    expect(p).not.toContain("msn_open123456");
    expect(buildSystemPrompt({ balancePoints: null, open: { id: "msn_open123456", state: "plan_ready" } })).toContain("OPEN_REQUEST: plan_ready");
  });
  it("a balance that could not be read is not invented", () => {
    expect(buildSystemPrompt({ balancePoints: null, open: null })).not.toMatch(/رصيد العميل/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("a non-data message: one model call, no mission, no money, no provider call", () => {
  it("the model gets ONE call per message, with max_tokens 400 or less, the balance in its prompt, and the customer's message last", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world();
    await turn(db, "بكام النقطة؟");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].maxTokens).toBeLessThanOrEqual(400);
    expect(CHAT_MODEL_MAX_TOKENS).toBeLessThanOrEqual(400);
    expect(model.calls[0].system).toContain("١١٬٦٧٦");
    expect(model.calls[0].messages.at(-1)).toEqual({ role: "user", content: "بكام النقطة؟" });
  });
  it("nothing is created or charged: no mission row, no ledger row, no mission event, no network call", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world();
    const before = JSON.stringify(db.rows("credit_ledger"));
    for (const m of ["هاي", "بكام النقطة؟", "ممكن تساعدني في رسالة الماجستير؟", "اكتب لي المنهجية"]) await turn(db, m);
    expect(db.rows("missions")).toHaveLength(0);
    expect(db.rows("mission_events")).toHaveLength(0);
    expect(JSON.stringify(db.rows("credit_ledger"))).toBe(before);
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
  it("the model's reply is what the customer reads (its own words), written on the assistant message, and the customer's message ends «completed»", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "greeting_or_small_talk", reply: "أهلًا بك يا دكتور، يسعدني أن أخدمك. ما البيانات التي تحتاجها لبحثك؟" }) }).call);
    const db = world();
    const { r, assistant, user } = await turn(db, "هاي يا صاحبي");
    expect(r).toMatchObject({ ok: false, contentAr: "أهلًا بك يا دكتور، يسعدني أن أخدمك. ما البيانات التي تحتاجها لبحثك؟" });
    expect(assistant.content_ar).toBe("أهلًا بك يا دكتور، يسعدني أن أخدمك. ما البيانات التي تحتاجها لبحثك؟");
    expect(user.request_status).toBe("completed");
  });
  it("only CODE routes to planning: a data request creates the mission (the model's reply to it is never shown), and a model that says «greeting» for a clear request does not stop it", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "greeting_or_small_talk", reply: "أهلًا بك" }) }).call);
    const db = world();
    const { r, user } = await turn(db, "عايز ١٠٠ تعليق من بوست على فيسبوك عن الغلاء");
    expect(r.ok).toBe(true);
    expect(db.rows("missions")).toHaveLength(1);
    expect(user.request_status).toBe("planning");
  });
  it("a data request through the model: a mission, the card message, no reply text from the model", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world();
    const { r, assistant } = await turn(db, "محتاج داتا لرسالة الدكتوراه عن التسوق الإلكتروني");
    expect(r.ok).toBe(true);
    expect(db.rows("missions")).toHaveLength(1);
    expect(assistant.plan?.agentMissionId).toMatch(/^msn_/);
  });
  it("the chat's own button messages (retry, review) never cost a model call: they are data requests by code", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world();
    await turn(db, "أعد المحاولة بنفس الخطة. اعرض عرض سعر جديدًا فقط، ولا تعتمد أو تبدأ التنفيذ.");
    expect(model.calls).toHaveLength(0);
    expect(db.rows("missions")).toHaveLength(1);
  });
  it("a typed «موافق» is still answered by code (the button approves), with no model call", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world({ status: "plan_ready" });
    const { r } = await turn(db, "أوافق وابدأ البحث");
    expect(r.ok).toBe(false);
    expect(model.calls).toHaveLength(0);
  });
  it("the model down: the round-21 fixed answers, so the chat still answers (greeting: fixed words; «other»: the honest short reply)", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => "fail" }).call);
    const db = world();
    const g = await turn(db, "هاي يا صاحبي");
    expect(g.assistant.content_ar).toContain("ديجر");
    const o = await turn(db, "احكيلي نكتة");
    expect(o.assistant.content_ar).toBe(otherReplyAr());
    expect(db.rows("missions")).toHaveLength(0);
  });
  it("without a test seam the production call refuses to run under tests (a test can never make a paid call)", async () => {
    const db = world();
    const { assistant } = await turn(db, "هاي يا صاحبي");
    expect(assistant.content_ar).toContain("ديجر");
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
});

describe("a methodology request keeps the round-21 behaviour; only the words around it are the model's", () => {
  it("with delivered missions: the model's sentence, then the chooser sentence and the price line before approval (50 points) which the page recognises", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world();
    db.seed("missions", [{ id: "msn_done1234567", user_id: USER, status: "completed", job_id: "job1", delivered_units: 120, request_text: "هات ١٢٠ تعليق", plan_public: { compiled: true }, files: [{ name: "a.xlsx", path: "a.xlsx", kind: "xlsx", download_name: "تعليقات.xlsx" }], created_at: new Date().toISOString() }]);
    const { assistant } = await turn(db, "عايزك تعملي منهجية بحث تكون pdf");
    expect(assistant.content_ar).toContain(METHODOLOGY_CHOOSER_SENTENCE_AR);
    expect(assistant.content_ar).toContain("منهجية الجمع لهذا الطلب: ٥٠ نقطة");
    expect(assistant.content_ar).toContain("تكتب ديجر منهجية جمع البيانات");
    expect(db.rows("missions")).toHaveLength(1);
  });
  it("with none delivered: the model's sentence, then what the document is and the offer to start a data request; no chooser", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world();
    const { assistant } = await turn(db, "عايزك تعملي منهجية بحث تكون pdf");
    expect(assistant.content_ar).not.toContain(METHODOLOGY_CHOOSER_SENTENCE_AR);
    expect(assistant.content_ar).toMatch(/ليس لديك طلب مُسلَّم/);
    expect(assistant.content_ar).toContain("٥٠ نقطة");
  });
  it("a clear ask for a FULL research methodology gets the honest sentence even when the model's words do not say it", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "methodology_request", reply: "بالتأكيد، سأكتبها لك." }) }).call);
    const db = world();
    const { assistant } = await turn(db, "اكتبلي منهجية بحث كاملة فيها تصميم الدراسة والعينة والتحليل الإحصائي");
    expect(assistant.content_ar).toContain("وليس منهجية بحث كاملة");
  });
  it("a model reply that breaks the guard is replaced by the round-21 methodology answer", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "methodology_request", reply: "السعر 50 USD" }) }).call);
    const db = world();
    const { assistant } = await turn(db, "اكتب لي المنهجية");
    expect(assistant.content_ar).not.toMatch(/USD|[0-9]/);
    expect(assistant.content_ar).toContain("٥٠ نقطة");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("an OPEN request receives the customer's follow-ups: its edit or answer path, never a new mission, never a generic reply", () => {
  it("«خليها ٥ تعليقات بس» on a plan waiting for approval: the plan is edited and priced again BY CODE (the stored plan's rows follow), the same mission, nothing held or charged", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world({ status: "plan_ready" });
    const before = db.rows("missions")[0].plan.price.reservePoints;
    const ledger = JSON.stringify(db.rows("credit_ledger"));
    const { r, assistant, user } = await turn(db, "خليها ٥ تعليقات بس");
    expect(r).toMatchObject({ ok: true, missionId: "msn_open123456" });
    const m = db.rows("missions");
    expect(m).toHaveLength(1);
    expect(m[0].status).toBe("plan_ready");
    expect(m[0].plan.stages[0].planned_rows).toBe(5);
    expect(m[0].plan.price.deliveredRows).toBe(5);
    expect(m[0].plan.price.reservePoints).toBeLessThanOrEqual(before);
    expect(m[0].reserved_points).toBe(m[0].plan.price.reservePoints);
    expect(JSON.stringify(db.rows("credit_ledger"))).toBe(ledger);
    expect(assistant.plan).toEqual({ agentMissionId: "msn_open123456" });
    expect(assistant.content_ar).toMatch(/عدّلنا الخطة/);
    expect(user.request_status).toBe("completed");
    expect(db.rows("mission_events").some((e: any) => e.kind === "plan")).toBe(true);
  });
  it("«خليها ٥٠٠»: the count is the number written; a count the model made up changes nothing", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const a = world({ status: "plan_ready" });
    expect((await turn(a, "خليها ٥٠٠")).r.ok).toBe(true);
    expect(a.rows("missions")[0].plan.stages[0].planned_rows).toBe(500);
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: 9999 }) }).call);
    const b = world({ status: "plan_ready" });
    const plan = JSON.stringify(b.rows("missions")[0].plan);
    const { r } = await turn(b, "خليها ٥٠٠");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(b.rows("missions")[0].plan)).toBe(plan);
  });
  it("an edit the plan refuses (a count above the limit) says why in the plan's own Arabic sentence and changes nothing", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "edit_of_open_request", count: 9999999 }) }).call);
    const db = world({ status: "plan_ready" });
    const plan = JSON.stringify(db.rows("missions")[0].plan);
    const { r, assistant } = await turn(db, "خليها ٩٩٩٩٩٩٩");
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toMatch(/العدد/);
    expect(JSON.stringify(db.rows("missions")[0].plan)).toBe(plan);
    expect(db.rows("missions")).toHaveLength(1);
  });
  // CHANGED (round 57): an edit with no number is a REVISION of the same request, planned again from the whole request with the change (13 Nov: the generic «use the button» line answered every such follow-up). The plan it
  // replaces held nothing and is cancelled in the open; the revised mission's words keep the original request.
  it("an edit with no number («خليها بالعربي بس»): a revision of the WHOLE request (never the change's words alone), the old plan replaced in the open, no generic reply", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world({ status: "plan_ready" });
    const original = String(db.rows("missions")[0].request_text);
    const { r, assistant } = await turn(db, "خليها بالعربي بس");
    expect(r.ok).toBe(true);
    expect(assistant.content_ar).toBe(REVISION_STARTED_AR);
    expect(assistant.content_ar).not.toContain("لم أفهم");
    const rows = db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe("cancelled");
    expect(rows[1].request_text.startsWith(original)).toBe(true);
    expect(rows[1].request_text).toContain(`${REVISION_JOINER_AR} خليها بالعربي بس`);
  });
  it("an answer to the question card goes to the mission's answer path: the mission is queued again with the answer text", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world({ status: "needs_input", question_ar: "أي بلد تقصد؟" });
    const { r, assistant } = await turn(db, "السعودية");
    expect(r).toMatchObject({ ok: true, missionId: "msn_open123456" });
    const m = db.rows("missions")[0];
    expect(m.status).toBe("queued");
    expect(m.answer_text).toBe("السعودية");
    expect(db.rows("missions")).toHaveLength(1);
    expect(assistant.plan).toEqual({ agentMissionId: "msn_open123456" });
    expect(assistant.content_ar).toMatch(/وصلت إجابتك/);
  });
  it("the question's text reaches the model so it can tell an answer from a new request", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world({ status: "needs_input", question_ar: "أي بلد تقصد؟" });
    await turn(db, "السعودية");
    expect(model.calls[0].system).toContain("OPEN_REQUEST: needs_input");
    expect(model.calls[0].system).toContain("أي بلد تقصد؟");
  });
  it("while the worker is still reading the request (planning), a follow-up is not lost and not a new mission: it is told the plan is not ready, and nothing changes", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world({ status: "planning" });
    const { r, assistant } = await turn(db, "خليها ٢٠٠");
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toMatch(/لم تجهز|قيد التجهيز|لم تُجهَّز/);
    expect(db.rows("missions")).toHaveLength(1);
    expect(db.rows("missions")[0].status).toBe("planning");
  });
  it("an approved or running request is not «open»: an edit-looking message is then a new data request (the plan was priced and held)", async () => {
    setChatModelForTesting(fakeChatModel().call);
    for (const status of ["approved", "executing", "completed", "cancelled"]) {
      const db = world({ status });
      db.rows("missions")[0].status = status;
      const { r } = await turn(db, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
      expect(r.ok, status).toBe(true);
      expect(db.rows("missions").length, status).toBe(2);
    }
  });
  it("a new, different data request while a plan waits replaces that plan (as before), and a greeting or price question leaves the open plan alone", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world({ status: "plan_ready" });
    await turn(db, "شكرًا");
    await turn(db, "بكام النقطة؟");
    expect(db.rows("missions")).toHaveLength(1);
    expect(db.rows("missions")[0].status).toBe("plan_ready");
    const { r } = await turn(db, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
    expect(r.ok).toBe(true);
    expect(db.rows("missions").find((m: any) => m.id === "msn_open123456").status).toBe("cancelled");
  });
  it("the model never prices or approves: after every kind of turn the ledger is untouched and no mission is «approved»", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world({ status: "plan_ready" });
    const ledger = JSON.stringify(db.rows("credit_ledger"));
    for (const m of ["خليها ٥٠٠", "شكرًا", "بكام النقطة؟", "خليها بالعربي بس", "أوافق وابدأ"]) await turn(db, m);
    expect(JSON.stringify(db.rows("credit_ledger"))).toBe(ledger);
    expect(db.rows("missions").every((m: any) => m.status !== "approved" && m.status !== "executing")).toBe(true);
  });
  it("the model down while a plan waits: the fallback still routes «خليها ٥ تعليقات بس» to the edit", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => "fail" }).call);
    const db = world({ status: "plan_ready" });
    const { r } = await turn(db, "خليها ٥ تعليقات بس");
    expect(r).toMatchObject({ ok: true, missionId: "msn_open123456" });
    expect(db.rows("missions")[0].plan.stages[0].planned_rows).toBe(5);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the production call (no network: fetch is faked)", () => {
  const okBody = (text: string) => ({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }], usage: { input_tokens: 800, output_tokens: 90 } }) });
  it("sends ONE request to the messages endpoint with the system prompt, the history, the 400-token limit and no thinking, and returns the text and usage; the key is never in the request body", async () => {
    const fetchImpl = vi.fn(async () => okBody('{"type":"other","reason":"x","reply":"حسنًا"}'));
    const r = await callClaudeChatWith({ system: "SYSTEM", messages: [{ role: "user", content: "مرحبا" }], maxTokens: 400, timeoutMs: 5000 }, { fetchImpl: fetchImpl as any, resolveKey: async () => "test-key-not-real", model: "claude-haiku-5-5" });
    expect(r).toMatchObject({ ok: true, text: '{"type":"other","reason":"x","reply":"حسنًا"}' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBeLessThanOrEqual(400);
    expect(body.system).toBe("SYSTEM");
    expect(body.messages).toEqual([{ role: "user", content: "مرحبا" }]);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(init.body).not.toContain("test-key-not-real");
    expect(init.headers["x-api-key"]).toBe("test-key-not-real");
  });
  it("no key, an HTTP error, a timeout or a thrown error is a failure (the caller falls back), never an exception", async () => {
    const input = { system: "S", messages: [{ role: "user" as const, content: "x" }], maxTokens: 400, timeoutMs: 5000 };
    expect(await callClaudeChatWith(input, { fetchImpl: vi.fn() as any, resolveKey: async () => "", model: "m" })).toMatchObject({ ok: false, failure: "no_key" });
    expect(await callClaudeChatWith(input, { fetchImpl: (async () => ({ ok: false, status: 529 })) as any, resolveKey: async () => "k", model: "m" })).toMatchObject({ ok: false, failure: "http_529" });
    expect(await callClaudeChatWith(input, { fetchImpl: (async () => { throw new Error("boom"); }) as any, resolveKey: async () => "k", model: "m" })).toMatchObject({ ok: false, failure: "network" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(await callClaudeChatWith(input, { fetchImpl: (async () => { throw abort; }) as any, resolveKey: async () => "k", model: "m" })).toMatchObject({ ok: false, failure: "timeout" });
    expect(await callClaudeChatWith(input, { fetchImpl: (async () => okBody("")) as any, resolveKey: async () => "k", model: "m" })).toMatchObject({ ok: false, failure: "empty" });
  });
});
