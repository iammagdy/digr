import { customerSafeText } from "./text";
import { formatAr, toArabicDigits } from "../arabicDigits";
import type { ProgressSample } from "../jobEta";
import { FILES_STEP_TITLE_AR, PLANNING_STEP_TITLES, type PanelStep } from "../missionView";
import { pointsAr } from "../pointsFormat";
import { AGENT_CLOSE_PAGE_LINE_AR, AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR, AGENT_QUEUE_LINE_AR, AGENT_SLOW_AFTER_MS, AGENT_STALL_AFTER_MS } from "./constants";
import { isInternalEvent } from "./eventText";
import { countAr, deliveredOfAr, itemNounOf, itemNounOfPlan } from "./itemNoun";
import { moneyLineAr } from "./moneyText";
import { fixFileWordingAr } from "./fileWording";
import { remainingLineAr, stageMetricLines, trackMission } from "./tracker";
import type { PlanEditorView } from "./plan";

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
export interface CustomerStageView { n: number; titleAr: string; rows: number; rowsAr: string; deliver: boolean; noteAr: string | null; yieldShare?: number; /** The number (1-based) of the stage this one hangs on (comments of posts), else null. */ parentN: number | null }

export interface CustomerMissionView {
  id: string;
  phase: CustomerPhase;
  /** ONE sentence: what will be delivered. */
  summaryAr: string | null;
  /** Honest sentences next to the summary (for example why a contact the customer asked for is not in the plan). */
  notesAr: string[];
  /** What the agent assumed where the request left a choice open («المقصود: محمد صلاح لاعب كرة القدم.»): the customer reads it on the card and may edit the request before approving. */
  assumptionsAr: string[];
  /** The steps the customer asked for that the plan leaves out, each with the reason (shown BEFORE approval; the customer approves the rest or edits the request). */
  unservedAr: string[];
  /** The ready answers of the agent's one question (the customer taps one). */
  questionOptionsAr: string[];
  stages: CustomerStageView[];
  totalRows: number;
  totalRowsAr: string;
  /** 2 to 3 sample rows with readable columns only. */
  samples: { stageTitleAr: string; columns: Array<{ key: string; titleAr: string }>; rows: string[][] } | null;
  /** What the file will contain, built from the plan's REAL columns (never from the agent's own words): «يضم الملف: التاريخ والوقت، نص التغريدة، …». */
  fileContentsAr: string | null;
  /** price, hold and expected time on ONE line. */
  priceLineAr: string | null;
  /** The same facts as short labelled cells for the compact card («السعر حتى ٢٤٣ نقطة»، «حجز مؤقت ٢٧٩ نقطة»، «الوقت المتوقع نحو ٤ دقائق»), and the one sentence under them. */
  priceFacts: Array<{ labelAr: string; valueAr: string }>;
  priceNoteAr: string | null;
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
  /** What the customer asked for in all, and the target the plan was approved at: equal unless the plan proposed fewer, with the reason on the card. A delivery below the request is never «complete». */
  requestedRows: number;
  /** The honest end sentence (what happened and what it cost, in one place): for an ending only; null while the mission is open. */
  endLineAr: string | null;
  /** The plan editor of the card (the target, the columns, the filters), only while the plan waits for approval. */
  edit: PlanEditorView | null;
  /** The start of the work (the first event), for the elapsed clock. */
  startedAt: number | null;
  live: boolean;
}

const PHASE_OF_STATUS: Record<string, CustomerPhase> = { queued: "waiting", planning: "planning", needs_input: "question", plan_ready: "plan", approved: "running", executing: "running", completed: "done", unserved: "unserved", failed: "failed", cancelled: "cancelled" };
export const isLivePhase = (p: CustomerPhase) => p === "waiting" || p === "planning" || p === "running";

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
    const parentIndex = typeof s?.parent_key === "string" ? list.findIndex((x) => x?.key === s.parent_key) : -1;
    // a stage that only FEEDS the next one is a ceiling, never a promise: «حتى ١٠ فيديوهات» (how many of them end up with results in the file is counted from the item store at the end)
    const rowsAr = countAr(rows, itemNounOf(String(s?.title_ar ?? "")));
    stages.push({ n: i + 1, parentN: parentIndex >= 0 ? parentIndex + 1 : null, titleAr: customerSafeText(s?.title_ar, "مرحلة"), rows, rowsAr: deliver ? rowsAr : `حتى ${rowsAr}`, deliver, noteAr: deliver ? null : "تُستخدم في المرحلة التالية ولا تُحتسب في ملفك", ...(typeof s?.yield_share === "number" ? { yieldShare: s.yield_share } : {}) });
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
  return { stageTitleAr: customerSafeText(stage.title_ar, "مرحلة"), columns, rows };
}

