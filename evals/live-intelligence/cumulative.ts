import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AUTHORIZED_TOTAL_ATTEMPTS, AUTHORIZED_TOTAL_USD, GuardRefusal } from "./budget";

/**
 * THE CUMULATIVE BUDGET OF EVERY EVALUATION RUN (docs/LIVE-INTELLIGENCE-EVAL.md, the LLM quality mission).
 *
 * One state file on disk, OUTSIDE the repository, holds what every run has spent and what is reserved right now:
 *   - it is CREATED once (`init`), with a ceiling no higher than the owner's authorization; a later run can never re-create, reset or raise it;
 *   - a run holds an exclusive LOCK file for its whole life (`O_EXCL`): a second run at the same time is refused, so concurrent runs cannot bypass the ceiling. A lock left by a process that is no longer alive is taken over, and every
 *     reservation that process left in flight is charged in full (it may have been billed);
 *   - before EVERY paid attempt the worst-case cost is RESERVED and written to disk (fsync, atomic rename) before the request is sent; after it the actual cost replaces the reservation. A network failure is charged its whole
 *     reservation. A process killed mid-request leaves its reservation counted;
 *   - the file carries a checksum: a missing, unreadable, corrupt or tampered state after the budget was created FAILS CLOSED (no paid call), and so does any write that cannot be completed.
 * Pure Node file I/O; nothing here reads the API key.
 */
export const STATE_FILE = "budget-state.json";
export const LOCK_FILE = "budget.lock";
const VERSION = 1;

export interface Reservation { usd: number; caseId: string; at: string; pid: number }
export interface CumulativeState {
  v: typeof VERSION;
  ceilingUsd: number;
  maxAttempts: number;
  /** Settled cost of every attempt so far (actual cost, or the whole reservation when the outcome is unknown). */
  spentUsd: number;
  /** Paid attempts made (each reservation counts one, whatever its outcome). */
  attempts: number;
  inflight: Record<string, Reservation>;
  runs: number;
  createdAt: string;
  updatedAt: string;
}

export interface CumulativeBudget {
  /** Reserves `usd` for one paid attempt (written to disk before it returns). Throws GuardRefusal when the ceiling or the attempt cap would be passed, or the state cannot be read or written. */
  reserve(usd: number, caseId: string): string;
  /** Replaces a reservation with the attempt's actual cost. */
  settle(id: string, actualUsd: number): void;
  snapshot(): { spentUsd: number; inflightUsd: number; attempts: number; ceilingUsd: number; maxAttempts: number; runs: number; recoveredUsd: number };
  /** Releases the lock (reservations still in flight stay counted). */
  close(): void;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;
const digest = (s: CumulativeState) => createHash("sha256").update(JSON.stringify(s)).digest("hex");

function readState(file: string): CumulativeState {
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { throw new GuardRefusal("budget_state_missing"); }
  let doc: { state?: CumulativeState; sha256?: string };
  try { doc = JSON.parse(raw); } catch { throw new GuardRefusal("budget_state_corrupt"); }
  const s = doc?.state;
  if (!s || typeof doc.sha256 !== "string" || digest(s) !== doc.sha256) throw new GuardRefusal("budget_state_corrupt");
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (s.v !== VERSION || !num(s.ceilingUsd) || !num(s.spentUsd) || !num(s.attempts) || !num(s.maxAttempts) || !s.inflight || typeof s.inflight !== "object") throw new GuardRefusal("budget_state_corrupt");
  if (s.ceilingUsd > AUTHORIZED_TOTAL_USD || s.maxAttempts > AUTHORIZED_TOTAL_ATTEMPTS) throw new GuardRefusal("budget_state_above_authorization");
  for (const r of Object.values(s.inflight)) if (!r || !num(r.usd)) throw new GuardRefusal("budget_state_corrupt");
  return s;
}

function writeState(file: string, s: CumulativeState): void {
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const body = JSON.stringify({ state: s, sha256: digest(s) });
    const fd = openSync(tmp, "w");
    try { writeSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw new GuardRefusal("budget_state_unwritable");
  }
}

const defaultAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code === "EPERM"; }
};

