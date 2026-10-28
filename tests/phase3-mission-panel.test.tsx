import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./helpers/memoryDb";
import { storedMissionPlan } from "./helpers/missionFixtures";

const memory = vi.hoisted(() => ({ db: null as any, user: { id: "u1", email: "a@example.com", app_metadata: {} as Record<string, unknown> } as any }));
vi.mock("../src/lib/supabase/server", async (original) => ({
  ...(await original<any>()),
  createAdminClient: () => memory.db,
  createServerSideClient: async () => ({ auth: { getUser: async () => ({ data: { user: memory.user } }) } }),
}));

import { GET as missionRoute } from "../src/app/api/jobs/[id]/mission/route";
import { GET as planningEventsRoute } from "../src/app/api/chat/planning-events/route";
import { MissionPlanBody, MissionPlanMobileBar, MissionPlanSheet, MissionPlanSidePanel, elapsedAr } from "../src/components/mission/MissionPlanPanel";
import { ETA_PENDING_AR, SLOW_SOURCE_AR, currentLineAr, missionView, panelTextProblems, phaseOfJob, planningSteps, snapshotsFromEvents, type MissionStageInfo, type PlannerEvent, type ProgressSnap } from "../src/lib/missionView";
import { PANEL_POLL_HIDDEN_MS, PANEL_POLL_VISIBLE_MS, contentFromMission, contentFromPlanQuote, contentFromPlanning, panelPollDelayMs, stagesOfPlanQuote } from "../src/lib/missionPanelContent";
import { PANEL_STATE_KEY, defaultPanelState, newPlannerRequestId, parsePanelState } from "../src/lib/missionPanelState";
import { completionSummaryAr, jobIdForQuote, loadMissionStatus } from "../src/lib/server/missionStatus";
import { generateMissionWorkbook, isMissionRowSet, safeSheetName } from "../src/lib/modelPlanner/missionWorkbook";
import { MISSION_NOTE_EVENT_TYPE, MISSION_PROGRESS_EVENT_TYPE, isCustomerVisibleJobEvent } from "../src/lib/reviewCostEvent";
import { PLANNER_EVENT_ROW_ENDPOINT } from "../src/lib/modelPlanner/exploration";
import { runPlanner } from "../src/lib/modelPlanner/planner";
import { createScriptedTransport } from "../src/lib/modelPlanner/transport";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { jobStartedNotice } from "../src/lib/server/jobNotices";
import { POST_APPROVAL_CRON_AR } from "../src/lib/postApproval";
import { stubGateway, search, sample, propose, xAccountPlan, X_REQUEST } from "./helpers/plannerKit";

const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const stageInfos = (name: "M1" | "M2" | "M3" | "M4"): MissionStageInfo[] => storedMissionPlan(name).stages!.map((s) => ({ titleAr: s.titleAr, deliver: s.deliver, effVolume: s.effVolume }));
const snap = (at: number, stages: Array<[number, number, boolean?]>, extra: Partial<Record<number, string>> = {}): ProgressSnap => ({ at, delivered: stages.reduce((n, s) => n + s[1], 0), stages: stages.map(([c, e, done], i) => ({ c, d: c, x: 0, e, q: 0, done: Boolean(done), ...(extra[i] ? { stopped: extra[i] } : {}) })) });
const T0 = Date.parse("2026-10-27T12:00:00Z");

describe("the panel steps equal the plan's stages for the four missions (the same source of truth, never a separate text)", () => {
  for (const name of ["M1", "M2", "M3", "M4"] as const) {
    it(`${name}: the stage steps are the stored plan's stage names, then the review and the files`, () => {
      const plan = storedMissionPlan(name);
      const view = missionView({ stages: stageInfos(name), snaps: [], phase: "queued", now: T0 });
      expect(view.steps.slice(0, plan.stages!.length).map((s) => s.titleAr)).toEqual(plan.stages!.map((s) => s.titleAr));
      expect(view.steps.slice(-2).map((s) => s.titleAr)).toEqual(["مراجعة النتائج", "تجهيز الملفات"]);
      expect(view.steps).toHaveLength(plan.stages!.length + 2);
      expect(panelTextProblems(view.steps)).toEqual([]);
      // the plan card's proposed steps are the same names
      const card = contentFromPlanQuote({ items: [{ params: { _modelStep: plan } }] });
      expect(card!.steps.map((s) => s.titleAr)).toEqual(view.steps.map((s) => s.titleAr));
      expect(card!.steps.every((s) => s.state === "waiting")).toBe(true);
    });
  }

  it("M4's stage names are the ones the model gave (made safe by code)", () => {
    expect(storedMissionPlan("M4").stages!.map((s) => s.titleAr)).toEqual(["جمع الشركات", "جمع الموظفين داخل كل شركة", "البريد المهني", "الموبايل"]);
    expect(stagesOfPlanQuote({ items: [{ params: {} }] })).toBeNull();
  });
});

