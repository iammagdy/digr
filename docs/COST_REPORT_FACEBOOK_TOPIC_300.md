# Cost report: 300 Facebook posts about a keyword with about 5 comments each (one item: `social-facebook-keyword-comments`)

Estimates from the code and the committed fixtures. **No endpoint was called.** On 2026-10-23 the public provider catalog page was read once (`GET https://treg.to/catalog/platforms/facebook`, free, unauthenticated, the same read the 2026-10-18 audit used) to get the endpoint ids, parameters and prices below.
The numbers are produced by `src/lib/costEstimate.ts` (`npx tsx scripts/cost-estimate-fb-topic.ts`) and pinned by `tests/facebook-keyword-cost.test.ts`.
Basis of every number: **CATALOG** (read from that page), **MEASURED** (a production measurement the code records), **ASSUMED** (nobody measured it).

## What the catalog read returned (raw values)

| | Keyword search of posts (first source) | Keyword search of posts (second source) | Comments of a post (the source the service uses) |
|---|---|---|---|
| Endpoint | `justoneapi.x.facebook-search-post-v1` | `anyapi.facebook.search_posts` | `scrapecreators.x.v1-facebook-post-comments` (the routed `treg.facebook.post.comments` is the second) |
| Method | GET | POST | GET |
| Inputs | `keyword` (required), `startDate`, `endDate` (yyyy-MM-dd), `cursor` | `query` (required), `limit` 1-20 (default 20), `startDate`, `endDate`, `location`; **no cursor** | `url`, `feedback_id`, `cursor` (all optional) |
| Price | **0.2 CNY = 0.02952 USD per successful call** (`rate_card_api`, checked 2026-07-28, "billed only on success") | **0.06606 USD per call** (observed, checked 2026-10-02) | **0.00188 USD per call** (`rate_card_api`, 1 credit, verified) |
| Rows per call | **not published.** One catalog review: "Returns only 6 newest posts with zero engagement; no relevance/virality sort" | up to 20 (the `limit`); the page says "billed per result returned" next to a per-call price, so the unit is not certain | 10 (the code's figure, `maxPerCall`); not published on the page |
| Success rate | not published; the catalog's reviews: 43% useful, 29% partly, 29% not useful (5 teams) | not published (1 review: "partly") | 100% verified on the platform fixture |
| Needs a customer session | no | no | no |

Two facts follow. **The topic search costs 0.02952 USD a call, 22 times the 0.00135 the first report assumed** for the posts call, so the earlier two-service numbers (kept at the end) are superseded. And **only the first source pages**: the second has no cursor, so it can serve one page of at most 20 posts and is only the fallback.

## The service and its price

One item in the quote, so `accept_quote_atomic` and `acceptQuoteSupabase` need no change (tested). The customer gets comments; the search that finds each post is part of the price of a delivered comment.
**Price (ASSUMED cost basis, owner to approve):** `costUsdPerRecord 0.00235` x 5,500 = **12.925 points a comment** (`RECORD_COSTS`, the one shared per-record rule; nothing existing was repriced).
Where 0.00235 comes from: 0.02952 USD a search call / (6 posts a call x 0.5 of them about the keyword) + 0.00188 for the one comments call of the post = 0.01172 USD per adopted post; / 5 comments = 0.002344, rounded up.

| | Value | Basis |
|---|---|---|
| Request | 300 posts, 5 comments each = **1,500 comments** | the request |
| Charge (full delivery) | `ceil(1,500 x 12.925)` = **19,388 points** = 1,938.8 EGP = **35.25 USD** | computed |
| Hold (reserve) | `ceil(1,500 x 12.925 x 1.15)` = **22,296 points**, under the 25,000 cap (the buffer is on the hold only) | computed |

## Cost of the job on the stated assumptions (USD)

| | Value | Basis |
|---|---|---|
| Posts to list | 600 (half are about the keyword) | ASSUMED |
| Search calls | 100 (6 posts a call) x 0.02952 = **2.952** | CATALOG price x ASSUMED rows a call |
| Comments calls | 300 (one per ADOPTED post, none for the others) x 0.00188 = **0.564** | CATALOG |
| **Provider total** | **3.516**, i.e. 0.002344 a delivered comment (inside the 0.00235 the price is built on) | |
| Planning call | 0.0155 | MEASURED |
| Review calls (25 posts a call, 0.0083 USD) | 12 (half of the listed posts are settled by their own text and never reach the model; ASSUMED) = 0.100 | MEASURED price x ASSUMED share |
| **Total cost** | **3.63 USD**; margin **89.7%** of the 35.25 USD charge | |
| The capacity gate's estimate | 1,500 x 0.00235 = **3.525 USD**; the gate keeps 10% back, so the admin's daily limit (and the provider's real balance) must leave **3.92 USD** | computed |
| The most the search can ever cost one job | 150 pages x 0.02952 + 300 x 0.00188 = **4.99 USD** (the adapter reads at most 150 pages) | computed |

### What the three unmeasured numbers do (same job; grid in `facebookKeywordMissionSensitivity`)

| Posts a search call returns | Share listed that are about the keyword | Provider USD | Total USD | Margin | Cost basis of the price holds? |
|---|---|---|---|---|---|
| 3 | 25% | 12.37 | 12.59 | 64% | no |
| 3 | 50% | 6.47 | 6.58 | 81% | no |
| 6 | 25% | 6.47 | 6.68 | 81% | no |
| **6** | **50%** | **3.52** | **3.63** | **90%** | **yes** |
| 6 | 75% | 2.54 | 2.62 | 93% | yes |
| 10 | 50% | 2.34 | 2.45 | 93% | yes |
| 20 | 50% | 1.45 | 1.56 | 96% | yes |

At every point of the grid the job costs less than half its revenue. Where the search is poorer than assumed, the real cost per comment passes the 0.00235 the price is built on (the markup shrinks from 10x), but the job still earns. Where it is richer, the margin grows.
The review model pays for the POSTS, never a comment: judged page by page (6 posts a call) it would be 100 calls (0.83 USD); the adapter collects pages into lists of 50 before judging (12 calls, 0.10 USD). At the measured 0.0083 USD a call the ordinary per-job review ceiling (0.15 USD, 18 calls) stops the worst case at 47% to 75% of the request
(worker fixture run), so a paged job has its own ceiling of 0.25 USD (30 calls, 0.7% of its revenue; the owner's 20%-of-revenue rule still applies on top). **That 0.25 is a number I chose; it is one constant (`REVIEW_PAGED_JOB_CEILING_USD`).**

## Formula path of the two services (item 3 of the earlier request)

* **`social-facebook-keyword-comments`** (the mission): `RECORD_COSTS["social-facebook-keyword-comments"].costUsdPerRecord` (0.00235) -> `unitPriceMicro` = `ceil(0.00235 x 5,500 x 1,000,000)` = 12,925,000 millionths -> 12.925 points. The quote writer, the public estimate and the catalog read the same number (`recordUnitPricePoints`). Charge `chargeForUnits` = `ceil(delivered x 12.925)`, hold `reserveForUnits` = `ceil(volume x 12.925 x 1.15)`.
* **`facebook-post-search` / `facebook-post-comments`** (the two live-catalog items of the two-service plan, 8 and 11 points by the older whole-point rule `ceil(price x 5,500)`): unchanged and no longer on the owner's path for a request that names a keyword. They still cannot be accepted together (two items).
* **Can the whole-point rule lose money?** It rounds up, so rounding alone never loses. What decides it is the cost per DELIVERED record against the revenue per record (a point is worth 0.001818 USD, so 8 points are 0.01455 USD and 11 points 0.02 USD). For the older posts item the real search costs 0.02952 USD a call:
  per delivered post that is 0.0098 USD at 6 posts a call with half of them delivered (profit), but 0.039 USD at 3 posts a call with a quarter delivered (**loss**). The break-even is 2 posts a call at full delivery. So the older two-service price CAN lose money on the posts item in a poor search; the keyword service puts the search into the price of the comment, and the grid above earns at every point. NOT PROVEN for the live catalog entry (its price and rows a call were not read from the app's own catalog).

## The ideas (Part A), with the status after this change

| # | Idea | Estimated saving on this job | Risk to quality | Status |
|---|---|---|---|---|
| 1 | Code-side filter before any model call (a post whose own text names the keyword and the country is adopted by text; empty, repeated, very short or bare-supplication comments are dropped by rules) | about half of the listed posts never reach the model: ~0.10 USD of review | a relevant post without the literal words goes to the model, not dropped | in the code for X, TikTok, YouTube; Facebook posts use the same reader |
| 2 | Review at the level of the post, in lists of 50 | 12 review calls instead of 100 (page by page) or 72 (row by row): ~0.7 to 1.0 USD | off-topic comments under an on-topic post are delivered | **this change**: the keyword service |
| 3 | Review budget capped at 20% of the job's revenue | a bound (7.05 USD here, never binding) | none | applied to post-level jobs; the per-job ceiling for a paged job is 0.25 USD |
| 4 | Comments only for adopted posts, one call each, stop on a repeating source | 300 comment calls (0.56 USD) instead of 600; the stall guard stops after two repeated pages and after 36 posts with none adopted | none | **this change** (adopted-only; the stall guard of #213 kept) |
| 5 | Plan caching | 0.0155 USD per repeated plan | stale price | not implemented |
| 6 | Bigger review batches | ~10-15% of the review cost | accuracy per row | not implemented |
| 7 | Firecrawl / Context.dev for comments | unknown | weak yield | not implemented |
| 8 | Prices from the measured cost per record | not a saving | none | no price changed |

## Superseded: the earlier two-service numbers (posts 8 points, comments 11 points)

The first report priced the posts call at 0.00135 USD (the page-posts source's price, not a keyword search) and assumed 10 posts a call: provider 0.645 USD, total 0.80 USD, charge 18,900, hold 21,735. The catalog read shows the keyword search at 0.02952 USD a call, so those provider figures are about 5 times too low and are kept only as `facebookTopicCostReport` (tested as arithmetic) for comparison.
