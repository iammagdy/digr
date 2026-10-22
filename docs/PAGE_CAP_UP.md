# Collection page cap raised: 6 times the pages the target needs (was 3)

**Evidence.** The X job of 22 Oct 2026 07:33 UTC (300 posts about high prices, 118 delivered, charge 14) stopped at page 18, by the page cap: 300 posts at 50 rows a chunk need 6 pages, times 3 is 18. Not the review budget (0.067 of 0.15 USD spent), not a dry source, not the low-yield rule (33% of the rows seen were accepted). The same job with a cap of 36 pages would have seen about 720 rows.

## What changed
- `LARGE_JOB_PAGE_ALLOWANCE = 6`, defined once in `src/lib/scaleConfig.ts` (it is the default of the `largeJobPageAllowance` setting and is re-exported by `providerCallCaps`). It was defined twice, both 3.
- `maxPagesForJob` = `min(absoluteMaxPages, pagesNeeded x allowance)`. The absolute ceiling (`LONG_JOB_MAX_PAGES`, 300) and small jobs (10 records or fewer: 4 feed pages, 3 directory pages) are unchanged.
- Cap by target (X posts, 50 rows a chunk): 30 -> 6 pages (was 3), 300 -> 36 (18), 1,000 -> 120 (60), 4,000 -> 300 (ceiling; 240 before). A full 600-point X job (4,453 posts) is held at 300 (270 before); 1,897 comments 228 (114).
- **The review budget does not move.** `collectableRows` (which sizes the budget, `rowReviewAdvisor.ts`) took its page count from the same cap, so it would have doubled for jobs of 30 to 149 posts. It is pinned to the allowance it was set with (`REVIEW_BUDGET_PAGE_ALLOWANCE = 3`), so every job size has exactly the review budget it had (0.03984 USD for 30, 0.0996 for 100, the 0.15 ceiling from about 150 posts).

## Stop rules, all unchanged
Low-yield stop, three consecutive empty pages (two for small jobs), review budget, the daily review guard, the per-job and daily provider spend gates, the plan's reserve, the deadline of each chunk. A larger cap only lets a job that is still finding rows keep going; a job that stops finding rows still stops after three empty pages.

## Money
- **Provider gate.** Spend is reserved one chunk at a time, before each provider call (`reserve_provider_spend_atomic`, with the daily cap, plus the per-job and per-user ceilings when set). For X the reserve is 0.006 USD a chunk (dearest call 0.001 x 6 calls). A larger cap does not widen any single check: when a gate refuses, the job keeps what it collected and settles it.
- **Worst case of an X job of 300 posts** (provider, USD): 36 chunks now, 18 before. At the measured 0.0006 USD a call and one call a chunk (what the 22 Oct jobs did): **0.0216** (was 0.0108). If every chunk made 6 calls: 0.1296 (was 0.0648). The gate's own reserve bound, 36 x 0.006: 0.216 (was 0.108).
- **Plan reserve and charge.** The plan capacity estimate is volume times the cost of one delivered record (`estimatedProviderUsd`), not pages, so it does not change. The reserve is held at plan time (41 points for 300 posts at 0.11715) and the charge is `ceil(delivered x unit price)`; delivered can never pass the target, so the charge is at most 36 points, never above the reserve. Nothing about the charge formula, the prices, the caps or the review budget changes.
- **Review cost with more pages (recorded prices):** at about 0.0037 USD a review call, 36 pages cost about 0.134 USD, under the 0.15 ceiling (about 0.017 USD at the possible real prices).

## Estimate (not measured)
A narrow topic like the 22 Oct job (about 33% of rows accepted) could reach about 240 delivered of 300 with 36 pages instead of 118, at about twice the provider and review cost of that job (recorded: about 0.134 + 0.022 USD against a revenue of about 29 points = 0.053 USD).

## One thing to check
`LONG_JOB_PAGE_ALLOWANCE` and `LONG_JOB_MAX_PAGES` are settings that override these defaults. If the first is set on Vercel (for example to 3), it still wins and this change has no effect until it is removed or raised. I did not read the environment variables of the project. The 22 Oct job stopping at exactly 18 only says the value in force was 3.