describe("the steps change when the plan changes (a stage added or a source replaced)", () => {
  it("another plan gives another list; a replaced source adds an honest line and the stage keeps its name", () => {
    const m1 = missionView({ stages: stageInfos("M1"), snaps: [], phase: "queued", now: T0 });
    const m4 = missionView({ stages: stageInfos("M4"), snaps: [], phase: "queued", now: T0 });
    expect(m1.steps.map((s) => s.titleAr)).not.toEqual(m4.steps.map((s) => s.titleAr));
    const replaced = missionView({ stages: stageInfos("M4"), snaps: [snap(T0, [[2, 50], [0, 150], [0, 150], [0, 150]])], phase: "running", notes: [{ kind: "source_replaced", stage: 1, textAr: "بدّلنا لمصدر بديل." }], now: T0 + 1000 });
    expect(replaced.delayAr).toBe("بدّلنا لمصدر بديل.");
    expect(replaced.steps[0].titleAr).toBe("جمع الشركات");
  });
});

describe("the four states of a step: done, running, waiting, stopped", () => {
  const infos = stageInfos("M4");

  it("no snapshot yet: the first stage runs, the others wait; a queued job waits entirely", () => {
    const running = missionView({ stages: infos, snaps: [], phase: "running", now: T0 });
    expect(running.steps.map((s) => s.state)).toEqual(["running", "waiting", "waiting", "waiting", "waiting", "waiting"]);
    const queued = missionView({ stages: infos, snaps: [], phase: "queued", now: T0 });
    expect(queued.steps.every((s) => s.state === "waiting")).toBe(true);
  });

  it("a finished stage is done (full bar), the next one runs with its live count, the rest wait", () => {
    const v = missionView({ stages: infos, snaps: [snap(T0, [[50, 50, true], [30, 150], [0, 150], [0, 150]])], phase: "running", now: T0 + 5000 });
    expect(v.steps.map((s) => s.state)).toEqual(["done", "running", "waiting", "waiting", "waiting", "waiting"]);
    expect(v.steps[0]).toMatchObject({ countAr: "٥٠ من ٥٠", ratio: 1 });
    expect(v.steps[1]).toMatchObject({ countAr: "٣٠ من ١٥٠" });
    expect(v.currentLineAr).toBe("جمع الموظفين داخل كل شركة · ٣٠ من ١٥٠");
  });

  it("when every stage is done the review runs, then the mission is done with its files", () => {
    const all = [[50, 50, true], [150, 150, true], [150, 150, true], [150, 150, true]] as Array<[number, number, boolean]>;
    const review = missionView({ stages: infos, snaps: [snap(T0, all)], phase: "running", now: T0 + 1000 });
    expect(review.steps.map((s) => s.state)).toEqual(["done", "done", "done", "done", "running", "waiting"]);
    const done = missionView({ stages: infos, snaps: [snap(T0, all)], phase: "completed", now: T0 + 1000 });
    expect(done.steps.every((s) => s.state === "done")).toBe(true);
  });

  it("a stage the manager stopped is «stopped» with its short honest reason; a failed mission stops what was not finished and says why", () => {
    const stopped = missionView({ stages: infos, snaps: [snap(T0, [[50, 50, true], [10, 150, true], [0, 150], [0, 150]], { 1: "رأينا أن نتائج هذه المرحلة لا تطابق طلبك فأوقفناها." })], phase: "running", now: T0 + 1000 });
    expect(stopped.steps[1]).toMatchObject({ state: "stopped", reasonAr: "رأينا أن نتائج هذه المرحلة لا تطابق طلبك فأوقفناها." });
    const failed = missionView({ stages: infos, snaps: [snap(T0, [[50, 50, true], [10, 150], [0, 150], [0, 150]])], phase: "failed", failureReasonAr: "المصدر لا يستجيب حاليًا.", now: T0 + 1000 });
    expect(failed.steps.map((s) => s.state)).toEqual(["done", "stopped", "stopped", "stopped", "stopped", "stopped"]);
    expect(failed.steps[1].reasonAr).toBe("المصدر لا يستجيب حاليًا.");
    expect(currentLineAr(failed.steps)).toContain("توقفت");
  });

  it("a partial delivery finishes every step (what was collected is delivered)", () => {
    expect(phaseOfJob("completed", 30, 50)).toBe("partial");
    expect(phaseOfJob("completed", 50, 50)).toBe("completed");
    expect(phaseOfJob("failed", 0, 50)).toBe("failed");
    expect(phaseOfJob("running", 3, 50)).toBe("running");
    const partial = missionView({ stages: infos, snaps: [snap(T0, [[50, 50, true], [40, 150, true], [0, 150, true], [0, 150, true]])], phase: "partial", now: T0 });
    expect(partial.steps.every((s) => s.state === "done")).toBe(true);
  });
});

