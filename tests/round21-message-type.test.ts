import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { METHODOLOGY_CHOOSER_SENTENCE_AR, MESSAGE_TYPES, classifyMessage, greetingReplyAr, isFullResearchMethodologyAsk, methodologyReplyAr, otherReplyAr, serviceAnswerAr, type MessageType } from "../src/lib/agentMission/messageType";
import { METHODOLOGY_POINTS } from "../src/lib/methodologyOffer";

/**
 * ROUND 21, item 1: THE TYPE OF A CHAT MESSAGE, decided by code BEFORE planning. Live (4 Nov 2026): «هاي يا صاحبي» opened a mission card with plan steps, and «عايزك تعملي منهجية بحث تكون pdf» went to planning and ended with
 * «مصادرنا لا تخدم هذا الطلب بالدقة المطلوبة الآن». Only a DATA request may reach mission planning; every other type is answered by code, with no mission and no provider call.
 *
 * THE PERMANENT CORPUS: each message with the type it must get. A new live message that is mistyped is added here (with its expected type), never argued with.
 */
const CORPUS: Array<[string, MessageType]> = [
  // ---- greeting or small talk (the two live ones first)
  ["هاي يا صاحبي", "greeting"],
  ["السلام عليكم", "greeting"],
  ["السلام عليكم ورحمة الله وبركاته", "greeting"],
  ["إزيك", "greeting"],
  ["ازيك يا باشا", "greeting"],
  ["صباح الخير", "greeting"],
  ["مساء الخير يا دكتور", "greeting"],
  ["مرحبا", "greeting"],
  ["أهلاً وسهلاً", "greeting"],
  ["شكرًا", "greeting"],
  ["شكرا جزيلا", "greeting"],
  ["تسلم ايدك", "greeting"],
  ["hi", "greeting"],
  // ---- a question about the service, its prices, its points or how it works
  ["بكام النقطة؟", "service_question"],
  ["كام سعر النقطة", "service_question"],
  ["ايه الحد الأدنى للطلب؟", "service_question"],
  ["هل بتخصموا قبل ما أوافق؟", "service_question"],
  ["ازاي بتحاسبوا على الطلبات؟", "service_question"],
  ["ديجر بتعمل ايه بالظبط؟", "service_question"],
  ["كيف تعمل الخدمة؟", "service_question"],
  ["كيف أشحن رصيدي؟", "service_question"],
  ["كم سعر ملف المنهجية؟", "service_question"],
  ["بكام المنهجية؟", "service_question"],
  ["هل أدفع مقابل ما لم يُسلَّم؟", "service_question"],
  ["انتو مين؟", "service_question"],
  // ---- a methodology request (the live one first)
  ["عايزك تعملي منهجية بحث تكون pdf", "methodology_request"],
  ["اكتب لي المنهجية", "methodology_request"],
  ["محتاج ملف المنهجية بتاع الطلب اللي جمعته", "methodology_request"],
  ["أريد منهجية جمع البيانات بصيغة pdf", "methodology_request"],
  ["عاوز منهجية للبيانات اللي جمعتها", "methodology_request"],
  ["هل تكتبون منهجية الدراسة؟", "methodology_request"],
  ["اكتبلي منهجية بحث كاملة فيها تصميم الدراسة والعينة والتحليل الإحصائي", "methodology_request"],
  ["محتاج المنهجية بتاعة التعليقات اللي سلمتوها", "methodology_request"],
  // ---- a data request
  ["هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا", "data_request"],
  ["عايز ١٠٠ تعليق من بوست على فيسبوك عن الغلاء", "data_request"],
  ["اجمعلي تعليقات هذا الفيديو https://www.youtube.com/watch?v=abc123", "data_request"],
  ["محتاج قائمة شركات مقاولات في القاهرة مع الإيميلات", "data_request"],
  ["هات لي ٥٠ فيديو تيك توك عن الذكاء الاصطناعي", "data_request"],
  ["ابحث عن حسابات إنستجرام لعيادات الأسنان في الرياض", "data_request"],
  ["أريد بيانات مديري التسويق في شركات الاتصالات في مصر", "data_request"],
  ["محتاج مراجعات خرائط جوجل للمطاعم في جدة", "data_request"],
  ["اسحب لي منشورات ريديت عن الهجرة آخر شهر", "data_request"],
  ["هل ممكن تجمعلي ١٠٠ تعليق من فيسبوك؟", "data_request"],
  ["collect 200 tweets about electric cars", "data_request"],
  ["اجمع لي كل الصيدليات في المنصورة مع أرقام الهاتف", "data_request"],
  // ---- anything else
  ["ايه رأيك في الجو النهاردة", "other"],
  ["احكيلي نكتة", "other"],
  ["بتحب الكورة؟", "other"],
  ["اكتب لي قصيدة عن البحر", "other"],
  ["طيب", "other"],
  ["؟؟؟", "other"],
  ["مين رئيس الوزراء", "other"],
];

