import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { readRunState } from "../agent/src/runState";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { setModelPlanningForTests } from "../src/lib/agentMission/testSeam";
import { CLARIFY_OPTIONS_AR, CLARIFY_QUESTION_AR, PLATFORM_OPTIONS_AR, PLATFORM_QUESTION_AR, UNCLEAR_END_AR, isCompaniesOrPlaces, legacyRouteOf, platformOptionOf, withPlatformChoice } from "../src/lib/agentMission/platformQuestion";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { NOT_ADMIN, fakeRecorder, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";

/**
 * ROUND 25: THE LIVE MISSION msn_04afab34eab34d815c6b (test account, 4 Nov 2026 11:51–11:53 UTC), read with read-only SELECTs on missions, mission_events and mission_calls:
 *   11:51:30 created «عايز داتا عن رأي الناس في الذكاء الاصطناعي»                       11:51:36 question «من أنهي منصة؟» (round 23)
 *   11:51:41 answer (the tester tapped «إكس»)                                           11:51:46 the compiled X path asked the count first: «تحب كام تغريدة؟…» (options ١٠ / ٥٠ / ١٠٠ / ميزانية), no read
 *   11:53:00 answer «١٠»: answer_text became «١٠» — the platform answer was REPLACED (each answer replaces answer_text)
 *   11:53:01 planning: the request alone names no platform, so the compiled path did not take it and, because answer_text was not empty, the round-23 platform question was skipped: the LEGACY model-planned path ran
 *            (one paid X search, query «الذكاء الاصطناعي lang:ar -is:retweet», 20 rows, about $0.0067 of model) and ended with no card → «unsupported» → unserved «مصادرنا لا تخدم…» at 11:53:27.
 *   No plan was ever priced (plan null, reserved_points null): the «plan card» the tester saw was the card's live «خطة المهمة» panel during those 26 seconds of legacy planning.
 */
const REQUEST = "عايز داتا عن رأي الناس في الذكاء الاصطناعي";
const OFF = { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off" };
const FLAGS = { redesign_flags: { ...OFF, tiktok: "on", x: "on", instagram: "on", facebook: "on", youtube: "on" } };
const catalog = loadTregCatalog();
const AI_TEXTS = ["الذكاء الاصطناعي سيغير سوق العمل في السنوات القادمة", "رأيي أن الذكاء الاصطناعي مفيد في التعليم", "تجربتي مع أدوات الذكاء الاصطناعي في الكتابة", "الذكاء الاصطناعي خطر على الخصوصية", "هل يستبدل الذكاء الاصطناعي الأطباء؟"];
const xPage = () => {
  const page = JSON.parse(readFileSync(new URL("./fixtures/live/missions/msn_b060d3347ed7660f972e/raw/call_0003.json", import.meta.url), "utf8"));
  page.output.data.items.forEach((it: any, i: number) => { it.text = `${AI_TEXTS[i % AI_TEXTS.length]} ${i}`; });
  return page;
};

beforeEach(() => { setModelPlanningForTests(false); vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); }); });
afterEach(() => { setModelPlanningForTests(true); vi.unstubAllGlobals(); });

