# Multi-objective research: one brief, every objective, the existing plans (switches unchanged, all OFF)

**Status.** One PR on top of #455 (`245535c`). It needs no new switch: the multi-part flow runs only where `chat_research_brief_v1` and `capability_discovery_v1` are already on for the account, and both are OFF.

**What changed for every customer:** two false refusals were fixed (section 5).

**Not changed:**

* pricing, ledger, wallet, reservation, approval, settlement or refunds;
* credentials, schema, migrations or permissions;
* Vercel or Heroku configuration;
* no live model or provider call was made.

## 1. What the code could and could not represent (traced)

* **A plan is ONE engine's plan.**
  * A social plan is compiled by the plan compiler and carries a `compiled` mark; it never runs the old pipeline and is never mixed with model-planned stages.
  * The model planner refuses social stages.
* **A mission has ONE plan, ONE price, ONE hold and ONE settlement:**
  * `accept_quote_atomic` reserves the plan's `reservePoints`;
  * `settle_job_atomic` charges the file's count against it.
* **The chat page draws ONE card per assistant message** (`plan.agentMissionId`).

So "TikTok comments + hotel reviews + news" cannot be one plan: compiled TREG social stages plus model-planned Context.dev Maps stages plus Firecrawl/TREG web stages, under one price, would need a composite financial transaction and a second executor. Neither was built.

## 2. What was built: one brief, several existing missions

**Parts.**

