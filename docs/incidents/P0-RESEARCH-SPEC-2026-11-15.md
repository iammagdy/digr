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

1. **The customer's words travel with the mission.** The chat server stores the customer's own messages of the conversation (newest 8, as typed) on the mission's card as `plan.customerWords`. The model never writes them. There is no schema change: the card's `plan` is already JSON.
2. **One research spec per mission** (`agent/src/researchSpec.ts`). The worker asks the model once, with no thinking and a forced structured answer (`research_spec` tool). The answer has three fields:
   - `criterion`: what a record must be about;
   - `any_of`: the alternatives, each keeping its qualifier;
   - `not_relevant`: near misses, such as general news or a word used in another meaning.
3. **Code checks the answer before anything uses it:**
   - shape and length;
   - the customer-facing Arabic rules, with a Latin word allowed only if the customer wrote it;
   - **a request whose customer words separate alternatives with «أو» must keep at least two alternatives.**
   
   A failed answer is not stored. The spec then falls back to the customer's words alone (`by: "words"`), and the next run asks again.
4. **Everything reads that one stored spec:**
   - the planning judgment;
   - the search-vocabulary step;
   - the plan stage's relevance subject, shown on the card as «المقصود» before approval;
   - the execution review;
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

`tests/p0-research-spec.test.ts` (24 tests) uses the recorded production words. It checks:

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
- the chat card carries the customer's words beside the summary.

## Remaining limits

- The spec is one model reading. It is checked for structure, but not for every nuance of meaning. The customer's words travel with every judgment so that a weak criterion does not decide alone.
- Rejected rows are recorded as counts and in the admin CSV, not as text in events. The event guard is Arabic-only, so a row's text cannot be stored there.
