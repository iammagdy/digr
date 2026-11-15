# P0 — The customer's meaning is one stored research specification (15 Nov 2026)

Follows PRs #503–#506 (docs/incidents/P0-RESEARCH-QUERY-2026-11-15-RETEST3.md). Evidence: production missions `msn_6d86fb6f698bb8ca7320` and `msn_5abbc68352f31fa31d56` on the test account, read with read-only queries.

## What was proven

| # | Root cause | Evidence |
|---|---|---|
| R1 | **The customer's own words never reached the worker.** The mission row stores only the chat model's one-line summary (`request_text`). | The customer wrote «…الشائعات الصحية **أو** تصحيح الشائعات **أو** جهود الوزارة في مكافحة المعلومات المضللة…». The stored summary says «…الشائعات الصحية **و**تصحيح الشائعات **و**جهود الوزارة…». The card's brief `topic` dropped «جهود الوزارة» too. |
| R2 | **Each step re-derived the meaning from the step before it.** The worker's word rules parsed the summary into a topic, and that label was the judge's «What they mean». | `buildAsk(summary).topic` = «الشائعات الصحية وتصحيح الشائعات وجهود الوزارة»: no alternatives, and the qualifier «في مكافحة المعلومات المضللة» is cut at «في». The continuation delivered 6 tweets, 5 of them the ministry's general news. |
| R3 | **Planning and execution built their judge inputs separately.** | `compiled.ts` built a subject from `researchRelevanceOf(ask)`, and `runMission.ts` built its own request string for the execution reviewer. #506 told the judge that "the customer's request is authoritative", but the text it called "the customer's request" was the summary. |
| R4 | **The methodology contradicted itself and the data.** | «لم يُحذف بها شيء من النتائج، وسُلّمت كلها» stood beside a table of 12 exclusions. A word-rule sentence («تُقبل إذا ذكر نصها …») described a meaning judgment. «غطّت النتائج أقل من ساعة» was said for one tweet of a five-year request. «طلبك (بكلماتك)» showed the summary. |

## The contract now

1. **The customer's words travel with the mission.** The chat server stores the customer's own messages on the mission's card, exactly as typed. The model never writes them. There is no schema change: the card's `plan` is already JSON. They are stored in two parts:
   - `plan.customerWords`: the messages of this request, meaning those typed after the conversation's previous mission card;
   - `plan.earlierWords`: earlier messages, kept as context only.
   
   The worker reads the newest card of the mission that holds them, because an answer typed in chat writes a later card that has none.
2. **One research spec per mission** (`agent/src/researchSpec.ts`). The worker asks the model once, with no thinking and a forced structured answer (`research_spec` tool). The answer has three fields:
   - `criterion`: what a record must be about;
   - `any_of`: the alternatives, each keeping its qualifier;
   - `not_relevant`: near misses, such as general news or a word used in another meaning.
3. **Code checks the answer before anything uses it:**
   - shape and length;
   - the customer-facing Arabic rules, with a Latin word allowed only if the customer wrote it;
   - **a request whose customer words separate alternatives with «أو» must keep at least two alternatives.** A message counts only when at least one of its alternatives appears in this request's summary, so an earlier request on another subject, or another part of a split request, never imposes its alternatives;
   - no provider or model name may appear, even one the customer typed.
   
   A failed answer falls back to the customer's words alone (`by: "words"`). That fallback replaces any spec made from other inputs, and the next run asks the model again. Execution judges only with the spec made from exactly its inputs, or else with the customer's words alone; it never uses a stale spec.
4. **Everything reads that one stored spec:**
   - the planning judgment;
   - the search-vocabulary step;
   - the plan stage's relevance subject, also stated on the card before approval: «المقصود بموضوعك كما فهمناه من كلماتك: …»;
   - the execution review, but only for plans whose research topic is judged by meaning;
   - the methodology.
   
   Every judgment prompt starts with the customer's own messages. The system prompt says that when the criterion and the customer's words disagree, the customer's words win, and that an uncertain row is 0.
5. **The model decides meaning only.** It does not set price, count, source, period, filters or charges; code enforces those exactly as before.
6. **Audit trail (admin-only internal events).** The worker records the spec's criterion, alternatives and near misses, and the planning judgment's counts (`jdg_rows`, `jdg_yes`). Execution's per-stage check report is unchanged.

## Methodology corrections

- A stage judged by meaning says so: «بمراجعة آلية لمعناها مقابل طلبك بكلماتك … ولا يكفي أن تذكر كلمة منه».
- On a judged stage, the topic-mark lines say that the marks describe the delivered items and that exclusions are counted in the counts table.
- One delivered item is told as one item, never as a coverage span.
- «طلبك (بكلماتك)» shows the customer's own messages. The summary appears as «ملخص الطلب الذي نُفّذ».

