import { randomBytes } from "node:crypto";
import type { GateContext } from "../../src/lib/server/spendGate/gate";
import type { ReviewCall } from "./review";
import type { WorkerSpendGate } from "./spendGateWiring";

/**
 * ROUND 62: the reservation key of ONE paid attempt. A random part makes every attempt its own reservation, even when a call id is used again after a
 * restart: a retry of a provider call is a new attempt and is never covered by the reservation of an earlier one. (The key is idempotent only for a
 * retry of the DATABASE call itself, which the gate never makes: one reserve per attempt.)
 */
export function spendReservationKey(provider: string, missionId: string | null, callId: string): string {
  return `${provider}:${missionId ?? "none"}:${callId}:${randomBytes(6).toString("hex")}`.slice(0, 200);
}

/**
 * How long a provider reservation is held. It is longer than any provider call of the worker (TREG 90 s, web calls 20 to 30 s). A reservation still held
 * after it expires counts its whole bound as SPENT, never released, so a lost settlement is on the safe side.
 */
export const PROVIDER_RESERVATION_TTL_SECONDS = 300;

/** ROUND 62: the gateways' spend gate of this mission; nothing (not even an undefined key) when the gate is off. */
export function spendGateOf(deps: { spendGate?: WorkerSpendGate }, missionId: string): { spendGate?: GateContext } {
  return deps.spendGate ? { spendGate: deps.spendGate.context(missionId) } : {};
}

/** ROUND 62: the runner's dependencies with this mission's GATED review call (review.ts) when the gate is on; the very same object when it is off. */
export function withMissionSpendGate<D extends { spendGate?: WorkerSpendGate; reviewCall?: ReviewCall }>(deps: D, missionId: string): D {
  return deps.spendGate && deps.reviewCall ? { ...deps, reviewCall: deps.spendGate.reviewCall(missionId) } : deps;
}
