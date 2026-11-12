import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, CHAT_RESEARCH_BRIEF_FLAG_KEY, GROUP_UNCHANGED_AR, MODEL_RETRY_AR, MULTI_PART_RETRY_AR, PLAN_NOT_READY_AR, REQUEST_UPDATED_AR, TOPIC_QUESTION_AR } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { buildSystemPrompt, decideTurn, FORMAT_REMINDER_AR, FORMAT_RETRY_AR, parseModelAnswer } from "../src/lib/agentMission/conversationModel";
import { parseBrief } from "../src/lib/agentMission/researchBrief";
import { buildCapabilityRegistry, CAPABILITY_DISCOVERY_FLAG_KEY, chatCapabilityLines, discoverCapabilities, researchNeedOf } from "../src/lib/agentMission/capabilities";
import { classifyMessage } from "../src/lib/agentMission/messageType";
import { completedPartSentence, conditionDriftOf } from "../src/lib/agentMission/researchGroup";
import { privacyRefusalAr } from "../src/lib/agentMission/guardRules";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { NOT_ADMIN } from "./helpers/agentHarness";

/**
 * THE LLM QUALITY FIXES (docs/LIVE-INTELLIGENCE-EVAL.md, round 50), OFFLINE. Each test scripts the chat model with the SHAPE the real claude-haiku-5-5 wrote in the live evaluation of 2026-11-12 (objectives beside the brief, a period on
 * a child objective, content «articles» / «contacts», an objective key «topic», a country inferred from a city, an empty clarification, a refusal of public research, an honest «Snapchat is not offered» re-typed by the keyword rule) and
 * runs it through the REAL chat turn. No network, no paid call: these prove what the backend now does with what the real model wrote; the live rounds measure what the model writes.
 */
type Obj = { id: string; operation: string; platform?: string | null; parent?: string | null; request?: string; period?: string; country?: string; language?: string; count?: number | null; contacts?: string[]; what?: string; topic?: string };
const o = (id: string, operation: string, x: Partial<Obj> = {}): Obj => ({ id, operation, ...x });
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
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
let infos: string[] = [];
const lastLog = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line) : null; };
const NOW = Date.parse("2026-11-12T09:00:00Z");
const registry = () => buildCapabilityRegistry(loadTregCatalog(), { isAllowed: (id) => !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed });
beforeEach(() => {
  infos = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { infos.push(String(line)); });
});
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("finding 1: objectives written BESIDE the brief (8 of 22 real answers) are read as the brief's own", () => {
  const J1 = "عايز ٣٠٠ تعليق عن السياحة من تيك توك، وتقييمات ٢٠٠ فندق في الغردقة، وآخر أخبار السياحة في مصر";
  // the real answer's shape: the brief closed WITHOUT objectives, the objectives next to it; a brief-level count of the TikTok part; requests on the parents AND on the comments
  const realJ1 = {
    type: "data_request", reason: "ثلاثة أجزاء", reply: "", count: null,
    brief: briefOf({ request: "تعليقات من تيك توك عن السياحة، وتقييمات فنادق الغردقة، ومقالات وأخبار السياحة في مصر", platforms: ["tiktok"], content: ["comments"], count: 300, topic: "السياحة", country: "مصر" }),
    objectives: [
      o("o1", "social.parents", { platform: "tiktok", request: "فيديوهات تيك توك عن السياحة", what: "", period: "", country: "", language: "", count: null }),
      o("o2", "social.comments", { platform: "tiktok", parent: "o1", request: "٣٠٠ تعليق عن السياحة من تيك توك", count: 300 }),
      o("o3", "places.reviews", { platform: null, parent: null, request: "تقييمات ٢٠٠ فندق في الغردقة", country: "الغردقة", count: 200 }),
      o("o4", "web.search", { platform: null, parent: null, request: "آخر أخبار السياحة في مصر", period: "آخر", country: "مصر" }),
    ],
  };
  it("the parser moves them into the brief (absent or empty inside), and the schema reads them", () => {
    const a = parseModelAnswer(JSON.stringify(realJ1))!;
    const p = parseBrief(a.brief);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.brief.objectives?.map((x) => x.id)).toEqual(["o1", "o2", "o3", "o4"]);
    const empty = parseModelAnswer(JSON.stringify({ ...realJ1, brief: { ...realJ1.brief, objectives: [] } }))!;
    expect((empty.brief as any).objectives).toHaveLength(4);
  });
  it("two DIFFERENT non-empty arrays (inside and beside) are ambiguous: rejected by the schema, never guessed", () => {
    const a = parseModelAnswer(JSON.stringify({ ...realJ1, brief: { ...realJ1.brief, objectives: [o("o1", "web.search")] } }))!;
    expect(parseBrief(a.brief)).toMatchObject({ ok: false, issue: "objectives" });
  });
  it("J1 end to end: THREE parts, each its own mission with its own number and place; nothing is reduced to the words", async () => {
    scripted([realJ1]);
    const db = world();
    const { r } = await turn(db, J1);
    expect(r.ok).toBe(true);
    const texts = live(db).map((m) => m.request_text);
    expect(texts).toHaveLength(3);
    expect(texts.find((t) => /تيك توك/.test(t))).toMatch(/٣٠٠/);
    expect(texts.find((t) => /فندق/.test(t))).toMatch(/٢٠٠.*الغردقة/);
    expect(texts.find((t) => /أخبار/.test(t))).toMatch(/مصر/);
    expect(live(db).every((m) => m.status === "queued" && !m.job_id)).toBe(true);
    expect(db.rows("credit_ledger")).toHaveLength(1);
  });
  it("a multi-part reading that cannot be used as written is ASKED («كمّل»), never one mission from the words", async () => {
    // a part with an operation outside the vocabulary: the whole objectives array is rejected by the schema
    scripted([{ ...realJ1, objectives: [...realJ1.objectives.slice(0, 3), o("o4", "news.search")] }]);
    const db = world();
    const { r } = await turn(db, J1);
    expect(r).toMatchObject({ ok: false, contentAr: MULTI_PART_RETRY_AR });
    expect(missions(db)).toHaveLength(0);
    expect(lastLog().brief).toBe("multi_part_unsafe_schema_objectives");
  });
  it("the prompt shows objectives INSIDE the brief, and says so", () => {
    const p = buildSystemPrompt({ balancePoints: 100, open: null, brief: { enabled: true, soFar: null, capabilityLines: chatCapabilityLines(registry()) } });
    expect(p).toMatch(/"language":"","objectives":\[\.\.\.\]\}/);
    expect(p).toContain("objectives حقل داخل brief نفسه");
  });
});

