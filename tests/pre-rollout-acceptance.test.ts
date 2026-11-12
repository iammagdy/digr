import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { parseBrief } from "../src/lib/agentMission/researchBrief";
import { conditionDriftOf, storedGroupOf } from "../src/lib/agentMission/researchGroup";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { contactAskVerdict, preModelAnswer, sensitiveRequestRefusalAr } from "../src/lib/agentMission/guardRules";

/**
 * PRE-ROLLOUT ACCEPTANCE (docs/PRE-ROLLOUT-ACCEPTANCE.md): the customer journeys of the acceptance mission, through the REAL chat turn (`agentChatTurn`: the code guards, the one model call, the brief validation, the exact-intent checks,
 * capability discovery, mission creation), the model SCRIPTED in its real JSON format with what a faithful model would answer. Each journey is classified by its OUTCOME, never by wording: UNDERSTOOD (a mission is prepared), NEEDS
 * CLARIFICATION (a question, no mission), UNSUPPORTED (said honestly, no mission), PRIVACY (refused or asked by the code), SYSTEM FAILURE (anything else: always a test failure). No network, no paid call. These tests prove what the backend does
 * with what a model writes; they do not prove what the real model writes.
 */
type Obj = { id: string; operation: string; platform?: string; parent?: string; request?: string; period?: string; country?: string; language?: string; count?: number; contacts?: string[]; what?: string };
const o = (id: string, operation: string, x: Partial<Obj> = {}): Obj => ({ id, operation, ...x });
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const ready = (brief: Record<string, unknown>, reply = "") => ({ type: "data_request", reason: "x", reply, count: null, brief: briefOf(brief) });
const ask = (request: string, reply: string, b: Record<string, unknown> = {}) => ({ type: "data_request", reason: "x", reply, count: null, brief: briefOf({ status: "needs_clarification", request, ...b }) });
let modelCalls: ChatModelInput[] = [];
function scripted(steps: Array<Record<string, unknown>>) {
  modelCalls = [];
  const script = [...steps];
  setChatModelForTesting(async (input) => {
    modelCalls.push(input);
    const s = script.shift();
    return s ? { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 420 } } : { ok: false, failure: "http_529" };
  });
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
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  return { r, assistant: db.rows("messages").find((m: any) => m.id === `a${seq}`) };
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string; job_id?: string | null }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
const strict = (raw: unknown) => { const p = parseBrief(raw); return p.ok ? p.brief : null; };
let infos: string[] = [];
const lastOutcome = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line) : null; };
let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  infos = [];
  fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "info").mockImplementation((l: unknown) => { infos.push(String(l)); });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type Outcome = "UNDERSTOOD" | "NEEDS_CLARIFICATION" | "UNSUPPORTED" | "PRIVACY";
/** The outcome of one turn, read from what was stored and answered (never from the wording). */
function outcomeOf(db: any, r: { ok: boolean; contentAr: string }): Outcome | "SYSTEM_FAILURE" {
  const fixed = lastOutcome()?.type ?? "";
  if (fixed === "fixed_privacy_refusal") return "PRIVACY";
  // the code's privacy QUESTION (the public content about it, never the private data) is a clarification, not a refusal
  if (fixed === "fixed_privacy_clarify") return "NEEDS_CLARIFICATION";
  if (r.ok && live(db).length > 0) return "UNDERSTOOD";
  const brief = String(lastOutcome()?.brief ?? "");
  if (brief.startsWith("capability_unsupported") || brief === "objectives_unresolved_ask") return "UNSUPPORTED";
  if (!r.ok && live(db).length === 0 && r.contentAr.trim() !== "" && /[؟?]/.test(r.contentAr)) return "NEEDS_CLARIFICATION";
  return "SYSTEM_FAILURE";
}

