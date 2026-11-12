import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { REPLAY_USER } from "./helpers/agentReplay";
import { agentChatTurn, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting } from "../src/lib/agentMission/chatModel";
import { CAPABILITY_DISCOVERY_FLAG_KEY } from "../src/lib/agentMission/capabilities";
import { selfReferenceOf, selfReferenceQuestionAr, selfReferenceUnresolved } from "../src/lib/agentMission/selfReference";

/**
 * THE INTELLIGENCE LAYER, FINAL ACCEPTANCE (docs/DIGER-INTELLIGENCE-FINAL-ACCEPTANCE.md), OFFLINE. Each test scripts the chat model with the shape the real model wrote and runs the REAL chat turn over an in-memory database.
 * No network, no paid call.
 */
const USER = REPLAY_USER;
const briefOf = (b: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...b });
const o = (id: string, operation: string, x: Record<string, unknown> = {}) => ({ id, operation, platform: null, parent: null, contacts: [], what: "", ...x });
function scripted(steps: Array<Record<string, unknown>>) {
  const script = [...steps];
  setChatModelForTesting(async () => { const s = script.shift(); return s ? { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1800, outputTokens: 420 } } : { ok: false, failure: "http_529" }; });
}
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
  // the stored answer is what the next turn reads as the assistant's question
  const a = db.rows("messages").find((m: any) => m.id === `a${seq}`);
  if (a && a.content_ar === "…") a.content_ar = r.contentAr;
  return r;
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
let infos: string[] = [];
const lastLog = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line) : null; };
beforeEach(() => {
  infos = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
  vi.spyOn(console, "info").mockImplementation((line: unknown) => { infos.push(String(line)); });
});
afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const D2 = "محتاج معلومات عن منافسين شركتي";

describe("D2: a request about the customer's own business that nobody named is asked IN THE CHAT, never a mission whose card asks", () => {
  for (const [name, status, op, content] of [
    ["round-9 shape: needs_clarification, no question, companies", "needs_clarification", "companies.discover", ["companies"]],
    ["needs_clarification, no question, web research", "needs_clarification", "web.search", ["articles"]],
    ["the model says ready", "ready", "companies.discover", ["companies"]],
  ] as const) {
    it(name, async () => {
      scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status, request: "معلومات عن منافسين شركتي", content, topic: "منافسين شركتي", objectives: [o("o1", op, { what: "منافسين شركتي" })] }) }]);
      const db = world();
      const r = await turn(db, D2);
      expect(r.ok).toBe(false);
      expect(r.contentAr).toBe(selfReferenceQuestionAr("company"));
      expect(missions(db)).toHaveLength(0);
      expect(lastLog()?.brief).toBe("clarify_self_reference_company");
    });
  }
  it("the model's OWN question is used when it wrote one", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "إيه مجال شركتك؟", count: null, brief: briefOf({ status: "needs_clarification", request: "معلومات عن منافسين شركتي", content: ["companies"], objectives: [o("o1", "companies.discover")] }) }]);
    const db = world();
    const r = await turn(db, D2);
    expect(r.contentAr).toBe("إيه مجال شركتك؟");
    expect(missions(db)).toHaveLength(0);
  });
  it("the customer's answer resolves it: the next ready brief becomes ONE mission, no duplicate", async () => {
    scripted([
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "معلومات عن منافسين شركتي", content: ["companies"], objectives: [o("o1", "companies.discover")] }) },
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "شركات السياحة المنافسة في الغردقة", content: ["companies"], topic: "شركات السياحة", country: "الغردقة", objectives: [o("o1", "companies.discover", { what: "شركات سياحة منافسة" })] }) },
    ]);
    const db = world();
    await turn(db, D2);
    expect(missions(db)).toHaveLength(0);
    const r = await turn(db, "شركة سياحة في الغردقة");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
  });
  it("a business described in the SAME message is not asked", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "شركات السياحة المنافسة في الغردقة", content: ["companies"], topic: "شركات السياحة", country: "الغردقة", objectives: [o("o1", "companies.discover")] }) }]);
    const db = world();
    const r = await turn(db, "عايز أعرف منافسين شركتي، إحنا شركة سياحة في الغردقة");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
  });
  it("English: «my company's competitors» is asked too", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "competitors of my company", content: ["companies"], objectives: [o("o1", "companies.discover")] }) }]);
    const db = world();
    const r = await turn(db, "I want data about the competitors of my company");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toBe(selfReferenceQuestionAr("company"));
    expect(missions(db)).toHaveLength(0);
  });
  it("inside a multi-part request only the own-business part is asked; the other parts are prepared", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({
      request: "منافسين شركتي، وآخر أخبار السياحة في مصر", content: ["companies", "articles"],
      objectives: [o("o1", "companies.discover", { request: "شركات منافسة لشركتي", what: "منافسين شركتي" }), o("o2", "web.search", { request: "آخر أخبار السياحة في مصر", what: "أخبار السياحة" })],
    }) }]);
    const db = world();
    const r = await turn(db, "عايز منافسين شركتي، وآخر أخبار السياحة في مصر");
    expect(live(db)).toHaveLength(1);
    expect(live(db)[0].request_text).toContain("أخبار السياحة");
    expect(r.contentAr).toContain(selfReferenceQuestionAr("company"));
  });
});