describe("finding 2: research ABOUT a sensitive subject is a request, never a refusal", () => {
  for (const t of ["What are people saying about phone number leaks", "الناس بتقول إيه عن تسريب أرقام التليفونات", "آراء الناس عن الاحتيال الإلكتروني"]) {
    it(`the keyword rule reads «${t}» as a data request (the WHEN-UNSURE backstop)`, () => expect(classifyMessage(t)).toBe("data_request"));
  }
  it("a private ask is still refused by code BEFORE any model call", async () => {
    scripted([]);
    const db = world();
    const { r } = await turn(db, "هات أرقام تليفونات الناس اللي علقوا");
    expect(r.ok).toBe(false);
    expect(modelCalls).toHaveLength(0);
    expect(missions(db)).toHaveLength(0);
  });
  it("the real refusal («ديجر … لا تجمع أرقام هواتف») of the public question is re-typed as a request: no refusal reaches the customer", async () => {
    scripted([{ type: "service_question", reason: "x", reply: "ديجر تجمع بيانات بحث عامة، ولا تجمع أرقام هواتف أو بيانات شخصية لأفراد.", count: null }]);
    const db = world();
    const { r } = await turn(db, "الناس بتقول إيه عن تسريب أرقام التليفونات");
    expect(r.contentAr).not.toContain("لا تجمع أرقام");
    expect(lastLog().type).toBe("data_request");
  });
  it("the prompt states the rule and its example", () => {
    const p = buildSystemPrompt({ balancePoints: null, open: null });
    expect(p).toContain("البحث عن موضوع حساس مسموح");
    expect(p).toContain("«الناس بتقول إيه عن تسريب أرقام التليفونات» = data_request");
  });
});

