import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { createMemoryStore } from "../agent/src/memoryStore";
import { runProductionPlanning } from "./helpers/productionPlanning";
import { M12 } from "./helpers/round14Missions";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { approvingReview, assertReplayInvariants, readWorkbook, replay, REPLAY_USER } from "./helpers/agentReplay";
import { callIds, companiesPage, employeesPage, lastOutputId, tregResult, type Results } from "./helpers/agentFakeWorld";
import { emailsOf, fakeContextDev, linksOf, mapsPlace, mapsReviews, phonesOf } from "./helpers/fakeContextDev";
import type { FakeStep } from "../agent/src/fakeDriver";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR, AGENT_TURN_CONTENT_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../src/lib/agentMission/chatTurn";
import { setChatModelForTesting, type ChatModelInput } from "../src/lib/agentMission/chatModel";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { PRIVACY_REFUSAL_AR } from "../src/lib/agentMission/guardRules";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import {
  buildCapabilityRegistry, capabilitySelectionOf, CAPABILITY_DISCOVERY_FLAG_KEY, planParamsDigest, resealCapabilitySelection, discoverCapabilities, plannerCapabilitySection, planStageIssues, readCapabilityDiscoveryFlag, researchNeedOf, validateCapabilityChoice, verifyApprovedScope,
  type CapabilityRegistry,
} from "../src/lib/agentMission/capabilities";
import { CAPABILITY_SCOPE_OPTIONS_AR, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { updateRunState } from "../agent/src/runState";
import { parseCatalog } from "../src/lib/treg/catalog";
import { newMission } from "../agent/src/memoryStore";
import { fakeRecorder, NOT_ADMIN } from "./helpers/agentHarness";
import type { PricedPlan } from "../src/lib/agentMission/plan";
import { editPlanForCustomer } from "../src/lib/agentMission/customerActions";
import { applyPlanEdits } from "../src/lib/agentMission/planEdit";

/**
 * UNIFIED REQUEST-TO-EXECUTION (docs/UNIFIED-CAPABILITY-DISCOVERY.md), OFFLINE. Each scenario goes through the real code paths: the chat turn (`agentChatTurn`, a SCRIPTED chat model in the real one-line JSON format), the worker's planning
 * (`runPlanning` with a fake planning model, or the compiled social path over stored live pages), the customer's approval (the existing money functions, faked with their arithmetic), the worker's execution and the settlement/delivery.
 * Providers are fakes (TREG answers handed out in call order, a fake Context.dev / Firecrawl fetch): NO network, NO paid call, NO key. These tests prove the backend's behaviour; they do NOT prove what a real model writes or what a live
 * provider returns.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
const registry = (o: Partial<Parameters<typeof buildCapabilityRegistry>[1]> = {}): CapabilityRegistry => buildCapabilityRegistry(catalog, { isAllowed: allowed, ...o });
const discover = (request: string, reg = registry()) => discoverCapabilities(researchNeedOf({ request }), reg);
const flagOn = (store: ReturnType<typeof createMemoryStore>, value: unknown = { user_ids: [REPLAY_USER] }) => { Object.assign(store.settings, { [CAPABILITY_DISCOVERY_FLAG_KEY]: value }); return store; };
const PROVIDER_WORDS = /treg|firecrawl|context\.?dev|crawl4ai|tikhub|anyapi|apify|endpoint|USD|\$/i;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE CHAT: a scripted model, the real turn
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const USER = "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
type Step = Record<string, unknown> | "fail" | ((input: ChatModelInput) => Record<string, unknown>);
let modelCalls: ChatModelInput[] = [];
let script: Step[] = [];
function scripted(steps: Step[]) {
  modelCalls = [];
  script = [...steps];
  setChatModelForTesting(async (input) => {
    modelCalls.push(input);
    const s = script.shift();
    if (s === undefined || s === "fail") return { ok: false, failure: "http_529" };
    const body = typeof s === "function" ? s(input) : s;
    return { ok: true, text: JSON.stringify(body), usage: { inputTokens: 1500, outputTokens: 220 } };
  });
}
const say = (type: string, brief: Record<string, unknown> | null, reply = "", count: number | null = null) => ({ type, reason: "scripted", reply, count, ...(brief ? { brief } : {}) });
const brief = (o: Record<string, unknown>) => ({ status: "ready", platforms: [], content: [], count: null, topic: "", period: "", country: "", language: "", ...o });
function chatWorld(capability: unknown = { user_ids: [USER] }) {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  db.seed("mission_events", []);
  db.seed("messages", []);
  db.seed("missions", []);
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }, ...(capability === null ? [] : [{ key: CAPABILITY_DISCOVERY_FLAG_KEY, value: capability }])]);
  return db;
}
let seq = 0;
async function turn(db: any, message: string) {
  seq += 1;
  const at = Date.parse("2026-11-11T09:00:00Z") + seq * 2000;
  db.seed("messages", [
    { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
    { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
  ]);
  const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
  return { r, assistant: db.rows("messages").find((m: any) => m.id === `a${seq}`) };
}
const missions = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
const live = (db: any) => missions(db).filter((m) => m.status !== "cancelled");
let infos: string[] = [];
const lastOutcome = () => { const line = [...infos].reverse().find((l) => l.includes("chat_message_type")); return line ? JSON.parse(line).brief : null; };

describe("the chat: LLM-led discovery grounded in the capabilities code found (scenarios 1, 2, 3, 8, 15)", () => {
  beforeEach(() => {
    infos = [];
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
    vi.spyOn(console, "info").mockImplementation((line: unknown) => { infos.push(String(line)); });
  });
  afterEach(() => { setChatModelForTesting(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("1. a vague request («عايز داتا عن السياحة في مصر») gets the model's own contextual question; the prompt carries the kinds of data code found available (no provider named); no mission; then the answer makes a valid brief and ONE mission", async () => {
    const q = "تحب نجمع إيه عن السياحة في مصر: آراء الناس وتعليقاتهم على المنصات، ولا شركات السياحة ومواقعها، ولا تقييمات الفنادق والأماكن؟";
    scripted([
      say("data_request", brief({ status: "needs_clarification", request: "عايز داتا عن السياحة في مصر", topic: "السياحة", country: "مصر" }), q),
      say("data_request", brief({ request: "هات تعليقات تيك توك عن السياحة في مصر", platforms: ["tiktok"], content: ["comments"], topic: "السياحة", country: "مصر" })),
    ]);
    const db = chatWorld();
    const first = await turn(db, "عايز داتا عن السياحة في مصر");
    expect(first.r).toMatchObject({ ok: false, contentAr: q });
    expect(missions(db)).toHaveLength(0);
    expect(first.assistant.plan.researchBrief).toMatchObject({ status: "needs_clarification" });
    // ONE model call; the capability lines are in its prompt, written by code from the registry: kinds of data, platforms, never a provider or a price
    expect(modelCalls).toHaveLength(1);
    const system = modelCalls[0].system;
    expect(system).toContain("أنواع البيانات العامة التي يقدر النظام يجمعها الآن");
    for (const kind of ["التعليقات: تيك توك، إكس، إنستجرام، فيسبوك، يوتيوب", "الشركات ومواقعها من مصادر الشركات العامة", "تقييمات الأماكن ونصوصها", "صفحات الويب العامة"]) expect(system).toContain(kind);
    expect(system.slice(system.indexOf("أنواع البيانات العامة"))).not.toMatch(PROVIDER_WORDS);
    expect(lastOutcome()).toBe("clarify");

    const second = await turn(db, "تعليقات الناس على تيك توك");
    expect(second.r).toMatchObject({ ok: true, contentAr: AGENT_TURN_CONTENT_AR });
    expect(live(db)).toHaveLength(1);
    expect(buildRequestContract(live(db)[0].request_text)).toMatchObject({ platform: "tiktok", comments: "some", topic: "السياحة", country: true });
    expect(lastOutcome()).toBe("ready");
  });

  it("2. a clear request is planned at once: no discovery question, one model call, the discovery finds every stage served", async () => {
    const text = "هات ٣٠٠ تعليق من تيك توك عن السياحة";
    scripted([say("data_request", brief({ request: text, platforms: ["tiktok"], content: ["comments"], count: 300, topic: "السياحة" }))]);
    const db = chatWorld();
    const { r } = await turn(db, text);
    expect(r).toMatchObject({ ok: true, contentAr: AGENT_TURN_CONTENT_AR });
    expect(modelCalls).toHaveLength(1);
    expect(missions(db)).toHaveLength(1);
    expect(discover(missions(db)[0].request_text).status).toBe("supported");
  });

  it("3. natural multi-turn corrections update ONE coherent request («عايز تعليقات عن السياحة» → «من تيك توك» → «آخر شهر» → «خليهم ٥٠٠» → «والردود كمان»); a typed «موافق» approves nothing", async () => {
    scripted([
      say("data_request", brief({ status: "needs_clarification", request: "عايز تعليقات عن السياحة", content: ["comments"], topic: "السياحة" }), "تحب التعليقات من أنهي منصة؟"),
      say("data_request", brief({ request: "هات تعليقات تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], topic: "السياحة" })),
      say("edit_of_open_request", brief({ request: "هات تعليقات تيك توك عن السياحة آخر شهر", platforms: ["tiktok"], content: ["comments"], topic: "السياحة", period: "آخر شهر" })),
      say("edit_of_open_request", brief({ request: "هات ٥٠٠ تعليق تيك توك عن السياحة آخر شهر", platforms: ["tiktok"], content: ["comments"], count: 500, topic: "السياحة", period: "آخر شهر" }), "", 500),
      say("edit_of_open_request", brief({ request: "هات ٥٠٠ تعليق تيك توك عن السياحة آخر شهر مع الردود", platforms: ["tiktok"], content: ["comments", "replies"], count: 500, topic: "السياحة", period: "آخر شهر" })),
    ]);
    const db = chatWorld();
    await turn(db, "عايز تعليقات عن السياحة");
    expect(missions(db)).toHaveLength(0);
    await turn(db, "من تيك توك");
    expect(live(db)).toHaveLength(1);
    const typed = await turn(db, "موافق");
    expect(typed.r.contentAr).toBe(AGENT_PRESS_APPROVE_AR);
    await turn(db, "آخر شهر");
    await turn(db, "خليهم ٥٠٠");
    await turn(db, "والردود كمان");
    // one live request, never restarted from scratch: every requirement kept (platform, comments, topic, period, count) and the replies added
    expect(live(db)).toHaveLength(1);
    const request = live(db)[0].request_text;
    expect(buildRequestContract(request)).toMatchObject({ platform: "tiktok", comments: "some", replies: "some", topic: "السياحة", period: true });
    const d = discover(request);
    expect(d.status).toBe("supported");
    expect(d.need.count).toBe(500);
    expect(d.stages.map((s) => s.stage.operation)).toEqual(["social.parents", "social.comments", "social.replies"]);
    // nothing approved, held or charged
    expect(db.rows("missions").every((m: any) => m.status === "queued" || m.status === "cancelled")).toBe(true);
    expect(JSON.stringify(db.rows("credit_ledger"))).toBe(JSON.stringify([{ user_id: USER, delta: 5000 }]));
  });

  it("8. an unsupported source is said honestly with a feasible public-data alternative, BEFORE any mission: Snapchat is never silently replaced by another platform", async () => {
    scripted([say("data_request", brief({ request: "عايز تعليقات سناب شات عن السياحة", content: ["comments"], topic: "السياحة" }))]);
    const db = chatWorld();
    const { r, assistant } = await turn(db, "عايز تعليقات سناب شات عن السياحة");
    expect(r.ok).toBe(false);
    expect(r.contentAr).toContain("سناب شات ليست من المصادر التي نجمع منها حاليًا");
    expect(r.contentAr).toContain("أي مصدر منها يناسبك؟");
    expect(r.contentAr).not.toMatch(PROVIDER_WORDS);
    expect(missions(db)).toHaveLength(0);
    expect(assistant.plan.researchBrief.status).toBe("needs_clarification");
    expect(lastOutcome()).toBe("capability_unsupported");
  });

  it("8c. a social request whose platform is served is never blocked by the chat for a child step only the social compiler decides (its plan states any step it cannot serve, with the price, before approval)", async () => {
    const text = "هات منشورات فيسبوك عن السياحة مع التعليقات والردود";
    scripted([say("data_request", brief({ request: text, platforms: ["facebook"], content: ["posts", "comments", "replies"], topic: "السياحة" }))]);
    const db = chatWorld();
    expect(discover(text).status).toBe("partial");
    const { r } = await turn(db, text);
    expect(r).toMatchObject({ ok: true });
    expect(missions(db)).toHaveLength(1);
    expect(lastOutcome()).toBe("ready");
  });

  it("8b. with the capability switch OFF the chat is exactly today's brief mode (no capability lines, the same request becomes a mission)", async () => {
    scripted([say("data_request", brief({ request: "هات ٣٠٠ تعليق من تيك توك عن السياحة", platforms: ["tiktok"], content: ["comments"], count: 300, topic: "السياحة" }))]);
    const db = chatWorld(null);
    const { r } = await turn(db, "هات ٣٠٠ تعليق من تيك توك عن السياحة");
    expect(r.ok).toBe(true);
    expect(modelCalls[0].system).not.toContain("أنواع البيانات العامة التي يقدر النظام يجمعها الآن");
  });

  it("15a. privacy: a brief that keeps a private component is refused whatever the model wrote (the same fixed answer as a typed one); no mission", async () => {
    scripted([say("data_request", brief({ request: "هات تعليقات تيك توك عن شركات الاتصالات وأرقام تليفونات الناس اللي علقوا", platforms: ["tiktok"], content: ["comments"], topic: "شركات الاتصالات" }))]);
    const db = chatWorld();
    const { r } = await turn(db, "هات تعليقات تيك توك عن شركات الاتصالات");
    expect(r.contentAr).toBe(PRIVACY_REFUSAL_AR);
    expect(missions(db)).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// CODE DECIDES: discovery, ranking, selection (over the REAL local catalog snapshot and the documented web sources)
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("capability discovery over the real catalog: eligibility, ranking by capability then price, validation (scenarios 9, 10, 11, 15)", () => {
  it("10. two capable providers: the one that meets the request wins over a cheaper one that cannot (paging for 300 comments), and between equally capable ones the cheaper wins", () => {
    const d = discover("هات ٣٠٠ تعليق من تيك توك عن السياحة");
    const comments = d.stages.find((s) => s.stage.operation === "social.comments")!;
    const cheapUnpaged = comments.eligible.find((e) => e.id === "crawl4ai.tiktok.video.comments")!;
    const winner = comments.eligible[0];
    expect(cheapUnpaged.reachesVolume).toBe(false);
    expect(winner.reachesVolume).toBe(true);
    expect(winner.usdPerRow!).toBeGreaterThan(cheapUnpaged.usdPerRow!);
    expect(comments.selected).toBe(winner.id);
    // the 20-comment parser is eligible (documented outputs) but ranked below every paged source
    const parser = comments.eligible.find((e) => e.id === "contextdev.parse.tiktok-comments")!;
    expect(parser.rank).toBeGreaterThan(comments.eligible.filter((e) => e.reachesVolume && e.outputsVerified).length);
    // among the candidates that are equally capable, price decides
    const capableTie = comments.eligible.filter((e) => e.outputsVerified === winner.outputsVerified && e.feedsChild === winner.feedsChild && e.reachesVolume === winner.reachesVolume && e.filtersCovered.length === winner.filtersCovered.length && e.preferredOutputs === winner.preferredOutputs);
    for (const e of capableTie) expect((e.usdPerRow ?? Infinity) >= (winner.usdPerRow ?? Infinity)).toBe(true);
    // a requested condition decides before price: «في مصر» picks a company source that can filter by country over cheaper ones that cannot
    const companies = discover("عايز شركات سياحة في مصر ومواقعهم").stages[0];
    expect(companies.eligible[0].filtersCovered).toContain("country");
    expect(companies.eligible.some((e) => !e.filtersCovered.includes("country") && (e.usdPerRow ?? Infinity) < (companies.eligible[0].usdPerRow ?? Infinity))).toBe(true);
    // the planner is told the ranked set, by code
    const section = plannerCapabilitySection(d);
    expect(section).toContain(`1. ${winner.id}`);
    expect(section).toContain("Plan stages ONLY with these ids");
  });

  it("a capability without the required output fields is never treated as able to supply them; a child stage must be fed by its parent's fields", () => {
    const d = discover("عايز تقييمات فنادق في القاهرة");
    const places = d.stages[0];
    expect(places.rejected.some((r) => r.reason === "missing_outputs")).toBe(true);
    for (const e of places.eligible.filter((x) => x.outputsVerified)) expect(e.outputs).toEqual(expect.arrayContaining(["name", "place_ref"]));
    const reviews = d.stages[1];
    expect(reviews.link).toEqual({ from: "place_ref", to: "place_ref" });
    for (const e of reviews.eligible.filter((x) => x.outputsVerified)) expect(e.outputs).toEqual(expect.arrayContaining(["text", "rating"]));
  });

  it("9. a provider with no key, or a daily cap of 0, is not eligible: its capabilities are rejected by code before anything could call them", () => {
    const noKey = discover("عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة", registry({ webKeys: { contextdev: false, firecrawl: false } }));
    const capZero = discover("عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة", registry({ dailyCapUsd: { contextdev: 0, firecrawl: 0 } }));
    for (const [d, reason] of [[noKey, "provider_key_missing"], [capZero, "provider_daily_cap_zero"]] as const) {
      const reviews = d.stages.find((s) => s.stage.operation === "places.reviews")!;
      expect(reviews.eligible.map((e) => e.id)).not.toContain("contextdev.parse.google-maps-reviews");
      expect(reviews.rejected).toContainEqual({ id: "contextdev.parse.google-maps-reviews", reason });
      expect(planStageIssues([{ key: "reviews", endpoint_id: "contextdev.parse.google-maps-reviews", parent_key: "place" }], d, catalog)).toHaveLength(1);
    }
    // the only provider of a step unavailable → the step is unsupported and said (here: web pages with no web key and no permitted catalog reader)
    const onlyWeb = buildCapabilityRegistry(catalog, { isAllowed: () => false, webKeys: { contextdev: false, firecrawl: false } });
    const web = discoverCapabilities(researchNeedOf({ request: "عايز اخبار ومقالات عن السياحة" }), onlyWeb);
    expect(web.status).toBe("unsupported");
    expect(web.unsupported[0].reason).toBe("not_permitted");
  });

  it("11. an invalid selection is rejected by code: an id outside the validated candidates, an unknown stage, a private-data capability", () => {
    const d = discover("عايز تقييمات فنادق في القاهرة");
    const reviewsKey = d.stages[1].stage.key;
    expect(validateCapabilityChoice(d, reviewsKey, d.stages[1].eligible[1].id, catalog)).toEqual({ ok: true });
    expect(validateCapabilityChoice(d, reviewsKey, "anyapi.tiktok.video.comments", catalog)).toEqual({ ok: false, reason: "not_a_candidate" });
    expect(validateCapabilityChoice(d, "made_up_stage", d.stages[1].eligible[0].id, catalog)).toEqual({ ok: false, reason: "unknown_stage" });
    expect(validateCapabilityChoice(d, reviewsKey, "aviato.people.email.find.personal", catalog)).toEqual({ ok: false, reason: "private_data" });
    expect(validateCapabilityChoice(d, reviewsKey, "invented.endpoint.that.does.not.exist", catalog)).toEqual({ ok: false, reason: "not_a_candidate" });
  });

  it("15b. private-data capabilities are never in the registry, and a request for private contacts discovers nothing", () => {
    const reg = registry();
    expect(reg.all.some((c) => /personal/.test(String(catalog.byId.get(c.id)?.capability ?? "")))).toBe(false);
    const d = discover("عايز أرقام موبايلات الناس اللي علقوا على فيديوهات السياحة في تيك توك");
    expect(d.status).toBe("blocked");
    expect(d.stages).toHaveLength(0);
  });

  it("the switch is OFF unless the trusted settings name this account (or everyone)", () => {
    expect(readCapabilityDiscoveryFlag({}, REPLAY_USER)).toBe(false);
    expect(readCapabilityDiscoveryFlag({ [CAPABILITY_DISCOVERY_FLAG_KEY]: "test" }, REPLAY_USER)).toBe(false);
    expect(readCapabilityDiscoveryFlag({ [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [USER] } }, REPLAY_USER)).toBe(false);
    expect(readCapabilityDiscoveryFlag({ [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] } }, REPLAY_USER)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE WORKER: the social compiled path (TREG) over stored live pages
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("4. a TREG social request through the unified social path: the compiled plan is recorded against the validated capabilities, with no extra provider call", () => {
  const TT = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
  const plan = (settings?: Record<string, unknown>) => runProductionPlanning({ fixture: M12, request: TT, answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", platform: "tiktok", planningAt: "2026-11-02T11:36:00Z", ...(settings ? { settings } : {}) });

  it("same plan, same provider calls, same price as the switch OFF; plus the capability record every stage is checked against at execution", async () => {
    const off = await plan();
    const on = await plan({ [CAPABILITY_DISCOVERY_FLAG_KEY]: true });
    expect(on.status).toBe("plan_ready");
    expect(on.providerCalls).toEqual(off.providerCalls);
    expect(on.plan!.stages.map((s) => [s.key, s.endpoint_id, s.planned_rows])).toEqual(off.plan!.stages.map((s) => [s.key, s.endpoint_id, s.planned_rows]));
    expect(on.plan!.price.reservePoints).toBe(off.plan!.price.reservePoints);
    expect(off.plan!.capability_selection).toBeUndefined();
    const rec = on.plan!.capability_selection!;
    expect(rec.v).toBe(1);
    expect(rec.stages.map((s) => [s.stage_key, s.capability_id])).toEqual(on.plan!.stages.map((s) => [s.key, s.endpoint_id]));
    // the parents of the compiled plan are a validated social.parents capability of TikTok on TREG
    const parents = rec.stages.find((s) => s.parent_key === null)!;
    expect(parents).toMatchObject({ operation: "social.parents", source: "discovery" });
    expect(catalog.byId.get(parents.capability_id)?.capability).toBe("tiktok.search.videos");
    const comments = rec.stages.find((s) => s.parent_key === parents.stage_key)!;
    expect(comments).toMatchObject({ operation: "social.comments", source: "discovery" });
    // a stage whose catalog entry names no capability (the compiler's replies card) is recorded as added by code, still checked at execution
    for (const s of rec.stages) expect(["discovery", "code"]).toContain(s.source);
    expect(verifyApprovedScope(on.plan!, catalog)).toEqual({ ok: true, checked: true });
  });

  it("12b (review of PR #454). the approved EXECUTION PARAMETERS are protected too: the customer's own edit before approval re-seals them (through the real edit path); any other change of a count, filter or pin is refused at execution", async () => {
    const on = await plan({ [CAPABILITY_DISCOVERY_FLAG_KEY]: true });
    const stored = on.plan!;
    expect(stored.capability_selection!.params_digest).toBe(planParamsDigest(stored));
    // the plan as the database gives it back (jsonb reorders the keys, drops undefined members): the same digest
    const reorder = (v: unknown): unknown => (Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse().map(([k, x]) => [k, reorder(x)])) : v);
    expect(verifyApprovedScope(reorder(JSON.parse(JSON.stringify(stored))) as PricedPlan, catalog)).toEqual({ ok: true, checked: true });
    // a count changed after the plan was priced, by anything but the customer's edit: never executed
    const bumped = JSON.parse(JSON.stringify(stored)) as PricedPlan;
    const child = bumped.stages.find((s) => s.parent_key !== null)!;
    child.planned_rows += 500;
    expect(verifyApprovedScope(bumped, catalog)).toMatchObject({ ok: false, issues: ["approved_parameters_changed"] });
    const filtered = JSON.parse(JSON.stringify(stored)) as PricedPlan;
    filtered.stages[0].filters = [...(filtered.stages[0].filters ?? []), { kind: "account", values: ["someone"] } as never];
    expect(verifyApprovedScope(filtered, catalog)).toMatchObject({ ok: false, issues: ["approved_parameters_changed"] });
    // the same edit made by the edit code but not re-sealed is refused; through the customer's real edit path it is re-sealed and runs
    const raw = applyPlanEdits(stored, { count: 1 });
    expect(raw.ok).toBe(true);
    if (raw.ok) {
      expect(verifyApprovedScope(raw.plan, catalog)).toMatchObject({ ok: false, issues: ["approved_parameters_changed"] });
      expect(verifyApprovedScope(resealCapabilitySelection(raw.plan), catalog)).toEqual({ ok: true, checked: true });
    }
    const db = createMemoryDb();
    db.seed("missions", [{ id: "msn_capscope00001", user_id: REPLAY_USER, status: "plan_ready", plan: JSON.parse(JSON.stringify(stored)), request_text: TT }]);
    expect(await editPlanForCustomer(db as never, { id: "msn_capscope00001", userId: REPLAY_USER, edits: { count: 1 } })).toMatchObject({ ok: true });
    const edited = db.rows("missions")[0].plan as PricedPlan;
    expect(planParamsDigest(edited)).not.toBe(stored.capability_selection!.params_digest);
    expect(verifyApprovedScope(edited, catalog)).toEqual({ ok: true, checked: true });
    // the capabilities themselves are never re-sealed by an edit
    expect(edited.capability_selection!.digest).toBe(stored.capability_selection!.digest);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE WORKER: the model-planned path, end to end through approval, execution, settlement and delivery
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const WHY = "the planner sampled the validated capability it ranks first for these fields";
const lastRows = (r: Results) => (r.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3);
const capturePrompts = (prompts: string[]) => (base: RunnerDeps): RunnerDeps => ({ ...base, driver: { run: async (i: Parameters<RunnerDeps["driver"]["run"]>[0]) => { prompts.push(i.userPrompt); return base.driver.run(i); } } as RunnerDeps["driver"] });

describe("6. Context.dev parsers: a places-and-reviews request planned from the validated parsers, executed, the place joined to every review", () => {
  it("the planner sees the validated capabilities, the plan records them, 200 real reviews are delivered with their place, charged by the file", async () => {
    const web = fakeContextDev({ parse: (parser, _url, body) => (parser === "google-maps" ? { data: mapsPlace("مطعم أبو طارق"), credits: 1 } : { data: mapsReviews(body.parseParams.limit), credits: 1 }) });
    const SEARCH = "https://www.google.com/maps/search/%D9%85%D8%B7%D8%B9%D9%85+%D8%A3%D8%A8%D9%88+%D8%B7%D8%A7%D8%B1%D9%82+%D8%A7%D9%84%D9%82%D8%A7%D9%87%D8%B1%D8%A9/";
    const PLACE = "https://www.google.com/maps/place/?q=place_id:ChIJplace0001";
    const prompts: string[] = [];
    const r = await replay({
      request: "عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة",
      web,
      makeStore: () => flagOn(createMemoryStore()),
      deps: capturePrompts(prompts),
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
    // the planner was given the validated set, by code, and the plan uses it
    expect(prompts[0]).toContain("VALIDATED CAPABILITIES");
    expect(prompts[0]).toMatch(/stage place_reviews \(places\.reviews/);
    expect(prompts[0]).toContain("contextdev.parse.google-maps-reviews");
    const rec = r.plannedPlan.capability_selection!;
    expect(rec.stages.map((s) => [s.stage_key, s.capability_id, s.operation, s.source])).toEqual([["place", "contextdev.parse.google-maps", "places.discover", "discovery"], ["reviews", "contextdev.parse.google-maps-reviews", "places.reviews", "discovery"]]);
    // the reviews are fed by the plan's own place stage: its place reference
    expect(rec.stages[1].link).toEqual({ from: "place_ref", to: "place_ref" });
    // executed from the STORED plan, delivered and charged by the file
    assertReplayInvariants(r, { expectDelivered: 200 });
    const sheet = (await readWorkbook(r)).getWorksheet("التقييمات")!;
    expect(sheet.getRow(2).getCell(1).value).toBe("مطعم أبو طارق");
    expect(sheet.rowCount).toBe(201);
    expect(r.store.events.some((e) => e.counts?.capability_discovery === 1)).toBe(true);
    expect(r.store.events.some((e) => e.counts?.capability_record === 1)).toBe(true);
  });
});

describe("7, 13, 14. a multi-stage company request (TREG companies → employees, Context.dev contact pages): a valid validated chain, joined rows, only verified contacts delivered and charged (partial)", () => {
  const COMPANIES = "aiark.companies.search";
  const EMPLOYEES = "aviato.companies.employees";
  const SITES = ["https://company1.example", "https://company2.example", "https://company3.example"];
  const EMAILS: Record<string, string[]> = { "company1.example": ["info@company1.example", "someone@gmail.com"], "company2.example": ["someone@gmail.com"], "company3.example": ["sales@company3.example"] };
  const PHONES: Record<string, string[]> = { "company1.example": ["+20227945000"], "company2.example": ["+20233445566"], "company3.example": [] };
  const contactWeb = () => fakeContextDev({
    parse: (parser, url) => {
      const host = new URL(url).hostname;
      if (parser === "links") return { data: linksOf([[`https://${host}/about`, "من نحن"], [`https://${host}/contact`, "اتصل بنا"]]), credits: 1 };
      if (parser === "emails") return { data: emailsOf(EMAILS[host] ?? []), credits: 1 };
      if (parser === "phone-numbers") return { data: phonesOf(PHONES[host] ?? []), credits: 1 };
      return { fail: { error_code: "NOT_FOUND" } };
    },
  });
  const proposal = (res: Results, contactsEndpoint = "contextdev.parse.emails") => ({
    summary_ar: "ستحصل على ثلاث شركات كهروميكانيكا في مصر وموظفين اثنين من كل شركة مع بريد كل شركة المهني وهاتفها من موقعها.",
    stages: [
      { key: "companies", title_ar: "الشركات", endpoint_id: COMPANIES, expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "اسم الشركة" }, { key: "url", title_ar: "الموقع" }], sample_rows: lastRows(res).slice(0, 2), measured_by: [callIds(res)[0]] },
      { key: "employees", title_ar: "موظفو كل شركة", endpoint_id: EMPLOYEES, expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "text", title_ar: "اسم الموظف" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "co1-p1", text: "أحمد حسن", title: "مدير المشتريات" }], measured_by: [callIds(res)[1]] },
      { key: "emails", title_ar: "البريد المهني لكل شركة", endpoint_id: contactsEndpoint, expected_rows: 3, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "البريد المهني", kind: "work_email" }], sample_rows: [{ id: "info@company1.example", text: "info@company1.example" }], measured_by: [callIds(res)[3]] },
      { key: "phones", title_ar: "هاتف كل شركة", endpoint_id: "contextdev.parse.phone-numbers", expected_rows: 3, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "رقم الهاتف", kind: "phone" }], sample_rows: [{ id: "+20227945000", text: "+20227945000" }], measured_by: [callIds(res)[4]] },
    ],
  });
  const planningSteps = (propose: FakeStep[]): FakeStep[] => [
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why: WHY } },
    { tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { website: "company1.example", page: 0, perPage: 2 }, why: WHY } },
    { tool: "parse_page", args: { parser: "links", url: SITES[0], why: WHY } },
    { tool: "parse_page", args: { parser: "emails", url: `${SITES[0]}/contact`, why: WHY } },
    { tool: "parse_page", args: { parser: "phone-numbers", url: `${SITES[0]}/contact`, why: WHY } },
    { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.content.slice(0, 2).map(c => ({ id: c.id, text: c.name, url: c.domain, country: c.location.country }))", files: callIds(res).slice(0, 1) }) },
    ...propose,
  ];
  const executionSteps = (): FakeStep[] => [
    { tool: "treg_call", args: { endpoint_id: COMPANIES, params: { page: 0, size: 3, account: "الكهروميكانيكا مصر" }, why: WHY } },
    { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].content.map(c => ({ id: c.id, text: c.name, url: c.domain, country: c.location.country }))", files: callIds(res) }) },
    { tool: "save_rows", args: (res: Results) => ({ stage_key: "companies", from_output: lastOutputId(res) }) },
    ...[1, 2, 3].map((c): FakeStep => ({ tool: "treg_call", args: { endpoint_id: EMPLOYEES, params: { website: `company${c}.example`, page: 0, perPage: 2 }, why: WHY } })),
    { tool: "run_code", args: (res: Results) => ({ code: "const out = []; for (const page of Object.values(inputs)) for (const e of page.employees) out.push({ id: e.personID, parent_id: e.companyID, text: e.person.fullName, title: e.positionList[0].title }); return out;", files: callIds(res).slice(1) }) },
    { tool: "save_rows", args: (res: Results) => ({ stage_key: "employees", from_output: lastOutputId(res) }) },
    ...SITES.flatMap((site): FakeStep[] => [
      { tool: "parse_page", args: { parser: "links", url: site, why: WHY } },
      { tool: "parse_page", args: { parser: "emails", url: `${site}/contact`, why: WHY } },
      { tool: "parse_page", args: { parser: "phone-numbers", url: `${site}/contact`, why: WHY } },
    ]),
    { tool: "run_code", args: (res: Results) => { const pages = res.filter((x) => (x.tool === "parse_page" || x.tool === "treg_call") && x.result.ok === true).map((x) => String(x.result.call_id)); return { code: "const ids = ['co1','co2','co3']; const keys = Object.keys(inputs); const out = []; ids.forEach((id, i) => { const emails = inputs[keys[i * 3 + 1]].rows.map(r => r.email); const first = emails[0]; if (first) out.push({ id: first, parent_id: id, text: first }); }); return out;", files: pages.slice(4) }; } },
    { tool: "save_rows", args: (res: Results) => ({ stage_key: "emails", from_output: lastOutputId(res) }) },
    { tool: "run_code", args: (res: Results) => { const pages = res.filter((x) => (x.tool === "parse_page" || x.tool === "treg_call") && x.result.ok === true).map((x) => String(x.result.call_id)); return { code: "const ids = ['co1','co2','co3']; const keys = Object.keys(inputs); const out = []; ids.forEach((id, i) => { const phones = inputs[keys[i * 3 + 2]].rows.map(r => r.phone); const first = phones[0]; if (first) out.push({ id: first, parent_id: id, text: first }); }); return out;", files: pages.slice(4) }; } },
    { tool: "save_rows", args: (res: Results) => ({ stage_key: "phones", from_output: lastOutputId(res) }) },
    { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ثلاث شركات وستة موظفين وبريدان مهنيان وهاتفان للشركات؛ البريد الشخصي لم يُعتمد، والشركة الثالثة لا هاتف لها في موقعها فلم يُحتسب عليك." } },
  ];
  const answers = () => [
    tregResult(companiesPage(3), 0.0005267), tregResult(employeesPage("co1", 2), 0.005),
    tregResult(companiesPage(3), 0.0005267), ...[1, 2, 3].map((c) => tregResult(employeesPage(`co${c}`, 2), 0.005)),
  ];
  const REQUEST = "عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين، وإيميل وموبايل كل شركة من موقعها";

  it("the chain companies → (employees, work e-mails, phones) is validated stage by stage, recorded with the plan, executed from the stored plan; 13 of 15 verified rows delivered and charged", async () => {
    const web = contactWeb();
    const r = await replay({
      request: REQUEST, web, answers: answers(),
      makeStore: () => flagOn(createMemoryStore()),
      deps: (base) => ({ ...base, reviewCall: approvingReview as never }),
      planning: planningSteps([{ tool: "propose_plan", args: (res: Results) => proposal(res) }]),
      execution: executionSteps,
    });
    const rec = r.plannedPlan.capability_selection!;
    expect(rec.status).toBe("supported");
    expect(rec.stages.map((s) => [s.stage_key, s.operation, s.source])).toEqual([["companies", "companies.discover", "discovery"], ["employees", "people.discover", "discovery"], ["emails", "company.contacts", "discovery"], ["phones", "company.contacts", "discovery"]]);
    // verified only: 3 companies + 6 employees + 2 work e-mails (the gmail box is not a work e-mail) + 2 phones = 13 of 15; charged for 13, the rest released
    assertReplayInvariants(r, { expectDelivered: 13, expectStatus: "partial" });
    const emails = JSON.parse((await r.store.getFile(r.missionId, "rows/emails.json"))!);
    expect(emails.map((e: any) => e.text)).toEqual(["info@company1.example", "sales@company3.example"]);
    // each contact row names its company first: the parent-child join of real rows
    const sheet = (await readWorkbook(r)).getWorksheet("البريد المهني لكل شركة")!;
    expect(sheet.getRow(2).getCell(1).value).toBe("الشركة المصرية للكهروميكانيكا");
  });

  it("11 (worker). a plan stage on a capability code did not validate for this request is refused; the planner fixes it and only then the plan exists", async () => {
    const web = contactWeb();
    const prompts: string[] = [];
    const r = await replay({
      request: REQUEST, web, answers: answers(),
      makeStore: () => flagOn(createMemoryStore()),
      deps: (base) => ({ ...capturePrompts(prompts)(base), reviewCall: approvingReview as never }),
      planning: planningSteps([
        // a TikTok comments source for the e-mails: not a validated capability of any stage of this request
        { tool: "propose_plan", args: (res: Results) => proposal(res, "anyapi.tiktok.video.comments") },
        { tool: "propose_plan", args: (res: Results) => proposal(res) },
      ]),
      execution: executionSteps,
    });
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals[0].result).toMatchObject({ ok: false });
    expect(JSON.stringify(proposals[0].result.issues)).toContain("anyapi.tiktok.video.comments is not one of the validated capabilities");
    expect(proposals[1].result).toMatchObject({ ok: true });
    expect(r.plannedPlan.stages.find((s) => s.key === "emails")!.endpoint_id).toBe("contextdev.parse.emails");
    assertReplayInvariants(r, { expectDelivered: 13, expectStatus: "partial" });
  });

  it("11b (review of PR #454). a capability validated for ANOTHER stage of the chain is refused at this stage: the work e-mails parser planned under the employees (its validated parent is the companies) is not accepted", async () => {
    const web = contactWeb();
    const misplaced = (res: Results) => { const p = proposal(res); return { ...p, stages: p.stages.map((st): Record<string, unknown> => (st.key === "emails" ? { ...st, parent_key: "employees" } : st)) }; };
    const r = await replay({
      request: REQUEST, web, answers: answers(),
      makeStore: () => flagOn(createMemoryStore()),
      deps: (base) => ({ ...base, reviewCall: approvingReview as never }),
      planning: planningSteps([
        { tool: "propose_plan", args: misplaced },
        { tool: "propose_plan", args: (res: Results) => proposal(res) },
      ]),
      execution: executionSteps,
    });
    const proposals = r.planningDriver.results.filter((x) => x.tool === "propose_plan");
    expect(proposals[0].result).toMatchObject({ ok: false });
    expect(JSON.stringify(proposals[0].result.issues)).toContain("contextdev.parse.emails is validated only for stage company_emails");
    expect(proposals[1].result).toMatchObject({ ok: true });
    expect(r.plannedPlan.stages.find((s) => s.key === "emails")!.parent_key).toBe("companies");
    assertReplayInvariants(r, { expectDelivered: 13, expectStatus: "partial" });
  });

  it("12. the approved scope is immutable: a stored plan whose stage now reads another capability than the one validated and approved is never executed; nothing is called and the hold is released whole", async () => {
    const web = contactWeb();
    const execAnswers = answers();
    let executionProviderCalls = -1;
    let webCallsBefore = -1;
    const store = flagOn(createMemoryStore());
    const r = await replay({
      request: REQUEST, web, answers: execAnswers,
      makeStore: () => store,
      deps: (base) => ({ ...base, reviewCall: approvingReview as never }),
      planning: planningSteps([{ tool: "propose_plan", args: (res: Results) => proposal(res) }]),
      beforeApproval: async ({ missionId, db }) => {
        // the stored plan is changed after the customer saw it (anything but the code that priced it): its companies stage now reads another source
        const m = store.missions.get(missionId)!;
        const plan = JSON.parse(JSON.stringify(m.plan)) as PricedPlan;
        plan.stages[0].endpoint_id = "quickenrich.companies.search";
        m.plan = plan as never;
        const row = db.rows("missions").find((x: any) => x.id === missionId);
        if (row) row.plan = plan;
        webCallsBefore = web.fetchFn.mock.calls.length;
      },
      execution: () => { executionProviderCalls = 0; return executionSteps(); },
    });
    expect(executionProviderCalls).toBe(0);
    expect(r.executionDriver.results).toHaveLength(0);
    expect(web.fetchFn.mock.calls.length).toBe(webCallsBefore);
    expect(r.rec.rows.filter((x) => x.jobId !== null)).toHaveLength(0);
    expect(Number(r.mission.delivered_units ?? 0)).toBe(0);
    expect(Number(r.mission.charged_points ?? 0)).toBe(0);
    expect(r.money.balance()).toBe(r.initialBalance);
    expect(String(r.mission.error)).toContain("approved_scope_changed");
    expect(String(r.mission.error)).toContain("capability_changed:companies");
  });
});

describe("5. Firecrawl: a public-web request planned from the validated web search and page reader, executed, each page joined to its search result", () => {
  it("search → read each page; the plan records the Firecrawl capabilities; the pages are delivered and charged", async () => {
    const PAGES: Record<string, string> = {
      "https://news1.example/tourism": "# السياحة في مصر\nارتفع عدد السياح هذا العام في الأقصر وأسوان.",
      "https://news2.example/egypt-travel": "# موسم السياحة\nالفنادق في الغردقة ممتلئة والسياحة الشاطئية تنمو.",
    };
    const base = fakeContextDev({ search: () => Object.keys(PAGES).map((url, i) => ({ url, title: `مقال عن السياحة ${i + 1}`, description: "السياحة في مصر" })) });
    const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/v2/scrape")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        base.requests.push({ url: input, body, headers: {} });
        return { status: 200, ok: true, headers: new Headers(), json: async () => ({ success: true, data: { markdown: PAGES[body.url] ?? "", links: [], metadata: { statusCode: 200, url: body.url } } }) } as unknown as Response;
      }
      return base.fetchFn(input, init);
    });
    const web = { fetchFn, requests: base.requests };
    const r = await replay({
      request: "اجمعلي مقالات أخبار عن السياحة في مصر من مواقع الويب",
      web,
      makeStore: () => flagOn(createMemoryStore()),
      planning: [
        { tool: "web_search", args: { provider: "firecrawl", query: "السياحة في مصر", limit: 10, why: WHY } },
        { tool: "web_scrape", args: { provider: "firecrawl", url: "https://news1.example/tourism", why: WHY } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs.call_0001.rows.map(h => ({ id: h.url, title: h.title, url: h.url }))", files: callIds(res).slice(0, 1) }) },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على مقالات عامة عن السياحة في مصر مع نص كل مقال ورابطه.",
          stages: [
            { key: "results", title_ar: "نتائج البحث", endpoint_id: "firecrawl.search", expected_rows: 2, parent_key: null, deliver: false, columns: [{ key: "title", title_ar: "العنوان" }, { key: "url", title_ar: "الرابط" }], sample_rows: lastRows(res).slice(0, 2), measured_by: [callIds(res)[0]] },
            { key: "pages", title_ar: "نصوص المقالات", endpoint_id: "firecrawl.scrape", expected_rows: 2, parent_key: "results", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "نص المقال" }], sample_rows: [{ id: "https://news1.example/tourism", text: "ارتفع عدد السياح هذا العام في الأقصر وأسوان." }], measured_by: [callIds(res)[1]] },
          ],
        }) },
      ],
      execution: () => [
        { tool: "web_search", args: { provider: "firecrawl", query: "السياحة في مصر", limit: 10 } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].rows.map(h => ({ id: h.url, title: h.title, url: h.url }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "results", from_output: lastOutputId(res) }) },
        ...Object.keys(PAGES).map((url): FakeStep => ({ tool: "web_scrape", args: { provider: "firecrawl", url } })),
        { tool: "run_code", args: (res: Results) => ({ code: `const urls = ${JSON.stringify(Object.keys(PAGES))}; return Object.keys(inputs).map((k, i) => ({ id: urls[i], parent_id: urls[i], text: String(inputs[k].markdown ?? inputs[k].rows?.[0]?.markdown ?? '').split('\\n').slice(1).join(' ').trim() }));`, files: callIds(res).slice(1) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "pages", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّم نص مقالين عن السياحة في مصر." } },
      ],
      answers: [],
    });
    const rec = r.plannedPlan.capability_selection!;
    expect(rec.stages.map((s) => [s.stage_key, s.capability_id, s.operation])).toEqual([["results", "firecrawl.search", "web.search"], ["pages", "firecrawl.scrape", "web.read"]]);
    assertReplayInvariants(r, { expectDelivered: 2 });
    const rows = JSON.parse((await r.store.getFile(r.missionId, "rows/pages.json"))!);
    expect(rows.map((x: any) => x.parent_id)).toEqual(Object.keys(PAGES));
    expect(rows[0].text).toContain("الأقصر");
    // every call was a recorded Firecrawl (or catalog-free) call: nothing reached the network
    expect(r.rec.rows.every((x) => x.provider === "firecrawl")).toBe(true);
    expect(r.call).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE WORKER: honest limits before any plan, no unauthorized call
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function planOnly(request: string, o: { answer?: string; caps?: Partial<Record<"firecrawl" | "contextdev", number>>; web?: ReturnType<typeof fakeContextDev>; script?: FakeStep[]; runState?: { capabilityScope: "asked" | "accepted" }; catalog?: typeof catalog } = {}) {
  vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
  const store = flagOn(createMemoryStore());
  const id = "msn_capability0001";
  store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: request, ...(o.answer ? { answer_text: o.answer } : {}), status: "planning", created_at: "2026-11-11T09:00:00Z" }) as never);
  if (o.runState) await updateRunState(store, id, (r) => ({ ...r, ...o.runState }));
  const call = vi.fn(async () => { throw new Error("no TREG call is expected"); });
  const driver = createFakeDriver(o.script ?? []);
  const rec = fakeRecorder({ dailyCapUsd: 5 });
  const deps: RunnerDeps = {
    store, client: {}, catalog: o.catalog ?? catalog, driver, recorder: rec.recorder, commit: rec.commit, call: call as never, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" },
    resolveAccess: async () => NOT_ADMIN, notify: async () => undefined,
    ...(o.web ? { providerKey: async () => "test-provider-key", fetchFn: o.web.fetchFn as never } : {}),
    ...(o.caps ? { providerDailyCaps: async () => o.caps! } : {}),
  };
  await runPlanning(deps, store.missions.get(id)!);
  vi.unstubAllGlobals();
  return { store, mission: store.missions.get(id)!, call, driver, rec };
}

describe("8, 9 (worker). an unavailable step is asked about before any plan; a provider with no cap is never called", () => {
  // a catalog fixture without the company-contact endpoints (the real snapshot, filtered): with Context.dev's cap at 0 the e-mails step has NO capability at all
  const noContactCatalog = parseCatalog({ source: catalog.source, count: 0, excluded: catalog.excluded, endpoints: catalog.endpoints.filter((e) => !/^companies\.emails/.test(String(e.capability ?? ""))) }, [...catalog.writeIds].map((id) => ({ id })));
  it("8. a reduced scope is ASKED before a plan or price (the e-mails step has no available capability); «لا» cancels, nothing was planned, called or held", async () => {
    const web = fakeContextDev();
    const first = await planOnly("عايز شركات مقاولات في مصر ومواقعها وإيميلات الشغل الرسمية", { web, caps: { contextdev: 0, firecrawl: 0 }, catalog: noContactCatalog });
    expect(first.mission.status).toBe("needs_input");
    expect(first.mission.question_ar).toContain("لا نقدر حاليًا على جمع");
    expect(first.mission.question_ar).toContain("إيميلات وأرقام العمل الرسمية");
    expect(first.mission.question_ar).toContain("هل يناسبك هذا النطاق؟");
    expect((first.mission.plan_public as any).question_options).toEqual([...CAPABILITY_SCOPE_OPTIONS_AR]);
    expect(first.mission.plan).toBeFalsy();
    expect(first.call).not.toHaveBeenCalled();
    expect(web.fetchFn).not.toHaveBeenCalled();
    expect(first.driver.results).toHaveLength(0);
    const no = await planOnly("عايز شركات مقاولات في مصر ومواقعها وإيميلات الشغل الرسمية", { web, caps: { contextdev: 0, firecrawl: 0 }, catalog: noContactCatalog, answer: CAPABILITY_SCOPE_OPTIONS_AR[1], runState: { capabilityScope: "asked" } });
    expect(no.mission.status).toBe("cancelled");
    expect(no.call).not.toHaveBeenCalled();
    expect(no.driver.results).toHaveLength(0);
  });

  it("9. a model that tries to plan a Context.dev parser whose provider cap is 0 gets the plan refused by code, and no Context.dev request is made", async () => {
    const web = fakeContextDev({ parse: () => ({ data: mapsReviews(10), credits: 1 }) });
    const r = await planOnly("عايز ٢٠٠ تقييم من خرائط جوجل لمطعم أبو طارق في القاهرة", {
      web, caps: { contextdev: 0, firecrawl: 0 },
      script: [{ tool: "propose_plan", args: { summary_ar: "تقييمات المطعم.", stages: [{ key: "reviews", title_ar: "التقييمات", endpoint_id: "contextdev.parse.google-maps-reviews", expected_rows: 200, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "نص التقييم" }], sample_rows: [{ id: "a", text: "x" }], measured_by: [] }] } }],
    });
    const proposed = r.driver.results.find((x) => x.tool === "propose_plan")!;
    expect(proposed.result).toMatchObject({ ok: false });
    expect(JSON.stringify(proposed.result.issues)).toContain("not one of the validated capabilities");
    expect(web.fetchFn).not.toHaveBeenCalled();
    expect(r.mission.plan).toBeFalsy();
  });

  it("8c. a source no provider serves ends honestly before any planning call, with the feasible alternative; nothing held", async () => {
    const r = await planOnly("عايز تعليقات سناب شات عن السياحة في مصر");
    // the platform card of the legacy route may come first; either way nothing is called or planned
    expect(r.call).not.toHaveBeenCalled();
    expect(r.driver.results).toHaveLength(0);
    if (r.mission.status === "unserved") {
      expect(r.mission.summary_ar).toContain("سناب شات");
      expect(r.mission.summary_ar).toContain("لم يُخصم منك شيء");
    } else expect(r.mission.status).toBe("needs_input");
  });

  it("15c. privacy in the worker: a private-data endpoint asked by the model is refused before the gateway and costs nothing; a plan stage on it is refused", async () => {
    const r = await planOnly("عايز شركات مقاولات في مصر ومواقعها", {
      script: [
        { tool: "treg_call", args: { endpoint_id: "aviato.people.email.find.personal", params: { type: "personal" } } },
        { tool: "propose_plan", args: { summary_ar: "الشركات.", stages: [{ key: "c", title_ar: "الشركات", endpoint_id: "aviato.people.email.find.personal", expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "الاسم" }], sample_rows: [{ id: "a", text: "x" }], measured_by: [] }] } },
      ],
    });
    expect(r.driver.results[0].result).toMatchObject({ ok: false, refused: "private_data" });
    expect(JSON.stringify(r.driver.results[1].result)).toContain("private personal data");
    expect(r.call).not.toHaveBeenCalled();
    expect(r.rec.rows).toHaveLength(0);
  });
});

describe("the selection record", () => {
  it("records every stage with its capability; a removed stage (a customer's edit before approval, re-sealed) is allowed, an added or switched one is not", () => {
    const d = discover("عايز تقييمات فنادق في القاهرة");
    const plan = { stages: [{ key: "p", endpoint_id: d.stages[0].selected!, parent_key: null }, { key: "r", endpoint_id: d.stages[1].selected!, parent_key: "p" }] };
    const rec = capabilitySelectionOf(plan, d);
    expect(verifyApprovedScope({ ...plan, capability_selection: rec })).toEqual({ ok: true, checked: true });
    expect(verifyApprovedScope(resealCapabilitySelection({ stages: [plan.stages[0]], capability_selection: rec }))).toEqual({ ok: true, checked: true });
    const added = verifyApprovedScope({ stages: [...plan.stages, { key: "x", endpoint_id: d.stages[1].selected!, parent_key: "p" }], capability_selection: rec });
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.issues).toContain("stage_added:x");
    const tampered = { ...rec, stages: rec.stages.map((s) => (s.stage_key === "r" ? { ...s, capability_id: "anyapi.google.maps.reviews" } : s)) };
    const switched = verifyApprovedScope({ stages: [plan.stages[0], { ...plan.stages[1], endpoint_id: "anyapi.google.maps.reviews" }], capability_selection: tampered });
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.issues).toContain("selection_record_altered");
    // a plan with no record (switch off) is not checked
    expect(verifyApprovedScope(plan)).toEqual({ ok: true, checked: false });
  });

  it("(review of PR #454) a capability is accepted only at ITS stage of the chain: a child-only capability planned as a first stage, or under the wrong parent, binds to nothing and is refused", () => {
    const d = discover("عايز ٣ شركات كهروميكانيكا في مصر، وجوه كل شركة موظفين اتنين، وإيميل وموبايل كل شركة من موقعها");
    const keyOf = (op: string) => d.stages.find((s) => s.stage.operation === op && (op !== "company.contacts" || s.stage.key.includes("email")))!;
    const companies = keyOf("companies.discover");
    const emails = keyOf("company.contacts");
    const people = keyOf("people.discover");
    expect(emails.stage.parentKey).toBe(companies.stage.key);
    const ok = [{ key: "c", endpoint_id: companies.selected!, parent_key: null }, { key: "e", endpoint_id: emails.selected!, parent_key: "c" }, { key: "p", endpoint_id: people.selected!, parent_key: "c" }];
    expect(planStageIssues(ok, d, catalog)).toEqual([]);
    // the contact-page parser as the FIRST stage: it is validated only as a child of the companies
    const asRoot = planStageIssues([{ key: "e", endpoint_id: emails.selected!, parent_key: null }], d, catalog);
    expect(asRoot.join(" ")).toContain(`validated only for stage ${emails.stage.key}`);
    // the e-mails under the employees: the e-mails stage's validated parent is the companies, not the people
    const wrongParent = planStageIssues([ok[0], ok[2], { key: "e", endpoint_id: emails.selected!, parent_key: "p" }], d, catalog);
    expect(wrongParent).toHaveLength(1);
    expect(wrongParent[0]).toContain("stage e:");
    // a child under a parent that is itself misplaced binds to nothing either
    const chainOff = planStageIssues([{ key: "p", endpoint_id: people.selected!, parent_key: null }, { key: "e", endpoint_id: emails.selected!, parent_key: "p" }], d, catalog);
    expect(chainOff).toHaveLength(2);
    // the record names each stage's own operation
    const rec = capabilitySelectionOf({ stages: ok }, d);
    expect(rec.stages.map((s) => [s.stage_key, s.operation, s.source])).toEqual([["c", "companies.discover", "discovery"], ["e", "company.contacts", "discovery"], ["p", "people.discover", "discovery"]]);
    expect(capabilitySelectionOf({ stages: [{ key: "e", endpoint_id: emails.selected!, parent_key: null }] }, d).stages[0]).toMatchObject({ operation: null, source: "code" });
  });
});
