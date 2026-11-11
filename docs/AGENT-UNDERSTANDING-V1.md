# Agent understanding v1: LLM-led discovery, a validated research brief, no false privacy blocks

**Status.** One consolidated change (this PR). Two parts:

1. **For every customer, now** (no switch; narrowings of existing filters plus one strengthening of the privacy rule): the privacy guard judges each collection objective on its own, an ambiguous app/product word is a clarification instead of a refusal, five word-level false readings are fixed, and a general/identity question that also carries a research request no longer drops the request.
2. **Behind server switches, OFF by default, nothing in the repository or the database sets them:** the research-brief mode of the chat (`chat_research_brief_v1`) and the semantic reading (`semantic_normalization_v1`), each ON for everyone or only for named test accounts.

No money, pricing, ledger, wallet, reservation, approval, settlement, refund, provider, credential, TREG, schema, auth, Vercel or Heroku change. No migration. No production data or setting was written.

## 1. The customer message path (read in the code)

```
chat page / POST /api/chat           placeholder check (unchanged)
ChatHandler.handleUserMessage        greeting → general question* → identity* → … → agent
agentChatTurn (chatTurn.ts)          typed approval → preModelAnswer (privacy* → account → trust) → ONE chat-model call (decideTurn) → route
  data_request          → mission (queued) → worker plans → plan_ready (plan + price shown) → «اعتمد» button → reserve → execute the STORED plan
  edit_of_open_request  → the open mission's own path (count edit / answer / card editor)
  other types           → the model's guarded reply, no mission
```

`*` changed here. Where deterministic code decided before the model could understand, and what changed:

| Filter | Wrong decision | Change |
|---|---|---|
| Privacy contact rule (`guardRules.ts`) | one business word anywhere exempted the whole sentence: «تعليقات عن شركات الاتصالات **وهات أرقام تليفونات الناس اللي علقوا**» passed | `contactAskVerdict`: the text is split into collection objectives at a joined collecting verb («وهات», «وكمان», «and also» …); each is judged alone; a business word exempts only its own objective; a person right after a contact word («تليفونات الناس», «عملاء», «اللي علقوا») is refused whatever business word is near |
| Privacy contact rule | a bare product/app word was refused: «عايز موبايلات سامسونج على تيك توك», «جروبات واتساب عن السياحة» | a product cue (a brand, a price, a review, «بيزنس») → the product, goes on; no cue and no person → **clarify** (`privacy_clarify`: a fixed question saying what Diger collects and what it never does; no model call, no mission) |
| General question (`briefManager.ts`) and identity (`assistantIdentity.ts`) | «إنت مين؟ وعايز داتا عن السياحة»: fixed answer, the research request lost | `carriesResearchRequest`: they stand aside when the message also asks for data; the agent's model sees both intentions |
| E-mail words (`contacts.ts`) | «ميل» inside «عميل», «تحميل», «جميل» (and «mail» inside «gmail») made a TikTok request an e-mail request | whole words only, clitics and plural/pronoun endings kept |
| Account name (`requestContract.ts`) | «حساب عام» read as an account NAMED «عام» | describing words («عام», «معين» …) are not a name |
| Keyword fallback (`messageType.ts`) | «كل التعليقات على بوستات فيسبوك عن …» typed «other» when the model call fails | a statement naming what to collect and a platform, not a question, is a data request |

Every refusal of the existing corpora still holds (`private-data-guards.test.ts`, `round23-live-fixes.test.ts`, `chat-prefilter-false-positives.test.ts`); only the two pf-06/pf-07 pins were changed, with a note.

## 2. LLM-first understanding: the research brief (switch `chat_research_brief_v1`)

**The model interprets; the backend decides.** In the SAME one call that already types every message (no second call, no embeddings, no new service), the chat model leads discovery and returns a structured brief next to the type:

