import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { classifyNoCardEnd, EMPTY_SOURCE_AR, INTERNAL_PLANNING_AR, refusalSentenceAr, UNSUPPORTED_AR } from "../src/lib/agentMission/refusal";
import { defaultLanguageOf, filterVerdict, isEnabled } from "../src/lib/agentMission/filters";
import { customerPlanView, validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { customerMissionView, stagesView, type EventForCustomer } from "../src/lib/agentMission/customerView";
import { parentCountsOf } from "../src/lib/agentMission/parents";
import { missionFileTitleAr } from "../src/lib/agentMission/fileNames";
import { shortfallClauseAr } from "../agent/src/finalize";
import { buildMissionFiles } from "../agent/src/workbook";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { COMMENTS_ENDPOINT, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, fakeRecorder, postsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE FIVE-MISSION LIVE RUN OF 2026-10-29 (X, Facebook posts + comments, TikTok comments, Google Maps reviews, companies): the honest classes of a refusal, the truth about a parent stage, the one language rule, and the one download name.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const LATIN = /[A-Za-z]{2,}/;

// ------------------------------------------------------------------------------------------------------------------ A. the four honest classes
const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
function setup(responses: Array<TregCallResult | ((o: TregCallOptions) => TregCallResult)>) {
  const store = createMemoryStore();
  const money = fakeMoneyClient();
  const queue = [...responses];
  const call = vi.fn(async (o: TregCallOptions) => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return typeof n === "function" ? n(o) : n; });
  const rec = fakeRecorder();
  const notices: Array<{ kind: string; facts: Record<string, unknown> }> = [];
  const deps = (driver: ReturnType<typeof createFakeDriver>): RunnerDeps => ({ store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call, models: MODELS, resolveAccess: async () => NOT_ADMIN, notify: async (n) => { notices.push({ kind: n.kind, facts: n.facts as unknown as Record<string, unknown> }); } });
  return { store, money, call, deps, notices };
}
const REQUEST = "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات";
const plan = async (steps: FakeStep[], answers: Array<TregCallResult> = []) => {
  const t = setup(answers);
  t.store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: REQUEST }));
  const driver = createFakeDriver(steps);
  await runPlanning(t.deps(driver), t.store.missions.get("msn_x")!);
  const m = t.store.missions.get("msn_x")!;
  const view = customerMissionView({ mission: { id: m.id, status: m.status, question_ar: m.question_ar, plan_public: m.plan_public, reserved_points: null, unit_price_points: null, delivered_units: null, charged_points: null, summary_ar: m.summary_ar, files: null, created_at: "2026-10-29T08:00:00Z" }, events: [] });
  return { ...t, m, view, driver };
};
const SAY = "لا أستطيع خدمة هذا الطلب بدقة، وقد جرّبت مصادر عدة وأقل من ١٠ تعليقات لكل منشور ولم يُحسب أي مبلغ.";

