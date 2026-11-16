# Platform check, 16 Nov 2026: every data family, every provider, the whole order delivered

**Owner's ask.** Confirm on production that:
- a customer's request is understood and served for **any** data family the providers sell, not only social media;
- the AI layer chooses the right provider;
- the customer receives the whole file;
- provider names never reach the customer.

**Spend cap.** Up to $10 of model spend and the test account.

**Main after this round:** `9811a52` (#542). Worker: Heroku v249.

This page also records the live-sheet redesign shipped earlier the same day (#533–#535).

---

## 1. How it was checked

### Real-model planner evaluation
- **Runner:** `agent/scripts/evalPlanner.ts`. It runs on a one-off worker dyno, so the model key never leaves Heroku.
- **What it calls:** `understandRequest` and `chooseTools`, the same code the worker runs. It makes no provider call.
- **Initial corpus:** 38 requests:
  - Maps places and reviews;
  - Amazon, eBay and TikTok Shop;
  - Google Play and App Store reviews;
  - TripAdvisor, Trustpilot, Yelp and Glassdoor;
  - news, Google results and SEO keywords;
  - LinkedIn jobs, stocks and crypto;
  - IMDb, GitHub, Spotify, Telegram, Pinterest, Hacker News and the Meta ad library;
  - Egyptian real-estate listings and website traffic, both expected "cannot";
  - a vague request, a private request, and social controls.
- **Re-runs:** after each fix, on the affected cases.

### Live missions on diger.tech
- **Account:** the test account. The login credentials were stored only in a private scratch folder and deleted after use.
- **Driver:** a headless browser that:
  - sends the request;
  - answers the planner's question when there is one;
  - approves within a point cap;
  - downloads every file;
  - opens the Excel file.

### Leak scan
Every delivered Excel, CSV and methodology file, every card text, every `plan_public`, and every customer-visible event was scanned for provider and model names. The result was **0 hits in 62 files and cards**, and 0 in the database.

### Spend
- Model spend for the evaluation was about $2.6.
- The live missions used about $1.2 of model and provider spend in total.
- Points: about 3,000 test-account points over 20 missions.

---

## 2. Results

| Family | Planner choice (real model) | Live delivery |
|---|---|---|
| Google Maps places | `google.serp.maps` | 40/40 Maadi restaurants; 30/30 Nasr City pharmacies; 30/30 Zamalek restaurants |
| Reviews of a named place | lookup → `google.maps.reviews` by place id | 50/50 reviews of «كشري أبو طارق» |
| Google Play reviews | lookup → reviews by package id | 100/100 InstaPay; after #538, the right app |
| Amazon products | `amazon.search.products` | 50/50 |
| Amazon reviews of a named product | lookup → reviews by ASIN | the source holds about 10 → the customer is asked → «سلّمني الموجود» → 10/10 |
| News | Google News and web news tools across engines | 30/30 gold prices; 20/20 AI in Saudi Arabia (it was 15 before #540) |
| Articles | web and Google news | 40/40 |
| Real estate (Egypt), website traffic | honest «cannot» | — |
| Private data (a person's WhatsApp) | refused | — |

---

## 3. Defects found and fixed

### #537: the planner and the files serve every data family

**1. An Amazon request ended in a social-only question.**
- What happened:
  - The only Amazon reviews tool timed out three times.
  - The plan then held only the non-delivered lookup step, and pricing threw «a mission delivers at least one row».
  - The worker fell to the legacy path, which asked «من أي منصة؟ تيك توك / إكس…».
- Fix: a plan with no delivered step ends `no_step_served`, which tells the customer honestly.

**2. Reviews of a named place, app or product had no id.**
- Fix: the understanding prompt now makes a lookup step first, then a child step that reads by the item's id.

**3. Async task tools were offered.**
- These are 212 submit-then-poll endpoints, and the worker has no poller. One was TripAdvisor's only option.
- Fix: `catalogView.isAsyncTask` excludes them.

**4. Tools without a capability name were invisible.**
- Fix: `<platform>.other` tools whose id names the items are now offered when a capability has few tools.

**5. Unrequested filters.**
- Fix: no star, rating, category or price filter unless the customer asked.

**6. One field appeared in two columns.**
- A place's rating was also shown as «الإعجابات», and its review count as «عدد التعليقات».
- Fix: `withoutTwinPaths`.

**7. Post marks on non-post rows.**
- «رد أم أصلي» and the other post marks appeared on places and products.
- Fix: `rawMarks.markColumnsOf` keeps them for posts, comments and videos, or when the request set that condition. Delivery contract R4 is kept.

**8. The card said «الطالب يريد…».**
- Fix: a prompt rule plus `impersonalAr`.

**9. The chat prompt said «we serve five platforms».**
- Fix: it now lists every family.

### #538

**1. Wrong app delivered.**
- What happened:
  - «InstaPay» delivered 100 Fawry reviews, because the lookup took the first search result.
- Fix:
  - `pickNamedItem` makes one model call to pick the result that *is* the named thing, or asks for the link.
  - `bindLookups` binds the child to that value and drops the lookup stage, so execution never searches again.

**2. A news card read «خرائط جوجل».**
- Fix: `platformAr(platform, capability)` decides the label from the capability.

**3. «١٠٠ تقييمًا» and «١٠٩ عنصرًا».**
- Fix: `countAr` follows the last two digits from 100 up.

### #539: the file button said the planned total

- What happened: the button showed the planned total and a column count capped at six.
- Fix: `fileRowsAr` gives the delivered count.

### #540: our own web search and every engine for news

**1. Cross-engine candidates.**
- A news search was planned on two web news tools. One answered 402 eight times; the other gave 5 per call.
- Fix: a web or news search now also gets the other engines' tools of the same kind (`SEARCH_ENGINE_PLATFORMS`).

**2. Our own keys (Firecrawl, Context.dev).**
- Their tools are now catalog-shaped entries (`directWebEndpoints`), offered when the worker has the key.
- They are proven on the step's own phrases as the **last fallback** when the catalog's sample is short.
- Execution reads them through the `SourceGateway`. It is now created for a plan that names a direct web tool, even with `multi_stage_engine` off. That is the one exception, and it is pinned in `tests/phase5-*.test.ts`.

**3. Unpaid or forbidden tools.**
- A 401, 402 or 403 while planning leaves that tool at once.

**4. Shortfall question threshold.**
- A shortfall below 90% of the number is asked before the plan (`SCOUT_SHORT_SHARE`). It was 50%.

**5. The small-sample note.**
- It promises more searching only when other phrases or tools exist.

### #541

- What happened: the items of one found thing (the reviews of the product the lookup found) were not measured, because only top-level steps were.
- Fix: they are measured now, so the shortfall question fires.

### #542

- What happened: after «سلّمني الموجود», the plan still read «هتستلم ٢٠».
- Fix: the plan now targets what was found, and says so.

---

## 4. Providers: how they are chosen, and what the customer sees

**Catalog tools.**
- All catalog tools go through the TREG gateway.
- The planning model sees the whole catalog except media generation, async task tools, blocked or paused providers, and tools the account's data policy refuses.
- Code ranks the candidates by proven-in-production status, measured success, and price.
- The model picks up to 3 options and writes their inputs.
- Code probes one real page per step and prices from it.

**Direct web search.**
- Context.dev and Firecrawl use our own encrypted keys.
- They are offered for web and news searches, and proven as the last fallback.

**What the customer sees.**
- The customer reads the **platform** («خرائط جوجل», «أمازون», «مواقع الأخبار», «الويب»), never a provider or model name.
- Every customer sentence passes `checkCustomerText`.
- The methodology names the kind of source (`sourceLabelAr`): for example «البحث في صفحات الويب».

---

## 5. Known limits and open items

**Amazon reviews**
- The main tool `crawl4ai.amazon.product.reviews` answered 504 on every call on 16 Nov.
- The fallback `justoneapi…top-reviews` gives the top 10 only, with no paging.
- The customer is now asked first, but more than about 10 reviews of one product is not available today.

**Failing tools seen on 16 Nov**
- `exa.web.search.news` answered 402 every time. Its account at the provider is likely out of credit.
- `apify.google.serp.maps` failed once.
- Worth raising with TREG.

**Not yet seen live**
- Firecrawl and Context.dev were never used in a live mission on 16 Nov, because the catalog's news tools were enough.
- They are covered by tests: a scripted end-to-end plan, plus dispatch and engine-call checks.

**GitHub**
- The catalog has no repository search. «repos about arabic nlp» plans GitHub trending.

**Price of an accepted shortfall (open owner decision)**
- Accepting 10 reviews was charged the 200-point minimum.
- An unasked partial delivery of 10 was charged 142.

**Web search as a fallback**
- It is used only for search-engine platforms: web, Google, Bing and the like. It never stands in for reviews, posts or products of a named site.

---

## 6. The live sheet redesign (#533–#535, same day)

See `docs/STAGE-2.md` for the sheet itself.

**#533: the Claude Design handoff**
- Desktop: an Excel-like grid with follow mode, a «نتائج جديدة ↓» chip, virtualised rows and a side panel.
- Phone: a card with the newest three rows and a bottom sheet.
- Each row fades in one at a time.
- The route answers the newest rows: `tail=1`, and «unchanged» for any window.

**#534**
- The sheet asks at once when the card knows rows were saved. The first rows used to lag about 20 s behind; now about 2 s.

**#535**
- The card's counter never goes back while the live snapshot lags the card's own events.