/** What the file holds, from the columns of the deepest delivered stage (the sheet the customer opens): one line, in the order of the sheet. Null when the plan has no readable column. */
export function fileContentsAr(plan: any): string | null {
  const list: any[] = Array.isArray(plan?.stages) ? plan.stages : [];
  const delivered = list.filter((s) => s?.deliver !== false);
  const stage = delivered[delivered.length - 1];
  const titles: string[] = (Array.isArray(stage?.columns) ? stage.columns : []).map((c: any) => String(c.title_ar ?? c.titleAr ?? "").trim()).filter(Boolean);
  return titles.length > 0 ? `يضم الملف: ${titles.join("، ")}.` : null;
}

/** The one honest sentence of the plan card about what is charged: the price shown is the price of the FULL delivery; fewer items cost in proportion; nothing delivered costs nothing. */
export const PRICE_PROMISE_AR = "السعر المعروض هو سعر التسليم الكامل؛ لو سُلّم أقل يُخصم بنسبة ما سُلّم فقط، ولو لم يُسلَّم شيء لا يُخصم شيء.";

/** price, hold and expected time on one clear line. */
export function priceLineAr(plan: any): string | null {
  const price = plan?.price;
  if (!price || !(Number(price.max_charge_points) > 0)) return null;
  const maxCharge = Math.round(Number(price.max_charge_points));
  const reserve = Math.round(Number(price.reserve_points));
  const minutes = Math.round(Number(plan?.expected_minutes) || 0);
  const parts = [
    `السعر حتى ${pointsAr(maxCharge)} (سعر التسليم الكامل) ويُخصم بنسبة ما يُسلَّم فعلًا`,
    `حجز مؤقت ${pointsAr(reserve)} يُحرَّر ما لا يُستخدم منه`,
  ];
  if (minutes > 0) parts.push(`الوقت المتوقع ${minutesAr(minutes)}`);
  return parts.join(" · ");
}

/** The price, the hold and the expected time as short cells, and one sentence about what is charged (full delivery = the price shown, fewer = in proportion, nothing = nothing). Empty when the plan has no price. */
export function priceFactsOf(plan: any): { facts: Array<{ labelAr: string; valueAr: string }>; noteAr: string | null } {
  const price = plan?.price;
  if (!price || !(Number(price.max_charge_points) > 0)) return { facts: [], noteAr: null };
  const minutes = Math.round(Number(plan?.expected_minutes) || 0);
  const facts = [
    { labelAr: "السعر حتى", valueAr: pointsAr(Math.round(Number(price.max_charge_points))) },
    { labelAr: "حجز مؤقت", valueAr: pointsAr(Math.round(Number(price.reserve_points))) },
    ...(minutes > 0 ? [{ labelAr: "الوقت المتوقع", valueAr: minutesAr(minutes) }] : []),
  ];
  return { facts, noteAr: PRICE_PROMISE_AR };
}

/** The queue line, only when the mission really waits behind another or the worker is busy or away; the position counts the missions ahead + 1. */
export function queueLine(status: string, queue: QueueInfo | null): { lineAr: string | null; position: number | null } {
  if (!queue || (status !== "queued" && status !== "approved")) return { lineAr: null, position: null };
  const position = queue.ahead + 1;
  if (!queue.workerAlive) return { lineAr: "الخدمة متوقفة مؤقتًا. مهمتك محفوظة وهتبدأ أول ما تعود للعمل.", position };
  if (queue.ahead === 0 && queue.running === 0) return { lineAr: null, position: 1 };
  return { lineAr: `${AGENT_QUEUE_LINE_AR} · ترتيبك ${toArabicDigits(position)}`, position };
}

/** The honest lines of a step that is slow. Planning holds NOTHING, and says so; a running mission says it charges only what it delivers. Never an ETA. */
export const SLOW_PLANNING_AR = "ما زلنا نجهّز خطتك وبعض المصادر أبطأ من المعتاد. لم يُحجز أي رصيد منك.";
export const STALLED_PLANNING_AR = "الخطوة الحالية تستغرق وقتًا أطول من المعتاد وما زلنا نعمل عليها. لم يُحجز أي رصيد منك حتى الآن.";
export const SLOW_RUNNING_AR = "المصدر أبطأ من المعتاد وما زلنا نعمل. ولن يُخصم منك إلا ما يُسلَّم فعلًا.";
export const STALLED_RUNNING_AR = "المصدر أبطأ من المعتاد منذ وقت أطول، وما زلنا نعمل عليه. ولن يُخصم منك إلا ما يُسلَّم فعلًا.";