describe("A. every no-card end is exactly one of four classes, each with its own sentence", () => {
  it("unsupported: no source was even tried; the customer's sentence is ours (no numbers), never «nothing found»", async () => {
    const r = await plan([{ tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: SAY } }]);
    expect(r.m).toMatchObject({ status: "unserved", summary_ar: UNSUPPORTED_AR, job_id: null });
    expect(r.view.endLineAr).toBe(UNSUPPORTED_AR);
    expect(r.view.endLineAr).not.toContain("لم نجد ما يطابق");
    expect(r.notices[0].kind).toBe("unserved");
    expect(r.m.error ?? null).toBeNull();
  });

  it("the model's free sentence (with numbers, as on the live Facebook mission) never replaces the class's sentence", async () => {
    const r = await plan([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: SAY } }]);
    expect(r.m.summary_ar).toBe(UNSUPPORTED_AR);
    expect(UNSUPPORTED_AR).not.toMatch(/[0-9٠-٩]/);
  });

  it("empty source: only when a REAL sample call returned nothing", async () => {
    const r = await plan([
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "غلاء", limit: 20 }, why: "the cheaper sources return no author or link fields in their catalog description" } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "empty", summary_ar: "لا نتائج." } },
    ], [tregResult({ output: { data: { items: [], nextCursor: null } } }, 0.001)]);
    expect(r.m).toMatchObject({ status: "unserved", summary_ar: EMPTY_SOURCE_AR });
    expect(r.view.endLineAr).toBe(EMPTY_SOURCE_AR);
    expect(r.notices[0]).toMatchObject({ kind: "unserved", facts: { cause: "empty" } });
  });

  it("«empty» claimed while a call returned rows is NOT empty: it is unsupported", async () => {
    const r = await plan([
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "غلاء", max_results: 5 }, why: "the fixture source is the one under test" } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "empty", summary_ar: "لا نتائج." } },
    ], [tregResult(postsPage(5), 0.025)]);
    expect(r.m).toMatchObject({ status: "unserved", summary_ar: UNSUPPORTED_AR });
  });

  it("internal: the planning ran out of its own source budget (the live Facebook mission): failed, hold never taken, the admin flagged, the customer told it was ours", async () => {
    // a 25-row page of a per-record source is estimated above the multi-stage planning budget: refused before the call
    const r = await plan([
      { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "غلاء", max_results: 25 }, why: "the fixture source is the one under test" } },
      { tool: "finish", args: { outcome: "cannot_serve", kind: "unsupported", summary_ar: SAY } },
    ]);
    expect(r.call).not.toHaveBeenCalled();
    expect(r.m.status).toBe("failed");
    expect(r.m.error).toMatch(/^admin: planning_failed class=internal reason=planning_over_budget/);
    expect(r.m.summary_ar).toBe(INTERNAL_PLANNING_AR);
    expect(r.view.endLineAr).toBe(INTERNAL_PLANNING_AR);
    expect(r.store.events.some((e) => e.counts?.adm_flag === 1)).toBe(true);
    expect(r.notices[0]).toMatchObject({ kind: "failed", facts: { cause: "internal", hasJob: false } });
    expect(r.money.calls).toHaveLength(0);
  });

  it("internal: the planning ended with no plan, no question and no ending", async () => {
    const r = await plan([{ tool: "report_progress", args: { message_ar: "أبحث عن مصدر", counts: { sources: 1 } } }]);
    expect(r.m.status).toBe("failed");
    expect(r.m.error).toMatch(/^admin: planning_failed class=internal reason=no_plan/);
    expect(r.m.summary_ar).toBe(INTERNAL_PLANNING_AR);
  });

  it("needs a detail: ONE question with 2 to 4 ready answers (a question without answers is refused)", async () => {
    const t = setup([]);
    t.store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: "هات أخبار عن صلاح" }));
    const driver = createFakeDriver([
      { tool: "ask_question", args: { question_ar: "أي صلاح تقصد؟" } },
      { tool: "ask_question", args: { question_ar: "أي صلاح تقصد؟", options_ar: ["لاعب كرة القدم", "شخص آخر"] } },
    ]);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_x")!);
    expect(driver.results[0].result.ok).toBe(false);
    expect(t.store.missions.get("msn_x")).toMatchObject({ status: "needs_input", question_ar: "أي صلاح تقصد؟" });
  });

  it("the classifier on its own: every class is reachable, and the four sentences are different, Arabic, with no number and no Latin word", () => {
    const real = (rows: number) => ({ phase: "planning", status: rows ? "ok" : "empty", rows_returned: rows });
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [] }).cls).toBe("unsupported");
    expect(classifyNoCardEnd({ claim: "empty", endedWithoutAnswer: false, calls: [real(0)] }).cls).toBe("empty_source");
    expect(classifyNoCardEnd({ claim: "empty", endedWithoutAnswer: false, calls: [real(0), real(3)] }).cls).toBe("unsupported");
    expect(classifyNoCardEnd({ claim: "empty", endedWithoutAnswer: false, calls: [] }).cls).toBe("unsupported");
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [real(5), { phase: "planning", status: "refused", refused_reason: "over_budget:planning" }] })).toMatchObject({ cls: "internal", reason: "planning_over_budget" });
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [{ phase: "planning", status: "refused", refused_reason: "daily_cap:cap" }] }).cls).toBe("internal");
    expect(classifyNoCardEnd({ claim: "unsupported", endedWithoutAnswer: false, calls: [{ phase: "planning", status: "failed" }, { phase: "planning", status: "refused", refused_reason: "source_unavailable:contextdev" }] })).toMatchObject({ cls: "internal", reason: "sources_failed" });
    expect(classifyNoCardEnd({ claim: null, endedWithoutAnswer: true, stop: "wall", calls: [] })).toMatchObject({ cls: "internal", reason: "no_plan(wall)" });
    const sentences = [refusalSentenceAr("unsupported"), refusalSentenceAr("internal"), refusalSentenceAr("empty_source")];
    expect(new Set(sentences).size).toBe(3);
    for (const s of sentences) { expect(s).toMatch(/[؀-ۿ]/); expect(s).not.toMatch(/[0-9٠-٩]/); expect(s).not.toMatch(LATIN); expect(s).toContain("ولم يُخصم منك شيء"); }
    expect(refusalSentenceAr("internal")).toContain("من جانبنا");
    expect(refusalSentenceAr("empty_source")).toContain("لم نجد");
    expect(refusalSentenceAr("unsupported")).not.toContain("لم نجد");
  });
});