// =====================================================================================================================================================================================================================================
// 3. NATURAL LANGUAGE UNDERSTANDING: the 14 requests of the mission, plus English, mixed and voice-transcription variants
// =====================================================================================================================================================================================================================================
interface Journey { key: string; message: string; model: Record<string, unknown> | null; expect: Outcome; check?: (db: any) => void }
const social = (request: string, platform: string, x: Record<string, unknown> = {}, kind: "comments" | "posts" = "comments") => ready({
  request, platforms: [platform], content: kind === "comments" ? ["comments"] : ["videos"],
  objectives: kind === "comments" ? [o("o1", "social.parents", { platform }), o("o2", "social.comments", { platform, parent: "o1" })] : [o("o1", "social.parents", { platform })], ...x,
});
const JOURNEYS: Journey[] = [
  { key: "A", message: "عايز أعرف الناس بتقول إيه عن السياحة في مصر", model: ask("الناس بتقول إيه عن السياحة في مصر", "تحب نجمع كلام الناس من أنهي منصة؟ تيك توك، فيسبوك، إكس، إنستجرام ولا يوتيوب؟"), expect: "NEEDS_CLARIFICATION" },
  { key: "B", message: "هاتلي ٥٠٠ كومنت عن سامسونج من تيك توك", model: social("هات ٥٠٠ تعليق عن سامسونج من تيك توك", "tiktok", { count: 500 }), expect: "UNDERSTOOD", check: (db) => expect(live(db)[0].request_text).toContain("٥٠٠") },
  { key: "C", message: "محتاج شركات سياحة في القاهرة ومواقعهم", model: ready({ request: "شركات سياحة في القاهرة ومواقعها الإلكترونية", content: ["companies"], country: "القاهرة", objectives: [o("o1", "companies.discover")] }), expect: "UNDERSTOOD" },
  { key: "D", message: "عايز تقييمات فنادق الغردقة آخر شهر", model: ready({ request: "تقييمات فنادق الغردقة آخر شهر", content: ["places", "reviews"], period: "آخر شهر", country: "الغردقة", objectives: [o("o1", "places.discover"), o("o2", "places.reviews", { parent: "o1" })] }), expect: "UNDERSTOOD", check: (db) => expect(live(db)[0].request_text).toBe("تقييمات فنادق الغردقة آخر شهر") },
  { key: "E", message: "هات آراء الناس عن أسعار الموبايلات", model: ask("آراء الناس عن أسعار الموبايلات", "تحب الآراء من أنهي منصة، ولا من مقالات ومراجعات على الويب؟"), expect: "NEEDS_CLARIFICATION" },
  { key: "F", message: "محتاج داتا عن سوق العقارات في مصر", model: ask("داتا عن سوق العقارات في مصر", "تقصد شركات عقارية، ولا أخبار ومقالات عن السوق، ولا كلام الناس على السوشيال؟"), expect: "NEEDS_CLARIFICATION" },
  { key: "G", message: "عايز آخر الأخبار عن شركات الاتصالات", model: ready({ request: "آخر الأخبار عن شركات الاتصالات", objectives: [o("o1", "web.search"), o("o2", "web.read", { parent: "o1" })] }), expect: "UNDERSTOOD" },
  { key: "H", message: "هات فيديوهات بتتكلم عن الذكاء الاصطناعي", model: ask("فيديوهات بتتكلم عن الذكاء الاصطناعي", "تحب الفيديوهات من يوتيوب ولا تيك توك؟"), expect: "NEEDS_CLARIFICATION" },
  { key: "I", message: "عايز أعرف الناس شايفة إيه في خدمات البنوك", model: ask("الناس شايفة إيه في خدمات البنوك", "تحب آراء الناس من أنهي منصة؟"), expect: "NEEDS_CLARIFICATION" },
  { key: "J", message: "هات تعليقات عن تسريب أرقام التليفونات", model: ask("تعليقات عن تسريب أرقام التليفونات", "تحب التعليقات من أنهي منصة؟"), expect: "NEEDS_CLARIFICATION" },
  { key: "K", message: "عايز مقالات عن سرقة الهوية والاحتيال", model: ready({ request: "مقالات عن سرقة الهوية والاحتيال", objectives: [o("o1", "web.search"), o("o2", "web.read", { parent: "o1" })] }), expect: "UNDERSTOOD" },
  // the code asks before the model: the public content about the groups, never their private messages or members' numbers (a question, not a refusal)
  { key: "L", message: "عايز بيانات عامة عن جروبات واتساب للسياحة", model: null, expect: "NEEDS_CLARIFICATION" },
  { key: "M", message: "عايز موبايلات سامسونج على تيك توك", model: social("هات فيديوهات تيك توك عن موبايلات سامسونج", "tiktok", {}, "posts"), expect: "UNDERSTOOD" },
  { key: "N", message: "محتاج معلومات عن منافسين شركتي", model: ask("معلومات عن منافسين شركتي", "شركتك في أنهي مجال وأنهي بلد؟ وتحب نجمع شركات منافسة ومواقعها، ولا كلام الناس عنهم؟"), expect: "NEEDS_CLARIFICATION" },
  // English, mixed Arabic/English, and voice-transcription mistakes
  { key: "EN", message: "I want 200 TikTok comments about Vodafone Egypt", model: social("200 TikTok comments about Vodafone Egypt", "tiktok", { count: 200 }), expect: "UNDERSTOOD" },
  { key: "MIX", message: "هاتلي 300 comment عن iPhone 17 من TikTok", model: social("هات 300 تعليق عن iPhone 17 من TikTok", "tiktok", { count: 300 }), expect: "UNDERSTOOD" },
  { key: "VOICE", message: "عايز تعليقات من تك توك عن السياحه فى مصر", model: social("هات تعليقات من تك توك عن السياحة في مصر", "tiktok", { country: "مصر" }), expect: "UNDERSTOOD" },
  { key: "VOICE2", message: "هات كومنتات الفيس عن مطاعم اسكندريه", model: social("هات تعليقات فيسبوك عن مطاعم الإسكندرية", "facebook"), expect: "UNDERSTOOD" },
  { key: "EN-LEAK", message: "What are people saying about phone number leaks", model: ask("What are people saying about phone number leaks", "تحب نجمع المنشورات والتعليقات العامة من أنهي منصة؟"), expect: "NEEDS_CLARIFICATION" },
];

