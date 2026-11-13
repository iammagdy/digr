# Hard spend gate: implementation-ready specification (NOT APPLIED)

Status: **SUPERSEDED by `docs/proposals/spend-gate/SPEC-v2.md` (round 61).** v1 let a settle pass the ceiling, relied on `maxBudgetUsd` for the model, left the scope tables writable by `service_role`, and created mission scopes implicitly; v2 fixes all four (see its §0). Kept for the record.

Original status: **specification for owner review.** No SQL, migration, grant, pricing or settlement change was made. It refines `docs/proposals/execution-spend-gate.md` (round 59) after reading the code as it is on `9974769`.

## 0. What exists today (read from the code, not assumed)

| Piece | Where | What it does | Gap |
|---|---|---|---|
| Mission provider budget | `src/lib/server/callBudget.ts` `createJobCallBudget`, used by `agent/src/gateway.ts` and `agent/src/webGateway.ts` | In memory, per run, rebuilt from recorded spend. Checked before every TREG and web call. Counts calls in flight. | Not durable and not shared across processes. Its ceiling is 40% of the hold's value, unrelated to the owner's authorization. |
| Provider daily cap | `reserve_provider_spend_atomic` (`supabase/migrations/20261016205259_fix_provider_spend_scope.sql`) | `SECURITY DEFINER`, one global advisory lock, sums today's `provider_costs`, inserts a reservation row. Granted to `service_role` only. | **The cap is a parameter the caller passes** (`p_daily_cap_usd DEFAULT 0.80`): any caller holding the service key sets its own cap. Daily only, providers only. |
| Model budget | `agent/src/runMission.ts` `maxBudgetUsd` | The SDK stops a run after a turn passes it. Planning gets $0.30, each execution round gets max($0.10, 5% of hold value). | Per round, not per mission (up to $0.30 per execution). Checked after the turn. Website chat replies are not recorded in `llm_usage`. |
| No-answer calls | `src/lib/server/multiProvider/httpCall.ts` | A timeout or dropped connection is recorded at $0 in `provider_costs`. | The provider may have billed it. Round 60 counts it at its estimate in the mission budget only (`webGateway.ts`, `charge_unknown`). The ledger row is unchanged. |
| Unknown price | `GATEWAY_UNKNOWN_PRICE_ESTIMATE_USD = 0.01` | Flat guess. | Not an upper bound. |

## 1. Ceilings (data, owned by the owner)

Ceilings are stored in a table and never passed by a caller.

```
spend_scopes(
  id text primary key,                 -- 'owner:2026-11-r60', 'mission:msn_…', 'provider:contextdev:2026-11-14', 'model:2026-11-14'
  kind text check (kind in ('owner','mission','provider_day','model_day')),
  ceiling_usd numeric(12,6) not null check (ceiling_usd >= 0),
  reserved_usd numeric(12,6) not null default 0 check (reserved_usd >= 0),
  spent_usd numeric(12,6) not null default 0 check (spent_usd >= 0),
  opens_at timestamptz not null, closes_at timestamptz,          -- an owner authorization has a window
  created_by text not null, created_at timestamptz default now(),
  check (reserved_usd + spent_usd <= ceiling_usd + 0.000001)     -- the invariant the gate keeps
)
spend_reservations(
  id uuid primary key, scope_ids text[] not null, usd numeric(12,6) not null check (usd > 0),
  op text not null,                     -- 'provider:contextdev.scrape', 'model:execution_turn', 'chat:reply', 'eval'
  mission_id text, call_ref text,       -- the mission_calls id or llm_usage id it becomes
  state text not null check (state in ('held','settled','released','expired')),
  actual_usd numeric(12,6), charge_known boolean,
  held_at timestamptz default now(), settled_at timestamptz, expires_at timestamptz not null
)
```

* **Owner scope.** One open `owner` scope at a time, for example "$0.20 for round 60". Every paid operation of the platform draws from it: missions, chat replies, reviews, evaluations, translations, planning. A closed or exhausted owner scope refuses everything paid.
* **Mission scope.** Created at approval, inside `accept_quote_atomic`'s transaction or right after it by the worker:

  ```
  ceiling = min(owner multiple × plan estimate (providers + model), 40% of hold value)
  ```

  The owner multiple is an owner decision, for example 2.0. Providers and model are counted together.
