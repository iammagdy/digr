# Volume ceilings, Facebook search, provider limits (proposal only; nothing changed on main)

Evidence is `file:line` on main at 488c8752. Counts marked "probe" come from running the real chat handler with the model stubbed to throw and a fake database (no network).

## A. Where the ceilings live

| Ceiling | Value | Where |
|---|---|---|
| Rows per plan item, per capability | X posts 500; YouTube comments 1,000; TikTok comments 1,000; Facebook comments 500; TikTok videos 200; YouTube videos 48; Facebook page posts 60 | `src/lib/socialSources.ts:500,513,528,543,557,570,583`; enforced `src/functions/shared/planManager.ts:384` (registry row `max_rows`, e.g. Facebook comments 500, Facebook posts 60 in production) |
| Edit schema | 5,000 per item | `planManager.ts:49,61` |
| Rows per worker chunk | 50 (`SOCIAL_ROWS_PER_CHUNK`); mission chunks up to 500 (`MISSION_ROWS_PER_CHUNK`) | `socialSources.ts:722`; `src/lib/server/socialAdapter.ts:68` |
| Calls per chunk / time per chunk | 6 calls / 40 s | `socialSources.ts:719`; `socialAdapter.ts:62`; route `maxDuration` 60 |
| Chunks (pages) per job | 30 (`ABSOLUTE_MAX_PAGES`), `min(30, ceil(target / 50) x 3)` | `src/lib/server/providerCallCaps.ts:22,39-44`; used `src/app/api/worker/chunk/route.ts:954` |
| => rows per job | feeds 30 x 50 = 1,500; missions at most 30 x 500 = 15,000 | derived |
| Mission shape | 10 channels, top 20 per channel, 30 videos ranked per channel, 100 videos in all, 500 comments per video | `socialSources.ts:627-631`; `socialAdapter.ts:66` |
| Reserve per job | 600 points | `planManager.ts:599`; `providerSpend.ts:5`; SQL settle functions |
| Provider capacity at plan time | estimate = volume x `unitCostUsd` (the price of ONE CALL per record) against 90% of min(estimated balance, daily allowance left) | `planManager.ts:736-760`; `providerSpend.ts:264-300` |
| Per-chunk spend gate | estimate = worst source price x 6 calls (X 0.006 USD) against the daily limit (SQL `reserve_provider_spend_atomic`) | `jobExecutionSpec.ts:123`; `socialSources.ts:728`; `route.ts:459-468` |
| Dedupe and assembly re-read every earlier chunk file | chunk n downloads files 0..n-1 (dedupe) and the last chunk downloads all of them (assembly) | `route.ts:602-618` and `1171-1215`; chunk file written `route.ts:1022` |

## B. What the real sizes need

Probe of the real chat path (balance 100,000, today's prices): M1 with a 2,000-comment cap is planned as "up to 1,000 comments" (cut by the 1,000 per-item ceiling, the request line says 1,000 not 2,000) and then cut to 57 comments / 590 points by the 600-point cap. M3 with "posts and replies" asks which platform (the word "ردود" makes it a comments request, and X has no comments service). M3 without "ردود" and 500 posts is planned as 104 posts / 598 points, and its subject is cut to «ماتش» (the country words are taken as a country filter). These are non-money defects of the intent step, reported not fixed here.

| Mission | Rows | What blocks it today | Exact changes (proposal) |
|---|---|---|---|
| M3 37,500 X posts | 37,500 | per-item 500; edit schema 5,000; chunk of 50 and 30 chunks = 1,500; reserve 600; plan-time capacity gate prices a post at a call price (28 USD estimate for 37,500, so it downscales); dedupe re-reads every earlier file (750 chunks of 50 would make about 281,000 downloads) | 1) `socialSources.ts:500` X `maxRows` 500 -> 40,000 and `planManager.ts:49,61` 5,000 -> 50,000. 2) `SOCIAL_ROWS_PER_CHUNK` 50 -> 250 (5 calls of 50 inside the 40 s budget, so 150 chunks) and a feed page cap of `ceil(target / rowsPerChunk) x 1.2` up to 200 in `providerCallCaps.ts:22,39`. 3) Replace the dedupe re-read by one running identity file per job (about 750 KB for 37,500 rows) and assemble the result from chunk files in a final stage that streams CSV first, so no single invocation reads 150 files and builds a 37,500-row workbook in 60 s (unmeasured, see below). 4) Plan-time capacity gate to use cost per delivered record (4d) instead of call price. 5) Job cap 600 -> 6,000 (money, SQL `job_points_cap()` in file 05). 6) Driver (file 07) so the 150 chunks run with the page closed. 7) Provider daily limit above 0.80 (section C). |
| M1 real size | up to 25,000 comments (50 videos x 500) | per-item 1,000; 15,000 rows per mission job; reserve 600 | per-item YouTube comments `maxRows` 1,000 -> 25,000; mission chunk and page cap give 30 x 500 = 15,000, so raise `ABSOLUTE_MAX_PAGES` for missions to 60; job cap 6,000 is not enough at the worst-path price (8,050 reserve), the customer's own cap or the first-path price settles it |
| M2 real size | up to about 5,000 comments | per-item 1,000; reserve 600 | per-item 1,000 -> 5,000; job cap as above |

