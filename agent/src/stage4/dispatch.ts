import { runMissionSafely, type RunnerDeps } from "../runMission";
import type { MissionRecord } from "../types";
import { isAddonMission, runAddonSafely } from "./runAddon";

/**
 * MONEY PR 7a, PHASE 2B-1: THE ONE ENTRY POINT OF THE WORKER FOR A CLAIMED ROW. A row whose plan has an `addon` key is an approved paid review, review fix or edit of a delivered mission and goes to the add-on runner (runAddon.ts);
 * EVERY OTHER row goes to the mission runner exactly as it did before (`runMissionSafely`). The Stage 4 flags are not read here: they gate the creation and the approval of an add-on, and a hold that was made must always be run to its end.
 * Both runners never throw. `runners` is for the tests.
 */
export interface Runners { mission: typeof runMissionSafely; addon: typeof runAddonSafely }
export async function runClaimedSafely(deps: RunnerDeps, mission: MissionRecord, runners: Runners = { mission: runMissionSafely, addon: runAddonSafely }): Promise<void> {
  if (isAddonMission(mission)) return runners.addon(deps, mission);
  return runners.mission(deps, mission);
}
