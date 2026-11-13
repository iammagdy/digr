# Proposal: a hard pre-call spend gate for a running mission (NOT APPLIED)

Status: **proposal only, for the owner.** It changes spending authorization and needs a database function, so it is not built. Nothing here changes a price, a hold, a charge, a settlement, a ledger row or a permission.

## Why: what msn_088c actually spent (13 Nov 2026)

Measured from the mission's own `mission_calls` rows. Pinned offline in `tests/cost-audit-r59.test.ts` with `tests/fixtures/msn-088c-calls.json`.

| | USD |
|---|---|
| Plan's provider estimate (9 contact rows × one $0.00254 page) | 0.0229 |
| Execution provider spend (40 calls, 37 paid) | 0.0940 |
| of which: 16 paid calls that returned nothing ("empty") | 0.0406 |
| of which: re-reads of a page already bought (24 calls) | 0.0610 |
| of which: calls for a company not in the delivered file (5 calls, first-cosmetics.com) | 0.0127 |
| One read per page for the same 13 pages | 0.0330 |
| One read per page, delivered companies only (11 pages) | 0.0279 |
| Planning (providers + model) | 0.0267 |
| Execution model | 0.0245 |

The categories overlap: an empty call can also be a re-read.

### Causes, in order of money

1. **The same page was bought up to three times.** The `parse_page` tool tells the model to use `emails`, `phone-numbers` and `links` "of the ONE page you give". Each parser is a separate Context.dev page fetch at one credit.
   * For six companies the model read the home page with all three parsers.
   * It then read the contact page with `emails` and `phone-numbers`, and finally with a plain `scrape` "because the parsers returned only masked values".
   * No call repeated the same parser and page, so the existing rules (Firecrawl after Context.dev, the planning repeat-sample cap) never applied.
2. **Empty calls are billed by the provider.** A page is fetched before the parser looks for an e-mail. Finding nothing still costs the credit. The record is right: `cost_basis: "reported"`. The 3 failed calls (site unreachable) cost $0, also right.
3. **Contact reads for a company the file does not carry.** first-cosmetics.com was read 5 times after the 9 companies were saved. Its contacts could never be delivered.
4. **The estimate counts one page per contact row.** The planned procedure, as the tool describes it, reads 4–6 pages per company. The estimate was therefore 4.1× low by construction, not by chance.

### Did any check fail open?

**Provider calls: no.** The execution ceiling is 40% of the hold's value: `executionBudgetUsd(310)` = $0.2255. It is checked before every call, counts calls in flight, and counts an unknown cost at its estimate. Spend stayed at $0.094, inside it.

The gap is what the ceiling is tied to. It comes from the customer's points. No code knows the owner's incremental API authorization ($0.20 for the round, $0.1265 left at approval). This mission's own ceiling was already above what was left.

Three further gaps (documented, not changed):

* **Model budget is per round, not per mission.** `maxBudgetUsd = max($0.10, 5% of hold value)` is handed to every execution round. With `AGENT_EXECUTION_CONTINUE_ROUNDS = 2` one mission may spend up to $0.30 on the model.
* **The SDK checks `maxBudgetUsd` after a turn.** One turn can overshoot.
* **Chat replies on the website are not recorded in `llm_usage`.** The owner's spend is therefore under-reported by them (under $0.005 this round).
* **Unknown catalog prices.** A TREG endpoint without a catalog price is budgeted at a flat $0.01 (`GATEWAY_UNKNOWN_PRICE_ESTIMATE_USD`). This is not an upper bound.

## The gate (design)

One function decides every paid operation **before** it is sent: provider call, model turn, review batch, chat reply, or evaluation call.

```
authorize(op) -> { ok: true, reservation_id } | { ok: false, reason }
settle(reservation_id, actual_usd | null)
```

### 1. Ceilings

An operation is refused if, after it, any of these would be passed:

| Ceiling | Value | Who sets it |
|---|---|---|
| a. Mission ceiling | min(owner-approved multiple × the plan's estimate, 40% of the hold's value), covering providers and model together | owner |
| b. Owner authorization | a USD amount with a start time, counting every paid operation of the platform (missions, chat, evaluations, reviews) | owner, per round |
| c. Provider daily caps | as today | as today |

The multiple in (a) is an owner decision, for example 2×. With an honest estimate (step 4) it can be tight.

### 2. Atomic, durable reservation

* The check-and-reserve is one SQL statement in one transaction, for example a new `reserve_spend_atomic(scope_ids[], usd)`:

  ```sql
  UPDATE … SET reserved = reserved + $usd
  WHERE spent + reserved + $usd <= ceiling
  RETURNING …
  ```

  It runs over a `spend_scopes` row per ceiling. The existing `reserve_provider_spend_atomic` already does this for the daily caps.
* Two workers, a worker restart, or a chat request at the same moment then cannot both pass. Today's mission budget is in memory, rebuilt from the record at start. It is correct for one process, but not across processes or across missions.
* The database must be readable for a reservation to succeed. If the gate cannot answer, the operation is refused (fail closed), as `recording_unavailable` does today.

### 3. Uncertain cost

* **The reservation is the upper bound, not a guess.**
  * Provider call: the documented maximum credits × the price.
  * Model turn: max output tokens × output price + the input already known.
* A call whose price is unknown is **refused in execution**. In planning it is allowed at a cap the owner sets.
* `settle(actual)` releases the difference.
* `settle(null)`, where the provider may have billed but did not say, keeps the full reservation.
* A provider failure releases the reservation only when the provider's answer proves no charge, for example a connection that never opened or a documented free error. A timeout keeps it.

### 4. Retries and repeats

* A retry is a new operation with its own reservation. It is never free.
* At most **1 retry** per (endpoint, input) after a transient failure, and **0** after an empty answer.
* **One paid fetch per page per mission.** A second paid read of a page the mission already bought is refused. The worker gives the model the saved answer instead, with e-mails, phones and links extracted from the saved page text by code.
  * For msn_088c this alone would have cost $0.0330 instead of $0.0940.
  * Behaviour change: it needs a measured comparison of contact coverage on recorded pages before switching on.
* **No reads for a row that is not in the item store.** A detail step may fetch only for parents already saved. It would have saved $0.0127 here.

### 5. The plan's estimate counts what the procedure does

The planner's estimate for a web-contact step would be:

```
pages_per_parent × parents × price
```

* `pages_per_parent` is measured from recorded executions: 37 paid / 9 companies ≈ 4.1 today, about 1.4 with the page rule.
* This changes the price shown to the customer through `providerCostUsd`. It is a **pricing change** and needs a separate owner decision. It is listed here only because the gate's mission ceiling (a) depends on an honest estimate.

### 6. When a ceiling is reached

The gate refuses, as `over_budget` is today. The mission settles on what it delivered with the existing settlement: charge = ceil(delivered × unit), the rest released. The customer reads the existing sentence for a stopped job. No settlement change is needed.

### 7. Model spend

* One mission-level model reservation is drawn by every round, not a fresh budget per round.
* Each turn reserves its upper bound before it is sent. The SDK's own `maxBudgetUsd` stays as a second guard.
* Chat replies and evaluations reserve against ceiling (b) and are recorded in `llm_usage`.

## What needs the owner

1. **Approve ceiling (b):** the owner authorization as a platform input, and who may raise it.
2. **Approve the mission multiple (a)** and whether model spend counts in it.
3. **Approve the new SQL function and table** (`spend_scopes`, `reserve_spend_atomic`). This is a database permission and infrastructure change.
4. **Approve "one paid fetch per page"** after an offline coverage comparison.
5. **Approve the estimate change (5).** It moves customer prices, so it is a separate pricing decision.

None of this was applied in round 59.