## Not changed

Pricing, holds, settlement and the ledger; database schema; feature switches; providers; the search composition from PR #503 to #505; the deduplication from PR #506.

## Tests

`tests/p0-research-spec.test.ts` (29 tests) uses the recorded production words. It checks:

- R1/R2 reproduced;
- bounds on the stored words;
- the spec validation, including that merged alternatives are refused;
- the spec is made once and stored, and a failed answer is not stored;
- identical planning and execution prompts;
- the variants step reads the spec;
- the card criterion;
- the structured call, with thinking off and the HTTP 400 retry;
- one spec per planning run, with its cost counted once;
- the four methodology contradictions;
- the chat card carries the customer's words beside the summary;
- the five independent-review findings that were fixed (answer cards, stale spec, earlier-request bleed, provider names, the card line).

## Remaining limits

- «طلبك (بكلماتك)» in the methodology prints this request's messages as the customer typed them, so the customer's own Latin words, links or numbers appear in their own file.

- The spec is one model reading. It is checked for structure, but not for every nuance of meaning. The customer's words travel with every judgment so that a weak criterion does not decide alone.
- Rejected rows are recorded as counts and in the admin CSV, not as text in events. The event guard is Arabic-only, so a row's text cannot be stored there.

## Live acceptance (test account, browser, owner cap USD 2.00 / 5 missions)

| # | Mission | Deployed | What happened | Charged |
|---|---|---|---|---|
| 1 | `msn_69cd4879ce77e97d01a1` | #507 | The spec (real model) kept 3 alternatives with qualifiers and 5 near misses, including «أخطاء شائعة». The expanded search returned **0 rows**, and the fallback read the 20 newest posts, none relevant. An honest question was shown. | 0 |
| 2 | `msn_88a5d0ec135b3cbd962d` | #508 | 10 rows, 1 judged relevant (Omicron notice «…وأن نحذر من الشائعات»). The card showed «المقصود …» and the 200-point minimum; I approved it. **Execution re-judged the same row and rejected it**, so nothing was delivered and the hold was released. → #509 | 0 |
| 3 | `msn_55816a05a6afc274e958` | #509 | Expanded and core searches both returned **0 rows**. Honest "nothing found". | 0 |
| 4 | `msn_ab60f5eb5c1bedcaffc7` | #509 | The handle was **not asked again** (carried over). 40 sample + 140 execution rows, all from @SaudiMOH in the period; 1 delivered (the planning verdict reused), 137 rejected, 2 with no text. Files and methodology are correct. **The delivered tweet is off-topic by my own reading**: a violation seen in a circulating clip, not a rumor. → #510 | 1 point |
| 5 | `msn_dae6a9b770b0560709cc` | #510 | The owner's follow-up. Topic, «أو», account and period were kept, and the handle was not asked. **The model's summary said «مع استبعاد ما سُلّم» but the brief flag was missing**, so no prior delivery was recorded. Searches returned 0 rows; nothing was delivered. → #511 | 0 |

Totals: USD 0.0157 (provider 0.0083, model 0.0074) of USD 2.00, and 5 of 5 missions. Test-account points: 1 charged; every hold was released or settled.

## What the live runs proved and did not prove

- **Proved:**
  - the real model produces a correct, checked spec from the customer's words, three times;
  - the card shows the criterion before approval;
  - the handle carries over within the conversation;
  - planning and execution now agree, because the verdict is reused;
  - the files and methodology match the delivered data;
  - the charges match the card.
- **Empty searches (corrected by the zero-spend audit below):** 4 of 9 topic queries inside @SaudiMOH returned 0 rows. This record first called that an intermittent provider; the stored calls do NOT prove it. See «Zero-spend forensic audit».
  - whether the account has 400 such tweets is unknown.
- **Not proved:**
  - #510 (the stricter judge) and #511 (the no-repeat backstop) have run only in tests, because the live budget is used up;
  - the 137 rejected rows of mission 4 could not be inspected: their text is in storage I cannot read, so false negatives are unmeasured.

## Zero-spend forensic audit (15 Nov 2026, after #512)

No paid call, no live mission, no data change. Evidence: read-only queries of `missions`, `mission_calls`, `mission_events` and `storage.objects` (names and sizes only).

### Method: queries proven by their fingerprints

`mission_calls.params_digest` cuts every query at 80 characters, but keeps `__params_sig`, the SHA-256 of the call's complete inputs (`agent/src/gateway.ts` `paramsSignature`). A rebuilt query whose fingerprint equals the recorded one is the query that was sent. Five queries are proven that way:
- the two plans' expanded queries (msn_ab60, msn_88a5: 354 characters, 16–17 terms);
- the two empty core queries (msn_5581, msn_dae6: 150–167 characters, 6 terms);
- the topic-less newest-posts query.

