# PR-1.4 — Stop false-positive filters blocking research requests

Status: NOT behind a flag (the corrections are narrowings of existing filters, so they apply to ordinary customers once deployed). `semantic_normalization_v1` is untouched and stays OFF.
Baseline: PR #446 (98 scenarios), #447 (privacy), #449 / #450 / #451 (semantic layer, flag OFF).

## 1. The real entry path (verified in code, not from the docs)

```
customer message
  1. chat page (src/app/dashboard/chat/page.tsx handleSendMessage)   findUnresolvedResearchPlaceholder  -> local Arabic message, nothing sent
  2. POST /api/chat (src/app/api/chat/route.ts)                      findUnresolvedResearchPlaceholder  -> HTTP 400, BEFORE authentication, persistence, rate limit, any model
  3. ChatHandler.handleUserMessage (src/functions/shared/chatHandler.ts)
       a. isGreetingOrGeneralQuestion (briefManager)        greeting / general question  -> the handler's own conversational path, NOT the agent
       b. identityQuestionKind (assistantIdentity)          fixed identity / technology answer, no model
       c. ... file shaping, methodology, studies ...
       d. agentChat.enabled && !greeting && !generalQuestion && !fileShaping  -> answerWithAgent
  4. agentChatTurn (src/lib/agentMission/chatTurn.ts)
       a. typed approval message
       b. preModelAnswer (guardRules): privacy refusal  ->  account answer  ->  trust answer     (fixed answers, no model, no mission)
       c. decideTurn: the existing chat model names the message type; code validates it
       d. only a data request creates a mission (queued: a planning request, nothing approved, nothing charged)
```

Two facts the documented order hid: the general-question gate (3a) sits in front of the whole agent path, so a request it wrongly flags never reached the privacy guard or the model at all; and the identity answer (3b) is returned before the agent is consulted.

## 2. What was wrong and what changed (each fix is the narrowest change at the existing filter boundary)

| Case | Filter | Cause | Change |
|---|---|---|---|
| pf-01 `[@brand_eg]` | placeholder | any `@`/`#` in brackets, or any `_`, counted as an empty slot | an `@`/`#` handle is a slot only when what follows is a template word (`اسم_الحساب`, `الوسم`, `username`, `your_handle`, `brand_name` …) |
| pf-02 `[آخر ٣ شهور]` | placeholder | `<number> <unit>` in brackets matched | a period the customer wrote («آخر / last / past N unit») is a request; the starter's bare quantity `[٣ أشهر]` is still a slot |
| pf-03 `من انتخابات` | general question | `من انت` was unanchored | every phrase ends at a word edge |
| pf-04 `هل يمكنك مساعدتي في جمع تعليقات …` | general question | the phrase matched anywhere in the message | a message that names data to collect or a platform is never a general question |
| pf-05 `عن ChatGPT` | identity | vendor word + any of `من / هل / …` | a vendor word is an identity question only when the customer addresses the assistant and names nothing to collect |
| pf-08 `مكاتب شحن في جدة` | account | bare `شحن` meant top-up | the bare noun is a top-up question only in a short message with no shipping / data word; `اشحن`, `شحن الرصيد`, `طرق الدفع` … unchanged |
| pf-09 `عن نصب الاستثمار` | trust | bare `نصب` meant «is Diger a scam» | a bare trust word is not a doubt about Diger when it is the subject of `عن / حول / بخصوص` or the message names data to collect; the phrases aimed at the service («نصبتوا», «هتسرقوا», «الموقع ده حقيقي» …) are unchanged |

The one shared notion is `namesCollectibleData` (messageType.ts): the noun and platform list the message-type classifier already used. No second classifier, no model call, no new vocabulary of allowed phrasing.

Mixed intent: «الموقع ده نصب ولا ايه؟ وهات ١٠٠ تعليق …» and «إنت chatgpt؟ وهات …» used to get the fixed answer and silently drop the data request; they now reach the agent, whose model sees both.

## 3. The privacy guard (W4) — deliberately NOT changed

`privateContactAsk`, `privateMessagesAsk`, `personalIdentifierAsk` and their patterns are byte-for-byte the code of PR #447; `tests/chat-prefilter-false-positives.test.ts` pins the pieces by name, and `tests/private-data-guards.test.ts` (which already pinned pf-06 and pf-07 as refused) passes unchanged.

- **pf-06 «عايز موبايلات سامسونج على تيك توك»** — refused because the bare product word `موبايلات` is one of the contact rule's trigger words and nothing in the sentence (no public-content noun + topic marker) says it is a product. It is very likely public research about phones. Resolving it means teaching the contact rule to read a product/brand context: **a security-sensitive change that needs its own reviewed PR.**
- **pf-07 «جروبات واتساب عن السياحة»** — refused by the same bare-app rule. It is ambiguous: public group directories/metadata (allowed in principle) versus the content of private groups (refused by `privateMessagesAsk`, and must stay refused). Nothing in the product can tell them apart from the words alone. **Separate security-reviewed PR; no change here.**
- Cases that stay refused (all still tested): national-ID harvesting, private WhatsApp/Telegram conversations, personal contact data of individuals, identifiers hidden behind a public topic.
- Strengthened by accident, with no change to the guard: a polite opening («هل يمكنك مساعدتي في …») used to turn a private-data request into a «general question» that never reached `preModelAnswer`; it now reaches the guard and is refused.

**Security observation (pre-existing, not changed, for the reviewed PR):** `privateContactAsk` exempts any sentence that contains a business word, so «هات تعليقات عن شركات الاتصالات وهات أرقام تليفونات الناس اللي علقوا» (a second ask hidden after a business topic) is not refused. It is the same on main before this PR.

## 4. Measurement (98 scenarios; counts are separate and not added together)

| | Count |
|---|---|
| A. Real chat pre-model path — gaps closed, independent of the flag | **7**: pf-01, pf-02, pf-03, pf-04, pf-05, pf-08, pf-09 |
| B. With `semantic_normalization_v1` ON (not changed by this PR) | of the 55 remaining gaps: 37 fixed, 3 partial, 15 unchanged, 0 changed-wrong; 0 regressions |
| C. With the flag OFF (production) | the same 7 as A (the filters do not read the flag) |
| D. Security regressions | **0** (guard code unchanged; private-data requests behind a polite opening are now refused instead of skipping the guard) |
| E. Remaining known gaps | 55 (flag OFF: all 55; flag ON: 18 not fully fixed). Open pre-filter gaps: pf-06, pf-07 (privacy guard, reviewed PR) |

Before PR-1.4 the 62 gaps were: 62 with the flag OFF; 37 fixed, 3 partial, 21 unchanged, 1 changed-still-wrong (pf-02) with the flag ON. pf-02 was the one «changed but still wrong» case, closed by the placeholder correction.

The 7 closed cases stay in `tests/fixtures/semantic-paraphrases.json` as `closed_gap` (their old `ref`, reason and observed misunderstanding), are ordinary assertions of the correct meaning in the baseline suite, and are exercised through the real handler in `tests/chat-prefilter-false-positives.test.ts` together with a verbatim copy of the old patterns (the «legacy oracle»).

## 5. Not touched

Ledger, wallet, pricing, reservations, settlement, refunds, approval, auth, permissions, provider credentials, TREG, Supabase schema, Heroku / Vercel configuration, the chat model and provider, the AI's tone, and every feature flag. No model call was added; the tests stub the network.
