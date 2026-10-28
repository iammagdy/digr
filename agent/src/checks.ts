import type { RelevanceReason, RuleBasis } from "../../src/lib/agentMission/relevance";
import type { AgentStore } from "./types";

/**
 * THE REPORT OF THE CHECK OF ITEMS, per stage: how many items were looked at, how many were accepted by RULE (and on what basis), how many by the MODEL review, how many were left out per reason, and how many are still PENDING
 * (waiting for a review that the budget or a failure delayed: they are not delivered, not charged, and asked again). Stored on the mission, read by the admin page; the customer sees only the counts in plain words.
 */
export const CHECKS_FILE = "checks.json";

export interface StageChecks {
  /** Items looked at for the first time. */
  examined: number;
  accepted_by_rule: number;
  accepted_by_rule_basis: Partial<Record<RuleBasis, number>>;
  accepted_by_model: number;
  excluded: Partial<Record<RelevanceReason, number>>;
}
export type MissionChecks = Record<string, StageChecks>;

export const emptyStageChecks = (): StageChecks => ({ examined: 0, accepted_by_rule: 0, accepted_by_rule_basis: {}, accepted_by_model: 0, excluded: {} });

export async function readChecks(store: AgentStore, missionId: string): Promise<MissionChecks> {
  try {
    const raw = await store.getFile(missionId, CHECKS_FILE);
    const o = raw ? (JSON.parse(raw) as unknown) : null;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as MissionChecks) : {};
  } catch {
    return {};
  }
}

export const writeChecks = (store: AgentStore, missionId: string, checks: MissionChecks): Promise<void> => store.putFile(missionId, CHECKS_FILE, JSON.stringify(checks), "application/json");

export const excludedTotal = (c: StageChecks): number => Object.values(c.excluded).reduce<number>((n, v) => n + (v ?? 0), 0);

/** Items still waiting for a review: the reasons that mean «not yet decided» (never a final exclusion). */
export const PENDING_REASONS: ReadonlyArray<RelevanceReason> = ["not_reviewed", "review_failed"];
