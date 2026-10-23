# Cost report: 300 Facebook posts about a topic with about 5 comments each

Read-only estimate from the code and the committed catalog fixture. **No live call was made.** The numbers are produced by `src/lib/costEstimate.ts` (run `npx tsx scripts/cost-estimate-fb-topic.ts`) and pinned by `tests/cost-cuts-and-refusal.test.ts`.
Basis of every number: **MEASURED** (a production measurement the code records), **CATALOG** (a provider price read from `tests/fixtures/treg-social-catalog.json`, captured 2026-10-17, not a live read), **ASSUMED** (nobody measured it).

## The request and what the customer pays

| | Value | Basis |
|---|---|---|
| Posts / comments | 300 / 1,500 (5 per post) | the request |
| Unit price of a post / of a comment | 8 / 11 points | CATALOG: `ceil(0.00135 x 5,500) = 8` (the posts price is the page-posts price of the fixture; the topic service's own price was not read); `ceil(0.0019 x 5,500) = 11` |
| Charge (full delivery) | 2,400 + 16,500 = **18,900 points** = 1,890 EGP = **34.36 USD** | computed |
| Reserve (hold) | 2,760 + 18,975 = **21,735 points** (15% buffer on the reserve only) | computed |

## Cost of the job, three ways (USD; provider = TREG catalog prices, model = the reviewer)

| | A0. every row reviewed by the model, no ceiling | A. today's per-row rule with its 0.15 USD ceiling | B. this change (code filter, post-level review, comments only for accepted posts) |
|---|---|---|---|
| Provider calls: listing posts | 60 (ASSUMED: 10 posts a call, half the listed posts about the topic) | 60 | 60 |
| Provider calls: comments (one call per post whose comments are read) | 600 (every listed post) | 600 | **300** (accepted posts only) |
| Provider USD | 1.209 (CATALOG prices x ASSUMED calls) | 1.209 | **0.645** |
| Model calls: planning | 1 x 0.0155 (MEASURED) | 1 | 1 |
| Model calls: review (25 rows, 0.0083 USD a call, MEASURED 2026-10-21) | 144 | 18 (the ceiling stops it) | **17** (posts only; no comment is sent to the model) |
| Model USD | 1.211 | 0.165 | **0.157** |
| **Total cost** | **2.42** | 1.37 | **0.80** |
| Margin on the 34.36 USD revenue | 93% | 96% | **97.7%** |
| Rows the review can cover | 3,600 | **450 of 3,600** (the remaining rows are NOT delivered and NOT charged) | 420 posts judged; comments follow their post by plain rules |

Reading: today's per-row path with the 0.15 USD ceiling could review only 450 of the 3,600 rows of this job, so most of it would sit unreviewed in the review sheet. Reviewing at the level of the post makes the model cost follow the number of POSTS (17 calls),
not of comments (the 144 calls), which is what makes a 1,500-comment job possible inside the 20% of revenue (6.87 USD) the owner approved.

Worst case of the same job, still ASSUMED: if the listing returns only 3 posts a call and a quarter of the listed posts are about the topic: 400 listing calls (0.54 USD) + 300 comment calls (0.56 USD) = 1.1 USD of provider money. With a measured 20 posts a call: about 0.6 USD.

## Formula path of the two topic services, and whether the whole-point rule can lose money

* Comments (`facebook-post-comments`): `getCustomerPriceUsdPerCatalogItem` (`capabilityRegistry.ts:119`, 0.0019 USD) -> `registryPointsPerUnit` (no per-record cost for this slug, so the older rule) -> `calculateCapabilityUnitPricePoints`
  (`quotes.ts`) = `max(1, ceil(0.0019 x 55 x 10 / 0.1)) = ceil(10.45) = 11`. The quote writer reaches the same number through `unitPricePointsForCapability` (`quotes.ts:208`) -> `recordUnitPricePoints` is null for the slug -> the same function.
* Posts (`facebook-post-search`): `unitCostUsd` of the live catalog entry -> `calculateCapabilityUnitPricePoints` = `ceil(price x 5,500)`. 8 points means a catalog price in (0.001272, 0.001454] USD (0.00135 fits). The live price was NOT read.
* **Can the older rule lose money?** Rounding is always UP, so rounding alone never loses. It loses only when the provider cost per DELIVERED record exceeds the price: for comments the price is 0.002 USD (11 points / 5,500) against about 0.000376 USD
  (one 0.00188 call per post, 5 comments kept), so the price is about 5x the cost before the markup is counted. For posts the price is the call price per post; it loses only if one listing call yields fewer than one delivered post (for example 1 post
  a call with 50% on topic = 2 calls for each delivered post). That case is NOT PROVEN either way until the topic service's price and rows per call are measured. **No unit price was changed.**

## The ideas, with an estimated saving on this job and the risk to quality

| # | Idea | Estimated saving (vs A0) | Risk to quality | Status |
|---|---|---|---|---|
| 1 | Code-side filter before any model call (duplicates, empty rows, comments of under 3 letters or only a link or a bare supplication, posts with no word of the topic) | ASSUMED 20-30% of the rows never reach a model: about 0.26 USD on the per-row path | A post that is on topic without the literal word is dropped (never delivered, never charged). Not a precision risk, a yield risk. | **Already in the code** for X, TikTok, YouTube (`researchRelevanceGate.ts:96-122`, `commentQuality.ts`, `rowDedupe.ts`); pinned by tests here |
| 2 | Review at the level of the post: comments of an accepted post are accepted by plain rules | about 1.0 USD (120 of the 144 review calls) | Off-topic comments under an on-topic post are delivered (measured wrong share of delivered comments 9% in the PR #194 simulation, ASSUMED error model) | In the code for TikTok and YouTube; **this change adds Facebook topic comments** (`postLevelReview.ts`) |
| 3 | Review budget per job: at most 20% of the job's revenue; rows beyond it are not delivered and not charged, with one Arabic sentence | bound, not a saving: 6.87 USD here (not binding) | For a per-row job (X posts) 20% of revenue (0.013 USD for 300 posts) pays for about 1.5 calls: it would deliver 15-31 of 300 (PR #194). So it is applied to **post-level jobs only** | **This change**: `socialReviewCapUsd(..., "post")`; the per-row rule keeps its ceiling |
| 4 | Fetch comments only for accepted posts; stop on a repeating source | 300 comment calls = 0.56 USD; the stall guard saves at least 2 calls (0.004 USD) per stalled job | none (a rejected post's comments would not be delivered anyway) | Already in the adapter (videos are judged before any comment is read); stall guard from PR #213 tightened; pinned here |
| 5 | Plan caching (not implemented) | 0.0155 USD per repeated plan (MEASURED planning cost) | A cached plan can carry a stale price or catalog | report only |
| 6 | Bigger review batches, 50 rows a call (not implemented) | about 10-15% of the review cost: 0.02 USD on B (input tokens are 94% of a call, PR #194) | A longer list lowers the accuracy per row; the reply can be cut | report only |
| 7 | Firecrawl / Context.dev for comments (not implemented) | unknown: yield and price per record are unmeasured; needs one small owner-approved live test and a reading of their terms | weak yield today | report only |
| 8 | Prices from the measured cost per record (not implemented, **no price changed**) | not a saving: revenue falls. With comments at 0.00188 USD a call and 5 kept per post: about 2.1 points a comment instead of 11, a charge of about 5,500 instead of 18,900 points (-71%) | none to quality; a pricing decision | report only |
