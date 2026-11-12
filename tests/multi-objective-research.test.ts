import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { createMemoryStore, newMission, type MemoryStore } from "../agent/src/memoryStore";
import { assertReplayInvariants, readWorkbook, replay, REPLAY_USER } from "./helpers/agentReplay";
import { callIds, lastOutputId, type Results } from "./helpers/agentFakeWorld";
import { fakeContextDev, mapsPlace, mapsReviews } from "./helpers/fakeContextDev";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR, AGENT_TURN_CONTENT_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY, GROUP_UNCHANGED_AR, TRUNCATED_AR } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { approveForCustomer } from "../src/lib/agentMission/customerActions";
import { parseBrief, validateBrief, type ResearchBrief } from "../src/lib/agentMission/researchBrief";
import { partBriefOf, partsOf, storedGroupOf } from "../src/lib/agentMission/researchGroup";
import { preModelAnswer } from "../src/lib/agentMission/guardRules";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { buildCapabilityRegistry, CAPABILITY_DISCOVERY_FLAG_KEY, discoverCapabilities, researchNeedOf, SCOPE_ANCHOR_FOLDER, type CapabilityDiscovery } from "../src/lib/agentMission/capabilities";
import { capabilityAnchorOf, objectiveOutcomesLineAr, runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { abortActiveRuns } from "../agent/src/sessions";
import { readSnapshot } from "../agent/src/items/itemStore";
import { pages, planning as xPlanning } from "./helpers/engineXScenario";
import { fakeRecorder, NOT_ADMIN } from "./helpers/agentHarness";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * MULTI-OBJECTIVE RESEARCH (docs/MULTI-OBJECTIVE-RESEARCH.md), OFFLINE, through the real code paths: the chat turn (`agentChatTurn`, a SCRIPTED model in the real one-line JSON format), the worker's `runPlanning` / `runExecution` (a fake planning model,
 * fake Context.dev / TREG answers), the customer's approval and the settlement (the existing money fakes, with their arithmetic). NO network, NO paid call, NO key. These tests prove what the backend does with what a model writes; they do
 * NOT prove what a real model writes or what a live provider returns.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
type Obj = { id: string; operation: string; platform?: string; parent?: string; contacts?: string[]; what?: string; request?: string };
const o = (id: string, operation: string, x: Partial<Obj> = {}): Obj => ({ id, operation, ...x });
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const say = (brief: Record<string, unknown>, reply = "", type = "data_request") => ({ type, reason: "x", reply, count: null, brief: briefOf(brief) });
let modelCalls: ChatModelInput[] = [];
function scripted(steps: Array<Record<string, unknown> | "truncated">) {
  modelCalls = [];
  const script = [...steps];
  setChatModelForTesting(async (input) => {
    modelCalls.push(input);
    const s = script.shift();
    if (!s) return { ok: false, failure: "http_529" };
    if (s === "truncated") return { ok: true, text: '{"type":"data_request","reason":"x","reply":"","brief":{"status":"ready","request":"عايز تعليقات تيك توك عن السياحة، وتقييمات فنادق الغردقة، وآخر الأخبار","objectives":[{"id":"o1","operation":"social.par', truncated: true };
    return { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 420 } };
  });
}

// THE CUSTOMER'S REQUEST OF THE MISSION and the model's reading of it
const REQUEST = "عايز تعليقات تيك توك عن السياحة، وتقييمات فنادق الغردقة، وآخر الأخبار عن السياحة في مصر";
const TIKTOK_PART = "هات تعليقات تيك توك عن السياحة";
const HOTELS_PART = "تقييمات فنادق الغردقة";
const NEWS_PART = "آخر الأخبار عن السياحة في مصر";
const THREE_PARTS = (hotels = HOTELS_PART) => ({
  request: REQUEST.replace("فنادق الغردقة", hotels.replace("تقييمات ", "")), platforms: ["tiktok"], content: ["comments", "places", "reviews"],
  objectives: [
    o("o1", "social.parents", { platform: "tiktok", request: TIKTOK_PART }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }),
    o("o3", "places.discover", { request: hotels }), o("o4", "places.reviews", { parent: "o3" }),
    o("o5", "web.search", { request: NEWS_PART }), o("o6", "web.read", { parent: "o5" }),
  ],
});

