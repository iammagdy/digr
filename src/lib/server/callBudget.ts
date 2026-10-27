import { DEFAULT_PRICING_BASIS, type PricingBasis } from "../recordPricing";

/**
 * A hard USD budget for ONE job, checked by code BEFORE EVERY provider call (not once per chunk).
 *
 * The chunk-level ceilings (`evaluateSpendCeilings`) decide whether a chunk may start; a social chunk can then make up to six calls, a retry makes more,
 * and nothing between them looked at the money. This budget is asked for each call: «may I spend at most `estimateUsd` more?». A call that would take the
 * job over its ceiling is NOT made; the job settles on what it delivered (charge = ceil(delivered x unit price), the rest of the hold released, as today).
 *
 * The ceiling is the lower of
 *  - the job's per-job spend ceiling (the owner's, or the default of three times the plan's expected provider cost, `defaultJobProviderCeilingUsd`), and
 *  - 40% of the value of the hold (owner decision): the points held for the job, at the points' own value (0.10 EGP per point, 55 EGP per USD), times
 *    `HOLD_SPEND_SHARE`. 40% of that value is reserve points / 1,375 USD. A call that would take the job's spend PAST this number is not sent; a call that
 *    lands exactly on it is.
 * Below 0.005 USD the ceiling is lifted to a floor of 0.005 USD (never above the per-job ceiling): see `CALL_CEILING_FLOOR_USD`.
 */
export const HOLD_SPEND_SHARE = 0.4;

/**
 * The floor (owner decision): a tiny hold (1 point = 0.000727 USD of 40%) must still pay for one call, so the ceiling is never below 0.005 USD, EXCEPT that the floor
 * never lifts a ceiling above the per-job spend ceiling: when the per-job ceiling is lower than 0.005, the PER-JOB CEILING WINS.
 * ceiling = max(floor, min(per-job ceiling, 40% of the hold)), with floor = min(0.005, per-job ceiling).
 */
export const CALL_CEILING_FLOOR_USD = 0.005;

export interface JobCallBudget {
  /** Asks to spend up to `estimateUsd` on the next call. False when that would pass the ceiling: the call must not be made. */
  reserve(estimateUsd: number): boolean;
  /** Reports the call: what it really cost, or null when the cost is unknown (the source may have billed it: the estimate stays counted). */
  settle(estimateUsd: number, actualUsd: number | null): void;
  /** The ceiling in force, or null for no ceiling (jobs that keep their own budget). */
  readonly ceilingUsd: number | null;
  /** Spend counted so far (recorded spend before this chunk plus this chunk's calls). */
  spentUsd(): number;
  /** True once a call was refused: nothing more is asked of the provider in this chunk. */
  stopped(): boolean;
  refusals(): number;
}

const EPS = 1e-9;

export function createJobCallBudget(input: { ceilingUsd: number | null; spentUsd: number }): JobCallBudget {
  const ceiling = input.ceilingUsd !== null && Number.isFinite(input.ceilingUsd) ? Math.max(0, input.ceilingUsd) : null;
  let spent = Math.max(0, Number(input.spentUsd) || 0);
  let inFlight = 0;
  let refused = 0;
  return {
    get ceilingUsd() { return ceiling; },
    reserve(estimateUsd: number): boolean {
      const est = Math.max(0, Number(estimateUsd) || 0);
      if (ceiling === null) return true;
      if (spent + inFlight + est > ceiling + EPS) { refused += 1; return false; }
      inFlight += est;
      return true;
    },
    settle(estimateUsd: number, actualUsd: number | null): void {
      const est = Math.max(0, Number(estimateUsd) || 0);
      inFlight = Math.max(0, inFlight - est);
      spent += actualUsd === null || !Number.isFinite(actualUsd) ? est : Math.max(0, actualUsd);
    },
    spentUsd: () => spent,
    stopped: () => refused > 0,
    refusals: () => refused,
  };
}

/** USD value of the points held for a job (the hold's own value, not the provider cost it was priced from). */
export function holdValueUsd(reservePoints: number, basis: PricingBasis = DEFAULT_PRICING_BASIS): number {
  const points = Math.max(0, Number(reservePoints) || 0);
  return (points * basis.creditValueEgp) / basis.usdToEgp;
}

/**
 * The ceiling for one job: the lower of the per-job ceiling (when there is one) and 40% of the value of the hold (when a hold is known), but never below
 * `CALL_CEILING_FLOOR_USD`, and the floor never exceeds the per-job ceiling (a per-job ceiling under 0.005 USD wins). Null when neither is known.
 */
export function jobCallCeilingUsd(input: { perJobUsd: number | null; reservePoints: number | null }, basis: PricingBasis = DEFAULT_PRICING_BASIS): number | null {
  const parts: number[] = [];
  const perJob = input.perJobUsd !== null && Number.isFinite(input.perJobUsd) ? Number(input.perJobUsd) : null;
  if (perJob !== null) parts.push(perJob);
  if (input.reservePoints !== null && Number(input.reservePoints) > 0) parts.push(holdValueUsd(Number(input.reservePoints), basis) * HOLD_SPEND_SHARE);
  if (!parts.length) return null;
  const floor = perJob !== null ? Math.min(CALL_CEILING_FLOOR_USD, perJob) : CALL_CEILING_FLOOR_USD;
  return Math.max(floor, Math.min(...parts));
}

export const JOB_BUDGET_ERROR_CODE = "job_budget_exceeded";

/** What the customer reads when the budget ends a job that delivered nothing (the same sentence as the per-job ceiling of the chunk gate; a test keeps them equal). */
export const JOB_BUDGET_STOP_AR = "تم الوصول إلى الحد الأقصى المسموح لمعالجة هذا الطلب؛ حجز مؤقت مُحرَّر كاملًا ولم يُخصم أي رصيد.";