* Each first objective of the validated brief (PR #455), with the objectives hanging on it, is a **part** (`researchGroup.ts`).
* The model writes each first objective's own sentence (`request`) in the same single call.
* Each part's sentence is validated exactly like a brief of its own: privacy, numbers written by the customer, platforms named by the customer, and the trusted parser's reading.
* Each part is matched to capabilities by the same discovery a single request gets.

**One chat turn** (`chatTurn.ts` `groupTurn`):

* **Creating parts:** every part that can be prepared becomes its own mission, created by the existing `createCustomerMission` (privacy, limits) from the part's sentence.
* **Cards:** the first part's card is on this answer, and each other part gets its own assistant message with its own card. These messages are server-written, so a reload shows them. The chat response also returns them (`agentMissionParts`), and the page appends them.
* **What the worker sees:** each card stores the part's brief (what the worker reads) and the whole group.
* **Parts that cannot be prepared** are said with why and an alternative, never dropped:
  * unsupported, or provider unavailable;
  * a sentence that failed validation, or a missing sentence (asked);
  * private data (refused alone, while the public parts go on);
  * over the open-missions limit (waits, said, and prepared on «كمّل» from the kept brief, without retyping).
* **Corrections change only what changed:**
  * an unchanged part keeps its mission and is never planned twice;
  * a changed or removed part is withdrawn only while it waits for the customer (compare-and-set);
  * an approved part is never touched;
  * a repetition creates nothing.
* **The worker** plans each part with the existing compiler or planner, from its own objectives.
* **Approval, execution, settlement:**
  * Each part is priced on its card and approved by its own «اعتمد»; one approval never covers another part.
  * Execution and settlement are the existing ones, per part.
  * Unapproved parts hold nothing and call no provider.

**Every objective has an explicit outcome.**

* **In the chat:** each part is planned, unsupported, unavailable, needs clarification, refused as private, or waiting.
* **After execution:** each part has its mission's existing status (delivered, partial, unserved, cancelled, failed).
* **Inside a part:** when a part's plan came through discovery and delivers more than one stage, a result line gives each objective's count against what was approved. Each objective reads "delivered", "partial (you pay only for what was delivered)", or "nothing delivered, not charged" (`objectiveOutcomesLineAr`).

## 3. Robustness: the 700-token ceiling

**The risk:** a long request with several parts could exceed the ceiling. The transport cut the JSON, the type-only salvage then routed the message as a data request without its brief, and today's path created a keyword-read mission. That kind of mission keeps one kind of data and silently drops the other objectives.

**The fixes:**

* **Detection:** the transport now reports `stop_reason: max_tokens` (`truncated`). In brief mode, a cut answer without its brief is failure `truncated`.
* **Handling:** with discovery on, the customer is told their request arrived whole and asked to type «كمّل». No mission is made from the words alone. The next turn reads the original request from the history, so it is not retyped.
* **Output size:** the prompt now asks for compact output (empty fields omitted, `what` only for unsupported goals, a short `reason`, an empty `reply` for a ready multi-part brief).
* **No extra cost:** no second call is made and the ceiling is unchanged.

## 4. Capability selection per objective

Unchanged from #454/#455 and applied per part:

* Hard eligibility comes first: public data, availability (key, allowance, policy), platform, inputs fed by the parent's documented outputs.
* Ranking is by coverage first (documented outputs, feeds the child, volume by paging, conditions it enforces), then price, then id.
* Every eligible capability across TREG, Firecrawl and Context.dev is kept. When the web providers' allowance is spent, the catalog's own news search still serves the part (test F).

## 5. No false refusals (for every customer)

**Two false refusals were found with a probe of 14 legitimate requests and fixed by the role of the words, not by new keywords:**

* **«مقالات عن سرقة الهوية والاحتيال الإلكتروني» got the trust answer.** The subject check cut one letter of the matched word, so «عن سرقة» was not seen as a topic. Fixed in the slice offset.
* **«الناس بتقول إيه عن تسريب أرقام التليفونات» and «تعليقات عن تسريب أرقام موبايلات» were refused.** Contact words that are only the SUBJECT of public content are no longer an ask.

**They stay an ask when:**

* they point at private people («أرقام تليفونات الناس العاديين», «… وأرقام تليفونات المعلقين»);
* they are what is collected (in the head);
* a second collecting verb follows them («… واستخرج الأرقام»);
* they are what the content must contain («تعليقات فيها أرقام موبايلات»).

Opinion phrasing («الناس بتقول/بيتكلموا/كلام …») is read as public content.

Every existing refusal corpus is unchanged and green (`private-data-guards`, `agent-understanding-privacy`, `chat-prefilter-false-positives`, `round23-live-fixes`).

## 6. Offline acceptance (`tests/multi-objective-research.test.ts`, 37)

| Scenario | Proven |
|---|---|
| A, G, L | three objectives give one model call, three missions and three cards, each with its part brief; the whole brief is kept; no provider call; each part validates and maps to its own capabilities |
| B | companies + websites + official contacts give one card; the worker's planner gets companies → e-mails / phones fed by the website |
| C | TikTok (comments, replies) + X (replies) give two cards with different chains (X has no separate replies step) |
| D | a correction withdraws only the changed part; the others are kept, never planned twice; a repetition creates nothing; «موافق» approves nothing; earlier part sentences are given back to the model |
| E | TikTok + Snapchat + an unsupported goal: one card, the other two said with why and an alternative, all kept in the brief |
| F | web providers' allowance spent: the TREG news search still serves; no web request |
| H, L, M | approving the hotels part plans it from its objectives, holds, executes and settles it (`assertReplayInvariants`). The TikTok and news parts stay unapproved, with nothing held. One reserve and one release, no negative balance; a second approval is refused; no TREG call |
| I | fewer reviews than approved: partial, each objective's outcome said, only the delivered rows charged |
| J | killed mid-execution and restarted with the record and anchor: the scope check passes again, no row twice, the same ledger |
| K | a private part is refused alone, the public part goes on; an all-private request is refused, with no mission |
| N | switch OFF: no record, no anchor, the same delivery; a single-objective brief keeps today's single card |
| robustness | a cut answer is said and recovers with «كمّل» without retyping; a 4th part over the open-missions limit waits and is prepared on «كمّل» |
| no false refusals | 14 legitimate requests reach the model and become missions; 6 real private-data collections stay refused |

**Not proven:**

* what the real chat model writes (part sentences, how often they validate, token use);
* live provider answers;
* the chat page in a browser (the extra cards are appended by code that was read and typechecked, not run in a browser);
* the deployed worker's revision.

## 7. Rollout (unchanged by sections 8 to 11)

Unchanged: the same two switches; the SQL is in `docs/AGENT-UNDERSTANDING-V1.md` and `docs/UNIFIED-CAPABILITY-DISCOVERY.md`. **Not run.**

## 8. Reliability: cards that are really stored (round 46)

**The failure found in #456.**

* The cards were written with `Promise.all`, and only a THROWN error was caught.
* A Supabase write that RESOLVES with `{ error }` counted as saved. The missions stayed, and the response listed cards that a reload would not show.
* A retry then created the same parts again, because the group was never stored.
* Two turns of the same request at the same moment created every part twice.

**Now** (`chatTurn.ts` `groupTurn`):

* **Layout:**
  * every part's card is its own assistant row with a derived id (`partCardIdOf(missionId)`);
  * the answer is the summary of the parts and draws no card (`summaryOnly`, so the handler sends no `agentMission`).
* **Checked writes:** cards are written one at a time and each result is checked.
  * An error object or a throw is a failure.
  * When the answer to a write is lost, the row is read back by its id.
* **A card that is not stored:**
  * Its mission is withdrawn when this turn created it (compare-and-set on the waiting statuses; nothing is held before approval).
  * The part is said «waiting» and is never claimed.
  * It is prepared again on «كمّل».
  * If the mission cannot be withdrawn (the worker took it), the group keeps its id, and the next turn writes ITS card. No second mission is created.
* **The summary:** written last, carrying the group with the true outcome of every card, and retried once. The cards also carry the group as it was just before they were written. The next turn prefers the summary of the same group (`readPriorBrief`).
* **Nothing stored:** no live mission is left, and the customer reads that nothing was prepared or charged and to say «كمّل».
* **Idempotency (no schema change).** A part's mission id is `partMissionIdOf(user, conversation, sentence, n)`, and both ids are existing TEXT primary keys.
  * A retried or concurrent turn meets the same id. The primary key refuses the second insert (`23505`), and that turn ADOPTS the live mission and its stored card.
  * A finished or withdrawn mission is never reused; the part takes `n + 1`.
  * The page appends a card it already shows only once (`chatCards.ts`).
* **Still possible:** two concurrent turns whose two model calls write DIFFERENT sentences for the same part get two ids. Both missions are visible, each on its own card, unapproved and holding nothing.

## 9. Every part accounted for: parts 7 and 8

**Before:**

* A brief carries up to 8 objectives (OBJECTIVES_MAX), so up to 8 parts.
* Only the first 6 (RESEARCH_GROUP_MAX_PARTS) were judged and stored.
* «كمّل» rebuilt the same brief and processed the same first 6, so parts 7 and 8 never reached mission creation.

**Now:**

* **All parts are stored:** every part is judged and stored in the group.
* **Waiting parts:** a part not prepared in this turn is stored «waiting» with its reason and prepared on a later «كمّل», from the kept brief, without retyping.
* **Limits, all existing and unchanged:**
  * the open-missions limit (3 being planned at once);
  * the hourly limit;
  * at most 6 new missions per turn;
  * the expiry of plans nobody answers (`requests/expiry.ts`): at most 5 wait for the customer, and the OLDEST beyond them are expired.
* **Room check:** a new part is created only while there is room among those 5, so preparing a later part never expires an earlier one. Without room, a part may still adopt its own existing mission.
* **Approval:** an approved part no longer waits, so it makes room. No part is ever executed without its own «اعتمد».

**Not done (needs infrastructure or an authorization change):** an automatic continuation when room appears (when a plan is approved or expires). The customer says «كمّل».

## 10. The customer's intent across the split

The model writes each part's sentence, and the code checks it with the trusted readers every request already goes through:

* the request contract with the semantic flag OFF (period, content language, country, rows' fields);
* the places list (countries and cities);
* the numbers written.

No new vocabulary. The chat still imports no semantic module.

* **Invented:** a part states a period, a language, a place or a field the customer never wrote (in any turn, or the request already grounded). That part is asked with a natural sentence and is not prepared; the other parts go on. A number the customer never wrote was already the existing check's.
* **Dropped:** a requirement of the whole request (period, language, country, city, field, number) that no part carries. Nothing is prepared, and the customer is asked which part it belongs to. A part that also states something unwritten is named in the same answer.
* **A clarification keeps the group:** the parts already prepared keep their missions (no second mission), and only the asked part is prepared next.
* **What it cannot see:** the request contract reads WHETHER a period or a language is stated, not its value. The value check of section 12 closes this.

## 11. Offline tests (`tests/multi-objective-reliability.test.ts`)

| Scenario | Proven |
|---|---|
| layout | the summary draws no card; each part's card is its own row with a derived id; the response lists exactly the stored cards |
| a card's write resolves with an error / throws / two of three fail | that part is withdrawn and said «waiting», never returned; reload shows exactly the stored cards |
| the write's answer is lost but the row was stored | counted saved, never withdrawn |
| a card fails and its mission cannot be withdrawn | the next turn writes its card for the same mission, never a second mission |
| retry after a failure | «كمّل» prepares only the failed part (next id); kept parts are not re-created; a third turn changes nothing |
| the summary fails | the stored cards stand; the next turn knows the parts from the cards' group |
| nothing can be stored | no live mission is left; the retry prepares each part once |
| concurrent duplicate requests | 3 missions and 3 cards, never 6; both answers list the same stored cards |
| 8 parts | all stored from turn 1; «كمّل» prepares more within the open-missions and 5-waiting limits; parts 7 and 8 get missions after earlier parts are approved; nothing expired |
| intent | invented period, place or field asked; dropped period or number asked; a changed city asked with both places named; a clarification keeps the group; no false question on the acceptance request |
| page | the same cards after the answer and after a reload; a repeated answer adds none; each card loads its own mission with its own price and «اعتمد» |

**Not proven:**

* what the real model writes;
* a real browser (the project has no browser runner);
* real Supabase error codes beyond the documented `23505`;
* the deployed worker's revision.

## 12. Exact requirements across the split (round 47)

**The gap (traced).**

* The brief's `period`, `country` and `language` were parsed but used by nothing. Only the request SENTENCE is executed: it is the mission's `request_text`, and the worker's `buildAsk` reads its period, country and language.
* Sections 10 and 11 compared only WHETHER a condition was stated, so «آخر شهر» → «آخر سنة» passed.
* Worse: the part matcher (`samePartRequest`) read both sentences with the parser's booleans. A customer's correction of a period («آخر شهر» → «آخر أسبوع») therefore counted as the SAME part. The old mission was kept and the correction was silently lost. Fixed.

**The understanding stays the model's, in the same single call, with no extra call.** The prompt asks:

* a condition of the WHOLE request is written once, in the brief's own `period`, `country` and `language`;
* a condition of ONE part is written on that part's first objective (`period`, `country`, `language` in the customer's own words, and `count`, the number the customer wrote for that part);
* a condition is never moved to another part or changed.

The fields are allowed only on a first objective (schema). They travel as structured fields in each part's brief (`partBriefOf`: the part's own conditions, else the whole request's) and are given back to the model in `BRIEF_SO_FAR`, so corrections keep them.

**The code compares VALUES (`conditionDriftOf`), never words of a new list.**

* **Reader:** the period, the country and the content language are read by `buildAsk`, the very reader the worker executes with, with the semantic flag OFF (as on the chat), at the same moment for the phrase and for the sentence. So a relative period keeps its meaning: «آخر شهر» is the same Cairo window on both sides.
* **Cities:** read with the existing places list.
* **Grounding:** the attributed words must be the customer's own (normalized letters and digits only), or give a value their words give.
* **Never refused:** words no reader understands are only required to be CARRIED by the part as written.

| The part's sentence | Result |
|---|---|
| executes another period, country, city or language than the customer's words for it | asked, not created |
| narrows a country to a city, or widens a city | asked, not created |
| loses a condition of the whole request, or of its own | asked, not created |
| carries a condition the model gave to ANOTHER part only (forced onto it) | asked, not created |
| gives another number than the one written for it | asked, not created (the existing `count_mismatch`, now with a clear sentence) |
| asks for replies that its objectives never collect | asked, not created |
| keeps every value | prepared |

* **Across the split:** a whole-request requirement no part carries is still asked about. It is not asked when a part that is itself being asked states that same kind of requirement differently, since that question already covers it. The other parts go on.
* **The single request:** the consolidated sentence must execute the customer's own period, place and language (`drift_*` outcome). Otherwise the customer is asked; nothing is created.
* **Corrections:** a part is the SAME only when it executes the same values (`sameExecutedValues`).
  * A corrected value withdraws only that part, and only while it is still unapproved.
  * An approved part is never touched.

**Why the chat may read with `buildAsk`:**

* `foundation/ask.ts` is an existing integration point.
* The chat calls it with the semantic flag OFF and never reads the flag.
* The isolation tests are unchanged (no new semantic import).
* The check can only ASK. It never widens, narrows, refuses, prices or approves.

**What it cannot see:**

* **Model fidelity:** a model that ignores a correction in BOTH the attribution and the sentence.
* **Unfamiliar phrases:** the value of a period phrase no reader understands. It is carried verbatim, and the planner reads the same words.
* **Cities:** only those in the places list.
* **Semantic flag on:** with the flag ON, the worker reads conditions with the semantic reader, and this check compares the flag-OFF reading.

**Offline tests:** `tests/exact-intent-across-parts.test.ts` (17) and multi-objective-research «EXACT REQUIREMENTS end to end». The second runs the real chat → worker planning → the customer's own approval → execution → settlement, with a drifted part never becoming a mission.
