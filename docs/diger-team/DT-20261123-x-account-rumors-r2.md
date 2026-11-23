# LLM Planner Quality Fixes & Topic Relevance Gate (DT-20261123-x-account-rumors r2)

Task: DT-20261123-x-account-rumors r2 (Non-money, LLM planning / execution quality).
Branch: `team/DT-20261123-x-account-rumors-r2` from `origin/main` (`99f8da7e`).
Steps: `/srv/diger-team/architect2/work/x-rumors-r2-steps.md` & `/srv/diger-team/architect2/work/x-rumors-r2-plan.md` by نفادي.
Gate 1 Review: GREEN by أشرف (`/srv/diger-team/bughunter2/work/x-rumors-r2-G1.md`).
Order: الكبير (msg `a2d25452-a95c-43af-b70d-89a32466616c`).

## Live r1 Root Cause (Mission `msn_d388e99e9d4238678b16`)

Following the initial PR #643 merge on `main`, the live re-test succeeded mechanically (0 redundant account questions asked, 39s card response, billing matched delivered items), but content quality failed:
1. **Unreviewed Raw Timeline Delivery:** The customer received 20/20 rows from `@SaudiMOH`, but 0/20 were on-topic (all were general ministry announcements/news). Because `assemblePlan` never attached a `relevance` key to the stage (`relevance: undefined`), `executionResearchSpec` returned `null`, skipping model review and delivering unjudged rows.
2. **Missing Search Sub-Provider Alternatives:** When the primary AnyAPI search failed with 502/429, the plan failed over directly to AnyAPI user timeline rather than secondary high-reliability search endpoints (e.g., TikHub search).
3. **Single-Page Timeline Paging:** Paging stopped after 1 page (20 rows) because fallback `cursor` was not resolved from endpoint pagination when the model left `cursor_input` empty.
4. **Card Period Display Mismatch:** The card displayed a single-day window (`٢٣ نوفمبر – ٢٣ نوفمبر ٢٠٢٦`) because the understanding model defaulted to today's date when no timeframe was specified, even though the query searched a 2-year window (`since:2024-11-23 until:2026-11-23`).

## What Changes for the Customer in r2

1. **Relevance & Reviewer Gate (Zero Off-Topic Deliveries):**
   - For any request carrying a topic, `assemblePlan` attaches `relevance: researchRelevanceOf(askTopic, textCols, u.understanding_ar)` with `judge: "model"`.
   - Every raw timeline row is judged by `reviewer.review(...)`. Off-topic rows receive `review_no` and are discarded before customer delivery.
   - The customer is charged strictly for on-topic rows delivered, never for irrelevant timeline noise. Requests without a topic bypass review with zero overhead.

2. **Judged Sample Card Sizing:**
   - Probe sample rows are judged by the model. If 0 items match the customer's topic, the planner records `found: 0, exhausted: true` and presents dynamic widening choices via `scoutQuestion`, rather than promising 20 rows on the card.
   - In accordance with COMMANDER's mandatory amendment, `takesTopic` was eliminated; whenever `step.topic && sampleRows.length > 0`, probe sample rows are always judged by the model.

3. **Multi-Provider Search Alternatives:**
   - Loops over candidate endpoints across distinct providers, constructing alternatives that span primary search query variations, secondary search sub-providers (TikHub search), timeline fallback (`anyapi.x.user.posts`), and web search fallbacks.

4. **Multi-page Timeline Paging:**
   - Automatically resolves fallback `cursor` from `endpoint.pagination` when `cursor_input` is not specified by the model, allowing multi-page timeline traversal across the full time window.

5. **Card Period Synchronization:**
   - `syncStepPeriodFromStep` extracts the actual `since:` / `until:` date window from search queries and synchronizes `step.period`, ensuring the card accurately displays the true multi-year date range.

6. **GraphQL & Legacy Shape Extraction:**
   - `fallbackMap` extracts `rest_id` and legacy fields (`legacy.full_text`, `legacy.name`, `legacy.screen_name`, `legacy.created_at`) from modern GraphQL tweet responses.

## Verification

Core Vitest suites, TypeScript typecheck, and agent typecheck:
- `tests/x-account-rumors-replay.test.ts`
- `tests/llm-first-planner.test.ts`
- `tests/llm-catalog-generality.test.ts`
- `tests/p0-x-account-contract.test.ts`
- `tests/flags-off-byte-identical.test.ts`
- `npm run agent:typecheck`
- `npx tsc -p tsconfig.json --noEmit`
