# Diger intelligence layer: final acceptance (round 51)

**Baseline:** main `c0a5c27` (PR #461). Vercel production was READY on that SHA when this round started (deployment `dpl_4YpoTgfm3EkmUVKCWSpuxFSGG98T`).
**Model:** `claude-haiku-5-5`, the repository default for the chat and the worker planner.
**Authorization:** real Anthropic testing with the dedicated evaluation key. The owner raised the cumulative evaluation ceiling from $10 to **$30** during this round. The earlier mission's reported $4.2746 counts inside it, so this round's budget state was created with a ceiling of **$25.7254**.
**Not changed:** production flags, database, schema, SQL, pricing, auth, deployment settings. No live provider call and no customer execution.

## 0. Results at a glance

| | Previous mission (final, 61 conv.) | Round 1 (this mission) | Round 2 | **Round 3 (final chat code)** |
|---|---|---|---|---|
| All conversations accepted | 60/61 (98.4%) | 88/95 (92.6%) | 96/97 (99.0%) | **97/97 (100%)** |
| Original 22 (labels unchanged) | 21/22 | 21/22 | 22/22 | **22/22** |
| Expanded 39 | 39/39 | 39/39 | 38/39 | **39/39** |
| Held-out 34–36 (new, labelled before any run) | – | 28/34 | 36/36 | **36/36** |
| Capability selection (labelled cases) | – | 16/16 | 19/19 | **19/19** |
| False privacy refusals | 0 | 1 (a label error, see 4.3) | 0 | **0** |
| Lost customer requirements | 0 | 1 (Z19, a real bug) | 0 | **0** |
| Duplicate live missions | 0 | 0 | 0 | **0** |
| Provider or model names shown to the customer | 0 | 0 | 0 | **0** |
| Missions executed, jobs, credit rows | 0 | 0 | 0 | **0** |

| Real planner, synthetic provider data | R1 | R2 | R3 | P4 | **P5 (final planner code)** |
|---|---|---|---|---|---|
| Valid plans (`plan_ready`) | 18/27 (67%) | 25/33 (76%) | 23/32 (72%) | 24/31 (77%) | **25/31 (80.6%)** |
| Planner asked the customer | 4 | 3 | 3 | 5 | 4 |
| Ended «not served» | 1 | 3 | 2 | 1 | 0 |
| Our own failure (admin flagged) | 4 | 2 | 4 | 1 | 2 |
| Plans that combine two provider families | 0 | 3 | 5 | 2 | **7** |
| Stages on Context.dev sources | 0 | 7 | 5 | 2 | **15** |

**Reading the planner figures.** In P5, 4 of the 6 non-plans were the planner ASKING the customer because the synthetic rows were ambiguous or did not fit the request:

* several apps called «إنستاباي»;
* companies outside the asked sector;
* «which pharma companies?».

The other 2 (J3, Z35) were our own failures, admin flagged and told to the customer as ours.

* **Strictly**, valid plans are 25/31 = **80.6%**: below the 90% target.
* **Without the 4 data-driven questions** (the «provider data contradicts the request» class the brief asks to report apart), they are 25/27 = 92.6%.

Both figures are given. The strict one is the acceptance figure, and the 90% target is **not met** on it.

**Spending.**

* **2,276 paid requests**, all HTTP 200, plus the two stability passes in section 6.
* **$5.16** this mission before the stability passes (exact figures in section 7).

<!--STABILITY-->

## 2. What changed (each from a real-model or real-planner failure, each with a deterministic regression test)

Tests: `tests/intelligence-final-acceptance.test.ts` (chat layer) and `tests/planner-reliability.test.ts` (planner), 59 tests. Every fix was mutation-checked (the test fails with the fix removed) where the fix is a single line.

### 2.1 Clarification in the chat (defect A, D2)

* **«محتاج معلومات عن منافسين شركتي»**: the model marked it `needs_clarification` with no question, a mission was created, and the worker asked on the card.
  * **Root cause:** the request refers to the customer's OWN business, which nobody can search for.
  * **Fix (`selfReference.ts`):** a request about «شركتي / البراند بتاعنا / مطعمي / صفحتي / my company» that nothing in the conversation identifies is asked IN THE CHAT. The question is one natural one: «إيه اسم شركتك ونشاطها، وبتشتغلوا في أنهي مدينة أو سوق؟».
  * **Where it applies:** the single path, every part of a multi-part request, and an empty model brief.
  * **Words deliberately not read as self-reference:** «منتجي الأفلام» (producers), «قطاع فندقي» (hotel sector), «متوسط حسابي» (arithmetic mean).
* **An open question is not split into sources the customer never named** (M5, real round 2). «What do people think about mental health apps?» became two missions the model chose: app reviews and web pages. A new request whose words name no kind of data is now asked which source fits.
* **«كمّل» continues the conversation whatever type the model gives it** (J1, Z12, real round 1). The model read it as small talk and asked «طلب جديد ولا تعديل؟». Now:
  * the prepared parts are kept and said;
  * a request still being planned is said to be in progress;
  * a ready plan points to its «اعتمد» button.

  Nothing is approved by typing.

### 2.2 Customer requirements actually executed (a real lost requirement)

**«خلال الأسبوع الماضي» was never applied.** The request contract marked it as a period the customer asked for, but the worker's period reader (`periodOfRequest`) gave it no value, so the planner ran without the customer's period. Real round 1 caught it (Z19).

| Phrase (period reader, flag off) | Value now |
|---|---|
| «الأسبوع الماضي / اللي فات / ده» | the last 7 days, as «آخر أسبوع» |
| «السنة / العام الماضي / اللي فاتت» | the previous calendar year |
| «الشهر ده / الحالي» | from the 1st of the month |
| «السنة دي / هذا العام» | from 1 January |
| English «(the) last / past N days, weeks, months, years», «last 24 hours», «this week / month / year» | the same windows |

The same applies to:

* **«Find news … from the last month»** (Z17): it had been asked «a period you never wrote» (a false clarification).
* **The semantic reader** (flag ON) now reads «الأسبوع اللي فات» as its own «آخر أسبوع», so the two readers agree.
* **The pinned gap dt-08** («السنة اللي فاتت») is closed for every customer, and its history is kept as `closed_gap`.

### 2.3 Privacy

**«العنوان الشخصي لمذيعة مشهورة»** was refused only by the model (Z25). It is now refused by code before any model call, as «عنوان السكن / البيت» already was. «عناوين فروع شركة» stays allowed.

### 2.4 Capabilities across the three providers (the owner's instruction during this mission)

* **The planner is told which tool calls each provider's capability** (`toolHint`):
  * Context.dev parsers → `parse_page`;
  * web search / scrape → `web_search` / `web_scrape` with `provider`;
  * the people search → `people_search`.

  A `treg_call` on such an id is refused with the right tool named. Before this, the real planner called parser ids with `treg_call`, was refused, and fell back to TREG every time: **0 cross-provider plans in round 1, 7 in P5.**
* **Apps and their reviews** (`apps.discover` → `apps.reviews`, new). TREG has Google Play and App Store searches and reviews; Context.dev has both stores' review parsers. None of them was reachable, so «تقييمات تطبيق إنستاباي» could only be refused. The chain now uses any of them:
  * a store named → that store;
  * none named → both;
  * «تطبيق» alone counts only with reviews, because «تطبيق القانون» is news;
  * the English «apps» counts only with reviews too.
* **List-wrapped catalog outputs** (`items: [...]`, Google Play) are proven on the sample, like object wrappers, instead of being rejected for missing fields.
* **An app found by a store search is an entity named by its title**, so its relevance is read as a company's. Before, every app was «mention_only».

### 2.5 Planner reliability (defects B and C), validators unchanged

* **A give-up after FORMAL plan refusals is ours, never «مصادرنا لا تخدم هذا الطلب».**
  * When the sources returned rows and the last `propose_plan` refusal was about the plan's form, the ending is classed `internal` (`plan_invalid_after_N_rejections`): admin flagged, and the customer is told it was our failure.
  * A refusal because no sampled row matched the request (`data`) keeps the honest «not served».
* **Refusals say why:**
  * the `yield_from` / sample-row refusal says what the cited output holds (an object with its keys, an empty array, a call id);
  * an untitled unknown column says to give `title_ar`;
  * a missing-inputs refusal names the inputs;
  * `deliver` is explained.
* **The `assumptions_ar` schema example promised a language** («تغريدات عربية»), which the validator then refused unless the stage had a language filter. The example no longer teaches the refused pattern.
* **The planning prompt states the exact `yield_from` shape:** a bare array returned by `run_code`.
* **A places request's phones are the listing phone the place stage delivers.** The planner was told to add a company contact stage for «مطاعم … وأرقام تليفوناتها». E-mails still need a contact stage.

### 2.6 Evaluation harness (no product effect)

* The owner's **$30** authorization, enforced as **$25.7254** for this mission (the previous mission's $4.2746 counted inside it).
* **36 held-out cases**, a capability-selection score, and provider-family reporting for each planned stage.
* **Synthetic Firecrawl page reads** and synthetic Context.dev e-mail / phone / app-review parsers.
* **Synthetic rows that follow the query's place, country and sector.** Rows placed in Cairo for a Sharm El-Sheikh search were rightly refused by the planner.
* **The planner's refusal reasons are recorded.** Before, 46 refused calls had been logged as `{}`.