describe("A. the planning does not spend its one budget on one source", () => {
  const ask = (q: string, rows: number): FakeStep => ({ tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: q, max_results: rows }, why: "the fixture source is the one under test" } });
  const run = async (request: string, steps: FakeStep[], answers: TregCallResult[]) => {
    const t = setup(answers);
    t.store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning", request_text: request }));
    const driver = createFakeDriver([{ tool: "catalog_search", args: { words: ["posts"], platform: "x", limit: 5 } }, ...steps, { tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا أستطيع خدمة هذا الطلب بدقة." } }]);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_x")!);
    return { t, calls: driver.results.filter((x) => x.tool === "treg_call") };
  };

  it("a third sample of a source that gave rows twice is refused (repeat_sample), costs nothing", async () => {
    const { t, calls } = await run("هات منشورات عن غلاء الأسعار", [ask("غلاء", 1), ask("غلاء الأسعار", 1), ask("ارتفاع الأسعار", 1)], [tregResult(postsPage(1), 0.005), tregResult(postsPage(1), 0.005)]);
    expect(calls.map((c) => (c.result as { ok?: boolean }).ok)).toEqual([true, true, false]);
    expect(calls[2].result).toMatchObject({ refused: "repeat_sample" });
    expect(t.call).toHaveBeenCalledTimes(2);
    expect((await t.store.listCalls("msn_x")).filter((c) => c.status === "refused").map((c) => c.refused_reason)).toEqual(["repeat_sample:planning"]);
    // a refusal for repeating is not one of the planning's own limits: the end is «unsupported», not our failure
    expect(t.store.missions.get("msn_x")!.status).toBe("unserved");
  });

  it("a parent and its children: the first job cannot spend the budget the next stage's first sample needs (stage_reserved)", async () => {
    // two calls of 0.025 estimate each: the third would pass 0.07 (0.10 less the 30% kept for the stage not yet sampled)
    const { t, calls } = await run(REQUEST, [ask("غلاء", 5), ask("غلاء الأسعار", 5), ask("ارتفاع الأسعار", 5)], [tregResult(postsPage(5), 0.025), tregResult(postsPage(5), 0.025)]);
    expect(calls.map((c) => (c.result as { ok?: boolean }).ok)).toEqual([true, true, false]);
    expect(calls[2].result).toMatchObject({ refused: "stage_reserved" });
    expect(t.call).toHaveBeenCalledTimes(2);
    expect((await t.store.listCalls("msn_x")).filter((c) => c.status === "refused").map((c) => c.refused_reason)).toEqual(["stage_reserved:planning"]);
  });
});

