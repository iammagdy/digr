# Cheap review design (branch claude/cheap-review-design)

Status: DESIGN AND SIMULATION ONLY. Nothing in this branch changes the product. The code added is a prototype of the pure pieces (`scripts/cheapReview/prototype.ts`, tested in `tests/cheap-review-prototype.test.ts`) and a simulation on fake data (`scripts/cheap-review-simulation.ts`). Prices, caps, the charge formula and the 20% review budget share are not touched.

## 1. The problem, with what is measured

| fact | value | where it comes from |
|---|---|---|
| a review call of 20 rows today | 3,325 tokens in, 1,000 out, 0.00666 USD (that is 0.0083 USD for 25 rows) | `llm_usage`, 21 Oct 2026 (measured) |
| price per token | 0.80 USD per million in, 4 USD per million out | derived from two calls, matches all of them (measured) |
| output share of a call | 60% when the reply is cut at 1,000 tokens; about 75% for the older replies with a reason per row | measured |
| revenue per delivered X post | 0.000215 USD (0.11715 points at 0.10 EGP a point, 55 EGP a dollar) | the pricing code |
| review budget of a 300-post X job | 0.0131 USD (20% of the job's revenue), floor 0.0083 USD | `socialReviewCapUsd` |
| provider cost of a page of 20 posts | 0.0006 USD | `provider_costs` |

A 300-post job therefore affords about 2 review calls of 20 rows. That is why only a handful of rows is delivered and the rest waits in the «غير مراجَع» sheet. The owner rejects both "review less" and "review everything": the scheme itself has to change so that each model call decides many more rows for less money, and so that code decides the rows that are clearly relevant.

## 2. The design

Six pieces, each with its rule. The order is the order a row meets them.

### 2.1 Filters that stay (code, free)
Ad, spam, foreign-script, emoji-only and bare-reaction rows are rejected; a post with no word of the topic and (when a country is requested) no word of the country is rejected. All of this exists today and is unchanged. Arabic normalisation (alef, ya, ta marbuta, tashkeel, light stemming) is the existing one.

### 2.2 Strong-signal acceptance in code (`strongSignal` in the prototype)
A row is accepted WITHOUT a model call only when it has a word of the topic AND one of:
- **Tier A:** the country's name or demonym, a governorate or a city of the country (starter list of 27 governorates and 20 cities in the prototype);
- **Tier B (sports topics only):** a well-known club or player of the country;
- **Tier C (two dialect markers with the topic) exists but is OFF** until the audit has measured it.

A row that names ANOTHER country is never accepted in code, whatever else it has; it goes to the model. Hashtags are read as words (the normaliser turns `#غلاء` into the word). The vocabulary lists are a STARTER list that the owner must review (a wrong word is a wrong delivered row).

### 2.3 Near-duplicate clustering (`clusterRows`)
The text is normalised for comparison (no retweet prefix, links, mentions or digits; tashkeel and tatweel removed; letters folded; a letter repeated three times or more reduced to one). Rows whose word sets have Jaccard similarity of at least 0.85 form a cluster (a text of fewer than three words only matches an equal text). The model reviews ONE representative per cluster in the job; the verdict is applied to the cluster, including members that arrive later. A near-copy is assumed to have the truth of the row it copies (assumed 95%; the shifted 5% are wrong rows). The threshold is a trade: a lower one saves more calls and delivers more wrong rows.

### 2.4 Trusted publishers (`TrustedPublishers`)
Inside ONE job only (kept in the running record, nothing stored across customers): a publisher whose rows got two consecutive model matches is accepted afterwards without a model call; one no-match or uncertain verdict, or one audit failure, ends the trust. Trust never applies when the page is in strict review.

### 2.5 Big-batch, number-only model review
Up to 50 rows per call (48 real rows plus 2 canaries), numbered lines of text trimmed to 160 characters; the model answers with digits only, one per row: 1 match, 0 no match, 2 uncertain, written in groups of five separated by a space so it can count. Reply reading (`readDigitReply`) is STRICT, because one skipped digit would move every later verdict onto the wrong row:
- any character other than digits and whitespace, or a different number of digits than rows, rejects the whole reply (the rows are asked again in smaller calls, never the identical request);
- the two canaries are rows whose answer the code knows (an obvious spam row: 0; an obvious strong row: 1); one wrong rejects the whole reply;
- a reply cut at the output limit keeps its verified prefix only, if every canary inside it is right; the rows after it are asked again (this is the salvage, in the new format);
- fail-closed is unchanged: a row with no verdict after the retry is held and goes to the «غير مراجَع» or review sheet, never delivered;
- the 20 s timeout is unchanged.
The reply is about 70 tokens for 50 rows (1.4 a row, assumed) against 50 a row today (measured at the old limit), so the output falls under 10% of today's. The call is then dominated by input: 350 tokens of instruction plus about 110 a row.

Buffering: a page holds about 20 posts, and a call needs 48 rows, so the rows that need the model are collected across pages (in the running record) and sent when 48 are waiting, when the job ends, or as a last call sized to the budget that is left (at least 8 rows). This also lets the call budget be used whole instead of leaving 0.6 of a call unused.

### 2.6 Audit sample and the fall-back to strict review (`AuditWindow`)
A sample of the rows accepted without the model (strong signals and trusted publishers) is sent to the model in the same calls: the FIRST 12 such rows of every job, then 7% of the rest. The model's verdict on an audited row is compared with the code's acceptance; a row the model rejects is withdrawn before the file is built, and the publisher's trust is revoked. The audited rows feed a window of the last 40: above 15% false accepts (at least 12 audited) the job falls back to STRICT review (strong signals and trusted publishers go to the model), and it returns to code acceptance at 10% or below. Every audit and every fall-back is written as an internal `job_events` row (no customer text), for example `review_audit step=3 audited=12 false_accepts=2 window_rate=0.167 strict=1`.

## 3. Cost model and assumptions

Measured (M) and assumed (A) are separated. A line marked A is a guess that the first shadow run must replace.

| item | value | |
|---|---|---|
| price per token | 0.80 / 4 USD per million in / out | M |
| today's call | overhead 450 tokens, 144 tokens a row in, 50 tokens a row out (the 1,000 seen at the old limit; if the real uncut reply is shorter, today's cost is lower, see the lean line) | M (out: the limit) |
| cheap call | overhead 350, 110 tokens a row in (text of 160 characters), reply 10 + 1.2 a row | A |
| cheap call cost | 10 rows 0.00125, 25 rows 0.00264, 50 rows 0.00496 USD | A |
| verdict error of the model | 3% in today's call, 4% in a 50-row number-only call | A |
| a digit reply shifted by a row | 2% of calls; the canaries catch 90% (then the rows are asked again in calls of 10); the rest is read as it is (50% right) | A |
| duplicates | 15% of the rows that need the model are near-copies; a copy has the truth of the original 95% of the time | A |
| repeat publishers | 40% of those rows come from publishers who write often; 80% of those are consistent (5% of their rows go the other way), 20% are mixed | A |
| audit | first 12 accepted rows of a job, then 7% | A |
| row mix | narrow: 25% relevant, 12% strong signals, 45% rejected by code; broad: 80% relevant, 30% strong, 10% rejected; comments: 40% relevant videos, 25% strong, 20% rejected | A |
| false-accept rate of the code-accepted rows | 5%, 15% and 30%, all three shown | A |
| page cap | main's rule: 3 times the pages the target needs (45 pages for 300 posts) | M |
| provider cost | 0.0006 USD per page of posts; not modelled for comments | M |

