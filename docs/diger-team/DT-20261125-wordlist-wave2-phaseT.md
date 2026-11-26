# Phase T: Delivery Filter Notices & Tool Guards Wave 2 (D-0213 & D-0214)

- **PR:** Draft PR on `team/DT-20261125-wordlist-wave2-phaseT`

## Overview
Phase T v2 implements customer delivery filter notices (D-0214), removes unfiltered admission finish refusals (D-0213), and completes Phase T tool guard cleanups:
1. **D-0213 («زي جوجل بس في الداتا»):** Removed `UNFILTERED_ADMISSION` declaration and finish tool checks from `agent/src/tools.ts`. The agent never refuses delivery at `finish` based on summary wording (such as «بدون فلترة» or «لم تُصفَّ»).
2. **D-0214 (Delivery Filter Notices):**
   - Promised filters continue applying at save time; rows with unconfirmed criteria are accepted and counted without blocking delivery or charging discounts.
   - Added `isFilterConfirmedOnRow` and `unconfirmedFilterNotices` in `src/lib/agentMission/filters.ts` with accurate Arabic noun agreement (`itemNounOf` and `countAr`).
   - Surfaces unconfirmed filter notes across 3 customer-facing surfaces:
     - `src/lib/agentMission/customerView.ts`: Card `resultLinesAr` displays unconfirmed note after delivered count and price lines.
     - `src/lib/agentMission/notices.ts`: Notice body and `email.detail2` display unconfirmed filter notes.
     - `agent/src/methodology.ts`: Workbook limits sheet (`حدود هذا التسليم` in `ملخص المهمة`) records unconfirmed filter notes.
   - Wired `unconfirmedFilterNotices` in `agent/src/runMission.ts` into `prepareExecutionDelivery` and `settleExecution`.
3. **Q3 (Parent Fallback Exclusion):**
   - Added `assumption_kinds: string[]` to `propose_plan` in `agent/src/tools.ts`.
   - Wired `excludedParentAssumptions` in `finalizeAcceptedPlan` to tag and filter fallback exclusions while preserving other tagged assumptions.
4. **Q4 (Metadata-Driven Tool Descriptions):**
   - Added `platformHintFromCatalog` to build catalog search platform hints dynamically from `TregCatalog`.
   - Made `dearerWebProviderMessage`, `webAvailableOf`, and `webTools` dynamic using `WEB_SOURCES`, `WEB_PROVIDERS`, and `PARSERS`.
   - Eliminated hardcoded provider literals (`firecrawl`, `x`, `youtube`) and regexes from `agent/src/tools.ts` (0 AST violations).
5. **Allow-List Sync & Monotonic Ceiling:**
   - Synced allow-list: `arabic_regex` 1398 -> 1392 (-6), `treg_tokens` 503 -> 500 (-3).
   - Lowered `ALLOW_LIST_CEILING` in `tests/design-guards-allow-monotonic.test.ts`.

## Evidence & Verifications
- **Targeted Test Suites:**
  - `tests/phaseT-tools-guards.test.ts` (10/10 passed)
  - `tests/agent-relevance-and-pricing.test.ts` (40/40 passed)
  - `tests/provider-selection-r56.test.ts` (9/9 passed)
  - `tests/mission-10-replay.test.ts` (15/15 passed)
  - `tests/mission-12-replay.test.ts` (16/16 passed)
  - `tests/design-guards.test.ts` (7/7 passed)
  - `tests/design-guards-allow-monotonic.test.ts` (2/2 passed)