// ------------------------------------------------------------------------------------------------------------------ B. the truth about a parent stage
interface Pair { name: string; parent: string; child: string; parentNoun: string; counts: number[]; read: number; max: number; target: number }
const PAIRS: Pair[] = [
  { name: "TikTok videos and comments (the live run: 10+10+10+10+8+2)", parent: "فيديوهات تيك توك عن الأكل المصري", child: "التعليقات على كل فيديو", parentNoun: "فيديوهات", counts: [10, 10, 10, 10, 8, 2], read: 10, max: 10, target: 50 },
  { name: "Facebook posts and comments", parent: "بوستات فيسبوك عن غلاء الأسعار", child: "تعليقات كل بوست", parentNoun: "منشورات", counts: [10, 7, 3], read: 5, max: 5, target: 50 },
  { name: "Google Maps places and reviews", parent: "الأماكن", child: "التقييمات", parentNoun: "أماكن", counts: [12, 12, 6], read: 4, max: 5, target: 30 },
  { name: "companies and employees", parent: "الشركات", child: "الموظفون", parentNoun: "شركات", counts: [2, 2], read: 3, max: 3, target: 4 },
];
const stage = (key: string, title: string, parent: string | null, rows: number, deliver: boolean) => ({ key, title_ar: title, endpoint_id: "e", expected_rows: rows, planned_rows: rows, deliver, parent_key: parent, ...(parent ? { per_parent_rows: 10 } : {}), columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] });
const rowsFor = (p: Pair) => {
  const parents = Array.from({ length: p.read }, (_, i) => ({ id: `p${i}`, text: `أصل رقم ${i}` }));
  const children = p.counts.flatMap((n, i) => Array.from({ length: n }, (_, j) => ({ id: `c${i}_${j}`, parent_id: `p${i}`, text: `عنصر ${i} ${j}` })));
  return { parents, children };
};
const loadBook = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as unknown as ArrayBuffer); return wb; };