/** Progress INSIDE the planning step «تجربة عينة من كل مرحلة»: the samples read so far, and out of how many when the agent has said how many stages it plans. */
function sampleProgress(events: EventForCustomer[], callsMade: number): { done: number; of: number | null } {
  let samples = 0;
  let stages = 0;
  for (const e of events) {
    if (typeof e.counts?.samples === "number") samples = Math.max(samples, Math.floor(e.counts.samples));
    if (typeof e.counts?.stages === "number" && e.counts.stages > 0) stages = Math.floor(e.counts.stages);
  }
  const done = Math.max(samples, callsMade);
  return { done, of: stages > 0 ? stages : null };
}

const stageIndexOf = (e: EventForCustomer): number => Math.max(0, Math.floor(Number(e.counts?.stage) || 0));

/** Steps of the live panel. Before the plan: the four planning steps; after approval: the plan's stages and the files. */
function stepsOf(input: { phase: CustomerPhase; status: string; stages: CustomerStageView[]; events: EventForCustomer[]; callsMade: number; hasPlan: boolean; delivered: number | null; filesReady: boolean; now: number }): { steps: PanelStep[]; samples: ProgressSample[]; savedTotal: number; plannedTotal: number; track: ReturnType<typeof trackMission> } {
  const { phase, status, stages, events, callsMade, hasPlan } = input;
  const executing = status === "approved" || status === "executing" || status === "completed" || (status === "failed" && hasPlan && events.some((e) => stageIndexOf(e) > 0));
  const finishedRun = status === "completed";
  // the live numbers of every stage, from the mission's own events: they only grow (one rule for every mission type)
  // the end of a finished mission: the items of each stage IN THE FILE (the result event's own counts, written by code from the delivered file); an older mission that has none says its delivered count for its one delivered stage
  const resultCounts = [...events].reverse().find((e) => e.kind === "result" && e.counts)?.counts ?? null;
  const deliveredStages = stages.filter((s) => s.deliver);
  const finalSaved = finishedRun ? stages.map((s) => (typeof resultCounts?.[`stage_${s.n}_rows`] === "number" ? Math.floor(resultCounts[`stage_${s.n}_rows`]) : deliveredStages.length === 1 && s.deliver && typeof input.delivered === "number" ? input.delivered : undefined)) : undefined;
  const track = trackMission({ stages: stages.map((s) => ({ n: s.n, titleAr: s.titleAr, expectedRows: s.rows, deliver: s.deliver, yieldShare: s.yieldShare })), events, finished: finishedRun, finalSaved, now: input.now });
  const savedPerStage = new Map<number, number>(track.stages.map((s) => [s.n, s.saved]));
  const samples: ProgressSample[] = [];
  const savedTotalNow = track.stages.reduce((n, s) => n + s.saved, 0);
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
    // clear progress inside the current step: «عينة ١ من ٢» when the number of stages is known, else how many samples were tried
    const progress = sampleProgress(events, callsMade);
    if (!planned && progress.done > 0 && steps[2].state === "running") {
      if (progress.of !== null) { const n = Math.min(progress.done, progress.of); steps[2].countAr = `عينة ${formatAr(n)} من ${formatAr(progress.of)}`; steps[2].ratio = Math.min(1, n / progress.of); }
      else steps[2].detailAr = progress.done === 1 ? "جُرّبت عينة واحدة" : progress.done === 2 ? "جُرّبت عينتان" : `جُرّبت ${formatAr(progress.done)} عينات`;
    }
    if (phase === "question") { for (const s of steps) if (s.state === "waiting" || s.state === "running") s.state = "waiting"; }
    if (phase === "unserved" || phase === "failed" || phase === "cancelled") for (const s of steps) if (s.state === "running" || s.state === "waiting") s.state = "stopped";
    return { steps, samples, savedTotal: savedTotalNow, plannedTotal, track };
  }
  const finished = status === "completed";
  const firstOpen = stages.findIndex((s) => (savedPerStage.get(s.n) ?? 0) < s.rows);
  const steps: PanelStep[] = stages.map((s, i) => {
    const t = track.stages[i];
    const saved = Math.min(t.saved, s.rows);
    const done = finished || (saved >= s.rows && s.rows > 0) || (firstOpen !== -1 && i < firstOpen && saved > 0);
    const running = !done && !finished && (status === "executing" || status === "approved") && i === (firstOpen === -1 ? 0 : firstOpen);
    const step: PanelStep = { id: `stage-${s.n}`, titleAr: s.titleAr, state: done ? "done" : running && status === "executing" ? "running" : "waiting" };
    if (saved > 0 || running || t.found > 0) {
      // what is in the file, with the noun of the stage; the bar follows the whole work of the stage (reading, checking, saving), so it moves while items are found and checked
      step.countAr = deliveredOfAr(saved, s.rows, t.noun);
      step.savedN = saved;
      step.plannedN = s.rows;
      step.ratio = done ? 1 : t.ratio;
      const lines = done && finished ? [] : stageMetricLines(t);
      if (lines.length > 0) step.metricsAr = lines;
      if (t.excluded > 0) step.excludedAr = `استُبعد ${formatAr(t.excluded)} لأنه لا يخص طلبك`;
    }
    if (!s.deliver) step.detailAr = "تُستخدم في المرحلة التالية";
    // THE TRUTH ABOUT A PARENT STAGE, from the item store: how many parents were read and, at the end, how many of them have items in the file (never «١٠ من ١٠» when only some parents gave results)
    if (stages.some((c) => c.parentN === s.n) && (saved > 0 || t.found > 0)) {
      const read = typeof resultCounts?.[`stage_${s.n}_read`] === "number" ? Math.floor(resultCounts[`stage_${s.n}_read`]) : saved;
      const used = typeof resultCounts?.[`stage_${s.n}_used`] === "number" ? Math.floor(resultCounts[`stage_${s.n}_used`]) : null;
      step.countAr = parentCountAr({ read, max: s.rows, used, noun: t.noun, finished });
    }
    return step;
  });
  const failedStop = status === "failed";
  if (failedStop) for (const s of steps) if (s.state === "running" || s.state === "waiting") { s.state = "stopped"; }
  steps.push({ id: "files", titleAr: FILES_STEP_TITLE_AR, state: input.filesReady ? "done" : finished ? "done" : failedStop ? "stopped" : "waiting" });
  return { steps, samples, savedTotal: savedTotalNow, plannedTotal, track };
}

