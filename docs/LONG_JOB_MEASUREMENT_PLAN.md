# Measuring the long-job numbers without spending (plan, nothing here spends or changes anything)

Everything the platform shows about how long a mission takes is a **range labelled «تقديري»** until these numbers are measured. This file says what is already
known from finished jobs (read-only), how to read it again, what cannot be known without real requests, and the exact small requests that measure the rest.

## 1. What the finished jobs already say (read-only query, run on 20 Oct 2026, completed jobs of the last 90 days)

The query is `docs/proposals/09_measurement_query.sql` (also `MEASUREMENT_SQL` in `src/lib/server/measurementReport.ts`). It only reads `jobs`, `provider_costs` and `job_events`.
`service_key` is `jobs.endpoint_id`; one provider cost row is written per chunk.

| service key | jobs | records | chunks | provider USD | per record | per chunk | records per chunk | s per chunk (median / p90) | retries | customer points per record |
|---|---|---|---|---|---|---|---|---|---|---|
| icypeas.companies.search | 44 | 434 | 84 | 0.250040 | 0.000576 | 0.002977 | 5.17 | 4.3 / 9.3 | 0 | 3.0 |
| tiktok-profile | 11 | 96 | 14 | 0.060000 | 0.000625 | 0.004286 | 6.86 | not enough page lines | 0 | 1.90 |
| crawl4ai.tiktok.search.videos | 4 | 19 | 4 | 0.002000 | 0.000105 | 0.000500 | 4.75 | not enough page lines | 0 | 3.0 |
| anyapi.x.search.posts | 1 | 10 | 1 | 0.000600 | 0.000060 | 0.000600 | 10.00 | 5.5 / 5.5 | 0 | 5.0 |
| tikhub.tiktok.search.videos | 2 | 6 | 2 | 0.003760 | 0.000627 | 0.001880 | 3.00 | 9.7 / 10.1 | 0 | 6.0 |
| icypeas.people.search | 1 | 5 | 1 | 0.003800 | 0.000760 | 0.003800 | 5.00 | not enough page lines | 0 | 3.0 |
| tikhub.tiktok.user.profile | 2 | 2 | 2 | 0.002000 | 0.001000 | 0.001000 | 1.00 | not enough page lines | 0 | 6.0 |

What this tells us, honestly: the platform has delivered **no comments job at scale yet** (the largest completed job is 434 company records over 84 chunks); the only seconds-per-chunk figures are
4.3 s (companies), 5.5 s (X posts) and about 10 s (TikTok video search), from 1 to 44 jobs each. Nothing is known about how long a chunk of 50 comments takes, how many comments a call returns in
practice, or what 429s look like at volume. That is what section 3 measures.

**Not recorded anywhere, so not reported:** the number of provider CALLS inside a chunk (a chunk makes up to 6 calls and writes one cost row). Records per call and USD per call therefore need the provider's own
usage panel (section 3 says what to read). If the owner wants it recorded, the smallest change is a code change (the worker would write the call count into the page line or a new column); that is a proposal, not done here.

## 2. How to read it again

Supabase, SQL Editor, paste `docs/proposals/09_measurement_query.sql`, Run. It is read-only. The same numbers are computed by `buildCapabilityMeasurements` (tested against fixtures, including the window, the idle-gap rule and the percentile rule),
so a result can be checked by hand.

## 3. The seven small requests for the tester (one per source)

The owner asked for each request to quote **at most 20 points** and the whole set to cost the provider **under 0.02 USD**. These two limits cannot both hold with the caps the owner listed, because the customer price per record is 5 to 11 points
(`src/lib/measurementPlan.ts` asks the public quote function, it sets nothing): 30 YouTube comments quote 311 points, not 20. So each request is given in two forms: **A, as specified** (the caps the owner listed, with the real quote), and **B, the largest
volume that stays within 20 points** (too small to measure records per call, useful only as a check of the price and the flow). Provider USD is an **estimate** from the catalog's price per call and records per call (not a measurement).
The customer points are the tester's account's points, not provider spend.

