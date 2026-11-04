import { stage2FlagMode } from "../../../src/lib/agentMission/stage2/flags";
import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { newWriterId, type ItemSnapshot } from "../items/itemStore";
import { missionFactsOf, type MissionFacts } from "../methodology";
import type { AgentStore, MissionEventInput } from "../types";
import type { CompanyMailboxes } from "../workbook";
import { buildLiveSnapshot } from "./liveSnapshot";

/**
 * STAGE 2 S6 (docs/STAGE-2.md): THE WORKER WRITES THE LIVE SHEET while a job runs, only when DIGER_STAGE2_LIVE_SHEET is on for the mission's account. Each snapshot is a CREATE-ONLY object
 * `live/snap_<item-log seq, 9 digits>_<writer>.json` in the mission's folder (never overwritten, so the storage CDN never serves a stale copy; owner decision 2); the newest is the last name of
 * the listing. At most ONE running snapshot per 5 seconds per mission, plus one at `done` (written after the file, with the run's facts, so it equals the file). A write that fails is logged
 * and ignored: it never slows, stops or fails a run, and it touches nothing else (no money line, no row, no count).
 */
export const LIVE_FOLDER = "live";
export const LIVE_MIN_INTERVAL_MS = 5_000;
export const liveSnapshotPath = (lastSeq: number, writer: string, done = false): string => `${LIVE_FOLDER}/snap_${String(Math.max(0, Math.floor(lastSeq))).padStart(9, "0")}_${writer}${done ? "_done" : ""}.json`;

type LiveEvent = { kind: string; created_at: string; counts?: Record<string, unknown> | null };
/** The live events this worker emitted per mission (the work log is made from their NUMBERS only); kept in memory for the done snapshot of the same run. */
const eventsOf = new Map<string, LiveEvent[]>();

/** Is the live sheet on for this account? Unset (today): no, and nothing is read. «test»: the account must be a test account (`isTest` is asked only then). */
export async function liveSheetOn(isTest: () => Promise<boolean>, env?: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const mode = stage2FlagMode("DIGER_STAGE2_LIVE_SHEET", env);
  if (mode === "off") return false;
  if (mode === "on") return true;
  try { return await isTest(); } catch { return false; }
}

export interface LiveWriterDeps {
  store: Pick<AgentStore, "putNew">;
  missionId: string;
  /** The plan as the customer approved it. */
  plan: PricedPlan;
  items: { snapshotOfMemory(): ItemSnapshot };
  writerId: string;
  now?: () => number;
  log?: (line: string) => void;
}

export interface LiveWriter {
  /** Wraps the run's own event writer: the event is stored as before, its numbers are kept, and a throttled snapshot is written in the background. */
  addEvent(e: MissionEventInput, store: () => Promise<void>): Promise<void>;
  /** Waits for a background write to finish (the tests, and the end of the run). */
  flush(): Promise<void>;
  /** How many snapshots were written (the tests). */
  written(): number;
}

