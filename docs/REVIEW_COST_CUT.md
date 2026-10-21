# Review cost cut (branch claude/review-cost-cut)

Cuts the model-review (Anthropic) spend per job. Prices, caps, the charge formula and the fail-closed rule are unchanged: a page whose review fails is still held, never delivered.

## What changed

1. **Pre-filter before any model call (X posts of a topic search).** A post with no word of the topic AND (when a country was requested) no word of that country is excluded by code (`no_match`), never sent to the review. A post that names the country but not the topic is kept but flagged (`suspicious`), so only the review can deliver it. Normalisation is the existing one (alef, ya, ta marbuta, diacritics, light stemming); the country words come from `regionEvidenceWords` (name and demonym, Arabic and English) through the new `hasRegionEvidence`. Comments are NOT judged by their own words: the video decides (videos are selected first), so a short comment that never repeats the topic stays a real comment. The basketball path was already strict (no topic word: excluded).
2. **Early page rejection.** When the sample review of a page finds more than 60% unrelated (and at least 8 sampled rows were read), the rest of the page's presumed rows are excluded without a review of their own (`outcome.rejected`, `no_match`, Arabic reason). The sampled rows and the doubtful rows keep the verdicts they got. 40%-60% is still a strict page (whole page reviewed). A failed review is never a rejection.
3. **Low-yield stop.** When the job's review budget is used up (the remaining budget cannot pay for one more row) AND fewer than 10% of the rows seen so far were accepted, nothing more is reviewed or delivered: the rows of the page wait in the review sheet (not delivered, not charged) and paging stops (`review_low_yield`, with its Arabic note). A running record without the new counts, or with an unreadable chunk, never triggers it.
4. **Review spend in job_events.** One internal row per chunk that made review calls (or stopped): event type `review_cost`, message `review_spend step=… calls=… usd=… total_calls=… total_usd=… rows_seen=… low_yield_stop=…`. The customer's activity list leaves that type out; the customer's own lines stay Arabic with no amount.

## Interpretations the owner should know about

* "Spend exceeds the budget": the merged budget is a hard ceiling (a call that would cross it is not started), so spend cannot exceed it. The rule fires when the budget is **used up** (cannot pay one more row).
* "Rows seen": rows that reached the relevance gate (after de-duplication and the date window), counted per chunk in the running record. "Accepted": the rows the earlier chunks delivered.
* Item 1 does nothing for the measured basketball job: its rows already had a basketball word (otherwise they were excluded) and were not Egyptian; the saving there comes from item 2.

## Existing tests changed (old line -> new line)

See the PR body for the full list. In short: five tests used posts with no topic word (a bare «اتفقت», a philosophical post, «صباح الخير», «ماتش جامد») as rows that must reach the review; they now assert the new exclusion with the exact decision and reason, and the tests that need doubtful rows reaching the review use rows that name the requested country (region EG). Two sampled-review tests used an all-«no match» reviewer that now rejects the page; their fixture is a page whose sample is 53% unrelated (strict, not rejected) and the assertions are the same plus `pageRejected: false`. The company strict-review test asserts the customer's lines without the owner's internal row and then asserts that row exactly.

## Simulation (fake data, no live call): `npx tsx scripts/review-cost-effect.ts`

Assumed reviewer cost model: 0.0040 + 0.0003 x rows USD per call (fitted to the three calls of the live job of 21 Oct 2026). It is a model, not a measurement.

| case | review calls | review USD | budget USD | pages | rows seen | delivered | off-topic delivered | held | excluded by code | stopped early |
|---|---|---|---|---|---|---|---|---|---|---|
| X 300 posts, narrow topic (25% of rows on topic) [real budget] — before | 2 | 0.0188 | 0.0131 | 5 | 100 | 56 | 35 | 44 | 0 | yes |
| X 300 posts, narrow topic (25% of rows on topic) [real budget] — after | 2 | 0.0161 | 0.0131 | 23 | 460 | 300 | 188 | 19 | 141 | no |
| X 300 posts, narrow topic (25% of rows on topic) [real budget] — change | 0% fewer calls | 14% less | | | | | | | | |
| X 300 posts, broad topic (80% of rows on topic) [real budget] — before | 2 | 0.0173 | 0.0131 | 16 | 320 | 300 | 54 | 15 | 0 | no |
| X 300 posts, broad topic (80% of rows on topic) [real budget] — after | 2 | 0.0170 | 0.0131 | 17 | 340 | 300 | 50 | 7 | 17 | no |
| X 300 posts, broad topic (80% of rows on topic) [real budget] — change | 0% fewer calls | 2% less | | | | | | | | |
| Comments 300 (videos judged, 10 comments per adopted video) [real budget] — before | 3 | 0.0303 | 0.0302 | 3 | 380 | 300 | 0 | 0 | 0 | no |
| Comments 300 (videos judged, 10 comments per adopted video) [real budget] — after | 3 | 0.0303 | 0.0302 | 3 | 380 | 300 | 0 | 0 | 0 | no |
| Comments 300 (videos judged, 10 comments per adopted video) [real budget] — change | 0% fewer calls | 0% less | | | | | | | | |
| X 300 posts, narrow topic (25% of rows on topic) [budget not binding] — before | 83 | 0.6014 | 1000.0000 | 45 | 900 | 233 | 2 | 667 | 0 | no |
| X 300 posts, narrow topic (25% of rows on topic) [budget not binding] — after | 50 | 0.3869 | 1000.0000 | 45 | 900 | 227 | 0 | 398 | 260 | no |
| X 300 posts, narrow topic (25% of rows on topic) [budget not binding] — change | 40% fewer calls | 36% less | | | | | | | | |
| X 300 posts, broad topic (80% of rows on topic) [budget not binding] — before | 19 | 0.1645 | 1000.0000 | 19 | 380 | 300 | 15 | 65 | 0 | no |
| X 300 posts, broad topic (80% of rows on topic) [budget not binding] — after | 19 | 0.1615 | 1000.0000 | 19 | 380 | 300 | 8 | 52 | 20 | no |
| X 300 posts, broad topic (80% of rows on topic) [budget not binding] — change | 0% fewer calls | 2% less | | | | | | | | |
| Comments 300 (videos judged, 10 comments per adopted video) [budget not binding] — before | 3 | 0.0303 | 1000.0000 | 3 | 380 | 300 | 0 | 0 | 0 | no |
| Comments 300 (videos judged, 10 comments per adopted video) [budget not binding] — after | 3 | 0.0303 | 1000.0000 | 3 | 380 | 300 | 0 | 0 | 0 | no |
| Comments 300 (videos judged, 10 comments per adopted video) [budget not binding] — change | 0% fewer calls | 0% less | | | | | | | | |
