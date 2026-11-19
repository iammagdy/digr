import { describe, expect, it, vi } from "vitest";
import { buildTools } from "../agent/src/tools";
import { makeHarness, NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { contactVerificationQuestionIssue } from "../src/lib/agentMission/contactQuestion";
import { PEOPLE_UNAVAILABLE_AR, classifyNoCardEnd, noCardSentenceAr } from "../src/lib/agentMission/refusal";
import { PEOPLE_OF_COMPANY_CAPABILITIES, peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import type { PlannerModel } from "../agent/src/llmPlanner/planner";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * DT-20261118-09 (live chat after #576, main be007198): «عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم بأرقامهم الشخصية» ended with NO card and the question «وجدنا شركات … لكن مسؤولي إدارتها
 * وأرقامهم الشخصية لم يظهروا في المصادر المتاحة … كيف تحب نكمل؟». Two gaps (BUG HUNTER RCA3): the A1 guard reads the request by words and this wording has none it knows, although the planner understood the
 * people; and a no-card end where the people sources failed or were never called was told to the customer as «not found» / «not served». The planner's understanding decides, not the words.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id);
const PEOPLE_IDS = peopleSourcesForCompanies(catalog, allowed).map((s) => s.id);
const REQUEST = "عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم بأرقامهم الشخصية";
const QUESTION = "وجدنا شركات مقاولات في الرياض، لكن مسؤولي إدارتها وأرقامهم الشخصية لم يظهروا في المصادر المتاحة لهذه المهمة. كيف تحب نكمل؟";
const OPTIONS = ["نكمل بالشركات فقط", "نبحث عن أي موظفين فيها", "أرسل لك أسماء شركات محددة"];
const UNDERSTOOD = { noun_ar: "الأشخاص", parent_ar: "الشركات", per_parent: null, contact_kinds: ["phone"] as Array<"email" | "phone"> };

describe("F1: the question about people «not found» is refused when the planner understood the people, whatever the wording", () => {
  it("the guard reads the planner's understanding, not only the words (control: the words alone still pass this wording)", () => {
    expect(contactVerificationQuestionIssue(REQUEST, QUESTION, OPTIONS)).toBeNull();
    expect(contactVerificationQuestionIssue(REQUEST, QUESTION, OPTIONS, { gaveRows: true, sourceIds: [] })).toMatch(/already asked for the people/);
  });
  it("a question that is not about contacts stays allowed for the same understanding", () => {
    expect(contactVerificationQuestionIssue(REQUEST, "المقصود بالمقاولات شركات البناء أم التشطيبات؟", ["البناء", "التشطيبات"], { gaveRows: false, sourceIds: [] })).toBeNull();
  });
  it("ask_question: refused when ctx.understoodPeople is set, nothing is stored as the customer's question; the same call without it is accepted (the guard is the planner's understanding)", async () => {
    const h = makeHarness({ phase: "planning", mission: { request_text: REQUEST } });
    const ask = buildTools(h.ctx).find((t) => t.name === "ask_question")!;
    const free: any = await ask.handler({ question_ar: QUESTION, options_ar: OPTIONS });
    expect(free.ok).toBe(true);
    const h2 = makeHarness({ phase: "planning", mission: { request_text: REQUEST } });
    (h2.ctx as { understoodPeople?: typeof UNDERSTOOD }).understoodPeople = UNDERSTOOD;
    const r: any = await buildTools(h2.ctx).find((t) => t.name === "ask_question")!.handler({ question_ar: QUESTION, options_ar: OPTIONS });
    expect(r.ok).toBe(false);
    expect(h2.ctx.state.question).toBeNull();
  });
});

describe("item 3: the refusal tells the planner what to do next, from the catalog's own structure", () => {
  it("no people source gave a person yet: the refusal names the catalog's people sources (cheapest first) and says to call them, never to ask the customer to choose", () => {
    const issue = contactVerificationQuestionIssue(REQUEST, QUESTION, OPTIONS, { gaveRows: false, sourceIds: ["people.source.a", "people.source.b"] })!;
    expect(issue).toContain("people.source.a, people.source.b");
    expect(issue).toMatch(/no people source has given a person yet/);
    expect(issue).toMatch(/finish/);
    expect(issue).not.toMatch(/Deliver every person/);
  });
  it("a people source already gave named people: the refusal is the A1 sentence (deliver them, decide, say it in assumptions_ar)", () => {
    const issue = contactVerificationQuestionIssue(REQUEST, QUESTION, OPTIONS, { gaveRows: true, sourceIds: ["people.source.a"] })!;
    expect(issue).toMatch(/Deliver every person/);
    expect(issue).not.toMatch(/no people source has given a person yet/);
  });
  it("through ask_question: the ids in the refusal are the catalog's people-of-company sources, and a sample of one of them that gave rows switches the sentence", async () => {
    expect(PEOPLE_IDS.length).toBeGreaterThan(0);
    const h = makeHarness({ phase: "planning", mission: { request_text: REQUEST } });
    (h.ctx as { understoodPeople?: typeof UNDERSTOOD }).understoodPeople = UNDERSTOOD;
    const ask = buildTools(h.ctx).find((t) => t.name === "ask_question")!;
    const before: any = await ask.handler({ question_ar: QUESTION, options_ar: OPTIONS });
    expect(before.ok).toBe(false);
    expect(before.error).toContain(PEOPLE_IDS[0]);
    expect(before.error).toMatch(/no people source has given a person yet/);
    h.ctx.state.samples.set(PEOPLE_IDS[0], [{ rows: 2, key: "k" }]);
    const after: any = await ask.handler({ question_ar: QUESTION, options_ar: OPTIONS });
    expect(after.ok).toBe(false);
    expect(after.error).toMatch(/Deliver every person/);
    h.ctx.state.samples.set(PEOPLE_IDS[0], [{ rows: 0, key: "k" }]);
    const empty: any = await ask.handler({ question_ar: QUESTION, options_ar: OPTIONS });
    expect(empty.error).toMatch(/no people source has given a person yet/);
  });
});

describe("F2: people sources that failed, or were never tried, are never reported as «not found» or «not served»", () => {
  const PEOPLE = new Set(["people.source.a", "people.source.b"]);
  const call = (endpoint_id: string, status: string, rows = 0, refused_reason: string | null = null) => ({ phase: "planning", endpoint_id, status, rows_returned: rows, refused_reason });
  const base = { claim: "unsupported" as const, endedWithoutAnswer: false, peopleAsked: true, peopleEndpointIds: PEOPLE };
  it("companies answered, every people call failed (402): internal, people_sources_failed, and the customer reads the people sentence", () => {
    const v = classifyNoCardEnd({ ...base, calls: [call("companies.source", "ok", 2), call("people.source.a", "failed"), call("people.source.b", "failed")] });
    expect(v).toEqual({ cls: "internal", reason: "people_sources_failed" });
    expect(noCardSentenceAr(v)).toBe(PEOPLE_UNAVAILABLE_AR);
    expect(checkCustomerText(PEOPLE_UNAVAILABLE_AR, {}).issues).toEqual([]);
    expect(PEOPLE_UNAVAILABLE_AR).toMatch(/تعذّر الوصول/);
    expect(PEOPLE_UNAVAILABLE_AR).toMatch(/وليس لأنهم غير موجودين/);
  });
  it("companies answered and no people tool was called at all: internal, people_sources_not_tried", () => {
    expect(classifyNoCardEnd({ ...base, calls: [call("companies.source", "ok", 2)] })).toEqual({ cls: "internal", reason: "people_sources_not_tried" });
  });
  it("a people call that answered (rows or empty) is not a failure; a request with no people asked is unchanged; the ends of the other classes keep their sentence", () => {
    expect(classifyNoCardEnd({ ...base, claim: "empty", calls: [call("companies.source", "ok", 2), call("people.source.a", "empty")] }).reason).not.toMatch(/^people_sources_/);
    expect(classifyNoCardEnd({ ...base, calls: [call("companies.source", "ok", 2), call("people.source.a", "ok", 3)] }).reason).not.toMatch(/^people_sources_/);
    const { peopleAsked, peopleEndpointIds, ...none } = base; void peopleAsked; void peopleEndpointIds;
    expect(classifyNoCardEnd({ ...none, calls: [call("companies.source", "ok", 2)] }).reason).not.toMatch(/^people_sources_/);
    expect(noCardSentenceAr({ cls: "unsupported", reason: "not_served" })).not.toBe(PEOPLE_UNAVAILABLE_AR);
  });
  it("a catalog with NO people-of-company tool says nothing about the people sources (an empty set never turns an end into «not tried»)", () => {
    expect(classifyNoCardEnd({ ...base, peopleEndpointIds: new Set<string>(), calls: [call("companies.source", "ok", 2)] }).reason).not.toMatch(/^people_sources_/);
  });
  it("a call refused for OUR own limit keeps its earlier class (the people sentence is for failures to reach the people only)", () => {
    expect(classifyNoCardEnd({ ...base, calls: [call("companies.source", "ok", 2), call("people.source.a", "refused", 0, "over_budget:planning")] })).toEqual({ cls: "internal", reason: "planning_over_budget" });
  });
});

describe("F2 end to end: the planner understood the people, the old path ends with finish and no people tool answered", () => {
  const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
  const understanding = (asked: boolean) => ({
    decision: "plan", understanding_ar: "شركتان مقاولات في الرياض.", accepts_available: false,
    steps: [{ key: "companies", title_ar: "شركات المقاولات", platform: "companies", capability: COMPANIES_CAP, parent: "", deliver: true, count: { total: 2, all: false }, search_terms: ["مقاولات"] }],
    people_of_companies: { asked, title_ar: asked ? "مسؤولو الإدارة" : "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: asked ? ["phone"] : [] },
  });
  const run = async (asked: boolean) => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const notices: Array<{ kind: string; facts: Record<string, unknown> }> = [];
    const model: PlannerModel = async ({ tool }) => (tool.name === UNDERSTAND_TOOL ? { input: JSON.parse(JSON.stringify(understanding(asked))), costUsd: 0.001 } : null);
    const call = vi.fn(async (_o: TregCallOptions): Promise<TregCallResult> => { throw new Error("no paid call in this test"); });
    store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: REQUEST }));
    const driver = createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "لا أستطيع خدمة هذا الطلب بدقة ولم أجد مصدرًا." } }]);
    const deps: RunnerDeps = { store, client: money.client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, plannerModel: model, notify: async (n) => { notices.push({ kind: n.kind, facts: n.facts as unknown as Record<string, unknown> }); } };
    await runPlanning(deps, store.missions.get("msn_x")!);
    return { m: store.missions.get("msn_x")!, notices, money };
  };
  it("the customer reads «the people sources could not be reached right now», the admin is flagged with the reason, nothing is held", async () => {
    const r = await run(true);
    expect(r.m).toMatchObject({ status: "failed", summary_ar: PEOPLE_UNAVAILABLE_AR });
    expect(r.m.error).toMatch(/^admin: planning_failed class=internal reason=people_sources_not_tried/);
    expect(r.notices[0]).toMatchObject({ kind: "failed", facts: { cause: "internal", hasJob: false } });
    expect(r.money.calls).toHaveLength(0);
  });
  it("the control: the same end for a request whose people were NOT asked keeps the old class and sentence", async () => {
    const r = await run(false);
    expect(r.m.summary_ar).not.toBe(PEOPLE_UNAVAILABLE_AR);
    expect(r.m.error ?? "").not.toMatch(/people_sources_/);
  });
});