/** What a parent stage says about itself: while it works, how many were read of the most it may read; at the end, how many were read and how many of them have items in the file. */
export function parentCountAr(input: { read: number; max: number; used: number | null; noun: Parameters<typeof countAr>[1]; finished: boolean }): string {
  if (!input.finished || input.used === null) return `قُرئ ${countAr(input.read, input.noun)}، والحد الأقصى ${formatAr(input.max)}`;
  return `قُرئ ${countAr(input.read, input.noun)}، ومنها ${formatAr(input.used)} لها نتائج في ملفك`;
}

const FILE_LABEL_AR: Record<string, string> = { xlsx: "تنزيل ملف إكسل", csv: "تنزيل نسخة سي إس في" };

/**
 * «تقدر تقفل الصفحة» is said ONLY when closing the page is really safe: the mission is approved (its work is in the worker's hands on the server, not in this browser) AND the worker is alive right now (a fresh heartbeat).
 * The e-mail is promised only when one will really be sent (a real address, the customer's «done» e-mails on). With no proof (no queue reading, a dead worker) the line is not shown and the panel's honest delay line speaks.
 */
export function closePageLine(status: string, queue: QueueInfo | null | undefined, emailWillBeSent: boolean | undefined): string | null {
  if (status !== "approved" && status !== "executing") return null;
  if (!queue || !queue.workerAlive) return null;
  return emailWillBeSent === false ? AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR : AGENT_CLOSE_PAGE_LINE_AR;
}

