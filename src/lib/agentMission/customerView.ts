import { formatAr, toArabicDigits } from "../arabicDigits";
import { estimateRemainingSeconds, etaTextAr, type ProgressSample } from "../jobEta";
import { FILES_STEP_TITLE_AR, PLANNING_STEP_TITLES, SLOW_SOURCE_AR, type PanelStep } from "../missionView";
import { pointsAr } from "../pointsFormat";
import { AGENT_CLOSE_PAGE_LINE_AR, AGENT_QUEUE_LINE_AR, AGENT_SLOW_AFTER_MS } from "./constants";

/**
 * WHAT THE CUSTOMER SEES OF A MISSION: one pure function from the columns the customer may read (the mission row without its internal columns, its events, the worker's state and the queue)
 * to a view that the chat card and the live panel «خطة المهمة» draw. Arabic only, Arabic-Indic digits; no endpoint, no provider, no internal id, no dollar amount, no English label.
 * Counts come from the events' `counts` JSON (never from their text). Nothing here holds money logic: the price figures are the ones the code computed and stored with the plan.
 */
export type CustomerPhase = "waiting" | "planning" | "question" | "plan" | "running" | "done" | "partial" | "unserved" | "failed" | "cancelled";

export interface MissionRowForCustomer {
  id: string;
  status: string;
  question_ar: string | null;
  plan_public: any | null;
  reserved_points: number | null;
  unit_price_points: number | null;
  delivered_units: number | null;
  charged_points: number | null;
  summary_ar: string | null;
  files: Array<{ name: string; kind: string }> | null;
  created_at: string;
}
export interface EventForCustomer { id: number; kind: string; message_ar: string; counts: Record<string, number> | null; created_at: string }
export interface QueueInfo {
  /** Missions waiting for the worker that were created before this one. */
  ahead: number;
  /** Missions the worker is running right now. */
  running: number;
  /** The worker's heartbeat is fresh. */
  workerAlive: boolean;
}
export interface CustomerStageView { n: number; titleAr: string; rows: number; rowsAr: string; deliver: boolean; noteAr: string | null }

export interface CustomerMissionView {
  id: string;
  phase: CustomerPhase;
  /** ONE sentence: what will be delivered. */
  summaryAr: string | null;
  /** Honest sentences next to the summary (for example why a contact the customer asked for is not in the plan). */
  notesAr: string[];
  stages: CustomerStageView[];
  totalRows: number;
  totalRowsAr: string;
  /** 2 to 3 sample rows with readable columns only. */
  samples: { stageTitleAr: string; columns: Array<{ key: string; titleAr: string }>; rows: string[][] } | null;
  /** price, hold and expected time on ONE line. */
  priceLineAr: string | null;
  questionAr: string | null;
  /** «مهمتك في الدور وهتبدأ خلال دقائق» with the position, or null. */
  queueLineAr: string | null;
  queuePosition: number | null;
  /** The live panel «خطة المهمة». */
  steps: PanelStep[];
  currentLineAr: string;
  delayAr: string | null;
  remainingAr: string | null;
  /** Said once after approval, while the work runs. */
  closePageAr: string | null;
  /** After the end: what was delivered, what was charged, what was released. */
  resultLinesAr: string[];
  resultSummaryAr: string | null;
  files: Array<{ name: string; kind: string; labelAr: string }>;
  /** The start of the work (the first event), for the elapsed clock. */
  startedAt: number | null;
  live: boolean;
}

const PHASE_OF_STATUS: Record<string, CustomerPhase> = { queued: "waiting", planning: "planning", needs_input: "question", plan_ready: "plan", approved: "running", executing: "running", completed: "done", unserved: "unserved", failed: "failed", cancelled: "cancelled" };
export const isLivePhase = (p: CustomerPhase) => p === "waiting" || p === "planning" || p === "running";

const rowsWordAr = (n: number): string => (n === 1 ? "صف واحد" : n === 2 ? "صفان" : n >= 3 && n <= 10 ? `${formatAr(n)} صفوف` : `${formatAr(n)} صفًا`);
const hoursAr = (h: number): string => (h <= 1 ? "نحو ساعة" : h === 2 ? "نحو ساعتين" : `نحو ${formatAr(h)} ساعات`);
const minutesAr = (m: number): string => (m <= 1 ? "نحو دقيقة" : m === 2 ? "نحو دقيقتين" : m <= 10 ? `نحو ${formatAr(m)} دقائق` : m < 60 ? `نحو ${formatAr(m)} دقيقة` : hoursAr(Math.ceil(m / 60)));

