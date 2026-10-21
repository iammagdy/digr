# All-in cost per delivered record and margins (read-only, 2026-10-21)

Sources (SELECT only): `jobs` (completed, delivered > 0), `provider_costs` (per job), `llm_usage` (per user, no job id), settings and code. Revenue in USD = points x 0.10 EGP / 55.

## What the data can and cannot say
- `llm_usage` has **no job id**: planning calls (propose_plan, ask_clarification, ...) cannot be tied to a job; they are shown as measured per-call averages. `provider_costs` rows of provider `llm` also carry no job id.
- MEASURED (our own jobs, test accounts): companies 45 completed jobs / 438 records: **0.0038 USD per call of up to 10 records** (0.00038 USD per record from 10 records up; 0.00076 at 5 records; 0.0038 for 1 record). X: 3 calls of **0.0006 USD**, 46 posts for 0.0018 USD = **0.000039 USD per post** (56 posts / 4 calls in all). TikTok comments (tikhub): 26 comments for 0.006 USD and 1 comment for 0.005 USD (about **0.005 USD fixed per job + about 0.00004 per comment**, two points only). YouTube comments (crawl4ai): 3 comments for 0.0018 USD; 5 failed jobs with nothing delivered cost 0.003 to 0.005 USD each (**fixed discovery cost**). Facebook posts and comments: **no job ever completed: ASSUMED only**.
- OWNER-REPORTED: X at scale 0.80 USD for about 37,500 posts = 0.0000213 USD per post (28 posts per call). Our own 46 posts cost 1.8x that per post (15 posts per call).
- LLM per call, MEASURED from `llm_usage` (claude-haiku-5-5): propose_plan **0.0155 USD** average (208 calls, 18,100 input tokens), ask_clarification 0.0137 (44), relevance_review **0.0047** (9 calls; 25 rows per call in the code), search_catalog 0.019.
- The automatic review of rows runs for X, TikTok and YouTube (only rows the gate flags as doubtful; fail closed) and for every company row; **not** for Facebook. The share of rows flagged is **not measurable from stored data**: the table below shows 0% and the worst case (every row reviewed). Companies review measured: 0.000068 USD per delivered record.
- **The review budget of a job is `0.0006 USD x target records` (`socialReviewCapUsd`, minimum 0.05 USD): that is more than the whole revenue of an X record (0.000213 USD) and above the revenue of a comment (0.0005 USD).** The cap does not protect the margin.

## Margin = revenue / all-in cost, at the PROPOSED unit prices
Columns: provider only | provider + review (every row reviewed, worst case; video-list review 0.0047 per comments job) | + one planning call (0.0155 USD). X provider cost uses our own measured rate; with the owner-reported rate the provider-only margin is 9.4x to 9.9x at 300 to 3,000 records.

| capability | records | charge (points) | revenue USD | provider USD | provider only | + review | + 1 plan call |
|---|---|---|---|---|---|---|---|
| X posts | 30 | 4 | 0.0073 | 0.0012 | 6.1x | **1.06x** | **0.33x** |
| X posts | 300 | 36 | 0.0655 | 0.0120 | 5.5x | **0.96x** | **0.78x** |
| X posts | 1,000 | 118 | 0.2145 | 0.0396 | 5.4x | **0.94x** | **0.88x** |
| X posts | 3,000 | 352 | 0.6400 | 0.1176 | 5.4x | **0.94x** | **0.92x** |
| YouTube comments | 30 | 9 | 0.0164 | 0.0045 | 3.6x | **1.1x** | **0.54x** |
| YouTube comments | 300 | 83 | 0.1509 | 0.0180 | 8.4x | **1.91x** | **1.6x** |
| YouTube comments | 1,000 | 275 | 0.5000 | 0.0530 | 9.4x | **2.04x** | **1.91x** |
| YouTube comments | 3,000 | 826 | 1.5000 | 0.1530 | 9.8x | **2.08x** | **2.03x** |
| TikTok comments | 30 | 9 | 0.0164 | 0.0062 | **2.6x** | **0.99x** | **0.51x** |
| TikTok comments | 300 | 83 | 0.1509 | 0.0170 | 8.9x | **1.93x** | **1.61x** |
| TikTok comments | 1,000 | 275 | 0.5000 | 0.0450 | 11.1x | **2.1x** | **1.97x** |
| TikTok comments | 3,000 | 826 | 1.5000 | 0.1250 | 12.0x | **2.16x** | **2.12x** |
| Facebook comments | 30 | 32 | 0.0582 | 0.0056 | 10.3x | 5.16x | **2.17x** |
| Facebook comments | 300 | 311 | 0.5655 | 0.0564 | 10.0x | 5.01x | 4.41x |
| Facebook comments | 1,000 | 1,034 | 1.8800 | 0.1880 | 10.0x | 5.0x | 4.8x |
| Facebook comments | 3,000 | 3,102 | 5.6400 | 0.5640 | 10.0x | 5.0x | 4.93x |
| Facebook posts | 30 | 104 | 0.1891 | 0.0188 | 10.1x | 7.73x | 4.73x |
| Facebook posts | 300 | 1,035 | 1.8818 | 0.1881 | 10.0x | 7.7x | 7.24x |
| Facebook posts | 1,000 | 3,449 | 6.2709 | 0.6270 | 10.0x | 7.69x | 7.55x |
| Facebook posts | 3,000 | 10,346 | 18.8109 | 1.8810 | 10.0x | 7.69x | 7.65x |
| Companies | 30 | 96 | 0.1745 | 0.0114 | 15.3x | 12.99x | 6.03x |
| Companies | 300 | 951 | 1.7291 | 0.1140 | 15.2x | 12.87x | 11.53x |
| Companies | 1,000 | 3,168 | 5.7600 | 0.3800 | 15.2x | 12.86x | 12.43x |
| Companies | 3,000 | 9,504 | 17.2800 | 1.1400 | 15.2x | 12.86x | 12.71x |

