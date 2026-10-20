import { MIN_MEASURED_CHUNKS, timingFamilyFor, type MeasuredChunkTiming, type MeasuredTimings, type TimingFamily } from "../missionDuration";

/**
 * The real time of one worker chunk, read (SELECT only) from the jobs that finished and the page events they wrote:
 *  - job_events: the progress line of every page («الصفحة ٣: …») is written when its chunk ends, so the gap between two such
 *    lines (and between the job's start and the first line) is one chunk, wall to wall (calls, saving, the driver's gap);
 *  - jobs: a finished job with no usable events falls back to (updated_at - created_at) / steps.
 * A gap longer than IDLE_GAP_SECONDS is a stall or a wait for the customer's tab, not the cost of a chunk, and is left out.
 * Nothing here writes, reads a price, or touches the ledger.
 */
export const IDLE_GAP_SECONDS = 30 * 60;
const MAX_JOBS_READ = 300;
const MAX_EVENTS_READ = 5000;
const CACHE_MS = 10 * 60 * 1000;

export interface FinishedJobRow {
  id: string;
  endpoint_id?: string | null;
  step?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
}
export interface PageEventRow {
  job_id: string;
  created_at?: string | null;
  message?: string | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/** Chunk durations per family from finished jobs and their page events. Pure. */
export function aggregateChunkTimings(jobs: readonly FinishedJobRow[], events: readonly PageEventRow[]): MeasuredTimings {
  const byJob = new Map<string, number[]>();
  for (const event of events) {
    if (!event?.job_id || typeof event.message !== "string" || !/^الصفحة\s/u.test(event.message)) continue;
    const at = Date.parse(String(event.created_at || ""));
    if (!Number.isFinite(at)) continue;
    const list = byJob.get(event.job_id) || [];
    list.push(at);
    byJob.set(event.job_id, list);
  }
  const gaps = new Map<TimingFamily, number[]>();
  const add = (family: TimingFamily, seconds: number) => {
    if (!(seconds > 0) || seconds > IDLE_GAP_SECONDS) return;
    const list = gaps.get(family) || [];
    list.push(seconds);
    gaps.set(family, list);
  };
  for (const job of jobs) {
    const family = timingFamilyFor(job.endpoint_id);
    const created = Date.parse(String(job.created_at || ""));
    const marks = (byJob.get(job.id) || []).sort((a, b) => a - b);
    if (marks.length >= 2 && Number.isFinite(created)) {
      const all = [created, ...marks];
      for (let i = 1; i < all.length; i++) add(family, (all[i] - all[i - 1]) / 1000);
      continue;
    }
    const updated = Date.parse(String(job.updated_at || ""));
    const steps = Number(job.step) || 0;
    if (steps >= 2 && Number.isFinite(created) && Number.isFinite(updated)) add(family, (updated - created) / 1000 / steps);
  }
  const out: MeasuredTimings = {};
  for (const [family, list] of gaps) {
    if (list.length < MIN_MEASURED_CHUNKS) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const timing: MeasuredChunkTiming = { p50: Number(percentile(sorted, 0.5).toFixed(2)), p90: Number(percentile(sorted, 0.9).toFixed(2)), chunks: sorted.length };
    out[family] = timing;
  }
  return out;
}

let cache: { at: number; value: MeasuredTimings } | null = null;

/** The measured timings, cached for ten minutes; an unreadable database gives «no data» (the defaults), never an error. */
export async function loadMeasuredTimings(admin: any, now: number = Date.now()): Promise<MeasuredTimings> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  try {
    if (!admin || typeof admin.from !== "function") return {};
    const { data: jobs } = await admin
      .from("jobs")
      .select("id, endpoint_id, step, created_at, updated_at")
      .eq("status", "completed")
      .order("created_at", { ascending: false })
      .limit(MAX_JOBS_READ);
    const rows: FinishedJobRow[] = Array.isArray(jobs) ? jobs : [];
    if (rows.length === 0) return {};
    const { data: events } = await admin
      .from("job_events")
      .select("job_id, created_at, message")
      .in("job_id", rows.map((row) => row.id))
      .eq("event_type", "progress")
      .like("message", "الصفحة%")
      .order("created_at", { ascending: true })
      .limit(MAX_EVENTS_READ);
    const value = aggregateChunkTimings(rows, Array.isArray(events) ? events : []);
    cache = { at: now, value };
    return value;
  } catch {
    return {};
  }
}

/** Test hook: forget the cached timings. */
export function resetMeasuredTimingsCache(): void {
  cache = null;
}
