# Pre-rollout acceptance: Diger Intelligence (round 48)

**Baseline:** main `4cb55cb` (after #458). The six PRs in scope (#453–#458) are merged. The open PRs (#440, #439, #438, #425, #346 and older) touch none of these paths.

**Switches:** `chat_research_brief_v1`, `capability_discovery_v1` and `semantic_normalization_v1` are OFF (no `agent_settings` rows). Nothing in this round turns them on.

**Not used in this round:** live Anthropic, TREG, Firecrawl or Context.dev calls; production data; money.

## Verdict

**READY FOR A CONTROLLED TEST-ACCOUNT ROLLOUT.** This means only:

* the two switches scoped to named test `user_ids` (the SQL in `docs/AGENT-UNDERSTANDING-V1.md`);
* the owner's approval;
* a defined spending cap for the real model and provider calls a test account makes.

**Not** general production readiness.

**Why:** every customer journey reaches a safe, honest outcome offline, through the real code. Three customer-facing defects found by this round are fixed with regression tests (below). The financial invariants hold.

**What it does not prove:**

* what the real model writes (this is exactly what a test-account rollout is for);
* live provider data;
* the full chat page in a browser;
* the deployed worker's revision.

## Defects found and fixed in this round

| # | Defect (customer-facing) | Root cause | Fix | Proof |
|---|---|---|---|---|
| 1 | **False refusal in English**: «What are people saying about phone number leaks» was refused as private data. Four more English phrasings were refused or asked; the Arabic equivalents passed. | The English public-content list in `guardRules.ts` lacked the opinion verbs that #456 added for Arabic. | English parity («saying», «talking», «think», «discussing», «writing»…). This only REMOVES refusals. | `pre-rollout-acceptance` §4: 27 legitimate requests, Arabic and English. |
| 2 | **Privacy gap in English**: «emails of users who commented», «home addresses of reviewers», «personal emails of instagram followers» passed every code guard. The guard, the brief check and mission creation share one rule set, which knew only phone and WhatsApp words in English. | Missing English forms of the existing Arabic rule. | Narrow parity: personal e-mails; e-mails or addresses OF private people (users, followers, commenters, reviewers…); home addresses. Business e-mails and office addresses of companies still pass. | §4: 17 private requests blocked; the legitimate business-contact requests pass. |
| 3 | **A delivered part was prepared again.** After a part completed, a later turn of the same conversation (a «كمّل», a correction of another part, a repetition) re-created it as a new priced card saying «بنجهّز خطته وسعره». The customer was invited to pay again for data they had. | `LIVE_STATUSES` listed `delivered` and `partial`, which the worker never writes. It lacked `completed` and `unserved`, which it does write. | The real statuses. A finished part is kept and said «اتنفّذ قبل كده ونتيجته في بطاقته». | §6b: fails on the old code, passes with the fix (`completed` and `unserved`). |
| 4 | **Stale duplicate cards in a discovery conversation.** When the model labels each follow-up a NEW request, every answer left the older, still-queued version live: three unapproved cards for one request. | The new-request path replaces only `plan_ready`/`needs_input`. | In the SAME brief conversation, a follow-up while the request is still being prepared goes through the existing update path: withdrawn while queued (compare-and-set). Once the worker has it, the customer is told plainly. | §5: one live mission at the end, whatever the label. |

## Evidence

### A. Verified by code review

* **Path traced:** chat → one model call → brief → validation → discovery → mission → worker plan → approval → execution → settlement.
* **What executes:** only the request sentence executes (`request_text` → `buildAsk`); the brief's phrases are checked against it (#458).
* **Before approval:** approval is only the card's button (`approveMissionOnce`); a typed «موافق» is answered, never acted on.
* **Integrity anchor:** create-only, worker-written (#455). A missing or replaced record blocks execution, and the hold is released.
* **Pricing:** computed by code. The model never sets a price, a balance, a hold, an approval, a credential or an endpoint.
* **Customer surface:** Arabic-only by design (`guardReply`/`checkCustomerText`). An English reply from the model is dropped (see "Observations").

### B. Verified by offline automated tests

**New file, `tests/pre-rollout-acceptance.test.ts` (80 tests).** Every outcome below is classified by what was stored, never by wording.

**§3: the 14 requests and their outcomes**

| Request | Outcome | Notes |
|---|---|---|
| B «٥٠٠ كومنت سامسونج تيك توك» | UNDERSTOOD | the 500 is carried |
| C «شركات سياحة القاهرة ومواقعهم» | UNDERSTOOD | |
| D «فنادق الغردقة آخر شهر» | UNDERSTOOD | exact sentence kept |
| G «أخبار شركات الاتصالات» | UNDERSTOOD | |
| K «سرقة الهوية والاحتيال» | UNDERSTOOD | |
| M «موبايلات سامسونج على تيك توك» | UNDERSTOOD | not read as phone numbers |
| A, E, F, H, I, N | NEEDS CLARIFICATION | the model's question (platform, kind of data, which company) |
| J «تسريب أرقام التليفونات» | NEEDS CLARIFICATION | which platform; never refused |
| L «جروبات واتساب للسياحة» | NEEDS CLARIFICATION | the code asks before the model: the public content about the groups, never their messages or members' numbers |
| English, mixed («300 comment عن iPhone 17 من TikTok») and voice-transcription spellings («تك توك», «الفيس», «اسكندريه», «فى») | UNDERSTOOD | |
| the English leak question | NEEDS CLARIFICATION | |

None of these was refused or failed; nothing was held, executed or fetched.

**§4: false refusals and private data.**

* 27 legitimate requests are never refused.
* 17 private requests are blocked.
* A private ask hidden behind a public topic is still caught.

**§5: the discovery conversation** («داتا عن السياحة» → «تعليقات من تيك توك» → «آخر شهر» → «٥٠٠ تعليق والردود كمان»).

* The brief is carried into every prompt.
* The end state is exactly one live mission. It has topic, platform, period (the same Cairo window), 500 and replies.
* The replaced versions are withdrawn unrun.
* «موافق» approves nothing.
* A request the worker is already planning is not stopped, and the customer is told.
* An invented «آخر سنة» is asked, never executed.

**§6: the mission's multi-objective request** (300 comments, 200 hotels in Hurghada, the news).

* One model call creates three missions on three cards.
* Each card has its own exact count and place.
* Nothing is held, and a repetition creates nothing.
* §6b: a delivered or unserved part is never prepared again.

**§7: flag combinations.** Whatever the chat validator accepts, the worker executes the same window, country and language with `semantic_normalization_v1` both OFF and ON. Where the two readers disagree («آخر ٣٠ يوم» against «آخر شهر», «الأسبوع اللي فات», «من أول أكتوبر», «السنة دي»), the chat asks. No unsafe mismatch was found in the corpus.

**Earlier rounds' files, re-run in the full suite:**

* **`exact-intent-across-parts` (17):**
  * last month ≠ last year;
  * Egypt ≠ Saudi Arabia;
  * Hurghada ≠ Cairo;
  * Arabic ≠ English;
  * 100 ≠ 1,000;
  * replies kept;
  * global and one-part conditions;
  * a correction updates only its part;
  * unfamiliar wording is never refused.
* **`multi-objective-reliability` (22):**
  * failed, partial and lost card writes;
  * a retry;
  * concurrent duplicates;
  * 8 parts within the 3-planning and 5-waiting limits;
  * reload consistency.
* **`multi-objective-research` (38):** the real chat → worker planning → the customer's own approval → execution → settlement replays. They cover a full delivery (201 rows, Excel), a partial one (151 rows, only delivered rows charged), a restart with no row twice, a drifted part never becoming a mission, and the TREG news fallback when the web allowance is spent.
* **`llm-first-objectives` (28):**
  * the provider inputs match the catalog schemas;
  * a capability outside a stage's candidates is rejected;
  * a removed or replaced selection record means no provider call, nothing charged, hold released.
* **`unified-capability-discovery`:** provider eligibility (key, allowance, policy), ranking by coverage before price, honest limitations.
* **Money:** `agent-price-and-settlement`, `engine-settlement`, `ledger`, `financial-audit-truncation`, `explicit-quote-approval`, `launch-e2e-approval-journey`, `decision-makers-dispatch-race`.
* **Delivery:**
  * Excel: `excel-quality`, `excel-qa-fixes`;
  * CSV: `customer-no-csv`;
  * methodology PDF: `customer-methodology`, `methodology-*`.

**Gates (this round):**

* full `npm test`: 951 files, 13,103 passed, 0 failed (48 expected fail and 65 skipped, both unchanged from before this round: no new regression);
* root and worker typechecks;
* `npm run build` and its client-bundle secret scan.

### C. Verified in a real browser: partial

* **Setup:**
  * real Chromium (Playwright);
  * the REAL card component (`AgentMissionCardBody`) and the page's REAL card functions (`chatCards.ts`);
  * the production-compiled CSS;
  * a mocked conversation: three priced part cards, a partial card, a failed card.
* **Viewports:** desktop 1280×900 and iPhone 13.
* **Results: 28 of 28 checks pass.**
  * 5 cards, none duplicated;
  * the summary draws no card;
  * an «اعتمد» button on each of the 3 priced plans only;
  * each card shows its own price in Arabic digits;
  * approving card 2 acts on mission 2 only;
  * no horizontal scroll on the phone;
  * the partial card says «تم تسليم ١٥٠ من ٢٠٠» and «خُصم ١٥٠ نقطة»;
  * the failed card says the points were returned;
  * a repeated answer appends nothing;
  * a reload shows the same cards on the same missions;
  * no page error.
* **Where it lives:** the harness ran from a scratch directory and is not committed, because the project has no browser runner in CI.
* **NOT covered:** the full chat page, its sign-in, its API calls, its loading and error states, and the composer.

### D. Verified against live providers

**None.** No live TREG, Firecrawl, Context.dev or Anthropic call was made.

### E. Not verified

* **Real Anthropic output:**
  * how often its briefs, objectives, part sentences and per-part conditions validate;
  * whether it labels follow-ups as edits;
  * whether it asks in Arabic;
  * its real token use against the 700 ceiling (truncation handling is tested offline).
* **Live providers:** real answers, real pagination, real timeouts, real allowance exhaustion.
* **The full chat page** in a browser.
* **The deployed worker's revision:** the heartbeat reports `version: dev`.

## Observations (not defects; reported for the rollout)

* **A model question can be skipped.** When the trusted parser already reads a complete social request (platform, topic, comments), the code prepares the mission instead of the model's question about the period or count. The card shows scope and price before anything is held, and a later answer replaces the unapproved version. Deliberate since round 22.
* **English replies.** A model reply in English is dropped by the Arabic-only reply guard. The turn then falls back to a mission from the customer's own words, and the worker asks what is missing on the card. A faithful model asks in Arabic.
* **Unreadable period phrases.** A period phrase no reader understands is carried verbatim and not compared by value.

## Rollout checklist (owner)

1. Approve a test-account rollout and a maximum spend.
2. Turn the two switches on for named test `user_ids` only.
3. Run the 14 requests, the discovery conversation and the multi-objective request with the real model, and record each outcome.
4. Keep `semantic_normalization_v1` OFF.