The three empty expanded queries (msn_69cd, msn_5581, msn_dae6) are stored only as their first 80 characters; by construction they hold the model's variants and then the customer's three alternatives, 241–400 characters.

### Task 1: the 180 rows of msn_ab60f5eb5c1bedcaffc7

- **Access boundary.** Row texts are only in the private bucket `agent-missions`, which has no storage policy: only the service role reads it. The read-only database role sees the object names and sizes, not their contents:
  - `excluded/tweets.json` (94,655 bytes) and `admin/excluded.csv`;
  - `raw/call_0001…0009.json`;
  - `research_judged.json`.
  
  The admin download needs an admin session; the test account is not admin, and this audit holds no credential. Reaching the bucket through the worker's production key was not attempted: that would mean using a production secret.
- **Examined: 1 of 180**, the delivered tweet 2111754500776030669, stored on the plan (`pinned_rows`):
  - @SaudiMOH, 18 Oct 2026, inside the period, an original post;
  - **a confirmed false positive.** It reports action on a violation seen in a circulating clip and calls nothing a rumor or false;
  - **it contains none of the 17 terms of the query that returned it**, so the search matched it on something other than its stored text (mechanism unknown).
- **Not examined: 179.** These are 139 execution rows (137 rejected, 2 with no text) and the 40 planning-sample rows. Execution's first page repeats planning's first query (same fingerprint), so some of those rows are the same. False negatives remain unmeasured.
- **Also examined (msn_88a5):** tweet 1466135018154205187 (@SaudiMOH, 1 Dec 2021: «…وأن نحذر من الشائعات»). It is a genuine warning against rumors, so relevant, and its only query word is «الشائعات».

### Task 2: the empty searches

| Fact | Status |
|---|---|
| Account, period and filter are identical in every topic query (`from:SaudiMOH since:2021-11-14_22:00:00_UTC until:2026-11-15_22:00:00_UTC -filter:replies`, `Latest`, 20 per page); the date format works (the same conditions returned 20, 10 and 180 rows) | confirmed |
| Every call answered HTTP 200; the empty ones returned 0 rows | confirmed |
| The only queries sent twice with identical inputs returned identical counts (20/20 twice) | confirmed: **no evidence of intermittency** |
| msn_88a5's first page held 10 rows (< 20) and its cursor page 0: the end of that query's results | consistent with normal paging |
| The empty CORE queries never carried the customer's «الشائعات»; the one relevant tweet found contains that word and none of their six terms | confirmed: **code defect, fixed below** |
| The empty EXPANDED queries of msn_5581 (16:35) and msn_dae6 (17:00) carried «الشائعات» (the customer's alternatives are always appended) and the same conditions as msn_88a5's query, which returned that tweet at 16:18 | confirmed from code and stored alternatives; contradicts a boolean OR over a stable index |
| Why: a hidden length or complexity limit (empty ones are 241–400 characters, ≥10 terms; non-empty ones 354), or a provider answering differently over time | **unresolved hypotheses**: no identical query exists to separate them |
| msn_ab60 returned 180 rows because it carried common words («نفي», «تصحيح», «غير صحيح», «لا صحة»), which is why 137 were off-topic | hypothesis (row texts unreadable) |

### Task 3: #510 and #511 checked offline

- **#510 (the stricter judge)** is a prompt rule. Tests prove the prompt says it; only a real model can prove it changes the verdict on the clip tweet. **Not proven.**
- **No deterministic filter can discard a genuine rumor correction.** A stage judged by the model sends every row with text to the meaning review (`classifyRowDetailed`: `review`). Only a row with no text left once links and mentions are dropped is set aside, counted as «no text»; a video-only correction is lost that way.
- **Planning and execution stay consistent.** Execution reuses planning's verdict for the same row and spec (#509). Limit: the verdict file is keyed by the spec, not by the judge's rules, so a mission planned before a rule change and executed after reuses the older verdicts. No mission is waiting across #510 today.
- **#511.** The owner's follow-up words alone record the exclusion; the first request's words never do, whatever the summary says.

### Fix

`coreExpandedInputsOf` now puts the customer's own short alternatives first, then the model's variants, at most six terms. It makes no new call, and every row is still judged. Production's msn_5581 core reproduces exactly from the old order (fingerprint match), and the fixed core carries «الشائعات». Whether it returns rows live is **not proven**. Tests: `tests/p0-zero-spend-audit.test.ts`.
