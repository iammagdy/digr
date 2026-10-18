# Social source catalog audit

Checked 2026-10-18 against unauthenticated `GET https://treg.to/catalog/platforms/x` and `GET https://treg.to/catalog/endpoints/{endpoint-id}` pages. The comparison/use-case page is https://treg.to/use-cases/search-posts-by-keyword. Performance is the catalog's rolling real-traffic observation, not a controlled benchmark. Prices and metrics can move; values below are the public response observed during this audit.

## X/Twitter keyword and account searches

| Endpoint | Request input | Published price | Observed success | Median / p95 | Customer X session? | Notes |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `anyapi.x.search.posts` | POST JSON: `query` required; `limit` 1–50, `cursor`, `queryType` optional | $0.00075/call | 99.99% (891,820 samples; 879,517 decided) | 1,615 / 2,715 ms | No | Advanced keyword search; bare terms are ANDed. |
| `tikhub.x.twitter-web-fetch-search-timeline` | GET: `keyword` required; `search_type`, `cursor` optional | $0.001/call | 99.99% (245,587 samples; 229,687 decided) | 2,385 / 3,671 ms | No | Keyword search; this is the fallback. |
| `justoneapi.x.twitter-search-v1` | GET: `keyword` required; `searchType`, `cursor` optional | $0.01476/call | 99.94% (13,197 samples; 13,192 decided) | 2,990 / 4,801 ms | No | Keyword search; much more expensive. |
| `crawl4ai.x.search.posts` | POST JSON: `query` required; `mode`, `limit` optional | $0.00065/call (0.65 credits) | 99.81% (774 samples; 535 decided) | 20,830 / 76,332 ms | **Required for topic search** | Without `auth_token` + `ct0` session cookies, only `from:<account>` in latest mode (optionally `since:`/`until:`) is permitted. Other searches are refused free. Excluded from both topic and account source routes. |
| `x.x.search-posts-recent` | GET: `query` required; `max_results`, pagination tokens and time/id filters optional | $0.005 per returned post | 98.98% (317 samples; 293 decided) | 172 / 373 ms | No customer session; official developer access is needed | Official recent search; limited to the last seven days. The public page says it uses the caller's X developer account and is charged per result. |
| `x.x.search-posts-all` | GET: `query` required; `max_results`, pagination tokens and time/id filters optional | $0.005 per returned post | 100% (23 samples; 23 decided) | 442 / 1,300 ms | No customer session; official developer access is needed | Official full-archive search; small sample, so the observed 100% is not comparable to larger samples. |
| `treg.x.search.posts` | POST JSON: `q` identity input | Routed child price $0.00075–$0.01476/call | 83.64% (143,127 samples; 143,126 decided) | Not published | No customer session for the listed scraper children | Routed aggregate; 0% markup, but reliability is lower than the direct AnyAPI/TikHub options. |

**Recommended topic route:** `anyapi.x.search.posts`, then `tikhub.x.twitter-web-fetch-search-timeline`. Both accept a keyword without a customer's X login. In the published observations they tie at 99.99% success; AnyAPI is cheaper and its median is 770 ms faster. This replaces the failed Crawl4AI topic route.

**Recommended account route:** `anyapi.x.user.posts` first; `crawl4ai.x.user.posts` as fallback. The first accepts a required handle and is $0.0005/call, 99.95% success (149,408 samples; 149,162 decided), median 1,656 ms/p95 2,538 ms. TikHub's `tikhub.x.user.posts` is a reliability-first alternative at $0.001/call (catalog observed 99.99%, median 1,853 ms); ScrapeCreators `scrapecreators.x.user.posts` is $0.00188/call (99.99%, median 3,318 ms). Crawl4AI `crawl4ai.x.user.posts` is $0.00045/call, 99.69% (766 samples; 649 decided), median 10,717 ms/p95 53,398 ms; its login cookies are explicitly **optional**, and it falls back to visitor access. For a handle-only request without a handle, Diger asks one short question for the account name or link.

Public X references:

