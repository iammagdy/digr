# LLM quality mission: the real chat model and the real planner, iterated (round 50)

**Baseline:** main `d913826` (PR #460, round 49: 17 of 22 real conversations as expected).
**Owner authorization:** real Anthropic testing, at most **$10 in total** across every run, retry and failure. No paid provider data, no production activation, no money, schema, pricing, auth or infrastructure change.
**Model:** `claude-haiku-5-5`, the repository default for both the chat (`DEFAULT_MODEL`) and the worker (`AGENT_MODEL_DEFAULT`). Price re-verified before the first paid call: $0.10 / $0.50 per million input / output tokens up to 100K-token prompts (the guard refuses larger prompts).

## 1. Results at a glance

| | Round 49 (before) | Round 1 of this mission (fixes A–E only) | **Final round (9)** |
|---|---|---|---|
| Original 22 conversations, labels unchanged | 17/22 | 16/22 | **21/22** |
| Expanded corpus (39 new conversations) | – | 28/39 | **39/39** |
| All 61 conversations | – | 44/61 (72%) | **60/61 (98.4%)** |
| First answers that are valid JSON | 25/25 | 65/68 | 67/67 |
| Briefs accepted by the schema | 16/22 | 56/62 | 58/63 |
| `objectives` written outside `brief` (now read correctly) | 8/22 | 0 | 0 |
| False refusals of legitimate research (code or model) | 2 | 1 (code, M1) | **0** |
| Lost customer requirements / missing parts | 2 objectives (J1) | 3 | **0** |
| Duplicate live missions | 0 | 0 | 0 |
| Truncated answers | 0 | 0 | 0 |
| Real planner: valid plans (non-social missions) | not tested | 1/21 (placeholder data) | 9/14 |

Across rounds 2–9, after the main fixes, the 61 conversations scored 58, 58, 59, 58, 57, 60, 58 and **60**. The remaining misses changed from round to round. The stability runs (section 6) repeat the critical conversations.

**This is not production readiness.** The live providers, the chat page in a browser and the deployed worker were not exercised. Every provider answer the planner saw was synthetic. See section 9.

## 2. What was fixed (each from a real-model failure, each with a deterministic regression test)

All tests are in `tests/llm-quality-fixes.test.ts` (50 tests). Each one scripts the chat model with the SHAPE the real model produced and runs the real `agentChatTurn`.

### A. Multi-objective reliability

| Real failure | Root cause | Fix |
|---|---|---|
| J1 lost 2 of 3 parts; 8/22 answers put `objectives` beside `brief` | The prompt's format example closed `brief` before objectives were described | The example shows `objectives` inside `brief`. `parseModelAnswer` moves a top-level array in when the brief has none; two different arrays are ambiguous and rejected. |
| J1: the whole request rejected (`count_mismatch`) | A part's number (300) written as the brief's count | `withPartCounts`: a brief-level count that is one part's own number belongs to that part. |
| J1, K6, K7: part rejected as dropping comments | The part sentence named only its first step («منشورات تيك توك…») | `completedPartSentence`: comments, replies, reviews, official e-mails and phones that the objectives carry are stated in fixed words; so is the part's own count when the sentence writes none. |
| J1: wrong part sentence | Sentences on several objectives of one part | The deepest objective's sentence that carries the part's count is used. |
| J1: «مصر» of the news part asked of every part | A whole-request condition duplicated on one part | A whole-request condition that the model also wrote as one part's own belongs to that part. |
| J1: «آخر أخبار» asked as a period | A recency phrase read as a time window | News-recency words are not a period. Words no reader executes are only checked on the part that owns them. |
| J1: «الغردقة» asked as «another part's place» | Any place on another part triggered the check | Only a city attributed to another part, or one the customer never wrote, triggers it. |
| Invalid multi-part reading reduced to words | Fallback to the keyword path | `MULTI_PART_RETRY_AR`: nothing is prepared from part of it. The customer continues with «كمّل». |
| K6: an added part left the single mission live next to a copy | The single open mission was not a known part | It is matched as the first part (kept or withdrawn while it waits). |
| K7: a removed part withdrawn silently | Not said | The summary says the earlier version was cancelled. |

### B. False privacy refusals

| Real failure | Root cause | Fix |
|---|---|---|
| M1, M2 (round 49): the model refused public opinion about phone-number leaks | Nothing in the prompt said research ABOUT a sensitive subject is allowed | Prompt rule plus examples. `classifyMessage` reads «what people say about …» as a request, so a model refusal is overruled. |
| M1 (round 1): code refusal of the model's English rephrase («comments discussing phone number leaks») | `discussing` was not a topic marker | `discussing`, `mentioning`, `covering` mark the subject. «comments discussing the phone numbers of the people who commented» is still refused. |
| N5: «الواتساب الشخصي للمعلقين» passed the code guard | «الواتساب» with the article was not matched | The article is accepted. The request is refused by code before any model call. |

All private-data cases (N1–N7) were refused by code in rounds 2–9. The privacy suites still pass.

### C. Structured output

* **Content values:** `articles` and `contacts` were added to the content enum. Each must have its objective (`web.search` / `company.contacts`), or the brief is rejected.
* **Objective keys:**
  * `topic` and `description` join the internal `what`, which is privacy-checked;
  * `city`, `place` and `location` are the part's place;
  * every other unknown key (an endpoint, a provider) still rejects the objectives.
* **Conditions on a child objective** (E1, H1) move to the part's first objective. A conflicting value is rejected.
* **Conditions the model invented** (a country inferred from a city, a language never said):
  * when the sentence does not execute them, they are cleared from the stored brief (`groundedConditions`) and never quoted to the customer as theirs;
  * when the sentence executes them, the customer is asked, and the question names them as the model's addition.
* **Prose instead of JSON.** In rounds 2–6, 2 to 3 follow-ups per round got prose answers, and neither retry wording recovered every case: a user-turn note was refused as an extraction attempt.
  * Root cause: the earlier assistant turns are prose, and the model imitated them.
  * Fix: in brief mode the earlier turns are a transcript in the system prompt, and the customer's message is the one user turn. Rounds 7–9: 0 unreadable answers.
  * One system-prompt retry remains. An unreadable answer in a conversation in progress is answered «ابعتها تاني», never with a mission from a fragment.

### D. Corrections

| Correction | Real failure | Fix |
|---|---|---|
| Period «آخر شهر» → «آخر أسبوع» (K1, E1) | `planning_same`: the contract compares only whether a period exists | Compared by executed values (period window, country, language, places, districts, numbers) while the plan is prepared or ready. A changed condition on a question card restates the request. |
| Quantity 300 → 100 (K3) | Same, then the number only in `count` | Numbers compared; `withCountInSentence` states a count the customer wrote. |
| District المعادي → الزمالك (K8) | Both read as Cairo | `districtLabelsIn` compares districts. |
| Platform, country, content language, added and removed parts (K2, K4, K5, K6, K7) | Prose answers, copies | See C and A. |

### E. Routing and capabilities

* **Unsupported platform (O1).** «Snapchat» re-typed as a request by the keyword rule became a mission that could only end `unserved`. Now the code's own discovery answers honestly («words_unsupported_platform»).
* **News read as companies (I1).** Fixed both ways:
  * the brief now carries `articles`;
  * in the keyword fallback, news words win over companies unless websites, contacts or reviews are asked.
* **No mission from words that name no data** (D1, D2, D3, S1, S2, A1, O4):
  * a new request whose brief is unusable, and whose words name no data kind or no topic, is asked (the model's question, or the code's);
  * a refusal the keyword rule overruled is never shown as the question;
  * a web or companies request that the customer named is not asked for a platform (W1).

## 3. Test corpus

**Original 22 conversations** (round 49): unchanged, labels unchanged.

**39 new conversations, labelled before any run:**

* **Platforms:** all five (X1, IG1, FB1, YT1, plus TikTok throughout).
* **Languages and spelling:**
  * English (EN1, M5, N6) and formal Arabic (FA1);
  * Arabizi (AZ1) and mixed (MX2);
  * misspelling and voice transcription (V1, V2).
* **Short, long and ambiguous:** very short (S1, S2), long (LG1), ambiguous (D3).
* **Multi-part:** J2, J3, LG1.
* **Corrections:** platform (K2), quantity (K3), country with a READY plan (K4), language with a READY plan (K5), added part (K6), removed part (K7), district (K8).
* **Sensitive public research:** M3–M6.
* **Private data:** N4–N7 (N7 mixes a public part with a private one).
* **Unsupported services:** Reddit (O3), a results chapter (O4).
* **Exact dates and count:** L2.
* **People, places, web:** G2, P1, W1.
* **Not a request:** Q1, Q2.

Cases: `evals/live-intelligence/cases.ts`.

## 4. The cumulative budget

Code: `evals/live-intelligence/cumulative.ts`, `budget.ts`. Offline tests: `tests/live-eval-cumulative.test.ts` (20) and `tests/live-eval-guard.test.ts` (35). All of them ran before the first paid call.

* **State.** One state file outside the repository, with a sha256 checksum.
  * It is created once (`LIVE_EVAL_BUDGET_INIT`, ≤ $10, here $9.50) and never reset or raised.
  * A missing, corrupt, edited or unwritable state fails closed.
* **Lock.** An exclusive lock for each run (`O_EXCL`), so concurrent runs are refused.
  * The lock of a dead process is taken over, and that process's in-flight reservations are charged in full.
* **Before every attempt.** The worst case (counted input, tools included, plus a 32-token margin, plus max_tokens of output) is reserved on disk with fsync and an atomic rename. Only then is the request sent.
* **After every attempt.**
  * The actual cost replaces the reservation.
  * A non-200 answer is charged its input; a network failure is charged its whole reservation.
  * Cache writes are charged at 2× input.
  * The run halts if the actual cost exceeds the reservation.
* **Ceilings.** Per run (`LIVE_EVAL_MAX_ATTEMPTS`, `LIVE_EVAL_MAX_USD`), cumulative ($9.50, 3,000 attempts), and an output ceiling (700 for the chat, 4,096 for the planner).
* **Network.** Every host except `api.anthropic.com` is blocked. The guard never reads the key.

## 5. Real Anthropic evidence

| Round | All | Original | Expanded | JSON 1st answer | Briefs valid | False refusals | Lost reqs | Dup | Truncated | Planner plans | Attempts | Run USD | Cumulative USD | Failed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| smoke | – | – | 1 | 1/1 | – | 0 | 0 | 0 | 0 | – | 1 | $0.0007 | $0.0007 | – |
| 1 | 44/61 | 16/22 | 28/39 | 65/68 | 56/62 | 1 | 3 | 0 | 0 | 1/21 | 245 | $0.5004 | $0.5011 | E1, J1, M1, A1, D1, D2, S1, S2, D3, J3, K3, K5, K6, K7, K8, N5, O4 |
| 2 | 58/61 | 20/22 | 38/39 | 65/67 | 57/61 | 0 | 0 | 0 | 0 | 10/15 | 238 | $0.4730 | $0.9741 | J1, D2, K7 |
| 3 | 58/61 | 21/22 | 37/39 | 67/67 | 58/63 | 0 | 0 | 0 | 0 | 9/12 | 225 | $0.4591 | $1.4332 | J1, S1, K7 |
| 4 | 59/61 | 20/22 | 39/39 | 67/67 | 55/63 | 0 | 1 | 0 | 0 | 12/13 | 259 | $0.5712 | $2.0044 | J1, C2 |
| 5 | 58/61 | 20/22 | 38/39 | 66/67 | 59/62 | 0 | 0 | 0 | 0 | 9/11 | 202 | $0.3842 | $2.3887 | E1, I1, W1 |
| 6 | 57/61 | 20/22 | 37/39 | 64/67 | 58/61 | 0 | 0 | 0 | 0 | 10/14 | 238 | $0.4868 | $2.8755 | E1, J1, K7, M5 |
| 7 | 60/61 | 21/22 | 39/39 | 67/67 | 59/62 | 0 | 0 | 0 | 0 | 8/12 | 203 | $0.4030 | $3.2785 | J1 |
| 8 | 58/61 | 20/22 | 38/39 | 67/67 | 58/61 | 0 | 0 | 0 | 0 | 11/13 | 229 | $0.4648 | $3.7432 | E1, J1, K3 |
| **9 (final code)** | **60/61** | **21/22** | **39/39** | 67/67 | 58/63 | **0** | **0** | 0 | 0 | 9/14 | 234 | $0.4785 | $4.2217 | D2 |

**Reading the table:**

* **"Accepted" requires all of these:**
  * the final outcome is one of the case's labels;
  * no requirement is lost;
  * the expected number of live parts exists.
* **"Briefs valid"** counts the model's raw brief against the schema. A rejected brief whose words name no data is asked (C, E), so a rejected brief is not a lost request.
* **"Planner plans"** means `plan_ready` from the REAL planner on non-social missions.

In every round, for every conversation:

* no mission executed;
* no `job_id`;
* no `credit_ledger` row;
* no provider or model name reached the customer;
* every reply was in Arabic;
* a typed «موافق» approved nothing.

**Capability selection.**

* News requests were planned as web research and places/reviews requests as maps.
* Companies with contacts were planned as companies → contacts. G2 (managers of pharma companies) was read as companies → people, which is the correct chain. The metric script's label for it was wrong.
* Snapchat and Reddit were said to be unavailable. No integration was invented.

**Final round D2 («محتاج معلومات عن منافسين شركتي").** The model marked the brief `needs_clarification` but wrote no question, and the request read as complete. A mission was prepared and the worker asked «ما اسم شركتك ونشاطها؟» on the card. Safe, but the question came on the card instead of in the chat.

## 6. Stability of the critical conversations

**The 18 critical conversations:** every multi-part request (J1, J2, J3, LG1), every correction (E1, K1–K8), the sensitive public research (M1, M2, M3, M6) and the mixed public + private request (N7).

They ran twice more on the final code, chat only:

| Run | Accepted | Lost requirements | Duplicates | False refusals | Attempts | USD |
|---|---|---|---|---|---|---|
| Stability A | **18/18** | 0 | 0 | 0 | 30 | $0.0264 |
| Stability B | **18/18** | 0 | 0 | 0 | 30 | $0.0265 |

With round 9 (17/18; D2 is not among them, but the round's J-cases and corrections all passed), the critical conversations passed in all three final-code runs. J1, the three-part request of the original failure, prepared all three parts in rounds 4, 8 and 9 and in both stability runs.

## 7. Real worker-planner evidence (synthetic provider data)

**Driver.** `evals/live-intelligence/plannerDriver.ts` runs the worker's own `runPlanning`:

* the production planning prompt, tools and handlers (`propose_plan` is validated by the production plan checks);
* with the model reached through the guarded Messages API instead of the Agent SDK. The SDK runs in a child process that the spending guard could not see.

**Differences from production:**

* plain tool names instead of `mcp__diger__…`;
* thinking off;
* at most 30 turns;
* the provider transport is synthetic. TREG answers fictional rows shaped like each endpoint; the web answers with the documented fake Context.dev shapes. Social missions use the code compiler (no model) and were answered «unavailable».

**What the real planner did:**

* **Round 1, placeholder rows** («نتيجة تجريبية», example.org). It refused to plan from them («any company I delivered would be invented») and ended `unserved`. This is anti-fabrication evidence, not a planning failure.
* **Rounds 2–9, realistic fictional rows.** 9 to 12 valid plans per round on 11–15 missions. Examples:
  * the maps search plus its reviews for hotels, restaurants and schools;
  * a news search, plus page text where asked;
  * a companies search plus its e-mails.
* **Questions it asked** were genuinely missing parameters («ما اسم شركتك ونشاطها؟») or honest mismatch notes («العينات أعادت فنادق في القاهرة وليس في الغردقة»).
* **The `unserved` endings** were honest stops: the synthetic rows did not match the requested city or sector, or they read as filler. Several came after the production validator rejected a plan for formal points the planner did not fix within its turns: `yield_from`, sample rows, column keys.
* **Prices** come from backend code (`plan.price`); no model-written price is used.
* **No money moved.** `reserved_points` on a ready plan is the code's quoted hold, and nothing was held. No job was created and no network call left the guard.

**Not proven:** the planner on real provider answers, and its success rate on companies and people searches (synthetic mismatches dominate those).

## 8. Offline regression and security gates (on the final code)

| Gate | Result |
|---|---|
| Full `npm test` | 954 files passed, 5 skipped. 13,208 tests passed (13,137 before this mission, +71 new). The 48 expected-fail and 65 skipped are unchanged. |
| Root typecheck (`tsc --noEmit`) and worker typecheck (`npm run agent:typecheck`) | pass |
| Privacy and money suites, by name: `private-data-guards`, `pre-rollout-acceptance`, `agent-understanding-privacy`, `agent-price-and-settlement`, `engine-settlement`, `ledger`, `explicit-quote-approval`, `financial-audit-truncation` | 8 files, 280 tests passed |
| `npm run build` and the client-bundle secret scan | pass; 209 files scanned, zero secrets |
| Evaluation key | Its VALUE is found in 0 files of the repository (the build output included), 0 lines of the branch history, and 0 files of the scratchpad and session logs. |

**Test files whose assertions changed**, each for a deliberate behaviour change and each now asserting more, not less:

* `exact-intent-across-parts`: a child's condition is moved to its part instead of rejected; a conflicting one is still rejected.
* `live-eval-guard`: the preflight now also needs the budget folder, and a 400 is charged its input.
* `agent-understanding-conversation` and `multi-objective-research`: in brief mode the earlier turns are in the system prompt; the model still sees them.

No test was skipped or weakened.

**Not changed:**

* production flags;
* the database, schema or SQL;
* pricing;
* auth;
* deployment or infrastructure.

**Product changes** are limited to the chat LLM layer: `chatTurn`, `conversationModel`, `researchBrief`, `researchGroup`, `messageType`, `guardRules`, `places` and capabilities `need` and `prompt`.

**Total real spending: 2,134 paid requests (all HTTP 200), $4.2746 of the $10.** This is read from the cumulative state file, which matches the per-run ledgers. The round-49 run ($0.018) was under its own earlier authorization.

## 9. Remaining defects and unverified behaviour

1. **D2-type requests.** When the model marks a brief `needs_clarification` without a question and the request reads as complete, a mission is prepared and the worker asks on the card. Safe, but not the chat question the label expects.
2. **Planner formal validation.** Some real planner runs ended `unserved` after the production validator rejected `yield_from` and sample-row details. On real data this would be seen as «not available» rather than a plan. Worker planner prompt work was not part of this mission.
3. **Model variability.** 1 to 3 different conversations miss in each round. No miss repeated in every round.
4. **Not exercised:**
   * live providers (TREG, Firecrawl, Context.dev) — blocked;
   * the chat page in a browser;
   * the deployed worker and the Agent SDK transport;
   * production's `ANTHROPIC_MODEL` and `planning_model` settings, which are unknown to this run;
   * semantic normalization ON.
5. **Rollout.** `chat_research_brief_v1` and `capability_discovery_v1` stay OFF everywhere. Nothing here changes a flag. Enabling them for named test accounts is the next step, followed by watching real traffic.

## 10. How to run again

```bash
LIVE_EVAL_CONFIRM=llm-quality-10usd-cumulative LIVE_EVAL_BUDGET_DIR=<state dir outside the repo> LIVE_EVAL_OUT_DIR=<scratch dir outside the repo> LIVE_EVAL_SET=all LIVE_EVAL_PLANNER=1 LIVE_EVAL_MAX_ATTEMPTS=500 LIVE_EVAL_MAX_USD=2 npx vitest run -c vitest.live-eval.config.ts
```

The first run against a new state directory also needs `LIVE_EVAL_BUDGET_INIT=<ceiling ≤ 10>`.
