# P0, 15 Nov 2026 (third retest after PR #502): the model layer was silent, and the query was the customer's sentence

Missions `msn_7365668c48162ce20bbd`, `msn_c6767995ad124f9edbec`, `msn_cfee23cdac3a2c7e4ab4` (test account). Production on `ddd74ab` (Vercel `dpl_DqVouwe4cEPPRMry4TNN2YV2U7DH` READY; Heroku v210; worker heartbeat `ddd74ab`). Evidence was read **read-only** from `missions`, `mission_calls`, `mission_events`, `messages` and `storage.objects`. Fixture: `tests/fixtures/p0-x-account/production-2026-11-15-retest3.json`. Tests: `tests/p0-research-query-retest3.test.ts`.

## 1. What happened (recorded)

| Mission | Reads (query as recorded, clipped at 80 chars) | Rows | Outcome |
|---|---|---|---|
| `msn_7365…` | `("الشائعات الصحية" OR "تصحيح الشائعات" OR "جهود الوزارة في مكافحة المعلومات المض…` | 0 | |
| | `from:SaudiMOH since:… until:… -filter:replies` (**no topic at all**) | 20 | the account's 20 newest tweets, all judged not about rumors (correctly) → «no relevant rows» question → «سأعدّل طلبي» → cancelled |
| `msn_c676…` | `"الشائعات الصحية وتصحيحها وجهود الوزارة" from:SaudiMOH. since:…` | 0 | |
| | `الشائعات الصحية وتصحيحها وجهود الوزارة from:SaudiMOH. since:…` | 0 | unserved |
| `msn_cfee…` | `"الشائعات الصحية وتصحيحها وجهود الوزارة" from:SaudiMOH since:…` | 0 | |
| | `الشائعات الصحية وتصحيحها وجهود الوزارة from:SaudiMOH since:…` | 0 | unserved |

* **Every mission** kept `planning_variants.json` of **12 bytes**, i.e. `{"terms":[]}`. That is the recall step of PR #502: it ran and produced no search terms, three times out of three.
* The customer of `msn_c676…` wrote the wordings to try («شائعات، إشاعات، معلومات مغلوطة، تصحيح، لا صحة لما يُتداول…»). None was searched.
* Nothing was priced or charged. Recorded cost: provider USD 0.002940 and planning model USD 0.001445.

## 2. Root causes (each proven by the evidence; each alone explains a failed request)

### Q1. The worker's model calls came back silently empty (the main cause)

* `claude-haiku-5-5` **runs adaptive thinking when a request omits `thinking`**, and **thinking counts toward `max_tokens`**. Anthropic's migration notes for Haiku 5.5 say this directly: a cap sized for a short answer can be used up by thinking, and the response then ends with `stop_reason: "max_tokens"` after a `thinking` block and before any text.
* The worker's shared call (`agent/src/review.ts` `anthropicReviewCall`) sent no `thinking` field. Its short text calls had small caps:
  * the topic's search variants: 300 tokens;
  * the capability choice: 200;
  * the channel understanding: 200;
  * the Arabic names step.
* The empty answer was read as **success with nothing to say**. The variants step returned `{terms: []}` and kept it for the mission, and every later planning run of that mission trusted it.
* **Evidence:**
  * the 12-byte variants files;
  * `msn_cfee…` recorded USD 0.000293 of planning model cost. That is about what two calls using their whole 300- and 200-token output caps cost at Haiku 5.5 prices.
* **Why the judge still worked:** the verdict call **forces a tool**, and a forced tool call skips thinking on Haiku 5.5.
* **Why tests passed:** every test of this layer scripted the model's *answer* (`scriptedVariants`), or mocked a fetch that answered text whatever was sent. No test modelled the model's real default.
* The web app's own short calls (chat brief, row review) already sent `thinking: {type: "disabled"}`. The worker never adopted that.

### Q2. The query was the customer's sentence

* The precise query is built by code from the customer's words. In two missions that was «الشائعات الصحية وتصحيحها وجهود الوزارة» searched as **one exact phrase**, then as **all of its words** (the relaxed «words» strategy).
* A platform search matches the words written in a post. A research brief is not how posts are worded, so both forms answered 0.

