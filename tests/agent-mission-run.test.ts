import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { approveMission, repriceStoredPlan } from "../src/lib/agentMission/lifecycle";
import { executionBudgetUsd } from "../src/lib/agentMission/price";
import { AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD, AGENT_MODEL_PLANNING_ESTIMATE_USD } from "../src/lib/agentMission/constants";
import { createFakeDriver, type FakeStep } from "../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { runExecution, runPlanning, type RunnerDeps } from "../agent/src/runMission";
import { COMMENTS_ENDPOINT, NOT_ADMIN, POSTS_ENDPOINT, USER_ID, commentsPage, fakeRecorder, postsPage, tregResult } from "./helpers/agentHarness";
import { fakeMoneyClient } from "./helpers/agentMoney";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";
import type { TregCallOptions, TregCallResult } from "../src/functions/shared/tregClient";

// zero real calls: a real network call from anywhere in these tests is a failure
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const MODELS = { planning: "claude-haiku-5-5", execution: "claude-haiku-5-5" };
const idOf = (r: Array<{ tool: string; result: Record<string, unknown> }>, n: number) => String(r.filter((x) => x.tool === "treg_call")[n]?.result.call_id);

function setup(responses: Array<TregCallResult | ((o: TregCallOptions) => TregCallResult)>, store = createMemoryStore(), money = fakeMoneyClient()) {
  const queue = [...responses];
  const call = vi.fn(async (o: TregCallOptions) => { const n = queue.shift(); if (!n) throw new Error("no fake answer left"); return typeof n === "function" ? n(o) : n; });
  const rec = fakeRecorder();
  const deps = (driver: ReturnType<typeof createFakeDriver>): RunnerDeps => ({ store, client: money.client, catalog: loadTregCatalog(), driver, recorder: rec.recorder, commit: rec.commit, call, models: MODELS, resolveAccess: async () => NOT_ADMIN });
  return { store, money, call, rec, deps };
}

/** The planning transcript of a fake model: look at the catalog, sample a parent source and a child source, build sample rows with code, propose a two-stage plan. */
const planningScript = (overrides: { stages?: (r: any[]) => unknown[] } = {}): FakeStep[] => [
  { tool: "report_progress", args: { message_ar: "أبحث في المصادر المتاحة عن أرخص مصدر مناسب", counts: { sources: 3 } } },
  { tool: "catalog_search", args: { words: ["posts", "search"], platform: "x", limit: 5 } },
  { tool: "describe_endpoint", args: { id: POSTS_ENDPOINT } },
  { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 5 }, why: "the fixture source is the one under test" } },
  { tool: "treg_call", args: { endpoint_id: COMMENTS_ENDPOINT, params: { url: "https://x.example/p/9000" }, why: "the fixture source is the one under test" } },
  { tool: "run_code", args: { code: "return inputs.call_0001.data.slice(0, 1).map(r => ({ id: r.id, text: r.text, url: r.url }))", files: ["call_0001"] } },
  { tool: "propose_plan", args: (r) => ({
    summary_ar: "ستحصل على المنشورات ثم تعليقات كل منشور في ورقتين مرتبطتين بمعرّف المنشور.",
    stages: overrides.stages ? overrides.stages(r) : [
      { key: "posts", title_ar: "المنشورات", endpoint_id: POSTS_ENDPOINT, expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }], sample_rows: [{ id: "9000", text: "post 0", url: "https://x.example/p/9000" }], measured_by: [idOf(r, 0)], relevance: aboutWords(["post"]), yield_from: firstOutputId(r) },
      { key: "comments", title_ar: "التعليقات", endpoint_id: COMMENTS_ENDPOINT, expected_rows: 200, parent_key: "posts", per_parent_rows: 12, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "comment 0" }], measured_by: [idOf(r, 1)] },
    ],
  }) },
];

const planningResponses = () => [tregResult(postsPage(5), 0.025), tregResult(commentsPage("9000", 12), 0.00144)];