- [X platform catalog](https://treg.to/catalog/platforms/x)
- [AnyAPI keyword endpoint](https://treg.to/catalog/endpoints/anyapi.x.search.posts)
- [TikHub keyword endpoint](https://treg.to/catalog/endpoints/tikhub.x.twitter-web-fetch-search-timeline)
- [Crawl4AI search endpoint and its session restriction](https://treg.to/catalog/endpoints/crawl4ai.x.search.posts)
- [AnyAPI account timeline](https://treg.to/catalog/endpoints/anyapi.x.user.posts)
- [Crawl4AI account timeline and optional session](https://treg.to/catalog/endpoints/crawl4ai.x.user.posts)
- [Keyword-search comparison and per-result/per-call explanation](https://treg.to/use-cases/search-posts-by-keyword)

## Other sources currently declared in `src/lib/socialSources.ts`

These are the exact source endpoints used by the app, including fallbacks. Catalog pages for these say the content is public; none requires the customer's login/session to make the declared public request. Two pages document an **optional** session that can expose more rows; Diger does not send customer session data.

| Task | Endpoint | Catalog request inputs declared by Diger | Session/access note |
| --- | --- | --- | --- |
| TikTok comments | `tikhub.tiktok.video.comments` | `aweme_id` required; `cursor`, `count`, `current_region` optional | Public video comments; no customer session required. |
| TikTok comments | `crawl4ai.tiktok.video.comments` | `post` required; `limit` optional | Public post comments; no customer session required. |
| YouTube comments | `crawl4ai.youtube.video.comments` | `video` required; `limit` optional | Public video comments; no customer session required. |
| YouTube comments | `tikhub.youtube.video.comments` | `video_id` required; language/country/sort/continuation/format optional | Public video comments; no customer session required. |
| Facebook comments | `scrapecreators.x.v1-facebook-post-comments` | `url`, `feedback_id`, `cursor` optional in catalog schema | Public post/reel comments; no customer session required. |
| Facebook comments | `treg.facebook.post.comments` | `post_id`, `url` optional in catalog schema | Public post comments; no customer session required. |
| TikTok keyword videos | `tikhub.tiktok.search.videos` | `keyword` required; count/offset/sort/time/region optional | Public keyword search; no customer session required. |
| TikTok keyword videos | `anyapi.tiktok.search.videos` | `query` required; cursor/date/sort optional | Public keyword search; no customer session required. |
| TikTok account videos | `anyapi.tiktok.user.videos` | `handle` required; cursor optional | Requires a public account handle as the query target, not a customer session. |
| TikTok account videos | `crawl4ai.tiktok.user.videos` | `account` required; limit optional | Requires a public account handle as the query target, not a customer session. |
| TikTok trending | `scrapecreators.x.v1-tiktok-get-trending-feed` | `region` required; `trim` optional | Public regional trending feed; no customer session required. |
| YouTube keyword videos | `crawl4ai.youtube.search.videos` | `query` required; `limit` optional | Public keyword search; no customer session required. |
| YouTube keyword videos | `tikhub.youtube.search.videos` | `keyword` required; continuation/type/upload/duration/features/sort optional | Public keyword search; no customer session required. |
| YouTube channel videos | `crawl4ai.youtube.channel.videos` | `channel` required; `limit` optional | Requires a channel reference as the query target, not a customer session. |
| YouTube channel videos | `tikhub.youtube.channel.videos` | `channel_id` required; language/country/continuation/format optional | Requires a channel ID as the query target, not a customer session. |
| YouTube trending Shorts | `scrapecreators.x.v1-youtube-shorts-trending` | No input parameters | Public trending feed; no customer session required. |
| YouTube trending Shorts | `anyapi.youtube.trending_shorts` | No input parameters | Public trending feed; no customer session required. |
| Facebook page posts | `anyapi.facebook.user.posts` | `url`, `pageId`, `cursor` optional in catalog schema | Public page; no customer session required. |
| Facebook page posts | `scrapecreators.x.v1-facebook-profile-posts` | `url`, `pageId`, `cursor` optional in catalog schema | Public profile/page posts; no customer session required. |
| Facebook page posts | `crawl4ai.facebook.user.posts` | `page` required; `limit` optional | Public initial page works without login. A Facebook session is explicitly optional and may reveal more posts; Diger does not provide one. |
| X topic posts | `anyapi.x.search.posts` | `query` required; `limit`, `cursor`, `queryType` optional | Public keyword search; no customer session required. |
| X topic posts | `tikhub.x.twitter-web-fetch-search-timeline` | `keyword` required; `search_type`, `cursor` optional | Public keyword search; no customer session required. |
| X account posts | `anyapi.x.user.posts` | `handle` required; `limit`, `cursor` optional | Requires a public account handle as the query target, not a customer session. |
| X account posts | `crawl4ai.x.user.posts` | `username` required; `limit` optional | Public visitor path works without login; X login cookies are explicitly optional. Diger does not provide them. |

`crawl4ai.x.search.posts` is intentionally absent from the registered sources: it is the exception whose catalog permits broad topic queries only when the caller supplies an X login session. Its no-session path is account-scoped (`from:<account>`), which is incompatible with an ordinary topic request.

## Test contract

`tests/social-sources.test.ts` compares every code-declared endpoint's method, full input-name set, required input set, price, request-builder parameter subset, and session metadata to `tests/fixtures/treg-social-catalog.json`. It also asserts no registered source requires a customer session. The fixture is a checked-in snapshot of public catalog responses; update it only from another unauthenticated catalog read.
