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
 * THE MONEY GUARD, CHECKED IN THE DATABASE (security review of round 55): the in-memory flag is set only by the heartbeat, up to 30 s after a takeover, and a run
 * resuming from a stall can reach its settlement first. So right before every settle or release the row is READ: when it names ANOTHER worker, this run's
 * ownership is revoked (`revokeOwnership`: writes refused, model run stopped) and it throws. A row that names no worker or this one passes (our own run may
 * have released it); a row that cannot be read passes too (the settlement itself needs the same database).
 */
export async function ensureOwned(
  deps: { leaseLost?: () => boolean; ownerId?: string; revokeOwnership?: () => void; store: Pick<AgentStore, "getMission"> },
  missionId: string,
): Promise<void> {
  assertOwned(deps.leaseLost, missionId);
  if (!deps.ownerId) return;
  let owner: string | null = null;
  try { owner = (await deps.store.getMission(missionId))?.worker_id ?? null; } catch { return; }
  if (owner && owner !== deps.ownerId) {
    try { deps.revokeOwnership?.(); } catch { /* the throw below is what stops the settlement */ }
    throw new LeaseLostError(missionId);
  }
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