## C. Provider balance and daily limit each mission needs

Facts read (SELECT only): recorded provider spend to date 0.9485 USD over 453 cost rows; spend today 0.01026 USD; stored daily limit 0.90 USD (`settings_private.provider_limits`, written by the admin screen). The estimated available balance is `PROVIDER_CREDIT_USD` (default 1.00, an environment value I cannot read) minus recorded spend, i.e. 0.0515 USD at the default. Plan capacity today is then 0.9 x 0.0515 = 0.046 USD, so an X request is downscaled to about 61 posts until the credit setting is raised.

| Mission | Provider cost, central (worst path) | Daily limit needed (cost + 25%) | Balance needed at plan time (cost / 0.9) |
|---|---|---|---|
| M1 25,000 comments, first path | 0.045 (worst 1.25) | 0.06 (worst 1.6) | 0.05 (worst 1.4) |
| M2 5,000 comments | 0.009 (worst 0.25) | 0.012 (worst 0.31) | 0.01 (worst 0.28) |
| M3 37,500 posts | 0.56 to 0.80 (worst 1.88) | 1.00 (worst 2.35) | 0.89 (worst 2.1) |
| M4 2,000 page posts | 0.40 (worst 1.25) | 0.50 (worst 1.6) | 0.45 (worst 1.4) |
| B2B 50 companies | 0.029 | 0.04 | 0.03 |

All five in one day: central 1.1 to 1.3 USD of provider spend.

What happens to an APPROVED job when the allowance or balance runs out (from the code):
- Daily limit: each chunk first asks `reserve_provider_spend_atomic`. If denied and rows were already delivered, the job stops, keeps the matching rows, settles and charges only them, and the rest of the reserve is released (`route.ts:470-480`, event «توقف الجمع عند الحد اليومي الآمن»). If nothing was delivered the whole reserve is released and the job fails with a 429 (`route.ts:481-501`). Nothing resumes the next day; the customer gets fewer records than asked and must ask for the rest.
- Provider balance: the code never reads the provider's real balance before a chunk, only the estimate above. When the provider refuses, the call fails: with rows delivered the job keeps them and settles (`providerFailedAfterDelivery`, `route.ts:545-551`, covered by the Phase 6 simulation); with none, every source fails and the full reserve is released (`tests/social-worker.test.ts`).
- Proposal: the start gate in file 05 and `capsProposal.ts` checks the daily allowance and the provider balance before approval, so a job that cannot finish is refused before points are held; a pause-and-resume-tomorrow status (reserve kept, no partial settlement) would be a new money behaviour and is not proposed without the owner's decision.

## D. Facebook search by keyword

Evidence: production `capability_registry` (SELECT) has only `social-facebook-comments` (`scrapecreators.x.v1-facebook-post-comments`, 0.00188 USD per call, 10 comments per call, 500 max) and `social-facebook-posts` (`anyapi.facebook.user.posts`, 0.002 USD per call, 10 posts per call, 60 max). The code's page-post chain is `anyapi.facebook.user.posts` (0.002, 10), `scrapecreators.x.v1-facebook-profile-posts` (0.00188, 3), `crawl4ai.facebook.user.posts` (0.00135, 20) (`socialSources.ts:385-420`); all need a page link or name. The static registry has `facebook-post-search` (`capabilityRegistry.ts:187-216`) but it is `status: pending_verification`, `enabled: false`, endpoint `internal-facebook-post-search` (not a catalog id), with a guessed 0.03 USD per call, 20 per call, 88% success: a placeholder, not a verified endpoint. `docs/SOCIAL_SOURCE_CATALOG_AUDIT.md` audited the X catalog only. The provider catalog's Facebook page was not read (no live calls), so a keyword endpoint, its price and page size are NOT KNOWN.

Proposal to make M4 purchasable: (1) with the owner's permission, read the public catalog page for Facebook (`https://treg.to/catalog/platforms/facebook`, the same unauthenticated page used for the X audit) and record any keyword or public-search endpoint with price, page size, session need and success rate; (2) if one exists without a customer login, add it as a `query` source of `social-facebook-posts` (modes `query` and `channel`), price it with the 4d formula, add dateFrom/dateTo handling in the worker's existing date filter (already in place), and verify with a 20-post run; (3) if none exists, sell M4 honestly as "posts of pages you name": the customer lists pages, the mission template for channels already supports a list; the unsupported keyword wording gets a plain Arabic answer instead of the current dead end (in the probe, M4 as typed has no code path and falls through to the model, which was stubbed to throw).