## 4. Simulation

Fake data, no live call, 40 random worlds per line, averages. `scripts/cheap-review-simulation.ts` has every assumption at its top. "Wrong delivered" counts rows that are delivered but not truly relevant: the code's false accepts that were not caught, the model's own errors and the copies that took the wrong verdict. "Ceiling" is the number of truly relevant rows the job saw: nothing more could have been delivered.

Averages of 40 random worlds per line. Revenue per delivered row: X 0.000215 USD, comments 0.000500 USD (M). Review budget = 20% of the job's revenue (floor 0.0083 USD) (M).
Cost per call (M for today, A for cheap): today 20 rows 0.00666 USD (measured 0.00666), lean-reply sensitivity 0.00426; cheap 50 rows 0.00496 (A).

### X 300 posts, narrow topic (25% truly relevant)

| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| main (da8a825), 20-row calls, measured cost | 15 | 0.8 | 5.1% | 3.0 | 32 | 0.0112 | 0.0131 | 0.000756 | 3.52 | 4.29 | 4 | 11 | 20 | target 0/40, budget 40/40, pages 0/40 |
| main, if its reply were only 20 tokens a row (sensitivity) | 24 | 1.1 | 4.8% | 4.8 | 51 | 0.0118 | 0.0131 | 0.000494 | 2.30 | 2.98 | 6 | 11 | 29 | target 0/40, budget 40/40, pages 0/40 |
| cheap scheme, code false-accept 5% (A) | 87 | 6.3 | 7.2% | 3.0 | 124 | 0.0130 | 0.0131 | 0.000150 | 0.70 | 1.27 | 18 | 23 | 92 | target 0/40, budget 40/40, pages 0/40 |
| cheap scheme, code false-accept 15% (A) | 74 | 5.3 | 7.2% | 3.3 | 123 | 0.0133 | 0.0131 | 0.000180 | 0.84 | 1.47 | 17 | 26 | 84 | target 0/40, budget 40/40, pages 0/40 |
| cheap scheme, code false-accept 30% (A) | 72 | 6.4 | 9.0% | 3.4 | 119 | 0.0133 | 0.0131 | 0.000185 | 0.86 | 1.48 | 16 | 28 | 81 | target 0/40, budget 40/40, pages 0/40 |

