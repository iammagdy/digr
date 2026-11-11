# Semantic integration v1 (PR-1.2): the reading inside the real request contract

**Flag `semantic_normalization_v1`: OFF by default. Nothing in the repository, the database or the environment sets it. With it OFF the worker and the server read every request exactly as before (tested). Fixed for ordinary customers today: 0.**

## What is connected

```
customer message → privacy guards (guardRules.ts, #447; do not read the flag)
→ mission row (request_text stored as typed, never replaced)
→ worker runPlanning: settings read ONCE → flag → buildRequestContract(request, answer, { semantic })
   ├ platform decision / platform question / route (runMission.ts)
   └ planByCompiler({ semantic }) → buildAsk(..., { semantic }) → the plan: stages, engine params, price
→ plan_ready (the customer sees the plan and its price) → approval → execution runs the STORED plan
```

| Place | Change |
|---|---|
| `requestContract.ts` | `buildRequestContract(request, answer, { semantic })` and `buildRequestContractWithReport`. The ONE place the reading joins the contract. OFF: byte-for-byte as before. |
| `semantic/contractFill.ts` | The rule, **fill-only** (below). Pure. |
| `foundation/ask.ts` | `buildAsk(..., edits, { semantic })` passes it to the contract (the Ask is what the compiler reads). |
| `agent/src/runMission.ts` | Reads `agent_settings` once at the top of the planning run (the read that was lower down moved up, one read still), takes the flag with `readSemanticNormalizationFlag`, uses it for the three contract reads and hands it to the compiler. |
| `agent/src/compiled.ts` | `deps.semantic` → `buildAsk`. |
| `stage2/askEditAction.ts` | The server's «فهمنا طلبك» card re-derives the Ask from the words; it reads the SAME key with `readSemanticNormalizationFlagFromClient` so the card and the plan cannot disagree. |

Execution does not re-read the request: it runs the stored plan (platform and parameters are in it), so planning and execution cannot disagree about the flag. Only `askedTextOf` consumers (people nouns, contact lookups) read the text, and they are untouched.

## The fill-only rule (`contractFill.ts`)

* The parser stays authoritative: a value it produced is kept.
* **Fill** a field it left empty, only from an unambiguous reading: platform, comments, replies, parent kind, topic. Never from `ambiguous`, `multiple` or `none`.
* **Tighten** a topic it over-read: «السياحة والردود» → «السياحة», «السياحة بس استبعد …» → «السياحة» (an output field or an exclusion is never part of the topic). The topic also stops at the parser's own stop words (a country, a period, a language).
* **Clear** one wrong value: an X platform that only a bare «X» gave, when the words name it («مطعم اسمه X»).
* A disagreement keeps the parser's value and is reported by field name only (`report.disagreements`), never the customer's words.
* The topic keeps the customer's own letters and capitalization (`ChatGPT`). The stored request is never touched.

## Customer-visible effect (flag ON), verified through `runPlanning` over the stored live pages (no model, no provider, no network)

* «… تك توك …»: OFF the worker asks «من أنهي منصة؟». ON it plans the same plan (stages, parameters, price) as the stored «تيك توك» request.
* «… وهات الكومنتس والريبلايز»: OFF the comments and replies are **dropped silently** (a videos-only plan). ON the worker asks «كم تعليقًا تريد من كل فيديو؟» before any plan or price: a newly recognized stage never enters a plan, a price or a reservation without the customer's answer and approval.
* A request the parser already reads is planned identically ON and OFF.

## Measured on the 98 baseline scenarios, through the real contract and ask (`tests/semantic-contract-integration.test.ts`)

* Gaps before: **62**. **Fixed end to end with the flag ON: 23** (sa-01, sa-02, sa-03, sa-08, sb-09, pl-04, pl-05, pl-07, pl-11, pl-14, pl-16, pl-17, pl-22, pl-24, pl-25, cm-02, cm-05, cm-06, cm-09, ct-07, rt-04, rt-05, mt-09): every expected field of the case holds.
* **Partly improved: 4** (sa-04, sa-06: topic without a marker; pl-15: X has no comments stage in the contract; pl-23: the platform is read, the period is PR-1.3).
* **Unchanged: 34. Changed, still wrong: 1** (pl-21: the topic lost «in Egypt», the country gap remains).
* **Regressions: 0** (no scenario that was right OFF is wrong ON). **Fixed for ordinary customers while the flag is OFF: 0.**
* The 62 known gaps stay pinned for the OFF path (`semantic-paraphrases.test.ts` unchanged and green).

## Not fixed here, and why

* Dates, countries, languages (L4: dt-*, ct-04, ct-05, ct-10, sb-01, sb-02, pl-21, pl-23), e-mail wording (L6), pre-filter false positives (W1-W6) and message-type routing (L7): separate stages, not vocabulary.
* «١٠٠ كومنت» (a number in front of a Latin or Arabizi «comments» word): the per-parent count is read by Arabic «تعليق» patterns, so the worker asks how many (a visible question), it does not guess.
* X has no comments stage in the contract: «تعليقات X» keeps meaning no comments stage (existing behavior for an explicit X, now also reachable for «Twitter» spelled with a capital).
* The chat model and the keyword classifier (`classifyMessage`) decide whether a message is a data request BEFORE any of this; they are not changed.

## Safety

* PR #447 untouched: `guardRules.ts`, `chatTurn.ts`, `customerActions.ts`, `messageType.ts` do not read the flag or import this layer (tested). The guard runs first and independently; the reading cannot override a refusal. The personal-contact rule is still enforced in the chat only (as before).
* No money, pricing, ledger, provider, TREG, schema, auth or deployment change. No test-account mode: the server card has no verified test-account signal, so the flag is a single global switch read by one reader on both sides; enabling it is an owner action in `agent_settings`.
