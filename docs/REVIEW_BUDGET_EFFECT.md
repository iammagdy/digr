# Review budget effect on delivery (fake data, no live calls)

Rule in force (owner-approved): review spend per job is capped at 20% of the job's expected charge, and never less than one full 25-row call (0.0047 USD); charge stays ceil(delivered x unit price).
Produced by `npx tsx scripts/review-budget-effect.ts` (real `socialReviewCapUsd` and `reviewSocialPage`, a fake reviewer at the measured 0.0047 USD per 25 rows).

**Updated for the review cost cut (branch claude/review-cost-cut):** every row of a page is now reviewed (one call per page), so no row is delivered without a verdict. A row the budget did not reach is NOT delivered and NOT charged: it goes to the «غير مراجَع» sheet and paging stops. The earlier version of this document (a sample per page, presumed rows delivered unreviewed once the budget was used up) is superseded; see docs/REVIEW_COST_CUT.md.

```
review call: 0.0047 USD per 25 rows (0.000188 per row); a page is 50 rows, reviewed in full

X posts (0.11715), target 30: expected charge 4 points, review budget 0.0047 USD = 1 full 25-row calls = about 25 rows reviewable
  every row reviewed and confirmed: delivered 25 of 30, charge 3 of 4 points, review spent 0.00470 of 0.0047 USD, 1 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

X posts (0.11715), target 300: expected charge 36 points, review budget 0.01309 USD = 2 full 25-row calls = about 69 rows reviewable
  every row reviewed and confirmed: delivered 50 of 300, charge 6 of 36 points, review spent 0.00940 of 0.01309 USD, 2 calls, 50 rows to the «غير مراجَع» sheet, paging stopped by the budget

X posts (0.11715), target 1000: expected charge 118 points, review budget 0.042909 USD = 9 full 25-row calls = about 228 rows reviewable
  every row reviewed and confirmed: delivered 225 of 1000, charge 27 of 118 points, review spent 0.04230 of 0.042909 USD, 9 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 30: expected charge 9 points, review budget 0.0047 USD = 1 full 25-row calls = about 25 rows reviewable
  every row reviewed and confirmed: delivered 25 of 30, charge 7 of 9 points, review spent 0.00470 of 0.0047 USD, 1 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 300: expected charge 83 points, review budget 0.030181 USD = 6 full 25-row calls = about 160 rows reviewable
  every row reviewed and confirmed: delivered 150 of 300, charge 42 of 83 points, review spent 0.02820 of 0.030181 USD, 6 calls, 50 rows to the «غير مراجَع» sheet, paging stopped by the budget

TikTok/YouTube comments (0.275), target 1000: expected charge 275 points, review budget 0.1 USD = 21 full 25-row calls = about 531 rows reviewable
  every row reviewed and confirmed: delivered 525 of 1000, charge 145 of 275 points, review spent 0.09870 of 0.1 USD, 21 calls, 25 rows to the «غير مراجَع» sheet, paging stopped by the budget

companies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is 0.005818 USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).
```