describe("selfReference: precise, never a false question on research about OTHER businesses", () => {
  it.each([
    ["منافسين شركتي", "company"], ["رأي الناس في البراند بتاعنا", "brand"], ["تقييمات مطعمي على جوجل", "venue"], ["تعليقات الناس على صفحتي في فيسبوك", "account"],
    ["what people say about our brand", "brand"], ["reviews of my restaurant", "venue"], ["3ayez a3raf mona7sin sherkety", "company"],
  ])("%s → %s", (text, kind) => expect(selfReferenceOf(text)).toBe(kind));
  it.each([
    "عايز أعرف الناس بتقول إيه عن سامسونج", "عايز شركات سياحة في الغردقة وإيميلاتها", "بيانات منتجي الأفلام في مصر", "نسبة الإشغال في القطاع الفندقي", "تعليقات تيك توك مع متوسط حسابي للإعجابات",
    "عايز تقييمات فنادق الغردقة", "هات آخر أخبار شركات الاتصالات", "comments about company layoffs",
  ])("%s → null", (text) => expect(selfReferenceOf(text)).toBeNull());
  it("resolved by identification in the same turn or by any later turn", () => {
    expect(selfReferenceUnresolved(["منافسين شركتي"])).toBe("company");
    expect(selfReferenceUnresolved(["منافسين شركتي", "سياحة في الغردقة"])).toBeNull();
    expect(selfReferenceUnresolved(["منافسين شركتي اسمها النيل للسياحة"])).toBeNull();
    expect(selfReferenceUnresolved(["تقييمات مطعمي", "رابطه www.example-food.com"])).toBeNull();
    expect(selfReferenceUnresolved(["تعليقات تيك توك عن السياحة", "وكمان تعليقات على صفحتي"])).toBe("account");
    expect(selfReferenceUnresolved(["تعليقات تيك توك عن السياحة"])).toBeNull();
  });
});

describe("D2, round 51 (real model): an EMPTY brief on «منافسين شركتي» asks which company, not which platform", () => {
  it("schema_request_missing → the own-business question", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ status: "needs_clarification", request: "" }) }]);
    const db = world();
    const r = await turn(db, D2);
    expect(r.contentAr).toBe(selfReferenceQuestionAr("company"));
    expect(missions(db)).toHaveLength(0);
  });
});

import { buildCapabilityRegistry as buildRegistry, discoverCapabilities as discover, researchNeedOf as needOf } from "../src/lib/agentMission/capabilities";
import { loadTregCatalog as loadCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason as blocked } from "../src/lib/treg/blockList";
import { policyVerdict as verdict } from "../src/lib/treg/dataPolicy";

