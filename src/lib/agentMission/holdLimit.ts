import { AGENT_JOB_POINTS_CAP } from "./constants";

/**
 * THE LIMIT A HOLD IS ABOVE (live round 11): the job cap (`AGENT_JOB_POINTS_CAP`, jobPointsCap.ts: read only), or the customer's balance when it is the lower of the two. Pure and tiny on purpose: the card (the browser) imports only this.
 * A balance that is not known (loading, failed: null) is never a limit, and never read as zero.
 */
export interface HoldLimit { kind: "cap" | "balance"; reserve_points: number; limit_points: number }
export function holdLimitOf(reservePoints: number, balancePoints: number | null | undefined, cap: number = AGENT_JOB_POINTS_CAP): HoldLimit | null {
  const lowerBalance = typeof balancePoints === "number" && Number.isFinite(balancePoints) && balancePoints < cap;
  const limit = lowerBalance ? Math.max(0, Math.floor(balancePoints as number)) : cap;
  return reservePoints > limit ? { kind: lowerBalance ? "balance" : "cap", reserve_points: reservePoints, limit_points: limit } : null;
}