describe("the corpus (at least 40 Arabic messages, Egyptian and formal)", () => {
  it("has at least 40 messages and covers every type", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(40);
    for (const t of MESSAGE_TYPES) expect(CORPUS.some(([, expected]) => expected === t), t).toBe(true);
  });
  it.each(CORPUS)("«%s» is %s", (message, expected) => {
    expect(classifyMessage(message)).toBe(expected);
  });
  it("the answer is always ONE type of the fixed set, never anything else, whatever arrives (empty, spaces, a very long text, symbols)", () => {
    for (const m of ["", "   ", "\n\n", "😂😂", "a".repeat(5000), "ا ".repeat(3000), "!!!???", "منهجية ".repeat(500), "هات ".repeat(900)]) expect(MESSAGE_TYPES).toContain(classifyMessage(m));
  });
  it("a greeting that carries a request is the request (the data comes first, nothing is lost)", () => {
    expect(classifyMessage("هاي، عايز ١٠٠ تعليق من بوست على فيسبوك")).toBe("data_request");
    expect(classifyMessage("السلام عليكم، محتاج قائمة شركات في القاهرة")).toBe("data_request");
  });
});

describe("a clear ask for a FULL research methodology is told apart from the data-collection one", () => {
  it("study design, sample and analysis words make it «full»; the plain ones do not", () => {
    expect(isFullResearchMethodologyAsk("اكتبلي منهجية بحث كاملة فيها تصميم الدراسة والعينة والتحليل الإحصائي")).toBe(true);
    expect(isFullResearchMethodologyAsk("محتاج منهجية فيها مجتمع الدراسة وفرضيات البحث")).toBe(true);
    expect(isFullResearchMethodologyAsk("عايزك تعملي منهجية بحث تكون pdf")).toBe(false);
    expect(isFullResearchMethodologyAsk("اكتب لي المنهجية")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WHAT IS SAID BACK: fixed facts in code, never invented numbers
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const noDigitsLatin = (t: string) => { expect(t).not.toMatch(/[0-9]/); };
const customerSafe = (t: string) => {
  expect(t).not.toMatch(/[A-Za-z]/);
  expect(t).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(t).not.toMatch(/USD|\$|دولار|TREG|Anthropic|Claude|OpenAI|ScrapeCreators|TikHub|endpoint|anyapi/i);
  expect(t).not.toContain("مصادرنا لا تخدم");
  noDigitsLatin(t);
};

describe("the fixed answers", () => {
  it("a greeting: short, friendly, formal Arabic, says what Diger does and invites a request", () => {
    const t = greetingReplyAr("هاي يا صاحبي");
    customerSafe(t);
    expect(t.length).toBeLessThan(600);
    expect(t).toContain("ديجر");
    expect(t).toMatch(/اكتب/);
    expect(t).toMatch(/جمع|تجمع/);
  });
  it("thanks is answered as thanks, not as a greeting", () => {
    const t = greetingReplyAr("شكرًا");
    customerSafe(t);
    expect(t).toMatch(/عفوًا/);
  });
  it("a price question: the fixed facts only (minimum 200 points, one point 0.10 pound, nothing before approval, only what is delivered, the methodology 50 points)", () => {
    const t = serviceAnswerAr("بكام النقطة؟");
    customerSafe(t);
    expect(t).toContain("٠٫١٠ جنيه");
    expect(t).toContain("٢٠٠ نقطة");
    expect(t).toContain("قبل موافقتك");
    expect(t).toMatch(/ما سُلّم|ما يُسلَّم|إن لم يُسلَّم/);
    expect(t).toContain("٥٠ نقطة");
    // no other number is ever said
    const numbers = (t.match(/[٠-٩]+(?:٫[٠-٩]+)?/g) ?? []).sort();
    expect([...new Set(numbers)]).toEqual(["٠٫١٠", "٢٠٠", "٥٠"]);
  });
  it("how the service works: the steps, the approval button and the file, with no number", () => {
    const t = serviceAnswerAr("كيف تعمل الخدمة؟");
    customerSafe(t);
    expect(t).toMatch(/اعتمد/);
    expect(t).toMatch(/إكسل/);
  });
  it("a question about the methodology's price says 50 points, the same constant the button shows", () => {
    expect(METHODOLOGY_POINTS).toBe(50);
    const t = serviceAnswerAr("بكام المنهجية؟");
    customerSafe(t);
    expect(t).toContain("٥٠ نقطة");
  });
  it("other: a short honest reply that says what Diger collects and how to ask", () => {
    const t = otherReplyAr();
    customerSafe(t);
    expect(t.length).toBeLessThan(500);
    expect(t).toMatch(/اكتب/);
  });
  it("methodology with no delivered request: says plainly what it is and offers to start a data request", () => {
    const t = methodologyReplyAr({ text: "عايزك تعملي منهجية بحث تكون pdf", delivered: 0 });
    customerSafe(t);
    expect(t).toMatch(/كيف جُمعت/);
    expect(t).toMatch(/ابدأ|اكتب/);
    expect(t).not.toContain(METHODOLOGY_CHOOSER_SENTENCE_AR);
  });
  it("methodology with delivered requests: the chooser sentence and the price line the card shows before approval", () => {
    const t = methodologyReplyAr({ text: "اكتب لي المنهجية", delivered: 2 });
    customerSafe(t);
    expect(t).toContain(METHODOLOGY_CHOOSER_SENTENCE_AR);
    expect(t).toContain("منهجية الجمع لهذا الطلب: ٥٠ نقطة");
  });
  it("a FULL research methodology ask gets one honest sentence first, in both cases, then the offer", () => {
    const ask = "اكتبلي منهجية بحث كاملة فيها تصميم الدراسة والعينة والتحليل الإحصائي";
    for (const delivered of [0, 3]) {
      const t = methodologyReplyAr({ text: ask, delivered });
      customerSafe(t);
      expect(t.startsWith("تكتب ديجر حاليًا منهجية جمع البيانات لطلباتك")).toBe(true);
      expect(t).toMatch(/ليس منهجية بحث كاملة/);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE CHAT, END TO END: the real handler with the agent switched on (as the live site is)
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function setup(seedMissions: Array<Record<string, unknown>> = []) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: "u1", title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: "u1", email: "a@example.com" }]);
  if (seedMissions.length) db.seed("missions", seedMissions);
  const handler = new ChatHandler(db);
  const oldPath = vi.fn(async () => { throw new Error("the old model path ran"); });
  (handler as any).llm.executeTurn = oldPath;
  handler.agentChat = { enabled: true };
  return { db, handler, oldPath };
}
const ask = (handler: ChatHandler, message: string) => handler.handleUserMessage({ userId: "u1", conversationId: "conv1", message, userBalance: 40_000 });
const DELIVERED = { id: "msn_aaaaaaaaaaaaaaaaaaaa", user_id: "u1", status: "completed", job_id: "job_1", delivered_units: 120, charged_points: 300, request_text: "هات ١٢٠ تغريدة", plan_public: { compiled: true }, files: [{ name: "result.xlsx", path: "result/result.xlsx", kind: "xlsx" }], created_at: "2026-11-01T10:00:00Z" };

describe("the live messages of finding A, through the real chat handler (the agent on)", () => {
  it("«هاي يا صاحبي»: a short greeting answer, NO mission row, no mission card, no model, no provider call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("a network call was made"); });
    try {
      const { db, handler, oldPath } = setup();
      const r: any = await ask(handler, "هاي يا صاحبي");
      expect(r.outputType).toBe("answer_question");
      expect(r.agentMission).toBeUndefined();
      expect(r.contentAr).toBe(greetingReplyAr("هاي يا صاحبي"));
      expect(db.rows("missions")).toHaveLength(0);
      expect(oldPath).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      const assistant = db.rows("messages").find((m: any) => m.id === r.messageId);
      expect(assistant.content_ar).toBe(r.contentAr);
      expect(assistant.plan ?? null).toBeNull();
    } finally { fetchSpy.mockRestore(); }
  });

  it("«عايزك تعملي منهجية بحث تكون pdf»: the methodology answer, never «مصادرنا لا تخدم»; no mission is created", async () => {
    const { db, handler } = setup();
    const r: any = await ask(handler, "عايزك تعملي منهجية بحث تكون pdf");
    expect(r.outputType).toBe("answer_question");
    expect(r.agentMission).toBeUndefined();
    expect(r.contentAr).toBe(methodologyReplyAr({ text: "عايزك تعملي منهجية بحث تكون pdf", delivered: 0 }));
    expect(r.contentAr).not.toContain("مصادرنا لا تخدم");
    expect(db.rows("missions")).toHaveLength(0);
  });

  it("the same message of a customer who HAS a delivered compiled request: the chooser sentence (the page draws the card), still no mission created", async () => {
    const { db, handler } = setup([DELIVERED]);
    const r: any = await ask(handler, "عايزك تعملي منهجية بحث تكون pdf");
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toContain(METHODOLOGY_CHOOSER_SENTENCE_AR);
    expect(r.contentAr).toContain("منهجية الجمع لهذا الطلب: ٥٠ نقطة");
    expect(db.rows("missions")).toHaveLength(1);
  });

  it("a delivered request of ANOTHER customer, an old plan, or one with nothing delivered is not offered", async () => {
    const { handler } = setup([{ ...DELIVERED, user_id: "u2" }, { ...DELIVERED, id: "msn_bbbbbbbbbbbbbbbbbbbb", plan_public: { compiled: false } }, { ...DELIVERED, id: "msn_cccccccccccccccccccc", delivered_units: 0 }, { ...DELIVERED, id: "msn_dddddddddddddddddddd", job_id: null }]);
    const r: any = await ask(handler, "اكتب لي المنهجية");
    expect(r.contentAr).not.toContain(METHODOLOGY_CHOOSER_SENTENCE_AR);
  });

  it("«بكام النقطة؟» is answered from the fixed facts, with no mission", async () => {
    const { db, handler } = setup();
    const r: any = await ask(handler, "بكام النقطة؟");
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(serviceAnswerAr("بكام النقطة؟"));
    expect(db.rows("missions")).toHaveLength(0);
  });

  it("a data request still becomes a mission (nothing else changed)", async () => {
    const { db, handler } = setup();
    const r: any = await ask(handler, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
    expect(r.outputType).toBe("agent_mission");
    expect(db.rows("missions")).toHaveLength(1);
  });

  it("the user's message is not left «planning» after an answer by code", async () => {
    const { db, handler } = setup();
    await ask(handler, "هاي يا صاحبي");
    const user = db.rows("messages").find((m: any) => m.role === "user");
    expect(user.request_status).toBe("completed");
  });
});
