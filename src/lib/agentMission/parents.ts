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

/**
 * HOW MANY PARENTS GAVE LESS THAN THE CUSTOMER'S NUMBER PER PARENT: for a child stage with a per-parent number, the parents read that have fewer children than that number in the file (a video with six comments when ten were asked). It is the real reason a child
 * stage falls short while every parent was read: the source has no more for that parent. Zero when the stage has no parent or no per-parent number.
 */
export function parentsBelowShare(plan: PricedPlan, stageKey: string, rowsByStage: Record<string, Array<Record<string, unknown>>>): number {
  const stage = plan.stages.find((s) => s.key === stageKey);
  if (!stage || stage.parent_key === null || !stage.per_parent_rows) return 0;
  const counts = new Map<string, number>();
  for (const r of rowsByStage[stage.key] ?? []) counts.set(String(r.parent_id ?? ""), (counts.get(String(r.parent_id ?? "")) ?? 0) + 1);
  return (rowsByStage[stage.parent_key] ?? []).filter((p) => (counts.get(String(p.id)) ?? 0) < stage.per_parent_rows!).length;
}