export function createLiveWriter(deps: LiveWriterDeps): LiveWriter {
  const now = deps.now ?? Date.now;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let lastSeqWritten = -1;
  let lastEvents = -1;
  let count = 0;
  let chain: Promise<void> = Promise.resolve();
  const events = eventsOf.get(deps.missionId) ?? [];
  eventsOf.set(deps.missionId, events);
  const tick = async (): Promise<void> => {
    const at = now();
    if (at - lastWriteAt < LIVE_MIN_INTERVAL_MS) return;
    try {
      const snap = deps.items.snapshotOfMemory();
      if (snap.lastSeq === lastSeqWritten && events.length === lastEvents) return;
      const live = buildLiveSnapshot({ missionId: deps.missionId, plan: deps.plan, snap, status: "running", events, nowMs: at });
      lastWriteAt = at;
      await deps.store.putNew(deps.missionId, liveSnapshotPath(snap.lastSeq, deps.writerId), JSON.stringify(live), "application/json");
      lastSeqWritten = snap.lastSeq;
      lastEvents = events.length;
      count += 1;
    } catch (e) {
      deps.log?.(`live_snapshot_not_written ${deps.missionId} ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
  };
  return {
    async addEvent(e, store) {
      await store();
      try {
        events.push({ kind: e.kind, created_at: new Date(now()).toISOString(), counts: (e.counts ?? null) as Record<string, unknown> | null });
        chain = chain.then(tick, tick);
      } catch { /* the live sheet never touches the run */ }
    },
    flush: () => chain,
    written: () => count,
  };
}

/**
 * THE DONE SNAPSHOT, written right after the file (same rows, same layout, the run's facts): it equals the file. Never throws: a failure is logged and the run goes on as before.
 */
export async function writeDoneSnapshot(input: {
  store: Pick<AgentStore, "putNew">; missionId: string; plan: PricedPlan; snap: ItemSnapshot; writerId: string; facts?: MissionFacts; companyMailboxes?: CompanyMailboxes; nowMs: number; log?: (line: string) => void;
}): Promise<boolean> {
  try {
    const live = buildLiveSnapshot({ missionId: input.missionId, plan: input.plan, snap: input.snap, status: "done", facts: input.facts, companyMailboxes: input.companyMailboxes, events: eventsOf.get(input.missionId) ?? [], nowMs: input.nowMs });
    await input.store.putNew(input.missionId, liveSnapshotPath(input.snap.lastSeq, input.writerId, true), JSON.stringify(live), "application/json");
    eventsOf.delete(input.missionId);
    return true;
  } catch (e) {
    input.log?.(`live_snapshot_not_written ${input.missionId} done ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    return false;
  }
}

/** The longest the done snapshot may take: past it the write is given up (the run has already been settled; it only delays the mission's last status). */
export const DONE_SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * THE DONE SNAPSHOT, SAFE TO CALL AFTER THE SETTLEMENT (the safety fix): it receives the RAW inputs, and the flag check, the account check, the facts, the mailboxes, the writer id and the write ALL happen
 * inside one try that logs (`live_snapshot_not_written ...`) and swallows. It never throws, never changes a status or a money value, and gives up after `timeoutMs` so a hung storage cannot hold the
 * run. Nothing is evaluated unless DIGER_STAGE2_LIVE_SHEET is on for the account and a result file exists (unset: no account lookup, no builder, no write). Returns whether a snapshot was stored.
 */
export async function writeDoneSnapshotSafely(input: {
  store: Pick<AgentStore, "putNew">;
  missionId: string;
  /** The plan as the customer approved it. */
  plan: PricedPlan;
  snap: ItemSnapshot;
  /** For the file's facts: the request's words and why the review stopped (the same inputs the file was built with). */
  requestText: string | null | undefined;
  reviewStop: "budget" | "failed" | null;
  /** The plan the file was written with (reported and judged): the facts are built from it. Defaults to `plan`. */
  filePlan?: PricedPlan;
  resultPath: string | null;
  mailboxesOf: (plan: PricedPlan, snap: ItemSnapshot) => CompanyMailboxes;
  isTest: () => Promise<boolean>;
  nowMs?: number;
  log?: (line: string) => void;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<boolean> {
  try {
    if (input.resultPath === null) return false;
    if (!(await liveSheetOn(input.isTest, input.env))) return false;
    const filePlan = input.filePlan ?? input.plan;
    const work = writeDoneSnapshot({
      store: input.store, missionId: input.missionId, plan: input.plan, snap: input.snap, writerId: newWriterId(),
      facts: missionFactsOf({ requestText: input.requestText, plan: filePlan, snap: input.snap, reviewStop: input.reviewStop }),
      companyMailboxes: input.mailboxesOf(filePlan, input.snap), nowMs: input.nowMs ?? Date.now(), log: input.log,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<false>((resolve) => { timer = setTimeout(() => { input.log?.(`live_snapshot_not_written ${input.missionId} done gave up after the time limit`); resolve(false); }, input.timeoutMs ?? DONE_SNAPSHOT_TIMEOUT_MS); });
    try { return await Promise.race([work, limit]); } finally { if (timer !== undefined) clearTimeout(timer); }
  } catch (e) {
    try { input.log?.(`live_snapshot_not_written ${input.missionId} done ${String((e as Error)?.message ?? e).slice(0, 120)}`); } catch { /* a log that fails is not a reason to fail */ }
    return false;
  }
}
