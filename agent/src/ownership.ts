import { AGENT_MISSION_LEASE_SECONDS } from "../../src/lib/agentMission/constants";
import type { AgentStore } from "./types";

/**
 * WORKER OWNERSHIP OF A CLAIMED MISSION (round 55). The claim is atomic (`agent_claim_mission`: FOR UPDATE SKIP LOCKED, then UPDATE … RETURNING), but nothing
 * stopped a worker that LOST its lease (a stall or a database outage longer than the 120 s lease, after which another worker took the mission over through the
 * expired-lease branch of the claim) from going on writing the row, the item log and the files of a mission it no longer owns.
 *
 * Now:
 *  - the heartbeat's lease renewal reports which missions it really renewed (it matches `worker_id = me` only);
 *  - a running mission that was NOT renewed is read once: when the row names ANOTHER worker, this worker has lost it (a row that names no worker, or this one,
 *    was released by our own run as it ended, and is not a loss);
 *  - the run's view of the store is then REVOKED: every write it makes is refused with LeaseLostError (a note on the live panel is dropped: it must never throw),
 *    its model run is aborted, and its error recovery writes nothing (the new owner owns the row).
 * Reads go on. Money is not written through the store: settlement stays idempotent per job in the database (settle_job_atomic, complete_chunk, release_job_atomic).
 */
export class LeaseLostError extends Error {
  constructor(readonly missionId: string) {
    super(`lease_lost ${missionId}: another worker owns this mission; this run writes nothing more`);
    this.name = "LeaseLostError";
  }
}

/** The store methods that WRITE. A revoked run may call none of them (addEvent is dropped instead of refused). */
export const STORE_WRITE_METHODS = ["putFile", "putNew", "putNewStrict", "addCall", "updateMission", "claimMission", "renewLeases", "writeHeartbeat", "publishResult"] as const;

/**
 * THE MONEY GUARD: settlement goes through the database client, not the store, so the store's refusal does not cover it. Called right before every settle or
 * release of a run: a run that lost its mission throws here and never settles, releases or charges a hold the new owner is working against.
 */
export function assertOwned(leaseLost: (() => boolean) | undefined, missionId: string): void {
  if (leaseLost?.()) throw new LeaseLostError(missionId);
}

/**
 * OWNERSHIP COULD NOT BE ESTABLISHED (round 56): the database could not be read, the row is missing, or the row names no worker / is no longer running. This
 * is NOT a loss to another worker (nothing is revoked), but it never authorizes money either: the settlement is not made, the run's error recovery writes
 * nothing (it could otherwise overwrite a row another worker now owns), and the mission is recovered by the existing lease path: the run ends, this worker
 * stops renewing the lease, and once it runs out the claim (`agent_claim_mission`, expired-lease branch) gives the mission to a worker that resumes it from
 * its stored item log and settles it then (settlement is idempotent per job in the database).
 */
export type OwnershipUnverifiedReason = "renew_failed" | "read_failed" | "row_missing" | "no_owner" | "not_running";
export class OwnershipUnverifiedError extends Error {
  constructor(readonly missionId: string, readonly reason: OwnershipUnverifiedReason) {
    super(`ownership_unverified ${missionId} ${reason}: this run does not settle, release or charge`);
    this.name = "OwnershipUnverifiedError";
  }
}

/** True for both ownership refusals: the run must stop and its error recovery must write nothing. */
export const isOwnershipError = (e: unknown): e is LeaseLostError | OwnershipUnverifiedError => e instanceof LeaseLostError || e instanceof OwnershipUnverifiedError;

const RUNNING = new Set(["planning", "executing"]);

/**
 * THE MONEY GUARD, FAIL-CLOSED (round 56; the round 55 version let a row that could not be read, a missing row and a row naming no worker PASS). Called on the
 * line before every settle or release of a run. Ownership is established only by POSITIVE evidence:
 *
 *  1. the lease is RENEWED for this mission (one UPDATE … WHERE id = m AND worker_id = me AND status IN (planning, executing) RETURNING id). The database
 *     itself confirms the row is ours and running, and the fresh lease means no other worker can claim it through the expired-lease branch for the next
 *     lease period: the read-check-write window before the settlement call is closed for that time, not just checked.
 *  2. Only when the renewal did not return the id is the row read, to say WHY:
 *       another worker on the row      → LeaseLostError (the run's ownership is revoked: writes refused, model run stopped);
 *       read error / timeout           → OwnershipUnverifiedError("read_failed");
 *       no row                          → OwnershipUnverifiedError("row_missing");
 *       no worker on the row            → OwnershipUnverifiedError("no_owner");
 *       our id but not running          → OwnershipUnverifiedError("not_running") (it was ended or put back: someone else settles it);
 *       our id, running, and the store cannot report renewals (a legacy store returning nothing): the read is the only evidence there is → passes.
 *
 * A run with no `ownerId` was not claimed by a worker (an in-process harness): no lease exists to check. The production worker always passes its id
 * (main.ts; pinned by tests/ownership-fail-closed.test.ts).
 */
export async function ensureOwned(
  deps: { leaseLost?: () => boolean; ownerId?: string; revokeOwnership?: () => void; leaseSeconds?: number; store: Pick<AgentStore, "getMission" | "renewLeases"> },
  missionId: string,
): Promise<void> {
  assertOwned(deps.leaseLost, missionId);
  const me = deps.ownerId;
  if (!me) return;
  let renewed: string[] | void;
  try {
    renewed = await deps.store.renewLeases(me, deps.leaseSeconds ?? AGENT_MISSION_LEASE_SECONDS, [missionId]);
  } catch (e) {
    if (e instanceof LeaseLostError) throw e; // the run's view was already revoked
    throw new OwnershipUnverifiedError(missionId, "renew_failed");
  }
  if (Array.isArray(renewed) && renewed.includes(missionId)) return;
  let row: Awaited<ReturnType<AgentStore["getMission"]>>;
  try { row = await deps.store.getMission(missionId); } catch { throw new OwnershipUnverifiedError(missionId, "read_failed"); }
  if (!row) throw new OwnershipUnverifiedError(missionId, "row_missing");
  const owner = row.worker_id ?? null;
  if (owner && owner !== me) {
    try { deps.revokeOwnership?.(); } catch { /* the throw below is what stops the settlement */ }
    throw new LeaseLostError(missionId);
  }
  if (!owner) throw new OwnershipUnverifiedError(missionId, "no_owner");
  if (!RUNNING.has(String(row.status))) throw new OwnershipUnverifiedError(missionId, "not_running");
  if (Array.isArray(renewed)) throw new OwnershipUnverifiedError(missionId, "renew_failed"); // ours and running, yet the renewal matched nothing: a race; never assumed
}

export interface OwnedStore {
  /** The store to give the run. */
  store: AgentStore;
  /** From now on every write of this run is refused. */
  revoke(): void;
  revoked(): boolean;
}

export function ownedStore(base: AgentStore, missionId: string): OwnedStore {
  let lost = false;
  const writes = new Set<string>(STORE_WRITE_METHODS);
  const store = new Proxy(base, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (prop === "addEvent") return (...args: unknown[]) => (lost ? Promise.resolve() : fn.apply(target, args));
      if (typeof prop === "string" && writes.has(prop)) return (...args: unknown[]) => (lost ? Promise.reject(new LeaseLostError(missionId)) : fn.apply(target, args));
      return fn.bind(target);
    },
  });
  return { store, revoke: () => { lost = true; }, revoked: () => lost };
}