### Q3. The recall strategy came too late, and its fallback had no topic

* PR #502's expanded query ran only **after** the literal read had spent one of the gateway's two planning samples.
* With no terms (Q1), the second sample went to the «source items» strategy. That is the account's newest 20 tweets with no topic: a 20-row window of five years, which says nothing about whether the topic exists.

### Q4. The account handle kept the sentence's full stop

* `idOfLink("https://x.com/SaudiMOH.")` returned `SaudiMOH.`, so the search was sent as `from:SaudiMOH.`, an account that does not exist.
* The `@` branch already stripped trailing dots; the link branch did not.

### Q5. The acceptance account does not take the customer's path (a finding, not changed)

* `iam.magdy+1@outlook.com` is a test account (`testAccounts.ts`). With `social_discovery = "test"`, its missions are planned with tools derived from the catalog (`catalogOnly`) and a model choice among candidates.
* A real customer's X mission uses only the hand-verified cards. An acceptance run on this account therefore tests a superset of the customer path. It is not identical to it, and every acceptance report must say so.

## 3. The change (general: no topic, account, platform or word list)

| # | Change | Where |
|---|---|---|
| 1 | Every worker model call asks for **no thinking**, as the web app's short calls already do. An API that refuses the field (400) is asked once more without it, then (verdict calls) without the forced tool. An answer cut at the cap with no text is reported `truncated`; for the variants step, that is a **failed** call, never «no other wording». | `review.ts`, `researchJudge.ts` |
| 2 | A failed variants call is **never kept** for the mission; the next planning run asks again. The variants call sees the customer's answer too (their suggested wordings), prefers one- and two-word terms, drops Arabic diacritics, and has a 600-token cap. | `researchJudge.ts`, `compiled.ts` |
| 3 | **The first read of a research search is the expanded query**: the customer's alternatives (or topic) OR the model's search terms, with every hard condition written exactly as before (the account's operator, the period, originals only). It contains the precise query's terms, so it finds everything the precise query finds. The second sample is its own next page. After an empty expanded page, only the source's own items are read (never the narrower «all the words» query). With no terms, the precise query is read first, as before. | `compiled.ts` |
| 4 | An identifier never ends with the sentence's punctuation (link and bare forms). An inner dot (Instagram) is kept. | `sourceScope.ts` |
| 5 | **The model's tool choice is offered only candidates that carry every condition the customer wrote** that the best-ranked tool carries (the topic, the period, the source, the language, the country), and the source rule. Before #1, this choice silently never answered; now that it answers, it can never trade a written condition for a preferred tool. | `compiled.ts` |
| 6 | The admin-only planning event no longer labels every question «لا فيديو في ما قُرئ…» (it said so for the source question on X). | `runMission.ts` |

**Unchanged:**

* the research gate (every row judged by meaning before it can be chosen, delivered or charged);
* request-sized plans, the dry-page stop and the prior-delivery exclusion;
* pricing, reserve, settlement, ledger, the 200-point minimum, every feature switch;
* no migration and no data change.

## 4. Why this addresses the general problem, not this request

* The AI layer is meant to understand the research and propose how to search for it, with code enforcing the conditions. Q1 meant every short step of that layer had been switched off in production, silently, and Q2/Q3 meant that code fell back to searching the customer's sentence.
* After this change:
  * the model's search vocabulary drives the first read of every research search on a platform whose search takes operators and a disjunction;
  * code still writes and enforces the account, the period and originals only, and judges every row;
  * a model call that fails is visible as a failure instead of passing as an empty answer.

## 5. What is NOT established (needs a live, authorized acceptance)

* **Provider coverage.** Unknown until a paid read: whether the X search returns @SaudiMOH's posts about rumors across five years for a disjunction of terms with `from:` and `since/until`.
* **Live quality.** The production model's search terms and verdicts are not verified live; the tests model the API's documented behaviour, not the live model's answers.
* **Execution at 400.** End-to-end reading up to 400 judged tweets, with its budget and dry-page stop, has not run live.
* **The browser journey.** Not run: no authenticated session for the test account is available to this engineering session.

## 6. Financial items

None. Nothing was charged on these three missions, and no pricing or settlement code changed.
