/** Hard limits shared by every live decision-maker job. */
/** The job's BASE provider allowance: the discovery search and the phone lookups. The email allowance of each person is added to it (see `decisionMakerJobSpendCeilingUsd`). */
export const DECISION_MAKER_PROVIDER_SPEND_CAP_USD = 0.04;
/** The per-call cost ceiling of the discovery search and of the phone lookups. */
export const DECISION_MAKER_ROUTE_COST_CAP_USD = 0.005;
/**
 * The per-call cost ceiling of a work-email lookup. At 0.005 the gateway skipped the providers that find emails ("would exceed max cost"):
 * 0 of 6 found; at 0.02, 6 of 6 (measured 2026-10-26, average 0.0111 USD per found address). A miss on a per-success provider is free.
 */
export const DECISION_MAKER_EMAIL_ROUTE_COST_CAP_USD = 0.02;

/**
 * The per-call cost ceiling of the deliverability check of a found work email (about 0.0004 USD measured, 0.0015 catalog price of the usual child):
 * a found address is checked once before it is delivered and charged. Part of every person's allowance in the job ceiling.
 */
export const DECISION_MAKER_VERIFY_ROUTE_COST_CAP_USD = 0.005;

const USD_MICROS = 1_000_000;
const ROUTE_CAP_MICROS = Math.round(DECISION_MAKER_ROUTE_COST_CAP_USD * USD_MICROS);

/**
 * The most a whole job may spend at the source: the base allowance plus, per person wanted, one email ceiling and one deliverability-check ceiling.
 * Never unbounded: it grows with the number of people the customer asked for and with nothing else. 1 person 0.065, 3 people 0.115, 10 people 0.29 USD.
 */
export function decisionMakerJobSpendCeilingUsd(people: number): number {
  const count = Math.max(1, Math.floor(Number(people) || 1));
  return Math.round((DECISION_MAKER_PROVIDER_SPEND_CAP_USD + count * (DECISION_MAKER_EMAIL_ROUTE_COST_CAP_USD + DECISION_MAKER_VERIFY_ROUTE_COST_CAP_USD)) * USD_MICROS) / USD_MICROS;
}

/**
 * Reserve the route ceiling before each outbound people call. This uses the worst case for calls whose provider cost has not been reported yet.
 * When a call comes back with its cost KNOWN (a hit, a free miss, or a refusal), `settleCall` gives back what it did not spend, so a miss that
 * bills 0 does not use up the allowance. A call whose cost is unknown (it timed out: the source may have billed it) keeps its whole reservation.
 * What is left is the job's ceiling minus ACTUAL spend (and the reservation of any call still in flight), so spend can never pass the ceiling.
 */
const capMicros = (capUsd: number): number => Math.round(Math.max(0, capUsd) * USD_MICROS);

export function createDecisionMakerSpendBudget(remainingUsd: number) {
  let remainingMicros = Math.max(0, Math.floor(remainingUsd * USD_MICROS));

  return {
    /** Reserve one call's ceiling (the route ceiling unless the call has its own, like the email lookup's). */
    reserveCall(capUsd: number = DECISION_MAKER_ROUTE_COST_CAP_USD): boolean {
      const cap = capMicros(capUsd);
      if (remainingMicros < cap) return false;
      remainingMicros -= cap;
      return true;
    },
    /**
     * `calls` reservations were made for one lookup (the call and its replays, each at `capUsd`); `actualMicros` is what it cost.
     * `costKnown` false (the call was cut by our time limit, or its answer is still in flight) keeps the FIRST call's reservation: the source may have billed it.
     * The replays read the same idempotency key, which the gateway never bills twice, so their reservations are always given back.
     */
    settleCall(settlement: { calls?: number; actualMicros: number; costKnown: boolean; capUsd?: number }): void {
      const cap = capMicros(settlement.capUsd ?? DECISION_MAKER_ROUTE_COST_CAP_USD);
      const calls = Math.max(1, Math.floor(settlement.calls ?? 1));
      if (!settlement.costKnown) {
        remainingMicros += (calls - 1) * cap;
        return;
      }
      remainingMicros += calls * cap - Math.max(0, Math.floor(settlement.actualMicros) || 0);
    },
    remainingUsd(): number {
      return remainingMicros / USD_MICROS;
    },
  };
}

/**
 * The worst case the daily provider cap and the capacity gate reserve for one worker chunk: the job's own ceiling for that many people (the
 * budget below stops every call before the ceiling, so nothing can spend more). 3 people: 0.04 + 3 x (0.02 + 0.005) = 0.115 USD.
 */
export function estimateDecisionMakerChunkSpendUsd(personCount: number): number {
  return decisionMakerJobSpendCeilingUsd(personCount);
}

export function remainingDecisionMakerSpendUsd(spentUsd: number, ceilingUsd: number = DECISION_MAKER_PROVIDER_SPEND_CAP_USD): number {
  return Math.max(0, ceilingUsd - Math.max(0, spentUsd));
}

/** Read prior actual/estimated provider-cost rows for this job; fail closed if unreadable. */
export async function readDecisionMakerSpendToDate(adminClient: any, jobId: string): Promise<number> {
  const { data, error } = await adminClient
    .from("provider_costs")
    .select("cost_usd,units,is_estimate")
    .eq("job_id", jobId);
  if (error || !Array.isArray(data)) {
    throw new Error("تعذر التحقق من سقف إنفاق المهمة؛ أُوقِف التنفيذ قبل الاتصال بالمصدر.");
  }
  return data.reduce((total: number, row: any) => {
    const reportedCost = Math.max(0, Number(row?.cost_usd) || 0);
    // For DM rows, units stores provider call attempts; retain their route-cap
    // estimate across chunks even when the provider reports a cheaper result.
    const callEstimate = Math.max(0, Number(row?.units) || 0) * DECISION_MAKER_ROUTE_COST_CAP_USD;
    return total + Math.max(reportedCost, callEstimate);
  }, 0);
}