describe.each(PAIRS)("B. $name", (p) => {
  const plan = { summary_ar: "ملخص", stages: [stage("parents", p.parent, null, p.max, false), stage("children", p.child, "parents", p.target, true)], price: {} } as unknown as PricedPlan;
  const { parents, children } = rowsFor(p);
  const used = p.counts.length;

  it("the counts come from the item store: parents READ, and parents that have delivered children", () => {
    expect(parentCountsOf(plan, { parents, children })).toEqual({ stage_1_read: p.read, stage_1_used: used });
    // a plan with no parent stage has no such counts
    expect(parentCountsOf({ stages: [stage("a", "x", null, 1, true)] } as unknown as PricedPlan, { a: [] })).toEqual({});
  });

  it("the summary sheet says what was read and how many of them have results in the file; no «صف» or «سجل» anywhere in its notes", async () => {
    const wb = await loadBook((await buildMissionFiles(plan, { parents, children })).xlsx);
    const s = wb.getWorksheet("ملخص المهمة")!;
    const parentRow = s.getRow(2).values as unknown[];
    const childRow = s.getRow(3).values as unknown[];
    expect(String(parentRow[3])).toMatch(new RegExp(`^قُرئ [٠-٩]+، ومنها [٠-٩]+ لها نتائج في الملف$`));
    expect(String(parentRow[3])).toContain(`ومنها ${toAr(used)} لها نتائج`);
    expect(String(parentRow[4])).toBe(`حتى ${toAr(p.max)}`);
    expect(String(parentRow[2])).toContain("لم تُسلَّم");
    // the delivered stage keeps its numbers
    expect(childRow[3]).toBe(children.length);
    expect(childRow[4]).toBe(p.target);
    let text = "";
    s.eachRow((row) => row.eachCell((cell) => { text += ` ${String(cell.value)}`; }));
    expect(text).not.toMatch(/صف|سجل/);
    expect(String(childRow[5])).toContain("كل عنصر هنا تابع لعنصر في مرحلة");
  });

  it("the card says «حتى N» for the parent, which only feeds the next stage", () => {
    const view = stagesView({ stages: [{ key: "parents", title_ar: p.parent, expected_rows: p.max, deliver: false }, { key: "children", title_ar: p.child, expected_rows: p.target, deliver: true, parent_key: "parents" }] });
    expect(view.stages[0].rowsAr).toMatch(/^حتى [٠-٩]+ /);
    expect(view.stages[1].rowsAr).not.toMatch(/^حتى/);
    expect(view.stages[1].parentN).toBe(1);
    expect(view.stages[0].parentN).toBeNull();
    expect(view.total).toBe(p.target);
  });

  it("the tracker: while it works «قُرئ N، والحد الأقصى M»; at the end «قُرئ N، ومنها K لها نتائج في ملفك»; never «N من N» for the parent", () => {
    const planPublic = { summary_ar: "ملخص", stages: [{ key: "parents", title_ar: p.parent, expected_rows: p.max, deliver: false, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }, { key: "children", title_ar: p.child, expected_rows: p.target, deliver: true, parent_key: "parents", columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { max_charge_points: 200, reserve_points: 200 } };
    const at = (s: number) => new Date(Date.parse("2026-10-29T08:00:00Z") + s * 1000).toISOString();
    const ev = (id: number, s: number, counts: Record<string, number>, kind = "progress"): EventForCustomer => ({ id, kind, message_ar: "يواصل الوكيل العمل", counts, created_at: at(s) });
    const running = customerMissionView({
      mission: { id: "m", status: "executing", question_ar: null, plan_public: planPublic, reserved_points: 200, unit_price_points: 4, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: at(0) },
      events: [ev(1, 5, { stage: 1, saved: Math.min(3, p.max), planned: p.max })], now: Date.parse(at(20)),
    });
    expect(running.steps[0].countAr).toMatch(/^قُرئ .+، والحد الأقصى [٠-٩]+$/);
    const done = customerMissionView({
      mission: { id: "m", status: "completed", question_ar: null, plan_public: planPublic, reserved_points: 200, unit_price_points: 4, delivered_units: children.length, charged_points: 200, summary_ar: null, files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: at(0) },
      events: [ev(1, 5, { stage: 1, saved: p.read, planned: p.max }), ev(2, 50, { delivered: children.length, charged_points: 200, stage_1_rows: p.read, stage_2_rows: children.length, stage_1_read: p.read, stage_1_used: used }, "result")], now: Date.parse(at(60)),
    });
    expect(done.steps[0].countAr).toMatch(new RegExp(`^قُرئ .+، ومنها ${toAr(used)} لها نتائج في ملفك$`));
    expect(done.steps[0].countAr).not.toMatch(/ من /);
    expect(done.steps[1].countAr).toContain(`من ${toAr(p.target)}`);
  });
});
const toAr = (n: number) => String(n).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

// ------------------------------------------------------------------------------------------------------------------ C. the one language rule
const lookup = (requestText: string): PlanLookup => ({
  call: (id: string) => (id === "call_0001" ? { endpointId: "src.search", ok: true, rows: 10, costUsd: 0.001, params: { query: "q" }, durationMs: 100 } : null),
  evidenceText: (id: string) => (id === "call_0001" ? JSON.stringify([{ id: "1", text: "x" }]) : id === "out_0001" ? JSON.stringify([{ id: "1", text: "نص", language: "ar", is_reply: false }]) : null),
  endpointAllowed: () => true, requestText,
} as unknown as PlanLookup);
const textStage = (title: string, extra: Record<string, unknown> = {}) => ({
  key: "items", title_ar: title, endpoint_id: "src.search", expected_rows: 50, parent_key: null, deliver: true,
  columns: [{ key: "text", title_ar: "النص" }, { key: "language", title_ar: "اللغة" }], sample_rows: [{ id: "1", text: "نص", language: "ar" }],
  measured_by: ["call_0001"], relevance: { subject_ar: "الموضوع", terms: ["نص"], text_columns: ["text"], min_own_words: 0 }, yield_from: "out_0001", ...extra,
});
const planFor = (request: string, title: string, extra: Record<string, unknown> = {}) => validateAndPricePlan({ summary_ar: "ستحصل على عناصر عن الموضوع مع نص كل عنصر.", stages: [textStage(title, extra)] }, lookup(request));

describe.each([
  ["X tweets", "هات ٥٠ تغريدة عن منتخب مصر لكرة القدم", "التغريدات"],
  ["TikTok comments", "هات ٥٠ تعليق من فيديوهات تيك توك عن الأكل المصري", "التعليقات"],
  ["Facebook posts", "هات ٥٠ بوست فيسبوك عن غلاء الأسعار في مصر", "المنشورات"],
  ["Google Maps reviews", "هات ٣٠ تقييم من جوجل ماب لمطعم كشري أبو طارق في القاهرة", "التقييمات"],
])("C. an Arabic request gets Arabic items by default: %s", (_name, request, title) => {
  it("the plan carries an enabled Arabic language filter that code added; the card says it; the editor can switch it off", () => {
    const r = planFor(request, title);
    expect(r.ok, r.ok ? "" : (r as { issues: string[] }).issues.join(" | ")).toBe(true);
    if (!r.ok) return;
    const f = r.plan.stages[0].filters!.find((x) => x.kind === "language")!;
    expect(f).toMatchObject({ lang: "ar" });
    expect(isEnabled(f)).toBe(true);
    expect(f.field).toBe("language");
    const view = customerPlanView(r.plan);
    expect(view.assumptions_ar).toContain("باللغة العربية فقط.");
    expect(view.edit!.stages[0].filters.find((x: { kind: string }) => x.kind === "language")).toMatchObject({ enabled: true, lang: "ar" });
  });

  it("the filter enforces it: an English item of the source is left out, an Arabic one, a star-only one and an emoji are not", () => {
    const f = { kind: "language" as const, lang: "ar" as const, field: "language" };
    const ctx = { textKey: "text", now: 0 };
    expect(filterVerdict([f], { text: "so good", language: "en" }, ctx)).toBe("filter_language");
    expect(filterVerdict([f], { text: "Best food in Cairo ever", language: "" }, ctx)).toBe("filter_language");
    expect(filterVerdict([f], { text: "أكل ممتاز جدًا", language: "ar" }, ctx)).toBeNull();
    expect(filterVerdict([f], { text: "", language: "" }, ctx)).toBeNull();
    expect(filterVerdict([f], { text: "👍🏽", language: "" }, ctx)).toBeNull();
  });
});

describe("C. the rest of the language rule", () => {
  it("the request decides: English request, English items; a request for another language or for all of them, no default; a plan's own filter is kept; a stage that is not text gets none", () => {
    expect(defaultLanguageOf("هات ٥٠ تعليق عن الأكل المصري")).toBe("ar");
    expect(defaultLanguageOf("get me 50 comments about Egyptian food")).toBe("en");
    expect(defaultLanguageOf("هات ٥٠ تعليق عن الأكل المصري بالإنجليزي")).toBeNull();
    expect(defaultLanguageOf("هات ٥٠ تعليق عن الأكل المصري بكل اللغات")).toBeNull();
    expect(defaultLanguageOf("هات ٥٠ تعليق عن الأكل المصري English only")).toBeNull();
    expect(defaultLanguageOf("")).toBeNull();
    const en = planFor("get me 50 comments about Egyptian food", "التعليقات");
    expect(en.ok && en.plan.stages[0].filters!.find((x) => x.kind === "language")).toMatchObject({ lang: "en" });
    expect(en.ok && isEnabled(en.plan.stages[0].filters!.find((x) => x.kind === "language")!)).toBe(true);
    const other = planFor("هات ٥٠ تعليق عن الأكل المصري بالإنجليزي", "التعليقات");
    expect(other.ok && isEnabled(other.plan.stages[0].filters!.find((x) => x.kind === "language")!)).toBe(false);
    const own = planFor("هات ٥٠ تعليق عن الأكل المصري", "التعليقات", { filters: [{ kind: "language", lang: "en" }] });
    expect(own.ok && own.plan.stages[0].filters!.find((x) => x.kind === "language")).toMatchObject({ lang: "en" });
    const companies = planFor("عايز ١٠ شركات مقاولات في مصر", "شركات المقاولات");
    expect(companies.ok && isEnabled(companies.plan.stages[0].filters!.find((x) => x.kind === "language")!)).toBe(false);
  });

  it("when the source gives too few items in that language, the shortfall reason says so", () => {
    for (const stop of [null, "source_exhausted", "no_new_items", "target_reached"] as const) expect(shortfallClauseAr(stop, { pending: 0, stop: null, languageLeftOut: 39 })).toBe("لأن المصادر لم تعطِ ما يكفي من المحتوى باللغة المحددة في خطتك");
    // another honest reason keeps its own words; with nothing left out by language the old sentence is unchanged
    expect(shortfallClauseAr("time_limit", { pending: 0, stop: null, languageLeftOut: 39 })).toBe("لأن الوقت المخصص لهذه المهمة انتهى");
    expect(shortfallClauseAr("source_exhausted", { pending: 0, stop: null })).toBe("لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب");
  });
});

// ------------------------------------------------------------------------------------------------------------------ E. the download name of «طلباتي»
const state = vi.hoisted(() => ({ signed: [] as Array<{ path: string; download?: string }>, mission: null as any }));
vi.mock("../src/lib/supabase/server", () => {
  const chain = (result: () => any): any => { const c: any = { select: () => c, eq: () => c, not: () => c, order: () => c, limit: () => c, in: () => c, update: () => c, insert: () => c, upsert: () => c, single: async () => result(), maybeSingle: async () => result(), then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject) }; return c; };
  return {
    createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: "owner-1", app_metadata: {} } }, error: null })) } })),
    createAdminClient: vi.fn(() => ({
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        if (table === "jobs") return chain(() => ({ data: { id: "job_quote_e3a", user_id: "owner-1", status: "completed", delivered_units: 50, charged_credits: 200, reserved_credits: 200, target_volume_max: 50, params: {}, endpoint_id: "agent-mission" }, error: null }));
        if (table === "artifact_versions") return chain(() => ({ data: [{ id: "v1", version_number: 1, file_id_xlsx: "owner-1/job_quote_e3a/result.xlsx", file_id_csv: "owner-1/job_quote_e3a/result.csv", file_id_pdf: null, created_at: "2026-10-29T07:56:29Z", job_id: "job_quote_e3a", user_id: "owner-1" }], error: null }));
        if (table === "missions") return chain(() => ({ data: state.mission, error: null }));
        return chain(() => ({ data: [], error: null }));
      },
      storage: { from: () => ({ download: async () => ({ data: null, error: new Error("nf") }), upload: async () => ({ error: null }), createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { state.signed.push({ path, download: o?.download }); return { data: { signedUrl: "https://signed.example/x" }, error: null }; } }) },
    })),
  };
});
import { GET as downloadRoute } from "../src/app/api/jobs/[id]/download/route";
import { customerFileLink } from "../src/lib/agentMission/customerActions";
import { fileLink } from "../src/lib/agentMission/adminActions";

