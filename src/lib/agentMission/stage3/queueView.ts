import type { QueueInfo } from "../customerView";
import { stage3FlagMode } from "./flags";
import { queueLineAr, queueStateOf } from "./queue";

/**
 * STAGE 3 S5 (docs/STAGE-3.md): THE QUEUE LINE OF THE MISSION VIEW, behind DIGER_STAGE3_QUEUE. Off (unset): `queueLine` of customerView.ts is used, untouched. On: the position, an honest reason
 * and, only when MEASURED, the time already waited. The wait is counted from the stored APPROVAL time (`approved_at`); a request that is only `queued` has no approval yet, so it never shows a time.
 * On the SITE only the value «on» turns this on: the site cannot know a test account (the guard tests/admin-calls-log.test.ts keeps that rule out of customer code), so «test» stays off here.
 */
export const stage3QueueOn = (env?: Readonly<Record<string, string | undefined>>): boolean => stage3FlagMode("DIGER_STAGE3_QUEUE", env) === "on";

export function queueLineV2(status: string, queue: QueueInfo | null, approvedAtMs: number | null, nowMs: number): { lineAr: string | null; position: number | null } {
  const state = queueStateOf({ status, queue, queuedAtMs: status === "approved" ? approvedAtMs : null, nowMs });
  if (!state) return { lineAr: null, position: null };
  // nothing ahead and the worker alive: no line (the card then says «بدأنا جمع»), as today
  return { lineAr: state.reason === "starting_now" ? null : queueLineAr(state), position: state.position };
}
