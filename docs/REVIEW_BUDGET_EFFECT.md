# Review budget effect on delivery (fake data, no live calls)

Rule in force (owner-approved): review spend per job is capped at 20% of the job's expected charge, and never less than one full 25-row call (0.0083 USD, the measured cost: it was 0.0047 until the truncation fix); charge stays ceil(delivered x unit price).
Produced by `npx tsx scripts/review-budget-effect.ts` (real `socialReviewCapUsd` and `reviewSocialPage`, a fake reviewer at the measured 0.0083 USD per 25 rows).

**Updated for the review cost cut (branch claude/review-cost-cut):** every row of a page is now reviewed (one call per page), so no row is delivered without a verdict. A row the budget did not reach is NOT delivered and NOT charged: it goes to the «غير مراجَع» sheet and paging stops. The earlier version of this document (a sample per page, presumed rows delivered unreviewed once the budget was used up) is superseded; see docs/REVIEW_COST_CUT.md.

```
review call: 0.0083 USD per 25 rows (0.000332 per row); a page is 50 rows, reviewed in full

X posts (0.11715), target 30: expected charge 4 points, review budget 0.0083 USD = 1 full 25-row calls = about 25 rows reviewable
  every row reviewed and confirmed: delivered 25 of 30, charge 3 of 4 points, review spent 0.00830 of 0.0083 USD, 1 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

X posts (0.11715), target 300: expected charge 36 points, review budget 0.01309 USD = 1 full 25-row calls = about 39 rows reviewable
  every row reviewed and confirmed: delivered 25 of 300, charge 3 of 36 points, review spent 0.00830 of 0.01309 USD, 1 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

X posts (0.11715), target 1000: expected charge 118 points, review budget 0.042909 USD = 5 full 25-row calls = about 129 rows reviewable
  every row reviewed and confirmed: delivered 125 of 1000, charge 15 of 118 points, review spent 0.04150 of 0.042909 USD, 5 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 30: expected charge 9 points, review budget 0.0083 USD = 1 full 25-row calls = about 25 rows reviewable
  every row reviewed and confirmed: delivered 25 of 30, charge 7 of 9 points, review spent 0.00830 of 0.0083 USD, 1 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 300: expected charge 83 points, review budget 0.030181 USD = 3 full 25-row calls = about 90 rows reviewable
  every row reviewed and confirmed: delivered 75 of 300, charge 21 of 83 points, review spent 0.02490 of 0.030181 USD, 3 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 1000: expected charge 275 points, review budget 0.1 USD = 12 full 25-row calls = about 301 rows reviewable
  every row reviewed and confirmed: delivered 300 of 1000, charge 83 of 275 points, review spent 0.09960 of 0.1 USD, 12 calls, 50 rows to the «غير مراجَع» sheet, paging stopped by the budget

companies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is 0.0083 USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).
```