/** Stages in plain words with the expected rows of each; the delivered ones add up to the total shown. */
export function stagesView(plan: any): { stages: CustomerStageView[]; total: number } {
  const stages: CustomerStageView[] = [];
  let total = 0;
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  list.forEach((s, i) => {
    const rows = Math.max(0, Math.floor(Number(s?.expected_rows) || 0));
    const deliver = s?.deliver !== false;
    if (deliver) total += rows;
    stages.push({ n: i + 1, titleAr: String(s?.title_ar ?? ""), rows, rowsAr: rowsWordAr(rows), deliver, noteAr: deliver ? null : "تُستخدم في المرحلة التالية ولا تُحتسب في ملفك" });
  });
  return { stages, total };
}

function samplesView(plan: any): CustomerMissionView["samples"] {
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  // the deepest delivered stage is what the customer gets: show its rows (else the first stage that has any)
  const delivered = list.filter((s) => s?.deliver !== false && Array.isArray(s?.sample_rows) && s.sample_rows.length > 0);
  const stage = delivered[delivered.length - 1] ?? list.find((s) => Array.isArray(s?.sample_rows) && s.sample_rows.length > 0);
  if (!stage) return null;
  const columns: Array<{ key: string; titleAr: string }> = (Array.isArray(stage.columns) ? stage.columns : []).map((c: any) => ({ key: String(c.key), titleAr: String(c.title_ar ?? c.titleAr ?? "") })).filter((c: { titleAr: string }) => c.titleAr).slice(0, 6);
  if (columns.length === 0) return null;
  const rows = (stage.sample_rows as Array<Record<string, unknown>>).slice(0, 3).map((r) => columns.map((c) => String(r?.[c.key] ?? "").slice(0, 120)));
  return { stageTitleAr: String(stage.title_ar ?? ""), columns, rows };
}

/** price, hold and expected time on one clear line. */
export function priceLineAr(plan: any): string | null {
  const price = plan?.price;
  if (!price || !(Number(price.max_charge_points) > 0)) return null;
  const maxCharge = Math.round(Number(price.max_charge_points));
  const reserve = Math.round(Number(price.reserve_points));
  const minutes = Math.round(Number(plan?.expected_minutes) || 0);
  const parts = [
    `السعر حتى ${pointsAr(maxCharge)} ولا يُخصم إلا ما يُسلَّم فعلًا`,
    `حجز مؤقت ${pointsAr(reserve)} يُحرَّر ما لا يُستخدم منه`,
  ];
  if (minutes > 0) parts.push(`الوقت المتوقع ${minutesAr(minutes)}`);
  return parts.join(" · ");
}

/** The queue line, only when the mission really waits behind another or the worker is busy or away; the position counts the missions ahead + 1. */
export function queueLine(status: string, queue: QueueInfo | null): { lineAr: string | null; position: number | null } {
  if (!queue || (status !== "queued" && status !== "approved")) return { lineAr: null, position: null };
  const position = queue.ahead + 1;
  if (!queue.workerAlive) return { lineAr: "الخدمة متوقفة مؤقتًا. مهمتك محفوظة وهتبدأ أول ما تعود للعمل.", position };
  if (queue.ahead === 0 && queue.running === 0) return { lineAr: null, position: 1 };
  return { lineAr: `${AGENT_QUEUE_LINE_AR} · ترتيبك ${toArabicDigits(position)}`, position };
}

const stageIndexOf = (e: EventForCustomer): number => Math.max(0, Math.floor(Number(e.counts?.stage) || 0));

/** Steps of the live panel. Before the plan: the four planning steps; after approval: the plan's stages and the files. */
/** What collect_pages reports while it pages through a source: events with `pages` and `rows` (and the target in `planned`) but no `stage`. */
function collectedOf(events: EventForCustomer[]): { rows: number; target: number; samples: ProgressSample[] } | null {
  const samples: ProgressSample[] = [];
  let rows = 0;
  let target = 0;
  for (const e of events) {
    if (typeof e.counts?.pages === "number" && typeof e.counts?.rows === "number" && !e.counts?.stage) {
      rows = e.counts.rows;
      target = Number(e.counts.planned) || target;
      const at = Date.parse(e.created_at);
      if (Number.isFinite(at)) samples.push({ at, delivered: rows });
    }
  }
  return samples.length ? { rows, target, samples } : null;
}

