import { randomBytes } from "node:crypto";

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
