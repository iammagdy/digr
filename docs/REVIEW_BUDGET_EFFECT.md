# Review budget effect on delivery (fake data, no live calls)

Produced by `npx tsx scripts/review-budget-effect.ts` (real `socialReviewCapUsd`, `reviewSocialPage`, a fake reviewer at the measured 0.0047 USD per 25 rows). The flagged share of real rows is NOT measured anywhere; the 25% and 10% rows are assumptions.

```
review call: 0.0047 USD per 25 rows (0.000188 per row); a page is 50 rows; the per-page sample is 15 rows

X posts (0.11715), target 30: expected charge 4 points, review budget 0.001454 USD = 0 full 25-row calls = about 7 rows reviewable
  worst: every row needs review: delivered 0 of 30, charge 0 of 4 points, review spent 0.00000 of 0.001454 USD, 0 calls, 50 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 30 of 30, charge 4 of 4 points, review spent 0.00000 of 0.001454 USD, 0 calls, 13 rows to the review sheet
  realistic B: 10% doubtful: delivered 30 of 30, charge 4 of 4 points, review spent 0.00094 of 0.001454 USD, 1 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 30 of 30, charge 4 of 4 points, review spent 0.00000 of 0.001454 USD, 0 calls, 0 rows to the review sheet

X posts (0.11715), target 300: expected charge 36 points, review budget 0.01309 USD = 2 full 25-row calls = about 69 rows reviewable
  worst: every row needs review: delivered 50 of 300, charge 6 of 36 points, review spent 0.00940 of 0.01309 USD, 2 calls, 50 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 300 of 300, charge 36 of 36 points, review spent 0.01278 of 0.01309 USD, 8 calls, 78 rows to the review sheet
  realistic B: 10% doubtful: delivered 300 of 300, charge 36 of 36 points, review spent 0.01128 of 0.01309 USD, 3 calls, 20 rows to the review sheet
  no row doubtful (sample only): delivered 300 of 300, charge 36 of 36 points, review spent 0.01128 of 0.01309 USD, 4 calls, 0 rows to the review sheet

X posts (0.11715), target 1000: expected charge 118 points, review budget 0.042909 USD = 9 full 25-row calls = about 228 rows reviewable
  worst: every row needs review: delivered 225 of 1000, charge 27 of 118 points, review spent 0.04230 of 0.042909 USD, 9 calls, 25 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 1000 of 1000, charge 118 of 118 points, review spent 0.04268 of 0.042909 USD, 17 calls, 221 rows to the review sheet
  realistic B: 10% doubtful: delivered 1000 of 1000, charge 118 of 118 points, review spent 0.04136 of 0.042909 USD, 11 calls, 50 rows to the review sheet
  no row doubtful (sample only): delivered 1000 of 1000, charge 118 of 118 points, review spent 0.04230 of 0.042909 USD, 15 calls, 0 rows to the review sheet

TikTok/YouTube comments (0.275), target 30: expected charge 9 points, review budget 0.003272 USD = 0 full 25-row calls = about 17 rows reviewable
  worst: every row needs review: delivered 0 of 30, charge 0 of 9 points, review spent 0.00000 of 0.003272 USD, 0 calls, 50 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 30 of 30, charge 9 of 9 points, review spent 0.00056 of 0.003272 USD, 1 calls, 13 rows to the review sheet
  realistic B: 10% doubtful: delivered 30 of 30, charge 9 of 9 points, review spent 0.00000 of 0.003272 USD, 0 calls, 5 rows to the review sheet
  no row doubtful (sample only): delivered 30 of 30, charge 9 of 9 points, review spent 0.00282 of 0.003272 USD, 1 calls, 0 rows to the review sheet

TikTok/YouTube comments (0.275), target 300: expected charge 83 points, review budget 0.030181 USD = 6 full 25-row calls = about 160 rows reviewable
  worst: every row needs review: delivered 150 of 300, charge 42 of 83 points, review spent 0.02820 of 0.030181 USD, 6 calls, 50 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 300 of 300, charge 83 of 83 points, review spent 0.02745 of 0.030181 USD, 12 calls, 26 rows to the review sheet
  realistic B: 10% doubtful: delivered 300 of 300, charge 83 of 83 points, review spent 0.02256 of 0.030181 USD, 6 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 300 of 300, charge 83 of 83 points, review spent 0.01692 of 0.030181 USD, 6 calls, 0 rows to the review sheet

TikTok/YouTube comments (0.275), target 1000: expected charge 275 points, review budget 0.1 USD = 21 full 25-row calls = about 531 rows reviewable
  worst: every row needs review: delivered 525 of 1000, charge 145 of 275 points, review spent 0.09870 of 0.1 USD, 21 calls, 25 rows to the review sheet, paging stopped by the budget
  realistic A: 25% of rows doubtful: delivered 1000 of 1000, charge 275 of 275 points, review spent 0.09945 of 0.1 USD, 37 calls, 26 rows to the review sheet
  realistic B: 10% doubtful: delivered 1000 of 1000, charge 275 of 275 points, review spent 0.07520 of 0.1 USD, 20 calls, 0 rows to the review sheet
  no row doubtful (sample only): delivered 1000 of 1000, charge 275 of 275 points, review spent 0.05640 of 0.1 USD, 20 calls, 0 rows to the review sheet

PROPOSAL (not applied): a floor of one full review call (0.0047 USD) on the budget, and the sample of a page may use at most 25% of the budget:
  X 30, worst: now delivered 0 of 30 (review budget 0.001454 USD); with the proposal 25 of 30 (budget 0.0047 USD, spent 0.00470), charge 3 of 4 points; review spend / revenue = 64.6% of the full expected charge
  X 30, 25% doubtful: now delivered 30 of 30 (review budget 0.001454 USD); with the proposal 30 of 30 (budget 0.0047 USD, spent 0.00244), charge 4 of 4 points; review spend / revenue = 33.6% of the full expected charge
  X 300, worst: now delivered 50 of 300 (review budget 0.01309 USD); with the proposal 50 of 300 (budget 0.01309 USD, spent 0.00940), charge 6 of 36 points; review spend / revenue = 14.4% of the full expected charge
  X 300, 25% doubtful: now delivered 300 of 300 (review budget 0.01309 USD); with the proposal 300 of 300 (budget 0.01309 USD, spent 0.01260), charge 36 of 36 points; review spend / revenue = 19.2% of the full expected charge
  X 1000, worst: now delivered 225 of 1000 (review budget 0.042909 USD); with the proposal 225 of 1000 (budget 0.042909 USD, spent 0.04230), charge 27 of 118 points; review spend / revenue = 19.7% of the full expected charge
  X 1000, 25% doubtful: now delivered 1000 of 1000 (review budget 0.042909 USD); with the proposal 1000 of 1000 (budget 0.042909 USD, spent 0.04268), charge 118 of 118 points; review spend / revenue = 19.9% of the full expected charge
  comments 30, worst: now delivered 0 of 30 (review budget 0.003272 USD); with the proposal 25 of 30 (budget 0.0047 USD, spent 0.00470), charge 7 of 9 points; review spend / revenue = 28.7% of the full expected charge
  comments 30, 25% doubtful: now delivered 30 of 30 (review budget 0.003272 USD); with the proposal 30 of 30 (budget 0.0047 USD, spent 0.00244), charge 9 of 9 points; review spend / revenue = 14.9% of the full expected charge
  comments 300, worst: now delivered 150 of 300 (review budget 0.030181 USD); with the proposal 150 of 300 (budget 0.030181 USD, spent 0.02820), charge 42 of 83 points; review spend / revenue = 18.7% of the full expected charge
  comments 300, 25% doubtful: now delivered 300 of 300 (review budget 0.030181 USD); with the proposal 300 of 300 (budget 0.030181 USD, spent 0.02030), charge 83 of 83 points; review spend / revenue = 13.5% of the full expected charge
  comments 1000, worst: now delivered 525 of 1000 (review budget 0.1 USD); with the proposal 525 of 1000 (budget 0.1 USD, spent 0.09870), charge 145 of 275 points; review spend / revenue = 19.7% of the full expected charge
  comments 1000, 25% doubtful: now delivered 1000 of 1000 (review budget 0.1 USD); with the proposal 1000 of 1000 (budget 0.1 USD, spent 0.07144), charge 275 of 275 points; review spend / revenue = 14.3% of the full expected charge

companies, target 5: the review of company rows is a separate path (not under this budget, no cap, not strict). The budget this rule would give a 5-company job is 0.005818 USD; the measured company review cost is 0.000068 USD per record (0.00034 USD for 5).
```
