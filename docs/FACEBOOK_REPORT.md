# Facebook topic report (`facebook-topic-report`)

One capability, one item per quote, unit = **delivered comment**. A customer asks for a topic, a country, a period and a size (posts, and comments per post); the platform delivers an Excel workbook (data only) and a separate Arabic methodology PDF.

Basis labels used below: **M** measured (the owner's own run of 24 Oct 2026: 406 calls, 305 posts, 1,753 comments, 0.9619 USD), **C** catalog price, **A** assumed, **T** proven by an automated test with FAKE sources. Nothing here was run against a live provider.

## The gate: unavailable until the owner reviews a Page

The capability is **off** until at least one registry Page is `ownerReviewed: true` with `status: "ok"` (`FACEBOOK_REPORT_ENABLED` in `src/lib/facebookReport/registry.ts`; all entries are false today, so it ships off). With the gate off the capability does not exist for the rest of the platform: it is not in `SOCIAL_CAPABILITIES` (so not in the calculator, the catalog seeds, the plans or the worker), «تقرير / تحليل / رصد» are not a report request and not content words, and every request behaves as it did before this work (checked against main's own answers for seven requests; test: `tests/facebook-report-gate.test.ts`). Turning it on is **one line**: set `ownerReviewed: true` on a usable Page. Note for the owner: once on, every `ok` Page is browsed, reviewed or not; review all of them before flipping (a single reviewed Page would make that Page the whole report, and the report would say so).

## How a request becomes a job

1. **Routing.** The word «تقرير» (or «تحليل», «رصد») with Facebook and a topic is a report; the same request without it stays the existing keyword service (`social-facebook-keyword-comments`, untouched). (T)
2. **Questions, in this order, and never guessed:** country (only Egypt has vetted Pages today), period, number of posts, comments per post. A country or topic with no usable Page gets one Arabic message and no plan. No default period is proposed for a report. (T)
3. **Plan.** One item; unit price 3.025 points a comment from the one `RECORD_COSTS` entry; charge `ceil(delivered x 3.025)`, reserve `ceil(volume x 3.025 x 1.15)`; outputs `xlsx` + `pdf`. Ceilings are the Facebook ones: 300 posts, 1,500 comments (`src/lib/facebookCeilings.ts`, unchanged). 300 x 5 = 1,500 comments: charge 4,538, reserve 5,219. 100 x 20 is cut to the 1,500 ceiling (75 posts) and the plan says so. (T)
4. **Capacity gate.** The existing `checkPlanProviderCapacity` with the report's cost basis: 1,500 comments estimate 0.825 USD and need a safe budget (0.9 x min(real balance, remaining daily cap, user cap)) above it, i.e. about 0.917 USD of balance. Otherwise one Arabic refusal sentence, nothing quoted or held. (T)
5. **No «sample first» offer** for the report (`sampleOffer` returns null for this slug): a 65-comment sample would be a different report and its remainder could not be told from a second report.

## The collector (`src/lib/server/facebookReportAdapter.ts`)

Chunked and resumable through the existing worker route; the state between chunks is one stored file per chunk (`fbreport_state_<step>.json`, small unique cursor), deleted when the job settles.

- **Browse.** The registry Pages of the request's country and topic area are browsed **round-robin** (2 post pages of a Page per round, never one Page to exhaustion). Each Page is validated by its first call: «not found», no posts (a personal profile) or a refusing source skip the Page, which is counted and reported, never retried in a loop. (T)
- **Exact window.** The period is whole UTC days, inclusive at both ends (`classifyRowsByDate`); a post whose date cannot be read is not kept and is counted as undated; posts come newest first, so a Page stops at its first post older than the window. The owner's file held 35 of 305 posts outside the window it claimed; the 305-post reference fixture is a test. (T)
- **Per-publisher cap 20%.** No publisher supplies more than 20% of the delivered posts (the owner's file had one Page at 74%). With fewer than 5 usable Pages an exact 20% is impossible (4 equal Pages are 25% each), so the share is raised to an equal split and the report says so; with the 5 seeded Pages the feasible post counts are multiples of 5. (T)
- **Dedupe** by post link/id across Pages and the search supplement.
- **Keyword search is only a small supplement:** at most 4 calls, 2 per chunk, 15% of the posts, 0.27 USD, and each result must name the country in its own text. (T)
- **Comments.** Posts are read highest engagement first (a post in the top 20% by engagement or with at least 30 comments: up to 3 pages of 10; the rest 1 page); a stall guard ends a post whose pages repeat. **Comments are never judged.** Only an empty comment, an exact duplicate (same id, or same author and text under the same post) and a link-only comment are removed, each counted. (T)
- **Axes.** Each post is placed on a health axis by rules first (word match with Arabic prefixes/endings, weighted; «قلب» is not counted near heartburn words; digestive posts have their own axis). Posts the rules cannot settle go to the model in **one call per 50 posts** (reply: numbers only), inside a budget of 20% of the job's revenue; beyond the budget (or on a failed call) a post is «موضوعات صحية عامة» and flagged in the data. The model never sees a comment and never decides or states money. (T with a fake model; real model behaviour NOT PROVEN)
- **Shortfall.** One Arabic sentence built from the real counts (Pages browsed and skipped, posts found and outside the window, comments the source did not return, and that only what was delivered is charged). (T)
- **Money.** The settlement is the existing `settle_job_atomic` path; the worker test applies charge = `ceil(delivered x unit)` capped at the hold. No SQL, no money table is touched by this work.

## Preview fake mode

The preview pressure-test provider (`fakeProviderActive`, never the live site) now also serves the report: the REAL collector runs on a deterministic fake Page and comments source (`src/lib/server/fakeFacebookSource.ts`, zero cost; the keyword search answers «not served»). The worker test runs a whole job on it. No provider is called.

## The files

- **Excel (data only):** «الموجز الإحصائي» (counts, axis table, top 10 posts, publisher concentration, covered period), «المنشورات», «التعليقات»; Arabic headers, right-to-left, frozen header row, filters, real numeric and date cells, working hyperlinks, sheet names within 31 characters, formula-looking text stored as text. No internal id, provider name or methodology text. (T: read back from the real workbook)
- **PDF (methodology and analysis, Arabic RTL):** scope and covered period, counts, axis table, publisher concentration, conclusions as **templates over the real counts** (an interpretation the numbers do not prove is labelled «اجتهاد (غير مقاس)»), and limits (what the sample is and is not). Built from the saved record at download time and by the existing 10-point methodology add-on (same file for the report; the add-on flow is unchanged). (T: generation and structure; the visual layout was inspected on a rendered page)
- Customers never see provider names, endpoint ids, USD, internal ids, English text, markdown symbols or emoji. (T on the plan, the shortfall sentence, the workbook and the PDF text helpers)

### Arabic-Indic digits in the workbook

Cells use `#,##0` and `0.0%`. An Arabic-Indic display format was tried **only in LibreOffice here**: `[$-2010401]#,##0` renders ١٬٢٣٤٬٥٦٧ in a LibreOffice PDF export, `[$-2000000]#,##0` and `[NatNum1]#,##0` do not. It was **not verified in Excel or Google Sheets**, and the rule is to change nothing unless all three work. Options for the owner: (a) keep Western digits in cells (today; text in the report is Arabic-Indic); (b) adopt `[$-2010401]` after checking one file in Excel and Google Sheets; (c) store a second text column. Nothing was changed.

## Period replacement: root cause and where else it can happen

«آخر ٣ شهور» became «آخر شهر» because of two defects:
1. `isStandaloneResearchRequest` read the per-item phrase («٢٠ تعليق لكل منشور») as the whole request being a bare per-item instruction and discarded the earlier period of the same sentence; and number words («ثلاثة شهور») were not parsed as periods. Both are fixed in `src/functions/shared/requestScope.ts` and `src/lib/timeWindow.ts` and affect every capability that reads a period (tests: G2a scenario, number words, `facebook-report-chat.test.ts`).
2. Found while testing the question-by-question flow: the written-count fallback of `understandMission` (`src/lib/consultantCopy.ts`) could read the period's number as the number of records («آخر ٣ شهور» became a 3-comment plan). The period span is now removed before that fallback runs. This defect existed for the other social requests too (a request that states its period before the noun).

Where else it can still happen (NOT fixed, not in scope): any new request phrase that the shared readers do not know can still be read as a bare answer; the period readers cover digits, number words, «شهرين/أسبوعين», and the usual cue words, not every dialect phrasing.

## NOT PROVEN

- Any live provider behaviour: the three sources were driven only by FAKE sources shaped like the owner's run; response shapes, cursors and prices in production are unverified.
- The real model's axis placement (a fake model in tests); the 20%-of-revenue model budget at real token costs.
- The cost per comment under the new mix (round-robin, 20% cap, small search share): the price is built on the dearer of the owner's measured all-in figure and a blended expectation; nothing has measured the new mix.
- Excel and Google Sheets rendering of the workbook (checked structurally with exceljs and in LibreOffice only), Arabic-Indic cell formats (above).
- That the seeded Pages are the right ones and still public (the owner has reviewed none: `docs/FACEBOOK_REPORT_PAGES.md`).
- Behaviour with five or more of the seeded Pages answering at production latency within the 40-second chunk budget.
