# P0, 15 Nov 2026 (second retest): three off-topic tweets sold as the research result

Mission `msn_cd5f32adadefb9bb971f`, job `job_quote_db59f56139e5862c064ba41d6bb57090` (test account). All evidence below was read **read-only** from production (`missions`, `mission_calls`, `mission_events`, `credit_ledger`, `messages`). Regression fixture: `tests/fixtures/p0-x-account/production-2026-11-15-cd5f.json`. Tests: `tests/p0-research-relevance-cd5f.test.ts`.

## 1. What the customer asked

«أنا محتاجة 400 تغريدة من حساب وزارة الصحة السعودية عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات خلال آخر 5 سنين. ولو العدد المتاح أقل من 400 مفيش مشكلة، **بس لازم التغريدات تكون فعلًا من حساب الوزارة وعن الموضوع ده**.»

The last sentence makes relevance a hard requirement. Fewer than 400 is acceptable; off-topic is not.

## 2. What the system did (recorded)

| Step | Recorded fact |
|---|---|
| Source | Asked before pricing; answered `SaudiMOH`. The source rule from PR #499 worked. |
| Query | `(الشائعات OR "التصدي للشائعات" OR "جهود الوزارة في مكافحة الشائعات") from:SaudiMOH since:2021-11-14_22:00:00_UTC until:2026-11-15_22:00:00_UTC -filter:replies`. The OR group from PR #501 worked. |
| Call 1 | 3 rows, all from @SaudiMOH, with a cursor. |
| Call 2 | The cursor: 0 rows (`empty`). |
| Call 3 | **The same empty cursor page, read and paid for again** after the customer's answer (the reuse of recorded pages served only `ok` pages). |
| The 3 rows | A respiratory virus «من الفيروسات التنفسية **الشائعة**»; «أخطاء **شائعة** عند علاج الإدمان»; «ملف الأسئلة **الشائعة**». In each, «شائعة» means *common*, not *rumor*. |
| Question | «لم نجد … ما يتحدث نصها عن …» with the options **«أكمل بما وجدتموه كما هو، مع علامة على كل عنصر»**, change, cancel. The operator chose the first. |
| Plan | **3 tweets** (`planned_rows = 3`, promise `exact 3`), reserve 200, unit price **66.67 points a tweet** (the 200-point mission minimum spread over 3; the rule's own unit was 24.04). The notes said both «كل عنصر مختار يذكر واحدًا منها على الأقل في نصه» / «كلها تطابق شروطك» **and** «ما اخترناه لا يذكر الموضوع في نصه». «القراءة مكتملة ضمن ما يتيحه هذا المصدر» was stated from one page of 3 rows. |
| Execution | **0 provider calls.** The engine replayed the 3 pinned planning rows (`runPinnedRows`, raw mode, no relevance rule). |
| File | Topic column: «يتحدث نصه عن الموضوع: 0», «لا يذكر الموضوع: 3». |
| Outcome | `completed`, 3 delivered. Ledger: reserve −200, release +200, **charge −200**. |
| Internal cost | 3 search calls, USD 0.00147, plus planning model USD 0.00037. |

## 3. Root causes (each proven in code; each alone reproduces the failure)

### R1. Relevance was a label, never a gate

* Compiled plans (X, TikTok, Facebook, Instagram, YouTube, the production path for social since `redesign_flags`) **never attached a `relevance` rule to their stages**. The engine and item store already have a full relevance gate (`relevance.ts`, `items/ingest.ts`, model review in `review.ts`, pending/excluded, never delivered or charged), but it was not applied to these plans.
* The topic relation was only a column («علاقة النص بالموضوع»).
* The pinned-row replay ran in raw mode, which skips every relevance rule.
* The planning offered the customer to **buy** rows it had itself classed as not about the topic (`useAsIs`, `allowUnrelated`, NOV 6 2026).
* Settlement charges the file's count, so whatever reached the file was charged.

### R2. A word is not a meaning

* The only topic check at planning was lexical (`topicTierOf`).
* It happened to class these 3 rows correctly, but a word rule cannot be the research standard:
  * «شائعة» is both *rumor* and *common*;
  * a post about countering rumors may say «استقاء المعلومات من مصادرها الرسمية» without the word;
  * the provider matches forms the code does not.

### R3. The planning sample sized the plan

* `compilePlan` set `planned_rows = chosen.length` and promised `exact` that number. That is at most the rows of the two planning sample pages.
* So **400 requested became 3 sold**.
* Three consequences:
  * the minimum charge was spread over 3 rows (66.67/tweet);
  * the pinned rows equalled the volume, so execution read nothing;
  * the customer view compared 3 delivered with 3 «requested» and showed **done**, not partial.
* The 14 Nov missions show the same: the 400 count was reached only when the customer edited the card.

### R4. Recall was never attempted

* The precise wording gave 3 rows.
* The second planning sample (and a third, paid, after the answer) went to that query's empty next page.
* PR #501's relaxed strategy triggers only when the first page is **empty**, not when it is short or off-topic.
* No other way of saying the topic was ever searched: «شائعات», «إشاعات», «معلومات مغلوطة», «أخبار كاذبة»…

### Not the cause

* The source and the OR syntax (both worked).
* Settlement arithmetic: correct for what it was given.
* The source rule of PR #499: correct.

### Why previous fixes did not solve it

PRs #499 and #501 fixed **retrieval inputs**: the source and the query syntax. Every downstream assumption stayed in place:

* a returned row is a result;
* the sample is the quantity;
* a technically completed run is a fulfilled request.

## 4. The change (general: no topic, account, platform or word list)

| # | Change | Where |
|---|---|---|
| 1 | A research topic (any topic except one the items are made *with*) gets an **execution gate** on every compiled parent stage: `relevance.judge = "model"`. Every row with text is judged by the existing model review against the customer's own request. A row judged no is excluded (`review_no`); a row not judged (budget, model failure, no key) stays pending or excluded. **Never delivered, never charged.** | `relevance.ts` (`judge`), `compilePlan.ts` (`researchRelevanceOf`) |
| 2 | The pinned-row replay keeps a model-judged rule. The planning sample is re-judged at execution, and execution is the authority. | `items/ingest.ts` |
| 3 | Accepted rows carry the verdict in the file's topic column («يتحدث نصه عن الموضوع»). Before, fresh rows had an empty mark and pinned rows had a word-based mark. | `items/ingest.ts` |
| 4 | **Planning judgment**: the rows read at planning are judged by the same review (`planningJudge`, an in-memory reviewer, cap USD 0.01, cost added to the planning model cost). The verdict decides eligibility, ranking and the card's counts. A row judged about the request is eligible even without the customer's words. With no model, the word rule applies as before. | `agent/src/researchJudge.ts`, `compiled.ts`, `compilePlan.ts` (`judged`) |
| 5 | **The option to buy unrelated rows is removed.** The no-relevant-rows question offers «سأعدّل طلبي» or «ألغِ المهمة»; the former answer changes nothing. | `compiled.ts` |
| 6 | **The sample never sizes the plan.** A parent-only plan is sized by the customer's number (promise `open`) whenever the executed query did **not** reach its end at planning. The pinned rows are then fewer than the volume, so the engine reads the source afresh, page after page, through the gate, until the number is reached or the source ends. When the query **did** end, the plan is sized by what exists, and `plan.quantity` keeps the customer's number. A delivery is then **partial** in the customer view, the notice and the result sentence. | `compilePlan.ts`, `compiled.ts` (`poolExhausted`) |
| 7 | **Recall**: when the precise query's first page is short (fewer rows than a page), the second planning sample goes to an **expanded query**: the customer's alternatives plus model-proposed variants of the topic, cleaned by code (no operators, quotes or accounts; ≤ 4 words; ≤ 10 variants), with every hard condition kept (`from:`, the period, originals only). The plan then executes the expanded query. Every row is still judged. Still at most two planning samples. | `researchJudge.ts` (`topicVariants`, `cleanVariants`), `compilePlan.ts` (`expandedInputsOf`) |
| 8 | Honest card: one sentence on what decides a result (meaning, judged on every row). The sample note says what was read, what was relevant, that a sample does not size the source, and that only delivered rows are charged, never above the hold. The contradictory notes are gone. The no-plan sentence counts «تتحدث فعلًا عن الموضوع» when judged. | `compilePlan.ts`, `searchScope.ts` |
| 9 | A recorded **empty** planning page is reused, not paid for again. | `compiled.ts` |
| 10 | **The plan's own selection rules hold at execution.** Every stage of a compiled plan is delivered in raw mode (`redesign.ts`), and raw ingest **skipped every filter** and only wrote marks. Top-level rows are now rejected (kept with their reason, never delivered or charged) when they fail the exact named account, the period, or, on X, the originals-only rule. These are the rules the planner chose rows by. This was a **pre-existing** hole: it is how `msn_dd7c…` delivered 79 tweets of 38 other accounts after its count was raised. Reading on (#6) would have widened it, and an independent review of this change found it. | `items/ingest.ts` |
| 11 | **Bounded reading.** A research read stops after `JUDGED_DRY_PAGES = 5` consecutive pages that add no accepted row. The customer sentence is the existing `page_limit` one. | `engine/run.ts` |
| 12 | The topic variants are asked **once per mission** and kept (`planning_variants.json`). A later planning run builds the same expanded query and reuses its recorded page, instead of paying again or hitting the two-sample cap. | `compiled.ts` |
| 13 | **Truthful sentences.** The no-relevant-rows question says «لا يتحدث عن الموضوع، وإن تشابهت بعض كلماته» when the judgment decided. A plan with comments or replies says that those are delivered as the source gives them (only the posts are judged). «انتهت نتائج المصدر» is claimed only from a real end signal. A row accepted later by the review gets its mark too. | `topicChoice.ts`, `compilePlan.ts`, `compiled.ts`, `itemStore.ts` |
| 14 | Plan sizing by the request applies only to **search** cards, whose query carries the source and period. An account or page **listing** has no date input and would page back through its whole history, so it keeps what the planning walk found, with `quantity` holding the customer's number (partial, said). | `compilePlan.ts` |

**Unchanged:**

* the pricing function and settings, the reserve/settlement functions and the ledger;
* the 200-point minimum, the review budget rule (20% of revenue, ceiling 40% of the reserve), `yield_share` (still 1 on compiled stages);
* every feature switch.

## 5. What this means for the incident request now

* The 3 rows are judged not about rumors at planning.
* The short first page triggers the expanded query in the second sample.
* Two outcomes:
  * **if** the expanded query returns relevant posts, the plan is for 400 (priced on 400 by the unchanged price function), and execution reads on through the gate;
  * **if not**, the customer gets the truthful no-plan sentence (what was searched, the strategies, the judged counts, «لا يثبت أن الحساب لم ينشر عن الموضوع», nothing charged).
* 3 off-topic tweets can no longer be delivered or charged on any path.

## 6. What is NOT established (needs live evidence)

* **Provider coverage.** Whether the provider's search returns @SaudiMOH's rumor posts over five years is unknown. Only 3 rows came back for the precise OR query, and that is suspiciously few for five years of a ministry account. Only a paid call can tell. Proposed probe in §8.
* **The model judgment in production.** The tests script the judge. The real verdicts are the production model's.
* **Variant quality.** The variants come from the model, are only cleaned by code, and are not verified live.

### Known limits of this change

* **No replacement read after a rejection.** When a plan is sized by what was found (the source ended, or a listing), the pinned rows the execution review rejects are not replaced by a new read. The delivery is smaller and partial, and says so.
* **Comments and replies are not judged.** They are delivered as the source gives them, under judged posts. Each customer card says so.
* **The planning judge has a cap.** It stops at USD 0.01, about two batches of rows. Rows past the cap fall back to the word rule at planning; execution judges them all.
* **Neither the variants nor the model verdicts are proven live** (§6).

## 7. Financial implications (owner decisions; nothing executed)

* **This mission:** 200 points charged for 3 rows that the file itself marks as off-topic. Under the corrected rules nothing would have been delivered or charged. Crediting 200 points to the test account is an owner decision. It is a test account.
* **Pricing policy, not changed and to be decided:**
  * the mission minimum (200) spread over a small plan gives a high price per row when the source genuinely has few relevant rows;
  * compiled plans price review cost and relevance yield as 1 (the older planner measures `yield_share`), so the hold for a low-yield request may be smaller than the reading it needs; execution then stops at its budget and the delivery is partial and honest.
* **Methodology offer:** still shown for any delivery (14 Nov §7.4, unchanged).

## 8. Third incident: a follow-up became a mission with no topic (`msn_8824508f840f703dee69`)

Conversation `b7abe45b18874b4b9d53`: «أريد ٤٠٠ تغريدة عن الشائعات الصحية … وزارة الصحة السعودية … إكس» → «طيب ابحث عن الشائعات فقط» (`msn_dd7c`, 79 tweets) → «زود العدد ل 400 تغريدة» → «هل ممكن تتوسع اكتر في استخراج التغريدات من دون تكرار بواقع 400 تغريدة».

* **What was recorded.**
  * The chat model read the last message correctly, as a data request, with the account and the topic carried from the conversation.
  * Code rejected that brief (`rejected_source_dropped`): the keyword reader did not find the account in the model's sentence.
  * The turn fell back to the fragment. The mission had no topic and no account.
  * The X search was sent with no query and refused (`missing_params:query`). The customer was told «مصادرنا لا تخدم هذا الطلب».
* **Root cause.** The model's understanding was a *suggestion* that a keyword reader could veto, and the veto fell back to the last sentence instead of to the conversation. A second, smaller cause: the «is there a topic?» check let any word outside a stop list through, so «تتوسع» counted as a topic.
* **Fix (general, no phrase list).**
  * The executable request is rendered from the brief's structured fields and re-validated by the same checks. An invented account, number or platform is still rejected.
  * An understanding that cannot be used is restated to the customer to confirm. A mission is never planned from a fragment of a conversation with history.
  * A search request needs search input (a topic or a source) by construction.
  * A search with an empty query is refused before any call (`no_topic`) with a truthful sentence; an invalid query is no longer reported as a missing source capability.
* **«من دون تكرار» is now enforced.** See §9.

## 9. «Without repeating what was delivered» (continuations)

**Correction to the earlier status report:** I wrote that this needed the `customer_exclusion_files_v1` switch and that carrying the structured brief to the worker needed a schema migration. **Both were wrong.**

* That switch checks *companies* against an uploaded spreadsheet. It cannot recognise a tweet.
* The brief already reaches the worker on the server-written `messages.plan` JSON. No migration and no switch are involved.

**The mechanism** (`src/lib/agentMission/priorDelivery.ts`, `agent/src/priorDelivery.ts`):

1. **The model reads the intent.** The brief has an optional `exclude_delivered`, written by the chat model when the customer wants more of earlier research without receiving again what was delivered. There is no keyword list.
2. **The chat server records the earlier missions.** It puts the conversation's earlier mission ids on the new card (`plan.priorDelivery.missionIds`, server-written; customers cannot write an assistant plan).
3. **The worker verifies and pins, at planning.**
   * It keeps only missions of the same customer that are `completed` with `delivered_units > 0`.
   * It reads their item stores, and builds the identity of every delivered item: its id, and its canonical link (`x:status:<id>` whether the link was x.com or twitter.com, with or without a query string).
   * It writes that snapshot to the mission's private folder and pins its digest on the plan, with one sentence on the card stating how many items are excluded.
   * A failed read throws, and the existing planning retry handles it. The requirement is never dropped silently.
4. **A delivered item is never a sample.** It is never chosen as a planning sample, judged, or counted as available. A parent-only search whose whole sample was delivered before is still planned for the customer's number, and execution reads past it.
5. **Execution never delivers or charges it.**
   * It loads exactly the approved snapshot. If it is missing or altered, nothing runs and the hold is released whole (fail closed).
   * Every matching row is kept out with the reason `already_delivered`.
   * Pages made only of earlier items do not count as «dry», so the read continues past the earlier mission's pages.

**Limits.**

* The continuation re-reads the earlier pages from the start of the query; it does not resume the earlier cursor. Those reads are a provider cost, inside the execution budget, and never a charge.
* If the model does not set `exclude_delivered`, nothing is excluded. The card says it when it is set, so the customer sees it before approval.
* For a follow-up that is not a parent-only search (with comments or replies, or an account listing), delivered items are still never chosen or delivered. But when *every* item its planning read was delivered before, no plan is made (the existing «no rows» answer); it does not read past them.

Tests: `tests/p0-continuation-no-duplicates.test.ts`, `tests/p0-conversation-continuity.test.ts`.

## 10. Pre-merge review of the whole diff (the seven questions)

1. **Can irrelevant rows still be delivered or charged?** Not on a compiled plan with a research topic.
   * Every top-level row with text goes to the model review at execution, pinned sample rows included. Only a «yes» is accepted.
   * Rows a review never reached stay `pending`: not in the file, not counted, not charged.
   * With no reviewer configured, such rows are final exclusions, so the gate fails closed.
   * Comments and replies under judged posts are delivered as the source gives them, and the card says so.
   * Plans with no topic (for example, «all posts of account X») have nothing to judge, and are unchanged.
2. **If the model review fails:** failed calls are retried by the reviewer. What stays unreviewed is `pending`, never delivered or charged.
   * The closing sentence says the review could not be reached («تعذّر الوصول إليها … فلم يُسلَّم ما لم يُراجَع»).
   * A planning judge failure falls back to the word rule for the *card only*. Execution judges every row again.
3. **Costs and budgets** (computed with the real price functions for a 400-tweet plan):

   | Spend | Amount (USD) | Enforced by |
   |---|---|---|
   | Planning judge | ≤ 0.01 per planning run | `createReviewer` budget |
   | Variants | one Haiku call (≤ 300 output tokens), once per mission | `planning_variants.json` |
   | Execution review | budget ≈ 0.073; ceiling ≈ 0.145 | 20% of revenue / 40% of the hold value, `review.ts` |
   | Provider reads at execution | ≈ 0.145 | `executionBudgetUsd(200)` |

   * A low-yield topic stops after 5 consecutive pages with no accepted row (`JUDGED_DRY_PAGES`).
   * Planning model cost is recorded as planning cost, never charged.
4. **Does the changed planned-row count affect pricing?** No pricing code changed, but the effective price changes.
   * A plan sized for 400 tweets is priced on 400. The 200-point minimum is spread over 400 (unit 0.5) and the hold is 200.
   * Settlement charges `ceil(delivered × unit)`. So 3 delivered tweets now cost **2 points**, where the incident charged 200.
   * This is in the customer's favour. Under it, the card's line «الحد الأدنى للمهمة ٢٠٠ نقطة» holds only for a full delivery, which was already true of any partial delivery.
   * The company's exposure on a short delivery is bounded by the budgets above. **Owner decision:** whether a minimum should apply to partial deliveries. That would be a settlement-policy change (the database function), and was not made.
5. **Can an approved plan execute beyond its scope?** No.
   * The approved scope check (capabilities, parameters, counts, pins) is unchanged.
   * The plan's own selection rules are gates at execution: exact account, period, X originals (`COMPILED_PLAN_GATES`).
   * The volume cap is `planned_rows`.
   * The expanded query keeps every hard condition, and is the query recorded and approved on the plan.
6. **Do conversation follow-ups preserve previous intent?** Yes, through the model's structured brief, re-validated by code (§8). A brief that cannot be validated is confirmed with the customer, never executed from a fragment.
7. **Is «without duplicates» enforced against previously delivered tweets?** Yes, for missions created after this change, by the snapshot mechanism in §9. It was never enforced before.

**Not verified live:** provider coverage for the incident account over five years, the production model's verdicts, variant quality, and the end-to-end continuation on a real conversation. Each needs the authorised live acceptance.

### Independent review of the PR head (839a859) and what changed after it

A separate review of the diff traced every path a row can be accepted by: the pinned replay, the engine's reads and alternative tools, the model's `save_rows`, carried pending items, and swaps. It found no path where an off-topic, wrong-account, out-of-period or previously delivered row is accepted and charged. A failed or exhausted review leaves rows pending.

It found five problems. All five are fixed in the next commit:

1. **The prior-delivery exclusion could fail open.**
   * The problem: the chat server's read of the earlier missions swallowed errors, and the card would then say «nothing to exclude». The same happened when the earlier mission was still executing, or when it predated the item store.
   * The fix: the worker now reads the conversation's earlier cards itself, and a failed read throws, so the planning retries.
   * An earlier mission still running has what it collected so far excluded. One whose items cannot be read is counted. The card states both, and never says «nothing to exclude» unless that is known.
   * Older missions' `rows/<stage>.json` files are read.
2. **The model execution path crashed at its closing review** (`tools.ts` `drainPending`). It was not given the approved exclusion lists. This already affected the customer's exclusion list before this change. Both lists are now passed.
3. **Execution enforced the period where the planning had only marked it** (TikTok, X searches with no account operator), so the approved card and the execution disagreed. The plan now records whether the planning gated the period (`compiled.period_gate`), and execution gates exactly there. **This means the requested period is a hard gate only where the planning could check it.** Elsewhere a row outside the period stays in the file, marked, as the card says.
4. **The new low-yield stop told the customer «the page limit was reached»,** which was false. It is now its own reason, `topic_dry`: «قرأنا عدة صفحات متتالية … ولم نجد فيها ما يتحدث فعلًا عن موضوعك». A page counts as dry when it held new rows that were not delivered before and none was accepted, so a few earlier items on a page no longer defeat the stop.
5. **The card promised «we read further than the first time»** even for plans that do not read past the sample. That clause is removed.

Also fixed: an edit of the open request keeps `exclude_delivered`, so the model does not have to repeat it.
