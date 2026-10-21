# Review budget raised (owner decision of 22 Oct 2026)

**Rule.** A job's automatic review budget is enough to review every row the job can collect, with a hard ceiling per job and the one-full-call floor kept. Review cost above the job's revenue is accepted until the platform is established. Nothing else changes: prices, caps and the charge formula (`ceil(delivered x unit price)`) are untouched; fail-closed, partial-verdict salvage, retry-missing-only, verdict-only replies and "unreviewed rows are held and not charged" are untouched.

| | before (da8a825) | after |
|---|---|---|
| budget | 20% of the job's expected revenue, never below 0.0083 USD | `min(0.15, max(0.0083, collectable rows x 0.0083 / 25))` |
| 300 X posts | 0.01309 USD (about 39 rows) | 0.15 USD (about 451 rows) |
| where it is set | `REVIEW_BUDGET_SHARE` | `REVIEW_JOB_CEILING_USD = 0.15` in `src/lib/server/rowReviewAdvisor.ts`, one place |

- Collectable rows = pages the job's page cap allows (`maxPagesForJob`, 3 x the pages needed, 4 for jobs of 10 records or fewer) x 20 rows a page.
- A job with no valid price has no review budget (0), as before.
- A job whose collectable rows cost more than 0.15 USD to review (every job from about 150 posts up) is reviewed up to the ceiling; rows after it are not delivered and not charged (the «غير مراجَع» sheet), and paging stops.

## Text sent per row

Posts, comments and videos are cut to **160 characters** (was 220). A cut must never lose what the verdict rests on, so when the first 160 characters hold no word of the request (its topic words, and the country in «الدولة المطلوبة») and a later part does, the cut keeps the first 90 characters and a window of 66 characters on the first such word. The tests prove it at every position of the request word in the text (including a word the cut would otherwise split). Companies and people keep 220. Short fake texts in the simulation are not shortened by the cut, so the simulation does not credit any saving from it; real posts are longer. The saving is not measured here: it needs a live call, which this task does not make.

## Review spend per job and per day

- Per job: the internal `review_cost` job_events row already records the calls and USD of each chunk and of the job so far (hidden from the customer). Unchanged.
- Per day: `GET /api/admin/review-spend?days=7` (admin only, read-only, one select on `llm_usage` rows whose reason starts with `relevance_review`) returns, per Cairo day, review calls, failed calls and USD, the total, and the per-job ceiling. Pure summariser: `src/lib/server/reviewSpendDaily.ts`.

## Simulation (fake data, real functions, no live call)

`npx tsx scripts/review-budget-up-effect.ts`: the same fake rows run twice, with the old and the new budget. The fake reviewer never errs; a call is priced by tokens at the real prices (0.80 USD / M in, 4 USD / M out), a model and not a measurement. Revenue is `ceil(delivered x unit price)` points at 0.10 EGP a point and 55 EGP a dollar. The daily columns are `review USD per job x 100` and `x 500` jobs of that kind.

| case | budget rule | budget USD | review calls | review USD | pages | rows seen | delivered of 300 | off-topic delivered | delivered with no verdict | «غير مراجَع» sheet | revenue USD | review USD / revenue | projected review USD per day: 100 jobs | 500 jobs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| X 300 posts, narrow topic (25% of rows on topic) | old (20% of revenue) | 0.01309 | 4 | 0.01054 | 5 | 100 | 17 | 0 | 0 | 16 | 0.00364 | 2.90x | 1.05 | 5.27 |
| X 300 posts, narrow topic (25% of rows on topic) | new (every row, ceiling) | 0.15000 | 45 | 0.12238 | 45 | 900 | 238 | 0 | 0 | 0 | 0.05091 | 2.40x | 12.24 | 61.19 |
| X 300 posts, broad topic (80% of rows on topic) | old (20% of revenue) | 0.01309 | 2 | 0.00691 | 3 | 60 | 31 | 0 | 0 | 19 | 0.00727 | 0.95x | 0.69 | 3.45 |
| X 300 posts, broad topic (80% of rows on topic) | new (every row, ceiling) | 0.15000 | 20 | 0.07056 | 20 | 400 | 300 | 0 | 0 | 0 | 0.06545 | 1.08x | 7.06 | 35.28 |
| Comments 300 (videos judged, 10 comments per adopted video) | old (20% of revenue) | 0.03018 | 3 | 0.01346 | 3 | 380 | 300 | 0 | 0 | 0 | 0.15091 | 0.09x | 1.35 | 6.73 |
| Comments 300 (videos judged, 10 comments per adopted video) | new (every row, ceiling) | 0.15000 | 3 | 0.01346 | 3 | 380 | 300 | 0 | 0 | 0 | 0.15091 | 0.09x | 1.35 | 6.73 |

ceiling per job: 0.15 USD; so 100 jobs a day can cost at most 15.00 USD and 500 jobs 75.00 USD, whatever the topic.

