# LLM-first research intent → verified capabilities (switches unchanged, all OFF)

**Status.** One PR on top of #454 (`f5703c6`). No new switch: everything here runs only where `chat_research_brief_v1` and `capability_discovery_v1` are already on for the account (both OFF; nothing in the repository or the database sets them). No money, pricing, ledger, wallet, reservation, approval, settlement, refund, credential, schema, migration, permission, Vercel or Heroku configuration change. No live model or provider call.

## 1. The path, traced

```
chat message ─ agentChatTurn ─ ONE decideTurn call (brief mode) ─ parseBrief ─ validateBrief ─ capabilityGate ─ startMission(brief.request)
                                                                                                                │ messages.plan.researchBrief (server-written)
worker runPlanning ─ readMissionBrief ─ researchNeedOf ─ discoverCapabilities ─ (compiler | planner with VALIDATED CAPABILITIES) ─ plan_ready (+ record + anchor)
customer «اعتمد» ─ approveMissionOnce (unchanged) ─ runExecution ─ verifyApprovedScope(plan, catalog, anchor) ─ execute the STORED plan ─ settlement (unchanged)
```

**Where keywords were the primary interpretation (before this PR).** `capabilities/need.ts` read the kind of research from regular expressions (`COMPANY_WORDS`, `PLACE_WORDS`, `REVIEW_WORDS`, `PEOPLE_WORDS`, `WEB_WORDS`, `COMMENT_WORDS`, `REPLY_WORDS`, the unsupported-platform list) and allowed exactly ONE kind per request. The model's brief added only `platforms` and `content` (a fixed noun list). So «الناس كاتبة إيه عن تجربتها في شاليهات الساحل» was `unknown` and went to a code-written clarifying card, and «تعليقات تيك توك وتقييمات فنادق الغردقة ومقالات الأخبار» kept one kind. The worker never saw the brief at all: it re-read the words.

## 2. What changed

**The model proposes objectives in the same call.** In brief mode with discovery on, the prompt (`capabilities/prompt.ts` `OBJECTIVE_PROMPT_LINES`, 6 lines) asks the model to add `objectives` to the brief it already writes:

```json
"objectives":[{"id":"o1","operation":"places.discover","platform":null,"parent":null,"contacts":[],"what":"..."},
              {"id":"o2","operation":"places.reviews","platform":null,"parent":"o1","contacts":[],"what":"..."}]
```

`operation` is one of the registry's ten operations, which name what can be EXECUTED, not what a customer may ask. A goal none of them serves is written `unsupported` (with the goal in `what`) and is asked about, never mapped to another operation. No provider, endpoint, field, number or price is ever in an objective. The earlier turn's objectives are given back to the model in `BRIEF_SO_FAR`, so confirmed parts stay and corrections replace only what changed.

**The backend validates them** (`researchBrief.ts`):

* **Schema:** only known fields and values. An unknown operation or field rejects the brief (`schema_objectives`), which then falls back to today's path.
* **Structure** (`OBJECTIVE_PARENTS`): a child hangs only on an operation that can feed it. A social objective names its platform and a non-social one names none. Contacts appear only on `company.contacts`.
* **Grounding:** a served platform an objective names was named by the customer.
* **Nothing dropped:** every platform and content of the brief has an objective.
* **Privacy:** an objective's `what` goes through the same refusal as a typed message.

**Objectives are the primary reading** (`need.ts`). With validated objectives, the need IS the objectives:

* Every objective is kept, and several kinds in one request become kind `mixed`.
* The chain step a child needs is added by code (comments are read from posts, reviews from places, page text from search results), never as a new goal.
* An X reply objective is the X comments stage.
* Count, period, country, language, topic and privacy are still read by the trusted contract from the words; numbers are never the model's.
* The keyword reading remains only as the fallback when there are no objectives (brief mode off, an old brief, a typed request).

**Discovery** (`discover.ts`):

* **Goal nothing serves:** an objective that no operation or served platform covers is `unresolved`. With nothing else it gives `needs_clarification` with an honest sentence and the kinds of data available now. With served parts it gives `partial`.
* **Unclassifiable is not unsupported:** a request the words cannot classify is never called unsupported.

**Chat gate** (`chatTurn.ts` `capabilityGate`):

* **Mixed social and non-social:** the customer is asked which part is prepared first. The social compiler plans social data only, so the other part is never cut silently.
* **Unresolved goal:** the customer is asked, and the brief is kept `needs_clarification`.
* **Social partial:** passes to the compiler only when nothing unresolved remains.
* **Typed approval:** «موافق» still approves nothing.