Bold = under 3x. (The Facebook rows include the review cost as a conservative worst case; the worker does not review Facebook rows.) Reading: provider-only margins are 5x to 15x except TikTok comments at 30 records (2.6x, the 0.005 USD fixed cost). With every row reviewed, **X is at about 1x at every size and YouTube/TikTok comments at about 2x**; with the planning call, every small job of X and comments is under 3x. Facebook posts, Facebook comments and companies stay above 3x at every size except Facebook comments at 30 records with the planning call (2.2x).

## Options (NOT implemented). Each keeps charge = ceil(delivered unique matching units x unit price)

**Option 1, unit price that includes the review:** unit = 5,500 x (provider cost + review cost) for 10x, or 1,650 x for 3x.

| capability | review share | cost per record USD | unit for 3x | unit for 10x | max records at 5,000 (3x unit) |
|---|---|---|---|---|---|
| X posts | 25% | 0.000068 | 0.11715 | 0.3757 | 37,113 |
| X posts | 100% | 0.000209 | 0.3453 | 1.1512 | 12,591 |
| YouTube comments | 25% | 0.000097 | 0.275 | 0.5335 | 15,810 |
| YouTube comments | 100% | 0.000238 | 0.3927 | 1.309 | 11,071 |
| TikTok comments | 25% | 0.000087 | 0.275 | 0.4785 | 15,810 |
| TikTok comments | 100% | 0.000228 | 0.3762 | 1.254 | 11,557 |
| Facebook comments | 0% | 0.000188 | 1.034 | 1.034 | 4,204 |
| Facebook posts | 0% | 0.000627 | 3.4485 | 3.4485 | 1,260 |
| Companies | 0% | 0.000448 | 3.168 | 2.464 | 1,372 |

(current units: X 0.11715, YouTube and TikTok comments 0.275, Facebook comments 1.034, Facebook posts 3.4485, companies 3.168; at a review share of 25% the 3x price equals the current price for every capability.) The 10x price of X with every row reviewed (1.1512 points) does not fit the owner's target of 4,000 posts under 500 points; a 3x price (0.3453 points: 4,000 posts = 1,382 points) does not either. Only a lower review share, or Option 3, does.

**Option 2, minimum plan volume** (plan refuses to start below it; with the planning call included), smallest plan size with all-in margin >= 3x:

| capability | review 0% | review 25% | review 100% |
|---|---|---|---|
| X posts | 316 | 5,745 | never |
| YouTube comments | 157 | 328 | never |
| TikTok comments | 161 | 313 | never |
| Facebook comments | 35 | n/a | n/a |
| Facebook posts | 11 | n/a | n/a |
| companies | 10 | n/a | n/a |

The tester batch (300 records per source) sits at or below the minimum for X and the two comment services.

**Option 3, cap the number of review calls per job** by revenue: `socialReviewCapUsd = min(current, 20% of the job's revenue)`. X: 0.000043 USD per record = 23% of rows reviewed at full call price; comments 0.0001 USD per record = 53%. Rows that are flagged beyond the budget are not delivered and not charged (fail closed), so the customer gets fewer rows only when more than 23% (X) or 53% (comments) are doubtful. The flagged share is unmeasured: the tester batch measures it (review cost / delivered, from `llm_usage` around each test job).

**Recommendation:** Option 3 now (no price change, protects the margin by construction, the smallest change), measure the doubtful share in the tester batch, then decide Option 1 only for X if the share turns out above 23%. Keep Option 2 for TikTok comments below 160 records only if the owner accepts a minimum plan.