describe("APP REVIEWS ACROSS PROVIDERS (round 51): an app is found in its store, and its reviews read by any provider that serves them", () => {
  const reg = () => buildRegistry(loadCatalog(), { isAllowed: (id) => !blocked(id) && verdict(id, null).allowed, webKeys: { firecrawl: true, contextdev: true } });
  const fam = (id: string) => (id.startsWith("contextdev.") ? "contextdev" : id.startsWith("firecrawl.") ? "firecrawl" : "treg");
  it.each([
    ["عايز تقييمات تطبيق إنستاباي على جوجل بلاي", "google_play"],
    ["هات ريفيوهات أبلكيشن طلبات على الآب ستور", "app_store"],
    ["reviews of the Fawry app on Google Play", "google_play"],
  ])("%s → apps.discover → apps.reviews on %s, review sources from two provider families", (request, store) => {
    const d = discover(needOf({ request }), reg());
    expect(d.status).toBe("supported");
    expect(d.stages.map((s) => [s.stage.operation, s.stage.platform, s.stage.parentKey])).toEqual([["apps.discover", store, null], ["apps.reviews", store, "apps"]]);
    expect(d.stages[0].eligible.length).toBeGreaterThan(0);
    expect(new Set(d.stages[1].eligible.map((e) => fam(e.id)))).toEqual(new Set(["treg", "contextdev"]));
  });
  it("no store named: both stores' capabilities are candidates", () => {
    const d = discover(needOf({ request: "تقييمات تطبيقات البنوك المصرية" }), reg());
    expect(d.need.kind).toBe("apps");
    expect(new Set(d.stages[1].eligible.map((e) => e.id))).toEqual(new Set(["contextdev.parse.app-store-reviews", "contextdev.parse.google-play-reviews", "litescrape.google_play.reviews", "litescrape.app_store.reviews"]));
  });
  it("«تطبيق» meaning «applying» a law stays news; hotel reviews stay places", () => {
    expect(needOf({ request: "أخبار تطبيق قانون الإيجار القديم" }).kind).toBe("web");
    expect(needOf({ request: "عايز تقييمات فنادق الغردقة" }).kind).toBe("places");
    expect(needOf({ request: "تعليقات تيك توك عن تطبيق إنستاباي" }).kind).toBe("social");
  });
  it("chat: the model's app objectives become ONE mission (no unsupported answer, no provider named)", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تقييمات تطبيق إنستاباي على جوجل بلاي", content: ["reviews"], topic: "إنستاباي", objectives: [o("o1", "apps.discover", { what: "تطبيق إنستاباي" }), o("o2", "apps.reviews", { parent: "o1" })] }) }]);
    const db = world();
    const r = await turn(db, "عايز تقييمات تطبيق إنستاباي على جوجل بلاي");
    expect(r.ok).toBe(true);
    expect(live(db)).toHaveLength(1);
    expect(r.contentAr).not.toMatch(/treg|firecrawl|context|litescrape|serpapi/i);
  });
  it("chat: app reviews as one part of a multi-part request keep their own part", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({
      request: "تقييمات تطبيق فوري على جوجل بلاي، وآخر أخبار المدفوعات الرقمية في مصر", content: ["reviews", "articles"],
      objectives: [o("o1", "apps.discover", { request: "تقييمات تطبيق فوري على جوجل بلاي" }), o("o2", "apps.reviews", { parent: "o1" }), o("o3", "web.search", { request: "آخر أخبار المدفوعات الرقمية في مصر" })],
    }) }]);
    const db = world();
    await turn(db, "عايز تقييمات تطبيق فوري على جوجل بلاي، وآخر أخبار المدفوعات الرقمية في مصر");
    expect(live(db)).toHaveLength(2);
  });
});

describe("round 51: «apps» alone is not an app-store request", () => {
  it("an opinion question about apps keeps its reading; app reviews in English are apps", () => {
    expect(needOf({ request: "What do people think about mental health apps?" }).kind).not.toBe("apps");
    expect(needOf({ request: "reviews of banking apps in Egypt" }).kind).toBe("apps");
  });
});

import { buildAsk as askOf } from "../src/lib/agentMission/foundation/ask";
import { privacyRefusalAr as refusal } from "../src/lib/agentMission/guardRules";
import { isContinueWord, CONTINUE_READY_AR, PLAN_NOT_READY_AR } from "../src/lib/agentMission/chatTurn";

describe("round 51: periods the contract reads as ASKED now have a value (they were not executed)", () => {
  const AT = Date.parse("2026-11-12T09:00:00Z");
  const p = (t: string) => askOf(t, null, AT).period;
  it.each([
    ["تغريدات إكس عن أزمة المياه خلال الأسبوع الماضي", "2026-11-05", "2026-11-12"],
    ["تعليقات تيك توك عن الأهلي الأسبوع اللي فات", "2026-11-05", "2026-11-12"],
    ["أخبار السياحة السنة اللي فاتت", "2025-01-01", "2025-12-31"],
    ["منشورات فيسبوك عن الدوري العام الماضي", "2025-01-01", "2025-12-31"],
    ["تعليقات يوتيوب عن العاصمة الإدارية الشهر ده", "2026-11-01", "2026-11-12"],
    ["مقالات عن الاقتصاد هذا العام", "2026-01-01", "2026-11-12"],
    ["Find public news articles about electric cars in Egypt from the last month", "2026-10-12", "2026-11-12"],
    ["tiktok comments about Ahly from the past 2 weeks", "2026-10-29", "2026-11-12"],
    ["posts from the last 24 hours", "2026-11-11", "2026-11-12"],
    ["news this year", "2026-01-01", "2026-11-12"],
  ])("%s → %s .. %s", (t, from, to) => expect(p(t)).toMatchObject({ from, to }));
  it("unchanged: آخر شهر, الشهر الماضي, no period, and a newspaper named «اليوم السابع»", () => {
    expect(p("آخر شهر")).toMatchObject({ from: "2026-10-12", to: "2026-11-12" });
    expect(p("الشهر الماضي")).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(p("تعليقات تيك توك عن السياحة")).toBeNull();
    expect(p("أخبار اليوم السابع عن الانتخابات")).toBeNull();
    expect(p("the past few days of comments")).toBeNull();
  });
});

