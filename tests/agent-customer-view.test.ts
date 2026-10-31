import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { customerPlanView, validateAndPricePlan, firstSentenceAr, isInternalColumn, type PlanLookup } from "../src/lib/agentMission/plan";
import { customerMissionView, queueLine, stagesView, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { estimateMissionMinutes } from "../src/lib/agentMission/price";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { AGENT_CLOSE_PAGE_LINE_AR, AGENT_QUEUE_LINE_AR } from "../src/lib/agentMission/constants";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";

const calls = new Map([
  ["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0.05, rows: 10, durationMs: 3000 }],
  ["call_0002", { id: "call_0002", endpointId: "anyapi.instagram.post.comments", ok: true, costUsd: 0.00144, rows: 12, durationMs: 1200 }],
]);
const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "9000 9001 9000-c0 9000-c1 https://x.example/p/9000", endpointAllowed: () => true };

/** A plan whose model put id columns and a duplicated title among the columns (the clutter seen on the admin page). */
function clutteredPlan() {
  const checked = validateAndPricePlan({
    summary_ar: "ستحصل على منشورات القهوة مع تعليقات كل منشور. وستصلك في ورقتين مرتبطتين.",
    stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 20, parent_key: null, deliver: true,
        columns: [{ key: "id", title_ar: "المعرّف" }, { key: "tweet_id", title_ar: "رقم التغريدة" }, { key: "text", title_ar: "النص" }, { key: "url", title_ar: "الرابط" }, { key: "text2", title_ar: "النص" }],
        sample_rows: [{ id: "9000", tweet_id: "9000", text: "post 0", url: "https://x.example/p/9000", text2: "post 0" }], measured_by: ["call_0001"] },
      { key: "comments", title_ar: "تعليقات كل منشور", endpoint_id: "anyapi.instagram.post.comments", expected_rows: 100, parent_key: "posts", per_parent_rows: 12, deliver: true,
        columns: [{ key: "parent_id", title_ar: "معرّف الأصل" }, { key: "text", title_ar: "نص التعليق" }],
        sample_rows: [{ id: "9000-c0", parent_id: "9000", text: "comment 0" }, { id: "9000-c1", parent_id: "9000", text: "comment 1" }], measured_by: ["call_0002"] },
    ],
  }, lookup);
  if (!checked.ok) throw new Error(checked.issues.join("; "));
  return checked.plan;
}

describe("the plan the customer reads", () => {
  it("drops id columns and duplicated titles, keeps readable columns only, and says ONE sentence", () => {
    const plan = clutteredPlan();
    expect(plan.stages[0].columns.map((c) => c.key)).toEqual(["text", "url"]);
    expect(plan.stages[1].columns.map((c) => c.key)).toEqual(["text"]);
    const view = customerPlanView(plan);
    expect(view.summary_ar).toBe("ستحصل على منشورات القهوة مع تعليقات كل منشور.");
    expect(view.stages[0].sample_rows[0]).toEqual({ text: "post 0", url: "https://x.example/p/9000" });
    expect(JSON.stringify(view)).not.toMatch(/x\.x\.|anyapi|call_00|measured|usd/i);
  });

  it("a column that only holds an id is not a column; a plan with nothing readable is refused", () => {
    expect(isInternalColumn({ key: "post_id", title_ar: "المنشور" })).toBe(true);
    expect(isInternalColumn({ key: "text", title_ar: "معرّف النص" })).toBe(true);
    expect(isInternalColumn({ key: "text", title_ar: "النص" })).toBe(false);
    const bad = validateAndPricePlan({ summary_ar: "ستحصل على منشورات.", stages: [{ key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 5, parent_key: null, deliver: true, columns: [{ key: "id", title_ar: "المعرّف" }], sample_rows: [{ id: "9000" }], measured_by: ["call_0001"] }] }, lookup);
    expect(bad.ok).toBe(false);
  });

  it("the first sentence", () => {
    expect(firstSentenceAr("جملة أولى. جملة ثانية.")).toBe("جملة أولى.");
    expect(firstSentenceAr("بدون نقطة")).toBe("بدون نقطة");
  });

  it("the expected time is computed by code from what the planning calls measured, never below two minutes", () => {
    expect(estimateMissionMinutes([{ rows: 20, msPerRow: 300 }])).toBe(2);
    const big = estimateMissionMinutes([{ rows: 300, msPerRow: 250 }, { rows: 1000, msPerRow: 120 }]);
    expect(big).toBeGreaterThan(estimateMissionMinutes([{ rows: 300, msPerRow: 250 }]));
    expect(customerPlanView(clutteredPlan()).expected_minutes).toBeGreaterThanOrEqual(2);
  });
});

