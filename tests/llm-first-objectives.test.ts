import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { assertReplayInvariants, replay, REPLAY_USER } from "./helpers/agentReplay";
import { callIds, lastOutputId, type Results } from "./helpers/agentFakeWorld";
import { fakeContextDev, mapsPlace, mapsReviews } from "./helpers/fakeContextDev";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR, AGENT_TURN_CONTENT_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { OBJECTIVE_OPERATIONS, parseBrief, validateBrief, type ResearchBrief } from "../src/lib/agentMission/researchBrief";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { toolProfile } from "../src/lib/agentMission/toolProfile";
import { PARSERS, WEB_SOURCES } from "../src/lib/agentMission/sources";
import {
  buildCapabilityRegistry, capabilitySelectionOf, CAPABILITY_DISCOVERY_FLAG_KEY, discoverCapabilities, OPERATIONS, operationOfCapability, researchNeedOf, scopeAnchorBody, scopeAnchorOf, SCOPE_ANCHOR_FOLDER, stagesOfNeed, UNRESOLVED_AR, validateCapabilityChoice,
  verifyApprovedScope, type CapabilityDiscovery, type CapabilityRegistry,
} from "../src/lib/agentMission/capabilities";
import { capabilityAnchorOf, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { updateRunState } from "../agent/src/runState";
import { fakeRecorder, NOT_ADMIN } from "./helpers/agentHarness";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * LLM-FIRST RESEARCH INTENT → VERIFIED CAPABILITIES (docs/LLM-FIRST-OBJECTIVES.md), OFFLINE. The chat model is SCRIPTED (the real one-line JSON format, the real `agentChatTurn`), the worker is the real `runPlanning` / `runExecution` with a
 * fake planning model and fake Context.dev answers, the money functions are the existing fakes. NO network, NO paid call, NO key: these tests prove what the backend does with what a model writes; they do NOT prove what a real model writes.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
const registry = (): CapabilityRegistry => buildCapabilityRegistry(catalog, { isAllowed: allowed });
type Obj = { id: string; operation: string; platform?: string | null; parent?: string | null; contacts?: string[]; what?: string };
const obj = (id: string, operation: string, o: Partial<Obj> = {}): Obj => ({ id, operation, platform: null, parent: null, contacts: [], what: "", ...o });
const briefOf = (o: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...o });
/** The brief exactly as the chat validates it (schema, then the conversation). */
function validated(raw: Record<string, unknown>, customerTurns: string[]): ResearchBrief {
  const p = parseBrief(briefOf(raw));
  if (!p.ok) throw new Error(`schema: ${p.issue}`);
  const v = validateBrief(p.brief, { customerTurns });
  if (!v.ok) throw new Error(`rejected: ${v.reason}`);
  return v.brief;
}
const discoverBrief = (b: ResearchBrief, reg = registry()): CapabilityDiscovery => discoverCapabilities(researchNeedOf({ request: b.request, brief: b }), reg);
const shape = (d: CapabilityDiscovery) => d.stages.map((s) => [s.stage.key, s.stage.operation, s.stage.platform, s.stage.parentKey]);

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE CHAT, scripted model
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const USER = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
let modelCalls: ChatModelInput[] = [];
function scripted(steps: Array<Record<string, unknown>>) {
  modelCalls = [];
  const script = [...steps];
  setChatModelForTesting(async (input) => {
    modelCalls.push(input);
    const s = script.shift();
    if (!s) return { ok: false, failure: "http_529" };
    return { ok: true, text: JSON.stringify(s), usage: { inputTokens: 1500, outputTokens: 260 } };
  });
}
const say = (brief: Record<string, unknown>, reply = "", type = "data_request") => ({ type, reason: "scripted", reply, count: null, brief: briefOf(brief) });
function chatWorld() {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER] } }]);
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const at = Date.parse("2026-11-12T09:00:00Z") + seq * 2000;
  db.seed("messages", [
    { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
  ]);
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  return { r, assistant: db.rows("messages").find((m: any) => m.id === `a${seq}`) };
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
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

// the goals of the mission's examples, as the model writes them
const PLACES_REVIEWS = [obj("o1", "places.discover"), obj("o2", "places.reviews", { parent: "o1" })];
const COMPANY_CONTACTS = [obj("o1", "companies.discover"), obj("o2", "company.contacts", { parent: "o1", contacts: ["email", "phone"] }), obj("o3", "people.discover", { parent: "o1" })];

describe("1. the model's objectives are the primary reading and map to real capabilities", () => {
  it("the objective vocabulary is exactly the registry's operations (plus «unsupported», which is never executed)", () => {
    expect(OBJECTIVE_OPERATIONS.filter((o) => o !== "unsupported")).toEqual([...OPERATIONS]);
  });

  it("each kind of research goal (social conversations, companies and official contacts, public professionals, places and reviews, public articles) becomes stages served by real capabilities of the three providers", () => {
    const cases: Array<{ request: string; raw: Record<string, unknown>; ops: string[]; providers: string[] }> = [
      { request: "هات تعليقات تيك توك عن السياحة", raw: { request: "هات تعليقات تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], objectives: [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }, ops: ["social.parents", "social.comments"], providers: ["treg"] },
      { request: "عايز شركات مقاولات في مصر وإيميلات وأرقام الشغل الرسمية بتاعتها والمديرين فيها", raw: { request: "عايز شركات مقاولات في مصر وإيميلات وأرقام الشغل الرسمية بتاعتها والمديرين فيها", objectives: COMPANY_CONTACTS }, ops: ["companies.discover", "company.contacts", "company.contacts", "people.discover"], providers: ["treg", "contextdev"] },
      { request: "مين أهم الناس في مجال التسويق الرقمي في دبي", raw: { request: "مين أهم الناس في مجال التسويق الرقمي في دبي", objectives: [obj("o1", "people.discover")] }, ops: ["people.discover"], providers: ["treg", "contextdev"] },
      { request: "الناس كاتبة إيه عن تجربتها في شاليهات الساحل", raw: { request: "الناس كاتبة إيه عن تجربتها في شاليهات الساحل", objectives: PLACES_REVIEWS }, ops: ["places.discover", "places.reviews"], providers: ["treg", "contextdev"] },
      { request: "اجمعلي اللي اتكتب في الصحافة عن السياحة في مصر", raw: { request: "اجمعلي اللي اتكتب في الصحافة عن السياحة في مصر", objectives: [obj("o1", "web.search"), obj("o2", "web.read", { parent: "o1" })] }, ops: ["web.search", "web.read"], providers: ["treg", "firecrawl", "contextdev"] },
    ];
    for (const c of cases) {
      const b = validated(c.raw, [c.request]);
      const d = discoverBrief(b);
      expect(d.need.source, c.request).toBe("objectives");
      expect(d.status, c.request).toBe("supported");
      expect(d.stages.map((s) => s.stage.operation), c.request).toEqual(c.ops);
      for (const s of d.stages) {
        expect(s.selected, `${c.request} ${s.stage.key}`).not.toBeNull();
        // every eligible capability performs the stage's operation, from a provider that exists
        for (const e of s.eligible) expect(c.providers.concat(["treg", "firecrawl", "contextdev"])).toContain(e.provider);
      }
      expect(new Set(d.stages.flatMap((s) => s.eligible.map((e) => e.provider))).size).toBeGreaterThan(0);
    }
  });

  it("provider inputs match the actual catalog schemas: every validated TREG capability is a real catalog endpoint of that operation whose documented inputs take what the stage is fed with; every web capability is a documented source", () => {
    const webIds = new Set([...Object.values(PARSERS).map((p) => p.id), ...WEB_SOURCES.map((w) => w.id)]);
    const oracle: Record<string, RegExp> = { post_ref: /id|code|url|post|video|urn/i, comment_ref: /comment|cid/i, place_ref: /place|cid|data_?id|fid|business|location/i, domain: /domain|website|company/i, url: /url|link|target/i };
    const briefs = [
      validated({ request: "هات تعليقات وردود تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments", "replies"], objectives: [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" }), obj("o3", "social.replies", { platform: "tiktok", parent: "o2" })] }, ["هات تعليقات وردود تيك توك عن السياحة"]),
      validated({ request: "شركات مقاولات وإيميلاتها وتليفوناتها ومديرينها", objectives: COMPANY_CONTACTS }, ["شركات مقاولات وإيميلاتها وتليفوناتها ومديرينها"]),
      validated({ request: "تقييمات فنادق شرم", objectives: PLACES_REVIEWS }, ["تقييمات فنادق شرم"]),
      validated({ request: "مقالات عن السياحة", objectives: [obj("o1", "web.search"), obj("o2", "web.read", { parent: "o1" })] }, ["مقالات عن السياحة"]),
    ];
    let checked = 0;
    for (const b of briefs) {
      const d = discoverBrief(b);
      for (const s of d.stages) {
        const parent = s.stage.parentKey ? d.stages.find((x) => x.stage.key === s.stage.parentKey)! : null;
        for (const e of s.eligible.slice(0, 5)) {
          if (e.provider !== "treg") { expect(webIds.has(e.id), e.id).toBe(true); continue; }
          const entry = catalog.byId.get(e.id)!;
          expect(entry, e.id).toBeTruthy();
          expect(operationOfCapability(entry.capability), e.id).toBe(s.stage.operation);
          if (!parent) {
            // a first stage is fed with the customer's topic: the endpoint has a query input (or, for a routed search, no input of its own)
            expect(toolProfile(entry).query !== null || entry.inputs.length === 0 || ["companies.discover", "people.discover", "places.discover"].includes(s.stage.operation), e.id).toBe(true);
          } else {
            const fed = e.takes.filter((t) => s.stage.accepts.includes(t) && t !== "query");
            expect(fed.length, e.id).toBeGreaterThan(0);
            // the documented input parameter that receives the parent's field exists in the catalog
            expect(fed.some((t) => entry.inputs.some((i) => oracle[t]?.test(i.name))), `${e.id} ${fed.join("/")} ${entry.inputs.map((i) => i.name).join(",")}`).toBe(true);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe("2. different natural phrasings, one goal", () => {
  chatHooks();
  const PHRASINGS = [
    "عايز تقييمات الفنادق في شرم الشيخ",
    "الناس بتقول إيه عن تجربتها في الإقامة في شرم؟",
    "what do guests write about their stay in Sharm resorts",
  ];
  it("three phrasings the model reads as the same objectives give the same stages; the keyword reading alone does NOT see the same goal in all of them", async () => {
    const shapes: unknown[] = [];
    const keywordKinds: string[] = [];
    for (const text of PHRASINGS) {
      scripted([say({ request: text, objectives: PLACES_REVIEWS })]);
      const db = chatWorld();
      const { r } = await turn(db, text);
      expect(r, text).toMatchObject({ ok: true, contentAr: AGENT_TURN_CONTENT_AR });
      expect(modelCalls).toHaveLength(1);
      const stored = db.rows("messages").find((m: any) => m.plan?.agentMissionId)!.plan.researchBrief as ResearchBrief;
      expect(stored.objectives).toHaveLength(2);
      const d = discoverBrief(stored);
      expect(d.status).toBe("supported");
      shapes.push(shape(d));
      keywordKinds.push(researchNeedOf({ request: text }).kind);
    }
    expect(shapes[1]).toEqual(shapes[0]);
    expect(shapes[2]).toEqual(shapes[0]);
    expect(shapes[0]).toEqual([["places", "places.discover", null, null], ["place_reviews", "places.reviews", null, "places"]]);
    // the old keyword reading misses the goal in at least one phrasing: the model's reading is what carries it
    expect(keywordKinds.filter((k) => k === "places").length).toBeLessThan(PHRASINGS.length);
    // no provider was called by the chat
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a request the keyword reading cannot classify is NOT treated as unsupported when the model understood it: it becomes one mission", async () => {
    const text = "محتاج أعرف مين الجهات اللي بتورد خامات بناء في الإسكندرية وإزاي أتواصل معاهم رسميًا";
    expect(researchNeedOf({ request: text }).kind).not.toBe("companies");
    scripted([say({ request: text, objectives: [obj("o1", "companies.discover"), obj("o2", "company.contacts", { parent: "o1", contacts: ["email", "phone"] })] })]);
    const db = chatWorld();
    const { r } = await turn(db, text);
    expect(r).toMatchObject({ ok: true });
    expect(missions(db)).toHaveLength(1);
    expect(lastOutcome()).toBe("ready");
  });
});

describe("3. a mixed request keeps every objective", () => {
  chatHooks();
  it("social comments + hotel reviews + news articles: nothing is cut; every part is said; every objective stays in the brief; no provider call", async () => {
    const text = "عايز تعليقات تيك توك عن السياحة في مصر، وتقييمات الفنادق في الغردقة، ومقالات الأخبار عن الموسم";
    const objectives = [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" }), obj("o3", "places.discover"), obj("o4", "places.reviews", { parent: "o3" }), obj("o5", "web.search"), obj("o6", "web.read", { parent: "o5" })];
    scripted([say({ request: text, platforms: ["tiktok"], content: ["comments", "places", "reviews"], objectives })]);
    const db = chatWorld();
    const { r, assistant } = await turn(db, text);
    // (since docs/MULTI-OBJECTIVE-RESEARCH.md: no part is cut and the customer is never made to choose one; here the model wrote no sentence for each part, so each part is clarified, never guessed)
    expect(r.ok).toBe(false);
    for (const part of ["تعليقات تيك توك", "تقييمات الأماكن ونصوصها", "نصوص صفحات الويب العامة"]) expect(r.contentAr).toContain(part);
    expect(r.contentAr).toContain("محتاج توضيح بسيط");
    expect(missions(db)).toHaveLength(0);
    expect(assistant.plan.researchGroup.brief.status).toBe("needs_clarification");
    expect(assistant.plan.researchGroup.brief.objectives.map((o: Obj) => o.operation)).toEqual(objectives.map((o) => o.operation));
    expect(lastOutcome()).toBe("group_0_created_0_kept_0_cards_0_unsaved_3_other");
    expect(fetchSpy).not.toHaveBeenCalled();
    // the next turn's prompt carries the objectives so far (confirmed information is preserved)
    scripted([say({ request: "عايز تقييمات الفنادق في الغردقة", objectives: [obj("o3", "places.discover"), obj("o4", "places.reviews", { parent: "o3" })] })]);
    await turn(db, "نبدأ بالفنادق");
    expect(modelCalls[0].system).toContain("objectives: o1=social.parents/tiktok; o2=social.comments/tiktok<-o1; o3=places.discover; o4=places.reviews<-o3; o5=web.search; o6=web.read<-o5");
    expect(missions(db)).toHaveLength(1);
  });

  it("companies with their official contacts AND public articles (two kinds, no social data): ONE request whose discovery keeps both chains", () => {
    const text = "عايز شركات الطاقة الشمسية في مصر وإيميلاتها الرسمية، ومقالات عن السوق";
    const b = validated({ request: text, objectives: [obj("o1", "companies.discover"), obj("o2", "company.contacts", { parent: "o1", contacts: ["email"] }), obj("o3", "web.search"), obj("o4", "web.read", { parent: "o3" })] }, [text]);
    const d = discoverBrief(b);
    expect(d.need.kind).toBe("mixed");
    expect(d.status).toBe("supported");
    expect(shape(d)).toEqual([["companies", "companies.discover", null, null], ["company_emails", "company.contacts", null, "companies"], ["web_results", "web.search", null, null], ["web_pages", "web.read", null, "web_results"]]);
  });

  it("the model may write a child alone: the chain step it needs is added by code (comments are read from posts), never a new goal", () => {
    const b = validated({ request: "هات ردود الناس على تعليقات إنستجرام عن مطاعم القاهرة", platforms: ["instagram"], content: ["comments", "replies"], objectives: [obj("o1", "social.comments", { platform: "instagram" }), obj("o2", "social.replies", { platform: "instagram", parent: "o1" })] }, ["هات ردود الناس على تعليقات إنستجرام عن مطاعم القاهرة"]);
    expect(stagesOfNeed(researchNeedOf({ request: b.request, brief: b })).map((s) => [s.key, s.parentKey])).toEqual([["instagram_parents", null], ["instagram_comments", "instagram_parents"], ["instagram_replies", "instagram_comments"]]);
  });
});

describe("4. a goal no capability serves is clarified usefully, never guessed and never «unsupported» by a missing keyword", () => {
  chatHooks();
  it("an objective the model marks «unsupported» (website traffic numbers): an honest question with what can be collected now; no mission", async () => {
    const text = "عايز أعرف عدد الزوار الشهري لمواقع منافسيني";
    scripted([say({ request: text, objectives: [obj("o1", "unsupported", { what: "عدد زوار مواقع المنافسين" })] })]);
    const db = chatWorld();
    const { r, assistant } = await turn(db, text);
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain(UNRESOLVED_AR);
    expect(r.contentAr).toContain("المتاح الآن مثلًا");
    expect(r.contentAr).toContain("أي نوع منها يخدم هدفك؟");
    expect(missions(db)).toHaveLength(0);
    expect(assistant.plan.researchBrief.status).toBe("needs_clarification");
    expect(lastOutcome()).toBe("objectives_unresolved_ask");
  });

  it("a served goal joined with an unserved one (TikTok comments + Snapchat stories): the served part is offered, the other is said honestly, nothing silently dropped; no mission", async () => {
    const text = "عايز تعليقات تيك توك وستوريز سناب شات عن الموضة";
    scripted([say({ request: "عايز تعليقات تيك توك عن الموضة", platforms: ["tiktok"], content: ["comments"], objectives: [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" }), obj("o3", "social.parents", { platform: "snapchat" })] })]);
    const db = chatWorld();
    const { r } = await turn(db, text);
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain("سناب شات");
    expect(r.contentAr).toContain("تعليقات تيك توك");
    expect(missions(db)).toHaveLength(0);
    expect(lastOutcome()).toBe("group_0_created_0_kept_0_cards_0_unsaved_2_other");
  });

  it("Snapchat alone: honest limitation and a served alternative, no mission", async () => {
    const text = "هات ستوريز سناب شات عن الموضة";
    scripted([say({ request: text, objectives: [obj("o1", "social.parents", { platform: "snapchat" })] })]);
    const db = chatWorld();
    const { r } = await turn(db, text);
    expect(r.contentAr).toContain("سناب شات ليست من المصادر");
    expect(missions(db)).toHaveLength(0);
  });

  it("a typed «موافق» after a question approves nothing", async () => {
    const db = chatWorld();
    scripted([]);
    const { r } = await turn(db, "موافق");
    expect(r).toMatchObject({ ok: false, contentAr: AGENT_PRESS_APPROVE_AR });
    expect(missions(db)).toHaveLength(0);
  });
});

describe("5. invalid model selections are rejected", () => {
  chatHooks();
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["an operation outside the vocabulary", { request: "هات رسائل تيك توك عن السياحة", platforms: ["tiktok"], objectives: [obj("o1", "social.dms", { platform: "tiktok" })] }, "schema_objectives"],
    ["an unknown field in an objective", { request: "هات تقييمات فنادق", objectives: [{ ...obj("o1", "places.discover"), endpoint: "google.maps.reviews" }] }, "schema_objectives"],
    ["reviews hung on companies", { request: "هات تقييمات شركات", objectives: [obj("o1", "companies.discover"), obj("o2", "places.reviews", { parent: "o1" })] }, "rejected_objectives_structure"],
    ["a platform the customer never named", { request: "هات تعليقات عن السياحة", objectives: [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" })] }, "rejected_objective_platform_not_named"],
    ["a content the objectives drop", { request: "هات تعليقات تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], objectives: [obj("o1", "social.parents", { platform: "tiktok" })] }, "rejected_objective_dropped"],
    ["contacts on a non-contact objective", { request: "هات شركات", objectives: [obj("o1", "companies.discover", { contacts: ["email"] })] }, "rejected_objectives_structure"],
  ];
  for (const [name, raw, outcome] of cases) {
    it(`${name}: the objectives are never used (the brief falls back to today's path)`, async () => {
      scripted([say(raw)]);
      const db = chatWorld();
      await turn(db, String(raw.request));
      expect(lastOutcome()).toBe(outcome);
      // whatever today's path did, no stored brief carries these objectives
      for (const m of db.rows("messages")) expect(m.plan?.researchBrief?.objectives).toBeUndefined();
    });
  }

  it("a private goal written in an objective is refused like a typed one", async () => {
    scripted([say({ request: "هات شركات مقاولات في مصر", objectives: [obj("o1", "companies.discover", { what: "أرقام موبايلات العملاء الشخصية" })] })]);
    const db = chatWorld();
    const { r } = await turn(db, "هات شركات مقاولات في مصر");
    expect(r.ok).toBe(false);
    expect(missions(db)).toHaveLength(0);
    expect(lastOutcome()).toBe("rejected_privacy_refusal");
  });

  it("a capability a model recommends for an objective-derived stage is accepted only from that stage's validated candidates", () => {
    const d = discoverBrief(validated({ request: "تقييمات فنادق شرم", objectives: PLACES_REVIEWS }, ["تقييمات فنادق شرم"]));
    const reviews = d.stages.find((s) => s.stage.operation === "places.reviews")!;
    expect(validateCapabilityChoice(d, reviews.stage.key, reviews.selected!)).toEqual({ ok: true });
    expect(validateCapabilityChoice(d, reviews.stage.key, d.stages[0].selected!)).toEqual({ ok: false, reason: "not_a_candidate" });
    expect(validateCapabilityChoice(d, reviews.stage.key, "aviato.people.email.find.personal", catalog)).toEqual({ ok: false, reason: "private_data" });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE WORKER
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const WHY = "the planner sampled the validated capability it ranks first for these fields";
const lastRows = (r: Results) => (r.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3);
/** A request the keyword reading cannot classify (no place word, no review word): only the model's objectives say «places and their reviews». */
const NO_KEYWORD_REQUEST = "عايز ٢٠٠ حاجة كتبها الناس عن تجربتهم في أبو طارق بالقاهرة على الخرايط";
function objectiveReplay(o: { workerFlag?: boolean; chatObjectives?: boolean; request?: string; beforeApproval?: Parameters<typeof replay>[0]["beforeApproval"]; prompts?: string[] } = {}) {
  const request = o.request ?? NO_KEYWORD_REQUEST;
  const web = fakeContextDev({ parse: (parser, _url, body) => (parser === "google-maps" ? { data: mapsPlace("مطعم أبو طارق"), credits: 1 } : { data: mapsReviews(body.parseParams.limit), credits: 1 }) });
  const SEARCH = "https://www.google.com/maps/search/%D9%85%D8%B7%D8%B9%D9%85+%D8%A3%D8%A8%D9%88+%D8%B7%D8%A7%D8%B1%D9%82+%D8%A7%D9%84%D9%82%D8%A7%D9%87%D8%B1%D8%A9/";
  const PLACE = "https://www.google.com/maps/place/?q=place_id:ChIJplace0001";
  const workerFlag = o.workerFlag !== false;
  return replay({
    request,
    web,
    makeStore: () => { const s = createMemoryStore(); if (workerFlag) Object.assign(s.settings, { [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] } }); return s; },
    beforeChat: (db) => {
      if (o.chatObjectives === false) return;
      db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [REPLAY_USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [REPLAY_USER] } }]);
      scripted([say({ request, count: 200, objectives: PLACES_REVIEWS })]);
    },
    ...(o.prompts ? { deps: (base: RunnerDeps): RunnerDeps => ({ ...base, driver: { run: async (i: Parameters<RunnerDeps["driver"]["run"]>[0]) => { o.prompts!.push(i.userPrompt); return base.driver.run(i); } } as RunnerDeps["driver"] }) } : {}),
    ...(o.beforeApproval ? { beforeApproval: o.beforeApproval } : {}),
      planning: [
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH, why: WHY } },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 100, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق بنص كل تقييم ودرجته وتاريخه.",
          stages: [
            { key: "place", title_ar: "المكان", endpoint_id: "contextdev.parse.google-maps", expected_rows: 1, parent_key: null, deliver: false, columns: [{ key: "name", title_ar: "اسم المكان" }, { key: "url", title_ar: "رابط المكان" }], sample_rows: lastRows(res).slice(0, 1), measured_by: [callIds(res)[0]] },
            { key: "reviews", title_ar: "التقييمات", endpoint_id: "contextdev.parse.google-maps-reviews", expected_rows: 200, parent_key: "place", per_parent_rows: 200, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "date", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }, { key: "writer", title_ar: "الكاتب" }, { key: "page_link", title_ar: "الرابط" }], sample_rows: [{ id: "rv0", text: "تجربة رقم 0 في المكان", rating: 1, date: "2026-09-20T12:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }) },
      ],
      execution: () => [
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "place", from_output: lastOutputId(res) }) },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 200 } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(v => ({ id: v.id, parent_id: 'ChIJplace0001', text: v.snippet, rating: v.rating, date: v.isoDate }))", files: [callIds(res)[1]] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "reviews", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم ٢٠٠ تقييم للمكان المطلوب." } },
      ],
      answers: [],
  });
}

describe("6. the worker plans from the model's validated objectives, end to end (chat → brief → objectives → discovery → plan → approval → execution)", () => {
  afterEach(() => { setChatModelForTesting(null); vi.restoreAllMocks(); });
  it("a request the keyword reading would send to a clarifying card is planned from the objectives the chat validated: the planner sees the validated Maps capabilities; 200 reviews delivered with their place; the plan carries its record and the server's anchor", async () => {
    expect(researchNeedOf({ request: NO_KEYWORD_REQUEST }).kind).toBe("unknown");
    const prompts: string[] = [];
    const r = await objectiveReplay({ prompts });
    expect(prompts[0]).toContain("VALIDATED CAPABILITIES");
    expect(prompts[0]).toMatch(/stage place_reviews \(places\.reviews/);
    const rec = r.plannedPlan.capability_selection!;
    expect(rec.stages.map((s) => [s.stage_key, s.operation, s.source])).toEqual([["place", "places.discover", "discovery"], ["reviews", "places.reviews", "discovery"]]);
    expect(await capabilityAnchorOf(r.store, r.missionId)).toEqual({ required: true, digest: rec.digest });
    assertReplayInvariants(r, { expectDelivered: 200 });
    // no TREG call at all; the Context.dev calls before approval are the planner's own sampling calls (planning phase), the rest after approval
    expect(r.call).not.toHaveBeenCalled();
    expect(r.rec.rows.filter((x) => x.jobId === null).length).toBeGreaterThan(0);
  });

  it("legacy compatibility: the same customer with the switch OFF everywhere: no record, no anchor, the plan executes exactly as before", async () => {
    const r = await objectiveReplay({ workerFlag: false, chatObjectives: false, request: "عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة" });
    expect(r.plannedPlan.capability_selection).toBeUndefined();
    expect(await r.store.listFiles(r.missionId, SCOPE_ANCHOR_FOLDER)).toEqual([]);
    assertReplayInvariants(r, { expectDelivered: 200 });
  });
});

describe("7. approved plan integrity: a missing or replaced record cannot bypass the check of a plan that needs one", () => {
  afterEach(() => { setChatModelForTesting(null); vi.restoreAllMocks(); });
  const stripOrReplace = (mode: "strip" | "replace") => async ({ missionId, db, store }: { missionId: string; db: any; store: any }) => {
    const m = store.missions.get(missionId)!;
    const plan = JSON.parse(JSON.stringify(m.plan)) as PricedPlan;
    if (mode === "strip") delete plan.capability_selection;
    else {
      // a self-consistent record of ANOTHER scope (its own digest matches its own stages): only the server's anchor can tell
      const other = { ...plan, stages: plan.stages.map((s) => (s.key === "reviews" ? { ...s, endpoint_id: "contextdev.parse.google-maps" } : s)) };
      const d = discoverCapabilities(researchNeedOf({ request: NO_KEYWORD_REQUEST, brief: { platforms: [], content: [], count: 200, objectives: PLACES_REVIEWS as never } }), registry());
      plan.capability_selection = capabilitySelectionOf(other, d);
      plan.stages = other.stages;
    }
    m.plan = plan as never;
    const row = db.rows("missions").find((x: any) => x.id === missionId);
    if (row) row.plan = plan;
  };
  for (const mode of ["strip", "replace"] as const) {
    it(`${mode === "strip" ? "the record REMOVED" : "the record REPLACED by another self-consistent one"} after the plan was shown: never executed, no provider call, nothing delivered or charged, the hold released whole`, async () => {
      const r = await objectiveReplay({ beforeApproval: stripOrReplace(mode) });
      expect(r.executionDriver.results).toHaveLength(0);
      expect(r.rec.rows.filter((x) => x.jobId !== null)).toHaveLength(0);
      expect(Number(r.mission.delivered_units ?? 0)).toBe(0);
      expect(Number(r.mission.charged_points ?? 0)).toBe(0);
      expect(r.money.balance()).toBe(r.initialBalance);
      expect(String(r.mission.error)).toContain(mode === "strip" ? "selection_record_missing" : "selection_record_replaced");
    });
  }

  it("the anchor: absent → a plan without a record is a legacy plan; the latest anchor decides; an unreadable anchor still requires a record", async () => {
    const store = createMemoryStore();
    const id = "msn_anchor000001";
    expect(await capabilityAnchorOf(store, id)).toEqual({ required: false, digest: null });
    await store.putNewStrict(id, `${SCOPE_ANCHOR_FOLDER}/000000000000001_0.json`, scopeAnchorBody("0a1b2c3d"), "application/json");
    expect(await capabilityAnchorOf(store, id)).toEqual({ required: true, digest: "0a1b2c3d" });
    expect(verifyApprovedScope({ stages: [{ key: "a", endpoint_id: "x", parent_key: null }] }, catalog, await capabilityAnchorOf(store, id))).toEqual({ ok: false, issues: ["selection_record_missing"] });
    // a later planning made a plan without a record (the switch was turned off): the newest anchor says no record is required
    await store.putNewStrict(id, `${SCOPE_ANCHOR_FOLDER}/000000000000002_0.json`, scopeAnchorBody(null), "application/json");
    expect(await capabilityAnchorOf(store, id)).toEqual({ required: false, digest: null });
    expect(verifyApprovedScope({ stages: [{ key: "a", endpoint_id: "x", parent_key: null }] }, catalog, await capabilityAnchorOf(store, id))).toEqual({ ok: true, checked: false });
    expect(scopeAnchorOf("not json")).toEqual({ required: true, digest: null });
  });

  it("a re-planning with the switch OFF clears the anchor of an earlier discovery plan, so the new legacy plan stays executable", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const store = createMemoryStore();
    const id = "msn_anchor000002";
    store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: "عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة", status: "planning", created_at: "2026-11-12T09:00:00Z" }) as never);
    await store.putNewStrict(id, `${SCOPE_ANCHOR_FOLDER}/000000000000001_0.json`, scopeAnchorBody("0a1b2c3d"), "application/json");
    await updateRunState(store, id, (r) => ({ ...r, planningStarts: 1 }));
    const web = fakeContextDev({ parse: (parser, _url, body) => (parser === "google-maps" ? { data: mapsPlace("مطعم أبو طارق"), credits: 1 } : { data: mapsReviews(body.parseParams.limit), credits: 1 }) });
    const SEARCH = "https://www.google.com/maps/search/%D9%85%D8%B7%D8%B9%D9%85+%D8%A3%D8%A8%D9%88+%D8%B7%D8%A7%D8%B1%D9%82+%D8%A7%D9%84%D9%82%D8%A7%D9%87%D8%B1%D8%A9/";
    const PLACE = "https://www.google.com/maps/place/?q=place_id:ChIJplace0001";
    const planning = [
        { tool: "parse_page", args: { parser: "google-maps", url: SEARCH, why: WHY } },
        { tool: "parse_page", args: { parser: "google-maps-reviews", url: PLACE, sort: "newest", limit: 100, why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.slice(0, 1).map(p => ({ id: p.place_id, name: p.name, url: p.google_maps_url }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق بنص كل تقييم ودرجته وتاريخه.",
          stages: [
            { key: "place", title_ar: "المكان", endpoint_id: "contextdev.parse.google-maps", expected_rows: 1, parent_key: null, deliver: false, columns: [{ key: "name", title_ar: "اسم المكان" }, { key: "url", title_ar: "رابط المكان" }], sample_rows: lastRows(res).slice(0, 1), measured_by: [callIds(res)[0]] },
            { key: "reviews", title_ar: "التقييمات", endpoint_id: "contextdev.parse.google-maps-reviews", expected_rows: 200, parent_key: "place", per_parent_rows: 200, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }, { key: "rating", title_ar: "الدرجة" }, { key: "date", title_ar: "التاريخ" }, { key: "likes", title_ar: "الإعجابات" }, { key: "writer", title_ar: "الكاتب" }, { key: "page_link", title_ar: "الرابط" }], sample_rows: [{ id: "rv0", text: "تجربة رقم 0 في المكان", rating: 1, date: "2026-09-20T12:00:00Z" }], measured_by: [callIds(res)[1]] },
          ],
        }) },
      ];
    const rec = fakeRecorder({ dailyCapUsd: 5 });
    const deps: RunnerDeps = {
      store, client: {}, catalog, driver: createFakeDriver(planning), recorder: rec.recorder, commit: rec.commit, call: vi.fn() as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
      resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, providerKey: async () => "test-provider-key", fetchFn: web.fetchFn as never,
    };
    await runPlanning(deps, store.missions.get(id)!);
    vi.unstubAllGlobals();
    expect(store.missions.get(id)!.status).toBe("plan_ready");
    expect((store.missions.get(id)!.plan as PricedPlan).capability_selection).toBeUndefined();
    expect(await capabilityAnchorOf(store, id)).toEqual({ required: false, digest: null });
    expect(verifyApprovedScope(store.missions.get(id)!.plan as PricedPlan, catalog, await capabilityAnchorOf(store, id))).toEqual({ ok: true, checked: false });
  });
});

describe("8. the worker never cuts a mixed request and never calls a provider before asking", () => {
  it("social data + places in one mission reaching the social compiler: asked first (the other part is never silently cut); no provider call", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const store = createMemoryStore();
    Object.assign(store.settings, { [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] }, redesign_flags: { tiktok: "on" } });
    const id = "msn_mixed0000001";
    const request = "هات تعليقات تيك توك عن السياحة وتقييمات فنادق الغردقة";
    store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: request, status: "planning", created_at: "2026-11-12T09:00:00Z" }) as never);
    const call = vi.fn(async () => { throw new Error("no provider call is expected"); });
    const rec = fakeRecorder({ dailyCapUsd: 5 });
    const brief = validated({ request, platforms: ["tiktok"], content: ["comments", "reviews"], objectives: [obj("o1", "social.parents", { platform: "tiktok" }), obj("o2", "social.comments", { platform: "tiktok", parent: "o1" }), ...PLACES_REVIEWS.map((o) => ({ ...o, id: o.id === "o1" ? "o3" : "o4", parent: o.parent ? "o3" : null }))] }, [request]);
    const deps: RunnerDeps = {
      store, client: {}, catalog, driver: createFakeDriver([]), recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
      resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, readMissionBrief: async () => brief,
    };
    await runPlanning(deps, store.missions.get(id)!);
    vi.unstubAllGlobals();
    const m = store.missions.get(id)!;
    expect(m.status).toBe("needs_input");
    expect(String(m.question_ar)).toContain("تعليقات تيك توك");
    expect(String(m.question_ar)).toContain("تقييمات الأماكن ونصوصها");
    expect(m.plan).toBeFalsy();
    expect(call).not.toHaveBeenCalled();
    expect(rec.rows).toHaveLength(0);
  });

  it("objectives stored for OTHER words (not this mission's request) are never used: the words are read", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
    const store = createMemoryStore();
    Object.assign(store.settings, { [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] } });
    const id = "msn_otherwords01";
    store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: NO_KEYWORD_REQUEST, status: "planning", created_at: "2026-11-12T09:00:00Z" }) as never);
    const brief = validated({ request: "تقييمات فنادق شرم", objectives: PLACES_REVIEWS }, ["تقييمات فنادق شرم"]);
    const logs: string[] = [];
    const rec = fakeRecorder({ dailyCapUsd: 5 });
    const deps: RunnerDeps = {
      store, client: {}, catalog, driver: createFakeDriver([]), recorder: rec.recorder, commit: rec.commit, call: vi.fn() as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
      resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, readMissionBrief: async () => brief, log: (l) => logs.push(l),
    };
    await runPlanning(deps, store.missions.get(id)!);
    vi.unstubAllGlobals();
    // read from the words: nothing recognised by them, so the discovery is «needs_clarification» and the existing route decides (no provider call)
    expect(logs.find((l) => l.startsWith("capability_discovery"))).toContain("status=needs_clarification");
    expect(logs.find((l) => l.startsWith("capability_discovery"))).not.toContain("place_reviews");
    expect(rec.rows).toHaveLength(0);
  });
});
