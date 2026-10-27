import { formatAr, toArabicDigits } from "./arabicDigits";
import { estimateRemainingSeconds, etaTextAr, type ProgressSample } from "./jobEta";

/**
 * THE MISSION PLAN PANEL «خطة المهمة»: the steps the customer sees, built from the same sources of truth as the mission itself and never written separately.
 *
 *  - BEFORE approval the steps are the planning steps as the planner really takes them: its events (it understood, it searched, it took a sample, it replaced a source, it priced the plan).
 *  - AFTER approval the steps are the approved plan's stages (their Arabic names are in the stored plan) followed by the review and the files; each stage's state and count come from the
 *    snapshots the worker writes after every chunk, and its remaining time from the speed those snapshots really show (nothing until two of them show progress).
 *
 * Pure: no network, no clock of its own. Every text here is a fixed Arabic sentence or an Arabic name made safe by code: no provider, endpoint id, price, English word or internal id.
 */
export type StepState = "done" | "running" | "waiting" | "stopped";

export interface PanelStep {
  id: string;
  titleAr: string;
  state: StepState;
  /** A short real finding or an honest delay («لقيت ٣ مصادر مناسبة»). */
  detailAr?: string;
  /** «١٢ من ١٥٠» of a running or finished stage. */
  countAr?: string;
  /** 0 to 1, for the progress bar of a stage. */
  ratio?: number;
  /** Rows the rules left out («استبعدنا ٥ لعدم مطابقتها»): not delivered, not charged. */
  excludedAr?: string;
  /** The remaining time of THIS stage, or the waiting phrase while the speed is not measured yet; absent for a finished stage. */
  etaAr?: string;
  /** Why a stopped step stopped, in plain Arabic. */
  reasonAr?: string;
}

export const ETA_PENDING_AR = "بنحسب الوقت المتوقع…";
export const SLOW_SOURCE_AR = "المصدر أبطأ من المعتاد، لسه شغالين.";
export const SOURCE_REPLACED_AR = "بدّلنا لمصدر بديل.";
/** A running mission with no new snapshot for this long is called slow (the chunk of a source can take most of a minute). */
export const SLOW_AFTER_MS = 90_000;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// PLANNING

export type PlannerEventKind = "understood" | "searched" | "sampled" | "sample_slow" | "switched" | "adjusting" | "planned" | "asked" | "stopped";
export interface PlannerEvent { kind: PlannerEventKind; at: number; n?: number; rows?: number; stage?: number }

export const PLANNING_STEP_TITLES = ["فهم الطلب", "البحث عن المصادر المناسبة", "تجربة عينة من كل مرحلة", "تجهيز الخطة والسعر"] as const;

const sourcesFoundAr = (n: number): string => {
  if (n <= 0) return "لم نجد مصدرًا مطابقًا بعد، نجرّب كلمات أخرى.";
  if (n === 1) return "لقيت مصدرًا مناسبًا.";
  if (n === 2) return "لقيت مصدرين مناسبين.";
  return n <= 10 ? `لقيت ${toArabicDigits(n)} مصادر مناسبة.` : `لقيت ${toArabicDigits(n)} مصدرًا مناسبًا.`;
};
const sampleRowsAr = (rows: number): string => (rows <= 0 ? "العينة ما رجّعتش صفوف مطابقة." : rows === 1 ? "العينة رجعت صفًا واحدًا مطابقًا." : `العينة رجعت ${toArabicDigits(rows)} ${rows <= 10 ? "صفوف" : "صفًا"} مطابقة.`);