| # | Source | The request (fill the brackets) | A: volume | A: quote (points) | A: settles if all arrive | A: provider USD (calls) | B: volume within 20 points | B: quote | B: settles |
|---|---|---|---|---|---|---|---|---|---|
| 1 | تعليقات يوتيوب | استخرج تعليقات هذين الفيديوهين على يوتيوب بحد أقصى ٣٠ تعليقًا: [رابط الفيديو الأول] [رابط الفيديو الثاني] | 30 | 311 | 270 (9 a comment) | 0.0018 (2) | 1 | 11 | 9 |
| 2 | تعليقات تيك توك | استخرج ٣٠ تعليقًا من هذا الفيديو على تيك توك: [رابط الفيديو] | 30 | 207 | 180 (6 a comment) | 0.0020 (2) | 2 | 14 | 12 |
| 3 | أعلى فيديوهات قناتين على تيك توك | استخرج تعليقات أعلى ٣ فيديوهات من قناتين على تيك توك، حتى ٢٠ تعليقًا لكل فيديو: [القناة الأولى] و[القناة الثانية] | 120 (one job holds 86, so the plan is cut to 86) | 594 | 516 (6 a comment, at 86) | 0.0084 (8) | not meaningful (a mission needs at least two channels) | n/a | n/a |
| 4 | منشورات إكس عن حدث | استخرج ١٠٠ منشور عن [حدث محدد] من منصة إكس | 100 | 575 | 500 (5 a post) | 0.0015 (2) | 3 | 18 | 15 |
| 5 | منشورات صفحة فيسبوك | استخرج آخر ٢٠ منشورًا من صفحة [اسم الصفحة] على فيسبوك بين [تاريخ البداية] و[تاريخ النهاية] | 20 | 253 | 220 (11 a post) | 0.0040 (2) | 1 | 13 | 11 |
| 6 | شركات | ابحث عن ٥ شركات [نشاط] في [مدينة] | 5 | 18 | 15 (3 a company) | 0.00288 (1) | 5 | 18 | 15 |
| 7 | صناع القرار | ابحث عن صانع قرار واحد في شركة [اسم الشركة] | 1 | 222 | 0, 138 or 193 (see below) | 0.00076 (1) | none: the smallest quote is 222 | n/a | n/a |

**Total expected provider spend as specified: 0.02134 USD, which is above the 0.02 limit** (the mission is 0.0084 of it). **Recommended set: request 3 with two videos per channel** ("استخرج تعليقات أعلى فيديوهين من قناتين على تيك توك، حتى ٢٠ تعليقًا لكل فيديو: [القناة الأولى] و[القناة الثانية]";
80 comments, quote 552 points, settles 480 if all arrive, 6 calls, 0.0064 USD), which brings the total to **0.01934 USD**, under the limit. The other six stay as specified.

What each settles (the rule is the existing one: charge = ceil(delivered unique matching units x unit price), never above the quote, nothing before approval):
- comments and posts, companies: `ceil(delivered x unit price)` with the unit prices above; fewer records than asked settle less, and the rest of the quote returns;
- decision makers (one person, both contact fields asked): 0 if neither a work e-mail nor a phone arrives, **138** if one of them arrives (83 for the person plus 55), **193** if both arrive (83 + 55 + 55); the quote is 222.

What to read for each (beyond the settled points): the page lines of the request (they show the records per page and the time), `docs/proposals/09_measurement_query.sql` afterwards for the cost rows, and the provider's usage panel for the number of calls
and their USD before and after (the difference is the real spend of the request: it must be at or under the estimate in the table; if a request costs more than twice its estimate, stop the series).

Per request, what it is for: 1 how many comments one call returns for each video and whether one call per video is enough; 2 comments per call (the source gives up to 20) and seconds per call; 3 the discovery calls, how many videos are really read and that the plan is cut to what one job holds;
4 posts per call (up to 50) and repeats between pages; 5 posts per call (10), and how many fall outside the date window (they are not charged); 6 the real cost per record and the share rejected by the geographic gate; 7 the real cost of the call and which contact fields arrive.

## 4. What to do with the results

When the table above has real rows for comments and posts, the defaults in `src/lib/missionDuration.ts` (seconds per call, chunk overhead, records per call) can be replaced by measured values and the label «تقديري» can be dropped for those sources: that is the owner's decision.
Until then every duration and capacity shown to a customer stays labelled «تقديري».
