# DT-20261124-hold-exceeds-card-max: Fix Hold (`reservePoints`) Exceeding Card `maxChargePoints`

- **Task ID:** `DT-20261124-hold-exceeds-card-max`
- **Implementer:** جوني (`ARCHITECT`, Tier A money piece)
- **Reviewer (Gate 1 GREEN):** فزاع (`BUG HUNTER`)
- **Base Commit:** `origin/main` (`e105cc9a`)
- **Branch:** `team/DT-20261124-hold-exceeds-card-max`
- **Scope:** 3 files only (`src/lib/agentMission/price.ts`, `tests/dt-20261124-hold-exceeds-card-max.test.ts`, `docs/diger-team/DT-20261124-hold-exceeds-card-max.md`); `agent/src/llmPlanner/planner.ts` and `agent/src/engine/run.ts` remain untouched.

---

## 1. Root Cause Analysis

On single-stage listed services (`youtube.search.videos`, `5` pts/video in `data/capabilities/provider-metadata.json:21350-21357`), QA Case 2 («عايز ٥ فيديوهات من يوتيوب عن نصائح التغذية الصحية لمرضى السكري») showed **أقصى سعر: ٢٠٠ نقطة** (`maxChargePoints = 200`) alongside **تُحجز ٤٣٤ نقطة عند الاعتماد** (`reservePoints = 434`), blocking balances `200–433`.

1. **Planner & Engine Routing Contract:** `agent/src/llmPlanner/planner.ts` (`checkedFundingSteps` / `sealedFunding`) attaches `execution_funding` to single-stage listed plans, and `agent/src/engine/run.ts:103,109` requires `stageFunding = executionFundingSchedule(...)` whenever `plan.price.listedRate` is present (otherwise aborting with `need_new_plan`).
2. **Unscoped Hold Inflation (`src/lib/agentMission/price.ts:246-247`):** `priceMissionByCode` previously fed **all** `listedRate` stages — including single-stage `parentKey === null` searches — into `fundingReservePoints(stages, capPoints)`, raising `reservePoints` to `434` (`ceil(0.315 * 1375)`) above `rule.chargeAtFullPoints` (`200`), and setting `executionFundingApplied: true`. Above the 200-pt minimum (e.g., `60` YouTube videos = `300` pts), `rule.reservePoints` (`src/lib/missionPricing.ts:137`) also added `+15%` (`345` > `300`).
3. **Settlement Ceiling Defense:** `settlementCharge` (`src/lib/agentMission/price.ts:136-139`) capped by `reservedPoints` and `capPoints` without an explicit `maxChargePoints` ceiling guard.

---

## 2. Changes Made

1. **`src/lib/agentMission/price.ts`:**
   - Scoped `fundingReservePoints` in `priceMissionByCode` via `needsChildFunding = Boolean(listedRate && stages.some((s) => s.parentKey !== null && Boolean(s.executionFunding?.length)))`.
   - For single-stage listed plans (`listedRate && !needsChildFunding`), set `baseReserve = rule.chargeAtFullPoints` so `reservePoints === maxChargePoints` (`200/200` for 5 videos with `minApplied: true`; `300/300` for 60 videos without `+15%` drift), omitting `executionFundingApplied` and keeping `execution_funding` intact for `runEngine`.
   - Preserved multi-stage parent+child funding math bit-for-bit (`needsChildFunding = true`, e.g., `dt-20261120-social` `752/758/323/297`) and non-listed pricing (`!listedRate`, e.g., Companies/News `200/200`, `x-account-rumors-replay` `r9 A3`).
   - Added optional `maxChargePoints` bound in `settlementCharge` (`ceiling = Math.min(reserved, maxChargePoints)`).
2. **`tests/dt-20261124-hold-exceeds-card-max.test.ts`:**
   - Added tests covering YouTube 5 videos (`200/200/200`, `minApplied`, `executionBudgetUsd(200) = $0.145455` covering 9 worst-case `$0.015` calls), 60 videos (`300/300`, `executionBudgetUsd(300) = $0.218182` covering 14 calls), end-to-end `replay` on a `200`-pt wallet (`runEngine` executes without `need_new_plan`, `#664` minimum line intact, settles `200`), Companies & News (`200/200`), and `settlementCharge <= maxChargePoints`.

---

## 3. Rollback

Revert the PR commit (`git revert <merge-sha>`); `src/lib/agentMission/price.ts` has no schema or migration side effects.