export function customerMissionView(input: { mission: MissionRowForCustomer; events: EventForCustomer[]; queue?: QueueInfo | null; callsMade?: number; now?: number; /** Will the completion e-mail really be sent (real address, e-mails on)? Unknown: it is promised (the old default). */ emailWillBeSent?: boolean }): CustomerMissionView {
  const { mission } = input;
  const now = input.now ?? Date.now();
  // the run's measured memory is for the admin: the customer never sees it
  const events = input.events.filter((e) => !isInternalEvent(e)).sort((a, b) => a.id - b.id);
  const basePhase = PHASE_OF_STATUS[mission.status] ?? "waiting";
  const plan = mission.plan_public && typeof mission.plan_public === "object" ? mission.plan_public : null;
  const { stages, total } = stagesView(plan);
  const planned = stages.filter((s) => s.deliver).reduce((n, s) => n + s.rows, 0);
  // the request: the target the plan was approved at, plus what a lower target (proposed with a reason) left out of it
  const quantity = plan?.quantity && typeof plan.quantity === "object" ? plan.quantity : null;
  const requestedRows = planned + (quantity ? Math.max(0, Math.floor(Number(quantity.requested) || 0) - Math.floor(Number(quantity.target) || 0)) : 0);
  const delivered = mission.delivered_units;
  const phase: CustomerPhase = basePhase === "done" && delivered !== null && requestedRows > 0 && delivered < requestedRows ? "partial" : basePhase;
  const q = queueLine(mission.status, input.queue ?? null);
  const filesReady = Array.isArray(mission.files) && mission.files.length > 0;
  const { steps, track } = stepsOf({ phase, status: mission.status, stages, events, callsMade: input.callsMade ?? 0, hasPlan: plan !== null, delivered, filesReady, now });

  const lastEvent = events[events.length - 1];
  const lastAt = lastEvent ? Date.parse(lastEvent.created_at) : NaN;
  const progressLine = [...events].reverse().find((e) => e.kind === "progress" || e.kind === "system")?.message_ar ?? null;
  const running = steps.find((s) => s.state === "running");
  let delayAr: string | null = null;
  // how long since anything moved: the last event, or the creation of the mission when there is none yet
  const quietSince = Number.isFinite(lastAt) ? lastAt : Date.parse(mission.created_at);
  if ((mission.status === "executing" || mission.status === "planning") && Number.isFinite(quietSince)) {
    const quietMs = now - quietSince;
    const planningNow = mission.status === "planning";
    if (quietMs > AGENT_STALL_AFTER_MS) delayAr = planningNow ? STALLED_PLANNING_AR : STALLED_RUNNING_AR;
    else if (quietMs > AGENT_SLOW_AFTER_MS) delayAr = planningNow ? SLOW_PLANNING_AR : SLOW_RUNNING_AR;
  }
  if (input.queue && !input.queue.workerAlive && (mission.status === "queued" || mission.status === "approved" || mission.status === "executing" || mission.status === "planning")) delayAr = "الخدمة متوقفة مؤقتًا. مهمتك محفوظة وتكمل أول ما تعود للعمل.";

  // the time left: by code, from the measured speed, smoothed, and only when the estimates agree (never a number that jumps)
  const remainingAr: string | null = mission.status === "executing" ? remainingLineAr(track.remainingSeconds, track.ratio) : null;
  const currentLineAr = q.lineAr ?? (running ? (running.countAr ? `${running.titleAr} · ${running.countAr}` : running.titleAr) : progressLine ?? steps.find((s) => s.state === "waiting")?.titleAr ?? "");

  // THE RESULT, in the words of the wallet: what was delivered of what was requested (with the noun of the request), then the hold, the charge and the released hold, each with the same number the wallet shows
  const resultLinesAr: string[] = [];
  if (delivered !== null && (phase === "done" || phase === "partial" || phase === "failed" || phase === "unserved")) {
    const noun = itemNounOfPlan(plan);
    if (requestedRows > 0 && delivered > 0) resultLinesAr.push(`تم تسليم ${deliveredOfAr(delivered, requestedRows, noun)}.`);
    else if (requestedRows > 0) resultLinesAr.push("لم يُسلَّم أي شيء.");
    if (mission.charged_points !== null && Number(mission.reserved_points ?? 0) > 0) resultLinesAr.push(`${moneyLineAr({ reservedPoints: Number(mission.reserved_points), chargedPoints: Number(mission.charged_points), delivered, noun })}.`);
  }
  // a stored summary that carries a number (written before the counts were stated by code) could disagree with the delivered count: it is not shown
  // the words about the files are the files': one workbook with a sheet per stage, never «ملفين» (fileWording.ts)
  const storedSummary = mission.summary_ar && !/[0-9٠-٩]/.test(mission.summary_ar) ? fixFileWordingAr(mission.summary_ar, plan?.stages) : null;

  const endLineAr = endLineOf(phase, resultLinesAr, storedSummary);
  const view: CustomerMissionView = {
    id: mission.id, phase, summaryAr: plan?.summary_ar ? String(plan.summary_ar) : null, notesAr: Array.isArray(plan?.notes_ar) ? plan.notes_ar.map(String) : [], assumptionsAr: Array.isArray(plan?.assumptions_ar) ? plan.assumptions_ar.map(String) : [], unservedAr: Array.isArray(plan?.unserved_ar) ? plan.unserved_ar.map(String) : [],
    questionOptionsAr: phase === "question" && Array.isArray((mission.plan_public as any)?.question_options) ? (mission.plan_public as any).question_options.map(String).slice(0, 4) : [], stages, totalRows: total, totalRowsAr: countAr(total, itemNounOfPlan(plan)),
    samples: plan ? samplesView(plan) : null, fileContentsAr: plan ? fileContentsAr(plan) : null, priceLineAr: plan ? priceLineAr(plan) : null, priceFacts: plan ? priceFactsOf(plan).facts : [], priceNoteAr: plan ? priceFactsOf(plan).noteAr : null, questionAr: phase === "question" ? mission.question_ar : null,
    queueLineAr: q.lineAr, queuePosition: q.position, steps, currentLineAr, delayAr, remainingAr,
    closePageAr: closePageLine(mission.status, input.queue, input.emailWillBeSent),
    resultLinesAr, resultSummaryAr: phase === "done" || phase === "partial" || phase === "unserved" || phase === "failed" ? storedSummary : null,
    files: filesReady ? mission.files!.filter((f) => FILE_LABEL_AR[f.kind]).map((f) => ({ name: f.name, kind: f.kind, labelAr: FILE_LABEL_AR[f.kind] })) : [],
    requestedRows, endLineAr, edit: phase === "plan" && plan?.edit && typeof plan.edit === "object" ? (plan.edit as PlanEditorView) : null,
    startedAt: (events.length ? Date.parse(events[0].created_at) : Date.parse(mission.created_at)) || null,
    live: isLivePhase(phase),
  };
  return guardViewText(view);
}