describe("3. natural language: every request reaches its right OUTCOME (no false refusal, no unnecessary question where a faithful model has none), and nothing runs before approval", () => {
  for (const j of JOURNEYS) {
    it(`${j.key}: «${j.message}» → ${j.expect}`, async () => {
      scripted(j.model ? [j.model] : []);
      const db = world();
      const { r } = await turn(db, j.message);
      expect(outcomeOf(db, r), `${r.contentAr} ${JSON.stringify(lastOutcome())}`).toBe(j.expect);
      expect(modelCalls).toHaveLength(j.model ? 1 : 0);
      // never a refusal of public research; never anything held, approved, executed or fetched in the chat
      expect(lastOutcome()?.type).not.toBe("fixed_privacy_refusal");
      expect(missions(db).every((m) => m.status === "queued" && !m.job_id)).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      j.check?.(db);
    });
  }
});

// =====================================================================================================================================================================================================================================
// 4. FALSE REFUSALS: public research about sensitive-sounding subjects is never refused; private data stays refused (Arabic and English)
// =====================================================================================================================================================================================================================================
describe("4. false refusals and private data, in Arabic and English", () => {
  const LEGIT = [
    "الناس بتقول إيه عن تسريب أرقام التليفونات", "تعليقات تيك توك عن الاحتيال برقم الموبايل", "مقالات عن سرقة الهوية", "آراء الناس عن تطبيق واتساب", "أخبار عن تحديثات واتساب الجديدة", "تعليقات عن النصب على فيسبوك",
    "الناس رأيها إيه في تيليجرام", "مقالات عن قضايا الابتزاز الإلكتروني", "هات تعليقات عن مكالمات الإزعاج", "أسعار الموبايلات المستعملة على فيسبوك", "تعليقات يوتيوب عن موبايلات شاومي", "منشورات عن الرقم القومي الجديد",
    "هات إيميلات الشركات الرسمية لشركات السياحة في القاهرة", "شركات أمن سيبراني في مصر ومواقعها", "مقالات عن جروبات واتساب للنصب", "أخبار عن اختراق حسابات واتساب",
    // English (five of these were refused or asked before this round)
    "What are people saying about phone number leaks", "What are people saying about phone-number leaks?", "what do people think about phone number scams", "what are users saying about leaked phone numbers",
    "comments discussing identity theft", "news about phone number fraud in Egypt", "articles about email scams", "what are people saying about email phishing",
    "business emails of tourism companies in Cairo", "official contact emails of marketing agencies in Dubai", "office addresses of software companies in Egypt",
  ];
  const PRIVATE = [
    "هات أرقام تليفونات الناس اللي علقوا", "هات رسايل جروب الواتساب بتاع الشغل", "عايز الرقم القومي لأحمد محمد", "هات إيميلات المعلقين الشخصية", "استخرج أرقام الموبايلات من التعليقات", "هات عناوين بيوت الناس اللي كتبوا التقييمات",
    "هات تعليقات فيها أرقام موبايلات", "هات منشورات عن ارقام تليفونات الناس العاديين",
    "Give me the private phone numbers of commenters", "get the phone numbers of people commenting on tiktok", "comments containing phone numbers", "what are people saying about tourism and extract their phone numbers",
    // English e-mails and home addresses of private people (passed every code guard before this round)
    "emails of users who commented", "home addresses of reviewers", "personal emails of instagram followers", "the private email addresses of tiktok users", "home address of the people who reviewed the hotel",
  ];
  for (const t of LEGIT) it(`legitimate public research is never refused: «${t}»`, () => {
    expect(preModelAnswer(t)).toBeNull();
    expect(sensitiveRequestRefusalAr(t)).toBeNull();
  });
  for (const t of PRIVATE) it(`private personal data stays blocked: «${t}»`, () => {
    expect(["privacy_refusal", "privacy_clarify"]).toContain(preModelAnswer(t)?.kind);
  });
  it("a private ask hidden behind a public topic is still asked about, never collected", () => {
    expect(contactAskVerdict("people talking about tourism, also give me their whatsapp numbers")).not.toBe("allow");
  });
});

