# Review cost cut (branch claude/review-cost-cut)

Cuts the model-review (Anthropic) spend per job and closes the gap where rows were delivered without a verdict. Prices, caps, the charge formula and the fail-closed rule are unchanged: a page whose review fails is still held, never delivered.

## What changed

1. **Pre-filter before any model call (X posts of a topic search).** A post with no word of the topic AND (when a country was requested) no word of that country is excluded by code (`no_match`), never sent to the review. A post that names the country but not the topic is kept but flagged `suspicious` (every row is reviewed now, so the flag is metadata only). Normalisation is the existing one (alef, ya, ta marbuta, diacritics, light stemming); the country words come from `regionEvidenceWords` through `hasRegionEvidence`. Comments are NOT judged by their own words: the video decides.
2. **Verdict-only replies (posts, comments, videos).** The model returns `{index, verdict}` and no Arabic reason; the code writes the standard Arabic reason of the verdict («مطابق / غير مطابق لموضوع الطلب», «غير مؤكد من نص السجل وحده») for the review sheet. A reason the model adds anyway is ignored. The reply room is small (`advisoryMaxTokens(rows, true)` = 200 + 40 per row, at most 2,000). Companies and people keep their reasons. The 20 s timeout and the retry-once rule are unchanged.
3. **One call per page.** Every row of a page is reviewed in ONE call (a page longer than 25 rows is split in calls of 25). No sample, no tail call, no row delivered on the gate alone. When the first call of a LONG page finds more than 60% of its rows unrelated (and at least 8 were read), the rest of the page is excluded without a review (`rejected`, Arabic event, not charged); the reviewed rows keep their verdicts. A page of 25 rows or fewer is never rejected as a page: each row has its own verdict.
4. **Budget exhausted: not delivered.** A row the job's review budget did not reach is NOT delivered and NOT charged. It goes to its own sheet, **«غير مراجَع»**, with a plain Arabic notice, and the job stops buying pages (`review_budget`). A row left unreviewed because the review FAILED (timeout, unreadable reply, no key) still goes to the review sheet «سجلات تحتاج مراجعة» exactly as before.
5. **Low-yield stop.** When the budget is used up and fewer than 10% of the rows seen were accepted, the page is held in «غير مراجَع» and paging stops (`review_low_yield`, with its Arabic note). A running record without the counts never triggers it.
6. **Review spend in job_events.** One internal row per chunk that made review calls (or stopped): event type `review_cost`, message `review_spend step=… calls=… usd=… total_calls=… total_usd=… rows_seen=… low_yield_stop=…`. The customer's activity list leaves that type out; the customer's own lines stay Arabic with no amount.

## The new sheet

`غير مراجَع` is written after «سجلات تحتاج مراجعة» in the social workbook (the in-memory and the streamed writers). First line, merged: «هذه السجلات لم تُراجَع آلياً لأن التحقق بلغ الحد المسموح لهذا الطلب، فلم نتأكد من مطابقتها لموضوعك. لم تُحتسب عليك ولم تُخصم نقاطها، ولم تدخل ضمن الملف المُسلَّم. راجعها بنفسك إن أردت.» Columns: record id, what the record says, link, reason. The CSV and the delivered sheet never contain these rows. The report counts line shows `غير مراجَع: N`. The rows are kept in the step files (`unreviewedRows`), the retry seed and the running record's identities, so a retry neither re-buys nor re-delivers them.

## Interpretations the owner should know about

* "Budget exhausted": the budget cannot pay for even one more row (the merged budget is a ceiling, so spend never exceeds it).
* "Rows seen": rows that reached the relevance gate (after de-duplication and the date window), counted per chunk in the running record. "Accepted": rows the earlier chunks delivered.
* Item 1 does nothing for the measured basketball job (its rows already named basketball and were not Egyptian); the saving there comes from the page review.
* Consequence of 4 on small budgets: the review budget is 20% of the job's revenue, so a 300-post job can review only a few pages; the rest is «غير مراجَع» and the job ends early with fewer rows (see the simulation). Raising the share is a pricing decision and was not touched.

## Simulation (fake data, no live call): `npx tsx scripts/review-cost-effect.ts`

"before" replays main (6e707da); "after" is this branch. Tokens are priced at the real prices (0.80 / 4 USD per million in / out) with a token model fitted to the live calls of 21 Oct 2026; it is a model, not a measurement. «delivered with no verdict» is the number of delivered rows that no review ever answered: it must be 0.

