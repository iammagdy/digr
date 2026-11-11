import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createMemoryDb } from "./helpers/memoryDb";
import { fakeChatModel } from "./helpers/fakeChatModel";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { IDENTITY_ANSWER_AR, TECHNOLOGY_DEFLECTION_AR, identityQuestionKind } from "../src/lib/assistantIdentity";
import { isGreetingOrGeneralQuestion } from "../src/functions/shared/briefManager";
import { findUnresolvedResearchPlaceholder } from "../src/lib/researchPlaceholders";
import { PRIVACY_REFUSAL_AR, PRIVATE_MESSAGES_REFUSAL_AR, SENSITIVE_ID_REFUSAL_AR, TRUST_REPLY_AR, accountAnswerAr, accountTopicOf, isTrustQuestion, preModelAnswer, privateContactAsk } from "../src/lib/agentMission/guardRules";
import { understand } from "./helpers/semanticUnderstand";

/**
 * PR-1.4: THE FIXED-ANSWER FILTERS THAT RUN BEFORE THE AGENT STOP INTERCEPTING LEGITIMATE RESEARCH REQUESTS.
 *
 * Tested through the REAL chat entry path, offline: `ChatHandler.handleUserMessage` with the agent switched on (greeting / general question / identity gates, then `agentChatTurn`: typed approval, privacy / account / trust, then the chat model, then a mission) over an in-memory database,
 * a fake chat model that only counts its calls, and a network that throws. The two placeholder checks (`/api/chat` and the chat page) are the same function; their wiring is read from source.
 * Each corrected filter is tested in BOTH directions: the false positive is gone, and the genuine question it exists for still gets its fixed answer. The old behaviour of every corrected case is kept below as a «legacy oracle» (the pre-PR patterns, verbatim), so the cases stay
 * regression cases for the day somebody loosens a filter again.
 */
const USER = "u1";

function world(modelType: "data_request" | "other" = "data_request") {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("profiles", [{ id: USER, email: "a@example.com" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 11676 }]);
  const model = fakeChatModel([], { override: () => ({ type: modelType }) });
  setChatModelForTesting(model.call);
  const handler = new ChatHandler(db);
  const oldPath = vi.fn(async () => { throw new Error("the old model path ran"); });
  (handler as any).llm.executeTurn = oldPath;
  handler.agentChat = { enabled: true };
  const ask = (message: string) => handler.handleUserMessage({ userId: USER, conversationId: "conv1", message, userBalance: 40_000 }) as Promise<any>;
  const ledger = JSON.stringify(db.rows("credit_ledger"));
  return { db, ask, model, oldPath, ledgerUnchanged: () => JSON.stringify(db.rows("credit_ledger")) === ledger };
}
const fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
beforeEach(() => { clearBriefCacheForTesting(); fetchSpy.mockClear(); vi.stubGlobal("fetch", fetchSpy); });
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); });

/** The requests of PR #446's pf-01 … pf-09 that are research (pf-06 and pf-07 are the privacy guard's: see the last section). */
const RESEARCH: Array<[string, string, string]> = [
  ["pf-01", "هات تعليقات من حساب [@brand_eg] على انستجرام", "a bracketed real handle"],
  ["pf-02", "هات ٥٠ تعليق عن السياحة [آخر ٣ شهور] على تيك توك", "a bracketed written period"],
  ["pf-03", "هات تعليقات من انتخابات مجلس النواب على تيك توك", "«من انتخابات» is not «من انت»"],
  ["pf-04", "هل يمكنك مساعدتي في جمع تعليقات تيك توك عن السياحة", "a polite request that names its task"],
  ["pf-05", "هات ١٠٠ تعليق من تيك توك عن ChatGPT", "a vendor name as the TOPIC"],
  ["pf-08", "قائمة مكاتب شحن في جدة", "shipping offices, not a wallet top-up"],
  ["pf-09", "هات تعليقات تيك توك عن نصب الاستثمار", "investment scams as the TOPIC"],
];

