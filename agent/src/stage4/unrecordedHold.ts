import type { RunnerDeps } from "../runMission";
import type { MissionRecord } from "../types";
import { ADDON_DONE_AR } from "./addonText";

/** STUB (red commit): the behaviour of the code before the fix, so the new tests fail for the right reason. Replaced by the real resolver in the next commit. */
export type HoldDeps = RunnerDeps & { now?: () => Date };
export const HOLD_WAITS_MAX = 4;
export const HOLD_WAIT_SECONDS = 30;
export const APPROVAL_LEASE_MS = 3_600_000;
export const HOLD_WAIT_MARK = "hold_wait:";
export async function resolveUnrecordedHold(deps: HoldDeps, row: MissionRecord, _opts: { afterRecord?: boolean } = {}): Promise<"verified" | "handled"> {
  await deps.store.updateMission(row.id, { status: "failed", error: "the add-on has no plan or no hold", summary_ar: ADDON_DONE_AR.planMismatch, worker_id: null, lease_until: null });
  await deps.store.addEvent(row.id, { kind: "result", message_ar: ADDON_DONE_AR.planMismatch });
  return "handled";
}
