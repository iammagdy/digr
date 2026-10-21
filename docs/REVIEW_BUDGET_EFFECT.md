# Review budget effect on delivery (fake data, no live calls)

Rule in force (owner-approved): review spend per job is capped at 20% of the job's expected charge, and never less than one full 25-row call (0.0047 USD); charge stays ceil(delivered x unit price).
Produced by `npx tsx scripts/review-budget-effect.ts` (real `socialReviewCapUsd`, `reviewSocialPage`, a fake reviewer at the measured 0.0047 USD per 25 rows). The flagged share of real rows is NOT measured anywhere; the 25% and 10% rows are assumptions.

```
review call: 0.0047 USD per 25 rows (0.000188 per row); a page is 50 rows; the per-page sample is 15 rows

X posts (0.11715), target 30: expected charge 4 points, 20% of it is 0.001454 USD, review budget 0.0047 USD (the floor of one full call) = 1 full 25-row calls = about 25 rows reviewable
  worst: every row needs review: delivered 25 of 30, charge 3 of 4 points, review spent 0.00470 of 0.0047 USD, 1 calls, 25 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 30 of 30, charge 4 of 4 points, review spent 0.00470 of 0.0047 USD, 1 calls, 0 rows to the review sheet
  realistic B: 10% doubtful: delivered 30 of 30, charge 4 of 4 points, review spent 0.00376 of 0.0047 USD, 1 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 30 of 30, charge 4 of 4 points, review spent 0.00282 of 0.0047 USD, 1 calls, 0 rows to the review sheet

X posts (0.11715), target 300: expected charge 36 points, 20% of it is 0.01309 USD, review budget 0.01309 USD = 2 full 25-row calls = about 69 rows reviewable
  worst: every row needs review: delivered 50 of 300, charge 6 of 36 points, review spent 0.00940 of 0.01309 USD, 2 calls, 50 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 300 of 300, charge 36 of 36 points, review spent 0.01278 of 0.01309 USD, 8 calls, 78 rows to the review sheet
  realistic B: 10% doubtful: delivered 300 of 300, charge 36 of 36 points, review spent 0.01128 of 0.01309 USD, 3 calls, 20 rows to the review sheet
  no row doubtful (sample only): delivered 300 of 300, charge 36 of 36 points, review spent 0.01128 of 0.01309 USD, 4 calls, 0 rows to the review sheet

X posts (0.11715), target 1000: expected charge 118 points, 20% of it is 0.042909 USD, review budget 0.042909 USD = 9 full 25-row calls = about 228 rows reviewable
  worst: every row needs review: delivered 225 of 1000, charge 27 of 118 points, review spent 0.04230 of 0.042909 USD, 9 calls, 25 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 1000 of 1000, charge 118 of 118 points, review spent 0.04268 of 0.042909 USD, 17 calls, 221 rows to the review sheet
  realistic B: 10% doubtful: delivered 1000 of 1000, charge 118 of 118 points, review spent 0.04136 of 0.042909 USD, 11 calls, 50 rows to the review sheet
  no row doubtful (sample only): delivered 1000 of 1000, charge 118 of 118 points, review spent 0.04230 of 0.042909 USD, 15 calls, 0 rows to the review sheet

TikTok/YouTube comments (0.275), target 30: expected charge 9 points, 20% of it is 0.003272 USD, review budget 0.0047 USD (the floor of one full call) = 1 full 25-row calls = about 25 rows reviewable
  worst: every row needs review: delivered 25 of 30, charge 7 of 9 points, review spent 0.00470 of 0.0047 USD, 1 calls, 25 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 30 of 30, charge 9 of 9 points, review spent 0.00470 of 0.0047 USD, 1 calls, 0 rows to the review sheet
  realistic B: 10% doubtful: delivered 30 of 30, charge 9 of 9 points, review spent 0.00376 of 0.0047 USD, 1 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 30 of 30, charge 9 of 9 points, review spent 0.00282 of 0.0047 USD, 1 calls, 0 rows to the review sheet

TikTok/YouTube comments (0.275), target 300: expected charge 83 points, 20% of it is 0.030181 USD, review budget 0.030181 USD = 6 full 25-row calls = about 160 rows reviewable
  worst: every row needs review: delivered 150 of 300, charge 42 of 83 points, review spent 0.02820 of 0.030181 USD, 6 calls, 50 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 300 of 300, charge 83 of 83 points, review spent 0.02745 of 0.030181 USD, 12 calls, 26 rows to the review sheet
  realistic B: 10% doubtful: delivered 300 of 300, charge 83 of 83 points, review spent 0.02256 of 0.030181 USD, 6 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 300 of 300, charge 83 of 83 points, review spent 0.01692 of 0.030181 USD, 6 calls, 0 rows to the review sheet

TikTok/YouTube comments (0.275), target 1000: expected charge 275 points, 20% of it is 0.1 USD, review budget 0.1 USD = 21 full 25-row calls = about 531 rows reviewable
  worst: every row needs review: delivered 525 of 1000, charge 145 of 275 points, review spent 0.09870 of 0.1 USD, 21 calls, 25 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 1000 of 1000, charge 275 of 275 points, review spent 0.09945 of 0.1 USD, 37 calls, 26 rows to the review sheet
  realistic B: 10% doubtful: delivered 1000 of 1000, charge 275 of 275 points, review spent 0.07520 of 0.1 USD, 20 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 1000 of 1000, charge 275 of 275 points, review spent 0.05640 of 0.1 USD, 20 calls, 0 rows to the review sheet

companies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is 0.005818 USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).
```
