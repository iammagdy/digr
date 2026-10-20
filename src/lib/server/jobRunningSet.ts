import { createHash } from "node:crypto";

/**
 * What a chunk needs to know about the chunks before it, kept as ONE small running record per chunk instead of being rebuilt from
 * every earlier chunk's rows: the identities of the rows already accepted or sent to review (so a repeated row is neither delivered
 * nor billed twice), the cursors already used (so a source that repeats a page stops the job), and how many rows each earlier page
 * accepted (the stop rule for pages that find nothing).
 *
 * `seen_<n>.json` holds the state AFTER chunk n, and chunk n+1 reads only `seen_<n>.json`. Snapshots are per chunk, never one
 * rewritten file, so a chunk that is killed and re-run reads the same earlier snapshot it read the first time and writes the same
 * snapshot again: nothing it did before dying can make its own rows look like duplicates. A missing or unreadable snapshot is never an
 * error: the state is rebuilt from the earlier chunks' files exactly as before (slower, but identical in result).
 */

export interface RunningSet {
  /** The last chunk this state includes. */
  step: number;
  identities: string[];
  cursors: string[];
  /** Accepted rows of each chunk so far, by chunk (null = unknown). */
  batchUnits: Array<number | null>;
  /** What the automatic review of posts and comments has cost so far, USD (absent for jobs that are not reviewed this way). */
  reviewUsd?: number;
}

export const runningSetKey = (jobId: string, step: number) => `${jobId}/seen_${step}.json`;

/** A cursor in the form kept in the set: short ones as they are, long ones (a chunk cursor can carry a list of videos) as a hash. */
export function cursorKey(cursor: unknown): string {
  const text = String(cursor ?? "");
  return text.length <= 64 ? text : `h:${createHash("sha1").update(text).digest("hex").slice(0, 20)}`;
}

/** The shape of what a chunk stored about itself (the same fields the step file carries). */
export interface StepSummary {
  cursor?: unknown;
  rows?: unknown;
  uncertainRows?: unknown;
  batchUnits?: unknown;
  reviewUsd?: unknown;
}

export const emptyRunningSet = (): RunningSet => ({ step: -1, identities: [], cursors: [], batchUnits: [] });

/** The state after one more chunk, from the state before it. Same rules as the rebuild: rows and review rows count for identity. */
export function extendRunningSet(previous: RunningSet, step: number, summary: StepSummary, identityOf: (row: any) => string | null): RunningSet {
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const review = Array.isArray(summary.uncertainRows) ? summary.uncertainRows : [];
  const identities = new Set(previous.identities);
  for (const row of [...rows, ...review]) {
    const identity = identityOf(row);
    if (identity) identities.add(identity);
  }
  const cursors = new Set(previous.cursors);
  if (typeof summary.cursor === "string" && summary.cursor) cursors.add(cursorKey(summary.cursor));
  const batchUnits = previous.batchUnits.slice(0, step);
  while (batchUnits.length < step) batchUnits.push(null);
  batchUnits[step] = typeof summary.batchUnits === "number" ? summary.batchUnits : Array.isArray(summary.rows) ? rows.length : null;
  const reviewUsd = Number(((previous.reviewUsd ?? 0) + (typeof summary.reviewUsd === "number" && summary.reviewUsd > 0 ? summary.reviewUsd : 0)).toFixed(6));
  return { step, identities: [...identities], cursors: [...cursors], batchUnits, ...(reviewUsd > 0 ? { reviewUsd } : {}) };
}

/**
 * The state after chunks 0..afterStep-1, rebuilt from those chunks' own records (`readStep` returns what a chunk stored, or null when it
 * cannot be read: an unreadable chunk adds no identity and its row count stays unknown, so it can never count as an empty page).
 */
export async function rebuildRunningSet(chunks: number, identityOf: (row: any) => string | null, readStep: (step: number) => Promise<StepSummary | null>): Promise<RunningSet> {
  let state = emptyRunningSet();
  for (let step = 0; step < chunks; step += 1) {
    const prior = await readStep(step);
    if (!prior) {
      const batchUnits = state.batchUnits.slice();
      batchUnits[step] = null;
      state = { ...state, step, batchUnits };
      continue;
    }
    state = extendRunningSet(state, step, prior, identityOf);
  }
  return state;
}

function isRunningSet(value: any, step: number): value is RunningSet {
  return Boolean(value) && value.step === step
    && Array.isArray(value.identities) && value.identities.every((item: unknown) => typeof item === "string")
    && Array.isArray(value.cursors) && value.cursors.every((item: unknown) => typeof item === "string")
    && Array.isArray(value.batchUnits) && value.batchUnits.length === step + 1
    && value.batchUnits.every((item: unknown) => item === null || typeof item === "number")
    && (value.reviewUsd === undefined || (typeof value.reviewUsd === "number" && Number.isFinite(value.reviewUsd)));
}

interface Bucket {
  download?: (path: string) => Promise<{ data: any; error: any }>;
  upload?: (path: string, body: any, options?: any) => Promise<{ data?: any; error?: any }>;
  remove?: (paths: string[]) => Promise<any>;
}

/** The state after chunk `afterStep`, or null when there is no readable snapshot (the caller rebuilds). */
export async function loadRunningSet(partials: Bucket | undefined, jobId: string, afterStep: number): Promise<RunningSet | null> {
  if (afterStep < 0) return emptyRunningSet();
  if (!partials || typeof partials.download !== "function") return null;
  try {
    const { data, error } = await partials.download(runningSetKey(jobId, afterStep));
    if (error || !data) return null;
    const parsed = JSON.parse(typeof data.text === "function" ? await data.text() : String(data));
    return isRunningSet(parsed, afterStep) ? parsed : null;
  } catch {
    return null;
  }
}

/** Stores the state after a chunk. Never throws: a snapshot that could not be stored only means the next chunk rebuilds. */
export async function saveRunningSet(partials: Bucket | undefined, jobId: string, set: RunningSet): Promise<boolean> {
  if (!partials || typeof partials.upload !== "function") return false;
  try {
    const res = await partials.upload(runningSetKey(jobId, set.step), Buffer.from(JSON.stringify(set), "utf-8"), { contentType: "application/json", upsert: true });
    return !res?.error;
  } catch {
    return false;
  }
}

/** Removes snapshots that no later chunk can read any more. Never throws. */
export async function removeRunningSets(partials: Bucket | undefined, jobId: string, steps: number[]): Promise<void> {
  if (!partials || typeof partials.remove !== "function" || steps.length === 0) return;
  try {
    await partials.remove(steps.filter((step) => step >= 0).map((step) => runningSetKey(jobId, step)));
  } catch {
    // best effort
  }
}