function world(request: string, extra: Record<string, unknown> = {}) {
  const store = createMemoryStore();
  Object.assign(store.settings, FLAGS);
  const id = "msn_r25";
  store.missions.set(id, newMission({ id, user_id: "user_t", request_text: request, status: "planning", ...extra }));
  const calls: Array<{ endpointId: string; params: Record<string, unknown> }> = [];
  const call = vi.fn(async (o: { endpointId: string; params: Record<string, unknown> }) => {
    calls.push(o);
    if (o.endpointId === "anyapi.x.search.posts") return tregResult(xPage(), 0.00054);
    return tregResult(null, 0, { ok: false, httpStatus: 404, error: "not_found" });
  });
  const driver = createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا يوجد مصدر متاح يخدم هذا الطلب بدقة." } }]);
  const runs = vi.spyOn(driver, "run");
  const notes: string[] = [];
  const deps: RunnerDeps = { store, client: fakeMoneyClient().client, catalog, driver, recorder: fakeRecorder().recorder, commit: fakeRecorder().commit, call: call as any, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async (n) => { notes.push(n.kind); } };
  const m = () => store.missions.get(id)!;
  /** The customer answers the card (what answerForCustomer does: answer_text REPLACED, back to the queue). */
  const answer = (text: string) => { store.missions.set(id, { ...m(), answer_text: text, status: "planning", question_ar: null }); };
  const plan = () => runPlanning(deps, m());
  return { store, m, answer, plan, calls, runs, notes, deps };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("1. THE LIVE MISSION replayed: platform «إكس», then the count «١٠»", () => {
  it("the platform answer survives the count answer: X is planned on the compiled path, the legacy model never runs, and the request never ends «مصادرنا لا تخدم»", async () => {
    const w = world(REQUEST);
    await w.plan();
    expect(w.m()).toMatchObject({ status: "needs_input", question_ar: PLATFORM_QUESTION_AR });
    w.answer("إكس");
    await w.plan();
    // the compiled X path asks the count first, before any read (as live)
    expect(w.m().status).toBe("needs_input");
    expect(w.m().question_ar).toMatch(/كام تغريدة/);
    expect(w.calls).toHaveLength(0);
    w.answer("١٠");
    await w.plan();
    // the platform was kept in the run note; the third run is the compiled X planning, not the legacy model
    expect((await readRunState(w.store, "msn_r25")).platformAnswer).toBe("إكس");
    expect(w.runs).not.toHaveBeenCalled();
    expect(w.calls.length).toBeGreaterThan(0);
    expect(w.calls.every((c) => c.endpointId.startsWith("anyapi.x."))).toBe(true);
    // the search is about the SUBJECT, not the phrase «رأي الناس»
    expect(String(w.calls[0].params.query ?? "")).toContain("الذكاء الاصطناعي");
    expect(String(w.calls[0].params.query ?? "")).not.toContain("رأي الناس");
    expect(w.m().status).toBe("plan_ready");
    expect(w.m().plan!.compiled?.by).toBe("compiler");
    // NOV 6 2026 CAMPAIGN: the parents on X are ORIGINAL posts; one tweet of the served page is itself a reply, so 9 of the 10 asked are planned and the card says so
    expect(w.m().plan!.price.deliveredRows).toBe(9);
    expect((w.m().plan!.notes_ar ?? []).join(" ")).toContain("وجدنا في ما قرأناه ٩ فقط تناسب طلبك من ١٠");
    expect(w.m().summary_ar ?? "").not.toContain("مصادرنا لا تخدم");
    expect(w.notes).not.toContain("unserved");
  });

  it("the Ask built after the platform choice: platform x, topic «الذكاء الاصطناعي» (not «رأي الناس»), the count from the card", () => {
    const chosen = withPlatformChoice({ request_text: REQUEST, answer_text: "إكس" }, "إكس");
    expect(chosen.answer_text).toBeNull();
    const ask = buildAsk(chosen.request_text, null, Date.now(), { count: 10 });
    expect(ask.platform).toBe("x");
    expect(ask.topic.text).toBe("الذكاء الاصطناعي");
    expect(ask.count).toBe(10);
  });

  it("the opinion phrasing names the subject in every form («رأي الناس في X»، «آراء الجمهور عن X»، «الناس بتقول ايه عن X»، «كلام الناس حول X»)", () => {
    for (const [text, topic] of [
      ["عايز داتا عن رأي الناس في الذكاء الاصطناعي على تيك توك", "الذكاء الاصطناعي"],
      ["هات آراء الجمهور عن الدوري المصري من إكس", "الدوري المصري"],
      ["الناس بتقول ايه عن غلاء الأسعار على فيسبوك", "غلاء الأسعار"],
      ["كلام الناس حول السيارات الكهربائية على يوتيوب", "السيارات الكهربائية"],
    ] as const) expect(buildRequestContract(text).topic, text).toBe(topic);
    // a plain «عن X» request is unchanged
    expect(buildRequestContract("هات ٣٠٠ تغريدة عن محمد صلاح").topic).toBe("محمد صلاح");
  });

  it("each of the five choices is recognised as the platform answer; anything else is not", () => {
    for (const o of PLATFORM_OPTIONS_AR) expect(platformOptionOf(o), o).toBe(o);
    expect(platformOptionOf(" إكس ")).toBe("إكس");
    for (const o of ["١٠", "حدد ميزانية بالنقاط", "مش عارف", "", null]) expect(platformOptionOf(o as any), String(o)).toBeNull();
  });

  it("an unanswered question card stays a question: the worker never ends it (only the 72-hour expiry cancels it, never as «مصادرنا لا تخدم»)", async () => {
    const w = world(REQUEST);
    await w.plan();
    expect(w.m().status).toBe("needs_input");
    expect(w.m().summary_ar ?? "").not.toContain("مصادرنا لا تخدم");
    const expiry = readFileSync(new URL("../src/lib/requests/expiry.ts", import.meta.url), "utf8");
    expect(expiry).toMatch(/status: "cancelled"/);
    expect(expiry).not.toMatch(/status: "unserved"/);
  });

  it("a mission that already has a plan (plan_ready) is never closed as unserved by a planning run that ends with no card", async () => {
    const w = world("محتاج قائمة شركات مقاولات في القاهرة");
    // a stale planning run of the same mission (a requeue racing the card): the store already holds a plan waiting for approval
    const stale = w.m();
    w.store.missions.set("msn_r25", { ...stale, status: "plan_ready", plan: { stages: [], price: { reservePoints: 230 } } as any });
    await runPlanning(w.deps, stale);
    expect(w.runs).toHaveBeenCalled();
    expect(w.m().status).toBe("plan_ready");
    expect(w.m().plan).not.toBeNull();
    expect(w.notes).not.toContain("unserved");
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const VAGUE_SOCIAL = [
  "عايز داتا عن رأي الناس في الذكاء الاصطناعي", "الناس بتقول ايه عن غلاء الأسعار", "محتاج آراء الجمهور في الدوري المصري", "هات كلام الناس عن السيارات الكهربائية",
  "عايز أعرف رأي الناس في التعليم الأونلاين", "اجمعلي تعليقات عن مسلسل رمضان", "هات منشورات عن القهوة المختصة", "عايز فيديوهات عن الطبخ الصحي",
  "ايه الترند النهاردة في مصر", "محتاج ردود فعل الناس على قرار رفع الأسعار", "اجمع انطباعات المستخدمين عن تطبيق جديد للتوصيل", "هات بوستات عن الهجرة",
  "عايز أشوف الناس بتتكلم ازاي عن الصحة النفسية", "محتاج محتوى عن الذكاء الاصطناعي في الطب", "هات ريلز عن السفر", "اجمعلي مشاعر الناس تجاه الحرب",
  "عايز تعليقات الناس على كأس العالم", "هات آراء الطلاب في الثانوية العامة", "محتاج داتا عن رأي الشارع في المواصلات", "رأي الناس في العمل عن بعد",
];
const VAGUE_OTHER = [
  "عايز داتا", "محتاج بيانات لبحثي", "اجمعلي معلومات عن التضخم", "عايز بيانات عن سوق العقارات في مصر", "محتاج داتا لرسالة الدكتوراه",
  "اجمع لي أي حاجة عن التسويق", "عايز إحصائيات عن البطالة", "هات معلومات عن الطاقة الشمسية", "محتاج بيانات عن التعليم في الوطن العربي", "اعملي بحث عن الاقتصاد الأخضر",
];
const COMPANIES_OR_PLACES = [
  "محتاج قائمة شركات مقاولات في القاهرة مع الإيميلات", "اجمع لي كل الصيدليات في المنصورة مع أرقام الهاتف", "محتاج مراجعات خرائط جوجل للمطاعم في جدة",
  "أريد بيانات مديري التسويق في شركات الاتصالات في مصر", "هات عيادات الأسنان في الرياض", "قائمة فنادق في شرم الشيخ",
];

describe("2. NO LEGACY SOCIAL PLANNING: a vague request is asked, never planned by the model and never paid for, before the customer answers", () => {
  it("the corpus has at least 30 vague requests", () => { expect(VAGUE_SOCIAL.length + VAGUE_OTHER.length).toBeGreaterThanOrEqual(30); });

  it.each(VAGUE_SOCIAL)("social-like «%s»: the platform question card, no model run, no provider call", async (text) => {
    expect(legacyRouteOf(text, null)).toBe("platform_question");
    const w = world(text);
    await w.plan();
    expect(w.m()).toMatchObject({ status: "needs_input", question_ar: PLATFORM_QUESTION_AR });
    expect((w.m().plan_public as any).question_options).toEqual([...PLATFORM_OPTIONS_AR]);
    expect(w.runs).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
    expect(w.notes).toEqual([]);
  });

  it.each(VAGUE_OTHER)("unclear «%s»: a short clarifying question card, no model run, no provider call", async (text) => {
    expect(legacyRouteOf(text, null)).toBe("clarify");
    const w = world(text);
    await w.plan();
    expect(w.m()).toMatchObject({ status: "needs_input", question_ar: CLARIFY_QUESTION_AR });
    expect((w.m().plan_public as any).question_options).toEqual([...CLARIFY_OPTIONS_AR]);
    expect(w.runs).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
    expect(w.notes).toEqual([]);
  });

  it.each(COMPANIES_OR_PLACES)("companies or places «%s»: still the legacy model-planned path", async (text) => {
    expect(isCompaniesOrPlaces(text)).toBe(true);
    expect(legacyRouteOf(text, null)).toBe("legacy");
    const w = world(text);
    await w.plan();
    expect(w.runs).toHaveBeenCalled();
  });

  it("the clarifying answer routes the request: a platform → compiled path; «شركات أو أماكن» → the legacy path; still unclear → ends honestly with NO paid call and never «مصادرنا لا تخدم»", async () => {
    const a = world("عايز داتا");
    await a.plan();
    a.answer("تيك توك");
    await a.plan();
    expect(a.runs).not.toHaveBeenCalled();
    expect(a.m().question_ar ?? "").not.toBe(CLARIFY_QUESTION_AR);

    const b = world("محتاج بيانات لبحثي");
    await b.plan();
    b.answer(CLARIFY_OPTIONS_AR[CLARIFY_OPTIONS_AR.length - 1]);
    await b.plan();
    expect(b.runs).toHaveBeenCalled();

    const c = world("عايز داتا");
    await c.plan();
    c.answer("مش عارف بصراحة");
    await c.plan();
    expect(c.runs).not.toHaveBeenCalled();
    expect(c.calls).toHaveLength(0);
    expect(c.m().status).toBe("unserved");
    expect(c.m().summary_ar).toBe(UNCLEAR_END_AR);
    expect(UNCLEAR_END_AR).not.toContain("مصادرنا لا تخدم");
  });

  it("a platform question answered with something that is not a platform is not asked forever: one more clarifying card, then the honest end, never a paid call", async () => {
    const w = world(REQUEST);
    await w.plan();
    w.answer("مش فارقة");
    await w.plan();
    expect(w.m().status).toBe("needs_input");
    w.answer("أي حاجة");
    await w.plan();
    expect(w.m().status).toBe("unserved");
    expect(w.runs).not.toHaveBeenCalled();
    expect(w.calls).toHaveLength(0);
  });

  it("the clarifying words are clean customer text with up to six one-tap choices", () => {
    for (const t of [CLARIFY_QUESTION_AR, UNCLEAR_END_AR, ...CLARIFY_OPTIONS_AR]) expect(checkCustomerText(t, { maxChars: 400 }).issues, t).toEqual([]);
    expect(CLARIFY_OPTIONS_AR.length).toBeLessThanOrEqual(6);
  });
});
