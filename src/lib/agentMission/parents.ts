import type { PricedPlan } from "./plan";

/**
 * THE TRUTH ABOUT THE PARENTS, read from the item store at the end: for every stage another stage hangs on, how many parents were read (`stage_<n>_read`) and how many of them have items in the delivered file (`stage_<n>_used`:
 * the distinct parents of the delivered children). The card, the tracker and the file's summary sheet say these two numbers, never the number the plan allowed.
 */
export function parentCountsOf(plan: PricedPlan, rowsByStage: Record<string, Array<Record<string, unknown>>>): Record<string, number> {
  const out: Record<string, number> = {};
  plan.stages.forEach((s, i) => {
    const children = plan.stages.filter((c) => c.parent_key === s.key && c.deliver);
    if (children.length === 0) return;
    out[`stage_${i + 1}_read`] = (rowsByStage[s.key] ?? []).length;
    out[`stage_${i + 1}_used`] = new Set(children.flatMap((c) => (rowsByStage[c.key] ?? []).map((r) => String(r.parent_id ?? "")).filter(Boolean))).size;
  });
  return out;
}