describe("finding 3: schema values the real model writes for capabilities the system has", () => {
  it("content «articles» (I1): a news request is planned as web research, not companies", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "جمع أحدث الأخبار والمقالات العامة عن شركات الاتصالات في مصر", content: ["articles"], topic: "شركات الاتصالات في مصر", period: "أحدث الأخبار", country: "مصر", language: "العربية", objectives: [o("o1", "web.search", { platform: null, parent: null, request: "جمع أحدث الأخبار والمقالات العامة عن شركات الاتصالات في مصر", period: "أحدث الأخبار", country: "مصر", language: "العربية" })] }) }]);
    const db = world();
    const { r } = await turn(db, "عايز آخر الأخبار عن شركات الاتصالات في مصر");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
    // the language the customer never wrote is not asked and not stored as theirs
    const card = db.rows("messages").find((m: any) => m.plan?.agentMissionId);
    expect(card.plan.researchBrief.language).toBeNull();
    expect(discoverCapabilities(researchNeedOf({ request: live(db)[0].request_text, brief: card.plan.researchBrief }), registry()).need.kind).toBe("web");
  });
  it("the words alone (fallback): «الأخبار عن شركات …» is web research, «شركات … وإيميلاتها» stays companies", () => {
    expect(researchNeedOf({ request: "عايز آخر الأخبار عن شركات الاتصالات في مصر" }).kind).toBe("web");
    expect(researchNeedOf({ request: "عايز شركات الاتصالات في مصر وإيميلاتها الرسمية" }).kind).toBe("companies");
  });
  it("content «contacts» (G1) with a company.contacts objective is valid; «contacts» without one is a dropped objective", () => {
    const ok = parseBrief(briefOf({ request: "شركات السياحة في الغردقة وإيميلاتها الرسمية", content: ["companies", "contacts"], objectives: [o("o1", "companies.discover"), o("o2", "company.contacts", { parent: "o1", contacts: ["email", "phone"] })] }));
    expect(ok.ok).toBe(true);
    expect(parseBrief(briefOf({ request: "x y z", content: ["news"] }))).toMatchObject({ ok: false, issue: "content" });
  });
  it("an objective key «topic» (B1) joins `what`; an endpoint key still rejects the objectives", () => {
    const p = parseBrief(briefOf({ request: "جمع ٣٠٠ تعليق من تيك توك عن iPhone 17", platforms: ["tiktok"], content: ["comments"], objectives: [o("o1", "social.parents", { platform: "tiktok", topic: "iPhone 17" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1", count: 300 })] }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.brief.objectives![0]).toMatchObject({ what: "iPhone 17", count: 300 });
    expect(parseBrief(briefOf({ request: "x y z", objectives: [{ ...o("o1", "web.search"), endpoint: "google.search" }] }))).toMatchObject({ ok: false, issue: "objectives" });
  });
  it("a period on the CHILD objective (H1) is the part's: the reviews request is prepared with its period", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "جمع تقييمات فنادق الغردقة خلال آخر شهر من الخرائط، بنصوص التقييمات.", content: ["reviews"], topic: "فنادق", period: "آخر شهر", country: "الغردقة", objectives: [o("o1", "places.discover", { platform: null, parent: null, request: "جمع الفنادق في الغردقة من الخرائط", period: "", country: "الغردقة", language: "", count: null, what: "" }), o("o2", "places.reviews", { platform: null, parent: "o1", request: "جمع تقييمات تلك الفنادق خلال آخر شهر", period: "آخر شهر" })] }) }]);
    const db = world();
    const { r } = await turn(db, "عايز تقييمات فنادق الغردقة آخر شهر");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
    expect(live(db)[0].request_text).toMatch(/آخر شهر/);
  });
});