/** The four planning steps and their states from the planner's real events, oldest first. */
export function planningSteps(events: readonly PlannerEvent[], opts: { finished?: "plan" | "asked" | "stopped" | null } = {}): PanelStep[] {
  const has = (kind: PlannerEventKind) => events.some((e) => e.kind === kind);
  const last = <K extends PlannerEventKind>(kind: K) => [...events].reverse().find((e) => e.kind === kind);
  const planned = has("planned") || opts.finished === "plan";
  const searched = has("searched");
  const sampled = has("sampled");
  const any = events.length > 0;
  const steps: PanelStep[] = PLANNING_STEP_TITLES.map((titleAr, i) => ({ id: `plan-${i + 1}`, titleAr, state: "waiting" as StepState }));
  // 1. understanding the request: running until the planner has done anything, done after
  steps[0].state = any ? "done" : "running";
  // 2. the sources
  const search = last("searched");
  steps[1].state = searched ? "done" : any ? "running" : "waiting";
  if (search && typeof search.n === "number") steps[1].detailAr = sourcesFoundAr(search.n);
  // 3. the sample of each stage
  steps[2].state = planned ? "done" : searched ? "running" : "waiting";
  const sample = last("sampled");
  const detail: string[] = [];
  if (sample && typeof sample.rows === "number") detail.push(sampleRowsAr(sample.rows));
  if (has("switched")) detail.push(SOURCE_REPLACED_AR);
  const lastEvent = events[events.length - 1];
  if (lastEvent?.kind === "sample_slow") detail.push(SLOW_SOURCE_AR);
  if (detail.length > 0) steps[2].detailAr = detail.join(" ");
  // 4. the plan and its price
  steps[3].state = planned ? "done" : sampled || has("adjusting") ? "running" : "waiting";
  if (has("adjusting") && !planned) steps[3].detailAr = "بنضبط الخطة على ما رجعته العينة.";
  if (planned) steps[3].detailAr = "الخطة والسعر جاهزان للمراجعة.";
  if (opts.finished === "stopped") for (const s of steps) if (s.state === "running" || s.state === "waiting") { s.state = "stopped"; s.reasonAr = s.reasonAr ?? "لم نتمكن من استكمال التجهيز."; }
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// THE MISSION

export interface MissionStageInfo { titleAr: string; deliver: boolean; effVolume: number }
export interface StageSnap { c: number; d: number; /** Rows the rules left out. */ x: number; e: number; q: number; done: boolean; stopped?: string }
export interface ProgressSnap { at: number; stages: StageSnap[]; delivered: number }
export type JobPhase = "queued" | "running" | "completed" | "partial" | "failed";
export interface MissionNote { kind: string; stage?: number; textAr: string }

export const REVIEW_STEP_TITLE_AR = "مراجعة النتائج";
export const FILES_STEP_TITLE_AR = "تجهيز الملفات";

export interface MissionView {
  steps: PanelStep[];
  /** One line for the bar of the mobile sheet: the running step with its count, else the last finished one. */
  currentLineAr: string;
  /** An honest word when the source is slow or was replaced; null otherwise. */
  delayAr: string | null;
}

const countAr = (c: number, e: number) => `${formatAr(c)} من ${formatAr(e)}`;

/** The snapshots the worker wrote (the `mission_progress` events, oldest first) from their stored rows. A row that cannot be read is skipped. */
export function snapshotsFromEvents(rows: ReadonlyArray<{ message?: string | null; created_at?: string | null }>): ProgressSnap[] {
  const out: ProgressSnap[] = [];
  for (const row of rows) {
    const at = Date.parse(String(row?.created_at ?? ""));
    if (!Number.isFinite(at) || typeof row?.message !== "string") continue;
    try {
      const parsed = JSON.parse(row.message);
      if (!Array.isArray(parsed?.stages)) continue;
      const stages: StageSnap[] = parsed.stages.map((s: any) => ({ c: Math.max(0, Number(s?.c) || 0), d: Math.max(0, Number(s?.d) || 0), x: Math.max(0, Number(s?.x) || 0), e: Math.max(0, Number(s?.e) || 0), q: Math.max(0, Number(s?.q) || 0), done: Boolean(s?.done), ...(typeof s?.stopped === "string" && s.stopped ? { stopped: s.stopped } : {}) }));
      out.push({ at, stages, delivered: stages.reduce((n, s) => n + s.d, 0) });
    } catch { /* not ours */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

export function missionNotesFromEvents(rows: ReadonlyArray<{ message?: string | null }>): MissionNote[] {
  const out: MissionNote[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row?.message ?? ""));
      if (typeof parsed?.textAr === "string" && parsed.textAr) out.push({ kind: String(parsed.kind ?? ""), ...(typeof parsed.stage === "number" ? { stage: parsed.stage } : {}), textAr: parsed.textAr });
    } catch { /* not ours */ }
  }
  return out;
}

/** The steps of an approved mission and their states, counts and remaining times. */
export function missionView(input: { stages: readonly MissionStageInfo[]; snaps: readonly ProgressSnap[]; phase: JobPhase; notes?: readonly MissionNote[]; now: number; failureReasonAr?: string }): MissionView {
  const snaps = [...input.snaps].sort((a, b) => a.at - b.at);
  const snap = snaps[snaps.length - 1];
  const finished = input.phase === "completed" || input.phase === "partial";
  const failed = input.phase === "failed";
  const live = input.phase === "running" || input.phase === "queued";
  const firstOpen = snap ? snap.stages.findIndex((s) => !s.done) : 0;
  const noteOf = (stage: number) => (input.notes ?? []).filter((n) => n.stage === stage + 1 && n.kind === "stage_stopped").pop()?.textAr;

  const steps: PanelStep[] = input.stages.map((info, i) => {
    const s = snap?.stages[i];
    const base: PanelStep = { id: `stage-${i + 1}`, titleAr: info.titleAr, state: "waiting" };
    const e = s?.e || info.effVolume;
    if (s) { base.countAr = countAr(Math.min(s.c, e), e); base.ratio = e > 0 ? Math.min(1, s.c / e) : 0; if (s.x > 0) base.excludedAr = `استبعدنا ${formatAr(s.x)} لعدم مطابقتها`; }
    if (s?.stopped) return { ...base, state: "stopped", reasonAr: s.stopped, etaAr: undefined };
    if (finished) return { ...base, state: "done", ...(s ? { ratio: 1 } : {}) };
    if (s?.done) return { ...base, state: "done", ratio: 1 };
    if (failed) return { ...base, state: "stopped", reasonAr: noteOf(i) ?? input.failureReasonAr ?? "توقفت المهمة قبل هذه المرحلة." };
    const running = live && (snap ? i === firstOpen || (s?.c ?? 0) > 0 || (s?.q ?? 0) > 0 : i === 0 && input.phase === "running");
    if (!running) return base;
    // the remaining time of this stage: only from the speed its own snapshots show
    const samples: ProgressSample[] = snaps.map((x) => ({ at: x.at, delivered: x.stages[i]?.c ?? 0 }));
    const seconds = estimateRemainingSeconds(samples, e, input.now);
    return { ...base, state: "running", etaAr: seconds === null ? ETA_PENDING_AR : (etaTextAr(seconds) ?? ETA_PENDING_AR) };
  });

  const allStagesDone = steps.length > 0 && steps.every((s) => s.state === "done" || s.state === "stopped");
  steps.push({ id: "review", titleAr: REVIEW_STEP_TITLE_AR, state: finished ? "done" : failed ? (allStagesDone ? "stopped" : "stopped") : allStagesDone && live ? "running" : "waiting", ...(failed ? { reasonAr: input.failureReasonAr ?? "توقفت المهمة قبل المراجعة." } : {}) });
  steps.push({ id: "files", titleAr: FILES_STEP_TITLE_AR, state: finished ? "done" : failed ? "stopped" : "waiting", ...(failed ? { reasonAr: "لم تُجهَّز ملفات لهذه المهمة." } : {}) });

  const replaced = (input.notes ?? []).some((n) => n.kind === "source_replaced");
  const stale = live && snap ? input.now - snap.at > SLOW_AFTER_MS : false;
  const delayAr = stale ? SLOW_SOURCE_AR : live && replaced ? SOURCE_REPLACED_AR : null;
  return { steps, currentLineAr: currentLineAr(steps), delayAr };
}

/** The one-line summary of a list of steps: the running step with its count, else the first waiting one, else the last finished. */
export function currentLineAr(steps: readonly PanelStep[]): string {
  const running = steps.find((s) => s.state === "running");
  if (running) return running.countAr ? `${running.titleAr} · ${running.countAr}` : running.titleAr;
  const stopped = steps.find((s) => s.state === "stopped");
  if (stopped) return `${stopped.titleAr} · توقفت`;
  const waiting = steps.find((s) => s.state === "waiting");
  if (waiting) return waiting.titleAr;
  const done = [...steps].reverse().find((s) => s.state === "done");
  return done ? `${done.titleAr} · تمّ` : "خطة المهمة";
}

/** The job's status word as the panel needs it. */
export function phaseOfJob(status: unknown, delivered: number, requested: number): JobPhase {
  const s = String(status ?? "");
  if (s === "queued") return "queued";
  if (s === "running") return "running";
  if (s === "completed" || s === "done") return requested > 0 && delivered < requested ? "partial" : "completed";
  return "failed";
}

/** The customer's panel text rules, as a check: Arabic, no Latin word of three letters or more, no money word, no internal id. */
export function panelTextProblems(steps: readonly PanelStep[]): string[] {
  const problems: string[] = [];
  for (const s of steps) for (const [field, value] of Object.entries({ titleAr: s.titleAr, detailAr: s.detailAr, countAr: s.countAr, excludedAr: s.excludedAr, etaAr: s.etaAr, reasonAr: s.reasonAr })) {
    if (!value) continue;
    if (/[A-Za-z]{3,}/.test(value)) problems.push(`${s.id}.${field}: a Latin word`);
    if (/USD|\$|دولار|\bsk_|treg|tikhub|apify/i.test(value)) problems.push(`${s.id}.${field}: a provider or a price`);
    if (/\b[a-z0-9-]+\.[a-z0-9_.-]{2,}\b/i.test(value)) problems.push(`${s.id}.${field}: an endpoint id`);
  }
  return problems;
}