/**
 * Every customer text of a view, passed through the render-time guard: whatever a stored field holds (an older mission's title or summary, an event the model wrote, a release reason), the customer never reads an English or an internal
 * phrase, in any state of the mission. Data cells (the samples) and file names are the customer's data, not messages, and are left as they are.
 */
export function guardViewText(v: CustomerMissionView): CustomerMissionView {
  const g = (s: string): string => customerSafeText(s);
  const n = (s: string | null): string | null => (s === null ? null : customerSafeText(s) || null);
  return {
    ...v,
    summaryAr: n(v.summaryAr), notesAr: v.notesAr.map(g).filter(Boolean), assumptionsAr: v.assumptionsAr.map(g).filter(Boolean), unservedAr: v.unservedAr.map(g).filter(Boolean), questionOptionsAr: v.questionOptionsAr.map(g).filter(Boolean),
    stages: v.stages.map((s) => ({ ...s, titleAr: g(s.titleAr) || "مرحلة", noteAr: n(s.noteAr) })),
    samples: v.samples ? { ...v.samples, stageTitleAr: g(v.samples.stageTitleAr) } : null,
    fileContentsAr: n(v.fileContentsAr), priceLineAr: n(v.priceLineAr), priceNoteAr: n(v.priceNoteAr), questionAr: n(v.questionAr), queueLineAr: n(v.queueLineAr),
    steps: v.steps.map((s) => ({ ...s, titleAr: g(s.titleAr) || "خطوة", ...(typeof s.countAr === "string" ? { countAr: g(s.countAr) } : {}) })),
    currentLineAr: g(v.currentLineAr), delayAr: n(v.delayAr), remainingAr: n(v.remainingAr), closePageAr: n(v.closePageAr),
    resultLinesAr: v.resultLinesAr.map(g).filter(Boolean), resultSummaryAr: n(v.resultSummaryAr), endLineAr: n(v.endLineAr),
  };
}

/** THE HONEST END SENTENCE of a mission that ended, said once on the card (and read aloud as a status): what happened, in the customer's words; null while the mission is open. */
function endLineOf(phase: CustomerPhase, resultLinesAr: string[], summary: string | null): string | null {
  switch (phase) {
    case "done": return resultLinesAr[0] ?? "اكتملت مهمتك.";
    case "partial": return resultLinesAr[0] ?? "اكتملت مهمتك بعدد أقل من المطلوب.";
    case "unserved": return summary ?? "لم نتمكن من تجهيز طلبك، ولم يُخصم منك شيء.";
    case "failed": return summary ?? "تعذّر استكمال مهمتك ولم يُخصم منك شيء.";
    case "cancelled": return "أُلغيت هذه المهمة ولم يُخصم شيء.";
    default: return null;
  }
}