describe("PLANNING with a fake model transcript", () => {
  it("samples, looks at real rows, and proposes a plan whose price is computed by code from the measured charges", async () => {
    const t = setup(planningResponses());
    t.store.missions.set("msn_p1", newMission({ id: "msn_p1", user_id: USER_ID, request_text: "أريد منشورات عن القهوة مع تعليقاتها", status: "planning" }));
    const driver = createFakeDriver(planningScript());
    await runPlanning(t.deps(driver), t.store.missions.get("msn_p1")!);

    const m = t.store.missions.get("msn_p1")!;
    expect(driver.results.filter((r) => r.tool === "propose_plan")[0].result.ok).toBe(true);
    expect(m.status).toBe("plan_ready");
    expect(m.planning_model).toBe("claude-haiku-5-5");
    expect(m.planning_llm_usd).toBeGreaterThan(0);
    // measured: posts 0.025 / 5 rows = 0.005 a row; comments 0.00144 / 12 rows = 0.00012 a row
    const plan = m.plan!;
    expect(plan.stages[0].measured_cost_per_row_usd).toBeCloseTo(0.005, 9);
    expect(plan.stages[1].measured_cost_per_row_usd).toBeCloseTo(0.00012, 9);
    expect(plan.price.totalCostUsd).toBeCloseTo(20 * 0.005 + 200 * 0.00012, 9);
    expect(plan.price.deliveredRows).toBe(220);
    // the one pricing rule: provider cost PLUS the estimated model cost (one planning, one execution per stage) per delivered row, x 5,500 (the old line was provider cost alone: ((20 * 0.005 + 200 * 0.00012) / 220) * 5500)
    expect(plan.price.unitPricePoints).toBeCloseTo(((20 * 0.005 + 200 * 0.00012 + AGENT_MODEL_PLANNING_ESTIMATE_USD + 2 * AGENT_MODEL_EXECUTION_PER_STAGE_ESTIMATE_USD) / 220) * 5500, 4);
    expect(m.reserved_points).toBe(plan.price.reservePoints);
    expect(m.unit_price_points).toBe(plan.price.unitPricePoints);
    // what the model was told after propose_plan carries no price
    expect(JSON.stringify(driver.results.filter((r) => r.tool === "propose_plan")[0].result)).not.toMatch(/\d/);
    // every real call went through the fake only, and was recorded with its actual charge
    expect(t.call).toHaveBeenCalledTimes(2);
    expect(t.rec.rows.map((r) => r.committedUsd)).toEqual([0.025, 0.00144]);
    expect(m.planning_treg_usd).toBeCloseTo(0.02644, 6);
    // the live panel got Arabic-Indic digits only
    const progress = t.store.events.filter((e) => e.kind === "progress");
    expect(progress[0].message_ar).toContain("أبحث");
    expect(progress[0].counts).toEqual({ sources: 3 });
    expect(t.store.events.some((e) => e.kind === "plan")).toBe(true);
    for (const e of t.store.events) expect(e.message_ar).not.toMatch(/[0-9]/);
  });

  it("a model that states a number, writes English or names a provider is told to rephrase, and nothing is stored", async () => {
    const t = setup([]);
    t.store.missions.set("msn_p2", newMission({ id: "msn_p2", user_id: USER_ID, status: "planning" }));
    const driver = createFakeDriver([
      { tool: "report_progress", args: { message_ar: "Calling the x.x.search-posts-all endpoint" } },
      { tool: "report_progress", args: { message_ar: "سعر الصف خمسة دولارات" } },
      { tool: "report_progress", args: { message_ar: "وجدت ١٠ منشورات" } },
    ]);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_p2")!);
    expect(driver.results.map((r) => r.result.ok)).toEqual([false, false, true]);
    expect(t.store.events.filter((e) => e.kind === "progress")).toHaveLength(1);
  });

  it("a plan with an invented sample id is rejected with the exact issue and no plan is stored", async () => {
    const t = setup(planningResponses());
    t.store.missions.set("msn_p3", newMission({ id: "msn_p3", user_id: USER_ID, status: "planning" }));
    const bad = planningScript({ stages: (r) => [{ key: "posts", title_ar: "المنشورات", endpoint_id: POSTS_ENDPOINT, expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "424242", text: "x" }], measured_by: [idOf(r, 0)], relevance: aboutWords(["post"]), yield_from: firstOutputId(r) }] });
    const driver = createFakeDriver(bad);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_p3")!);
    const last = driver.results[driver.results.length - 1].result;
    expect(last.ok).toBe(false);
    expect(JSON.stringify(last)).toContain("never invent ids or links");
    expect(t.store.missions.get("msn_p3")!.status).toBe("failed");
    expect(t.store.missions.get("msn_p3")!.plan).toBeNull();
  });

  it("asks ONE question (once), then waits for the answer", async () => {
    const t = setup([]);
    t.store.missions.set("msn_q", newMission({ id: "msn_q", user_id: USER_ID, status: "planning", request_text: "أريد تعليقات" }));
    const driver = createFakeDriver([
      { tool: "ask_question", args: { question_ar: "أي منشور أو حساب تقصد؟", options_ar: ["منشور محدد بالرابط", "حساب محدد"] } },
      { tool: "ask_question", args: { question_ar: "سؤال ثانٍ؟", options_ar: ["هذا", "ذاك"] } },
    ], { stopAfterTerminal: false });
    await runPlanning(t.deps(driver), t.store.missions.get("msn_q")!);
    expect(driver.results.map((r) => r.result.ok)).toEqual([true, false]);
    const m = t.store.missions.get("msn_q")!;
    expect(m.status).toBe("needs_input");
    expect(m.question_ar).toBe("أي منشور أو حساب تقصد؟");
    expect(t.store.events.filter((e) => e.kind === "question")).toHaveLength(1);
  });

  it("stops honestly and explains when no source can serve (nothing is reserved)", async () => {
    const t = setup([]);
    t.store.missions.set("msn_u", newMission({ id: "msn_u", user_id: USER_ID, status: "planning" }));
    const driver = createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لا يوجد مصدر متاح يخدم هذا الطلب بدقة، ولم يُحجز أي رصيد." } }]);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_u")!);
    expect(t.store.missions.get("msn_u")).toMatchObject({ status: "unserved", job_id: null });
    expect(t.money.calls).toHaveLength(0);
  });

  it("planning cannot finish with 'delivered'", async () => {
    const t = setup([]);
    t.store.missions.set("msn_x", newMission({ id: "msn_x", user_id: USER_ID, status: "planning" }));
    const driver = createFakeDriver([{ tool: "finish", args: { outcome: "delivered", summary_ar: "تم" } }]);
    await runPlanning(t.deps(driver), t.store.missions.get("msn_x")!);
    expect(driver.results[0].result.ok).toBe(false);
  });
});