* **Day scopes.** A provider-day scope replaces `p_daily_cap_usd`. A model-day scope is new.

## 2. The two functions

```
reserve_spend(p_scope_ids text[], p_usd numeric, p_op text, p_mission text, p_ttl_seconds int) returns jsonb
  -- one transaction:
  --   SELECT … FROM spend_scopes WHERE id = ANY(p_scope_ids) ORDER BY id FOR UPDATE   (row locks, fixed order: no deadlock; no global advisory lock)
  --   refuse (no row written) if any scope is missing, closed, or reserved + spent + p_usd > ceiling
  --   else reserved_usd += p_usd on every scope; INSERT spend_reservations(state 'held', expires_at = now() + ttl)
  --   returns {ok, reservation_id} | {ok:false, reason:'scope_missing'|'scope_closed'|'over_ceiling', scope_id}
settle_spend(p_reservation uuid, p_actual numeric, p_charge_known boolean) returns jsonb
  -- one transaction, idempotent (a settled or released reservation is returned as it is):
  --   charge_known = false        -> actual := reserved usd (an uncertain charge keeps the whole reservation)
  --   actual > reserved           -> spent += actual (the overrun is recorded, never hidden); the scope may pass its ceiling once, by at most one call's error; flagged for the admin
  --   otherwise                   -> reserved -= usd, spent += actual on every scope; state 'settled'
```