### X 300 posts, broad topic (80% truly relevant)

| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| main (da8a825), 20-row calls, measured cost | 31 | 0.1 | 0.2% | 2.0 | 36 | 0.0120 | 0.0131 | 0.000387 | 1.80 | 2.07 | 3 | 18 | 48 | target 0/40, budget 40/40, pages 0/40 |
| main, if its reply were only 20 tokens a row (sensitivity) | 47 | 0.1 | 0.3% | 3.0 | 54 | 0.0117 | 0.0131 | 0.000248 | 1.15 | 1.39 | 4 | 18 | 64 | target 0/40, budget 40/40, pages 0/40 |
| cheap scheme, code false-accept 5% (A) | 170 | 4.3 | 2.5% | 3.1 | 124 | 0.0131 | 0.0131 | 0.000077 | 0.36 | 0.56 | 12 | 25 | 193 | target 0/40, budget 40/40, pages 0/40 |
| cheap scheme, code false-accept 15% (A) | 171 | 8.1 | 4.7% | 3.0 | 124 | 0.0130 | 0.0131 | 0.000076 | 0.35 | 0.55 | 12 | 24 | 190 | target 0/40, budget 40/40, pages 0/40 |
| cheap scheme, code false-accept 30% (A) | 142 | 7.4 | 5.2% | 3.3 | 121 | 0.0133 | 0.0131 | 0.000094 | 0.44 | 0.64 | 10 | 28 | 165 | target 0/40, budget 40/40, pages 0/40 |

### Comments 300 (judged by video; 10 comments per adopted video)

| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| main (da8a825), 20-row calls, measured cost | 300 | 27.0 | 9.0% | 3.2 | 53 | 0.0177 | 0.0302 | 0.000059 | 0.12 | n/a | 3 | 1 | 33 | target 39/40, budget 1/40, pages 0/40 |
| main, if its reply were only 20 tokens a row (sensitivity) | 300 | 27.0 | 9.0% | 3.2 | 53 | 0.0115 | 0.0302 | 0.000038 | 0.08 | n/a | 3 | 0 | 33 | target 40/40, budget 0/40, pages 0/40 |
| cheap scheme, code false-accept 5% (A) | 300 | 12.0 | 4.0% | 2.1 | 60 | 0.0068 | 0.0302 | 0.000023 | 0.05 | n/a | 4 | 0 | 40 | target 40/40, budget 0/40, pages 0/40 |
| cheap scheme, code false-accept 15% (A) | 300 | 23.8 | 7.9% | 2.1 | 64 | 0.0070 | 0.0302 | 0.000023 | 0.05 | n/a | 4 | 0 | 40 | target 40/40, budget 0/40, pages 0/40 |
| cheap scheme, code false-accept 30% (A) | 300 | 31.5 | 10.5% | 2.0 | 60 | 0.0066 | 0.0302 | 0.000022 | 0.04 | n/a | 4 | 0 | 38 | target 40/40, budget 0/40, pages 0/40 |

### What each piece adds (code false-accept 15%, A)

| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **X 300 posts, narrow topic (25% truly relevant)** | | | | | | | | | | | | | | | | |
| 50-row number-only calls only | 55 | 2.5 | 4.6% | 3.2 | 120 | 0.0131 | 0.0131 | 0.000239 | 1.11 | 1.80 | 13 | 27 | 67 | target 0/40, budget 40/40, pages 0/40 |
| + strong signals accepted in code | 83 | 8.8 | 10.7% | 3.2 | 120 | 0.0131 | 0.0131 | 0.000158 | 0.74 | 1.31 | 17 | 25 | 85 | target 0/40, budget 40/40, pages 0/40 |
| + near-duplicate clusters | 99 | 11.2 | 11.3% | 3.2 | 120 | 0.0131 | 0.0131 | 0.000132 | 0.62 | 1.18 | 20 | 25 | 99 | target 0/40, budget 40/40, pages 0/40 |
| + trusted publishers | 100 | 11.6 | 11.6% | 3.2 | 120 | 0.0131 | 0.0131 | 0.000130 | 0.61 | 1.17 | 20 | 25 | 100 | target 0/40, budget 40/40, pages 0/40 |
| + audit sample and strict fall-back (full scheme) | 74 | 5.3 | 7.2% | 3.3 | 123 | 0.0133 | 0.0131 | 0.000180 | 0.84 | 1.47 | 17 | 26 | 84 | target 0/40, budget 40/40, pages 0/40 |
| **X 300 posts, broad topic (80% truly relevant)** | | | | | | | | | | | | | | | | |
| 50-row number-only calls only | 106 | 0.7 | 0.6% | 3.2 | 123 | 0.0132 | 0.0131 | 0.000125 | 0.58 | 0.80 | 8 | 26 | 132 | target 0/40, budget 40/40, pages 0/40 |
| + strong signals accepted in code | 186 | 12.7 | 6.8% | 3.2 | 123 | 0.0132 | 0.0131 | 0.000071 | 0.33 | 0.52 | 13 | 26 | 201 | target 0/40, budget 40/40, pages 0/40 |
| + near-duplicate clusters | 224 | 15.4 | 6.9% | 3.2 | 123 | 0.0132 | 0.0131 | 0.000059 | 0.28 | 0.46 | 15 | 25 | 237 | target 0/40, budget 40/40, pages 0/40 |
| + trusted publishers | 243 | 16.7 | 6.9% | 3.2 | 123 | 0.0132 | 0.0131 | 0.000054 | 0.25 | 0.44 | 16 | 24 | 254 | target 0/40, budget 40/40, pages 0/40 |
| + audit sample and strict fall-back (full scheme) | 171 | 8.1 | 4.7% | 3.0 | 124 | 0.0130 | 0.0131 | 0.000076 | 0.35 | 0.55 | 12 | 24 | 190 | target 0/40, budget 40/40, pages 0/40 |

### The audit at the size of these jobs (code false-accept 15%, A)

| case | rows audited in the whole job | false accepts found | pages run in strict review | rows removed by the audit |
|---|---|---|---|---|
| X 300 posts, narrow topic (25% truly relevant) | 12.9 | 2.8 | 5.9 | 2.8 |
| X 300 posts, broad topic (80% truly relevant) | 14.3 | 2.7 | 3.0 | 2.7 |
| Comments 300 (judged by video; 10 comments per adopted video) | 12.6 | 2.5 | 0.5 | 2.5 |

### If the budget did not stop the job (to size the budget it would need; the real budget stays 20% of revenue)

| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **X 300 posts, narrow topic (25% truly relevant)** | | | | | | | | | | | | | | | | |
| main, measured cost | 225 | 9.2 | 4.1% | 45.0 | 490 | 0.1707 | 1000.0000 | 0.000758 | 3.53 | 4.09 | 45 | 0 | 223 | target 0/40, budget 0/40, pages 0/40 |
| cheap scheme, code false-accept 15% (A) | 227 | 14.8 | 6.5% | 9.9 | 409 | 0.0437 | 1000.0000 | 0.000193 | 0.90 | 1.45 | 45 | 0 | 223 | target 0/40, budget 0/40, pages 40/40 |
| **X 300 posts, broad topic (80% truly relevant)** | | | | | | | | | | | | | | | | |
| main, measured cost | 300 | 0.9 | 0.3% | 19.7 | 356 | 0.1192 | 1000.0000 | 0.000397 | 1.85 | 2.03 | 20 | 0 | 315 | target 40/40, budget 0/40, pages 0/40 |
| cheap scheme, code false-accept 15% (A) | 300 | 14.7 | 4.9% | 5.6 | 236 | 0.0247 | 1000.0000 | 0.000082 | 0.38 | 0.57 | 20 | 0 | 319 | target 40/40, budget 0/40, pages 0/40 |