describe.each([
  ["X tweets", "هات ٥٠ تغريدة عن منتخب مصر لكرة القدم", "التغريدات", "تغريدات عن منتخب مصر لكرة القدم"],
  ["TikTok comments", "هات ٥٠ تعليق من فيديوهات تيك توك عن الأكل المصري", "التعليقات", "تعليقات عن الأكل المصري"],
  ["Google Maps reviews", "هات ٣٠ تقييم من جوجل ماب لمطعم كشري أبو طارق في القاهرة", "التقييمات", "تقييمات عن مطعم كشري أبو طارق"],
])("E. the same mission-based name on every download route: %s", (_n, request, stageTitle, expectedWhat) => {
  const plan = { stages: [{ key: "s", title_ar: stageTitle, deliver: true }] };
  const at = "2026-10-29T07:56:00Z";
  const named = (stored: boolean) => ({
    files: [{ kind: "xlsx", name: "result.xlsx", path: "result/result.xlsx" }, { kind: "csv", name: "result.csv", path: "result/result.csv" }].map((f) => (stored ? { ...f, download_name: `${missionFileTitleAr({ plan, requestText: request, delivered: 50, date: new Date(at) })}.${f.kind}` } : f)),
    plan, request_text: request, delivered_units: 50, updated_at: at, user_id: "owner-1", id: "msn_1",
  });

  it.each([[true], [false]])("stored name: %s — «طلباتي» (the route's JSON and its signed link), the panel and the admin give one name, never «result.xlsx»", async (stored) => {
    state.mission = named(stored);
    for (const kind of ["xlsx", "csv"]) {
      state.signed = [];
      const res = await downloadRoute(new NextRequest(`https://x.example/api/jobs/job_quote_e3a/download?format=${kind}`, { headers: { authorization: "Bearer t" } }), { params: Promise.resolve({ id: "job_quote_e3a" }) });
      const json = await res.json();
      expect(json.success).toBe(true);
      const client: any = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.mission, error: null }) }) }) }), storage: { from: () => ({ createSignedUrl: async (path: string, _t: number, o?: { download?: string }) => { state.signed.push({ path, download: o?.download }); return { data: { signedUrl: "https://signed.example/y" }, error: null }; } }) } };
      await customerFileLink(client, { id: "msn_1", userId: "owner-1", name: `result.${kind}` });
      await fileLink(client, { id: "msn_1", name: `result.${kind}` });
      const names = [json.downloadFileName, ...state.signed.map((s) => s.download)];
      expect(new Set(names).size, JSON.stringify(names)).toBe(1);
      expect(names[0]).toBe(`${expectedWhat} - ${toAr(kind === "xlsx" || kind === "csv" ? 50 : 0)} - ٢٩ أكتوبر ٢٠٢٦.${kind}`);
      expect(names[0]).not.toMatch(/^result\./);
      // the route signed its own link with the same name (what the browser saves when the page falls back to the link)
      expect(state.signed[0].download).toBe(json.downloadFileName);
    }
  });

  it("the requests page saves the file under the name the route returned (the name of the signed link), and every route calls one function", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain("a.download = payload.downloadFileName");
    expect(page).toContain("/api/jobs/${job.$id}/download?format=${ext}");
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("link.download = payload.downloadFileName");
  });
});

describe("E. a request about a place names the file after the place", () => {
  it("«تقييمات عن مطعم كشري أبو طارق - ٣٠ - …», not the bare noun", () => {
    const plan = { stages: [{ key: "s", title_ar: "التقييمات", deliver: true }] };
    expect(missionFileTitleAr({ plan, requestText: "هات ٣٠ تقييم من جوجل ماب لمطعم كشري أبو طارق في القاهرة", delivered: 30, date: new Date("2026-10-29T08:00:00Z") })).toBe("تقييمات عن مطعم كشري أبو طارق - ٣٠ - ٢٩ أكتوبر ٢٠٢٦");
    expect(missionFileTitleAr({ plan, requestText: "هات ٣٠ تقييم", delivered: 30, date: new Date("2026-10-29T08:00:00Z") })).toBe("تقييمات - ٣٠ - ٢٩ أكتوبر ٢٠٢٦");
  });
});