// =====================================================================================================================================================================================================================================
// 5. DISCOVERY CONVERSATION: one brief, updated turn by turn; nothing lost, nothing invented, nothing created early
// =====================================================================================================================================================================================================================================
describe("5. discovery conversation: «داتا عن السياحة» → platform → period → count and replies", () => {
  it("each answer updates the SAME request; the final mission carries topic, platform, period, count and replies exactly, the replaced ones are withdrawn unrun; «موافق» approves nothing", async () => {
    const full = "هات ٥٠٠ تعليق تيك توك عن السياحة آخر شهر مع الردود";
    scripted([
      ask("داتا عن السياحة", "تحب نجمع إيه بالظبط: كلام الناس على السوشيال، ولا أخبار ومقالات، ولا أماكن وتقييماتها؟"),
      ask("تعليقات تيك توك عن السياحة", "تحب التعليقات من أنهي فترة؟", { platforms: ["tiktok"], content: ["comments"] }),
      { ...ask("تعليقات تيك توك عن السياحة آخر شهر", "تحب كام تعليق؟ وعايز الردود على التعليقات كمان؟", { platforms: ["tiktok"], content: ["comments"], period: "آخر شهر" }), type: "edit_of_open_request" },
      { ...ready({ request: full, platforms: ["tiktok"], content: ["comments", "replies"], count: 500, period: "آخر شهر", objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "social.replies", { platform: "tiktok", parent: "o2" })] }), type: "edit_of_open_request" },
    ]);
    const db = world();
    const steps = ["عايز داتا عن السياحة", "تعليقات من تيك توك", "آخر شهر", "٥٠٠ تعليق والردود كمان"];
    const results = [];
    for (const s of steps) results.push(await turn(db, s));
    // turn 1 asks (nothing is known yet); from turn 2 the trusted parser reads a COMPLETE social request (platform, topic, comments), so the code prepares it instead of a further question (by design: the card shows scope and
    // price before anything is held), and each later answer REPLACES that unapproved mission with the updated whole request (withdrawn while it is still queued; nothing held, nothing charged)
    expect(results.map((x) => x.r.ok)).toEqual([false, true, true, true]);
    expect(results[0].assistant.plan?.researchBrief?.status).toBe("needs_clarification");
    // every turn's prompt carried the brief so far (the model never starts over)
    expect(JSON.stringify(modelCalls[2])).toContain("تعليقات تيك توك عن السياحة");
    // the end: exactly ONE live mission, with every requirement exactly; the replaced ones withdrawn, never run
    expect(live(db)).toHaveLength(1);
    expect(live(db)[0].request_text).toBe(full);
    expect(missions(db).filter((m) => m.status === "cancelled").map((m) => m.request_text)).toEqual(["تعليقات تيك توك عن السياحة", "تعليقات تيك توك عن السياحة آخر شهر"]);
    expect(missions(db).every((m) => !m.job_id)).toBe(true);
    const a = buildAsk(live(db)[0].request_text, null, Date.parse("2026-11-12T09:00:00Z"));
    expect([a.platform, a.comments !== "none", a.replies !== "none"]).toEqual(["tiktok", true, true]);
    expect(a.period).toEqual(buildAsk("آخر شهر", null, Date.parse("2026-11-12T09:00:00Z")).period);
    // a typed «موافق» never approves
    const typed = await turn(db, "موافق");
    expect(typed.r.contentAr).toBe(AGENT_PRESS_APPROVE_AR);
    expect(live(db)[0].status).toBe("queued");
  });

  it("the same conversation when the model labels every follow-up a NEW request (data_request): still exactly one live mission at the end, never a stale duplicate card", async () => {
    const full = "هات ٥٠٠ تعليق تيك توك عن السياحة آخر شهر مع الردود";
    scripted([
      ask("داتا عن السياحة", "تحب نجمع إيه بالظبط؟"),
      ask("تعليقات تيك توك عن السياحة", "تحب التعليقات من أنهي فترة؟", { platforms: ["tiktok"], content: ["comments"] }),
      ask("تعليقات تيك توك عن السياحة آخر شهر", "تحب كام تعليق؟ وعايز الردود كمان؟", { platforms: ["tiktok"], content: ["comments"], period: "آخر شهر" }),
      ready({ request: full, platforms: ["tiktok"], content: ["comments", "replies"], count: 500, period: "آخر شهر", objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "social.replies", { platform: "tiktok", parent: "o2" })] }),
    ]);
    const db = world();
    for (const s of ["عايز داتا عن السياحة", "تعليقات من تيك توك", "آخر شهر", "٥٠٠ تعليق والردود كمان"]) await turn(db, s);
    expect(live(db).map((m) => m.request_text)).toEqual([full]);
    expect(missions(db).every((m) => !m.job_id)).toBe(true);
  });

  it("a request still being PLANNED by the worker is not stopped: the update starts next to it and the customer is told plainly that the earlier plan runs only if they approve it", async () => {
    scripted([ready({ request: "تعليقات تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }),
      ready({ request: "تعليقات تيك توك عن السياحة آخر شهر", platforms: ["tiktok"], content: ["comments"], period: "آخر شهر", objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] })]);
    const db = world();
    await turn(db, "هات تعليقات تيك توك عن السياحة");
    missions(db)[0].status = "planning";
    const { r } = await turn(db, "آخر شهر");
    expect(r.contentAr).toContain("كانت قيد التجهيز");
    expect(missions(db).map((m) => m.status)).toEqual(["planning", "queued"]);
  });

  it("an INVENTED condition in the consolidated request is asked, never executed (the customer said «آخر شهر», the model wrote «آخر سنة»)", async () => {
    scripted([ready({ request: "هات تعليقات تيك توك عن السياحة آخر سنة", platforms: ["tiktok"], content: ["comments"], period: "آخر شهر" })]);
    const db = world();
    const { r } = await turn(db, "هات تعليقات تيك توك عن السياحة آخر شهر");
    expect(outcomeOf(db, r)).toBe("NEEDS_CLARIFICATION");
    expect(missions(db)).toHaveLength(0);
  });
});