## 1. Provider catalogs actually inspected

Everything below was read from the repository's own files. Nothing was fetched, and no provider was called.

**TREG snapshot** (`data/treg/treg_catalog_sellable.json`, loaded by `src/lib/treg/catalog.ts` `loadTregCatalog`)

* 3,276 sellable endpoints. Own-account (652), write (29) and paused (12) endpoints were already removed when the snapshot was built.
* The data policy (`data/treg/data_policy.json`) classifies them as:
  * 2,993 public;
  * 231 b2b_contact;
  * 50 sensitive;
  * 278 blocked.
* After the block list and the customer policy, **3,224** are allowed for a normal customer and 3,274 for an admin or verified business.

**Context.dev** (`src/lib/agentMission/sources.ts`)

* 20 pre-built parsers.
* Before this round, 8 of them served an operation. Two more now do: the Google Play and App Store review parsers (see section 3).
* Also a web search, a page scrape and a people search.

**Firecrawl** (`sources.ts`): a web search and a page scrape.

**The registry** (`src/lib/agentMission/capabilities/registry.ts`) maps all of these to one vocabulary of operations. The mapping is by capability string, not by name, and private-data capability strings are never mapped.

| Operation | Produces | Parent | Provider families that serve it |
|---|---|---|---|
| social.parents | posts, videos, tweets | none | TREG (5 platforms), Context.dev (TikTok, Instagram feeds) |
| social.comments | comments | social.parents | TREG (5 platforms), Context.dev (TikTok, Instagram) |
| social.replies | replies | social.comments | TREG (TikTok, Instagram, Facebook, YouTube). On X a reply is the comment. |
| companies.discover | companies | none | TREG, Context.dev (maps) |
| company.contacts | official work e-mail or phone | companies.discover | TREG, Context.dev (e-mails, phone numbers) |
| places.discover | places | none | TREG (maps, Tripadvisor, Yelp, Apple Maps, Bing), Context.dev (maps) |
| places.reviews | reviews | places.discover | TREG, Context.dev (maps reviews) |
| web.search | articles, news, pages | none | TREG, Firecrawl, Context.dev |
| web.read | page text | web.search | TREG, Firecrawl, Context.dev |
| people.discover | professional profiles | none or companies | TREG, Context.dev |
| **apps.discover** (new) | mobile apps in a store | none | TREG (Google Play and App Store searches) |
| **apps.reviews** (new) | app reviews | apps.discover | TREG (store reviews), Context.dev (store review parsers) |