describe("findings 4–7: corrections, invented places, empty questions, unsupported platforms", () => {
  it("K1: «آخر شهر» → «آخر أسبوع» while the first plan is still queued: the request is REPLACED with the corrected period (never «still being prepared»)", async () => {
    const first = { type: "data_request", reason: "x", reply: "", brief: briefOf({ request: "جمع تعليقات تيك توك عن السياحة في الغردقة خلال آخر شهر", platforms: ["tiktok"], content: ["comments"], topic: "السياحة في الغردقة", period: "آخر شهر", objectives: [o("o1", "social.parents", { platform: "tiktok", request: "جمع فيديوهات تيك توك عن السياحة في الغردقة خلال آخر شهر", period: "آخر شهر" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }), count: null };
    const second = { type: "edit_of_open_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "جمع تعليقات تيك توك عن السياحة في الغردقة خلال آخر أسبوع", platforms: ["tiktok"], content: ["comments"], topic: "السياحة في الغردقة", period: "آخر أسبوع", objectives: [o("o1", "social.parents", { platform: "tiktok", what: "فيديوهات تيك توك عن السياحة في الغردقة", period: "آخر أسبوع" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }) };
    scripted([first, second]);
    const db = world();
    await turn(db, "هات تعليقات تيك توك عن السياحة في الغردقة آخر شهر");
    const { r } = await turn(db, "لا خليها آخر أسبوع");
    expect(r.contentAr).not.toBe(PLAN_NOT_READY_AR);
    expect(r.contentAr).toBe(REQUEST_UPDATED_AR);
    expect(live(db)).toHaveLength(1);
    const ask = buildAsk(live(db)[0].request_text, null, NOW);
    expect(JSON.stringify(ask.period)).toBe(JSON.stringify(buildAsk("آخر أسبوع", null, NOW).period));
  });
  it("C2: a country the model inferred from the customer's city is not asked, and is not quoted as the customer's", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات فيسبوك عن مطاعم الإسكندرية", platforms: ["facebook"], content: ["comments"], topic: "مطاعم", country: "مصر", objectives: [o("o1", "social.parents", { platform: "facebook", period: "", country: "مصر", language: "", what: "منشورات عن مطاعم الإسكندرية" }), o("o2", "social.comments", { platform: "facebook", parent: "o1" })] }) }]);
    const db = world();
    const { r } = await turn(db, "هات كومنتات الفيس عن مطاعم اسكندريه");
    expect(r.ok).toBe(true);
    expect(live(db)[0].request_text).toMatch(/الإسكندرية/);
    expect(r.contentAr).not.toContain("اللي كتبته");
  });
  it("a place the model invented AND executed is asked as the model's, never quoted as «what you wrote»", () => {
    const d = conditionDriftOf({ partRequest: "تعليقات فيسبوك عن مطاعم القاهرة", own: { country: "القاهرة" }, global: {}, elsewhere: new Set(), customerTexts: ["هات كومنتات الفيس عن المطاعم"], nowMs: NOW });
    expect(d).toMatchObject({ kind: "place", invented: true });
  });
  it("A1: needs_clarification with an EMPTY reply: the code asks what is missing; no mission is made from the words", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "جمع آراء الناس عن السياحة في مصر", topic: "السياحة في مصر", country: "مصر" }), objectives: [o("o1", "web.search", { what: "مقالات وآراء عامة عن السياحة في مصر" })] }]);
    const db = world();
    const { r } = await turn(db, "عايز أعرف الناس بتقول إيه عن السياحة في مصر");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toMatch(/[؟?]/);
    expect(missions(db)).toHaveLength(0);
    expect(lastLog().brief).toBe("clarify_code_question");
  });
  it("O1: the honest «Snapchat is not offered», re-typed as a request by the keyword rule, is answered honestly: no mission that could only end «unserved»", async () => {
    scripted([{ type: "other", reason: "x", reply: "للأسف لا نجمع حاليًا بيانات من سناب شات.", count: null }]);
    const db = world();
    const { r } = await turn(db, "هات ستوريز سناب شات عن السياحة في مصر");
    expect(r.ok).toBe(false);
    expect(missions(db)).toHaveLength(0);
    expect(lastLog().brief).toBe("words_unsupported_platform");
  });
  it("a new request's own number the model's sentence dropped is asked, never silently lost", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }) }]);
    const db = world();
    const { r } = await turn(db, "هات ٤٠٠ تعليق تيك توك عن السياحة");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain("العدد ٤٠٠");
    expect(missions(db)).toHaveLength(0);
  });
});

describe("decideTurn reports the parts of a raw brief (before any check)", () => {
  it("counts first objectives inside or beside the brief", async () => {
    const d = await decideTurn({ message: "x", balancePoints: null, open: null, brief: { enabled: true, soFar: null } }, async () => ({ ok: true, text: JSON.stringify({ type: "data_request", reason: "", reply: "", brief: briefOf({ request: "abc" }), objectives: [o("o1", "web.search"), o("o2", "places.discover"), o("o3", "places.reviews", { parent: "o2" })] }) }));
    expect(d.briefParts).toBe(2);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// ROUND 1 OF THE QUALITY MISSION (real model, 61 conversations): the failures it found, each pinned here
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const tiktok = (request: string, extra: Record<string, unknown> = {}) => ({ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request, platforms: ["tiktok"], content: ["comments"], topic: "السياحة", objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })], ...extra }) });

describe("round 1: the JSON format in long conversations", () => {
  it("the format reminder closes every prompt; an answer in prose is asked ONCE more with a format note, and read", async () => {
    const seen: ChatModelInput[] = [];
    const answers = ["تمام، سجّلت طلبك.", JSON.stringify({ type: "greeting_or_small_talk", reason: "x", reply: "أهلًا بك.", count: null })];
    const d = await decideTurn({ message: "أهلا", balancePoints: null, open: null }, async (i) => { seen.push(i); return { ok: true, text: answers.shift()! }; });
    expect(seen).toHaveLength(2);
    expect(seen[0].system.endsWith(FORMAT_REMINDER_AR)).toBe(true);
    // the retry adds a note at the end of the SYSTEM prompt (never a user turn: rounds 5–6, the model refused such a turn as an extraction attempt); the messages are the same
    expect(seen[1].system.endsWith(FORMAT_RETRY_AR)).toBe(true);
    expect(seen[1].messages).toEqual(seen[0].messages);
    expect(d).toMatchObject({ type: "greeting_or_small_talk", source: "model", reply: "أهلًا بك." });
  });
  it("prose twice in a conversation in progress: «send it again», never a new mission from a fragment («٥٠٠ تعليق والردود كمان»)", async () => {
    const db = world();
    scripted([tiktok("تعليقات تيك توك عن السياحة")]);
    await turn(db, "هات تعليقات تيك توك عن السياحة");
    setChatModelForTesting(async () => ({ ok: true, text: "تمام، سجّلت طلبك الآن: ٥٠٠ تعليق." }));
    const { r } = await turn(db, "٥٠٠ تعليق والردود كمان");
    expect(r.contentAr).toBe(MODEL_RETRY_AR);
    expect(live(db)).toHaveLength(1);
  });
});

