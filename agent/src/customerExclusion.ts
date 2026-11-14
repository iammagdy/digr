import { scopedFlagOn } from "../../src/lib/agentMission/scopedFlag";
import type { PricedPlan } from "../../src/lib/agentMission/plan";
import {
  CUSTOMER_EXCLUSION_FLAG_KEY,
  EXCLUSION_SNAPSHOT_PATH,
  exclusionMatcherOf,
  exclusionNotApplicableAr,
  exclusionPlanLineAr,
  parseExclusionSnapshot,
  type ExclusionMatcher,
  type ExclusionSnapshot,
  type PlanExclusionMark,
} from "../../src/lib/agentMission/customerExclusion";
import { exclusionAppliesToStage } from "./items/ingest";
import type { AgentStore, MissionRecord } from "./types";

/**
 * PHASE 5.3: THE CUSTOMER'S EXCLUSION LIST IN THE WORKER (docs/intelligence/PHASE-5-3-AND-6.md).
 *
 * PLANNING (switch `customer_exclusion_files_v1` ON for the mission's account only): the list the chat stored on this mission's card is read (same user, same mission id), copied to the mission's private folder and pinned by
 * its digest on the plan the customer approves, with one honest sentence on the card: applied to the plan's company or people stages, or not applicable to this kind of data. Switch OFF, or no list: the plan is returned as it
 * is (the same object), so nothing changes.
 *
 * EXECUTION (whatever the switch says now: the customer approved the plan WITH the list): the private copy is loaded and its digest must equal the approved one; anything else and the mission does not run (fail closed).
 */

/** Reads the snapshot stored on the mission's card. Null: no list on the card. Throws when the read fails or a stored list is malformed (never a silent «no list»). */
export type ReadMissionExclusion = (missionId: string, userId: string) => Promise<ExclusionSnapshot | null>;

/**
 * The real reader: the assistant message of THIS user that carries THIS mission's card (`plan->>agentMissionId`), newest first: the same lookup as the research brief's. A message of another account can never be read (the
 * user id is the mission row's own), and only the server writes an assistant message's plan (messages RLS: customers insert `role = 'user'` rows with `plan IS NULL`, and have no update policy).
 */
export function missionExclusionReader(client: any): ReadMissionExclusion {
  return async (missionId, userId) => {
    const { data, error } = await client.from("messages").select("plan,created_at").eq("user_id", userId).eq("role", "assistant").eq("plan->>agentMissionId", missionId).order("created_at", { ascending: false }).limit(1);
    if (error) throw new Error("customer_exclusion_read_failed");
    const raw = Array.isArray(data) ? data[0]?.plan?.customerExclusion : undefined;
    if (raw === undefined || raw === null) return null;
    const snapshot = parseExclusionSnapshot(raw);
    if (!snapshot) throw new Error("customer_exclusion_malformed");
    return snapshot;
  };
}

export async function withCustomerExclusion(input: { plan: PricedPlan; mission: MissionRecord; store: AgentStore; settings: Record<string, unknown>; read?: ReadMissionExclusion }): Promise<PricedPlan> {
  const { plan, mission, store } = input;
  if (!input.read || !scopedFlagOn(input.settings[CUSTOMER_EXCLUSION_FLAG_KEY], mission.user_id)) return plan;
  const snapshot = await input.read(mission.id, mission.user_id);
  if (!snapshot) return plan;
  const applies = plan.stages.some(exclusionAppliesToStage);
  // the approved copy, in the mission's private folder (written before the plan is shown: a failure stops here and the existing error path retries the planning)
  if (applies) await store.putFile(mission.id, EXCLUSION_SNAPSHOT_PATH, JSON.stringify(snapshot), "application/json");
  const n = snapshot.entities.length;
  const mark: PlanExclusionMark = { digest: snapshot.digest, entities: n, applies };
  const line = applies ? exclusionPlanLineAr(n) : exclusionNotApplicableAr(n);
  return { ...plan, notes_ar: [...new Set([...(plan.notes_ar ?? []), line])], customer_exclusion: mark };
}

/** The approved list of an approved plan, or null when it cannot be loaded with exactly the approved digest (missing, unreadable, altered). */
export async function loadApprovedExclusion(store: AgentStore, missionId: string, mark: PlanExclusionMark): Promise<ExclusionMatcher | null> {
  try {
    const bytes = await store.getFileBytes(missionId, EXCLUSION_SNAPSHOT_PATH);
    if (!bytes) return null;
    const snapshot = parseExclusionSnapshot(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (!snapshot || snapshot.digest !== mark.digest || snapshot.entities.length !== mark.entities) return null;
    return exclusionMatcherOf(snapshot);
  } catch {
    return null;
  }
}