describe("the remaining time appears only after measured progress, per stage", () => {
  const infos = stageInfos("M4");
  it("«بنحسب الوقت المتوقع…» with one snapshot or no progress; a real time after two snapshots that show progress over enough time", () => {
    const one = missionView({ stages: infos, snaps: [snap(T0, [[10, 50], [0, 150], [0, 150], [0, 150]])], phase: "running", now: T0 + 1000 });
    expect(one.steps[0].etaAr).toBe(ETA_PENDING_AR);
    const stuck = missionView({ stages: infos, snaps: [snap(T0, [[10, 50], [0, 150], [0, 150], [0, 150]]), snap(T0 + 60_000, [[10, 50], [0, 150], [0, 150], [0, 150]])], phase: "running", now: T0 + 61_000 });
    expect(stuck.steps[0].etaAr).toBe(ETA_PENDING_AR);
    const moving = missionView({ stages: infos, snaps: [snap(T0, [[10, 50], [0, 150], [0, 150], [0, 150]]), snap(T0 + 60_000, [[20, 50], [0, 150], [0, 150], [0, 150]])], phase: "running", now: T0 + 61_000 });
    expect(moving.steps[0].etaAr).toMatch(/دقيقة|دقائق|ثانية/);
    expect(moving.steps[0].etaAr).not.toBe(ETA_PENDING_AR);
    // a waiting stage and a finished one show no time at all
    expect(moving.steps[2].etaAr).toBeUndefined();
  });

  it("each stage has its OWN remaining time from its own speed", () => {
    const snaps = [snap(T0, [[50, 50, true], [0, 150], [0, 150], [0, 150]]), snap(T0 + 120_000, [[50, 50, true], [30, 150], [0, 150], [0, 150]])];
    const v = missionView({ stages: infos, snaps, phase: "running", now: T0 + 121_000 });
    expect(v.steps[0].etaAr).toBeUndefined();
    expect(v.steps[1].etaAr).toMatch(/دقائق|دقيقة/);
  });

  it("a source that stops answering is said plainly, never silence", () => {
    const v = missionView({ stages: infos, snaps: [snap(T0, [[10, 50], [0, 150], [0, 150], [0, 150]])], phase: "running", now: T0 + 200_000 });
    expect(v.delayAr).toBe(SLOW_SOURCE_AR);
    const fresh = missionView({ stages: infos, snaps: [snap(T0, [[10, 50], [0, 150], [0, 150], [0, 150]])], phase: "running", now: T0 + 30_000 });
    expect(fresh.delayAr).toBeNull();
  });
});

describe("planning steps as they really happen", () => {
  const ev = (kind: PlannerEvent["kind"], extra: Partial<PlannerEvent> = {}): PlannerEvent => ({ kind, at: T0, ...extra });
  it("the four steps move with the planner's events, with small real findings", () => {
    expect(planningSteps([]).map((s) => s.state)).toEqual(["running", "waiting", "waiting", "waiting"]);
    const understood = planningSteps([ev("understood")]);
    expect(understood.map((s) => s.state)).toEqual(["done", "running", "waiting", "waiting"]);
    const searched = planningSteps([ev("understood"), ev("searched", { n: 3 })]);
    expect(searched.map((s) => s.state)).toEqual(["done", "done", "running", "waiting"]);
    expect(searched[1].detailAr).toBe("لقيت ٣ مصادر مناسبة.");
    const sampled = planningSteps([ev("understood"), ev("searched", { n: 3 }), ev("sampled", { rows: 10 })]);
    expect(sampled.map((s) => s.state)).toEqual(["done", "done", "running", "running"]);
    expect(sampled[2].detailAr).toBe("العينة رجعت ١٠ صفوف مطابقة.");
    const planned = planningSteps([ev("understood"), ev("searched", { n: 3 }), ev("sampled", { rows: 10 }), ev("planned")], { finished: "plan" });
    expect(planned.every((s) => s.state === "done")).toBe(true);
    expect(planned.map((s) => s.titleAr)).toEqual(["فهم الطلب", "البحث عن المصادر المناسبة", "تجربة عينة من كل مرحلة", "تجهيز الخطة والسعر"]);
  });

  it("a slow or replaced source is told in plain words; no provider, endpoint, price or English word anywhere", () => {
    const steps = planningSteps([ev("understood"), ev("searched", { n: 1 }), ev("switched"), ev("sample_slow")]);
    expect(steps[2].detailAr).toContain("بدّلنا لمصدر بديل");
    expect(steps[2].detailAr).toContain("المصدر أبطأ من المعتاد، لسه شغالين");
    expect(steps[1].detailAr).toBe("لقيت مصدرًا مناسبًا.");
    expect(panelTextProblems(steps)).toEqual([]);
  });

  it("the panel opens only when there is a plan or a mission: a plain question never shows it", () => {
    const steps = planningSteps([ev("understood")]);
    expect(contentFromPlanning({ steps, finished: null })).toBeNull();
    const searching = planningSteps([ev("understood"), ev("searched", { n: 2 })]);
    expect(contentFromPlanning({ steps: searching, finished: null })).not.toBeNull();
    expect(contentFromPlanning({ steps: searching, finished: "asked" })).toBeNull();
    expect(contentFromPlanning({ steps: searching, finished: "stopped" })).toBeNull();
    expect(contentFromPlanning(null)).toBeNull();
    expect(contentFromMission({ mission: false })).toBeNull();
  });

  it("the planner reports what it does, as it does it", async () => {
    const events: PlannerEvent[] = [];
    const fixture = JSON.parse(readFileSync("tests/fixtures/replay/real-rows_anyapi.x.user.posts.json", "utf-8")).pages[0];
    const gateway = stubGateway({ "anyapi.x.user.posts": fixture }, { "anyapi.x.user.posts": 800 });
    try {
      const out = await runPlanner({
        transport: createScriptedTransport([search("x", ["user", "posts"]), sample("anyapi.x.user.posts", [{ name: "handle", value: "elonmusk", source: "customer_text", quote: "@elonmusk" }]), propose(xAccountPlan())] as any),
        customerMessages: [X_REQUEST], access: { isAdmin: false, verifiedBusiness: false }, catalog: loadTregCatalog(), exploration: { client: createMemoryDb(), requestId: "req_events", userId: "u1" }, onEvent: (e) => events.push(e),
      });
      expect(out.kind).toBe("plan");
    } finally { gateway.restore(); }
    expect(events.map((e) => e.kind)).toEqual(["understood", "searched", "sampled", "planned"]);
    expect(events[1].n).toBeGreaterThan(0);
    expect(events[2].rows).toBeGreaterThan(0);
  });
});