describe("round 1: no mission from words that name no data", () => {
  for (const [message, raw] of [
    ["محتاج داتا عن سوق العقارات في مصر", { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "", topic: "سوق العقارات", objectives: [] }) }],
    ["عايز داتا", { type: "data_request", reason: "x", reply: "تمام، عايز بيانات عن إيه بالتحديد؟", count: null, brief: briefOf({ status: "needs_clarification", request: "" }) }],
    ["عايز أعرف الناس بتقول إيه عن السياحة في مصر", { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "منشورات الناس عن السياحة في مصر", objectives: [o("o1", "social.parents", { request: "منشورات الناس عن السياحة في مصر" })] }) }],
  ] as Array<[string, Record<string, unknown>]>) {
    it(`«${message}»: an unusable brief and words with no data kind → a question, no mission`, async () => {
      scripted([raw]);
      const db = world();
      const { r } = await turn(db, message);
      expect(r.ok).toBe(false);
      expect(r.contentAr).toMatch(/[؟?]/);
      expect(missions(db)).toHaveLength(0);
    });
  }
  it("a refusal the keyword rule overruled is never shown as the question: the code asks", async () => {
    scripted([{ type: "service_question", reason: "x", reply: "ديجر لا تقدم التحليل الإحصائي.", count: null }]);
    const db = world();
    const { r } = await turn(db, "اعملي تحليل إحصائي للبيانات واكتبلي فصل النتائج");
    expect(missions(db)).toHaveLength(0);
    expect(r.contentAr).not.toContain("لا تقدم");
  });
  it("«تيك توك» alone: the model's invented topic («الموضوع المطلوب») is asked, not planned; a real topic the parser cannot read is not asked", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "منشورات وفيديوهات تيك توك عن الموضوع المطلوب", platforms: ["tiktok"], content: ["posts", "videos"], objectives: [o("o1", "social.parents", { platform: "tiktok" })] }) }]);
    const db = world();
    const { r } = await turn(db, "تيك توك");
    expect(r.contentAr).toBe(TOPIC_QUESTION_AR);
    expect(missions(db)).toHaveLength(0);
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "فيديوهات تيك توك عن موبايلات سامسونج", platforms: ["tiktok"], content: ["videos"], objectives: [o("o1", "social.parents", { platform: "tiktok" })] }) }]);
    const db2 = world();
    expect((await turn(db2, "عايز موبايلات سامسونج على تيك توك")).r.ok).toBe(true);
  });
});

describe("round 1: a part's sentence says what its objectives collect", () => {
  it("comments, replies, reviews and official contacts the objectives carry are added when the sentence omits them; nothing else is added", () => {
    expect(completedPartSentence("منشورات تيك توك عن السياحة", [o("o1", "social.parents", { platform: "tiktok" }) as any, { ...o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), contacts: [] } as any])).toBe("منشورات تيك توك عن السياحة والتعليقات عليها");
    expect(completedPartSentence("المدارس الدولية في القاهرة على خرائط جوجل", [{ ...o("o1", "places.discover"), platform: null, parent: null, contacts: [] } as any, { ...o("o2", "places.reviews", { parent: "o1" }), platform: null, contacts: [] } as any])).toBe("المدارس الدولية في القاهرة على خرائط جوجل وتقييماتها");
    expect(completedPartSentence("شركات التسويق في دبي", [{ ...o("o1", "companies.discover"), platform: null, parent: null, contacts: [] } as any, { ...o("o2", "company.contacts", { parent: "o1" }), platform: null, contacts: ["email"] } as any])).toBe("شركات التسويق في دبي وإيميلاتها الرسمية");
    expect(completedPartSentence("تعليقات تيك توك عن السياحة", [o("o1", "social.parents", { platform: "tiktok" }) as any, { ...o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), contacts: [] } as any])).toBe("تعليقات تيك توك عن السياحة");
  });
  it("K7: «تعليقات تيك توك … وآخر أخبار …» with the TikTok sentence written for its posts: BOTH parts are prepared", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", brief: briefOf({ request: "تعليقات تيك توك عن السياحة، وأخبار السياحة في مصر", platforms: ["tiktok"], content: ["comments", "articles"], topic: "السياحة", objectives: [o("o1", "social.parents", { platform: "tiktok", request: "منشورات تيك توك عن السياحة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "web.search", { request: "آخر أخبار السياحة في مصر", country: "مصر" })] }) }]);
    const db = world();
    await turn(db, "عايز تعليقات تيك توك عن السياحة، وآخر أخبار السياحة في مصر");
    expect(live(db).map((m) => m.request_text).sort()).toEqual(["آخر أخبار السياحة في مصر", "منشورات تيك توك عن السياحة والتعليقات عليها"]);
  });
});