* **Expiry.** A reservation still `held` at `expires_at` (a worker that died mid-call) moves to `expired`. It keeps its whole amount as spent, the conservative side, because the call may have gone out. A scheduled `expire_spend()` (pg_cron or the worker's heartbeat) does this. It never releases.
* **Concurrency.** Row locks on the scopes involved serialize only the operations that share a scope. Two missions share the owner and day scopes but not their mission scopes. The order of locks is fixed, sorted by id.
* **Fail closed.** The worker and the website treat any error, timeout (2 s) or missing answer from `reserve_spend` as a refusal. The paid call is not made. A database outage therefore stops spending, never allows it.

## 3. What a reservation is worth: the upper bound, never the estimate

| Operation | Reserved amount |
|---|---|
| Context.dev page (`page.read`, a field parser) | 1 credit = $0.00254 (documented flat). A 404 also keeps 1 credit. |
| Context.dev people search | 10 credits per page (documented). |
| Firecrawl scrape / search | 1 credit / 2 credits per 10 results, at the configured price. |
| TREG endpoint with a catalog price | `callEstimateUsd` at the page size **asked for** (`limit`), not the expected rows. |
| TREG endpoint with **no** price | **Refused in execution.** In planning, at most the owner's "unpriced sample" amount (proposed $0.02) and only once per endpoint. |
| Model turn | (input tokens known) × input price + `max_tokens` × output price, at the model's own price table. |
| Chat reply on the website | The same, with the reply's `max_tokens`. |
| Review batch | Its `max_tokens` bound. |

`settle_spend` then records the actual charge the provider or API reported (`credits_consumed`, usage). When nothing was reported, `charge_known = false` and the whole reservation stays.

## 4. Retries and failures

* A retry is a new `reserve_spend`. Nothing is free.
* Per (mission, endpoint, input): at most one retry after a passing failure (timeout, 5xx, network), none after a definitive one (404, blocked, bad input). The round-60 page cache already enforces this for pages (`PAGE_MAX_ATTEMPTS = 2`).
* A failed call that the provider reports as free (Context.dev reports `credits_consumed: 0` on most errors) settles at 0. A call with no answer settles at its reservation (`charge_known = false`).

## 5. Call sites (code changes, after approval)

1. `agent/src/gateway.ts` and `agent/src/webGateway.ts`, `execute`: call `reserve_spend([owner, mission, provider_day])` before the call, then `settle_spend` after it. The in-memory budget stays as a second, faster guard.
2. `agent/src/runMission.ts`: one mission model scope drawn by every round and turn. A turn hook reserves before each model request.
   * The Agent SDK has no pre-turn hook today. Until one is available, the run is started with `maxBudgetUsd = remaining mission model scope`, recomputed per round, so no round gets a fresh budget.
3. Website chat (`src/lib/server/invoices/chat/run.ts` and the conversation model): reserve before the model call. Refused → the existing "model unavailable" path, with a code answer. Record the reply in `llm_usage`.
4. Evaluations (`evals/…`): reserve from the owner scope. They replace the local budget files.

## 6. Settlement and release (unchanged money for the customer)

The gate never touches `credit_ledger`, `accept_quote_atomic`, `settle_job_atomic` or `release_job_atomic`. When a mission is refused by the gate, it ends as a job stopped by `over_budget` does today:

* charge = ceil(delivered × unit), the rest of the hold released;
* nothing delivered → full release, and the customer reads `JOB_BUDGET_STOP_AR`.

The mission scope is closed after settlement, and its unspent ceiling is simply never used.

## 7. Security

* **`SECURITY DEFINER` risks.**
  * Both functions run as owner. They must set `search_path = public, pg_temp`, like the existing functions.
  * They must validate every argument: `p_usd > 0` and at most a per-op maximum ($1), and known scope ids.
  * They must never take a ceiling from the caller.
  * They must not be callable by `anon` or `authenticated`.
* **Grants.**
  * `REVOKE ALL … FROM PUBLIC, anon, authenticated`.
  * `GRANT EXECUTE … TO service_role`.
  * The tables get RLS on, with no policies. Only the definer functions and `service_role` read them.
* **Who changes a ceiling.** Only a separate admin function, `set_spend_ceiling(scope_id, usd, reason)`, which checks `app_metadata.role = 'admin'` of the caller's JWT on the website path. Every change is written to an audit table.
* **What the service key cannot do.** Unlike today, it cannot set its own cap through a parameter. It can still write tables directly, which is unchanged and inherent to `service_role`.

## 8. Migration and rollback

1. **Migration A (additive).** Create the tables, the functions, `expire_spend`, the grants, and the indexes on `spend_reservations(state, expires_at)` and `(mission_id)`. No existing function changes. Rollback: drop them.
2. **Code B, behind `DIGER_SPEND_GATE=observe`.** Reserve and settle are called and recorded, but a refusal is only logged. This measures for a week whether the ceilings would have refused anything.
3. **Code C, `DIGER_SPEND_GATE=enforce`.** Refusals stop calls. Rollback: set the variable to `observe` (a Heroku/Vercel config change, an owner action).
4. **Migration D (later).** `reserve_provider_spend_atomic` reads its cap from the provider-day scope instead of the parameter. Rollback: restore the previous function body, kept in the migration file.

**Missions already running when C ships:** a mission with no mission scope gets one created on its next call, using `min(40% hold value − its recorded spend, owner remaining)`. It is never refused retroactively for spend before the scope existed.

## 9. Tests required before enforcement

* Concurrency: two missions × 50 parallel reservations against one owner scope never exceed the ceiling (database test on the replica).
* A worker killed between reserve and settle: the reservation expires as spent.
* Database unavailable: zero paid calls are sent (worker and website).
* A no-answer call keeps its reservation. A reported $0 failure releases it.
* An unpriced TREG endpoint in execution is refused.
* The existing settlement tests are unchanged: no ledger row differs.

## 10. Requires owner approval (none applied)

1. The owner scope as a platform input: the amount, its window, and who may open or raise it.
2. The mission multiple of the plan estimate, and that model spend counts in the same mission ceiling.
3. Migrations A and D (new tables, functions, grants, RLS) and the cron job for expiry. These are database and infrastructure changes.
4. `DIGER_SPEND_GATE` on Heroku and Vercel, observe then enforce. This is a configuration change.
5. Refusing unpriced TREG endpoints in execution, and the planning "unpriced sample" amount.
6. Recording website chat replies in `llm_usage`. This changes what the owner's cost reports include.
7. Whether a no-answer provider call should also be recorded at its estimate in `provider_costs`. That is accounting; round 60 changed only the mission budget.
8. An honest plan estimate (pages per company, measured). This moves customer prices, so it is a pricing decision.