describe("EXECUTION with a fake model transcript: linked rows, settlement, files", () => {
  async function planned() {
    const store = createMemoryStore();
    const money = fakeMoneyClient();
    const t = setup(planningResponses(), store, money);
    store.missions.set("msn_e1", newMission({ id: "msn_e1", user_id: USER_ID, request_text: "أريد منشورات عن القهوة مع تعليقاتها بكل اللغات", status: "planning" }));
    await runPlanning(t.deps(createFakeDriver(planningScript())), store.missions.get("msn_e1")!);
    const m = store.missions.get("msn_e1")!;
    expect(m.status).toBe("plan_ready");
    // the admin approves: reserve through the existing functions
    const approved = await approveMission(money.client, { id: m.id, user_id: m.user_id, plan: m.plan! });
    if (!approved.ok) throw new Error(approved.messageAr);
    await store.updateMission(m.id, { status: "approved", job_id: approved.jobId, quote_id: approved.quoteId, reserved_points: approved.reservePoints, unit_price_points: approved.unitPricePoints });
    return { store, money, approved, mission: store.missions.get("msn_e1")! };
  }

  const execScript = (postCount: number, commentsPerPost: number, extra: FakeStep[] = []): FakeStep[] => [
    { tool: "report_progress", args: { message_ar: "بدأت جمع المنشورات", counts: { target: postCount } } },
    { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: postCount }, why: "the fixture source is the one under test" } },
    { tool: "run_code", args: { code: "return inputs.call_0003.data.map(r => ({ id: r.id, text: r.text, url: r.url }))", files: ["call_0003"] } },
    { tool: "save_rows", args: { stage_key: "posts", from_output: "out_0002" } },
    ...Array.from({ length: postCount }, (_, i): FakeStep => ({ tool: "treg_call", args: { endpoint_id: COMMENTS_ENDPOINT, params: { url: `https://x.example/p/${9000 + i}` }, why: "the fixture source is the one under test" } })),
    { tool: "run_code", args: { code: `const out = []; const posts = inputs.call_0003.data; const ids = Object.keys(inputs).filter(k => k !== 'call_0003'); ids.forEach((k, i) => inputs[k].output.data.comments.forEach(c => out.push({ id: c.id, parent_id: posts[i].id, text: c.text }))); return out;`, files: ["call_0003", ...Array.from({ length: postCount }, (_, i) => `call_${String(4 + i).padStart(4, "0")}`)] } },
    { tool: "save_rows", args: { stage_key: "comments", from_output: "out_0003" } },
    ...extra,
    { tool: "finish", args: { outcome: "delivered", summary_ar: `سُلّمت ${postCount} منشورات وتعليقاتها في ورقتين مرتبطتين.` } },
  ];

  const execResponses = (postCount: number, commentsPerPost: number) => [tregResult(postsPage(postCount), postCount * 0.005), ...Array.from({ length: postCount }, (_, i) => tregResult(commentsPage(`${9000 + i}`, commentsPerPost), 0.00144))];

  it("collects stage by stage, links every comment to a saved post, builds linked sheets, charges only the delivered unique rows and releases the rest", async () => {
    const { store, money, approved, mission } = await planned();
    const t = setup(execResponses(8, 10), store, money);
    const driver = createFakeDriver(execScript(8, 10));
    // planning left two saved pages (call_0001, call_0002): execution numbering continues after them
    await runExecution({ ...t.deps(driver), call: t.call as any }, mission);
    const m = store.missions.get("msn_e1")!;
    expect(driver.results.filter((r) => r.tool === "save_rows").map((r) => r.result.ok)).toEqual([true, true]);
    expect(m.status).toBe("completed");
    expect(m.execution_model).toBe("claude-haiku-5-5");
    // 8 posts + 80 comments = 88 unique final rows delivered
    expect(m.delivered_units).toBe(88);
    const expectedCharge = Math.ceil(Math.round(88 * approved.unitPricePoints * 1e6) / 1e6 - 1e-9);
    expect(m.charged_points).toBe(expectedCharge);
    expect(m.charged_points).toBeLessThanOrEqual(approved.reservePoints);
    expect(money.balance()).toBe(100_000 - expectedCharge);
    expect(money.calls.map((c) => c.name).slice(-2)).toEqual(["complete_chunk", "settle_job_atomic"]);
    expect(money.jobs.get(approved.jobId)).toMatchObject({ status: "completed", delivered_units: 88 });
    // the execution budget was 40% of the reserve's value; the spend was recorded against the JOB
    expect(m.execution_treg_usd).toBeCloseTo(8 * 0.005 + 8 * 0.00144, 6);
    expect(m.execution_treg_usd).toBeLessThan(executionBudgetUsd(approved.reservePoints));
    expect(t.rec.rows.every((r) => r.jobId === approved.jobId)).toBe(true);

    // linked rows: every comment carries the id of a saved post
    const posts = JSON.parse((await store.getFile(m.id, "rows/posts.json"))!);
    const comments = JSON.parse((await store.getFile(m.id, "rows/comments.json"))!);
    const postIds = new Set(posts.map((p: any) => p.id));
    expect(posts).toHaveLength(8);
    expect(comments).toHaveLength(80);
    expect(comments.every((c: any) => postIds.has(c.parent_id))).toBe(true);

    // the files: linked sheets joined by المعرّف / معرّف الأصل
    expect(store.published).toEqual([{ missionId: m.id, userId: USER_ID, jobId: approved.jobId }]);
    expect(m.files!.map((f) => f.kind)).toEqual(["xlsx", "csv"]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(((await store.getFileBytes(m.id, "result/result.xlsx")) as unknown) as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "المنشورات", "التعليقات"]);
    const sheet = wb.getWorksheet("التعليقات")!;
    // readable first: the post's text and link next to each comment, then the comment, and the ids LAST (the parent id is a link to the post's id cell)
    expect([1, 2, 3, 4, 5].map((c) => sheet.getRow(1).getCell(c).value)).toEqual(["النص (المنشورات)", "الرابط", "النص", "المعرّف", "معرّف الأصل"]);
    expect(sheet.rowCount).toBe(81);
    const parentCell = sheet.getRow(2).getCell(5).value as any;
    expect(parentCell.hyperlink).toMatch(/^#'المنشورات'!C\d+$/);
    // the final summary and counts reached the live panel
    expect(store.events[store.events.length - 1]).toMatchObject({ kind: "result" });
    expect(store.events[store.events.length - 1].message_ar).not.toMatch(/[0-9]/);
  });

  it("save_rows refuses a child whose parent is not saved, ignores duplicates and refuses rows beyond the approved volume", async () => {
    const { store, money, mission } = await planned();
    const t = setup([tregResult(postsPage(3), 0.015)], store, money);
    const driver = createFakeDriver([
      { tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 3 } } },
      // a comment before its post is saved: refused
      { tool: "save_rows", args: { stage_key: "comments", rows: [{ id: "c1", parent_id: "9000", text: "x" }] } },
      { tool: "run_code", args: { code: "return inputs.call_0003.data.map(r => ({ id: r.id, text: r.text, url: r.url }))", files: ["call_0003"] } },
      { tool: "save_rows", args: { stage_key: "posts", from_output: "out_0002" } },
      { tool: "save_rows", args: { stage_key: "posts", from_output: "out_0002" } }, // the same rows again
      { tool: "save_rows", args: { stage_key: "comments", rows: [{ id: "c1", parent_id: "9000", text: "x" }, { id: "c2", parent_id: "no-such-post", text: "y" }, { id: "c1", parent_id: "9000", text: "dup" }, { text: "no id" }] } },
      { tool: "save_rows", args: { stage_key: "nope", rows: [] } },
    ], { stopAfterTerminal: false });
    await runExecution(t.deps(driver), mission);
    const saves = driver.results.filter((r) => r.tool === "save_rows").map((r) => r.result);
    expect(saves[0]).toMatchObject({ ok: true, saved_now: 0, rejected_unknown_parent: 1 });
    expect(saves[1]).toMatchObject({ ok: true, saved_now: 3 });
    expect(saves[2]).toMatchObject({ ok: true, saved_now: 0, duplicates_ignored: 3 });
    expect(saves[3]).toMatchObject({ ok: true, saved_now: 1, rejected_unknown_parent: 1, duplicates_ignored: 1, rejected_missing_id: 1 });
    expect(saves[4]).toMatchObject({ ok: false });
    // delivered = 3 posts + 1 comment, unique, linked
    expect(store.missions.get("msn_e1")!.delivered_units).toBe(4);
  });

  it("a stage never keeps more rows than the approved volume", async () => {
    const { store, money, mission } = await planned();
    const t = setup([], store, money);
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, text: "post t", url: `https://x.example/${i}` }));
    const driver = createFakeDriver([{ tool: "save_rows", args: { stage_key: "posts", rows } }], { stopAfterTerminal: false });
    await runExecution(t.deps(driver), mission);
    expect(driver.results[0].result).toMatchObject({ saved_now: 20, rejected_over_limit: 10, stage_limit: 20 });
    expect(store.missions.get("msn_e1")!.delivered_units).toBe(20);
  });

  it("nothing delivered: the whole hold is released and nothing is charged", async () => {
    const { store, money, approved, mission } = await planned();
    const t = setup([], store, money);
    const driver = createFakeDriver([{ tool: "finish", args: { outcome: "cannot_serve", summary_ar: "لم يعد المصدر يعطي بيانات، فلم يُسلَّم شيء ولم يُخصم رصيد." } }]);
    await runExecution(t.deps(driver), mission);
    const m = store.missions.get("msn_e1")!;
    expect(m).toMatchObject({ status: "unserved", delivered_units: 0, charged_points: 0 });
    expect(money.balance()).toBe(100_000);
    expect(money.jobs.get(approved.jobId)!.status).toBe("failed");
    expect(money.calls.map((c) => c.name)).toContain("release_job_atomic");
  });

  it("execution calls stop at the execution budget (40% of the reserve's value) and the agent is told", async () => {
    const { store, money, approved, mission } = await planned();
    const budget = executionBudgetUsd(approved.reservePoints);
    const t = setup([], store, money);
    // spend the whole budget on earlier execution calls, then ask for one more
    await store.addCall({ id: "msn_e1:call_0900", mission_id: "msn_e1", phase: "execution", endpoint_id: POSTS_ENDPOINT, params_digest: {}, status: "ok", refused_reason: null, http_status: 200, rows_returned: 1, cost_usd: budget, estimate_usd: budget, provider_cost_id: null, storage_path: null, duration_ms: 1 });
    const driver = createFakeDriver([{ tool: "treg_call", args: { endpoint_id: POSTS_ENDPOINT, params: { query: "قهوة", max_results: 5 } } }], { stopAfterTerminal: false });
    await runExecution(t.deps(driver), mission);
    expect(driver.results[0].result).toMatchObject({ ok: false, refused: "over_budget" });
    expect(t.call).not.toHaveBeenCalled();
  });

  it("approval re-prices the stored plan by code and the mission's reserve equals ceil(volume x unit x 1.15)", async () => {
    const { mission, approved } = await planned();
    const price = repriceStoredPlan(mission.plan!);
    expect(approved.reservePoints).toBe(price.reservePoints);
    expect(approved.reservePoints).toBe(Math.ceil(Math.round(220 * price.unitPricePoints * 1e6 * 1.15) / 1e6 - 1e-9));
  });
});