describe("round 1: corrections while the plan is being prepared", () => {
  it("K3: «خليهم ١٠٠ بس» replaces the 300-comment request (the count is part of the request)", async () => {
    scripted([tiktok("جمع ٣٠٠ تعليق تيك توك عن السياحة", { count: 300 }), { ...tiktok("جمع ١٠٠ تعليق تيك توك عن السياحة", { count: 100 }), type: "edit_of_open_request", count: 100 }]);
    const db = world();
    await turn(db, "هات ٣٠٠ تعليق تيك توك عن السياحة");
    const { r } = await turn(db, "خليهم ١٠٠ بس");
    expect(r.contentAr).not.toBe(PLAN_NOT_READY_AR);
    expect(live(db).map((m) => m.request_text)).toEqual(["جمع ١٠٠ تعليق تيك توك عن السياحة"]);
  });
  it("K8: «الزمالك بدل المعادي» (two districts of one city) replaces the request", async () => {
    const places = (where: string) => ({ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: `مطاعم ${where} مع تقييماتها`, content: ["places", "reviews"], topic: `مطاعم ${where}`, objectives: [o("o1", "places.discover", { request: `مطاعم ${where}` }), o("o2", "places.reviews", { parent: "o1" })] }) });
    scripted([places("المعادي"), { ...places("الزمالك"), type: "edit_of_open_request" }]);
    const db = world();
    await turn(db, "هات مطاعم المعادي وتقييماتها");
    await turn(db, "لا خليها الزمالك بدل المعادي");
    expect(live(db).map((m) => m.request_text)).toEqual(["مطاعم الزمالك مع تقييماتها"]);
  });
  it("K6: an added part while the single mission waits: that mission is matched as the first part, never left live next to a copy", async () => {
    scripted([
      tiktok("تعليقات تيك توك عن المدارس الدولية في القاهرة"),
      { type: "edit_of_open_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات تيك توك عن المدارس الدولية في القاهرة، وتقييمات المدارس على خرائط جوجل", platforms: ["tiktok"], content: ["comments", "reviews"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "تعليقات تيك توك عن المدارس الدولية في القاهرة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "places.discover", { request: "المدارس الدولية في القاهرة على خرائط جوجل" }), o("o4", "places.reviews", { parent: "o3" })] }) },
    ]);
    const db = world();
    await turn(db, "هات تعليقات تيك توك عن المدارس الدولية في القاهرة");
    await turn(db, "وكمان تقييمات المدارس دي على جوجل ماب");
    const texts = live(db).map((m) => m.request_text);
    expect(texts).toHaveLength(2);
    expect(texts.filter((t) => /تيك توك/.test(t))).toHaveLength(1);
    expect(texts.find((t) => /خرائط/.test(t))).toMatch(/تقييم/);
  });
});

describe("round 1: two privacy-rule gaps", () => {
  it("«الواتساب الشخصي للمعلقين» is refused by code; «comments discussing phone number leaks» (the model's English rephrase) is public research", () => {
    expect(privacyRefusalAr("عايز الواتساب الشخصي للمعلقين على البوست ده")).not.toBeNull();
    expect(privacyRefusalAr("Public posts and comments discussing phone number leaks")).toBeNull();
    expect(privacyRefusalAr("comments discussing the phone numbers of the people who commented")).not.toBeNull();
    expect(privacyRefusalAr("منشورات عامة عن الواتساب")).toBeNull();
  });
});

describe("round 2", () => {
  it("J1: a part whose sentence writes no number gets the count the model attributed to it, in Arabic digits", () => {
    expect(completedPartSentence("تعليقات تيك توك عن السياحة", [{ ...o("o1", "social.parents", { platform: "tiktok" }), parent: null, contacts: [], count: 300 } as any, { ...o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), contacts: [] } as any])).toBe("تعليقات تيك توك عن السياحة، العدد ٣٠٠");
    expect(completedPartSentence("٣٠٠ تعليق تيك توك عن السياحة", [{ ...o("o1", "social.parents", { platform: "tiktok" }), parent: null, contacts: [], count: 300 } as any, { ...o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), contacts: [] } as any])).toBe("٣٠٠ تعليق تيك توك عن السياحة");
  });
  it("D2: the model says something decisive is missing and wrote no usable brief: asked, even when the words name a kind of data", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "" }) }]);
    const db = world();
    const { r } = await turn(db, "محتاج معلومات عن منافسين شركتي");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toMatch(/[؟?]/);
    expect(missions(db)).toHaveLength(0);
  });
});

