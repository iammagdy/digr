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

/**
 * WHOLE MICRO-DOLLARS, ROUNDED DOWN (DT-20261119-11, D2). The money a call may be given is never more than what is left: 200 points hold 0.145454545… USD of provider money, which is 145,454 micro-dollars, never 145,455. A value that
 * is not a positive amount gives 0 (no request is made with it).
 */
export const floorMicroUsd = (usd: number): number => {
  const micro = Math.floor(Number(usd) * 1_000_000 + 1e-7);
  return Number.isFinite(micro) && micro > 0 ? micro / 1_000_000 : 0;
};

export interface CallMoney {
  /** What ONE request of the call may bill: the header sent to the provider (whole micro-dollars). */
  perRequestUsd: number;
  /** How many requests the call may make (the call and every key-pool hop), or 1 when the money does not stretch to more. */
  attempts: number;
  /** The most the call may bill, all its requests together: what is reserved on every ledger. */
  holdUsd: number;
}

/**
 * THE MOST ONE CALL MAY HOLD (Megz, D-0138): the larger of 0.05 USD and 20 times the call's own estimate bound (the estimate floored at 0.001). A stale stored price up to 20 times too low still passes; a call whose real price is above it gets the provider's 402 as an
 * ordinary failed source; and a call whose charge is UNKNOWN keeps at most this amount, never the whole job.
 */
export const callMoneyCapUsd = (estimateUsd: number): number => Math.max(0.05, 20 * Math.max(Number(estimateUsd) || 0, 0.001));

/**
 * THE MONEY OF ONE CALL (DT-20261119-11 D1/D2, D-0138): the money that is left, but never more than `callMoneyCapUsd`, split over the requests the call can make. `maxShare` (a path with very little money in all, the legacy exploration) keeps back the rest, so one
 * call that cannot be reckoned cannot take it all. When the money does not stretch to the call's own estimate for each request, the call makes ONE request with all of it (an explicit one-attempt path). Null when no positive amount that covers the estimate is
 * left: no request is made.
 */
export function callMoney(leftUsd: number, estimateUsd: number, maxAttempts: number, options: { maxShare?: number } = {}): CallMoney | null {
  const share = options.maxShare !== undefined && options.maxShare > 0 && options.maxShare < 1 ? options.maxShare : 1;
  const need = floorMicroUsd(estimateUsd);
  // the share never takes the call below its own estimate when the money covers it (a call that lands exactly on the money left is made)
  const left = floorMicroUsd(Math.min(Math.max(Number(leftUsd) * share, Math.min(Number(leftUsd), need)), callMoneyCapUsd(estimateUsd)));
  let attempts = Math.max(1, Math.floor(maxAttempts) || 1);
  let per = floorMicroUsd(left / attempts);
  if (per < need && attempts > 1) { attempts = 1; per = left; }
  if (!(per > 0) || per < need) return null;
  return { perRequestUsd: per, attempts, holdUsd: Number((per * attempts).toFixed(6)) };
}

export interface JobCallBudget {
  /** Asks to spend up to `estimateUsd` on the next call. False when that would pass the ceiling: the call must not be made. */
  reserve(estimateUsd: number): boolean;
  /** Reports the call: what it really cost, or null when the cost is unknown (the source may have billed it: the estimate stays counted). */
  settle(estimateUsd: number, actualUsd: number | null): void;
  /** The ceiling in force, or null for no ceiling (jobs that keep their own budget). */
  readonly ceilingUsd: number | null;
  /** Spend counted so far (recorded spend before this chunk plus this chunk's calls). */
  spentUsd(): number;
  /**
   * The money this call may still take, in whole micro-dollars rounded DOWN: the ceiling less what was spent and what OTHER calls hold (`heldUsd` is what this call itself already holds, so it is not counted against itself). `capUsd` lowers the
   * ceiling for this question (the planning stages' kept share). Null when there is no ceiling and no cap.
   */
  leftUsd(heldUsd?: number, capUsd?: number | null): number | null;
  /** Replaces what this call holds (`fromUsd`) by `toUsd` in ONE step, so two calls in flight can never both hold the same money. False (nothing changed) when the larger hold does not fit the ceiling. */
  rehold(fromUsd: number, toUsd: number, capUsd?: number | null): boolean;
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
    leftUsd(heldUsd = 0, capUsd: number | null = null): number | null {
      const top = ceiling === null ? (capUsd === null ? null : capUsd) : capUsd === null ? ceiling : Math.min(ceiling, capUsd);
      if (top === null) return null;
      const others = Math.max(0, inFlight - Math.max(0, Number(heldUsd) || 0));
      return floorMicroUsd(top - spent - others);
    },
    rehold(fromUsd: number, toUsd: number, capUsd: number | null = null): boolean {
      const from = Math.max(0, Number(fromUsd) || 0);
      const to = Math.max(0, Number(toUsd) || 0);
      const top = ceiling === null ? (capUsd === null ? null : capUsd) : capUsd === null ? ceiling : Math.min(ceiling, capUsd);
      if (to > from && top !== null && spent + (inFlight - from) + to > top + EPS) return false;
      inFlight = Math.max(0, inFlight - from) + to;
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
export const JOB_BUDGET_STOP_AR = "تم الوصول إلى الحد الأقصى المسموح لمعالجة هذا الطلب؛ رجع لمحفظتك كاملًا ولم يُخصم أي رصيد.";
