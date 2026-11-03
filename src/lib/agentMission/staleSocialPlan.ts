import type { PricedPlan } from "./plan";
import { platformOfStages } from "./redesignFlagTypes";

/**
 * PR B (round 18), THE APPROVAL GUARD. A social plan that the plan compiler did not build (it was planned by the old model pipeline, which is deleted) is never approved: it would be carried out by the old engine. It is refused BEFORE anything is reserved (a read of the stored plan, no money function is called),
 * with one honest sentence. A compiled plan (`compiled.by === "compiler"`, every stage built by code) and every non-social plan are untouched. Pure.
 */
export const EXPIRED_SOCIAL_PLAN_AR = "انتهت صلاحية هذه الخطة؛ اطلب البحث من جديد ولن يُخصم منك شيء.";

export function isStaleSocialPlan(plan: Pick<PricedPlan, "stages" | "compiled"> | null | undefined): boolean {
  const stages = plan?.stages;
  if (!plan || !Array.isArray(stages) || stages.length === 0) return false;
  if (platformOfStages(stages as never) === null) return false;
  const compiled = plan.compiled?.by === "compiler" && stages.every((s) => s.engine?.built_by === "code");
  return !compiled;
}