### Levers inside the real budget (code false-accept 15%, A): shorter text per row, a bigger vocabulary

| scheme | delivered of 300 | wrong delivered | wrong share | model calls | model rows | review USD | budget USD | USD per delivered row | review cost / revenue per row | all-in cost / revenue per row (posts) | pages | rows left unreviewed | ceiling (relevant rows seen) | stopped by |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **X 300 posts, narrow topic (25% truly relevant)** | | | | | | | | | | | | | | | | |
| cheap scheme as designed (110 tokens a row, text of 160 characters) | 74 | 5.3 | 7.2% | 3.3 | 123 | 0.0133 | 0.0131 | 0.000180 | 0.84 | 1.47 | 17 | 26 | 84 | target 0/40, budget 40/40, pages 0/40 |
| text trimmed to 100 characters (70 tokens a row) | 106 | 7.4 | 7.0% | 4.3 | 181 | 0.0131 | 0.0131 | 0.000123 | 0.57 | 1.15 | 22 | 13 | 110 | target 0/40, budget 40/40, pages 0/40 |
| text trimmed to 70 characters (50 tokens a row) | 138 | 9.6 | 7.0% | 5.5 | 234 | 0.0130 | 0.0131 | 0.000094 | 0.44 | 1.09 | 32 | 51 | 158 | target 0/40, budget 40/40, pages 0/40 |
| vocabulary 10 points bigger (more rows accepted in code, at the same false-accept rate) | 92 | 9.1 | 9.9% | 3.1 | 124 | 0.0131 | 0.0131 | 0.000142 | 0.66 | 1.23 | 19 | 24 | 95 | target 0/40, budget 40/40, pages 0/40 |
| **X 300 posts, broad topic (80% truly relevant)** | | | | | | | | | | | | | | | | |
| cheap scheme as designed (110 tokens a row, text of 160 characters) | 171 | 8.1 | 4.7% | 3.0 | 124 | 0.0130 | 0.0131 | 0.000076 | 0.35 | 0.55 | 12 | 24 | 190 | target 0/40, budget 40/40, pages 0/40 |
| text trimmed to 100 characters (70 tokens a row) | 250 | 11.9 | 4.7% | 4.0 | 186 | 0.0131 | 0.0131 | 0.000052 | 0.24 | 0.43 | 16 | 11 | 261 | target 1/40, budget 39/40, pages 0/40 |
| text trimmed to 70 characters (50 tokens a row) | 294 | 14.7 | 5.0% | 4.9 | 220 | 0.0119 | 0.0131 | 0.000040 | 0.19 | 0.38 | 20 | 12 | 315 | target 23/40, budget 17/40, pages 0/40 |
| vocabulary 10 points bigger (more rows accepted in code, at the same false-accept rate) | 197 | 12.0 | 6.1% | 3.0 | 124 | 0.0130 | 0.0131 | 0.000066 | 0.31 | 0.50 | 13 | 23 | 211 | target 0/40, budget 40/40, pages 0/40 |

Cheap call cost by size (A): 10 rows: 0.00125 USD; 25 rows: 0.00264 USD; 50 rows: 0.00496 USD.