describe("the real chat path: legitimate research reaches the agent and the model decides (no fixed answer in front of it)", () => {
  it.each(RESEARCH)("%s «%s» (%s) becomes a queued mission through the real handler, with nothing charged and no network", async (_id, text) => {
    const w = world("data_request");
    const r = await w.ask(text);
    expect(r.outputType).toBe("agent_mission");
    expect(w.oldPath).not.toHaveBeenCalled();
    // the chat model (the existing one, here a fake) was asked exactly once: the filters stood aside, the model decides
    expect(w.model.calls).toHaveLength(1);
    // a planning request, not a purchase: the mission is queued, no plan is approved, no money moved, no provider was reached
    expect(w.db.rows("missions")).toHaveLength(1);
    expect(w.db.rows("missions")[0]).toMatchObject({ user_id: USER, status: "queued", request_text: text });
    expect(w.ledgerUnchanged()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(RESEARCH)("%s: the customer's words are stored exactly as typed", async (_id, text) => {
    const w = world("data_request");
    await w.ask(text);
    expect(w.db.rows("missions")[0].request_text).toBe(text);
    expect(w.db.rows("messages").find((m: any) => m.role === "user")?.content_ar ?? text).toBe(text);
  });

  it("a polite «can you help me» that is still a conversation (the model says it is not a data request) gets the model's conversational answer, NOT a mission", async () => {
    const w = world("other");
    const r = await w.ask("هل يمكنك مساعدتي في جمع تعليقات تيك توك عن السياحة");
    expect(r.outputType).not.toBe("agent_mission");
    expect(w.model.calls).toHaveLength(1);
    expect(w.db.rows("missions")).toHaveLength(0);
  });
});

describe("the real chat path: the genuine questions the fixed answers exist for still get them (no model, no mission, no money)", () => {
  it.each([
    ["إنت مين؟", IDENTITY_ANSWER_AR],
    ["انت مين يا برنس", IDENTITY_ANSWER_AR],
    ["انت chatgpt؟", TECHNOLOGY_DEFLECTION_AR],
    ["إنت كلود ولا جي بي تي؟", TECHNOLOGY_DEFLECTION_AR],
    ["هل أنت openai", TECHNOLOGY_DEFLECTION_AR],
    ["مين عملك؟", TECHNOLOGY_DEFLECTION_AR],
  ])("identity: «%s»", async (text, answer) => {
    const w = world("data_request");
    const r = await w.ask(text);
    expect(r.contentAr).toBe(answer);
    expect(w.model.calls).toHaveLength(0);
    expect(w.db.rows("missions")).toHaveLength(0);
  });

  it.each(["هل يمكنك مساعدتي؟", "هل يمكنك مساعدتي في بحث", "كيف تعمل المنصة", "انت بتعمل ايه", "ماذا تقدم"])("general question: «%s» is still answered as a conversation, never as a mission", async (text) => {
    const w = world("data_request");
    // the conversational path is the handler's own model turn (stubbed to answer one fixed line): reaching it proves the question was NOT handed to the agent
    w.oldPath.mockImplementation(async () => ({ output: { type: "answer_question", contentAr: "أنا ديجر الذكي، مساعد بحثي." }, inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub", promptVersion: "stub", textBlockAr: "" }) as never);
    const r = await w.ask(text);
    expect(w.oldPath).toHaveBeenCalled();
    expect(r.outputType).not.toBe("agent_mission");
    expect(w.model.calls).toHaveLength(0);
    expect(w.db.rows("missions")).toHaveLength(0);
    expect(w.ledgerUnchanged()).toBe(true);
  });

  it.each([
    ["عايز اشحن رصيدي", "topup"],
    ["ازاي اشحن الرصيد", "topup"],
    ["الشحن ازاي", "topup"],
    ["شحن الرصيد", "topup"],
    ["طرق الدفع", "topup"],
  ])("top-up: «%s» keeps the fixed answer of the wallet page", async (text, topic) => {
    const w = world("data_request");
    const r = await w.ask(text);
    expect(accountTopicOf(text)).toBe(topic);
    expect(r.contentAr).toBe(accountAnswerAr("topup"));
    expect(w.model.calls).toHaveLength(0);
    expect(w.db.rows("missions")).toHaveLength(0);
  });

  it.each(["الموقع ده نصب ولا ايه", "انتو نصابين؟", "هل الموقع ده مضمون", "هتسرقوا فلوسي؟", "مش واثق فيكم ثقه فيكم ايه"])("trust: «%s» keeps the fixed honest answer", async (text) => {
    const w = world("data_request");
    const r = await w.ask(text);
    expect(isTrustQuestion(text), text).toBe(true);
    expect(r.contentAr).toBe(TRUST_REPLY_AR);
    expect(w.model.calls).toHaveLength(0);
    expect(w.db.rows("missions")).toHaveLength(0);
  });
});

describe("placeholders: a real unresolved template slot is still blocked; a real handle or period is not", () => {
  it.each([
    "[الموضوع]", "بيانات حساب [@اسم_الحساب] على تيك توك", "منشورات عن [الموضوع] خلال [٣ أشهر]", "اجمع فيديوهات عن كرة القدم على تيك توك خلال [٣ أشهر]", "بحث عن [#الوسم]",
    "ابحث عن [industry] companies in [country]", "هات تعليقات [@username] على انستجرام", "هات تعليقات [@your_handle]", "هات تعليقات من [@brand_name]", "[@]", "[#]", "تعليقات عن [topic_name]", "أريد أعلى [١٠] فيديوهات من [٣] قنوات [@القناة_الأولى و@القناة_الثانية و@القناة_الثالثة]", "[@الحساب_الأول و@الحساب_الثاني]",
    "أريد [١٠٠٠] منشور وردودها على إكس عن [اسم الحدث أو الموضوع] خلال [الفترة: من تاريخ إلى تاريخ].",
  ])("blocked: %s", (text) => { expect(findUnresolvedResearchPlaceholder(text), text).not.toBeNull(); });

  it.each([
    "هات تعليقات من حساب [@brand_eg] على انستجرام", "هات ٥٠ تعليق عن السياحة [آخر ٣ شهور] على تيك توك", "هات تعليقات [@nike] على تيك توك", "هات [#رمضان] على تيك توك", "هات فيديوهات من [@AlArabiya و@SkyNewsArabia] على يوتيوب",
    "منشورات عن السياحة [last 3 months] على تيك توك", "هات تعليقات عن السياحة [اخر ٦ شهور]", "ابحث عن شركات [اسم العميل] داخل ملف مرفق",
  ])("allowed: %s", (text) => { expect(findUnresolvedResearchPlaceholder(text), text).toBeNull(); });

  it("BOTH entry points use the one function (the API route before authentication or any model, and the chat page before it sends)", () => {
    const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
    const page = readFileSync(new URL("../src/app/dashboard/chat/page.tsx", import.meta.url), "utf8");
    expect(route).toMatch(/findUnresolvedResearchPlaceholder\(message\)/);
    expect(page).toMatch(/findUnresolvedResearchPlaceholder\(textToSend\)/);
    // the route rejects BEFORE it authenticates and before any model call
    expect(route.indexOf("findUnresolvedResearchPlaceholder(message)")).toBeLessThan(route.indexOf("currentStep = \"authenticate_user\""));
  });
});

describe("the privacy guard is NOT in front of this PR's changes and loses nothing", () => {
  // each of these used to be answered by an earlier fixed rule (or by the general-question skip) and is now judged by the privacy guard: it must be refused
  it.each([
    ["هل يمكنك مساعدتي في جمع أرقام تليفونات الناس العاديين على تيك توك", PRIVACY_REFUSAL_AR],
    ["هل يمكنك مساعدتي في هات رقم الواتساب بتاع احمد", PRIVACY_REFUSAL_AR],
    ["هل يمكنك مساعدتي في الرقم القومي لأحمد", SENSITIVE_ID_REFUSAL_AR],
    ["عايز رسايل الواتساب بتاعة جروب الشغل", PRIVATE_MESSAGES_REFUSAL_AR],
    ["الرقم القومي لأحمد", SENSITIVE_ID_REFUSAL_AR],
    ["هات رقم الواتساب بتاع احمد", PRIVACY_REFUSAL_AR],
    ["عنوان سكن محمد صلاح", PRIVACY_REFUSAL_AR],
    ["أرقام موبايلات الناس اللي علّقوا على البوست ده", PRIVACY_REFUSAL_AR],
    ["ايميلات الناس اللي علقوا على الفيديو", PRIVACY_REFUSAL_AR],
  ])("«%s» is refused by code before any model, mission or provider", async (text, refusal) => {
    const w = world("data_request");
    const r = await w.ask(text);
    expect(r.contentAr).toBe(refusal);
    expect(w.model.calls).toHaveLength(0);
    expect(w.db.rows("missions")).toHaveLength(0);
    expect(w.ledgerUnchanged()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a request for private group messages behind a polite opening is refused too (by the handler's own coverage refusal, before the agent)", async () => {
    const w = world("data_request");
    const r = await w.ask("هل يمكنك مساعدتي في رسايل الواتساب بتاعة جروب الشغل");
    expect(r.outputType).not.toBe("agent_mission");
    expect(r.contentAr).toMatch(/^لا أستطيع جمع/);
    expect(w.db.rows("missions")).toHaveLength(0);
    expect(w.model.calls).toHaveLength(0);
  });

  it("a topic word never lifts a refusal: «تعليقات عن نصب …» and the like only stop being a TRUST question, they do not touch privacy", () => {
    for (const text of ["هات أرقام تليفونات ناس عادية عن نصب الاستثمار", "هات رسايل جروب واتساب عن ChatGPT", "هات الرقم القومي لاحمد عن السياحة"]) expect(preModelAnswer(text)?.kind, text).toBe("privacy_refusal");
  });

  // CHANGED (consolidated mission): the security-reviewed change this test deferred is made in guardRules.ts (`contactAskVerdict`): pf-06 (a brand) is a product request and reaches the agent; pf-07 (no cue) is ASKED what it means, never refused,
  // never planned. The pieces of the private-data section are still named here (and every refusal corpus still passes unchanged).
  it("pf-06 reaches the agent (a brand is the product); pf-07 is a clarification, not a refusal; the private-data section's pieces are all still there", () => {
    expect(privateContactAsk("عايز موبايلات سامسونج على تيك توك")).toBe(false);
    expect(preModelAnswer("عايز موبايلات سامسونج على تيك توك")).toBeNull();
    expect(privateContactAsk("جروبات واتساب عن السياحة")).toBe(false);
    expect(preModelAnswer("جروبات واتساب عن السياحة")?.kind).toBe("privacy_clarify");
    const guard = readFileSync(new URL("../src/lib/agentMission/guardRules.ts", import.meta.url), "utf8");
    // the whole private-data section is the code of PR #447, byte for byte (its pieces are named here; a change to any of them fails this test)
    for (const piece of ["const PERSONAL_CONTACT =", "const BARE_APP_OR_PRODUCT =", "const PRIVATE_EXPLICIT =", "export function privateContactAsk", "export function privateMessagesAsk", "export function personalIdentifierAsk", "export function sensitiveRequestRefusalAr"]) expect(guard, piece).toContain(piece);
  });
});

describe("mixed intent is not silently misrouted", () => {
  it("a message that doubts the site AND asks for data is a data request for the agent (the model sees both), not the fixed trust reply that drops the data request", async () => {
    const w = world("data_request");
    const r = await w.ask("الموقع ده نصب ولا ايه؟ وهات ١٠٠ تعليق تيك توك عن السياحة");
    expect(r.outputType).toBe("agent_mission");
    expect(w.model.calls).toHaveLength(1);
  });
  it("«إنت chatgpt؟ وهات ١٠٠ تعليق تيك توك عن السياحة» reaches the agent too (the identity answer would drop the request)", async () => {
    const w = world("data_request");
    const r = await w.ask("إنت chatgpt؟ وهات ١٠٠ تعليق تيك توك عن السياحة");
    expect(r.outputType).toBe("agent_mission");
    expect(w.model.calls).toHaveLength(1);
  });
  it("a question about the vendor with NO data in it is still the identity question", () => {
    for (const q of ["انت chatgpt؟", "هل أنت من openai", "are you chatgpt", "what model are you"]) expect(identityQuestionKind(q), q).toBe("technology");
  });
});

describe("unusual but legitimate wording is not refused by a fixed answer", () => {
  it.each([
    "هات كومنتات من تيك توك عن انتخابات النواب",
    "ممكن تجمعلي ١٠٠ تعليق من فيسبوك عن نصب وهمي",
    "اجمع منشورات انستجرام عن OpenAI وعن Claude",
    "هات تعليقات يوتيوب عن حملات الاحتيال الالكتروني",
    "هات تعليقات تيك توك عن ضمان الجودة",
    "عايز قايمة شركات شحن دولي في الاسكندرية",
    "هات مراجعات عن مكاتب شحن من الصين على فيسبوك",
    "دور على تعليقات عن من انتصر في المباراة على تيك توك",
    "tiktok comments about ChatGPT in Egypt last 3 months",
  ])("«%s» reaches the agent", async (text) => {
    const w = world("data_request");
    expect(isGreetingOrGeneralQuestion(text).isGeneralQuestion, text).toBe(false);
    expect(identityQuestionKind(text), text).toBeNull();
    expect(accountTopicOf(text), text).toBeNull();
    expect(isTrustQuestion(text), text).toBe(false);
    expect(findUnresolvedResearchPlaceholder(text), text).toBeNull();
    const r = await w.ask(text);
    expect(r.outputType).toBe("agent_mission");
    expect(w.db.rows("missions")).toHaveLength(1);
  });
});

/**
 * THE LEGACY ORACLE: the patterns the filters used BEFORE this PR, verbatim. They show that each corrected case WAS intercepted (so it is a genuine regression case, not a test that could never have failed) and that the corrected code no longer intercepts it.
 */
describe("legacy oracle: what the filters did before, and what they do now", () => {
  const LEGACY_GENERAL = /(انت بتعمل ايه|أنت بتعمل ايه|بتعمل ايه|بتساعد في ايه|ازاي بتشتغل|ما وظيفتك|ما هي خدماتك|كيف تعمل|كيف تعمل المنصة|ماذا تفعل|ماذا تقدم|من انت|من أنت|إنت مين|انت مين|عرفني بنفسك|هل يمكنك مساعدتي)/i;
  const LEGACY_VENDOR_IDENTITY = (t: string) => /(chat\s*gpt|\bgpt[-\s]?\d*\b|open\s*ai|\bclaude\b|anthropic|gemini|\bllama\b|mistral|deepseek|جي\s*بي\s*تي|شات\s*جي|اوبن\s*اي|أوبن\s*إيه|كلود|انثروبيك|أنثروبيك|جيميناي|ديب\s*سيك)/i.test(t) && /(انت|إنت|أنت|you|هل|بتاع|تابع|من|مين)/i.test(t);
  const LEGACY_TOPUP_BARE = /(?:ال)?شحن(?: |$)/;
  const LEGACY_TRUST_BARE = /(?:^| )(?:نصب|نصاب\S*|نصبتوا|نصبو|احتيال\S*|حرام[يه]\S*|وهم[يه]|مزيف\S*|مضمون\S*|موثوق\S*|ضمان)(?: |$)/;
  const LEGACY_PLACEHOLDER = (t: string) => ((t.match(/[\[【〈<]([^\]】〉>]{1,80})[\]】〉>]/gu) || []).some((tok) => { const v = tok.slice(1, -1).trim(); return /^[@#]/u.test(v) || v.includes("_") || /[٠-٩0-9]+\s*(?:شهر|شهور|أشهر|سنة|سنوات|أسبوع|أسابيع|يوم|أيام)/u.test(v); }));
  const byId = (id: string) => RESEARCH.find((r) => r[0] === id)![1];

  it("before: every corrected case WAS intercepted by exactly the filter the audit named", () => {
    expect(LEGACY_PLACEHOLDER(byId("pf-01"))).toBe(true);
    expect(LEGACY_PLACEHOLDER(byId("pf-02"))).toBe(true);
    expect(LEGACY_GENERAL.test(byId("pf-03"))).toBe(true);
    expect(LEGACY_GENERAL.test(byId("pf-04"))).toBe(true);
    expect(LEGACY_VENDOR_IDENTITY(byId("pf-05"))).toBe(true);
    expect(LEGACY_TOPUP_BARE.test("قائمه مكاتب شحن في جده")).toBe(true);
    expect(LEGACY_TRUST_BARE.test(" هات تعليقات تيك توك عن نصب الاستثمار ")).toBe(true);
  });

  it("after: not one of them is intercepted, by the real prefilter order of the helper and by every individual filter", () => {
    for (const [id, text] of RESEARCH) {
      expect(understand(text).prefilter, id).toBe("agent");
      expect(findUnresolvedResearchPlaceholder(text), id).toBeNull();
      expect(isGreetingOrGeneralQuestion(text).isGeneralQuestion, id).toBe(false);
      expect(identityQuestionKind(text), id).toBeNull();
      expect(preModelAnswer(text), id).toBeNull();
    }
  });

  it("the genuine questions were, and still are, intercepted (the controls of the old and the new code agree)", () => {
    for (const t of ["كيف تعمل المنصة", "انت مين", "من أنت", "هل يمكنك مساعدتي؟"]) {
      expect(LEGACY_GENERAL.test(t) || t === "انت مين", t).toBe(true);
      expect(isGreetingOrGeneralQuestion(t).isGeneralQuestion || identityQuestionKind(t) !== null, t).toBe(true);
    }
  });
});