```json
{"type":"data_request","reason":"…","reply":"…","count":null,
 "brief":{"status":"ready|needs_clarification","request":"…","platforms":[],"content":[],"count":null,"topic":"","period":"","country":"","language":""}}
```

* `request` is the whole research request in one or two Arabic sentences: every turn of this request merged, corrections applied (new value replaces old, the rest kept), canonical words the trusted parser reads (platform names, «تعليقات», «ردود», «عن» before the topic, the period in the customer's words). The prompt also gets `BRIEF_SO_FAR` (the brief validated on an earlier turn, marked as data, not instructions).
* Discovery rules in the prompt: understand the goal, ask only what changes what is collected or its cost, one natural open question in the model's own words, never re-ask what was said, explain unsupported capabilities honestly, «موافق/تمام» is not approval. Nothing in the product hard-codes a question or a reply.

**Backend validation** (`researchBrief.ts`, pure, versioned `v: 1`):

1. Schema: known fields only (unknown ones dropped and never executed), enumerated platforms and contents (an unsupported value rejects the brief, it is never mapped), integer count.
2. Privacy: the consolidated request goes through the same `privacyRefusalAr` and contact verdict as a typed message. A private component the model left in is refused; it is never planned.
3. Grounding: every number in the request (and the count) must have been written by the customer in this conversation (digits of both scripts and number words); every platform must have been named by the customer, by the open request's stored words, or by the question they answered.
4. Consistency with the trusted parser (the worker plans from the words, not from the model's fields): the platforms the words name equal the brief's; the count is in the words; comments and replies the brief lists are read from the words. Otherwise the brief is rejected (`comments_dropped`, `platform_mismatch` …).

A rejected brief (other than privacy) falls back to today's path: the mission is made from the customer's own message exactly as before. Brief mode can therefore not do worse than today.

**Routing** (`chatTurn.ts`):

| Situation | What happens |
|---|---|
| request, brief `needs_clarification`, the parser does not read a complete request | the model's question (reply guard passed) is shown; the brief is stored on the assistant message (`messages.plan.researchBrief`); no mission |
| request, brief `ready`, or the parser already reads platform + topic + what to collect | a mission is created from the **validated consolidated request** (the old unapproved plan is replaced, as before) |
| follow-up on a plan waiting for approval | same request → today's path; only the count changed and the customer wrote it → today's plan edit priced by code; anything else → the unapproved plan is cancelled and a mission of the whole updated request is planned and priced again |
| follow-up on a question card | an answer → today's answer path; a platform change or the platform the request lacked → the request is restated whole |
| follow-up while the plan is still being prepared | still queued → withdrawn with a compare-and-set, replaced; already in the worker's hands → not touched, the new request is started and the customer is told the earlier plan runs only if they approve it |
| the model is unavailable while a discovery question waits | the answer joins the request so far («…، تيك توك»), privacy checked again |
| typed «موافق» | unchanged: «الاعتماد يتم بزر اعتمد…», nothing starts |

The customer's own messages stay in `messages` as typed. The brief holds no reasoning (`reason` is never stored). The log line holds an outcome code only (`brief: "clarify" | "ready" | "rejected_number_not_written" …`), never the customer's words.

**Cost cap.** Still exactly one chat-model call per customer message. In brief mode the output ceiling is `CHAT_MODEL_BRIEF_MAX_TOKENS = 700` (normal mode 400; the transport clamps every call to 700) and the prompt grows by about 700 tokens. With the configured default chat model ($0.10 / $0.50 per million input / output tokens) the worst case is about **+$0.0002 per message** in brief mode (≈ 700 × $0.10/M + 300 × $0.50/M). A different `ANTHROPIC_MODEL` scales this by its price. The mode is OFF until the owner enables it.

**Not changed by the brief:** the price (computed by the planner and shown on the card), the hold (only at «اعتمد»), the stages (the planner decides; a newly recognized stage is asked before it enters a price), provider calls, the model name.

## 3. The switches and test-account evaluation

`agent_settings` (service role only: no grant to anon or authenticated) holds both values; one reader `scopedFlagOn(value, userId)`:

* `true` or `"on"`: every account. Anything else is OFF (`"test"`, `"true"`, `"ON"`, `false`, a number, a malformed list).
* `{"user_ids": ["<uuid>", …]}`: only those accounts. Compared with the verified sign-in user id (chat) or the mission's `user_id` (worker and the «فهمنا طلبك» card): the same value and the same id give the same answer on the server and the worker. Nothing the customer sends is read.

`semantic_normalization_v1` now also accepts the user-id list (`readSemanticNormalizationFlag(settings, userId)` in `runMission.ts` and `askEditAction.ts`). With the flag ON the customer's typed answer is also read on its own: a platform it names fills or corrects (mt-03/04/06/07), «X مش Y» keeps X, comments it names are added (mt-10).

To evaluate on the test account of `docs/HANDOFF.md` (owner action, NOT run by this PR):

```sql
insert into agent_settings(key, value) values ('chat_research_brief_v1', '{"user_ids":["47693c59-89f1-405d-bec1-e72271517870"]}') on conflict (key) do update set value = excluded.value;
insert into agent_settings(key, value) values ('semantic_normalization_v1', '{"user_ids":["47693c59-89f1-405d-bec1-e72271517870"]}') on conflict (key) do update set value = excluded.value;
```

Rollback: delete the two rows (or set `false`).

## 4. Measurement (recomputed from the code of this PR; counts are separate, never added)

98 scenarios, 62 original known gaps (`tests/fixtures/semantic-paraphrases.json`).

| | Before this PR | After |
|---|---|---|
| A. Gaps closed for every customer (flag OFF), cumulative | 7 (PR-1.4) | **14**: + sb-11, sb-12, sb-13, cm-13, rt-06, pf-06, pf-07 (pf-07 by clarification: its expectation was revised from «agent» to «privacy_clarify» per the owner's directive and recorded in the fixture) |
| B. Known gaps still pinned with the flag OFF | 55 | **48** |
| C. Of those, fully right with `semantic_normalization_v1` ON | 37 | **42** (+ mt-03, mt-04, mt-06, mt-07, mt-10) |
| D. Partly right with the flag ON | 3 | 3 (sa-04, sa-06: topic with no marker; pl-15: X has no comments stage) |
| E. Unchanged with the flag ON | 15 | **3** (pl-19 Reddit routing, cm-08 topic with no marker, rt-03 «اللي الناس كاتباه» paraphrase) |
| F. Regressions (a scenario right before and wrong now), OFF and ON | 0 | **0** |
| G. Privacy regressions (an earlier refusal no longer refused) | – | **0**; one bypass closed (the business-word objective) |

What the scenario counts do NOT measure: the brief mode. Its effect is measured separately by the conversation suite (`tests/agent-understanding-conversation.test.ts`, 29 tests): vague → the model's own question, clear → no redundant question, follow-ups and corrections revise the same request, the final request is planned by the worker's real `runPlanning` over stored TikTok pages with the asked scope and price and no hold. Those tests prove the backend's behaviour around a **scripted** model; they do not prove what the real model writes. The remaining six flag-ON gaps (sa-04, sa-06, cm-08, rt-03 in particular) are exactly the phrasing the brief's consolidation is meant to normalize, but that depends on the real model and is **not measured**.

## 5. Not tested / not done

* The real chat model in brief mode (wording, how often its brief passes validation, latency, real token use): no paid call was made. First evaluate on the test account with the SQL above.
* The live site, the chat page in a browser with a stored brief (the page ignores `plan.researchBrief`; read from the code only).
* pl-19 (Reddit sent to the model planner), pl-15 (X comments), topics with no marker without the brief: not changed.
* A worker that already started planning an earlier version of the request is not stopped (its writes are unconditional; changing that is a worker change outside this scope): the customer is told, and nothing of it runs without their approval.
