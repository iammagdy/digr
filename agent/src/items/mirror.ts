import type { PricedPlan } from "../../../src/lib/agentMission/plan";
import { emptyStageChecks, writeChecks, type MissionChecks } from "../checks";
import { RELEVANCE_REASON_LIST, type RelevanceReason } from "../../../src/lib/agentMission/relevance";
import type { AgentStore } from "../types";
import type { ItemStore } from "./itemStore";

/**
 * THE OLDER FILES, DERIVED. The admin page and the first versions of the tools read `rows/<stage>.json`, `excluded/<stage>.json` and `checks.json`. They are written from the item store (never read to decide anything: an overwritten
 * object may be stale), best effort, after a model-driven save and at the end of a run. The item store is the truth.
 */
const RELEVANCE: ReadonlyArray<string> = RELEVANCE_REASON_LIST;

export async function mirrorLegacyFiles(items: ItemStore, store: AgentStore, plan: PricedPlan, stageKeys: ReadonlyArray<string> = plan.stages.map((s) => s.key)): Promise<void> {
  const checks: MissionChecks = {};
  try {
    for (const stage of plan.stages) {
      if (!stageKeys.includes(stage.key)) continue;
      await items.mirror(stage.key);
      if (!stage.relevance) continue;
      const c = items.counts(stage.key);
      const excluded = [...items.excludedItems(stage.key), ...items.pendingItems(stage.key)].filter((i) => i.row && i.reason && RELEVANCE.includes(i.reason)).map((i) => ({ id: i.id, reason: i.reason as RelevanceReason, row: i.row }));
      await store.putFile(items.missionId, `excluded/${stage.key}.json`, JSON.stringify(excluded), "application/json");
      const sc = emptyStageChecks();
      sc.examined = c.new;
      sc.accepted_by_rule = c.acceptedByRule;
      sc.accepted_by_model = c.acceptedByModel;
      sc.accepted_by_rule_basis = { ...c.acceptedByRuleBasis };
      for (const [reason, n] of Object.entries(c.excludedByReason)) if (RELEVANCE.includes(reason)) sc.excluded[reason as RelevanceReason] = n;
      checks[stage.key] = sc;
    }
    if (Object.keys(checks).length > 0) await writeChecks(store, items.missionId, checks);
  } catch { /* a mirror is a convenience, never a requirement */ }
}
