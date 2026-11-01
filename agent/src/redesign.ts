import type { PricedPlan } from "../../src/lib/agentMission/plan";
import { isEnabled } from "../../src/lib/agentMission/filters";
import { redesignActive, redesignTypeOf, type RedesignFlags, REDESIGN_TYPES } from "../../src/lib/agentMission/redesignFlags";

/**
 * WHICH STAGES OF AN APPROVED PLAN RUN THE REDESIGNED ENGINE (S1 items 1.1, 1.3, 1.9; docs/REDESIGN-PLAN.md section 5). The plan's request type (from its stages) must be switched on for the account (`on`, or `test` for a test account), AND every stage's
 * recipe must have been BUILT BY CODE (the Stage 1 ordering gate: a model-built recipe never runs raw). A mission with one stage that does not qualify runs entirely on the old path: no half-new mission. Empty set = the old pipeline, byte for byte.
 */
export function redesignStagesOf(plan: Pick<PricedPlan, "stages">, flags: RedesignFlags, isTest: boolean): Set<string> {
  const stages = plan.stages;
  if (stages.length === 0) return new Set();
  const account = stages.some((s) => (s.filters ?? []).some((f) => f.kind === "account" && isEnabled(f) && (f.values ?? []).length > 0));
  const type = redesignTypeOf(stages, { account });
  if (!redesignActive(flags, type, { isTest })) return new Set();
  if (!stages.every((s) => s.engine?.built_by === "code")) return new Set();
  return new Set(stages.map((s) => s.key));
}

/** True when any flag is switched on or to test: only then is the pipeline that ran a mission recorded (all flags off leaves the mission's events exactly as they were). */
export const anyRedesignFlag = (flags: RedesignFlags): boolean => REDESIGN_TYPES.some((t) => flags[t] !== "off");