const USER = REPLAY_USER;
function chatWorld(o2: { capability?: boolean; brief?: boolean } = {}) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
  db.seed("agent_settings", [...(o2.brief === false ? [] : [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }]), ...(o2.capability === false ? [] : [{ key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER] } }])]);
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const at = Date.parse("2026-11-12T09:00:00Z") + seq * 10_000;
  db.seed("messages", [
    { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
  ]);
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  return { r, assistant: db.rows("messages").find((m: any) => m.id === `a${seq}`) };
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
const cardMessages = (db: any) => db.rows("messages").filter((m: any) => m.role === "assistant" && m.plan?.agentMissionId);
let infos: string[] = [];
const lastOutcome = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line).brief : null; };
let fetchSpy: ReturnType<typeof vi.fn>;
const chatHooks = () => {
  beforeEach(() => {
    infos = [];
    fetchSpy = vi.fn(async () => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(console, "info").mockImplementation((line: unknown) => { infos.push(String(line)); });
  });
  afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
};

describe("A, G, L. one request with three objectives: every objective understood, kept, prepared on its own card; nothing paid before approval", () => {
  chatHooks();
  it("TikTok comments + hotel reviews + news: ONE model call, THREE missions (one card each, each with its own part brief), the whole brief kept; no provider call", async () => {
    scripted([say(THREE_PARTS())]);
    const db = chatWorld();
    const { r, assistant } = await turn(db, REQUEST);
    expect(modelCalls).toHaveLength(1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // every part's card is its own stored message (the answer itself is the summary and draws no card)
    expect(r.extraMissions).toHaveLength(3);
    expect(r.summaryOnly).toBe(true);
    expect(missions(db).map((m) => m.request_text)).toEqual([TIKTOK_PART, HOTELS_PART, NEWS_PART]);
    expect(missions(db).every((m) => m.status === "queued")).toBe(true);
    // the summary names every part and says approvals are per part
    for (const part of [TIKTOK_PART, HOTELS_PART, NEWS_PART]) expect(r.contentAr).toContain(part);
    expect(r.contentAr).toContain("تعتمد كل جزء لوحده");
    // each card is its own stored assistant message with its own part brief (the worker reads THAT brief) and the whole group
    const cards = cardMessages(db);
    expect(cards.map((m: any) => m.plan.agentMissionId)).toEqual(missions(db).map((m) => m.id));
    expect(cards.map((m: any) => m.plan.researchBrief.request)).toEqual([TIKTOK_PART, HOTELS_PART, NEWS_PART]);
    expect(cards.map((m: any) => m.id)).toEqual(r.extraMissions!.map((c) => c.messageId));
    expect(assistant.plan.agentMissionId).toBeUndefined();
    expect(assistant.plan.researchGroup.parts.map((p: any) => p.missionId)).toEqual(missions(db).map((m) => m.id));
    const group = storedGroupOf(cards[2].plan, (raw) => { const p = parseBrief(raw); return p.ok ? p.brief : null; })!;
    expect(group.brief.objectives).toHaveLength(6);
    expect(group.parts.map((p) => p.outcome)).toEqual(["planned", "planned", "planned"]);
    // L: the chat called no provider
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("each part's brief is validated like a brief of its own and maps to its own capabilities", () => {
    const reg = buildCapabilityRegistry(catalog, { isAllowed: allowed });
    const p = parseBrief(briefOf(THREE_PARTS()));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const shapes = partsOf(p.brief).map((part) => {
      const pb = partBriefOf(part)!;
      const v = validateBrief(pb, { customerTurns: [REQUEST] });
      expect(v.ok, pb.request).toBe(true);
      const d = discoverCapabilities(researchNeedOf({ request: pb.request, brief: pb }), reg);
      expect(d.status, pb.request).toBe("supported");
      return d.stages.map((s) => s.stage.operation);
    });
    expect(shapes).toEqual([["social.parents", "social.comments"], ["places.discover", "places.reviews"], ["web.search", "web.read"]]);
  });
});

describe("C. two social platforms with different capabilities", () => {
  chatHooks();
  it("TikTok comments with replies and X replies: two cards; X (where a reply to a post IS its comment) has no separate replies step, TikTok has one", async () => {
    const text = "هات تعليقات وردود تيك توك عن الدوري المصري، وردود إكس عن نفس الموضوع";
    scripted([say({
      request: text, platforms: ["tiktok", "x"], content: ["comments", "replies"],
      objectives: [
        o("o1", "social.parents", { platform: "tiktok", request: "هات تعليقات وردود تيك توك عن الدوري المصري" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "social.replies", { platform: "tiktok", parent: "o2" }),
        o("o4", "social.parents", { platform: "x", request: "هات ردود إكس عن الدوري المصري" }), o("o5", "social.replies", { platform: "x", parent: "o4" }),
      ],
    })]);
    const db = chatWorld();
    const { r } = await turn(db, text);
    expect(r.ok).toBe(true);
    expect(missions(db).map((m) => m.request_text)).toEqual(["هات تعليقات وردود تيك توك عن الدوري المصري", "هات ردود إكس عن الدوري المصري"]);
    const reg = buildCapabilityRegistry(catalog, { isAllowed: allowed });
    const stagesOf = (i: number) => { const b = cardMessages(db)[i].plan.researchBrief as ResearchBrief; return discoverCapabilities(researchNeedOf({ request: b.request, brief: b }), reg).stages.map((s) => s.stage.key); };
    expect(stagesOf(0)).toEqual(["tiktok_parents", "tiktok_comments", "tiktok_replies"]);
    expect(stagesOf(1)).toEqual(["x_parents", "x_comments"]);
  });
});

describe("D. natural multi-turn corrections change only what changed", () => {
  chatHooks();
  it("«خلي الفنادق في شرم بدل الغردقة»: only the hotels part is withdrawn and prepared again; the TikTok and news cards are kept (never planned twice); «تمام» creates nothing; «موافق» approves nothing", async () => {
    const db = chatWorld();
    scripted([say(THREE_PARTS())]);
    await turn(db, REQUEST);
    const [tiktok, hotels, news] = missions(db).map((m) => m.id);
    scripted([say(THREE_PARTS("تقييمات فنادق شرم الشيخ"), "", "edit_of_open_request")]);
    const second = await turn(db, "خلي الفنادق في شرم الشيخ بدل الغردقة");
    // the earlier objectives and part sentences were given back to the model (confirmed information preserved)
    expect(modelCalls[0].system).toContain(`«${TIKTOK_PART}»`);
    expect(second.r.ok).toBe(true);
    const byId = new Map(missions(db).map((m) => [m.id, m]));
    expect(byId.get(hotels)!.status).toBe("cancelled");
    expect(byId.get(tiktok)!.status).toBe("queued");
    expect(byId.get(news)!.status).toBe("queued");
    expect(live(db).map((m) => m.request_text)).toEqual([TIKTOK_PART, NEWS_PART, "تقييمات فنادق شرم الشيخ"]);
    expect(second.r.contentAr).toContain("مش هتتغير");
    // a repetition creates nothing
    scripted([say(THREE_PARTS("تقييمات فنادق شرم الشيخ"))]);
    const third = await turn(db, "تمام كده");
    expect(third.r).toMatchObject({ ok: false, contentAr: GROUP_UNCHANGED_AR });
    expect(live(db)).toHaveLength(3);
    // a typed agreement is never an approval
    scripted([]);
    const fourth = await turn(db, "موافق");
    expect(fourth.r.contentAr).toBe(AGENT_PRESS_APPROVE_AR);
    expect(missions(db).filter((m) => m.status === "approved")).toHaveLength(0);
  });
});

describe("E, K. an unsupported or private part among supported ones: the supported parts are prepared, the others said honestly; nothing silently dropped", () => {
  chatHooks();
  it("TikTok comments + Snapchat stories + competitors' traffic numbers: one card for TikTok; Snapchat and the traffic said with why and an alternative; the brief keeps all three", async () => {
    const text = "عايز تعليقات تيك توك عن الموضة، وستوريز سناب شات عن الموضة، وعدد زوار مواقع المنافسين";
    scripted([say({
      request: "عايز تعليقات تيك توك عن الموضة", platforms: ["tiktok"], content: ["comments"],
      objectives: [o("o1", "social.parents", { platform: "tiktok", request: "هات تعليقات تيك توك عن الموضة" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "social.parents", { platform: "snapchat", request: "ستوريز سناب شات عن الموضة" }), o("o4", "unsupported", { what: "عدد زوار مواقع المنافسين" })],
    })]);
    const db = chatWorld();
    const { r, assistant } = await turn(db, text);
    expect(r.ok).toBe(true);
    expect(missions(db).map((m) => m.request_text)).toEqual(["هات تعليقات تيك توك عن الموضة"]);
    expect(r.contentAr).toContain("سناب شات ليست من المصادر");
    expect(r.contentAr).toContain("لا يطابق أي نوع");
    expect(r.contentAr).toContain("المتاح الآن مثلًا");
    expect(assistant.plan.researchGroup.parts.map((p: any) => p.outcome)).toEqual(["planned", "unsupported", "unsupported"]);
  });

  it("K. a part that asks for private contacts is refused alone; the public parts go on", async () => {
    const text = "عايز تعليقات تيك توك عن السياحة، وتقييمات فنادق الغردقة";
    scripted([say({
      request: text, platforms: ["tiktok"], content: ["comments", "places", "reviews"],
      objectives: [o("o1", "social.parents", { platform: "tiktok", request: TIKTOK_PART }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" }), o("o3", "places.discover", { request: "تقييمات فنادق الغردقة وأرقام موبايلات الناس اللي كتبوها" }), o("o4", "places.reviews", { parent: "o3" })],
    })]);
    const db = chatWorld();
    const { r, assistant } = await turn(db, text);
    expect(missions(db).map((m) => m.request_text)).toEqual([TIKTOK_PART]);
    expect(r.contentAr).toContain("بيانات خاصة");
    expect(assistant.plan.researchGroup.parts.map((p: any) => p.outcome)).toEqual(["planned", "refused_private"]);
  });

  it("K. a request whose every part is private is refused like a typed one; no mission", async () => {
    scripted([say({ request: "هات أرقام موبايلات المعلقين على تيك توك", platforms: ["tiktok"], objectives: [o("o1", "social.parents", { platform: "tiktok", request: "أرقام موبايلات المعلقين على تيك توك" }), o("o2", "social.parents", { platform: "tiktok", request: "إيميلات المتابعين الشخصية على تيك توك" })] })]);
    const db = chatWorld();
    const { r } = await turn(db, "هات تعليقات تيك توك");
    expect(r.ok).toBe(false);
    expect(missions(db)).toHaveLength(0);
  });
});

describe("8. robustness: a cut model answer never drops the objectives; the open-missions limit never drops a part", () => {
  chatHooks();
  it("an answer cut at the output ceiling: no keyword-read mission; the customer continues with «كمّل» and the parts are prepared without retyping", async () => {
    const db = chatWorld();
    scripted(["truncated"]);
    const first = await turn(db, REQUEST);
    expect(first.r).toMatchObject({ ok: false, contentAr: TRUNCATED_AR });
    expect(missions(db)).toHaveLength(0);
    expect(lastOutcome()).toBe("model_truncated");
    scripted([say(THREE_PARTS())]);
    const second = await turn(db, "كمّل");
    expect(second.r.ok).toBe(true);
    expect(missions(db)).toHaveLength(3);
    // the model was given the original request in the conversation history
    // brief mode: the earlier turns are in the system prompt's conversation (round 50); the model still reads the whole request
    expect(JSON.stringify([modelCalls[0].system, modelCalls[0].messages])).toContain("تقييمات فنادق الغردقة");
  });

  it("four parts with the worker's limit of three open requests: the fourth WAITS (said, kept) and is prepared on «كمّل», never dropped", async () => {
    const db = chatWorld();
    const four = { ...THREE_PARTS(), content: ["comments", "places", "reviews", "companies"], objectives: [...THREE_PARTS().objectives, o("o7", "companies.discover", { request: "شركات السياحة في مصر" })] };
    scripted([say(four)]);
    const first = await turn(db, `${REQUEST}، وشركات السياحة في مصر`);
    expect(first.r.ok).toBe(true);
    expect(missions(db)).toHaveLength(3);
    expect(first.r.contentAr).toContain("مستني");
    expect(first.assistant.plan.researchGroup.parts.map((p: any) => p.outcome)).toEqual(["planned", "planned", "planned", "waiting"]);
    // the worker took the first parts (no longer queued): «كمّل» prepares the fourth from the kept brief
    // (the in-memory table has no default timestamps: the real one stamps created_at, which the expiry of old waiting plans reads)
    for (const m of missions(db) as any[]) Object.assign(m, { status: "plan_ready", created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    scripted([say(four)]);
    const second = await turn(db, "كمّل");
    expect(second.r.ok).toBe(true);
    expect(missions(db).map((m) => m.request_text)).toEqual([TIKTOK_PART, HOTELS_PART, NEWS_PART, "شركات السياحة في مصر"]);
    expect(live(db)).toHaveLength(4);
  });
});

describe("NO FALSE REFUSALS: legitimate public-data requests reach the agent", () => {
  chatHooks();
  const LEGIT = [
    "عايز تعليقات تيك توك عن نصب شركات التسويق الشبكي",
    "هات أخبار عن قانون حماية البيانات الشخصية في مصر",
    "تعليقات فيسبوك عن عروض شركات الموبايل في مصر",
    "آراء الناس على إكس عن واتساب بيزنس",
    "تغريدات عن الانتخابات الرئاسية",
    "شركات بتبيع خطوط موبايل وإيميلاتها الرسمية",
    "مقالات عن سرقة الهوية والاحتيال الإلكتروني",
    "تعليقات يوتيوب عن أسعار الموبايلات الجديدة",
    "عايز أعرف الناس بتقول إيه عن تسريب أرقام التليفونات من التطبيقات",
    "هات تعليقات عن رسائل النصب اللي بتيجي على الواتساب",
    "شركات الاتصالات في مصر وأرقام خدمة العملاء الرسمية بتاعتها",
    "مقالات عن الرقم القومي الجديد وإجراءات استخراجه",
    "هات أخبار السياسة في مصر الأسبوع ده",
    "هات تعليقات تيك توك عن تسريب أرقام موبايلات من تطبيقات التوصيل",
  ];
  for (const text of LEGIT) {
    it(`«${text}» is not refused by a word: the model is asked and a mission is created`, async () => {
      expect(preModelAnswer(text)).toBeNull();
      scripted([{ type: "data_request", reason: "x", reply: "", count: null }]);
      const db = chatWorld({ brief: false, capability: false });
      const { r } = await turn(db, text);
      expect(modelCalls).toHaveLength(1);
      expect(r).toMatchObject({ ok: true, contentAr: AGENT_TURN_CONTENT_AR });
      expect(missions(db)).toHaveLength(1);
    });
  }
  const STILL_REFUSED = ["هات أرقام تليفونات الناس اللي علقوا على تيك توك", "هات تعليقات فيها أرقام موبايلات", "هات منشورات عن ارقام تليفونات الناس العاديين", "هات تعليقات عن السياحة واستخرج أرقام الموبايلات منها", "هات رسايل جروب الواتساب بتاع الشغل", "هات الرقم القومي لأحمد محمد"];
  for (const text of STILL_REFUSED) {
    it(`a request that really collects private data stays refused: «${text}»`, async () => {
      expect(preModelAnswer(text)?.kind).toBe("privacy_refusal");
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE WORKER: the approved part, end to end
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const WHY = "the planner sampled the validated capability it ranks first for these fields";
const lastRows = (r: Results) => (r.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3);
function hotelsPartReplay(o2: { reviewsDelivered?: number; request?: string; brief?: Record<string, unknown> } = {}) {
  const web = fakeContextDev({ parse: (parser, _url, body) => (parser === "google-maps" ? { data: { results: mapsPlace("فندق الشاطئ الغردقة").results.map((p) => ({ ...p, address: "طريق الشيراتون، الغردقة", city: "الغردقة", google_category: ["فندق"] })) }, credits: 1 } : { data: mapsReviews(Math.min(o2.reviewsDelivered ?? 1000, body.parseParams.limit)), credits: 1 }) });
  const SEARCH = "https://www.google.com/maps/search/%D9%85%D8%B7%D8%B9%D9%85+%D8%A3%D8%A8%D9%88+%D8%B7%D8%A7%D8%B1%D9%82+%D8%A7%D9%84%D9%82%D8%A7%D9%87%D8%B1%D8%A9/";
  const PLACE = "https://www.google.com/maps/place/?q=place_id:ChIJplace0001";
  return replay({
    request: o2.request ?? REQUEST,
    web,
    makeStore: () => { const s = createMemoryStore(); Object.assign(s.settings, { [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] } }); return s; },
    beforeChat: (db) => {
      db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [REPLAY_USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [REPLAY_USER] } }]);
      scripted([say(o2.brief ?? THREE_PARTS())]);
    },
    chooseMission: (t) => t.extraMissions!.find((c) => (c.contentAr ?? "").includes(HOTELS_PART))!.id,
      planning: [
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH, why: WHY } },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 100, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url, rating: p.rating }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق بنص كل تقييم ودرجته وتاريخه.",
          stages: [
            { key: "place", title_ar: "المكان", endpoint_id: "contextdev.parse.google-maps", expected_rows: 1, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم المكان" }, { key: "url", title_ar: "رابط المكان" }, { key: "rating", title_ar: "التقييم" }], sample_rows: lastRows(res).slice(0, 1), measured_by: [callIds(res)[0]] },
            { key: "reviews", title_ar: "التقييمات", endpoint_id: "contextdev.parse.google-maps-reviews", expected_rows: 200, parent_key: "place", per_parent_rows: 200, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "date", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }, { key: "writer", title_ar: "الكاتب" }, { key: "page_link", title_ar: "الرابط" }], sample_rows: [{ id: "rv0", text: "تجربة رقم 0 في المكان", rating: 1, date: "2026-09-20T12:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }) },
      ],
      execution: () => [
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url, rating: p.rating }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "place", from_output: lastOutputId(res) }) },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 200 } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(v => ({ id: v.id, parent_id: 'ChIJplace0001', text: v.snippet, rating: v.rating, date: v.isoDate }))", files: [callIds(res)[1]] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "reviews", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ٢٠٠ تقييم للمكان المطلوب." } },
      ],
      answers: [],
  });
}

describe("H, I, L, M. the customer approves ONE part: only that part is held, executed, delivered and charged; every objective of it has an explicit outcome", () => {
  afterEach(() => { setChatModelForTesting(null); vi.restoreAllMocks(); });
  it("the hotels part is planned from its own validated objectives, approved on its own card, executed and settled; the TikTok and news parts are untouched (queued, nothing held, no call)", async () => {
    const r = await hotelsPartReplay();
    const all = r.db.rows("missions") as Array<{ id: string; status: string; request_text: string; job_id?: string | null }>;
    expect(r.mission.request_text).toBe(HOTELS_PART);
    // the plan came from the part's objectives (validated set) and carries its record and the server's anchor
    expect(r.plannedPlan.capability_selection!.stages.map((s) => s.operation)).toEqual(["places.discover", "places.reviews"]);
    expect((await capabilityAnchorOf(r.store, r.missionId)).required).toBe(true);
    assertReplayInvariants(r, { expectDelivered: 201 });
    // H: the other parts were not approved, held, planned or called
    const others = all.filter((m) => m.id !== r.missionId);
    expect(others.map((m) => [m.request_text, m.status])).toEqual([[TIKTOK_PART, "queued"], [NEWS_PART, "queued"]]);
    expect(others.every((m) => !m.job_id)).toBe(true);
    // M: one hold, one release, no negative balance
    expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(r.money.balance()).toBeGreaterThanOrEqual(0);
    // a second approval of the same part is refused (never held twice)
    const again = await approveForCustomer(r.db as never, { id: r.missionId, userId: REPLAY_USER, isGuest: false, emailVerified: true });
    expect(again.ok).toBe(false);
    expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    // L: no TREG call at all; every Context.dev call is the planner's sampling or this part's approved execution
    expect(r.call).not.toHaveBeenCalled();
    // every objective of the part has its outcome
    expect(r.store.events.map((e) => e.message_ar).find((m) => m.startsWith("نتيجة كل هدف"))).toContain("سُلّم كاملًا");
  });

  it("EXACT REQUIREMENTS end to end: the TikTok part drifted («آخر شهر» → «آخر سنة») is asked and never becomes a mission; the hotels part, its place attributed exactly, is planned, approved on its own card, executed and settled", async () => {
    const request = REQUEST.replace("تعليقات تيك توك عن السياحة", "تعليقات تيك توك عن السياحة آخر شهر");
    const brief = { ...THREE_PARTS(), request, objectives: THREE_PARTS().objectives.map((x: any) => (x.id === "o1" ? { ...x, request: "هات تعليقات تيك توك عن السياحة آخر سنة", period: "آخر شهر" } : x.id === "o3" ? { ...x, country: "الغردقة" } : x.id === "o5" ? { ...x, country: "مصر" } : x)) };
    const r = await hotelsPartReplay({ request, brief });
    const all = r.db.rows("missions") as Array<{ id: string; status: string; request_text: string; job_id?: string | null }>;
    expect(all.map((m) => m.request_text)).toEqual([HOTELS_PART, NEWS_PART]);
    expect(r.mission.request_text).toBe(HOTELS_PART);
    assertReplayInvariants(r, { expectDelivered: 201 });
    // the other part waits for its own approval: nothing held, nothing run
    expect(all.find((m) => m.request_text === NEWS_PART)).toMatchObject({ status: "queued" });
    expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(r.call).not.toHaveBeenCalled();
  });

  it("I. a source that gives fewer reviews than approved: the part ends PARTIAL, the outcome of each objective is said, and only the delivered rows are charged", async () => {
    const r = await hotelsPartReplay({ reviewsDelivered: 150 });
    assertReplayInvariants(r, { expectDelivered: 151, expectStatus: "partial" });
    const line = r.store.events.map((e) => e.message_ar).find((m) => m.startsWith("نتيجة كل هدف"))!;
    expect(line).toContain("سُلّم كاملًا");
    expect(line).toContain("سُلّم جزئيًا، ولا تدفع إلا عن المسلَّم");
    const sheet = (await readWorkbook(r)).getWorksheet("التقييمات")!;
    expect(sheet.rowCount).toBe(151);
  });

  it("the outcome line: every delivering objective with its count; a single-stage plan has none (its status says it)", () => {
    const plan = { stages: [{ key: "a", title_ar: "الأماكن", deliver: true, planned_rows: 3 }, { key: "b", title_ar: "التقييمات", deliver: true, planned_rows: 10 }, { key: "c", title_ar: "داخلي", deliver: false, planned_rows: 5 }], capability_selection: { stages: [] } } as unknown as PricedPlan;
    expect(objectiveOutcomesLineAr(plan, { a: 3, b: 0 })).toBe("نتيجة كل هدف من طلبك: الأماكن: ٣ من ٣ (سُلّم كاملًا)؛ التقييمات: ٠ من ١٠ (لم يُسلَّم منه شيء، ولم تدفع عنه).");
    expect(objectiveOutcomesLineAr({ ...plan, stages: plan.stages.slice(0, 1) } as PricedPlan, { a: 3 })).toBeNull();
  });
});

describe("B, F. official business contacts; a provider with no allowance", () => {
  chatHooks();
  it("B. companies + websites + official contacts (one first objective): one card, its brief carries the chain; the worker's planner is given companies → e-mails / phones fed by the website", async () => {
    const text = "عايز شركات السياحة في الغردقة ومواقعها وإيميلات وأرقام الشغل الرسمية بتاعتها";
    scripted([say({ request: text, content: ["companies"], objectives: [o("o1", "companies.discover"), o("o2", "company.contacts", { parent: "o1", contacts: ["email", "phone"] })] })]);
    const db = chatWorld();
    const { r } = await turn(db, text);
    expect(r).toMatchObject({ ok: true });
    expect(missions(db)).toHaveLength(1);
    const card = cardMessages(db)[0];
    expect(card.plan.researchGroup).toBeUndefined();
    vi.unstubAllGlobals();
    const prompts: string[] = [];
    const out = await planWorker(missions(db)[0].request_text, { brief: card.plan.researchBrief, prompts });
    expect(prompts[0]).toContain("VALIDATED CAPABILITIES");
    expect(prompts[0]).toMatch(/stage company_emails \(company\.contacts, child of companies/);
    expect(prompts[0]).toMatch(/stage company_phones \(company\.contacts, child of companies/);
    expect(out.rec.rows).toHaveLength(0);
  });

  it("F. the news part when both web providers' allowance is spent: other eligible capabilities (the catalog's own news search) are searched before any failure; no web call", async () => {
    const reg = buildCapabilityRegistry(catalog, { isAllowed: allowed, dailyCapUsd: { firecrawl: 0, contextdev: 0 } });
    const pb = partBriefOf(partsOf((parseBrief(briefOf(THREE_PARTS())) as { ok: true; brief: ResearchBrief }).brief)[2])!;
    const d: CapabilityDiscovery = discoverCapabilities(researchNeedOf({ request: pb.request, brief: pb }), reg);
    const search = d.stages.find((s) => s.stage.operation === "web.search")!;
    expect(search.selected).not.toBeNull();
    expect(search.eligible.every((e) => e.provider === "treg")).toBe(true);
    expect(search.rejected.some((x) => x.reason === "provider_daily_cap_zero")).toBe(true);
    // the page reader: served by an eligible capability, or the step is said (partial), never assumed
    const read = d.stages.find((s) => s.stage.operation === "web.read")!;
    if (read.selected === null) expect(d.status).toBe("partial");
    else expect(d.status).toBe("supported");
    // in the worker: no Context.dev / Firecrawl request is made for a provider with no allowance
    vi.unstubAllGlobals();
    const web = fakeContextDev({});
    const out = await planWorker(pb.request, { brief: pb, caps: { firecrawl: 0, contextdev: 0 }, web });
    expect(web.fetchFn).not.toHaveBeenCalled();
    expect(out.rec.rows).toHaveLength(0);
  });
});

/** The worker's planning of one mission whose card stored `brief`, with a planning model that proposes nothing (the planner's prompt and the discovery are what is checked). */
async function planWorker(request: string, o2: { brief: ResearchBrief; prompts?: string[]; caps?: Partial<Record<"firecrawl" | "contextdev", number>>; web?: ReturnType<typeof fakeContextDev> }) {
  vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
  const store = createMemoryStore();
  Object.assign(store.settings, { [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] } });
  const id = "msn_partworker01";
  store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: request, status: "planning", created_at: "2026-11-12T09:00:00Z" }) as never);
  const rec = fakeRecorder({ dailyCapUsd: 5 });
  const driver = createFakeDriver([]);
  const deps: RunnerDeps = {
    store, client: {}, catalog, driver: { run: async (i: Parameters<RunnerDeps["driver"]["run"]>[0]) => { o2.prompts?.push(i.userPrompt); return driver.run(i); } } as RunnerDeps["driver"], recorder: rec.recorder, commit: rec.commit, call: vi.fn(async () => { throw new Error("no TREG call expected"); }) as never,
    models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, readMissionBrief: async () => o2.brief,
    ...(o2.caps ? { providerDailyCaps: async () => o2.caps! } : {}), ...(o2.web ? { providerKey: async () => "test-provider-key", fetchFn: o2.web.fetchFn as never } : {}),
  };
  await runPlanning(deps, store.missions.get(id)!);
  vi.unstubAllGlobals();
  return { store, rec };
}

describe("J, N. restart and legacy", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  async function xRun(stopAfterCalls: number | null, capability: boolean) {
    let captured: RunnerDeps | null = null;
    let calls = 0;
    const r = await replay({
      request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: xPlanning(), execution: () => [], answers: [pages(1)[0], ...pages(30)],
      deps: (d) => {
        (d.store as MemoryStore).settings.redesign_flags = { social_posts: "on" };
        if (capability) (d.store as MemoryStore).settings[CAPABILITY_DISCOVERY_FLAG_KEY] = { user_ids: [REPLAY_USER] };
        const inner = d.call!;
        captured = { ...d, call: (async (x: Parameters<typeof inner>[0]) => { const out = await inner(x); calls += 1; if (stopAfterCalls !== null && calls === stopAfterCalls) abortActiveRuns("memory"); return out; }) as typeof inner };
        return captured;
      },
    });
    return { r, deps: captured as unknown as RunnerDeps };
  }
  it("J. a run killed mid-execution and restarted: the scope check passes again (same record, same anchor), no row twice, one hold, one settlement", async () => {
    const whole = await xRun(null, true);
    const cut = await xRun(4, true);
    expect(cut.r.plannedPlan.capability_selection).toBeDefined();
    expect(cut.r.mission.status).toBe("approved");
    await cut.r.store.claimMission("w_replay", 120);
    await runExecution(cut.deps, cut.r.store.missions.get(cut.r.missionId)!);
    const final = cut.r.store.missions.get(cut.r.missionId)!;
    expect(final.status).toBe("completed");
    expect(String(final.error ?? "")).not.toContain("approved_scope_changed");
    const a = (await readSnapshot(cut.r.store, cut.r.missionId)).acceptedRows("tweets").map((x) => String(x.id));
    const b = (await readSnapshot(whole.r.store, whole.r.missionId)).acceptedRows("tweets").map((x) => String(x.id));
    expect(new Set(a).size).toBe(a.length);
    expect(a).toEqual(b);
    expect(final.charged_points).toBe(whole.r.mission.charged_points);
    expect(cut.r.money.calls.map((c) => c.name)).toEqual(whole.r.money.calls.map((c) => c.name));
  });

  it("N. the same mission with the switch OFF: no record, no anchor, the same delivery", async () => {
    const off = await xRun(null, false);
    const on = await xRun(null, true);
    expect(off.r.plannedPlan.capability_selection).toBeUndefined();
    expect(await off.r.store.listFiles(off.r.missionId, SCOPE_ANCHOR_FOLDER)).toEqual([]);
    expect(off.r.mission.delivered_units).toBe(on.r.mission.delivered_units);
    expect(off.r.mission.charged_points).toBe(on.r.mission.charged_points);
  });

  it("N. a single-objective request in brief mode keeps today's single card (no group)", async () => {
    infos = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network"); }));
    scripted([say({ request: TIKTOK_PART, platforms: ["tiktok"], content: ["comments"], objectives: [o("o1", "social.parents", { platform: "tiktok" }), o("o2", "social.comments", { platform: "tiktok", parent: "o1" })] })]);
    const db = chatWorld();
    const { r } = await turn(db, TIKTOK_PART);
    expect(r).toMatchObject({ ok: true, contentAr: AGENT_TURN_CONTENT_AR });
    expect(cardMessages(db)).toHaveLength(1);
    expect(cardMessages(db)[0].plan.researchGroup).toBeUndefined();
    setChatModelForTesting(null);
  });
});