describe("a reload restores the panel exactly where the mission is", () => {
  it("the same persisted snapshots give the same steps, the same counts and the same line; nothing lives only in the page", () => {
    const infos = stageInfos("M4");
    const rows = [
      { message: JSON.stringify({ stages: [{ c: 50, d: 50, x: 3, e: 50, q: 0, done: true }, { c: 30, d: 30, x: 0, e: 150, q: 4, done: false }, { c: 0, d: 0, x: 0, e: 150, q: 0, done: false }, { c: 0, d: 0, x: 0, e: 150, q: 0, done: false }] }), created_at: new Date(T0).toISOString() },
      { message: JSON.stringify({ stages: [{ c: 50, d: 50, x: 3, e: 50, q: 0, done: true }, { c: 60, d: 60, x: 0, e: 150, q: 2, done: false }, { c: 20, d: 20, x: 0, e: 150, q: 0, done: false }, { c: 0, d: 0, x: 0, e: 150, q: 0, done: false }] }), created_at: new Date(T0 + 60_000).toISOString() },
      { message: "not json", created_at: new Date(T0 + 70_000).toISOString() },
    ];
    const first = missionView({ stages: infos, snaps: snapshotsFromEvents(rows), phase: "running", now: T0 + 65_000 });
    const second = missionView({ stages: infos, snaps: snapshotsFromEvents([...rows].reverse()), phase: "running", now: T0 + 65_000 });
    expect(second).toEqual(first);
    expect(first.steps[0]).toMatchObject({ state: "done", excludedAr: "استبعدنا ٣ لعدم مطابقتها" });
    expect(first.steps[1]).toMatchObject({ state: "running", countAr: "٦٠ من ١٥٠" });
    expect(first.steps[2]).toMatchObject({ state: "running", countAr: "٢٠ من ١٥٠" });
  });

  it("the customer's panel settings (expanded, pinned) are kept in the browser, and a broken value means the default", () => {
    expect(parsePanelState(JSON.stringify({ expanded: false, pinned: true }))).toEqual({ expanded: false, pinned: true });
    expect(parsePanelState("garbage")).toEqual(defaultPanelState());
    expect(parsePanelState(null)).toEqual({ expanded: true, pinned: false });
    expect(PANEL_STATE_KEY).toContain("missionPanel");
    expect(newPlannerRequestId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(newPlannerRequestId()).not.toBe(newPlannerRequestId());
  });

  it("the status API rebuilds the panel from the job, its quote's plan and its events, for the owner of the job only", async () => {
    const plan = storedMissionPlan("M4");
    const quoteId = "quote_m4";
    const jobId = jobIdForQuote(quoteId);
    memory.db = createMemoryDb();
    memory.user = { id: "u1", email: "a@example.com", app_metadata: {} };
    memory.db.seed("jobs", [{ id: jobId, user_id: "u1", status: "running", delivered_units: 80, target_volume_max: 500, error_message: null, created_at: new Date(T0).toISOString(), reserved_credits: 900, charged_credits: 0, step: 2 }]);
    memory.db.seed("plans_quotes", [{ id: quoteId, user_id: "u1", items: [{ capabilitySlug: "model-planned", params: { _modelStep: plan } }], created_at: new Date(T0).toISOString() }]);
    memory.db.seed("job_events", [
      { job_id: jobId, event_type: MISSION_PROGRESS_EVENT_TYPE, message: JSON.stringify({ stages: [{ c: 50, d: 50, x: 0, e: 50, q: 0, done: true }, { c: 30, d: 30, x: 0, e: 150, q: 5, done: false }, { c: 0, d: 0, x: 0, e: 150, q: 0, done: false }, { c: 0, d: 0, x: 0, e: 150, q: 0, done: false }] }), created_at: new Date(T0 + 1000).toISOString() },
      { job_id: jobId, event_type: MISSION_NOTE_EVENT_TYPE, message: JSON.stringify({ kind: "source_replaced", stage: 1, textAr: "بدّلنا لمصدر بديل." }), created_at: new Date(T0 + 2000).toISOString() },
    ]);
    const ask = (id: string) => missionRoute(new NextRequest(`https://diger.test/api/jobs/${id}/mission`), { params: Promise.resolve({ id }) });
    const mine = await (await ask(jobId)).json();
    expect(mine).toMatchObject({ success: true, mission: true, phase: "running", delivered: 80, requested: 500 });
    expect(mine.view.steps.map((s: any) => s.titleAr).slice(0, 4)).toEqual(plan.stages!.map((s) => s.titleAr));
    expect(mine.view.steps[0].state).toBe("done");
    expect(mine.view.steps[1]).toMatchObject({ state: "running", countAr: "٣٠ من ١٥٠" });
    expect(mine.notes[0].textAr).toBe("بدّلنا لمصدر بديل.");
    memory.user = { id: "someone_else", email: "b@example.com", app_metadata: {} };
    expect((await ask(jobId)).status).toBe(403);
    memory.user = { id: "u1", email: "a@example.com", app_metadata: {} };
    expect((await ask("no_such_job")).status).toBe(404);
  });

  it("a job that is not a model-planned mission answers «not a mission», so the panel is not shown for it", async () => {
    memory.db = createMemoryDb();
    memory.db.seed("jobs", [{ id: "old_job", user_id: "u1", status: "running", delivered_units: 1, target_volume_max: 5 }]);
    const out = await (await missionRoute(new NextRequest("https://diger.test/x"), { params: Promise.resolve({ id: "old_job" }) })).json();
    expect(out.mission).toBe(false);
    const status = await loadMissionStatus(memory.db, { id: "old_job", user_id: "u1", status: "running" });
    expect(status.view).toBeNull();
  });
});

describe("the planning steps API reads the planner's own event rows, the customer's only", () => {
  it("returns the steps built from the rows, in order, with the finish state", async () => {
    memory.db = createMemoryDb();
    memory.user = { id: "u1", email: "a@example.com", app_metadata: {} };
    const row = (request_id: string, user_id: string, params_digest: any, at: number) => ({ request_id, user_id, endpoint_id: PLANNER_EVENT_ROW_ENDPOINT, params_digest, created_at: new Date(at).toISOString(), cost_usd: 0 });
    memory.db.seed("exploration_calls", [
      row("req_abcdefgh", "u1", { kind: "understood", at: T0 }, T0), row("req_abcdefgh", "u1", { kind: "searched", n: 4, at: T0 + 1 }, T0 + 1000), row("req_abcdefgh", "u1", { kind: "sampled", rows: 12, at: T0 + 2 }, T0 + 2000),
      row("req_abcdefgh", "someone_else", { kind: "planned", at: T0 + 3 }, T0 + 3000), { request_id: "req_abcdefgh", user_id: "u1", endpoint_id: "anyapi.x.user.posts", params_digest: { kind: "planned" }, created_at: new Date(T0 + 4000).toISOString() },
    ]);
    const ask = (id: string) => planningEventsRoute(new NextRequest(`https://diger.test/api/chat/planning-events?requestId=${id}`));
    const out = await (await ask("req_abcdefgh")).json();
    expect(out.finished).toBeNull();
    expect(out.steps.map((s: any) => s.state)).toEqual(["done", "done", "running", "running"]);
    expect(out.steps[1].detailAr).toBe("لقيت ٤ مصادر مناسبة.");
    expect(out.currentLineAr).toBe("تجربة عينة من كل مرحلة");
    expect((await ask("x")).status).toBe(400);
    const none = await (await ask("req_unknown1")).json();
    expect(none.steps[0].state).toBe("running");
  });
});

describe("the panel's drawing: check mark and strike-through, spinner, plain, stopped; RTL; light and dark by the site's tokens", () => {
  const infos = stageInfos("M4");
  const content = () => {
    const v = missionView({ stages: infos, snaps: [snap(T0, [[50, 50, true], [30, 150], [0, 150], [0, 150]], {})], phase: "running", now: T0 + 5000 });
    const stopped = { ...v.steps[3], state: "stopped" as const, reasonAr: "رأينا أن نتائج هذه المرحلة لا تطابق طلبك فأوقفناها." };
    return { title: "خطة المهمة", steps: [...v.steps.slice(0, 3), stopped, ...v.steps.slice(4)], currentLineAr: v.currentLineAr, live: true, startedAt: T0, latest: { stageTitleAr: "جمع الموظفين داخل كل شركة", columns: [{ key: "a", titleAr: "الاسم" }], rows: [["أحمد"], ["منى"]] }, notesAr: ["بدّلنا لمصدر بديل."], closePageAr: "تقدر تقفل الصفحة وتروح تشرب قهوة، هنكمّل الشغل وهنبعتلك إيميل أول ما نخلص.", summaryAr: [] };
  };
  const body = () => renderToStaticMarkup(createElement(MissionPlanBody, { content: content() }));

  it("a done step has the check mark and a struck-through name; the running one a spinner; waiting is plain; stopped has its reason", () => {
    const html = body();
    expect(html).toContain('data-state="done"');
    expect(html).toContain('data-testid="step-icon-done"');
    expect(html).toMatch(/line-through[^>]*>جمع الشركات</);
    expect(html).toContain('data-testid="step-icon-running"');
    expect(html).toContain("animate-spin");
    expect(html).toContain('data-testid="step-icon-waiting"');
    expect(html).toContain('data-testid="step-icon-stopped"');
    expect(html).toContain("رأينا أن نتائج هذه المرحلة لا تطابق طلبك فأوقفناها.");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="20"/);
    expect(html).toContain("بنحسب الوقت المتوقع…");
    expect(html).toContain('data-testid="mission-live-rows"');
    expect(html).toContain("تقدر تقفل الصفحة وتروح تشرب قهوة");
    expect(html).toContain('dir="rtl"');
  });

  it("only the site's tokens are used for colour (so light and dark follow the theme); a spinner stands still for reduced motion; no hard-coded hex colour", () => {
    const html = body();
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).toContain("var(--ok)");
    expect(html).toContain("motion-safe:animate-spin");
    expect(readFileSync("src/components/mission/MissionPlanPanel.tsx", "utf8")).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });

  it("no English word, provider, endpoint id or USD in any text of the panel", () => {
    const plain = text(body());
    expect(plain).not.toMatch(/[A-Za-z]{3,}/);
    expect(plain).not.toMatch(/USD|\$|دولار/);
    expect(plain).not.toMatch(/[a-z0-9-]+\.[a-z0-9_.-]{2,}/i);
  });

  it("desktop: expanded, collapsed to a rail, pinned; mobile: the one-line bar with the current step, and a sheet", () => {
    const c = content();
    const open = renderToStaticMarkup(createElement(MissionPlanSidePanel, { content: c, expanded: true, pinned: true, onToggleExpanded: () => {}, onTogglePinned: () => {} }));
    expect(open).toContain('data-expanded="true"');
    expect(open).toContain('data-pinned="true"');
    expect(open).toContain('data-testid="mission-pin"');
    expect(open).toContain("hidden"); // hidden below the large breakpoint: the bar and the sheet take over
    expect(open).toContain("lg:flex");
    const rail = renderToStaticMarkup(createElement(MissionPlanSidePanel, { content: c, expanded: false, pinned: false, onToggleExpanded: () => {}, onTogglePinned: () => {} }));
    expect(rail).toContain('data-expanded="false"');
    expect(rail).toContain('data-testid="mission-expand"');
    const bar = renderToStaticMarkup(createElement(MissionPlanMobileBar, { content: c, onOpen: () => {} }));
    expect(bar).toContain("lg:hidden");
    expect(bar).toContain('data-testid="mission-current-line"');
    expect(text(bar)).toContain("جمع الموظفين داخل كل شركة · ٣٠ من ١٥٠");
    const sheet = renderToStaticMarkup(createElement(MissionPlanSheet, { content: c, onClose: () => {} }));
    expect(sheet).toContain('role="dialog"');
    expect(sheet).toContain('data-testid="mission-sheet-close"');
  });

  it("the elapsed time is real and in Arabic digits", () => {
    expect(elapsedAr(12_000)).toBe("مضى ١٢ ث");
    expect(elapsedAr(132_000)).toBe("مضى ٢ د ١٢ ث");
    expect(elapsedAr(3_900_000)).toBe("مضى ١ س ٥ د");
  });

  it("polling: every 2 to 3 seconds while the page is visible, slower when it is hidden", () => {
    expect(panelPollDelayMs(false)).toBe(PANEL_POLL_VISIBLE_MS);
    expect(PANEL_POLL_VISIBLE_MS).toBeGreaterThanOrEqual(2000);
    expect(PANEL_POLL_VISIBLE_MS).toBeLessThanOrEqual(3000);
    expect(panelPollDelayMs(true)).toBe(PANEL_POLL_HIDDEN_MS);
    expect(PANEL_POLL_HIDDEN_MS).toBeGreaterThan(PANEL_POLL_VISIBLE_MS);
  });
});

