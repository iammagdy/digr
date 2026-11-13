# Spend gate threat model (round 61, 14 Nov 2026)

Status: **analysis. Nothing here is enforced in production.**

* Base: production `adb22f8`, read from the code.
* No paid call, no database change.
* The design that answers it is `SPEC-v2.md`.

## What is protected, from what

**The asset.** Owner money spent on providers (TREG, Context.dev, Firecrawl) and on models (Anthropic) on the owner's behalf.

* Customer points, held in `credit_ledger`, are a separate asset.
* The gate never reads or writes them (§13).

**The property wanted.** Total paid spend in a window ≤ the amount the owner authorized for that window.

* The authorization exists only if the owner issued it.
* It can be raised only by the owner.
* When it is missing, closed or exhausted, nothing is spent.

**Out of scope.** These are said plainly so they are not assumed covered:

* A fully compromised server process. It holds the provider keys and the Anthropic key, so it can call providers without asking any gate. Only provider-side limits stop that (§9).
* Anthropic's or a provider's own billing errors.

## Threats

| # | Threat | Today (`adb22f8`) | v2 control | Residual risk |
|---|---|---|---|---|
| 1 | **Concurrent workers**: several missions at once | Each run has its own in-memory budget (`createJobCallBudget`), and nothing caps their sum. The provider daily cap sums `provider_costs` under one advisory lock, but its cap is a caller argument (`p_daily_cap_usd DEFAULT 0.80`). | One grant row, locked `FOR UPDATE` by every reservation. `reserved + spent + bound ≤ ceiling` is checked and written in one transaction. | Every paid call waits on one row lock. That is milliseconds at this volume (§4). |
| 2 | **One mission on two workers** (lease lapse, restart overlap) | Two in-memory budgets, each believing it has the whole 40%. | The per-mission maximum is counted in the database across workers. | None for money; the mission fence is a separate issue. |
| 3 | **Website chat** and the other model calls of the website | 8 direct model call sites (§7 of SPEC-v2). Chat replies are not recorded in `llm_usage`. No per-call budget. | Kind `chat`/`model`. Each call goes through `guardedPaidCall` with `modelRequestBound`. | **Not wired yet.** Until it is, a grant must be described as covering missions only, never "the platform". |
| 4 | **Evaluation calls** | Run from a development session with a real key. The budget is a local file (`evals/live-intelligence/budget.ts`). | Kind `eval`, reserved against an owner grant that names `eval`. | An eval run with a raw key bypasses any gate. Only the provider-side limit stops it. |
| 5 | **Restarts and crashes** | The in-memory budget is rebuilt from recorded spend. A call in flight at the crash is lost. | A held reservation is in the database. It **expires as spent**, never released. Every reserve expires stale ones first. | Over-counting by the bounds of the calls in flight at a crash. Conservative. |
| 6 | **Lost responses** | A provider timeout is recorded at $0 in `provider_costs`. Round 60 counts it at its estimate in the mission budget only. | Provider or model no-answer: settled as unknown, so the whole bound stays spent. | None for the ceiling. |
| 6a | Lost answer to *reserve* | — | Same idempotency key, same reservation, no double hold. In enforce mode the call is not made; if the reservation existed it expires as spent. | None. |
| 6b | Lost answer to *settle* | — | Settle is idempotent. An unsettled reservation expires as spent. | None. |
| 7 | **The privileged service key** (`service_role`, held by the worker and the website) | It can pass any `p_daily_cap_usd`. It can write every public table. The v1 spec admitted it could write the scope tables directly, so the worker could raise its own ceiling. | Grants live in schema `spend_gate`: no privilege for `service_role`, `authenticated` or `anon`, and not exposed by the API. `service_role` may only execute `reserve`, `settle`, `stop` and a read of its own state. Issuing, raising or extending a grant needs the owner's database role (§5 of SPEC-v2). The SQL tests prove `service_role` cannot do it. | (a) The provider keys themselves (out of scope above). (b) `settle` with an under-reported charge: a dishonest caller can report $0. Detected only by reconciliation against the providers' free usage APIs (owner decision). |
| 8 | **Retries** | Provider retries and SDK retries are invisible to the mission budget until settled. | Every provider attempt is a new reservation with a new key. Every SDK retry is a new HTTP request through the model gate, so a new reservation. A *database* retry reuses the key. | Retries of 5xx answers keep their bound (conservative) and can exhaust a small grant during an outage. Owner decision 7. |
| 9 | **Spend above the estimate** | Settle adds what the provider reports, even above the estimate. The v1 spec let a scope "pass its ceiling once". | A reservation is an **upper bound**, or the operation is refused (`no_safe_bound`). An actual above the bound counts the bound, records the excess as `overrun` and **trips** the grant. | The excess of the calls in flight when the first violation lands. Zero while the bounds hold. |
| 10 | **Model cost** | `maxBudgetUsd` per run, checked by the SDK **after** a turn, and given again to each round (round 59). | The loopback model gate reserves the bound of **each request** before it leaves. The SDK child holds only the gate's token. | The input bound assumes tokens ≤ bytes + 4,096. It is checked on every answer, and a violation trips the grant. |
| 11 | **Implicit authorization** | v1 created a mission scope "at approval … or by the worker", and auto-created scopes for running missions. | Nothing is created when a mission starts. The per-mission maximum is a field of the owner's grant. No grant means no spend. | None. |
| 12 | **Flag misconfiguration** | — | `DIGER_SPEND_GATE` unset or off: today's behaviour. Any unknown value: enforce (fails closed). | A typo stops spending instead of allowing it. |
| 13 | **Customer money confused with owner money** | — | Separate schema. No function of the gate touches `credit_ledger`, `accept_quote_atomic`, `settle_job_atomic` or `release_job_atomic`. A test hashes those function bodies and counts ledger rows before and after. | None. |
| 14 | **Kill switch abuse** | — | `stop()` can only trip the open grant: it only stops spending. | A compromised service role can halt spending. It can already halt the service. |
| 15 | **Time** | — | Windows and expiry use the database clock (`now()`), never the worker's. | None. |

## What is honest to claim after activation, and what is not

**Honest to claim, after migration, configuration and failure tests are authorized and verified in production:**

* "Mission provider calls and mission model requests are refused before they are sent once the owner's grant would be exceeded."
* For the model part: "subject to the token bound, which is checked on every answer".

**Not honest, at any point in round 61:**

* "Budget enforcement is live." Nothing is applied.
* "The platform cannot spend more than X." The website's model calls, evaluations, and keys used outside the gate are not covered.