function stepsOf(input: { phase: CustomerPhase; status: string; stages: CustomerStageView[]; events: EventForCustomer[]; callsMade: number; hasPlan: boolean; delivered: number | null; filesReady: boolean }): { steps: PanelStep[]; samples: ProgressSample[]; savedTotal: number; plannedTotal: number } {
  const { phase, status, stages, events, callsMade, hasPlan } = input;
  const executing = status === "approved" || status === "executing" || status === "completed" || (status === "failed" && hasPlan && events.some((e) => stageIndexOf(e) > 0));
  const savedPerStage = new Map<number, number>();
  const samples: ProgressSample[] = [];
  let savedTotalNow = 0;
  for (const e of events) {
    const idx = stageIndexOf(e);
    if (idx > 0 && typeof e.counts?.saved === "number") {
      savedPerStage.set(idx, Math.max(savedPerStage.get(idx) ?? 0, e.counts.saved));
      savedTotalNow = [...savedPerStage.values()].reduce((a, b) => a + b, 0);
      const at = Date.parse(e.created_at);
      if (Number.isFinite(at)) samples.push({ at, delivered: savedTotalNow });
    }
  }
  const plannedTotal = stages.reduce((n, s) => n + s.rows, 0);
  if (!executing) {
    const planned = hasPlan;
    const planning = phase === "planning" || phase === "waiting";
    const steps: PanelStep[] = PLANNING_STEP_TITLES.map((titleAr, i) => ({ id: `plan-${i + 1}`, titleAr, state: "waiting" as PanelStep["state"] }));
    steps[0].state = phase === "waiting" ? "waiting" : "done";
    if (phase === "planning" && !events.some((e) => e.kind === "progress") && callsMade === 0) steps[0].state = "running";
    steps[1].state = planned || callsMade > 0 ? "done" : phase === "planning" && steps[0].state === "done" ? "running" : "waiting";
    steps[2].state = planned ? "done" : callsMade > 0 ? "running" : "waiting";
    steps[3].state = planned ? "done" : planning && callsMade > 0 ? "waiting" : "waiting";
    if (phase === "question") { for (const s of steps) if (s.state === "waiting" || s.state === "running") s.state = "waiting"; }
    if (phase === "unserved" || phase === "failed" || phase === "cancelled") for (const s of steps) if (s.state === "running" || s.state === "waiting") s.state = "stopped";
    return { steps, samples, savedTotal: savedTotalNow, plannedTotal };
  }
  const finished = status === "completed";
  const firstOpen = stages.findIndex((s) => (savedPerStage.get(s.n) ?? 0) < s.rows);
  const steps: PanelStep[] = stages.map((s, i) => {
    const saved = Math.min(savedPerStage.get(s.n) ?? 0, s.rows);
    const done = finished || (saved >= s.rows && s.rows > 0) || (firstOpen !== -1 && i < firstOpen && saved > 0);
    const running = !done && !finished && (status === "executing" || status === "approved") && i === (firstOpen === -1 ? 0 : firstOpen);
    const step: PanelStep = { id: `stage-${s.n}`, titleAr: s.titleAr, state: done ? "done" : running && status === "executing" ? "running" : "waiting" };
    if (saved > 0 || running) { step.countAr = `${formatAr(saved)} من ${formatAr(s.rows)}`; step.ratio = s.rows > 0 ? Math.min(1, saved / s.rows) : 0; }
    if (!s.deliver) step.detailAr = "تُستخدم في المرحلة التالية";
    return step;
  });
  // while a source is being paged through, say how many rows were collected so far (the saved count only moves when the rows are saved)
  const collected = collectedOf(events);
  const runningStep = steps.find((st) => st.state === "running");
  if (collected && runningStep && !finished) {
    const detail = `جُمع ${formatAr(collected.rows)}${collected.target ? ` من ${formatAr(collected.target)}` : ""} من المصدر حتى الآن`;
    runningStep.detailAr = runningStep.detailAr ? `${runningStep.detailAr} · ${detail}` : detail;
  }
  const failedStop = status === "failed";
  if (failedStop) for (const s of steps) if (s.state === "running" || s.state === "waiting") { s.state = "stopped"; }
  steps.push({ id: "files", titleAr: FILES_STEP_TITLE_AR, state: input.filesReady ? "done" : finished ? "done" : failedStop ? "stopped" : "waiting" });
  return { steps, samples, savedTotal: savedTotalNow, plannedTotal };
}

const FILE_LABEL_AR: Record<string, string> = { xlsx: "تنزيل ملف إكسل", csv: "تنزيل نسخة سي إس في" };