const row = (over: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer => ({ id: "msn_view00001", status: "plan_ready", question_ar: null, plan_public: customerPlanView(clutteredPlan()), reserved_points: 30, unit_price_points: 1.5, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-10-28T10:00:00Z", ...over });
const ev = (id: number, over: Partial<EventForCustomer> = {}): EventForCustomer => ({ id, kind: "progress", message_ar: "يواصل الوكيل العمل", counts: {}, created_at: new Date(Date.parse("2026-10-28T10:00:00Z") + id * 20_000).toISOString(), ...over });

describe("the mission card: stages that add up, readable samples, one price line", () => {
  it("numbers the stages in plain words, rows that add up to the total, two or three sample rows, the price/hold/time on ONE line", () => {
    const v = customerMissionView({ mission: row(), events: [] });
    expect(v.phase).toBe("plan");
    expect(v.stages.map((s) => [s.n, s.titleAr, s.rows])).toEqual([[1, "المنشورات", 20], [2, "تعليقات كل منشور", 100]]);
    expect(v.totalRows).toBe(120);
    expect(v.stages.reduce((n, s) => n + s.rows, 0)).toBe(v.totalRows);
    expect(v.samples!.columns.map((c) => c.titleAr)).toEqual(["نص التعليق"]);
    expect(v.samples!.rows.length).toBeGreaterThanOrEqual(2);
    expect(v.samples!.rows.length).toBeLessThanOrEqual(3);
    expect(v.priceLineAr).toMatch(/^السعر حتى .+ · حجز مؤقت .+ · الوقت المتوقع نحو /);
    expect(v.priceLineAr!.split("\n")).toHaveLength(1);
    // all of it Arabic with Arabic-Indic digits: no Latin word, no ASCII digit, no id, no dollar
    for (const text of [v.summaryAr!, v.priceLineAr!, ...v.stages.map((s) => `${s.titleAr} ${s.rowsAr}`)]) { expect(checkCustomerText(text).issues).toEqual([]); expect(text).not.toMatch(/[0-9]/); }
  });

  it("an intermediate stage is not counted in the total", () => {
    const plan: any = { stages: [{ title_ar: "الشركات", expected_rows: 3, deliver: false }, { title_ar: "الموظفون", expected_rows: 6, deliver: true }] };
    expect(stagesView(plan)).toMatchObject({ total: 6 });
    expect(stagesView(plan).stages[0].noteAr).toContain("المرحلة التالية");
  });

  it("the card draws the plan with the buttons «اعتمد» and «عدّل الطلب» and no internal word", () => {
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: customerMissionView({ mission: row(), events: [] }), isGuest: false }));
    expect(html).toContain("اعتمد");
    expect(html).toContain("عدّل الطلب");
    expect(html).toContain("data-testid=\"agent-total\"");
    expect(html).not.toMatch(/endpoint|treg|firecrawl|context\.dev|USD|call_\d|msn_/i);
    // a guest is asked to sign up instead of approving
    const guest = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: customerMissionView({ mission: row(), events: [] }), isGuest: true }));
    expect(guest).toContain("سجّل لتعتمد");
    expect(guest).not.toContain("data-testid=\"agent-approve\"");
    expect(guest).toContain("data-testid=\"agent-guest-note\"");
  });
});

