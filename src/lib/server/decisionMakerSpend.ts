/** Hard limits shared by every live decision-maker job. */
export const DECISION_MAKER_PROVIDER_SPEND_CAP_USD = 0.04;
export const DECISION_MAKER_ROUTE_COST_CAP_USD = 0.005;

const USD_MICROS = 1_000_000;
const ROUTE_CAP_MICROS = Math.round(DECISION_MAKER_ROUTE_COST_CAP_USD * USD_MICROS);

/**
 * Reserve the route ceiling before each outbound people call. This uses the
 * worst case for calls whose provider cost has not been reported yet.
 */
export function createDecisionMakerSpendBudget(remainingUsd: number) {
  let remainingMicros = Math.max(0, Math.floor(remainingUsd * USD_MICROS));

  return {
    reserveCall(): boolean {
      if (remainingMicros < ROUTE_CAP_MICROS) return false;
      remainingMicros -= ROUTE_CAP_MICROS;
      return true;
    },
    remainingUsd(): number {
      return remainingMicros / USD_MICROS;
    },
  };
}

/** Maximum routed calls for one worker chunk: one search, then email and phone per person. */
export function estimateDecisionMakerChunkSpendUsd(personCount: number): number {
  const count = Math.max(0, Math.floor(personCount));
  return Math.min(
    DECISION_MAKER_PROVIDER_SPEND_CAP_USD,
    (1 + count * 2) * DECISION_MAKER_ROUTE_COST_CAP_USD,
  );
}

export function remainingDecisionMakerSpendUsd(spentUsd: number): number {
  return Math.max(0, DECISION_MAKER_PROVIDER_SPEND_CAP_USD - Math.max(0, spentUsd));
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