| case | review calls | review USD | budget USD | pages | rows seen | delivered | delivered with no verdict | off-topic delivered | held (review sheet) | «غير مراجَع» sheet | excluded by code |
|---|---|---|---|---|---|---|---|---|---|---|---|
| X 300 posts, narrow topic (25% of rows on topic) [real budget] — before (main) | 2 | 0.0183 | 0.0131 | 2 | 40 | 6 | 0 | 0 | 34 | 0 | 0 |
| X 300 posts, narrow topic (25% of rows on topic) [real budget] — after | 4 | 0.0105 | 0.0131 | 5 | 100 | 17 | 0 | 0 | 37 | 16 | 30 |
| X 300 posts, narrow topic (25% of rows on topic) [real budget] — change | -100% fewer calls | 43% less | USD per delivered row: 0.00306 → 0.00062 | | | | | | | | |
| X 300 posts, broad topic (80% of rows on topic) [real budget] — before (main) | 2 | 0.0147 | 0.0131 | 16 | 320 | 300 | 282 | 54 | 15 | 0 | 0 |
| X 300 posts, broad topic (80% of rows on topic) [real budget] — after | 3 | 0.0104 | 0.0131 | 4 | 80 | 48 | 0 | 0 | 8 | 19 | 5 |
| X 300 posts, broad topic (80% of rows on topic) [real budget] — change | -50% fewer calls | 29% less | USD per delivered row: 0.00005 → 0.00022 | | | | | | | | |
| Comments 300 (videos judged, 10 comments per adopted video) [real budget] — before (main) | 3 | 0.0308 | 0.0302 | 3 | 380 | 300 | 0 | 0 | 0 | 0 | 0 |
| Comments 300 (videos judged, 10 comments per adopted video) [real budget] — after | 3 | 0.0135 | 0.0302 | 3 | 380 | 300 | 0 | 0 | 0 | 0 | 0 |
| Comments 300 (videos judged, 10 comments per adopted video) [real budget] — change | 0% fewer calls | 56% less | USD per delivered row: 0.00010 → 0.00004 | | | | | | | | |
| X 300 posts, narrow topic (25% of rows on topic) [budget not binding] — before (main) | 83 | 0.4358 | 1000.0000 | 45 | 900 | 233 | 2 | 2 | 667 | 0 | 0 |
| X 300 posts, narrow topic (25% of rows on topic) [budget not binding] — after | 45 | 0.1224 | 1000.0000 | 45 | 900 | 238 | 0 | 0 | 393 | 0 | 269 |
| X 300 posts, narrow topic (25% of rows on topic) [budget not binding] — change | 46% fewer calls | 72% less | USD per delivered row: 0.00187 → 0.00051 | | | | | | | | |
| X 300 posts, broad topic (80% of rows on topic) [budget not binding] — before (main) | 19 | 0.1402 | 1000.0000 | 19 | 380 | 300 | 85 | 15 | 65 | 0 | 0 |
| X 300 posts, broad topic (80% of rows on topic) [budget not binding] — after | 20 | 0.0706 | 1000.0000 | 20 | 400 | 300 | 0 | 0 | 64 | 0 | 21 |
| X 300 posts, broad topic (80% of rows on topic) [budget not binding] — change | -5% fewer calls | 50% less | USD per delivered row: 0.00047 → 0.00024 | | | | | | | | |
| Comments 300 (videos judged, 10 comments per adopted video) [budget not binding] — before (main) | 3 | 0.0308 | 1000.0000 | 3 | 380 | 300 | 0 | 0 | 0 | 0 | 0 |
| Comments 300 (videos judged, 10 comments per adopted video) [budget not binding] — after | 3 | 0.0135 | 1000.0000 | 3 | 380 | 300 | 0 | 0 | 0 | 0 | 0 |
| Comments 300 (videos judged, 10 comments per adopted video) [budget not binding] — change | 0% fewer calls | 56% less | USD per delivered row: 0.00010 → 0.00004 | | | | | | | | |

## Existing tests changed

See the PR body for every changed line, old and new. In short: tests that used posts with no topic word as rows that must reach the review now assert the exclusion; tests that pinned a sample, a strict page, a presumed row delivered without review, or the budget leaving the page «as it was» now assert one call per page and the «غير مراجَع» sheet; the advisor test asserts the verdict-only prompt for social kinds and keeps the old one for companies; the company strict-review test asserts the customer's lines without the owner's internal row.
