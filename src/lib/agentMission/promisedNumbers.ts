import { cardTotalOf, deliveryDenominatorOf, requestedRowsOf, type PricedPlan } from "./plan";
import { topLevelFactsOf } from "./repliesCard";

/**
 * THE ONE DENOMINATOR of «تم تسليم X من Y» (round 14, delivery contract R1). The file's first sheet and the notice used the same formula written twice (`workbook.ts`, `runMission.ts`); it is written once here and both read it, so the two can never differ. The delivery is told against the top-level
 * rows the customer asked for (the card's total when the delivery is short of it, else the request), and the replies come in addition: their promised number when they were judged at the end of the run, else the replies delivered. Pure; display only: no money.
 * `deliveredByStage` is the rows delivered of each stage.
 */
export function promisedTotalOf(plan: Pick<PricedPlan, "stages" | "quantity">, deliveredByStage: Record<string, number>, repliesJudged: boolean): { delivered: number; promised: number } {
  const tl = topLevelFactsOf(plan, deliveredByStage);
  const delivered = plan.stages.filter((s) => s.deliver).reduce((n, s) => n + Math.max(0, deliveredByStage[s.key] ?? 0), 0);
  const deliveredTop = Math.max(0, delivered - tl.repliesDelivered);
  const promised = deliveryDenominatorOf(deliveredTop, cardTotalOf(plan) - tl.repliesPlanned, requestedRowsOf(plan) - tl.repliesPlanned) + (repliesJudged ? tl.repliesPlanned : tl.repliesDelivered);
  return { delivered, promised };
}
