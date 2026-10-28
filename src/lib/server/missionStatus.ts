import { createHash } from "node:crypto";
import { toArabicDigits } from "../arabicDigits";
import { MODEL_PLAN_PARAM } from "../modelPlanner/constants";
import { columnsOfMap } from "../modelPlanner/fieldMap";
import type { StoredModelPlan } from "../modelPlanner/types";
import { MISSION_NOTE_EVENT_TYPE, MISSION_PROGRESS_EVENT_TYPE } from "../reviewCostEvent";
import { missionNotesFromEvents, missionView, phaseOfJob, snapshotsFromEvents, stageCounts, type JobPhase, type MissionStageInfo, type MissionView } from "../missionView";

/**
 * What the mission panel reads for ONE job: the approved plan's stages (their Arabic names), the snapshots the worker wrote after each chunk, the decisions the model made, and a few of
 * the newest rows of the stage that is filling. Read only: it writes nothing and touches no money. A job that is not a model-planned mission answers `mission: false` and the panel is not shown.
 */
export interface MissionStatus {
  mission: boolean;
  phase: JobPhase;
  delivered: number;
  requested: number;
  view: MissionView | null;
  stages: Array<MissionStageInfo & { collected: number; delivered: number }>;
  /** A few of the newest rows of the stage that is filling, in that stage's own Arabic headers. */
  latest: { stageTitleAr: string; columns: Array<{ key: string; titleAr: string }>; rows: string[][] } | null;
  notes: Array<{ kind: string; stage?: number; textAr: string }>;
  /** The job's last failure in plain Arabic (a stopped mission says why). */
  failureAr: string | null;
  /** When the job began (epoch ms), for the elapsed time. */
  startedAt: number | null;
  /** The completion summary in plain Arabic: delivered against requested, rows per delivered stage, what was charged. Empty while the mission runs. */
  summaryAr: string[];
}

const PREVIEW_ROWS = 5;
const PREVIEW_COLUMNS = 4;
const PREVIEW_CHARS = 80;

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" && Number.isFinite(v)) return toArabicDigits(v);
  const t = String(v).replace(/\s+/g, " ").trim();
  return t.length <= PREVIEW_CHARS ? t : `${t.slice(0, PREVIEW_CHARS - 1).trimEnd()}…`;
};

/** The completion summary: counts per stage, delivered against requested, and the charge (never above what was held). Fixed Arabic sentences with numbers. */
export function completionSummaryAr(input: { phase: JobPhase; delivered: number; requested: number; stages: ReadonlyArray<{ titleAr: string; deliver: boolean; delivered: number }>; reserved: number; charged: number }): string[] {
  const lines: string[] = [];
  const f = toArabicDigits;
  if (input.phase === "failed") lines.push("توقفت المهمة قبل أن تكتمل.");
  else if (input.requested > 0) lines.push(input.delivered >= input.requested ? `وصلك كل المطلوب: ${f(input.delivered)} صفًا.` : `وصلك ${f(input.delivered)} من ${f(input.requested)} صفًا مطلوبًا؛ تسلّمت ما جُمع فعلًا.`);
  const per = input.stages.filter((s) => s.deliver && s.delivered > 0).map((s) => `${s.titleAr.replace(/^جمع\s+/, "")} ${f(s.delivered)}`);
  if (per.length > 1) lines.push(`في الملفات: ${per.join(" · ")}.`);
  if (input.charged > 0) lines.push(`خُصم ${f(input.charged)} نقطة فقط${input.reserved > input.charged ? ` من ${f(input.reserved)} محجوزة، وعاد الباقي إلى رصيدك` : ""}.`);
  else lines.push("لم يُخصم أي رصيد.");
  return lines;
}

export const jobIdForQuote = (quoteId: string) => `job_quote_${createHash("md5").update(String(quoteId)).digest("hex")}`;

/** The stored model plan of the quote a job came from (job ids are `job_quote_<md5 of the quote id>`), or null. */
export async function storedPlanOfJob(admin: any, jobId: string, userId: string): Promise<StoredModelPlan | null> {
  try {
    const { data } = await admin.from("plans_quotes").select("id, items").eq("user_id", userId).order("created_at", { ascending: false }).limit(300);
    const quote = (Array.isArray(data) ? data : []).find((q: any) => q?.id && (q.id === jobId || jobIdForQuote(q.id) === jobId));
    const items = Array.isArray(quote?.items) ? quote.items : Array.isArray(quote?.items?.items) ? quote.items.items : [];
    const plan = items[0]?.params?.[MODEL_PLAN_PARAM] as StoredModelPlan | undefined;
    return plan && plan.v === 1 && Array.isArray(plan.steps) ? plan : null;
  } catch {
    return null;
  }
}