**Which path plans what**

* **The compiled social path (code, no model)** plans every `social.*` operation on all five platforms (`agent/src/compiled.ts`, `foundation/compilePlan.ts`). A social plan proposed by the model is refused.
* **The model planner (`runPlanning` → `propose_plan`)** plans companies, contacts, places, reviews, web, people and now apps. With `capability_discovery_v1` on, each stage may only use the capabilities code validated for it. They are listed to the planner ranked by ability, then price, across all three provider families (`plannerCapabilitySection`).

**How selections are validated**

* **Chat side.**
  * `parseBrief` rejects an unknown operation or field.
  * `validateBrief` / `objectivesIssue` check structure, parent chain, platform grounding and that nothing was dropped.
  * `capabilityGate` answers an unsupported or partial request honestly, with no mission.
* **Worker side.**
  * The registry is rebuilt with the account's real access, provider keys and caps.
  * `propose_plan` refuses any id that is not a validated candidate for its own stage (`planStageIssues`).
  * At execution, `verifyApprovedScope` refuses added stages, swapped capabilities or changed parameters.

**Documented but not served**

* 10 Context.dev parsers still serve no operation: app details, G2 reviews, TikTok and Instagram profiles, followers and following, user search, links.
* Catalog endpoints for Reddit (52), Telegram (9) and Snapchat (3) map to no operation. Such requests are answered as unavailable.