describe("the waiting experience around it", () => {
  it("the friendly sentence is the post-approval message and the in-site notice when the driver is live; the honest line otherwise", () => {
    expect(POST_APPROVAL_CRON_AR).toBe("تقدر تقفل الصفحة وتروح تشرب قهوة، هنكمّل الشغل وهنبعتلك إيميل أول ما نخلص.");
    expect(jobStartedNotice({ targetVolumeMax: 500, driver: "cron" }).body).toContain("تقدر تقفل الصفحة وتروح تشرب قهوة");
    expect(jobStartedNotice({ targetVolumeMax: 500, driver: "tab" }).body).toContain("أبقِ الصفحة مفتوحة");
    const accept = readFileSync("src/app/api/chat/accept-quote/route.ts", "utf8");
    expect(accept).toContain("isModelPlanned, driver: driverNow"); // any model-planned job, while the driver is live (was: only a mission)
    const content = contentFromMission({ mission: true, phase: "running", view: { steps: [], currentLineAr: "x", delayAr: null } }, { closePageAr: "تقدر تقفل الصفحة" });
    expect(content!.closePageAr).toBe("تقدر تقفل الصفحة");
    expect(contentFromMission({ mission: true, phase: "completed", view: { steps: [], currentLineAr: "x", delayAr: null } }, { closePageAr: "تقدر تقفل الصفحة" })!.closePageAr).toBeNull();
  });

  it("the mission's own events never appear in the customer's activity list", () => {
    expect(isCustomerVisibleJobEvent(MISSION_PROGRESS_EVENT_TYPE)).toBe(false);
    expect(isCustomerVisibleJobEvent(MISSION_NOTE_EVENT_TYPE)).toBe(false);
    expect(isCustomerVisibleJobEvent("progress")).toBe(true);
  });

  it("the pages wire the panel in: the chat page (side panel, mobile bar, sheet, planner request id), «طلباتي» for every past mission, and the plan card's stages", () => {
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    for (const part of ["useMissionPanel(", "MissionPlanSidePanel", "MissionPlanMobileBar", "MissionPlanSheet", "plannerRequestId"]) expect(chat).toContain(part);
    const requests = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(requests).toContain("MissionPlanInline");
    expect(requests).toContain("MODEL_PLAN_SLUG");
    expect(readFileSync("src/app/dashboard/chat/components/PlanQuoteCard.tsx", "utf8")).toContain('data-testid="mission-stages"');
    expect(readFileSync("src/app/api/chat/route.ts", "utf8")).toContain("plannerRequestId");
  });
});