describe("the live panel and the queue", () => {
  it("shows the queue line with the position when the worker is busy, and an honest line when the worker is away", () => {
    expect(queueLine("queued", { ahead: 2, running: 1, workerAlive: true })).toEqual({ lineAr: `${AGENT_QUEUE_LINE_AR} · ترتيبك ٣`, position: 3 });
    expect(queueLine("queued", { ahead: 0, running: 0, workerAlive: true }).lineAr).toBeNull();
    expect(queueLine("queued", { ahead: 0, running: 0, workerAlive: false }).lineAr).toContain("الخدمة متوقفة مؤقتًا");
    expect(queueLine("executing", { ahead: 5, running: 1, workerAlive: true }).lineAr).toBeNull();
    const v = customerMissionView({ mission: row({ status: "queued", plan_public: null }), events: [], queue: { ahead: 1, running: 1, workerAlive: true } });
    expect(v.phase).toBe("waiting");
    expect(v.queueLineAr).toContain("مهمتك في الدور وهتبدأ خلال دقائق");
    expect(v.currentLineAr).toContain("مهمتك في الدور");
  });

  it("ticks the steps from the counts of the events, shows the current step with its count and the coffee line after approval", () => {
    const events = [ev(1, { kind: "system" }), ev(2, { counts: { stage: 1, saved: 20, planned: 20 } }), ev(3, { counts: { stage: 2, saved: 30, planned: 100 } })];
    const now = Date.parse(events[2].created_at) + 5_000;
    // (the old call had no queue reading) the coffee line is shown only while the worker is really alive
    const v = customerMissionView({ mission: row({ status: "executing" }), events, now, queue: { ahead: 0, running: 1, workerAlive: true } });
    expect(v.phase).toBe("running");
    expect(v.steps.map((s) => s.state)).toEqual(["done", "running", "waiting"]);
    // (the old lines expected «٣٠ من ١٠٠»: the count now carries the noun of the stage, correctly: «تعليقًا»)
    expect(v.steps[1].countAr).toBe("٣٠ من ١٠٠ تعليقًا");
    expect(v.currentLineAr).toContain("٣٠ من ١٠٠ تعليقًا");
    expect(v.closePageAr).toBe(AGENT_CLOSE_PAGE_LINE_AR);
    expect(v.delayAr).toBeNull();
    // the remaining time comes only from the real speed (two samples that show progress), never a guess
    expect(v.remainingAr === null || /^المتبقي /.test(v.remainingAr)).toBe(true);
  });

  it("an honest delay when nothing new arrived for a while", () => {
    const events = [ev(1, { counts: { stage: 1, saved: 5, planned: 20 } })];
    const v = customerMissionView({ mission: row({ status: "executing" }), events, now: Date.parse(events[0].created_at) + 200_000 });
    expect(v.delayAr).toContain("الأمر يأخذ وقتًا أطول من المعتاد");
  });

  it("a finished mission says what was delivered, what was charged and what came back; partial when fewer rows than planned", () => {
    const done = customerMissionView({ mission: row({ status: "completed", delivered_units: 120, charged_points: 28, reserved_points: 32, summary_ar: "اكتملت المهمة.", files: [{ name: "result.xlsx", kind: "xlsx" }, { name: "result.csv", kind: "csv" }] }), events: [] });
    expect(done.phase).toBe("done");
    // one money line: what was charged and for how many items (the hold and its release are the wallet's own rows)
    expect(done.resultLinesAr[done.resultLinesAr.length - 1]).toBe("خُصم ٢٨ نقطة مقابل ١٢٠ عنصرًا.");
    expect(done.files.map((f) => f.labelAr)).toEqual(["تنزيل ملف إكسل"]);
    expect(done.steps[done.steps.length - 1]).toMatchObject({ id: "files", state: "done" });
    const partial = customerMissionView({ mission: row({ status: "completed", delivered_units: 40, charged_points: 9, reserved_points: 32 }), events: [] });
    expect(partial.phase).toBe("partial");
  });

  it("the question phase shows the agent's one question", () => {
    const v = customerMissionView({ mission: row({ status: "needs_input", plan_public: null, question_ar: "أي بلد تقصد؟" }), events: [] });
    expect(v.phase).toBe("question");
    expect(v.questionAr).toBe("أي بلد تقصد؟");
  });
});
