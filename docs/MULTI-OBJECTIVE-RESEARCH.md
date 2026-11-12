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

## 7. Rollout

Unchanged: the same two switches; the SQL is in `docs/AGENT-UNDERSTANDING-V1.md` and `docs/UNIFIED-CAPABILITY-DISCOVERY.md`. **Not run.**