export interface OpenOptions {
  dir: string;
  /** Creates the state the FIRST time only (refused when it already exists: never a reset). */
  init?: { ceilingUsd: number; maxAttempts: number };
  pid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export function openCumulativeBudget(o: OpenOptions): CumulativeBudget {
  const pid = o.pid ?? process.pid;
  const isAlive = o.isAlive ?? defaultAlive;
  const now = o.now ?? Date.now;
  const file = path.join(o.dir, STATE_FILE);
  const lock = path.join(o.dir, LOCK_FILE);
  if (o.init) {
    if (!(o.init.ceilingUsd > 0) || o.init.ceilingUsd > AUTHORIZED_TOTAL_USD) throw new GuardRefusal("budget_ceiling_above_authorization");
    if (!(o.init.maxAttempts > 0) || o.init.maxAttempts > AUTHORIZED_TOTAL_ATTEMPTS) throw new GuardRefusal("budget_attempts_above_authorization");
    if (existsSync(file)) throw new GuardRefusal("budget_state_exists_no_reset");
    try { mkdirSync(o.dir, { recursive: true }); } catch { throw new GuardRefusal("budget_state_unwritable"); }
    const t = new Date(now()).toISOString();
    writeState(file, { v: VERSION, ceilingUsd: o.init.ceilingUsd, maxAttempts: o.init.maxAttempts, spentUsd: 0, attempts: 0, inflight: {}, runs: 0, createdAt: t, updatedAt: t });
  }
  // the state must exist before the lock is taken (a run never creates it implicitly)
  readState(file);

  // the exclusive lock of this run
  let recoveredUsd = 0;
  const takeLock = () => { const fd = openSync(lock, "wx"); try { writeSync(fd, JSON.stringify({ pid, at: new Date(now()).toISOString() })); fsyncSync(fd); } finally { closeSync(fd); } };
  try { takeLock(); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw new GuardRefusal("budget_lock_unwritable");
    let holder = -1;
    try { holder = Number(JSON.parse(readFileSync(lock, "utf8"))?.pid); } catch { holder = -1; }
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) throw new GuardRefusal("budget_locked_by_running_process");
    // a dead holder (or an unreadable lock): taken over; the dead run's reservations are charged in full below
    try { unlinkSync(lock); takeLock(); } catch { throw new GuardRefusal("budget_locked_by_running_process"); }
  }
  let held = true;
  try {
    const s = readState(file);
    for (const [id, r] of Object.entries(s.inflight)) { if (r.pid === pid) continue; s.spentUsd = round(s.spentUsd + r.usd); recoveredUsd = round(recoveredUsd + r.usd); delete s.inflight[id]; }
    s.runs += 1;
    s.updatedAt = new Date(now()).toISOString();
    writeState(file, s);
  } catch (e) { try { unlinkSync(lock); } catch { /* */ } held = false; throw e; }

  const mustHold = () => { if (!held) throw new GuardRefusal("budget_closed"); };
  return {
    reserve(usd, caseId) {
      mustHold();
      if (!(usd >= 0) || !Number.isFinite(usd)) throw new GuardRefusal("budget_bad_reservation");
      const s = readState(file);
      const inflight = Object.values(s.inflight).reduce((n, r) => n + r.usd, 0);
      if (s.attempts >= s.maxAttempts) throw new GuardRefusal("cumulative_attempt_cap");
      if (s.spentUsd + inflight + usd > s.ceilingUsd + 1e-12) throw new GuardRefusal("cumulative_usd_cap");
      const id = randomUUID();
      s.inflight[id] = { usd: round(usd), caseId: String(caseId).slice(0, 40), at: new Date(now()).toISOString(), pid };
      s.attempts += 1;
      s.updatedAt = new Date(now()).toISOString();
      writeState(file, s);
      return id;
    },
    settle(id, actualUsd) {
      mustHold();
      const s = readState(file);
      const r = s.inflight[id];
      if (!r) throw new GuardRefusal("budget_unknown_reservation");
      // never less than zero; an actual cost above its reservation is still charged in full (the guard halts the run)
      s.spentUsd = round(s.spentUsd + Math.max(0, Number.isFinite(actualUsd) ? actualUsd : r.usd));
      delete s.inflight[id];
      s.updatedAt = new Date(now()).toISOString();
      writeState(file, s);
    },
    snapshot() {
      const s = readState(file);
      return { spentUsd: s.spentUsd, inflightUsd: round(Object.values(s.inflight).reduce((n, r) => n + r.usd, 0)), attempts: s.attempts, ceilingUsd: s.ceilingUsd, maxAttempts: s.maxAttempts, runs: s.runs, recoveredUsd };
    },
    close() {
      if (!held) return;
      held = false;
      try { unlinkSync(lock); } catch { /* already gone */ }
    },
  };
}
