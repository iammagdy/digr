/**
 * THE MARKER OF A FREE RE-RUN (freeRerun.ts), client-safe: the panel, the notices and the admin page read it from the mission's events.
 * Its counts keys are internal (constants.ts MISSION_INTERNAL_COUNT_KEYS): the customer never sees these events, only the money line that says the mission was free.
 */
export const FREE_RERUN_MARK = "free_rerun";
export const FREE_RERUN_HOLD_GRANT = "free_rerun_hold_grant";
export const FREE_RERUN_REFUND = "free_rerun_refund";

type EventRow = { counts?: Record<string, unknown> | null };
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Is this mission a free re-run (one of its events carries the marker)? */
export const isFreeRerunEvents = (events: ReadonlyArray<EventRow>): boolean => events.some((e) => num(e.counts?.[FREE_RERUN_MARK]) === 1);
/** The reserve granted before the approval (0 when the customer's balance covered it). */
export const holdGrantOf = (events: ReadonlyArray<EventRow>): number => events.reduce((n, e) => n + num(e.counts?.[FREE_RERUN_HOLD_GRANT]), 0);
/** What was given back after the settlement (0 until then). */
export const refundOf = (events: ReadonlyArray<EventRow>): number => events.reduce((n, e) => n + num(e.counts?.[FREE_RERUN_REFUND]), 0);
/** The points the customer is owed back: what was charged, less what was granted before the approval. */
export const refundDue = (chargedPoints: number, holdGrant: number): number => Math.max(0, Math.round(chargedPoints) - Math.round(holdGrant));
