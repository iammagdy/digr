# Round 57: the Egyptian-cosmetics customer journey (13 Nov 2026)

Conversation `98a724a3995b46579f82` (dedicated test account), production deployment `dpl_Ff5zJtJNF5mRdp4pSAXAMvX2J7Av`, research-brief mode OFF.

## What happened, turn by turn (Vercel runtime log `chat_message_type`, read before it expired; database read only)

| UTC | customer | log | what the customer got |
|---|---|---|---|
| 10:12:28 | original request | `data_request`, model | plan `msn_e925…`: 20 companies (maps) + 12 contact rows = 32 items, price up to 325, hold 374 |
| 10:14:41 | «مش عايز بيانات ملهاش علاقة» | `edit_of_open_request`, model | generic «use the edit button» |
| 10:14:54 | «إزاي هتتأكد …؟» | `other`, keyword, `unreadable` | «لم أفهم من رسالتك…» |
| 10:15:04 | «سيبه فاضي» | `other`, keyword, `http_503` | «لم أفهم من رسالتك…» |
| 10:15:14 | «نقلل التكلفة؟» | `service_question`, keyword, `http_503` | fixed price boilerplate |
| 10:15:35 | «البيانات دي جاية منين» | `data_request`, keyword, `http_503`, open plan_ready | NEW mission of that sentence alone; the plan was cancelled; the planner asked «من أي مصدر…» |
| 10:18:52 | «ترجع لي الخطة … ٣٢ شركة بـ ٣٢٥» | `data_request`, keyword, `http_503` | NEW mission of that sentence (subject «شركات ترجع الخطه كانت»), companies only, 200 (minimum) |
| 10:35:45 | «تعيد إصدار الخطة … 3 أعمدة» | `data_request`, keyword, `unreadable` | NEW mission: Cairo places 20 + e-mails 20 = 40 items, 437 / hold 502 |
| 10:44:38 | «الخطة دي مش اللي طلبته…» | `data_request`, keyword, `unreadable` | NEW mission: 32 companies + 32 e-mails + 32 phones = 96 items, 1110 / hold 1276 (still `plan_ready`) |

Seven of nine turns had no chat model (5× `http_503`, 3× `unreadable`). The test report said every plan was cancelled: the last one (`msn_8373…`) is still `plan_ready` because nothing cancelled it (no row was changed by this round). No ledger row was written on 13 Nov for this account.

## Root causes

1. **A follow-up became a new mission of its own words** (`chatTurn.ts`): with brief mode off, every `data_request` started `startMission(input, input.message)`, which cancelled the open plan and planned the fragment alone. When the model failed, the keyword rules read «عايز … البيانات» as a data request; the «WHEN UNSURE» overrule did the same even when the model answered correctly.
2. **Prose instead of the JSON line** (`conversationModel.ts`): with brief mode off the conversation was sent as real turns; after a few prose assistant messages the model answered in prose («unreadable»). Brief mode already sent it as a transcript in the system prompt; production did not. Offline replay with the real model reproduced it 8 times in 40 turns.
3. **No retry of a momentary outage** (`chatModel.ts`): one `503` sent the turn to the keyword rules.
4. **The model never saw the plan**: asked about sources it named TikTok and X; asked to bring back the plan it said none was shown; asked about duplicates it promised a de-duplication the plan never states.
5. **Every change without a number got the generic «use the button» line**; the card's editor can only toggle the columns it has, so «add phone, e-mail and source» could not be done there.
6. **Unapproved plans left alive**: the replace list did not include `queued`.

The price differences (325 → 200 → 437 → 1110) are four different plans of four different requests (two of them fragments), not one request priced four ways: the unit is every delivered item of every step (a company, a contact row of a company), as the approved pricing contract says. Nothing in the pricing was changed.

## Fix (PR A)

* `openPlanFacts.ts`: the open plan's PUBLIC facts (stages, counts, columns, how, assumptions, price, hold) go into the chat model's prompt, and their numbers pass the reply guard; code answers the same questions from the same facts when the model is unavailable (sources, relevance, missing fields, cost, price/hold).
* Two chat types that exist only with an open request: `open_request_question` (answered, nothing changes) and `cancel_open_request` (applied only when the words are explicit, `isExplicitCancel`, through the existing compare-and-set cancel).
* A change without a number is a REVISION: planned again from the whole request plus the change (`… تعديل العميل على نفس الطلب: …`); the replaced plan is cancelled in the open. Approvals and instructions to the system are never revisions. A made-up count changes nothing (as before).
* With an open request a follow-up never becomes a new mission of its own words; only a request that stands on its own (names what to collect, not about the plan) replaces the plan, as before.
* Transcript in the system prompt in every mode; one retry after a 5xx/529 within the same timeout; `queued` joins the replaceable (unheld) statuses.

## Measured (real `claude-haiku-5-5`, production configuration, `evals/customer-journey`)

16 cases (A question, B requirement, C revision, D cancel, E new request) × 2 repeats = 40 turns. Objective checks: plan kept when it must be, no fragment mission, no generic reply, the reply names what was asked, new mission only when allowed, Arabic, no Latin digit, no provider name.

| | baseline (main `6a644ef`) | final |
|---|---|---|
| turns passing every check | 11 / 40 | 40 / 40 |
| generic replies | 23 / 40 | 0 / 40 |
| plan kept / no fragment mission | 34 / 40 | 40 / 40 |
| reply names what was asked | 8 / 24 | 26 / 26 |
| model failures (unreadable / truncated) | 10 | 1 (truncated; answered from the plan by code) |

Spending: 134 paid attempts, $0.0743 in total for the round so far (cumulative ceiling set to $0.50 for this round). Qualitative review: replies are relevant and fluent; 3 of 40 contain a statement the plan's public facts do not support (twice «off-topic results are excluded», once «a company may appear twice»).
