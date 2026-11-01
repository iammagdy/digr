import type { PricedPlan } from "../../src/lib/agentMission/plan";
import { isEnabled } from "../../src/lib/agentMission/filters";
import { isTestAccount } from "../../src/lib/server/testAccounts";
import type { AgentStore } from "./types";
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

/**
 * IS THIS MISSION'S ACCOUNT A TEST ACCOUNT (S1 live findings fix 1). The classifier knows a test account by its e-mail (the plus-alias `iam.magdy+1@outlook.com`) or by a few known ids; the worker used to ask with the id alone, so the plus-alias account was never a
 * test account and the `test` flag never applied to it. The e-mail is read once (read-only); an e-mail that cannot be read leaves the answer to the id rule: a failure can never switch the new pipeline on.
 */
export async function accountIsTest(store: Pick<AgentStore, "readUserEmail">, userId: string): Promise<boolean> {
  if (isTestAccount({ id: userId })) return true;
  try {
    const email = store.readUserEmail ? await store.readUserEmail(userId) : null;
    return isTestAccount({ id: userId, email });
  } catch { return false; }
}
