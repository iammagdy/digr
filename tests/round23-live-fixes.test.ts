import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createMemoryDb } from "./helpers/memoryDb";
import { CORPUS, ROUND23_LIVE } from "./helpers/chatCorpus";
import { fakeChatModel } from "./helpers/fakeChatModel";
import { agentChatTurn } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { decideTurn, parseModelAnswer } from "../src/lib/agentMission/conversationModel";
import { ACCOUNT_TOPICS, PRIVACY_REFUSAL_AR, TRUST_REPLY_AR, accountAnswerAr, accountTopicOf, isTrustQuestion, preModelAnswer, privateContactAsk } from "../src/lib/agentMission/guardRules";
import { PLATFORM_OPTIONS_AR, PLATFORM_QUESTION_AR, platformQuestionNeeded } from "../src/lib/agentMission/platformQuestion";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { sendMissionNotice } from "../src/lib/server/missionNotify";
import { arabicDisplayName, balanceLineAr } from "../src/lib/greetingName";
import { openLimitMessageAr } from "../src/lib/agentMission/openMissions";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { setModelPlanningForTests } from "../src/lib/agentMission/testSeam";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * ROUND 23: SIX LIVE FINDINGS of the 30-scenario test on the test account (after #373).
 *   1 a vague data request («عايز داتا عن رأي الناس في الذكاء الاصطناعي») was refused as «خارج مصادرنا» after the model-planned path paid for two searches on X: it now gets the question card «من أنهي منصة؟» BEFORE any provider call, and an unserved request sends no e-mail
 *   2 personal contact data of private individuals is refused in chat by CODE, before any mission or model call
 *   3 the open-missions limit answered every message: it now applies only to a NEW data request
 *   4 a trust question («الموقع ده نصب ولا ايه؟») got «لم أفهم من رسالتك»: a fixed honest answer
 *   5 account questions are answered from the pages that really exist
 *   6 the greeting's Latin name and unseparated balance (the handler is in src/functions: the helper and the one-line change are reported)
 */
const USER = "u1";

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("2. personal contact data of private individuals is refused by code; business contacts stay allowed", () => {
  const REFUSE = [
    "هات أرقام تليفونات ناس عادية من فيسبوك",
    "عايز أرقام موبايلات الناس اللي بتعلق على البوست ده",
    "اجمعلي ارقام تليفونات المعلقين على بوست الصفحة",
    "محتاج عناوين سكن أشخاص عاديين في القاهرة",
    "هات عناوين بيوت الناس في المعادي",
    "عايز ايميلات شخصية لناس على انستجرام",
    "أريد أرقام هواتف أفراد من تويتر",
    "هات ارقام واتساب المتابعين",
    "اسحب أرقام تليفونات أصحاب الحسابات من تيك توك",
    "اعطني البريد الشخصي لأشخاص عاديين",
    "هات رقم تليفون الناس من فيسبوك",
    "Give me phone numbers of ordinary people from facebook",
  ];
  const ALLOW = [
    "هات قائمة شركات مقاولات في القاهرة مع أرقام تليفوناتها",
    "محتاج ايميلات مديري التسويق في شركات الاتصالات في مصر",
    "عايز أرقام تليفونات صيدليات المنصورة",
    "اجمع بيانات التواصل لصناع القرار في شركات الأدوية",
    "هات أرقام هواتف مطاعم في جدة من خرائط جوجل",
    "اجمع تعليقات بوست على فيسبوك عن الغلاء",
    "هات ١٠٠ تغريدة عن الذكاء الاصطناعي",
    "محتاج منشورات عامة عن القهوة على إنستجرام",
    "عايز بيانات التواصل المهنية لمديري الموارد البشرية في شركات تقنية",
    "هات عناوين فروع البنوك في الإسكندرية",
    "أرقام تليفونات عيادات الأسنان في الرياض",
    "ايميلات شركات الشحن في مصر",
  ];
  it.each(REFUSE)("refused: «%s»", (m) => { expect(privateContactAsk(m), m).toBe(true); expect(preModelAnswer(m)?.kind, m).toBe("privacy_refusal"); });
  it.each(ALLOW)("allowed (not refused): «%s»", (m) => { expect(privateContactAsk(m), m).toBe(false); expect(preModelAnswer(m)?.kind ?? null, m).not.toBe("privacy_refusal"); });
  it("the refusal is polite, says one sentence on privacy, offers what Diger can do, and is clean customer text", () => {
    expect(PRIVACY_REFUSAL_AR).toMatch(/خصوصي/);
    expect(PRIVACY_REFUSAL_AR).toMatch(/المنشورات والتعليقات العامة/);
    expect(PRIVACY_REFUSAL_AR).toMatch(/للشركات/);
    expect(PRIVACY_REFUSAL_AR).toMatch(/صناع القرار/);
    expect(checkCustomerText(PRIVACY_REFUSAL_AR, { maxChars: 600 }).issues).toEqual([]);
    expect(PRIVACY_REFUSAL_AR).not.toMatch(/[0-9]|\p{Extended_Pictographic}/u);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("5. account questions are answered from the pages that really exist (and only those)", () => {
  const settings = readFileSync(new URL("../src/app/dashboard/settings/page.tsx", import.meta.url), "utf8");
  const shell = readFileSync(new URL("../src/components/app/AppShell.tsx", import.meta.url), "utf8");
  const topup = readFileSync(new URL("../src/app/dashboard/topup/page.tsx", import.meta.url), "utf8");
  const contact = readFileSync(new URL("../src/app/contact/page.tsx", import.meta.url), "utf8");
  const login = readFileSync(new URL("../src/app/login/page.tsx", import.meta.url), "utf8");

  it("the pages and labels the answers name exist in the code: «الإعدادات»، «الملف الشخصي»، «الاسم»، «كلمة المرور»، «تغيير كلمة المرور»، «حذف الحساب»، «المحفظة»، «شحن الرصيد»، «تواصل معنا»، «نسيت كلمة المرور؟»", () => {
    expect(shell).toContain('label: "الإعدادات"');
    expect(shell).toContain('label: "المحفظة"');
    for (const t of ["الملف الشخصي", ">الاسم<", ">كلمة المرور<", "تغيير كلمة المرور", "حذف الحساب"]) expect(settings, t).toContain(t);
    expect(topup).toContain("شحن الرصيد");
    expect(contact).toContain("تواصل معنا");
    expect(login).toContain("نسيت كلمة المرور؟");
  });
  it("there is NO e-mail field in the settings (the e-mail is shown, not editable): the answer says so plainly and points to support", () => {
    expect(settings).not.toMatch(/type="email"|autoComplete="email"|تغيير البريد/);
    expect(accountAnswerAr("email")).toMatch(/غير متاح/);
    expect(accountAnswerAr("email")).toContain("تواصل معنا");
  });
  const CASES: Array<[string, (typeof ACCOUNT_TOPICS)[number]]> = [
    ["ممكن أغير اسمي في الحساب؟", "name"], ["ازاي اغير الاسم بتاعي", "name"], ["عايز أعدل اسمي", "name"],
    ["ازاي اغير الايميل بتاعي؟", "email"], ["عايز أغير البريد الإلكتروني للحساب", "email"],
    ["ازاي اغير كلمة السر؟", "password"], ["نسيت الباسورد", "password"], ["كيف أغيّر كلمة المرور؟", "password"],
    ["ازاي امسح حسابي؟", "delete"], ["أريد حذف حسابي", "delete"], ["عايز اقفل الاكاونت", "delete"],
    ["ازاي اشحن رصيدي؟", "topup"], ["كيف أشحن الرصيد", "topup"], ["عايز اضيف رصيد", "topup"],
  ];
  it.each(CASES)("«%s» is the %s question and gets its fixed answer", (m, topic) => {
    expect(accountTopicOf(m), m).toBe(topic);
    const a = preModelAnswer(m)!;
    expect(a.kind).toBe("account");
    expect(a.contentAr).toBe(accountAnswerAr(topic));
    expect(checkCustomerText(a.contentAr, { maxChars: 600 }).issues, a.contentAr).toEqual([]);
    expect(a.contentAr).not.toMatch(/[0-9]|\p{Extended_Pictographic}/u);
  });
  it("each answer names only real places: the name and password in «الإعدادات», delete in «الإعدادات» then «حذف الحساب», top-up in «المحفظة» then «شحن الرصيد»", () => {
    expect(accountAnswerAr("name")).toMatch(/الإعدادات[\s\S]*الملف الشخصي[\s\S]*الاسم[\s\S]*حفظ/);
    expect(accountAnswerAr("password")).toMatch(/الإعدادات[\s\S]*كلمة المرور[\s\S]*تغيير كلمة المرور/);
    expect(accountAnswerAr("password")).toContain("نسيت كلمة المرور؟");
    expect(accountAnswerAr("delete")).toMatch(/الإعدادات[\s\S]*حذف الحساب/);
    expect(accountAnswerAr("topup")).toMatch(/المحفظة[\s\S]*شحن الرصيد/);
  });
  it("a data request that merely contains a word like «حسابات» or «البريد» is NOT an account question", () => {
    for (const m of ["هات حسابات إنستجرام لعيادات الأسنان في الرياض", "ممكن تجمعلي ١٠٠ تعليق من فيسبوك؟", "عايز البريد الإلكتروني لمديري شركات مقاولات", "اجمع لي كل الصيدليات في المنصورة مع أرقام الهاتف"]) expect(accountTopicOf(m), m).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("4. a trust question gets a short honest answer from fixed facts", () => {
  it.each(["الموقع ده نصب ولا ايه؟", "هل الموقع نصاب؟", "انتو نصابين؟", "الخدمة دي مضمونة؟", "هل يمكن الوثوق بكم؟", "فلوسي هتضيع؟", "الموقع ده حقيقي ولا وهمي؟"])("«%s»", (m) => {
    expect(isTrustQuestion(m), m).toBe(true);
    expect(preModelAnswer(m)).toEqual({ kind: "trust", contentAr: TRUST_REPLY_AR });
  });
  it("it says only the facts: nothing before approval, the price seen before approving, charge only for what is delivered, an undelivered hold is released; nothing invented (no license, no guarantee, no number)", () => {
    expect(TRUST_REPLY_AR).toMatch(/لا يُخصم منك شيء قبل/);
    expect(TRUST_REPLY_AR).toMatch(/الخطة والسعر/);
    expect(TRUST_REPLY_AR).toMatch(/ما سُلّم لك فعلًا/);
    expect(TRUST_REPLY_AR).toMatch(/يُحرَّر كاملًا/);
    expect(TRUST_REPLY_AR).not.toMatch(/ترخيص|مرخص|نضمن|ضمان|معتمد|أكثر من|عميل|[٠-٩0-9]/);
    expect(checkCustomerText(TRUST_REPLY_AR, { maxChars: 700 }).issues).toEqual([]);
    expect(TRUST_REPLY_AR.length).toBeLessThan(450);
  });
  it("ordinary questions about the service are not trust questions", () => {
    for (const m of ["بكام النقطة؟", "هل بتخصموا قبل ما أوافق؟", "ديجر بتعمل ايه بالظبط؟", "انت مين", "يعني ايه ديجر الذكي"]) expect(isTrustQuestion(m), m).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the fixed rules never take a message of the round-21 and round-22 corpus", () => {
  it("none of the 79 corpus messages is answered by a pre-model rule, except the top-up question, which is now an account question with the real page", () => {
    for (const e of CORPUS) {
      if (e.text === "كيف أشحن رصيدي؟") { expect(preModelAnswer(e.text), e.text).toMatchObject({ kind: "account", topic: "topup" }); continue; }
      expect(preModelAnswer(e.text), e.text).toBeNull();
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function world(openQueued = 0) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 11676 }]);
  db.seed("mission_events", []);
  db.seed("messages", []);
  db.seed("missions", Array.from({ length: openQueued }, (_, i) => ({ id: `msn_open${i}0000000`, user_id: USER, status: "queued", request_text: `طلب مفتوح ${i}`, created_at: new Date(Date.now() - i * 1000).toISOString() })));
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
  return { r, assistant: db.rows("messages").find((m: any) => m.id === assistantMsgId), user: db.rows("messages").find((m: any) => m.id === userMsgId) };
}
beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); })); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

describe("3. the open-missions limit applies only to a NEW data request", () => {
  const OPEN = 3;
  it("with three open missions, a new DATA request gets the limit sentence (as before) and creates nothing", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world(OPEN);
    const { r, assistant } = await turn(db, "هات ٣٠٠ تغريدة عن محمد صلاح بعد انتقاله لتركيا");
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toContain("عندك مهام مفتوحة بالفعل");
    expect(db.rows("missions")).toHaveLength(OPEN);
  });
  it.each([
    ["ممكن أغير اسمي في الحساب؟", /الإعدادات/],
    ["هات أرقام تليفونات ناس عادية من فيسبوك", /خصوصي/],
    ["الموقع ده نصب ولا ايه؟", /لا يُخصم منك شيء قبل/],
    ["ازاي اشحن رصيدي؟", /المحفظة/],
    ["بكام النقطة؟", /جنيه/],
    ["هاي يا صاحبي", /ديجر/],
    ["شكرًا", /./],
    ["يعني ايه ديجر الذكي", /ديجر/],
  ])("with three open missions «%s» is answered normally (never the limit sentence)", async (m, expected) => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world(OPEN);
    const { r, assistant } = await turn(db, m);
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toMatch(expected);
    expect(assistant.content_ar).not.toContain("عندك مهام مفتوحة");
    expect(db.rows("missions")).toHaveLength(OPEN);
  });
  it("…and the model down (keyword fallback) does not turn «ممكن أغير اسمي في الحساب؟» into a data request either", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => "fail" }).call);
    const db = world(OPEN);
    const { assistant } = await turn(db, "ممكن أغير اسمي في الحساب؟");
    expect(assistant.content_ar).not.toContain("عندك مهام مفتوحة");
    expect(assistant.content_ar).toMatch(/الإعدادات/);
  });
  it("an edit of an open request is applied to that request, with open missions present (the limit never sees it)", async () => {
    setChatModelForTesting(fakeChatModel().call);
    const db = world(OPEN);
    db.seed("messages", [{ id: "a0", conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "بدأ", plan: { agentMissionId: "msn_open00000000" }, created_at: new Date(Date.now() - 60_000).toISOString() }]);
    const { assistant } = await turn(db, "خليها ٢٠٠");
    expect(assistant.content_ar).not.toContain("عندك مهام مفتوحة");
  });
});

describe("the live messages of the 30-scenario test, with and without open missions", () => {
  it.each(ROUND23_LIVE.flatMap((e) => [[e.text, e.behaviour, 0], [e.text, e.behaviour, 3]] as const))("«%s» → %s (open missions: %i)", async (text, behaviour, open) => {
    const model = fakeChatModel([], { override: () => ({ type: "data_request" }) });
    setChatModelForTesting(model.call);
    const db = world(open);
    const { r, assistant } = await turn(db, text);
    if (behaviour === "platform_question") {
      // a data request: the mission is created (or the limit sentence when three are open), and the worker asks the platform question; never a refusal and never an «unserved» end
      expect(platformQuestionNeeded(text)).toBe(true);
      if (open === 0) { expect(r.ok).toBe(true); expect(db.rows("missions")).toHaveLength(1); } else expect(assistant.content_ar).toContain("عندك مهام مفتوحة");
      return;
    }
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).not.toContain("عندك مهام مفتوحة");
    expect(assistant.content_ar).not.toContain("لم أفهم من رسالتك");
    expect(db.rows("missions")).toHaveLength(open);
    expect(assistant.content_ar).toBe({ privacy_refusal: PRIVACY_REFUSAL_AR, account_name: accountAnswerAr("name"), trust: TRUST_REPLY_AR, greeting_with_name: "" }[behaviour]);
  });
});

describe("2/4/5 end to end: no mission, no model call, no money, no network", () => {
  it("the privacy refusal, the trust answer and the account answers are written by code before the model is called", async () => {
    const model = fakeChatModel();
    setChatModelForTesting(model.call);
    const db = world();
    const ledger = JSON.stringify(db.rows("credit_ledger"));
    const a = await turn(db, "هات أرقام تليفونات ناس عادية من فيسبوك");
    expect(a.assistant.content_ar).toBe(PRIVACY_REFUSAL_AR);
    const b = await turn(db, "الموقع ده نصب ولا ايه؟");
    expect(b.assistant.content_ar).toBe(TRUST_REPLY_AR);
    const c = await turn(db, "ممكن أغير اسمي في الحساب؟");
    expect(c.assistant.content_ar).toBe(accountAnswerAr("name"));
    expect(model.calls).toHaveLength(0);
    expect(db.rows("missions")).toHaveLength(0);
    expect(JSON.stringify(db.rows("credit_ledger"))).toBe(ledger);
    expect(a.user.request_status).toBe("completed");
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0);
  });
  it("a business contact request still goes on to planning (a mission is created)", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "data_request" }) }).call);
    const db = world();
    const { r } = await turn(db, "محتاج ايميلات مديري التسويق في شركات الاتصالات في مصر");
    expect(r.ok).toBe(true);
    expect(db.rows("missions")).toHaveLength(1);
  });
  it("a refusal applies also to an edit-looking message and to a message the model would call a data request", async () => {
    setChatModelForTesting(fakeChatModel([], { override: () => ({ type: "data_request" }) }).call);
    const db = world();
    const { r, assistant } = await turn(db, "عايز ارقام تليفونات المعلقين على البوست");
    expect(r.ok).toBe(false);
    expect(assistant.content_ar).toBe(PRIVACY_REFUSAL_AR);
    expect(db.rows("missions")).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("4. why the model path fell back to the keyword reply: the failure is now recorded, and a reply with a raw line break is no longer lost", () => {
  it("a JSON reply whose text holds a raw line break (a model's habit) is read; before it was unreadable and fell back to the keyword words", () => {
    const raw = '{"type":"service_question","reason":"trust","reply":"أفهم حرصك.\nلا يُخصم شيء قبل موافقتك.","count":null}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(parseModelAnswer(raw)).toMatchObject({ type: "service_question", reply: "أفهم حرصك. لا يُخصم شيء قبل موافقتك." });
  });
  it("a reply cut at the token limit still yields its type (the type comes first), with no reply to show", () => {
    const cut = '{"type":"other","reason":"general question","reply":"يسعدني أن أساعدك فيما أتقنه: جمع بيانات بحثك من وسائل التواصل وال';
    expect(parseModelAnswer(cut)).toMatchObject({ type: "other", reply: "" });
  });
  it("the decision carries the failure code of a failed call (http, timeout, unreadable) so the log says why", async () => {
    const failing = fakeChatModel([], { override: () => "fail" });
    expect(await decideTurn({ message: "ايه رأيك في الجو", balancePoints: null, open: null }, failing.call)).toMatchObject({ source: "keyword", failure: "http_529" });
    const garbage = fakeChatModel([], { override: () => "garbage" });
    expect(await decideTurn({ message: "ايه رأيك في الجو", balancePoints: null, open: null }, garbage.call)).toMatchObject({ source: "keyword", failure: "unreadable" });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("1. a data request with no platform asks «من أنهي منصة؟» before anything is read", () => {
  it("the question and its five one-tap choices", () => {
    expect(PLATFORM_QUESTION_AR).toBe("من أنهي منصة؟");
    expect(PLATFORM_OPTIONS_AR).toEqual(["تيك توك", "إكس", "إنستجرام", "فيسبوك", "يوتيوب"]);
  });
  it("each choice, read with the request, names its platform (so the normal compiled path takes it)", () => {
    const want = ["tiktok", "x", "instagram", "facebook", "youtube"];
    PLATFORM_OPTIONS_AR.forEach((o, i) => expect(buildRequestContract("عايز داتا عن رأي الناس في الذكاء الاصطناعي", o).platform, o).toBe(want[i]));
  });
  it.each([
    "عايز داتا عن رأي الناس في الذكاء الاصطناعي",
    "محتاج أعرف كلام الناس عن الغلاء",
    "هات آراء الناس في الدراما الجديدة",
    "عايز تعليقات عن مسلسل رمضان",
    "اجمعلي منشورات عن القهوة",
    "هات ١٠٠ فيديو عن الذكاء الاصطناعي",
    "أريد ردود فعل الناس على القرار الجديد",
  ])("asked: «%s»", (m) => { expect(platformQuestionNeeded(m)).toBe(true); });
  it.each([
    "عايز ١٠٠ تعليق من بوست على فيسبوك عن الغلاء",
    "هات ٣٠٠ تغريدة عن محمد صلاح",
    "اجمعلي تعليقات هذا الفيديو https://www.youtube.com/watch?v=abc123",
    "محتاج قائمة شركات مقاولات في القاهرة مع الإيميلات",
    "ابحث عن حسابات إنستجرام لعيادات الأسنان في الرياض",
    "محتاج مراجعات خرائط جوجل للمطاعم في جدة",
    "اسحب لي منشورات ريديت عن الهجرة آخر شهر",
    "اجمع لي كل الصيدليات في المنصورة مع أرقام الهاتف",
    "بكام النقطة؟",
  ])("not asked: «%s»", (m) => { expect(platformQuestionNeeded(m)).toBe(false); });
  it("once the customer answered (a platform or anything else), the question is never asked again", () => {
    expect(platformQuestionNeeded("عايز داتا عن رأي الناس في الذكاء الاصطناعي", "تيك توك")).toBe(false);
    expect(platformQuestionNeeded("عايز داتا عن رأي الناس في الذكاء الاصطناعي", "مش عارف")).toBe(false);
  });

  const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
  // the shared test setup turns the fake-model planning on; the question is the production behaviour (as the social gate's own tests, these turn it off)
  beforeEach(() => { setModelPlanningForTests(false); });
  afterEach(() => { setModelPlanningForTests(true); });
  function setup() {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const call = vi.fn(async () => { throw new Error("no provider call in this test"); });
    const notes: Array<{ kind: string; jobId: string | null }> = [];
    const driver = createFakeDriver([]);
    const runs = { n: 0 };
    const counting = { ...driver, async run(input: any) { runs.n += 1; return driver.run(input); } } as any;
    const deps: RunnerDeps = { store, client: money.client, catalog: loadTregCatalog(), driver: counting, recorder: rec.recorder, commit: rec.commit, call: call as any, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: async (n) => { notes.push({ kind: n.kind, jobId: n.jobId }); } };
    return { store, deps, call, notes, runs };
  }
  it("THE WORKER: the vague request becomes a question card with the five choices, with no model turn, no provider call and no notice (the live request paid for two X searches and 20 model turns, then ended «خارج مصادرنا»)", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const t = setup();
    t.store.missions.set("msn_v1", newMission({ id: "msn_v1", user_id: USER_ID, request_text: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
    await runPlanning(t.deps, t.store.missions.get("msn_v1")!);
    const m = t.store.missions.get("msn_v1")!;
    expect(m).toMatchObject({ status: "needs_input", question_ar: "من أنهي منصة؟", worker_id: null, lease_until: null });
    expect((m.plan_public as any).question_options).toEqual(PLATFORM_OPTIONS_AR);
    expect(t.runs.n).toBe(0);
    expect(t.call).not.toHaveBeenCalled();
    expect(t.notes).toEqual([]);
    expect(t.store.events.some((e: any) => e.kind === "question" && e.message_ar === "من أنهي منصة؟")).toBe(true);
  });
  it("THE WORKER: after the answer the request is planned on its platform (no second question)", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const t = setup();
    t.store.missions.set("msn_v2", newMission({ id: "msn_v2", user_id: USER_ID, request_text: "عايز داتا عن رأي الناس في الذكاء الاصطناعي", answer_text: "تيك توك", status: "planning", worker_id: "w1", lease_until: new Date(Date.now() + 60_000).toISOString() }));
    await runPlanning(t.deps, t.store.missions.get("msn_v2")!);
    expect(t.store.missions.get("msn_v2")!.question_ar ?? null).not.toBe("من أنهي منصة؟");
  });
  it("THE WORKER: a request with its platform, or a company list, is not asked", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    for (const text of ["محتاج قائمة شركات مقاولات في القاهرة", "عايز ١٠٠ تعليق من بوست على فيسبوك عن الغلاء"]) {
      const t = setup();
      t.store.missions.set("msn_v3", newMission({ id: "msn_v3", user_id: USER_ID, request_text: text, status: "planning" }));
      await runPlanning(t.deps, t.store.missions.get("msn_v3")!);
      expect(t.store.missions.get("msn_v3")!.question_ar ?? null, text).not.toBe("من أنهي منصة؟");
    }
  });
  it("the question card shows all five choices (the card showed at most four)", () => {
    const view = readFileSync(new URL("../src/lib/agentMission/customerView.ts", import.meta.url), "utf8");
    expect(view).not.toMatch(/question_options\.map\(String\)\.slice\(0, 4\)/);
    expect(view).toMatch(/question_options\.map\(String\)\.slice\(0, 6\)/);
  });
});

describe("1. a request declined before it started sends no e-mail (the in-site notice stays)", () => {
  function notifyWorld() {
    const sent: any[] = [];
    const db: any = createMemoryDb();
    db.seed("missions", [{ id: "msn_n1", user_id: "u9", request_text: "عايز داتا", plan: null }]);
    db.seed("notifications", []);
    const client: any = { from: (t: string) => db.from(t), auth: { admin: { getUserById: async () => ({ data: { user: { id: "u9", email: "a@example.com", user_metadata: {} } } }) } } };
    return { client, db, sent };
  }
  const facts = { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false };
  it("the e-mail sender is src/lib/server/missionNotify.ts (called by the worker's tell()): an «unserved» notice with NO job writes the in-site notice and sends no e-mail", async () => {
    const w = notifyWorld();
    const mailer = vi.fn(async () => ({ ok: true }));
    vi.doMock("../src/lib/server/sendPlatformEmail", async () => ({ sendPlatformEmail: mailer, resolveDisplayName: () => "x" }));
    vi.resetModules();
    const mod = await import("../src/lib/server/missionNotify");
    const out = await mod.sendMissionNotice(w.client, { userId: "u9", missionId: "msn_n1", jobId: null, kind: "unserved", facts });
    expect(out.email).toBe(false);
    expect(mailer).not.toHaveBeenCalled();
    vi.doUnmock("../src/lib/server/sendPlatformEmail");
    void sendMissionNotice;
  });
  it("a notice of a mission that HAD a job (a measured run that delivered nothing, the hold released) keeps its e-mail", async () => {
    const w = notifyWorld();
    const mailer = vi.fn(async () => ({ ok: true }));
    vi.doMock("../src/lib/server/sendPlatformEmail", async () => ({ sendPlatformEmail: mailer, resolveDisplayName: () => "x" }));
    vi.resetModules();
    const mod = await import("../src/lib/server/missionNotify");
    await mod.sendMissionNotice(w.client, { userId: "u9", missionId: "msn_n1", jobId: "job1", kind: "unserved", facts: { ...facts, hasJob: true, releasedPoints: 230 } });
    expect(mailer).toHaveBeenCalledTimes(1);
    vi.doUnmock("../src/lib/server/sendPlatformEmail");
  });
});

describe("6. the greeting's name and balance (the handler's one-line change is reported; the helper is tested here)", () => {
  it("a name written in Arabic letters is used; a Latin name, an empty one or a mixed one is not (the greeting says «أهلًا بك»)", () => {
    expect(arabicDisplayName("أمل محمود")).toBe("أمل محمود");
    expect(arabicDisplayName("  دكتور أحمد  ")).toBe("دكتور أحمد");
    for (const n of ["codex test", "John", "أحمد Ali", "", "   ", null, undefined, "١٢٣"]) expect(arabicDisplayName(n as any), String(n)).toBeNull();
  });
  it("the balance is written with the Arabic thousands separator", () => {
    expect(balanceLineAr(11676)).toBe("رصيدك المتاح ١١٬٦٧٦ نقطة. ");
    expect(balanceLineAr(200)).toBe("رصيدك المتاح ٢٠٠ نقطة. ");
    expect(balanceLineAr(Number.NaN)).toBe("");
  });
  it("the open-limit sentence is unchanged (it still serves a new data request)", () => {
    expect(openLimitMessageAr([])).toContain("عندك مهام مفتوحة");
  });
});