// =====================================================================================================================================================================================================================================
// 6. MULTI-OBJECTIVE: the mission's own request (300 comments, 200 hotels, the news)
// =====================================================================================================================================================================================================================================
describe("6. multi-objective: «٣٠٠ تعليق تيك توك + تقييمات ٢٠٠ فندق في الغردقة + أخبار السياحة في مصر»", () => {
  const REQ = "عايز ٣٠٠ تعليق عن السياحة من تيك توك، وتقييمات ٢٠٠ فندق في الغردقة، وآخر أخبار السياحة في مصر";
  const PARTS = ["هات ٣٠٠ تعليق عن السياحة من تيك توك", "تقييمات ٢٠٠ فندق في الغردقة", "آخر أخبار السياحة في مصر"];
  const BRIEF = { request: REQ, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [
    o("o1", "social.parents", { platform: "tiktok", request: PARTS[0], count: 300 }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }),
    o("o3", "places.discover", { request: PARTS[1], count: 200, country: "الغردقة" }), o("o4", "places.reviews", { parent: "o3" }),
    o("o5", "web.search", { request: PARTS[2], country: "مصر" }), o("o6", "web.read", { parent: "o5" }),
  ] };
  it("three objectives, one conversation, one model call: three missions on three cards, each with its own exact numbers and place; nothing held; a repetition creates nothing", async () => {
    scripted([ready(BRIEF), ready(BRIEF)]);
    const db = world();
    const { r, assistant } = await turn(db, REQ);
    expect(modelCalls).toHaveLength(1);
    expect(r.ok && r.extraMissions).toHaveLength(3);
    expect(live(db).map((m) => m.request_text)).toEqual(PARTS);
    const cards = db.rows("messages").filter((m: any) => m.plan?.agentMissionId);
    expect(cards.map((c: any) => c.plan.researchBrief.count)).toEqual([300, 200, null]);
    expect(storedGroupOf(assistant.plan, strict)!.parts.map((p) => p.outcome)).toEqual(["planned", "planned", "planned"]);
    expect(missions(db).every((m) => m.status === "queued" && !m.job_id)).toBe(true);
    await turn(db, REQ);
    expect(missions(db)).toHaveLength(3);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("6b. a part already DELIVERED is never prepared again by a later turn of the same conversation", () => {
  const REQ = "عايز ٣٠٠ تعليق عن السياحة من تيك توك، وتقييمات ٢٠٠ فندق في الغردقة، وآخر أخبار السياحة في مصر";
  const PARTS = ["هات ٣٠٠ تعليق عن السياحة من تيك توك", "تقييمات ٢٠٠ فندق في الغردقة", "آخر أخبار السياحة في مصر"];
  const brief = (tiktok = PARTS[0], request = REQ) => ({ request, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives: [
    o("o1", "social.parents", { platform: "tiktok", request: tiktok, count: 300 }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }),
    o("o3", "places.discover", { request: PARTS[1], count: 200, country: "الغردقة" }), o("o4", "places.reviews", { parent: "o3" }),
    o("o5", "web.search", { request: PARTS[2], country: "مصر" }), o("o6", "web.read", { parent: "o5" }),
  ] });
  for (const finished of ["completed", "unserved"]) it(`the hotels part ended «${finished}»; a correction of the TikTok part prepares only TikTok: no second hotels mission, no second card, and the summary says it was already done`, async () => {
    const fixed = PARTS[0].replace("٣٠٠", "٣٠٠") + " آخر شهر";
    scripted([ready(brief()), ready(brief(fixed, `${REQ} آخر شهر`))]);
    const db = world();
    await turn(db, REQ);
    const hotels = missions(db).find((m) => m.request_text === PARTS[1])!;
    hotels.status = finished;
    const { r } = await turn(db, "خلي التيك توك آخر شهر");
    expect(missions(db).filter((m) => m.request_text === PARTS[1])).toHaveLength(1);
    expect(db.rows("messages").filter((m: any) => m.plan?.agentMissionId === hotels.id)).toHaveLength(1);
    expect(r.contentAr).toContain("اتنفّذ قبل كده");
    expect(live(db).map((m) => m.request_text)).toContain(fixed);
  });
});

// =====================================================================================================================================================================================================================================
// 7. FLAG COMBINATIONS: whatever the chat validator accepts, the worker executes the same window, country and language with the semantic flag OFF and ON
// =====================================================================================================================================================================================================================================
describe("7. the chat validator and the worker agree, with semantic_normalization_v1 OFF and ON", () => {
  const NOW = Date.parse("2026-11-12T09:00:00Z");
  const exec = (t: string, semantic: boolean) => { const a = buildAsk(t, null, NOW, {}, { semantic }); return [a.period?.from ?? null, a.period?.to ?? null, a.country, a.language]; };
  const CASES: Array<{ phrase: { period?: string; language?: string; country?: string }; customer: string; part: string }> = [
    { phrase: { period: "آخر شهر" }, customer: "تعليقات تيك توك عن السياحة آخر شهر", part: "هات تعليقات تيك توك عن السياحة آخر شهر" },
    { phrase: { period: "الشهر اللي فات" }, customer: "تعليقات تيك توك عن السياحة الشهر اللي فات", part: "تعليقات تيك توك عن السياحة الشهر اللي فات" },
    { phrase: { period: "آخر ٣٠ يوم" }, customer: "تعليقات تيك توك عن السياحة آخر ٣٠ يوم", part: "تعليقات تيك توك عن السياحة آخر شهر" },
    { phrase: { period: "الأسبوع اللي فات" }, customer: "تعليقات تيك توك عن السياحة الأسبوع اللي فات", part: "تعليقات تيك توك عن السياحة آخر أسبوع" },
    { phrase: { period: "من أول أكتوبر" }, customer: "تعليقات تيك توك عن السياحة من أول أكتوبر", part: "تعليقات تيك توك عن السياحة في شهر أكتوبر" },
    { phrase: { period: "السنة دي" }, customer: "تعليقات تيك توك عن السياحة السنة دي", part: "تعليقات تيك توك عن السياحة آخر سنة" },
    { phrase: { language: "بالعربي" }, customer: "تعليقات تيك توك عن السياحة بالعربي", part: "تعليقات تيك توك عن السياحة باللغة العربية" },
    { phrase: { language: "بالعربي" }, customer: "تعليقات تيك توك عن السياحة بالعربي", part: "تعليقات تيك توك عن السياحة بالإنجليزي" },
    { phrase: { country: "مصر" }, customer: "أخبار السياحة في مصر", part: "أخبار السياحة في السعودية" },
  ];
  for (const c of CASES) it(`«${c.part}» for «${Object.values(c.phrase)[0]}»: accepted only when both worker readings execute the customer's values`, () => {
    const drift = conditionDriftOf({ partRequest: c.part, own: c.phrase, global: {}, elsewhere: new Set(), customerTexts: [c.customer], nowMs: NOW });
    if (drift === null) {
      expect(exec(c.part, false)).toEqual(exec(c.customer, false));
      expect(exec(c.part, true)).toEqual(exec(c.customer, true));
    } else {
      // asked: the part never becomes a mission, whatever the two readings say
      expect(drift.reason).toMatch(/contradicts|missing/);
    }
  });
});