describe("the completion: a summary, and the files as LINKED sheets", () => {
  it("the summary says delivered against requested, rows per delivered stage, and what was charged (never above the hold)", () => {
    const stages = [{ titleAr: "جمع الشركات", deliver: true, delivered: 50 }, { titleAr: "جمع الموظفين داخل كل شركة", deliver: true, delivered: 120 }, { titleAr: "الوسيط", deliver: false, delivered: 0 }];
    const lines = completionSummaryAr({ phase: "partial", delivered: 170, requested: 200, stages, reserved: 900, charged: 700 });
    expect(lines[0]).toBe("وصلك ١٧٠ من ٢٠٠ صفًا مطلوبًا؛ تسلّمت ما جُمع فعلًا.");
    expect(lines[1]).toBe("في الملفات: الشركات ٥٠ · الموظفين داخل كل شركة ١٢٠.");
    expect(lines[2]).toBe("خُصم ٧٠٠ نقطة فقط من ٩٠٠ محجوزة، وعاد الباقي إلى رصيدك.");
    expect(completionSummaryAr({ phase: "completed", delivered: 200, requested: 200, stages: stages.slice(0, 1), reserved: 600, charged: 600 })).toEqual(["وصلك كل المطلوب: ٢٠٠ صفًا.", "خُصم ٦٠٠ نقطة فقط."]);
    expect(completionSummaryAr({ phase: "failed", delivered: 0, requested: 200, stages: [], reserved: 600, charged: 0 })).toEqual(["توقفت المهمة قبل أن تكتمل.", "لم يُخصم أي رصيد."]);
    for (const line of lines) expect(line).not.toMatch(/[A-Za-z]{3,}|USD|\$/);
  });

  it("Excel: one sheet per delivered stage, linked by the row id and the parent id; frozen headers, filters on, numbers as numbers, links as links", async () => {
    const plan = storedMissionPlan("M2");
    const videos = [1, 2, 3].map((n) => ({ mission_stage: 1, mission_row_id: `v${n}`, mission_parent_id: "", source_id: `v${n}`, video_title: `فيديو ${n}`, ["الوصف"]: `وصف ${n}` }));
    const comments = [1, 2, 3, 4].map((n) => ({ mission_stage: 2, mission_row_id: `c${n}`, mission_parent_id: `v${(n % 3) + 1}`, text: `تعليق ${n}`, likes_count: String(n * 10) }));
    expect(isMissionRowSet(plan, [...videos, ...comments])).toBe(true);
    expect(isMissionRowSet(plan, [{ text: "x" }])).toBe(false);
    const buffer = await generateMissionWorkbook([...videos, ...comments], plan);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["ملخص المهمة", "جمع الفيديوهات", "تعليقات كل فيديو"]);
    const videosSheet = wb.getWorksheet("جمع الفيديوهات")!;
    const commentsSheet = wb.getWorksheet("تعليقات كل فيديو")!;
    expect(videosSheet.getRow(1).values).toEqual(expect.arrayContaining(["المعرّف", "المعرف", "الوصف"]));
    expect(commentsSheet.getRow(1).getCell(1).value).toBe("المعرّف");
    expect(commentsSheet.getRow(1).getCell(2).value).toBe("معرّف الأصل");
    for (const sheet of [videosSheet, commentsSheet]) {
      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, rightToLeft: true });
      expect(sheet.autoFilter).toBeTruthy();
    }
    expect(videosSheet.rowCount).toBe(4);
    expect(commentsSheet.rowCount).toBe(5);
    // the parent id is a link to the parent's row, and the id it holds is the parent's
    const parentCell = commentsSheet.getRow(2).getCell(2);
    expect((parentCell.value as any).text).toBe("v2");
    expect(String((parentCell.value as any).hyperlink)).toMatch(/^#'جمع الفيديوهات'!A3$/);
    // the number of likes would be a number if the plan maps one (this plan maps text only): the id columns stay text
    const first = wb.getWorksheet("ملخص المهمة")!;
    expect(first.getRow(2).getCell(3).value).toBe(3);
    expect(first.getRow(3).getCell(3).value).toBe(4);
    expect(String(first.getRow(3).getCell(5).value)).toContain("معرّف الأصل");
    expect(first.autoFilter).toBeTruthy();
  });

  it("a stage that is not delivered has no sheet; sheet names are safe and unique; a customer's word that looks like a formula is text", async () => {
    const plan = storedMissionPlan("M1");
    plan.stages![1].deliver = false;
    const rows = [{ mission_stage: 1, mission_row_id: "n1", mission_parent_id: "", video_title: "=HYPERLINK(\"x\")", url: "https://example.com/a" }, { mission_stage: 3, mission_row_id: "c1", mission_parent_id: "v1", text: "تعليق", likes_count: "7" }];
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generateMissionWorkbook(rows, plan)) as any);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["ملخص المهمة", "جمع الأخبار", "تعليقات كل فيديو"]);
    const news = wb.getWorksheet("جمع الأخبار")!;
    expect(String(news.getRow(2).getCell(2).value)).toBe("'=HYPERLINK(\"x\")");
    const comments = wb.getWorksheet("تعليقات كل فيديو")!;
    expect(comments.getRow(2).getCell(4).value).toBe(7); // «الإعجابات» is a number cell
    const used = new Set<string>();
    expect(safeSheetName("a/b:c*d?[e]", used, "x")).toBe("a b c d e");
    expect(safeSheetName("a/b:c*d?[e]", used, "x")).toBe("a b c d e 2");
    expect(safeSheetName("x".repeat(60), new Set(), "x").length).toBeLessThanOrEqual(31);
    expect(readFileSync("src/app/api/worker/chunk/route.ts", "utf8")).toContain("generateMissionWorkbook(");
  });
});

