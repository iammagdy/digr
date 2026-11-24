# One Accepted Set Count Parity, Code-Owned Option Prices & Honest Per-Route Widening (DT-20261123-x-account-rumors r9)

Task: DT-20261123-x-account-rumors r9 (Count Parity between Shortfall Question & Plan Card, Code-Owned Option Prices, and Honest Per-Route Widening on live mission `msn_f91f7e220bbf60fd7c9c` replay + CTO Amendments A1–A3).
Branch: `team/DT-20261123-x-account-rumors-r9`
Base: `origin/main` (`f727b018`)
Architect: نفادي (DIGER ARCHITECT-2) with Commander CTO Amendments A1–A3
Plan Path: `/srv/diger-team/architect2/work/DT-20261123-x-account-rumors-r9-plan.md`
Implementer: هجرس (FAWAALY)
Authority: Megz authority D-0081, D-0086, D-0197, D-0201

---

## 1. Goal & Root Causes

Live mission `msn_f91f7e220bbf60fd7c9c` failed with count parity discrepancies, inaccurate option prices, and uniform made-up widening figures:
1. **Root Cause 1 (Count Mismatch 0 vs 1):**
   - Round 1 probed primary timeline (0 matches) and alternate search (Call #6: 16 tweets, containing 1 on-topic tweet `1466135018154205187`).
   - Planning judged `secondRows` but did not unify findings before asking the shortfall question, causing Round 1 to state 0 found while Round 2 planned 1 row.
   - **Fix:** `secondRows` is judged with `judgeSampleRows` and pushed to `sampleRows` and `stepAcceptedIds` before `findings.push`, ensuring Round 1 and Round 2 share the exact same accepted set.

2. **Root Cause 2 (Hardcoded 0.0005 Fallback & Price Inaccuracy):**
   - Widening options used hardcoded `priceForRows` assuming $0.0005/row, leading to option price discrepancies versus the actual card hold and failing to reflect the 200-point minimum charge.
   - **Fix:** Implemented `priceStageForOption` using `stageCostPerRawRowUsd` + `listedQuoteOf` + `stagePriceInputs` + `priceMissionByCode` (identical to `assemblePlan`). When unpriceable/catalog missing, no guessed points number is shown (`max_price_points: null`).
   - **Amendment A1:** When `foundCount === 0`, `take_found` («سلّمني الموجود») is never offered; only widening routes are presented.
   - **Amendment A3:** Option price reflects code pricing with zero `0.0005` fallback, matching card `maxChargePoints` and minimum charges.

3. **Root Cause 3 (Identical Made-up `~20, max 200` Widening Estimates):**
   - Options previously hardcoded `DEFAULT_COUNT` (20) and 200 points uniformly across all widening routes.
   - **Fix:** Each route has an explicit `estimate_kind: "exact" | "measured" | "up_to"`, distinct row numbers (e.g. 19 for search, 5 for related accounts, 10 for web), and honest Arabic phrasing (`«يضيف نحو N»` for measured/probed vs `«يضيف حتى N»` for unprobed).

4. **Amendment A2 (Single-Use Scoped Snapshot):**
   - `PriorScoutStepSnapshot` in `PlannerState` is single-use, scoped to answering the last scout question of the mission.
   - Immediately cleared upon consumption or if the customer edits the request/sends a different topic.

---

## 2. Changed Files (<= 5 files)

1. `agent/src/llmPlanner/prompts.ts`:
   - Updated `SCOUT_SYSTEM` and structured `buildScoutSchema` / `SCOUT_SCHEMA` with `{ kind, stem_ar }` items matching dynamic `facts.widening_options` enums.
2. `agent/src/llmPlanner/planner.ts`:
   - Unified `secondRows` judging with `judgeSampleRows` before shortfall findings.
   - Added `priceStageForOption` and `buildCatalogWideningFacts` with code-stamped option pricing and honest per-route widening.
   - Added `PriorScoutStepSnapshot` restoration logic in `planWithLlm`.
   - Structured output option mapping: replaced Arabic word regexes with kind-based mapping (`stampScoutOptionsWithCodeFacts`), dropping unknown/duplicate kinds and sorting `take_found` first when present.
3. `agent/src/llmPlanner/run.ts`:
   - Persisted and cleared `scoutSnapshot` in `PlannerState` across planning turns with single-use scoped restoration.
4. `tests/x-account-rumors-replay.test.ts`:
   - Added test suite for r9 covering Must-Pass 1 (Round 1 & 2 count parity on real Call #6 replay), Must-Pass 2 (Amendment A1 `found = 0` no take_found), and Must-Pass 3 (Amendment A3 code-stamped option prices & per-route widening), plus structured output kind validation and unknown-kind dropping.
5. `docs/diger-team/DT-20261123-x-account-rumors-r9.md`:
   - This documentation file.

---

## 3. Verification

- Design guards: `npx vitest run tests/design-guards.test.ts` (7 passed, 0 violations).
- All 40 replay tests pass: `npx vitest run tests/x-account-rumors-replay.test.ts` (40 passed).
- TypeScript compilation: `npm run agent:typecheck && npx tsc --noEmit` exits with code 0.
- Dependent suites verified: `tests/retrieval-state-machine.test.ts` and `tests/dt09-leaks.test.ts` pass.