describe("round 51: a person's personal address is refused by code, before any model call", () => {
  it("Arabic «العنوان الشخصي» joins «عنوان السكن / البيت»", () => {
    expect(refusal("عايز العنوان الشخصي لمذيعة مشهورة")).not.toBeNull();
    expect(refusal("هات العناوين الشخصية للاعبين")).not.toBeNull();
    expect(refusal("عايز عناوين فروع شركة فودافون")).toBeNull();
  });
});

describe("round 51: «كمّل» continues the research conversation whatever type the model gave it", () => {
  it("continuation words", () => {
    for (const w of ["كمّل", "كمل.", "تمام", "يلا", "continue", "ok", "kammel"]) expect(isContinueWord(w), w).toBe(true);
    for (const w of ["كمّل الطلب بتاع تيك توك وزود ١٠٠", "تمام بس خليها ٢٠٠", "عايز تعليقات"]) expect(isContinueWord(w), w).toBe(false);
  });
  it("a single request being prepared: «كمّل» read as small talk keeps it, says so, creates nothing", async () => {
    scripted([
      { type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({ request: "تعليقات إنستجرام عن الموضة المحتشمة في مصر", platforms: ["instagram"], content: ["comments"], topic: "الموضة المحتشمة", objectives: [o("o1", "social.parents", { platform: "instagram" }), o("o2", "social.comments", { platform: "instagram", parent: "o1" })] }) },
      { type: "greeting_or_small_talk", reason: "x", reply: "تمام، تحب طلب جديد ولا تعديل؟", count: null },
    ]);
    const db = world();
    await turn(db, "عايز تعليقات إنستجرام عن الموضة المحتشمة في مصر");
    expect(live(db)).toHaveLength(1);
    const r = await turn(db, "كمّل");
    expect([PLAN_NOT_READY_AR, CONTINUE_READY_AR]).toContain(r.contentAr);
    expect(live(db)).toHaveLength(1);
    expect(lastLog()?.brief).toMatch(/^continue_open_/);
  });
});

describe("round 51 (real model, M5): an open question is not split into sources the customer never named", () => {
  it("«What do people think about mental health apps?» read as app reviews + web pages: asked, no mission", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({
      request: "User reviews of mental health apps, and web articles about them", content: ["reviews", "articles"],
      objectives: [o("o1", "apps.discover", { request: "User reviews of mental health apps from app stores" }), o("o2", "apps.reviews", { parent: "o1" }), o("o3", "web.search", { request: "Web articles about mental health apps" })],
    }) }]);
    const db = world();
    const r = await turn(db, "What do people think about mental health apps?");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toMatch(/[؟?]/);
    expect(missions(db)).toHaveLength(0);
    expect(lastLog()?.brief).toBe("clarify_unnamed_parts");
  });
  it("a request whose words NAME the kinds keeps its parts", async () => {
    scripted([{ type: "data_request", reason: "x", reply: "", count: null, brief: briefOf({
      request: "تقييمات تطبيق فوري على جوجل بلاي، وآخر أخبار المدفوعات الرقمية في مصر", content: ["reviews", "articles"],
      objectives: [o("o1", "apps.discover", { request: "تقييمات تطبيق فوري على جوجل بلاي" }), o("o2", "apps.reviews", { parent: "o1" }), o("o3", "web.search", { request: "آخر أخبار المدفوعات الرقمية في مصر" })],
    }) }]);
    const db = world();
    await turn(db, "عايز تقييمات تطبيق فوري على جوجل بلاي، وآخر أخبار المدفوعات الرقمية في مصر");
    expect(live(db)).toHaveLength(2);
  });
});