**The worker uses them** (`runMission.ts` `missionObjectivesBrief`). It reads the brief the chat stored with this mission's card (`messages.plan.researchBrief`, assistant rows that only the server writes: customers may insert only `role='user'` rows with `plan` null, and there is no update policy). It uses the objectives only when:

* the brief's request is exactly this mission's words;
* they pass the structure and grounding check again against the mission's own words;
* the customer has not since changed the request by answering a question (a reduced-scope «yes» changes nothing).

Otherwise the words are read as before. A mixed social plus non-social mission that reaches the compiler is asked first, using the existing reduced-scope card.

## 3. Approved plan integrity: a missing record cannot skip the check

#454 checked `capability_selection` and `params_digest`, but a plan without a record was "legacy" and skipped the check. Removing the record therefore disabled it.

**Trusted marker.** The worker writes a **create-only anchor** in the mission's private storage folder: `capability_scope/<time>_<n>.json` = `{"v":1,"digest":"<record digest>"}`.

* **Who can write it:** only the worker, with the service role. Neither the customer nor the site can.
* **When:** written BEFORE the plan is shown with its record. A failed write stops the plan, so the existing error path retries the mission.
* **Re-planning with the switch off:** a later planning that makes a plan without a record writes `{"digest":null}`. Only a re-planning reads the folder.

**At execution, `verifyApprovedScope(plan, catalog, anchor)`:**

* **Anchor requires a record:**
  * the plan has none → `selection_record_missing`;
  * the plan has a different one, even a self-consistent one → `selection_record_replaced`.
* **No anchor:** plans made before discovery, or with the switch off. These are exactly as compatible as before.
* **Unreadable anchor:** still requires a record.
* **Failed listing:** throws. Execution never runs a plan it could not check.

**When the check fails:** nothing is called, and the existing settlement releases the hold whole. No migration, no permission change, no financial logic change.

**What it adds:** one storage listing per execution start, for every mission.

## 4. Cost

Still exactly one chat-model call per message. With both switches on, the prompt grows by about 350 tokens and the reply by the objectives (about 80 to 250 tokens). That is roughly +$0.0001 per message at the default chat model's $0.10 / $0.50 per million tokens. The output ceiling stays 700 tokens. A reply cut by the ceiling fails the schema and falls back to today's path.

## 5. Offline tests (`tests/llm-first-objectives.test.ts`, 28)

| What | Proven by |
|---|---|
| The objective vocabulary is exactly the registry's operations | 1 |
| Each goal kind (social conversations, companies and official contacts, public professionals, places and reviews, public articles) maps to real capabilities of TREG / Firecrawl / Context.dev | 1 |
| Provider inputs match the catalog schemas: each validated TREG id is a real endpoint of that operation whose documented input takes the parent's field; each web id is a documented source | 1 |
| Three phrasings (Arabic, a paraphrase, English) give the same stages, though the keyword reading misses the goal in at least one; an unclassifiable request becomes a mission | 2 |
| A mixed request keeps every objective: the customer is asked which part first; the next turn's prompt carries every earlier objective; companies plus articles stay one request with both chains | 3 |
| Useful clarification: an unsupported goal, a served goal joined with Snapchat, Snapchat alone; «موافق» approves nothing | 4 |
| Invalid selections rejected: an unknown operation, an unknown field, a wrong parent, an unnamed platform, a dropped content, misplaced contacts, a private goal; a capability outside a stage's candidates | 5 |
| End to end: a request the keyword reading sends to a clarifying card is planned from the objectives, approved, executed and delivered (200 reviews), with its record and anchor | 6 |
| Legacy compatibility: switches off → no record, no anchor, executed as before | 6 |
| A record removed, or replaced by a self-consistent other one → never executed, no provider call, nothing charged, hold released | 7 |
| Anchor semantics; a re-planning with the switch off clears the anchor and the legacy plan stays executable | 7 |
| The worker asks before cutting a mixed request (no provider call); a brief stored for other words is never used | 8 |

**Provider calls before approval.**

* The chat turns, the clarifications and the worker's questions make none.
* The only provider calls before approval are the existing planner's sampling calls in the planning phase. These are unchanged and recorded without a job.

**Not proven:** what the real chat model writes (how often its objectives pass validation, latency, real token use), live provider answers, and the deployed worker's revision.

## 6. Superseded in part

The «ask which part first» behaviour for a mixed request is replaced by `docs/MULTI-OBJECTIVE-RESEARCH.md`: every part is prepared on its own card, none is cut.

## 7. Rollout

Unchanged: the same two switches and the test-account SQL already documented in `docs/AGENT-UNDERSTANDING-V1.md` and `docs/UNIFIED-CAPABILITY-DISCOVERY.md`. **Not run by this PR.**