describe("round 3", () => {
  it("S1: «تيك توك» alone with NO brief from the model: the topic is asked, no mission from the words", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null }]);
    const db = world();
    const { r } = await turn(db, "تيك توك");
    expect(r.contentAr).toBe(TOPIC_QUESTION_AR);
    expect(missions(db)).toHaveLength(0);
  });
  it("J1: words no reader executes («آخر أخبار») written on the whole request are not asked of every part; a part's OWN such words must be carried", () => {
    const base = { partRequest: "تعليقات تيك توك عن السياحة", global: {}, elsewhere: new Set<any>(), customerTexts: ["عايز تعليقات تيك توك عن السياحة، وكمان آخر أخبار السياحة في مصر"], nowMs: NOW };
    expect(conditionDriftOf({ ...base, own: {}, global: { period: "آخر أخبار" } })).toBeNull();
    expect(conditionDriftOf({ ...base, own: { period: "موسم الصيف" }, customerTexts: ["عايز تعليقات تيك توك عن السياحة في موسم الصيف"] })).toMatchObject({ kind: "period", reason: "missing" });
  });
  it("K7: a part removed by the customer is withdrawn AND said; the kept part stays", async () => {
    const two = { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات تيك توك عن السياحة، وأخبار السياحة في مصر", platforms: ["tiktok"], content: ["comments", "articles"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "تعليقات تيك توك عن السياحة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "web.search", { request: "آخر أخبار السياحة في مصر" })] }) };
    const one = { type: "edit_of_open_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "تعليقات تيك توك عن السياحة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }) };
    scripted([two, one]);
    const db = world();
    await turn(db, "عايز تعليقات تيك توك عن السياحة، وآخر أخبار السياحة في مصر");
    const { r } = await turn(db, "شيل الأخبار، خلي التعليقات بس");
    expect(live(db).map((m) => m.request_text)).toEqual(["تعليقات تيك توك عن السياحة"]);
    expect(r.contentAr).toContain("«آخر أخبار السياحة في مصر» اتلغت");
  });
});

describe("round 4", () => {
  it("C2: an objective key «city» is the part's place (as «country»); two different places reject", () => {
    const p = parseBrief(briefOf({ request: "تعليقات فيسبوك عن المطاعم في الإسكندرية", platforms: ["facebook"], content: ["comments"], objectives: [o("o1", "social.parents", { platform: "facebook", city: "الإسكندرية" } as any), o("o2", "social.comments", { platform: "facebook", parent: "o1" })] }));
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.brief.objectives![0].country).toBe("الإسكندرية");
    expect(parseBrief(briefOf({ request: "x y z", objectives: [o("o1", "places.discover", { country: "القاهرة", city: "الجيزة" } as any)] }))).toMatchObject({ ok: false, issue: "objectives" });
  });
  it("J1: «كمّل» with no brief after every part is prepared: «already prepared», nothing new", async () => {
    scripted([
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات تيك توك عن السياحة، وأخبار السياحة في مصر", platforms: ["tiktok"], content: ["comments", "articles"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "تعليقات تيك توك عن السياحة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "web.search", { request: "آخر أخبار السياحة في مصر" })] }) },
      { type: "edit_of_open_request", reason: "x", reply: "", count: null },
    ]);
    const db = world();
    await turn(db, "عايز تعليقات تيك توك عن السياحة، وكمان آخر أخبار السياحة في مصر");
    const { r } = await turn(db, "كمّل");
    expect(r.contentAr).toBe(GROUP_UNCHANGED_AR);
    expect(live(db)).toHaveLength(2);
  });
});