Reading it:
- **X broad:** 300 of 300 delivered, review about 0.07 USD, about the job's revenue (1.08x).
- **X narrow:** 238 of 300 delivered, review about 0.12 USD, 2.4x the job's revenue. The budget was NOT the limit (0.122 of 0.15 USD used): the job reached its page cap (45 pages, 900 rows seen) and a topic where about a quarter of the rows are on topic cannot give 300 inside it. Before: 17 of 300 (the budget ran out after 100 rows).
- **Comments:** unchanged, 300 of 300 (the video list is judged in one call per page, about 0.013 USD).
- **Daily cost:** the ceiling bounds it: at most 15 USD a day for 100 jobs and 75 USD a day for 500, whatever the topics. At the simulated mixes, 100 jobs cost 7 to 12 USD a day (X) and 500 jobs 35 to 61 USD a day, against revenue per job of 0.05 to 0.07 USD (X) and 0.15 USD (comments).
- This is the cost the owner accepted: review above revenue on narrow X topics. It is capped per job by the constant and read daily by the route above.

Older script, same rule, 50-row pages (`npx tsx scripts/review-budget-effect.ts`):

```
review call: 0.0083 USD per 25 rows (0.000332 per row); a page is 50 rows, reviewed in full

X posts (0.11715), target 30: expected charge 4 points, review budget 0.03984 USD = 4 full 25-row calls = about 120 rows reviewable
  every row reviewed and confirmed: delivered 30 of 30, charge 4 of 4 points, review spent 0.01660 of 0.03984 USD, 2 calls, 0 rows to the «غير مراجَع» sheet

X posts (0.11715), target 300: expected charge 36 points, review budget 0.15 USD = 18 full 25-row calls = about 451 rows reviewable
  every row reviewed and confirmed: delivered 300 of 300, charge 36 of 36 points, review spent 0.09960 of 0.15 USD, 12 calls, 0 rows to the «غير مراجَع» sheet

X posts (0.11715), target 1000: expected charge 118 points, review budget 0.15 USD = 18 full 25-row calls = about 451 rows reviewable
  every row reviewed and confirmed: delivered 450 of 1000, charge 53 of 118 points, review spent 0.14940 of 0.15 USD, 18 calls, 50 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 30: expected charge 9 points, review budget 0.03984 USD = 4 full 25-row calls = about 120 rows reviewable
  every row reviewed and confirmed: delivered 30 of 30, charge 9 of 9 points, review spent 0.01660 of 0.03984 USD, 2 calls, 0 rows to the «غير مراجَع» sheet

TikTok/YouTube comments (0.275), target 300: expected charge 83 points, review budget 0.15 USD = 18 full 25-row calls = about 451 rows reviewable
  every row reviewed and confirmed: delivered 300 of 300, charge 83 of 83 points, review spent 0.09960 of 0.15 USD, 12 calls, 0 rows to the «غير مراجَع» sheet

TikTok/YouTube comments (0.275), target 1000: expected charge 275 points, review budget 0.15 USD = 18 full 25-row calls = about 451 rows reviewable
  every row reviewed and confirmed: delivered 450 of 1000, charge 124 of 275 points, review spent 0.14940 of 0.15 USD, 18 calls, 50 rows to the «غير مراجَع» sheet, paging stopped by the budget

companies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is 0.02656 USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).
```

## Daily review guard (owner condition on PR #195)

`REVIEW_DAILY_CEILING_USD = 12` (one place, `src/lib/server/rowReviewAdvisor.ts`). Today's review spend is the sum of `cost_usd` of the `llm_usage` rows of the UTC day whose reason starts with `relevance_review` (failed calls included), read by `src/lib/server/reviewDailyGuard.ts`:

- **Cheap:** one read per instance every 45 seconds (concurrent decisions share one read), plus this instance's own spend since the read (`noteReviewSpend`, called each chunk), so it never under-counts itself. A new UTC day reads at once. A failed read is kept for the same 45 seconds (no hammering). The read is paged (1,000 rows a page, at most 30); a read that does not reach the last row counts as failed, never as a partial sum.
- **At or above 12 USD:** a job that has not started reviewing takes the previous rule (20% of the expected revenue, floor 0.0083), but never more than its per-job budget (the previous rule would give 4,000 X posts 0.170545 USD, above 0.15). One internal `review_fallback` job_events row is written (reason, today's spend, the ceiling, the job's cap), hidden from the customer.
- **Read failed:** the previous rule too, never the 0.15 ceiling (row reason `read_failed`).
- **A job keeps its rule:** a job already reviewing under the per-job budget keeps it (it is not cut mid-way); a job that took the previous rule keeps it for all its chunks (flag `reviewFallback` in its running record), so it writes one row and makes no further read.
- **Nothing else changes:** prices, caps, the charge formula, delivery rules, SQL.

### The chat cannot be blocked by the review path
- The chat route, the chat handler and the chat's spend-cap code do not import or call the guard or the review code (a test reads their source).
- With the guard at the ceiling, with its read failing, the chat answers exactly as without (tests on `/api/chat`).
- One fact to know: the chat's own daily model-spend cap (`checkGlobalDailySpendCap`, 50 USD in settings today) sums ALL of today's `llm_usage` rows, review rows included. The guard keeps review spend near 12 USD a day (plus the small previous-rule jobs after it), which leaves about 38 USD of that cap for chat. If the chat cap were ever set below the review ceiling, review spend alone could use it up; the cap, its rule and its setting are untouched here.
