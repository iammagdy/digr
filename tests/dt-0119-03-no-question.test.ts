import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../src/lib/agentMission/childSources";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { acceptOf } from "../agent/src/llmPlanner/run";
import { planWithLlm, understandRequest, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_SCHEMA, UNDERSTAND_SYSTEM, UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { NOT_ADMIN, USER_ID, fakeRecorder } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

/**
 * DT-20261119-03 (live after #578): the model asked the customer instead of making a card: «الأرقام الشخصية للمسؤولين ممكن تكون بيانات حساسة. تحب نجيب إيه بالظبط؟» (planner path) and «… تواريخ انتهاء مناصب … كيف تحب
 * نكمل؟» (old agent path). THE RULE: asking is a permission the model's own answer must earn: `missing` names an essential input that has NO value anywhere in the customer's words (items, place, source, platform), and
 * a request whose people of the companies the planner understood can only miss a place. Sensitivity, data format, dates and «how to continue» have no value in that set. The model is scripted: these tests prove what CODE does.
 */
const catalog = loadTregCatalog();
const COMPANIES_CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
const LIVE1 = "عايز شركتين مقاولات في الرياض ومسؤولي الإدارة فيهم بأرقامهم الشخصية";
const SENSITIVE = { question_ar: "الأرقام الشخصية للمسؤولين ممكن تكون بيانات حساسة. تحب نجيب إيه بالظبط؟", options_ar: ["أسماء المسؤولين والمسمى وأرقام العمل المعلنة", "أرقام الشركة المعلنة على موقعها فقط", "الأرقام الشخصية للمسؤولين نفسهم"] };
const peopleAsk = (asked: boolean, kinds: string[] = ["phone"]) => ({ asked, title_ar: asked ? "مسؤولو الإدارة" : "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: asked ? kinds : [] });
const askAnswer = (over: Record<string, unknown> = {}) => ({ decision: "ask", understanding_ar: "شركتان مقاولات في الرياض.", ...SENSITIVE, accepts_available: false, steps: [], people_of_companies: peopleAsk(true), missing: [], ...over });
const planAnswer = (over: Record<string, unknown> = {}) => ({
  decision: "plan", understanding_ar: "شركتان مقاولات في الرياض.", accepts_available: false, missing: [],
  steps: [{ key: "companies", title_ar: "شركات المقاولات", platform: "companies", capability: COMPANIES_CAP, parent: "", deliver: true, count: { total: 2, all: false }, search_terms: ["مقاولات"] }],
  people_of_companies: peopleAsk(true), ...over,
});
interface Seen { schemaDecision: unknown; system: string; user: string }
function sequence(answers: unknown[]): { model: PlannerModel; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const model: PlannerModel = async ({ tool, system, user }) => {
    if (tool.name !== UNDERSTAND_TOOL) return null;
    seen.push({ schemaDecision: ((tool.schema as any).properties.decision.enum as unknown[]).join("|"), system, user });
    const next = answers[Math.min(i, answers.length - 1)]; i += 1;
    return { input: JSON.parse(JSON.stringify(next)), costUsd: 0.001 };
  };
  return { model, seen };
}
const depsOf = (model: PlannerModel): LlmPlannerDeps => ({ model, catalog, access: NOT_ADMIN, today: "2026-11-19", probe: async () => { throw new Error("no paid call"); }, readPage: async () => null, accept: acceptOf(catalog, NOT_ADMIN) });

describe("the schema carries the permission: `missing` is required, a closed set of input kinds", () => {
  it("UNDERSTAND_SCHEMA requires `missing` (array of the enum items, place, source, platform) and the prompt says it is the ONLY reason to ask", () => {
    const s = UNDERSTAND_SCHEMA as any;
    expect(s.required).toContain("missing");
    expect(s.properties.missing).toMatchObject({ type: "array", items: { type: "string", enum: ["items", "place", "source", "platform"] } });
    expect(UNDERSTAND_SYSTEM).toMatch(/missing/);
  });
});

describe("R1 planner path: an «ask» the answer does not earn is never shown to the customer", () => {
  it("live 1: ask + the sensitivity question + missing [] → the model is asked ONCE more with a schema that has no «ask» and the «decide it» sentence; the plan comes back; no question", async () => {
    const m = sequence([askAnswer(), planAnswer()]);
    const r = await planWithLlm({ words: [LIVE1], request: "" }, depsOf(m.model));
    expect(r.kind).not.toBe("question");
    expect(r).toMatchObject({ kind: "cannot", detail: "handed_over" });
    expect(m.seen).toHaveLength(2);
    expect(m.seen[0].schemaDecision).toBe("plan|ask|cannot");
    expect(m.seen[1].schemaDecision).toBe("plan|cannot");
    expect(m.seen[1].user).toMatch(/decide it/i);
    expect(m.seen[0].user).not.toMatch(/decide it/i);
  });
  it("cross-check (Gate 1 P1-1): people of the companies were asked, so `items` and `platform` are contradicted by the model's own answer: ask + missing [items] is refused too; only `place` can stand", async () => {
    for (const missing of [["items"], ["platform"], ["items", "platform"], ["bogus"], ["source"]]) {
      const m = sequence([askAnswer({ missing }), planAnswer()]);
      const r = await planWithLlm({ words: [LIVE1], request: "" }, depsOf(m.model));
      expect(r.kind, JSON.stringify(missing)).not.toBe("question");
      expect(m.seen, JSON.stringify(missing)).toHaveLength(2);
    }
    const place = sequence([askAnswer({ missing: ["place"] })]);
    const q = await planWithLlm({ words: ["عايز شركات مقاولات ومسؤوليها"], request: "" }, depsOf(place.model));
    expect(q.kind).toBe("question");
    expect(place.seen).toHaveLength(1);
  });
  it("a kind outside the closed set is no permission: a non-people ask with missing [\"bogus\"] is refused and retried like an empty one", async () => {
    const m = sequence([askAnswer({ people_of_companies: peopleAsk(false), missing: ["bogus"], question_ar: "تحب إيه؟" }), planAnswer({ people_of_companies: peopleAsk(false) })]);
    const r = await planWithLlm({ words: ["هات ٥٠ تغريدة"], request: "" }, depsOf(m.model));
    expect(r.kind).not.toBe("question");
    expect(m.seen).toHaveLength(2);
  });
  it("the Dubai sentence (5 companies, managers, e-mails): the same flow, no question", async () => {
    const m = sequence([askAnswer({ people_of_companies: peopleAsk(true, ["email"]), question_ar: "الإيميلات ممكن تكون محمية. تحب إيه؟" }), planAnswer({ people_of_companies: peopleAsk(true, ["email"]) })]);
    const r = await planWithLlm({ words: ["هات ٥ شركات برمجة في دبي ومديرينهم بإيميلاتهم"], request: "" }, depsOf(m.model));
    expect(r.kind).not.toBe("question");
    expect(m.seen).toHaveLength(2);
  });
  it("a genuinely ambiguous request keeps its ONE question: «عايز شركات» with nothing said about kind or place (missing items + place), and a non-people request missing the source", async () => {
    const a = sequence([askAnswer({ people_of_companies: peopleAsk(false), missing: ["items", "place"], question_ar: "أي نوع شركات وفي أي مكان؟", options_ar: ["مقاولات", "برمجة"] })]);
    const r = await planWithLlm({ words: ["عايز شركات"], request: "" }, depsOf(a.model));
    expect(r).toMatchObject({ kind: "question", question_ar: "أي نوع شركات وفي أي مكان؟" });
    expect(a.seen).toHaveLength(1);
    const b = sequence([askAnswer({ people_of_companies: peopleAsk(false), missing: ["source"], question_ar: "أي حساب تقصد؟", options_ar: ["حساب الوزارة", "حساب آخر"] })]);
    expect((await planWithLlm({ words: ["هات تغريدات الوزارة"], request: "" }, depsOf(b.model))).kind).toBe("question");
  });
  it("a non-people «ask» with missing [] is refused too (the rule is for every request)", async () => {
    const m = sequence([askAnswer({ people_of_companies: peopleAsk(false), missing: [], question_ar: "تحب إيه بالظبط؟" }), planAnswer({ people_of_companies: peopleAsk(false) })]);
    const r = await planWithLlm({ words: ["هات ٥٠ تغريدة"], request: "" }, depsOf(m.model));
    expect(r.kind).not.toBe("question");
    expect(m.seen).toHaveLength(2);
  });
  it("a model that IGNORES the no-ask schema and asks again ends as `ask_refused` (never a question), carrying its understanding; at most 2 model calls; a plan answer or a bad first answer is untouched", async () => {
    const m = sequence([askAnswer(), askAnswer()]);
    const r = await planWithLlm({ words: [LIVE1], request: "" }, depsOf(m.model));
    expect(r).toMatchObject({ kind: "cannot", detail: "ask_refused" });
    expect((r as { understanding: unknown }).understanding).not.toBeNull();
    expect(m.seen).toHaveLength(2);
    const bad = sequence([{ decision: "plan", understanding_ar: "x", steps: [] , missing: [] }, askAnswer()]);
    const r2 = await planWithLlm({ words: [LIVE1], request: "" }, depsOf(bad.model));
    expect(r2.kind).not.toBe("question");
    expect(bad.seen).toHaveLength(2);
    const ok = sequence([planAnswer()]);
    await planWithLlm({ words: [LIVE1], request: "" }, depsOf(ok.model));
    expect(ok.seen).toHaveLength(1);
  });
  it("understandRequest: an answer without `missing` (an older fixture) that asks counts as empty: it is retried, never shown", async () => {
    const legacy = { ...askAnswer() } as Record<string, unknown>; delete legacy.missing;
    const m = sequence([legacy, planAnswer()]);
    const got = await understandRequest({ words: [LIVE1], request: "" }, { model: m.model, catalog, access: NOT_ADMIN, today: "2026-11-19" });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.decision).toBe("plan");
  });
});

describe("through runPlanning (Gate 1 P1-2, P1-3, P1-4): the customer's mission never holds the question", () => {
  const run = async (answers: unknown[], request: string) => {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const rec = fakeRecorder();
    const m = sequence(answers);
    const call = vi.fn(async (_o: TregCallOptions): Promise<TregCallResult> => { throw new Error("no paid call in this test"); });
    store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: request }));
    // the old agent path, if it is reached, tries to ask the very same question first, then ends honestly
    const driver = createFakeDriver([
      { tool: "ask_question", args: { question_ar: "وجدنا شركات مقاولات في جدة، لكن المصدر يرجع أيضًا تواريخ انتهاء مناصب لبعض الأشخاص. كيف تحب نكمل؟", options_ar: ["الشركات فقط", "الشركات والمديرين مع التواريخ", "المديرين من غير أرقام"] } },
      ...Array.from({ length: 3 }, () => ({ tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: "لا أستطيع خدمة هذا الطلب بدقة ولم أجد مصدرًا." } })),
    ]);
    const deps: RunnerDeps = { store, client: money.client, catalog, driver, recorder: rec.recorder, commit: rec.commit, call, models: { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" }, resolveAccess: async () => NOT_ADMIN, plannerModel: m.model, notify: async () => undefined };
    await runPlanning(deps, store.missions.get("msn_x")!);
    return { mission: store.missions.get("msn_x")!, events: store.events, driver, seen: m.seen, money };
  };
  const noQuestion = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.mission.status).not.toBe("needs_input");
    expect(r.mission.question_ar ?? null).toBeNull();
    expect(r.events.some((e) => e.kind === "question")).toBe(false);
    expect(JSON.stringify([r.mission.question_ar, r.mission.plan_public, r.events])).not.toMatch(/حساسة|تواريخ انتهاء/);
    expect(r.money.calls).toHaveLength(0);
  };
  it("live 1 end to end: the first answer asks (sensitivity), the retry plans → handed over; the old path's own attempt to ask is refused; no question anywhere", async () => {
    const r = await run([askAnswer(), planAnswer()], LIVE1);
    noQuestion(r);
    expect(r.seen).toHaveLength(2);
    expect(r.driver.results.find((x) => x.tool === "ask_question")?.result).toMatchObject({ ok: false });
  });
  it("P1-2: a model that keeps asking (`ask_refused`) is NOT shown as a question and does NOT reach an old path that may ask: the old path runs with the planner's understanding and its ask is refused", async () => {
    const r = await run([askAnswer(), askAnswer()], LIVE1);
    noQuestion(r);
    expect(r.mission.status).toBe("unserved");
    expect(r.mission.summary_ar).toContain("لم يُخصم منك شيء");
    expect(r.driver.results.find((x) => x.tool === "ask_question")).toBeUndefined();
  });
  it("P1-3: a bad first answer then an ask-without-missing second answer: still no question (the planner ran, so the old path may not ask)", async () => {
    const r = await run([{ decision: "plan", understanding_ar: "x", steps: [], missing: [] }, askAnswer()], LIVE1);
    noQuestion(r);
    expect(r.mission.status).toBe("unserved");
    expect(r.mission.summary_ar).toContain("لم يُخصم منك شيء");
    expect(r.driver.results.find((x) => x.tool === "ask_question")).toBeUndefined();
  });
  it("the planner RAN but could not be read at all (two unusable answers, no understanding): the old path is still not allowed to ask (`plannerRan`)", async () => {
    const unreadable = { decision: "plan", understanding_ar: "x", steps: [], missing: [] };
    const r = await run([unreadable, unreadable], LIVE1);
    noQuestion(r);
    expect(r.mission.status).toBe("unserved");
    expect(r.mission.summary_ar).toContain("لم يُخصم منك شيء");
    expect(r.driver.results.find((x) => x.tool === "ask_question")).toBeUndefined();
  });
  it("the control: a genuinely ambiguous request is shown as ONE question (needs_input), as before", async () => {
    const r = await run([askAnswer({ people_of_companies: peopleAsk(false), missing: ["items", "place"], question_ar: "أي نوع شركات وفي أي مكان؟", options_ar: ["مقاولات", "برمجة"] })], "عايز شركات");
    expect(r.mission).toMatchObject({ status: "needs_input", question_ar: "أي نوع شركات وفي أي مكان؟" });
  });
});