### How to read it
1. **Under the unchanged 20% budget the cheap scheme multiplies what is delivered, but it does not deliver most of a 300-row job for the X cases.** Narrow topic: 72 to 87 rows against 15 today (a job that sees only 81 to 92 relevant rows before its budget ends). Broad topic: 142 to 171 against 31. Comments reach 300 with a review cost of 0.0068 USD against 0.0177. The budget stops every X run: about 120 model rows in 3 calls, which is all 0.0131 USD buys.
2. **The input, not the output, is now the cost.** A 50-row call is 0.0050 USD of which 94% is input. The levers table shows that trimming the text sent per row is the strongest one: at 100 characters the broad topic delivers 250 of 300, at 70 characters 294 (narrow: 106 and 138). It is an ASSUMPTION that the model stays as accurate on shorter text (it will not be exactly as accurate; this must be measured).
3. **If the budget did not stop the job**, delivering the full ceiling costs the cheap scheme 0.044 USD (narrow) and 0.025 USD (broad) against 0.171 and 0.119 for main: about a quarter and a fifth. For the broad topic that is 0.38 times the revenue per delivered row; for the narrow topic 0.90 times, that is review alone almost equals the revenue.
4. **A narrow topic is not profitable even with the cheap scheme**: the provider pages dominate. All-in (review plus provider), the cheap scheme costs 1.27 to 1.48 times the revenue per delivered row for the narrow topic (main: 4.29) and 0.55 to 0.64 for the broad one (main: 2.07). The review scheme alone cannot fix a topic where only one row in four is relevant.
5. **The audit is statistically weak at this job size.** A 300-row job has 13 to 14 audited rows even with the first 12 front-loaded, so its false-accept estimate is noisy: at a true 15% rate the estimate crosses the 15% line by chance often. The fall-back protects accuracy (wrong share 7.2% against 11.6% without it in the narrow case, 4.7% against 6.9% in the broad one) but it costs volume (74 against 100 rows, and 171 against 243) but also fires when it should not. It measures much better across many jobs (shadow mode) than it controls one job.
6. **Accuracy is the price.** With a code false-accept rate of 5%, 15% and 30% the wrong share of delivered rows is 2.5%, 4.7% and 5.2% (broad) and 7.2%, 7.2% and 9.0% (narrow), against 0.2% and 5.1% for main in the same worlds. The comments case has the same shape (4.0%, 7.9%, 10.5% against 9.0%, where main's figure comes from the same assumed false-accept rate on its video evidence). These shares depend on the assumed model error and false-accept rates; the real rates are not known.

## 5. The main risk: wrong rows delivered

Every row accepted by code, by a cluster verdict or by trust is a row no model looked at in this job. If the code's false-accept rate is 15%, a customer receives about 5% wrong rows in a broad topic and about 7% in a narrow one, against under 1% for the broad topic today. The model's verdicts also get a little worse with 50 rows in a call and with a digit reply that can slip. Mitigations in the design: other countries block code acceptance; the canaries reject a shifted reply; the audit withdraws caught rows and falls back to strict review; nothing is accepted on a tier the owner has not approved; all of it can be switched off per piece.

What I could not establish, and no simulation can: the real false-accept rate of the vocabulary on real Egyptian Arabic posts; the real accuracy of a number-only 50-row call; whether the model keeps count of fifty digits.

## 6. Recommendation

**Do not ship the acceptance and big-batch pieces before the conference.** The conference is Saturday 2026-10-24 and the freeze is Friday evening: there are two working days, no measured false-accept rate, no measured accuracy for the digit reply, and the downside is paying customers receiving wrong rows in front of an audience, while the upside is cheaper review on jobs that are today delivered correctly but small. Today's behaviour (7 of 7 correct, few rows, the rest in «غير مراجَع») is a smaller risk than a wrong row.

What CAN ship before the freeze, at no risk to deliveries, is the measurement: **PR 1, shadow mode.** For rows the model already reviews, compute and LOG (internal `job_events` rows, nothing else changes) what strong-signal acceptance, clustering and trusted publishers would have decided, next to the model's verdict. That gives the real false-accept rate and the real saving from real jobs, with no change to what is delivered or charged. It costs no model call (the verdicts exist).

If shipping later, the smallest safe PRs, each behind its own switch and each measured before the next:
1. **Shadow measurement** (before the freeze): strong signals, clusters, trusted publishers logged next to the model verdicts.
2. **Budget-fit last call and the call estimate for the batch** (small, no accuracy effect): size the last call to the budget that is left.
3. **Near-duplicate reuse** (lowest false-accept risk): one verdict per cluster, threshold 0.9 to start.
4. **Number-only calls in shadow** on a share of pages, comparing with the JSON verdicts: measures accuracy and digit slips before any delivery depends on them.
5. **Number-only calls live** with canaries, strict reading and the retry in smaller calls.
6. **Strong-signal acceptance tier A with the audit** and the strict fall-back; tiers B and C only after the audit data.
7. **Trusted publishers** last.
Trimming the text per row (the strongest lever in the simulation) belongs in step 4 or 5 with its own accuracy measurement.

## 7. Not done here
No code in the product, no change to prices, caps, charge or the 20% share, no live call, no SQL. The vocabulary lists are a starter set. The simulation's world is assumed; its numbers are for choosing an order of work, not for promising a price.