export async function loadMissionStatus(admin: any, job: { id: string; user_id: string; status: string; delivered_units?: number | null; target_volume_max?: number | null; error_message?: string | null; created_at?: string | null; reserved_credits?: number | null; charged_credits?: number | null }, now: number = Date.now()): Promise<MissionStatus> {
  const delivered = Math.max(0, Number(job.delivered_units) || 0);
  const requested = Math.max(0, Number(job.target_volume_max) || 0);
  const phase = phaseOfJob(job.status, delivered, requested);
  const startedAt = Number.isFinite(Date.parse(String(job.created_at ?? ""))) ? Date.parse(String(job.created_at)) : null;
  const empty: MissionStatus = { mission: false, phase, delivered, requested, view: null, stages: [], latest: null, notes: [], failureAr: null, startedAt, summaryAr: [] };
  const plan = await storedPlanOfJob(admin, job.id, job.user_id);
  if (!plan?.stages || plan.stages.length !== plan.steps.length) return empty;
  const infos: MissionStageInfo[] = plan.stages.map((s) => ({ titleAr: s.titleAr, deliver: s.deliver, effVolume: s.effVolume }));

  let events: Array<{ message?: string | null; created_at?: string | null; event_type?: string }> = [];
  try {
    const { data } = await admin.from("job_events").select("message, created_at, event_type").eq("job_id", job.id).in("event_type", [MISSION_PROGRESS_EVENT_TYPE, MISSION_NOTE_EVENT_TYPE]).order("created_at", { ascending: false }).limit(120);
    events = (Array.isArray(data) ? data : []).reverse();
  } catch { /* the panel then shows the stages with no progress yet */ }
  const snaps = snapshotsFromEvents(events.filter((e) => e.event_type === MISSION_PROGRESS_EVENT_TYPE));
  const notes = missionNotesFromEvents(events.filter((e) => e.event_type === MISSION_NOTE_EVENT_TYPE));
  const failureAr = phase === "failed" && typeof job.error_message === "string" && /[؀-ۿ]/.test(job.error_message) ? job.error_message : null;
  const view = missionView({ stages: infos, snaps, phase, notes, now, deliveredTotal: delivered, ...(failureAr ? { failureReasonAr: failureAr } : {}) });
  const last = snaps[snaps.length - 1];
  const endedCounts = stageCounts(infos, last, phase === "queued" || phase === "running" ? undefined : delivered);
  const stages = infos.map((s, i) => ({ ...s, collected: last?.stages[i]?.c ?? 0, delivered: s.deliver ? endedCounts[i] : last?.stages[i]?.d ?? 0 }));

  // the newest rows of the stage that is filling (the deepest stage that has rows), from the last saved page
  let latest: MissionStatus["latest"] = null;
  const live = phase === "queued" || phase === "running";
  if (live) {
    try {
      const bucket = admin.storage?.from?.("partials");
      const lastStep = Math.max(0, Math.floor(Number((await admin.from("jobs").select("step").eq("id", job.id).maybeSingle())?.data?.step) || 0) - 1);
      const rows: Array<Record<string, any>> = [];
      if (bucket?.download) {
        for (let step = lastStep; step >= Math.max(0, lastStep - 1) && rows.length < 40; step -= 1) {
          try {
            const { data: blob } = await bucket.download(`${job.id}/step_${step}.json`);
            if (!blob) continue;
            const parsed = JSON.parse(typeof blob.text === "function" ? await blob.text() : String(blob));
            if (Array.isArray(parsed?.rows)) rows.unshift(...parsed.rows);
          } catch { /* a page that cannot be read only means fewer rows */ }
        }
      }
      const stageOf = [...rows].reverse().find((r) => typeof r?.mission_stage === "number")?.mission_stage as number | undefined;
      if (rows.length > 0) {
        const index = stageOf ? stageOf - 1 : plan.steps.length - 1;
        const step = plan.steps[index];
        const columns = columnsOfMap(step.fieldMap).slice(0, PREVIEW_COLUMNS);
        const mine = rows.filter((r) => (stageOf ? r.mission_stage === stageOf : true)).slice(-PREVIEW_ROWS);
        if (mine.length > 0) latest = { stageTitleAr: infos[index]?.titleAr ?? "", columns: columns.map((c) => ({ key: c.key, titleAr: c.titleAr })), rows: mine.map((r) => columns.map((c) => cell(r[c.key]))) };
      }
    } catch { /* counts only */ }
  }
  const summaryAr = phase === "queued" || phase === "running" ? [] : completionSummaryAr({ phase, delivered, requested, stages, reserved: Number(job.reserved_credits) || 0, charged: Number(job.charged_credits) || 0 });
  return { mission: true, phase, delivered, requested, view, stages, latest, notes, failureAr, startedAt, summaryAr };
}