export function customerMissionView(input: { mission: MissionRowForCustomer; events: EventForCustomer[]; queue?: QueueInfo | null; callsMade?: number; now?: number }): CustomerMissionView {
  const { mission } = input;
  const now = input.now ?? Date.now();
  const events = [...input.events].sort((a, b) => a.id - b.id);
  const basePhase = PHASE_OF_STATUS[mission.status] ?? "waiting";
  const plan = mission.plan_public && typeof mission.plan_public === "object" ? mission.plan_public : null;
  const { stages, total } = stagesView(plan);
  const planned = stages.filter((s) => s.deliver).reduce((n, s) => n + s.rows, 0);
  const delivered = mission.delivered_units;
  const phase: CustomerPhase = basePhase === "done" && delivered !== null && planned > 0 && delivered < planned ? "partial" : basePhase;
  const q = queueLine(mission.status, input.queue ?? null);
  const filesReady = Array.isArray(mission.files) && mission.files.length > 0;
  const { steps, samples, savedTotal, plannedTotal } = stepsOf({ phase, status: mission.status, stages, events, callsMade: input.callsMade ?? 0, hasPlan: plan !== null, delivered, filesReady });

  const lastEvent = events[events.length - 1];
  const lastAt = lastEvent ? Date.parse(lastEvent.created_at) : NaN;
  const progressLine = [...events].reverse().find((e) => e.kind === "progress" || e.kind === "system")?.message_ar ?? null;
  const running = steps.find((s) => s.state === "running");
  let delayAr: string | null = null;
  if ((mission.status === "executing" || mission.status === "planning") && Number.isFinite(lastAt) && now - lastAt > AGENT_SLOW_AFTER_MS) delayAr = SLOW_SOURCE_AR;
  if (input.queue && !input.queue.workerAlive && (mission.status === "queued" || mission.status === "approved" || mission.status === "executing" || mission.status === "planning")) delayAr = "الخدمة متوقفة مؤقتًا. مهمتك محفوظة وتكمل أول ما تعود للعمل.";

  let remainingAr: string | null = null;
  if (mission.status === "executing") {
    let seconds = estimateRemainingSeconds(samples, plannedTotal, now);
    // the speed of the paging itself (rows collected from the source), before the first rows are saved
    if (seconds === null) { const c = collectedOf(events); if (c && c.target > 0) seconds = estimateRemainingSeconds(c.samples, c.target, now); }
    remainingAr = seconds === null ? null : seconds === 0 ? null : `المتبقي ${etaTextAr(seconds)?.replace(/^حوالي /, "نحو ")}`;
  }
  const currentLineAr = q.lineAr ?? (running ? (running.countAr ? `${running.titleAr} · ${running.countAr}` : running.titleAr) : progressLine ?? steps.find((s) => s.state === "waiting")?.titleAr ?? "");

  const resultLinesAr: string[] = [];
  if (delivered !== null && (phase === "done" || phase === "partial" || phase === "failed" || phase === "unserved")) {
    if (planned > 0) resultLinesAr.push(`سُلّم ${formatAr(delivered)} من ${rowsWordAr(planned)} متوقعة`);
    const charged = Number(mission.charged_points ?? 0);
    const reserved = Number(mission.reserved_points ?? 0);
    if (mission.charged_points !== null) resultLinesAr.push(`خُصم ${pointsAr(Math.round(charged))} مقابل ما سُلّم فقط${reserved > charged ? `، وحجز مؤقت مُحرَّر ${pointsAr(Math.round(reserved - charged))}` : ""}`);
  }

  return {
    id: mission.id, phase, summaryAr: plan?.summary_ar ? String(plan.summary_ar) : null, notesAr: Array.isArray(plan?.notes_ar) ? plan.notes_ar.map(String) : [], stages, totalRows: total, totalRowsAr: rowsWordAr(total),
    samples: plan ? samplesView(plan) : null, priceLineAr: plan ? priceLineAr(plan) : null, questionAr: phase === "question" ? mission.question_ar : null,
    queueLineAr: q.lineAr, queuePosition: q.position, steps, currentLineAr, delayAr, remainingAr,
    closePageAr: mission.status === "approved" || mission.status === "executing" ? AGENT_CLOSE_PAGE_LINE_AR : null,
    resultLinesAr, resultSummaryAr: phase === "done" || phase === "partial" || phase === "unserved" || phase === "failed" ? mission.summary_ar : null,
    files: filesReady ? mission.files!.filter((f) => FILE_LABEL_AR[f.kind]).map((f) => ({ name: f.name, kind: f.kind, labelAr: FILE_LABEL_AR[f.kind] })) : [],
    startedAt: events.length ? Date.parse(events[0].created_at) || null : null,
    live: isLivePhase(phase),
  };
}
