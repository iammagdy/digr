# Diger intelligence layer: final acceptance (round 51)

**Baseline:** main `c0a5c27` (PR #461). Vercel production was READY on that SHA when this round started (deployment `dpl_4YpoTgfm3EkmUVKCWSpuxFSGG98T`).
**Model:** `claude-haiku-5-5`, the repository default for the chat and the worker planner.
**Authorization:** real Anthropic testing with the dedicated evaluation key. The owner raised the cumulative evaluation ceiling from $10 to **$30** during this round. The earlier mission's reported $4.2746 counts inside it, so this round's budget state was created with a ceiling of **$25.7254**.
**Not changed:** production flags, database, schema, SQL, pricing, auth, deployment settings. No live provider call and no customer execution.

## 1. Results at a glance

| | Previous mission (final, 61 conv.) | Round 1 | Round 2 | Round 3 | Round 4 (all but the last fix) |
|---|---|---|---|---|---|
| All conversations accepted | 60/61 (98.4%) | 88/95 (92.6%) | 96/97 (99.0%) | **97/97 (100%)** | 96/97 (99.0%) |
| Original 22 (labels unchanged) | 21/22 | 21/22 | 22/22 | **22/22** | 21/22 (M2, fixed after) |
| Expanded 39 | 39/39 | 39/39 | 38/39 | **39/39** | 39/39 |
| Held-out 34–36 (new, labelled before any run) | – | 28/34 | 36/36 | **36/36** | 36/36 |
| Capability selection (labelled cases) | – | 16/16 | 19/19 | **19/19** | 19/19 |
| False privacy refusals | 0 | 1 (Z28, a label error: section 5) | 0 | **0** | 1 (M2, a real defect, fixed) |
| Lost customer requirements | 0 | 1 (Z19, a real bug) | 0 | **0** | 0 |
| Duplicate live missions | 0 | 0 | 0 | **0** | 0 |
| Provider or model names shown to the customer | 0 | 0 | 0 | **0** | 0 |
| Missions executed, jobs, credit rows | 0 | 0 | 0 | **0** | 0 |

**Over rounds 2–4 (the code after the round-1 fixes)**, 289 of 291 conversations were accepted (**99.3%**). The two misses are M5 (round 2) and M2 (round 4). Each was traced to its root cause and fixed with a regression test.

* **The M2 fix (the last change)** was re-measured on the 20 sensitive-topic and private-data conversations, three times: 60/60 accepted, 0 false refusals, every private request refused.

| Real planner, synthetic provider data | R1 | R2 | R3 | P4 | P5 | **R4 (final planner code)** |
|---|---|---|---|---|---|---|
| Valid plans (`plan_ready`) | 18/27 (67%) | 25/33 (76%) | 23/32 (72%) | 24/31 (77%) | 25/31 (80.6%) | **26/31 (83.9%)** |
| Planner asked the customer | 4 | 3 | 3 | 5 | 4 | 1 |
| Ended «not served» | 1 | 3 | 2 | 1 | 0 | 0 |
| Our own failure (admin flagged) | 4 | 2 | 4 | 1 | 2 | 4 |
| Plans that combine two provider families | 0 | 3 | 5 | 2 | 7 | **9** |
| Stages on Context.dev sources | 0 | 7 | 5 | 2 | 15 | **9** |

**Reading the planner figures.**

* **The final planner code (R4)** produced valid plans for **26 of 31** missions (**83.9%**).
  * 1 non-plan was a question caused by the synthetic data: several fictional apps named «إنستاباي».
  * 4 were our own failures: J3, G2, Z16 and Z35, after formal plan refusals. Each is now admin flagged and told to the customer as OUR failure, never as «not available».
* **The strict figure is the acceptance figure.** The **90% target is NOT met**. Without the one data-driven question the rate is 26/30 = 86.7%, still below.
* **Measured over the last two planner runs on the final planner code** (P5 and R4): 51/62 valid plans (82.3%). The failures change from run to run (planner variability). Section 7 lists them.

**Spending.**

* **2,920 paid requests**, all HTTP 200.
* **$6.3030** this mission; **$10.5776** in total with the previous mission's $4.2746, out of the owner's **$30**.
* Exact figures are in section 4.

## 1b. Stability of the critical conversations (repeated real runs)

**The 37 critical conversations:**

* every multi-part request;
* every correction (period, quantity, city, district, platform, country, language, added and removed parts);
* «كمّل»;
* the sensitive public research M1, M2, M3, M6;
* the mixed public + private requests N7 and Z26;
* private data Z24 and Z25;
* prompt injection Z29;
* own-business clarification D2 and Z6;
* app reviews Z30, Z35 and Z36.

They ran three more times, chat only, on code after round 3:

| Run | Accepted | Lost requirements | Duplicates | False refusals | Paid requests | USD |
|---|---|---|---|---|---|---|
| Stability A | **37/37** | 0 | 0 | 0 | 53 | $0.0471 |
| Stability B | 36/37 | 1 (Z9: a judge error, plus a REAL reader gap it revealed, fixed) | 0 | 0 | 53 | $0.0471 |
| Stability C (final code but the M2 fix) | 36/37 | 0 | 0 | 0 | 53 | $0.0470 |

* **B, Z9.** The model wrote the corrected count as «مائة».
  * The worker reads it as 100, so nothing was lost, but the judge read digits only.
  * Looking closer showed that **«ثلاثمائة» was read by no reader at all**, so a spelled count of 300–900 would have been lost.
  * Fixed: the hundreds, formal and dialect, are now numbers. The judge also reads number words.
* **C, Z36.** The model attributed the news part's «مصر» to the app-reviews part. The code ASKED whether that place applies to the app part instead of dropping or applying it: safe, though not the label. Z36 passed in round 4.
* **The sensitive and privacy subset** (20 conversations) ran three more times on the final code: **60/60**.


## 2. What changed (each from a real-model or real-planner failure, each with a deterministic regression test)

**Where each change applies.**

* **Behind the two switches (OFF in production), the chat-turn changes:**
  * the own-business question;
  * the open question asked;
  * «كمّل»;
  * the apps vocabulary for the model.
* **For EVERY customer now (no switch):**
  * the period reader (`ask.ts`, `requestConditions.ts`; the worker plans from it on every path, the compiled social path included);
  * the spelled hundreds;
  * the two privacy-rule changes;
  * the planner's refusal messages, schema descriptions and prompt sentence;
  * the places-phone and app-entity planning rules;
  * the `treg_call` redirect;
  * the give-up classification.

Each of these changes makes the system execute what the customer asked, or refuse more precisely. None widens what is collected, and the full suite passes with them.

Tests: `tests/intelligence-final-acceptance.test.ts` (chat layer, 60) and `tests/planner-reliability.test.ts` (planner, 10): 70 tests. Two fixes were also mutation-checked: the places-phone rule and the app relevance rule (each test fails with its fix removed).

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


## 3. Provider catalogs actually inspected

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

## 4. Real Anthropic spending (this mission)

**The budget state.**

* **The previous state file was not in this container.** The previous session's transcript was not reachable, so the reported $4.2746 could not be independently verified.
  * Paid calls were held until the owner raised the authorization to **$30** during this mission.
  * The $4.2746 was then counted inside it: a new state file was created once with a ceiling of **$25.7254**.
* **Every attempt** was reserved at its worst case on disk before it was sent, and settled at its actual cost after.
* **Only `api.anthropic.com` could be reached.** No provider, Supabase or other host could.

| Run | What | Paid requests | USD | Cumulative (this mission) |
|---|---|---|---|---|
| smoke | D2, 1 conversation | 1 | $0.0008 | $0.0008 |
| R1 | 95 conversations + real planner | 463 | $1.0052 | $1.0060 |
| R2 | 97 + planner | 535 | $1.2096 | $2.2155 |
| R3 | 97 + planner | 520 | $1.1453 | $3.3608 |
| P4 | 27 planner conversations | 384 | $0.9203 | $4.2811 |
| P5 | 27 planner conversations | 373 | $0.8771 | $5.1582 |
| Stability A, B | 37 + 37 critical, chat only | 106 | $0.0942 | $5.2524 |
| R4 | 97 + planner | 458 | $0.9804 | $6.2328 |
| Stability C | 37 critical, chat only | 53 | $0.0470 | $6.2799 |
| Privacy ×3 | 20 sensitive and private, three times | 27 | $0.0231 | **$6.3030** |

* **Total this mission:** **2,920 paid requests**, all HTTP 200, **$6.3030**. No halt, no truncation.
* **With the previous mission:** **$10.5776** of the owner's **$30**.

**The evaluation key.**

* Its VALUE is in 0 of 6,078 files: the repository, the build output and every evaluation transcript and ledger.
* It is in 0 lines of the 146 MB git history.
* It was never printed.
* **It is still ACTIVE.** This session has no tool that can revoke an Anthropic key, so revocation is the owner's to do in the Anthropic console.

## 5. Corpus and label changes (disclosed)

**The corpus.**

* **Original 22:** labels unchanged.
* **Expanded 39:** labels unchanged.
* **Held-out 36:** written before their first run; Z35 and Z36 were added with the apps capability.

**Label changes after a run**, each written in `cases.ts` where it is made:

| Case | Change | Why |
|---|---|---|
| Z28 «هات رسائل جروبات تليجرام» | from «legitimate, unsupported» to «private chats» | The existing privacy rule refuses the messages of chat groups by design. The label was wrong. |
| Z30 «تقييمات تطبيق إنستاباي» | from unsupported to understood | Apps and their reviews became a served operation during the mission. |

**Judge changes:**

* «كمّل» on a single request counts as understood (`continue_open_*`), as for multi-part requests;
* a count written in words counts as the number.

## 6. Gates (head of PR #462)

| Gate | Result |
|---|---|
| Full `npm test` | 956 files passed, 5 skipped. **13,278 passed**, 0 failed, 47 expected-fail, 65 skipped. Before: 13,208 passed and 48 expected-fail; dt-08 moved from expected-fail to an ordinary test. |
| Root typecheck, worker typecheck | pass |
| `npm run build` and the client-bundle secret scan | pass; 209 files, zero secrets |
| Privacy and money suites | 8 files, 280 tests, pass, unchanged in count: `private-data-guards`, `pre-rollout-acceptance`, `agent-understanding-privacy`, `agent-price-and-settlement`, `engine-settlement`, `ledger`, `explicit-quote-approval`, `financial-audit-truncation` |
| New tests | `intelligence-final-acceptance` (60) and `planner-reliability` (10): 70 |

**Test files whose assertions changed**, each for a deliberate behaviour change and each asserting more, not less:

* **`round16-previous-month`:** «الشهر الحالي» is now asserted as the current month. It was asserted as unread, and it is still never the previous month.
* **The semantic baseline pins** (`semantic-paraphrases`, `semantic-conditions`, `semantic-contract-integration`, `semantic-normalization`): dt-08 is closed for every customer (47 known gaps remain, 15 closed). pl-23's English period is no longer a gap; its «tweets is not X» gap stays.
* **No validator was loosened**, and no test was skipped or deleted.

## 7. Remaining defects and what is not proven

1. **The real planner is at 82–84% valid plans, not 90%.** The remaining failures change from run to run:
   * a planner that does not map a field the plan promises (city, sector);
   * one that plans app reviews without their app stage;
   * one that keeps a people stage on a contact source without marking its contact columns.

   Each now ends as OUR failure (admin flagged, the customer told so), never as «not available». The validators were not weakened to raise the rate.
2. **Model attribution of a condition to the wrong part** (Z36, 1 in 4 runs): the part is asked, never mis-planned.
3. **«ألف» (1,000) written in words is not read as a count**, because it is also a word of names. A count of 1,000 written in words would be asked or carried as words.
4. **The synthetic providers are fiction.** The planner's figures are its behaviour on plausible fictional rows: they are not proof of the plan on real TREG, Firecrawl or Context.dev answers.
5. **Not exercised by this mission:**
   * live providers;
   * the authenticated chat page in a browser (no test account session or isolated environment was authorized; the flags must stay off);
   * the deployed Heroku worker (its heartbeat has reported `version: dev` in earlier rounds, and this session has no Heroku access);
   * production's `ANTHROPIC_MODEL` and `planning_model` values;
   * `semantic_normalization_v1` ON.

## 8. Delivery and deployment

The PR, its merge SHA and the Vercel production deployment are recorded in `docs/HANDOFF.md` (round 51).

Heroku: not verifiable from this session.

## 9. Readiness recommendation

**The chat intelligence layer is ready for a CONTROLLED TEST-ACCOUNT rollout:**

* `chat_research_brief_v1` and `capability_discovery_v1` scoped to named test `user_ids`;
* a spending cap;
* `semantic_normalization_v1` kept OFF.

On real Anthropic responses it reached:

* 97/97 conversations in round 3, and 289/291 over rounds 2–4;
* 0 lost requirements, 0 duplicate missions and 0 leaks in every round;
* 0 false refusals in rounds 2 and 3;
* no private-data request accepted in any run.

**It is NOT general-production ready.**

* **The real planner** is below its 90% target on synthetic data and is unproven on real provider answers.
* **The browser journey and the deployed worker** were not exercised.

The next step is the owner's test-account rollout with real providers, watching the planner's admin-flagged failures.