describe("M2 end to end on fixtures (zero provider calls): the validated plan runs on the engine, writes its snapshots, and the rows become linked sheets", () => {
  it("validator → engine → progress → workbook", async () => {
    const plan = storedMissionPlan("M2");
    const nest = (path: string | null, rows: unknown[]) => (path ? path.split(".").reduceRight<any>((acc, key) => ({ [key]: acc }), rows) : rows);
    const listPaths = plan.steps.map((st) => st.facts.listPath);
    const call = async (o: any) => {
      const i = plan.steps.findIndex((st) => st.endpointId === o.endpointId);
      const p = o.params as Record<string, any>;
      const rows = i === 0
        ? [1, 2, 3, 4].map((n) => ({ id: `V${n}`, caption: `فيديو ${n}` }))
        : [1, 2, 3].map((n) => ({ text: `تعليق ${n} على ${p.aweme_id}` }));
      return { ok: true, httpStatus: 200, tregCallId: "c", costMicro: 500, latencyMs: 1, data: nest(listPaths[i], rows), isRouteMaxCost: false, isPlatformBalanceLow: false };
    };
    const { runModelPlanChunk } = await import("../src/lib/modelPlanner/interpreter");
    const { MODEL_PLAN_PARAM, MODEL_PLAN_SLUG } = await import("../src/lib/modelPlanner/constants");
    const small = { ...plan, stages: plan.stages!.map((s, i) => ({ ...s, effVolume: i === 0 ? 4 : 8, perParent: s.perParent ? 2 : 0 })) };
    const rows: any[] = [];
    const snaps: any[] = [];
    let cursor: string | null = null;
    for (let chunk = 0; chunk < 30; chunk += 1) {
      const out: any = await runModelPlanChunk({ jobId: "j", userId: "u1", step: chunk, endpointId: plan.steps[0].endpointId, capabilitySlug: MODEL_PLAN_SLUG, method: "POST", params: { [MODEL_PLAN_PARAM]: small }, paginationStrategy: "cursor", cursor, pageSize: 10, remainingNeeded: 12 - rows.length, targetVolumeMax: 12, deliveredSoFar: rows.length } as any, { call, advisor: (async ({ rows: batch }: any) => ({ verdicts: new Map(batch.map((r: any) => [r.index, { verdict: "match", reasonAr: "" }])), usage: null })) as any });
      expect(out.ok).toBe(true);
      rows.push(...out.rows);
      expect(out.missionProgress.stages).toHaveLength(2);
      snaps.push(out.missionProgress);
      cursor = out.nextCursor;
      if (!cursor) break;
    }
    expect(rows.filter((r) => r.mission_stage === 1)).toHaveLength(4);
    expect(rows.filter((r) => r.mission_stage === 2)).toHaveLength(8);
    const last = snaps[snaps.length - 1].stages;
    expect(last.map((s: any) => [s.c, s.d, s.done])).toEqual([[4, 4, true], [8, 8, true]]);
    expect(snaps.some((s) => s.stages[1].c > 0 && !s.stages[1].done)).toBe(true); // the panel saw the second stage fill up
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await generateMissionWorkbook(rows, small as any)) as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["ملخص المهمة", "جمع الفيديوهات", "تعليقات كل فيديو"]);
    expect(wb.getWorksheet("تعليقات كل فيديو")!.rowCount).toBe(9);
    // the rows of the second stage name their video, and it is a video of the first sheet
    const ids = new Set(rows.filter((r) => r.mission_stage === 1).map((r) => r.mission_row_id));
    expect(rows.filter((r) => r.mission_stage === 2).every((r) => ids.has(r.mission_parent_id))).toBe(true);
  });
});

beforeEach(() => { memory.db = createMemoryDb(); memory.user = { id: "u1", email: "a@example.com", app_metadata: {} }; });
