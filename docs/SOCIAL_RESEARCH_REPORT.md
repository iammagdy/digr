# Social research: why the platform did not work like the direct tool, and what was changed

Date: 2026-10-17. Branch `claude/zealous-carson-sdg9x4` (draft PR #80). No customer data, token or secret appears here.
Everything marked PASS below is an automated test or a read-only measurement; everything that needs a live provider call is marked NOT RUN.

## 1. What the owner asked

Researchers should be able to pull comments of a Facebook post, YouTube video or TikTok video, trending videos together with
their comments, and the videos of a TikTok channel, from the browser, as the owner did before from the IDE. The assistant should
understand the request, ask only for what is missing, and send the right order to the provider.

## 2. Root causes found (each with its evidence)

| # | Cause | Evidence |
|---|---|---|
| 1 | The live registry has no working service for these tasks. Every social endpoint id registered (`facebook.page.posts`, `youtube.search.video`, `tikhub.tiktok.search.video`, `twitter.search.tweets`, `instagram.user.profile` and others) and every "internal-..." id for Facebook and YouTube comments returns HTTP 404 on the provider's public catalog. Only the TikTok profile, companies and people services exist. | Public catalog endpoint pages: 13 ids returned 404 (11 registry rows: `facebook.page.posts`, `google.serp.organic`, `instagram.user.profile`, `instagram.user.posts`, `telegram.channel.messages`, `tikhub.tiktok.search.video`, `tikhub.tiktok.user.posts`, `twitter.search.tweets`, `twitter.user.tweets`, `youtube.channel.details`, `youtube.search.video`; plus `internal-facebook-post-comments` and `internal-youtube-comments`). The 3 enabled registry rows (`tikhub.tiktok.user.profile`, `icypeas.companies.search`, `icypeas.people.search`) exist. Registry rows read with a read-only query. |
| 2 | The assistant did not understand the owner's own words. "كومنتس" was not read as comments, "ستراندنج" was not read as trending, so the catalog was searched for the platform alone and the cheapest-first ranking put a post search at 364 points a call above the comments service. | Raw output of the catalog search for "عايز كومنتس بوست على فيسبوك": first result was a post search, not comments. |
| 3 | A correct comments answer was read as "no data". The result reader recognized lists only under a fixed set of names (`videos`, `posts`...) and not `comments`, `rows` or a routed `output` envelope; an aggregator answer `data.comments` became ONE junk row that would have been billed. | Run of the old reader on the real answer shapes: 0 rows, "invalid payload", or 1 junk row. |
| 4 | The default source was the slow, less reliable one. The old ranking preferred the cheapest source: its measured median is 14 s (95th percentile 33 s, 97.7% success) while the alternative has 99.99% success over 170,000 calls at 3.4 s. The worker is cut off at 60 s and a call had no time limit. | Catalog measurements; the database shows 6 of 10 TikTok keyword-video jobs failed with the provider-failure reason. |
| 5 | "Videos with their comments" was impossible: the worker runs the first plan step only, so a two-step plan was silently reduced to one. | `resolveJobExecutionSpec` reads `items[0]`. |
| 6 | Channels of TikTok need an id the customer never has: the old service wanted `secUid`, not the username. | Catalog page of that endpoint ("does NOT accept a username"). |
| 7 | The result files were not usable: raw provider columns in English ("حقل digg count", "حقل user nickname"), a duplicated likes column, a unix timestamp shown as `1760000000`, and the CSV and Excel disagreed. | Output of the old generator on realistic rows. |
| 8 | A silent default period ("آخر شهر" / "آخر ٣ شهور") filtered social results, so every comment on an older video was excluded and the job ended as "nothing matched". | Code path in the chat handler; test with no period given. |
| 9 | Questions borrowed another question's choices: the link and country questions were offered "حتى ٢٥ سجلاً", and the account-name question was offered platform buttons. | Raw output of the question normalizer before and after. |
| 10 | The public calculator priced from the provider cost while the quote writer priced from the customer rate (5 vs 9 points for a YouTube comment). | Test of both functions over every social service. |

## 3. What was changed

- A verified source table (`src/lib/socialSources.ts`): for each task, an ordered list of sources, chosen by the catalog's measured success rate and speed, with the exact parameter names the catalog declares. A failed, slow or unrecognized answer falls through to the next source. TikTok trending has no region-less fallback on purpose (it would answer a different question).
- Six capabilities served from code until the registry has a row for them (a disabled row is a kill switch): comments and videos for TikTok and YouTube, comments and page posts for Facebook.
- Request understanding in Egyptian and standard Arabic (`src/lib/socialTasks.ts`) and a server-side gate that asks only what is missing, one question at a time: the link (or a subject), the country for TikTok trending, the channel. Facebook trending is said plainly to be unavailable, with the two platforms that have it.
- The server rebuilds the link, channel, subject and country from the customer's words and writes the plan card's goal line itself; the model supplies only the count. Dates apply only when the customer wrote a period.
- "Videos and their comments" is one job in two stages inside the worker: the videos are found once, comments are collected video by video, and where the job stands travels in the chunk cursor. A video that cannot be read is skipped; if nothing is readable and nothing was delivered, the full reserve is released with the provider reason; rows delivered earlier are never discarded by a late failure.
- One reader for every answer shape (`src/lib/server/providerRows.ts`), per-call time limit, a time budget per chunk, a provider-spend estimate that covers a chunk's worst case, and de-duplication of comments across pages and chunks (repeated comments are neither delivered nor billed).
- Results: one fixed Arabic schema for comments and for videos, readable dates, counts as numbers, one sheet, CSV and Excel identical, no raw provider columns, no English in any header.
- The model's fixed rules now describe the social services and their limits. The model string was not touched (`claude-haiku-5-5`, the one the database records for every turn).

## 4. Tests and measurements

- Full suite: 1163 tests in 132 files, all passing; `tsc` clean (1034 before this work, so 129 new tests: social tasks, sources, adapter, plans, worker integration, outputs, job spec, calculator parity, prompt rules, result reader).
- Contract test: every endpoint id, HTTP method and parameter name used by a source is checked against a fixture captured from the provider's public catalog on 2026-10-17 (`tests/fixtures/treg-social-catalog.json`), including required parameters, and the first source of each task must be at 97% measured success or better. One exception is stated in the test, not hidden: the YouTube trending feed has one measured source at 94.3% (about 9 s) and one unmeasured fallback.
- Worker integration: the real worker route runs a comments job end to end with only the provider call faked: delivery, per-comment charge, Arabic files, cross-chunk de-duplication, release on provider failure, release on a valid empty answer.

## 5. NOT RUN (needs a live provider call or a browser)

- No live call to any source was made: this environment has no provider token and no real spend was allowed. The real answer shapes of the sources are therefore proven only against the documented columns and the readers' tolerance, not against a real answer. The one-shot check `scripts/verify/verify-social-live.ts` exists for this: ten tiny checks, typically about USD 0.03 in total, run by the owner with `--confirm-spend`. It prints counts and column names only.
- No browser run of the chat, the plan card, the requests page or a downloaded file on the Preview (it is behind the host's sign-in, and no test account was provided).
- Real latency and success rates of the new sources as the customer would see them.
- Instagram, X, Reddit and LinkedIn were not changed.

## 6. Decisions only the owner can make

1. Price per comment. The rule prices a delivered row at the provider's price of one call. The sources return 20 to 500 comments per call, so the real cost per comment is a small fraction of a point, while the customer price is 6 points (TikTok), 9 (YouTube) and 11 (Facebook). With the 600-point job cap a customer gets at most: 100 TikTok comments, 66 YouTube comments, 54 Facebook comments (100 videos, 120 YouTube videos, 54 Facebook posts), whatever the quote shows. A researcher who needs thousands of comments cannot buy them at these rates or cap. Options: a per-comment rate derived from the real cost per row (minimum 1 point), a higher job cap for these services, or both. Nothing was changed.
2. The settlement cap. A quote above 600 points shows the full amount but settlement charges at most 600 (`LEAST(delivered x unit price, reserve, cap)`), so a 100-comment YouTube job shows 900 points and is charged 600. Decide whether quotes should be limited to the cap so the card matches the charge.
3. Reliability over price. TikTok keyword videos and TikTok comments use the source with 99.99% / 99.97% measured success, which costs about twice the cheapest source. The order of sources is one table.
4. Registry rows. The six services work without a registry row; adding a row with `enabled = false` switches one off. The old disabled rows with ids that do not exist should be deleted or corrected.

## 7. Risks, stated plainly

- The sources were chosen from the provider's own measurements; none was called from here.
- The "videos with comments" job makes up to six provider calls per chunk; a slow source can make a chunk end early and the job continues in the next chunk. Long jobs take several chunks (about 15 seconds of overhead per chunk was measured on the existing worker).
- The trending feed of TikTok depends on one source; if it fails the job is released in full.
- Facebook comments depend on a source the catalog verified on 2026-07-28 but has no success statistics for.
- Customer text that the model writes freely (greetings, explanations) is not covered by these tests; the plan card, the questions and the files are written by the server.
- The 600-point cap and the per-call pricing basis (section 6) limit what a researcher can buy regardless of how well the sources work.
