# DT-20261121-copy

## Overview
Implementation of the six mandatory Arabic copy adjustments (6 MUST fixes) on customer-facing messages from Hazaloom's review (`/srv/diger-team/designer/work/DT-20261121-copy-review.md`):

1. **MUST 1 (`STALE_MISSION_PLAN_AR`):** Updated stale mission plan warning to clear, reassuring Arabic copy.
2. **MUST 2 (`APPROVE_UNKNOWN_AR`):** Clarified unexpected approval error message.
3. **MUST 3 (`AgentMissionCard.tsx`, `lifecycle.ts`):** Removed premature "لم يُخصم شيء" promise during pending approval state (`approvalState === "pending"` and `pendingProof`); reassurance is now "ولن تُحجز نقاطك مرتين".
4. **MUST 4 (`APPROVE_MESSAGES.plan_changed`):** Updated plan-change notice during approval to clear customer explanation.
5. **MUST 5 (`APPROVE_MESSAGES.quote_expired`):** Clarified expired quote wording.
6. **MUST 6 (`finalize.ts`, `runMission.ts`):** Distinguish total-only shortfall clause (`isFillTotal` = `fill_total_across_parents: true` with `per_parent_rows === undefined`) from capped plans (which retain per-parent wording).

## Files Modified
- `agent/src/finalize.ts`
- `agent/src/runMission.ts`
- `src/components/mission/AgentMissionCard.tsx`
- `src/lib/agentMission/approval.ts`
- `src/lib/agentMission/customerActions.ts`
- `src/lib/agentMission/lifecycle.ts`
- `src/lib/missionApprove.ts`
- `tests/dt-0119-11-prices.test.ts`
- `tests/round14-approve-recovery.test.ts`
- `tests/dt-20261121-copy.test.ts` (new)