describe("round 5", () => {
  it("I1: «آخر الأخبار» is the recency of news, not a period to carry", () => {
    expect(conditionDriftOf({ partRequest: "جمع أحدث الأخبار عن شركات الاتصالات في مصر", own: { period: "آخر الأخبار" }, global: {}, elsewhere: new Set(), customerTexts: ["عايز آخر الأخبار عن شركات الاتصالات في مصر"], nowMs: NOW })).toBeNull();
    // a real window the reader understands is still checked
    expect(conditionDriftOf({ partRequest: "جمع أحدث الأخبار عن شركات الاتصالات في مصر", own: { period: "آخر شهر" }, global: {}, elsewhere: new Set(), customerTexts: ["عايز أخبار آخر شهر عن شركات الاتصالات في مصر"], nowMs: NOW })).toMatchObject({ kind: "period" });
  });
  it("W1: a web-articles request the model marks needs_clarification WITHOUT a question is prepared, never asked for a platform", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "جمع مقالات وأخبار عامة عن الذكاء الاصطناعي في التعليم", content: ["articles"], topic: "الذكاء الاصطناعي في التعليم", objectives: [o("o1", "web.search", { request: "جمع مقالات وأخبار عامة عن الذكاء الاصطناعي في التعليم" })] }) }]);
    const db = world();
    const { r } = await turn(db, "عايز مقالات عن الذكاء الاصطناعي في التعليم");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
  });
  it("brief mode: the earlier turns are given as a transcript in the system prompt and the customer's message is the ONE user turn (no prose assistant turn to imitate)", async () => {
    const seen: ChatModelInput[] = [];
    await decideTurn({ message: "آخر شهر", balancePoints: null, open: null, history: [{ role: "user", content: "تعليقات تيك توك عن السياحة" }, { role: "assistant", content: "تمام، بنجهّز طلبك." }], brief: { enabled: true, soFar: null } }, async (i) => { seen.push(i); return { ok: true, text: JSON.stringify({ type: "data_request", reason: "", reply: "", count: null }) }; });
    expect(seen[0].messages).toEqual([{ role: "user", content: "آخر شهر" }]);
    expect(seen[0].system).toContain("العميل: «تعليقات تيك توك عن السياحة»");
    expect(seen[0].system).toContain("المساعد: «تمام، بنجهّز طلبك.»");
    expect(seen[0].system.endsWith(FORMAT_REMINDER_AR)).toBe(true);
    // brief mode off: the conversation is sent as before
    seen.length = 0;
    await decideTurn({ message: "آخر شهر", balancePoints: null, open: null, history: [{ role: "user", content: "تعليقات تيك توك عن السياحة" }, { role: "assistant", content: "تمام، بنجهّز طلبك." }] }, async (i) => { seen.push(i); return { ok: true, text: JSON.stringify({ type: "data_request", reason: "", reply: "", count: null }) }; });
    expect(seen[0].messages).toHaveLength(3);
  });
  it("M5: a brief that invents platforms for an open question is ASKED (words name no data), never answered «اكتب كمّل»", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "منشورات وتعليقات عن تطبيقات الصحة النفسية", platforms: ["tiktok", "x"], content: ["posts", "comments"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "منشورات تيك توك عن تطبيقات الصحة النفسية" }), o("o2", "social.parents", { platform: "x", request: "تغريدات عن تطبيقات الصحة النفسية" })] }) }]);
    const db = world();
    const { r } = await turn(db, "What do people think about mental health apps?");
    expect(r.contentAr).not.toBe(MULTI_PART_RETRY_AR);
    expect(r.contentAr).toMatch(/[؟?]/);
    expect(missions(db)).toHaveLength(0);
  });
});

describe("round 7", () => {
  it("J1: the hotels' own city («الغردقة», written by the customer) is not «another part's» because the news part's place is «مصر»; a city another part claims still is", () => {
    const base = { partRequest: "تقييمات ٢٠٠ فندق في الغردقة", own: {}, global: {}, elsewhere: new Set<any>(["place"]), customerTexts: ["عايز ٣٠٠ تعليق عن السياحة من تيك توك، وتقييمات ٢٠٠ فندق في الغردقة، وآخر أخبار السياحة في مصر"], nowMs: NOW };
    expect(conditionDriftOf({ ...base, elsewherePlaces: ["مصر"] })).toBeNull();
    expect(conditionDriftOf({ ...base, elsewherePlaces: ["الغردقة"] })).toMatchObject({ kind: "place", reason: "other_part" });
  });
});

describe("round 8", () => {
  it("K3: «خليهم ١٠٠ بس» with 100 in the count field only: the sentence states it and the request is replaced (never «still being prepared»)", async () => {
    scripted([tiktok("تعليقات تيك توك عن السياحة، ٣٠٠ تعليق", { count: 300 }), { ...tiktok("تعليقات تيك توك عن السياحة", { count: 100 }), type: "edit_of_open_request", count: 100 }]);
    const db = world();
    await turn(db, "هات ٣٠٠ تعليق تيك توك عن السياحة");
    const { r } = await turn(db, "خليهم ١٠٠ بس");
    expect(r.contentAr).not.toBe(PLAN_NOT_READY_AR);
    expect(live(db).map((m) => m.request_text)).toEqual(["تعليقات تيك توك عن السياحة، العدد ١٠٠"]);
  });
  it("J1: «كمّل» read as «other» after every part is prepared: «already prepared», never «not a request»", async () => {
    scripted([
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات تيك توك عن السياحة، وأخبار السياحة في مصر", platforms: ["tiktok"], content: ["comments", "articles"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "تعليقات تيك توك عن السياحة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "web.search", { request: "آخر أخبار السياحة في مصر" })] }) },
      { type: "other", reason: "x", reply: "", count: null },
    ]);
    const db = world();
    await turn(db, "عايز تعليقات تيك توك عن السياحة، وكمان آخر أخبار السياحة في مصر");
    const { r } = await turn(db, "كمّل");
    expect(r.contentAr).toBe(GROUP_UNCHANGED_AR);
    expect(live(db)).toHaveLength(2);
  });
});
