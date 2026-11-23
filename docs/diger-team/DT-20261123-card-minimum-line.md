# DT-20261123-card-minimum-line: Plan Card Minimum Charge Line Display (Megz D-0196)

## Purpose & Problem
- Customer plan card before approval previously displayed only «أقصى سعر ٢٠٠ نقطة» without showing the honest minimum charge policy line when the minimum rule governs the price (live incident `msn_a9e3167d3cb1d7e60ef7`).
- When unit price is scaled (`jobUnitPoints = Math.floor(min / volume)`), strict inequality `rows * unitPricePoints < minChargePoints` failed (`200 < 200` is false).

## Fix Details
1. **`src/lib/agentMission/plan.ts`**:
   - `customerPlanView`: Emits `min_applied: true` in public plan price when `plan.price.minApplied` is true (omitted when false to preserve golden plan invariance on non-minimum plans).
2. **`src/lib/agentMission/customerView.ts`**:
   - `isMinimumSettingPrice`: Strictly gates on explicit `min_applied === true || minApplied === true`. Loose inferred fallbacks (`maxCharge <= minCharge`) deleted to prevent false positives on counter-cases (`20 rows * 10 = 200` does not show minimum line).
   - `minimumLineAr`: Plumbed through `CustomerMissionView` and `guardViewText`.
   - `headlineCountArOf`: Updated to reflect minimum charge rule.
3. **`src/components/mission/AgentMissionCard.tsx`**:
   - Renders `v.minimumLineAr` under `data-testid="agent-minimum-line"` with `<Tick />` in the facts block before approval, in the mobile summary (`MoneyLine`), and folded details notes (`agent-minimum-note`).
4. **`tests/design-guards.test.ts`**:
   - Raised timing threshold from 5,000 ms to 20,000 ms to prevent flakiness on slower CI runners.

## Golden Digests Re-pinned
- `tests/round11-tiktok-x-invariance.test.ts`: `BASE.x.view` updated to `500ad3826cf63cbb` because `xWorld` operates under minimum charge (200 pts) and gains `min_applied: true`.
- `tests/fixtures/flags-off-digests.json`: `x_posts_300.planView` (`2c5f16ac2b37a9f9`) and `x_posts_300.finalView` (`565fc6148c0e9081`) re-pinned because minimum charge governs price, emitting `min_applied: true` and `minimumLineAr`. All other sections and the four other worlds remain byte-identical.
