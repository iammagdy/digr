# Hard spend gate, specification v2 (round 61): NOT APPLIED

Status: **for owner review. Nothing is enforced in production.**

* It supersedes `docs/proposals/spend-gate-spec.md` (round 60, v1).
* Threats: `THREAT-MODEL.md`.

**What exists as code, and where:**

* **PR A (this round, mergeable, unwired).** No production behaviour changes, which a test pins.
  * `src/lib/server/spendGate/bounds.ts`: provider bounds.
  * `src/lib/server/spendGate/modelBound.ts`: model request bounds.
  * `src/lib/server/spendGate/gate.ts`: the contract, the mode flag, `guardedPaidCall`, and an in-memory reference model of the SQL rules.
  * `agent/src/modelGate.ts`: the loopback model gate.
* **PR B (this round, NOT for merge until approved).**
  * `sql/001_spend_gate.sql` and its rollback.
  * The scratch-Postgres tests.
  * The database client.
  * The call-site wiring behind `DIGER_SPEND_GATE` (default off).

## 0. What v1 got wrong, and the fix

| v1 (round 60) | Why it is not a hard gate | v2 |
|---|---|---|
| `settle`: "actual > reserved → spent += actual; the scope may pass its ceiling once" | The ceiling is passed whenever an estimate is low. Today's estimates are low in four places (§3). | A reservation is an **upper bound**, or the operation is refused. Overrun: the bound counts, the excess is recorded in `overrun_usd`, and the grant **trips**. The invariant `reserved + spent ≤ ceiling` always holds. |
| Model: "start the run with `maxBudgetUsd` = remaining", the SDK having no pre-turn hook | `maxBudgetUsd` is checked after a turn. It cannot stop the request that passes it. | A loopback **model gate**, the only route the SDK child has to the API, reserves each request's bound before sending (§6). Measured with the real SDK. |
| `service_role` "can still write tables directly" | The worker could raise its own ceiling. | Grants live in schema `spend_gate`, where `service_role` has no privilege. Issuing needs the owner's database role (§5). |
| Mission scope "created at approval … or by the worker"; running missions get one "on their next call" | Starting a mission created authorization. | Nothing is created by a mission. The per-mission maximum is a field of the owner's grant. No grant means no spend (§2). |
| Expiry through `pg_cron` | An infrastructure dependency for safety. | Every `reserve` first expires stale reservations, **as spent**. A scheduled job is optional, for tidiness only. |

## 1. Principles

1. **A reservation is a provable upper bound.** Its reason is documented by the provider or enforced by the API. Otherwise the operation is refused (`no_safe_bound`).
2. **Authorization comes from the owner only.** It is a grant with an amount, a window, the kinds of spend it covers, a per-operation maximum and a per-mission maximum.
3. **Every doubt counts as spent:** no answer, a cut stream, an expired reservation, a settle that failed.
4. **Fail closed:**
   * any error or timeout (2 s) of the gate;
   * a missing, unopened, expired, revoked or tripped grant;
   * an unknown flag value.
5. **Customer money is not touched.**

## 2. Authorization: the grant

```
spend_gate.grants(
  id text pk, ceiling_usd > 0 and <= 50, per_op_max_usd > 0 and <= 1, per_mission_max_usd > 0 and <= ceiling,
  kinds text[] ⊆ {provider, model, chat, eval}, opens_at, closes_at <= opens_at + 31 days,
  reserved_usd, spent_usd, overrun_usd >= 0, state in (open, revoked, tripped),
  issued_by, issued_at, reason,
  check (reserved_usd + spent_usd <= ceiling_usd + 0.000001))
unique (state) where state = 'open'      -- one open grant at a time
```

* **Issuing is an owner act.** It is `spend_gate.issue_grant(...)`, executable only by the database owner role. That role is the one the owner reaches through the Supabase dashboard's SQL editor (an MFA-protected login) or the database password.
  * The application code holds no database password. A search of `src`, `agent/src`, `scripts` and the package files for `DATABASE_URL`/`POSTGRES_URL`/`PGPASSWORD` finds none.
  * The owner must confirm that no such variable is set on Heroku or Vercel. That is decision 4.
* **Revoking** (`spend_gate.revoke_grant`) is an owner act too.
* **Stopping** (`public.spend_stop`) is available to `service_role` because it can only trip the open grant: it only stops spending.
* **No grant is ever created, raised, reopened or extended by a mission, an approval, a worker, the website, or the migration itself.** Missions already running when the gate is enforced get no special scope. Their next paid call is refused unless an open grant covers it.

## 3. Bounds (what a reservation is worth)

| Operation | Bound | Reason it holds |
|---|---|---|
| Context.dev page read (`/web/scrape` markdown; round-60 field reads) | 1 credit ($0.00254); 2 with browser actions | Documented credits page |
| Context.dev people search | 10 credits fast, 50 ultra | Documented |
| Context.dev web search | ceil(limit/10) credits | Billed per block of 10 |
| **Context.dev prebuilt parsers** (maps, social, app stores, g2) | **none: refused** | The documentation states no credit cost (`sources.ts`) |
| Firecrawl scrape | 5 credits (stealth) unless `proxy: "basic"`; +4 for JSON | The adapter sends `proxy: "auto"`, which may escalate |
| Firecrawl search | 2 × ceil(limit/10) credits; refused if it also scrapes results | Documented |
| TREG call | the `X-Treg-Route-Max-Cost` sent, and the reservation must equal it | TREG documents the header as the ceiling of the routed call |
| Model request | (body bytes + 4,096) × dearest input rate (1.25×, or 2× with a one-hour cache) + max_tokens (lowered to the gate's cap) × output rate; long-context rates when the bound passes 100K on Haiku | `max_tokens` is enforced by the API. Input tokens ≤ bytes is an assumption, checked on every answer. |
| Model request with server tools, fast mode, fallbacks, threads, compaction, containers, MCP servers, service tier, region, images, documents, files | **none: refused** | They bill beyond the bytes |
| Any single operation above $1 | refused | The code's outer limit; the grant's `per_op_max_usd` may be lower |

**Four estimates of `adb22f8` that are not bounds** (tests `R61 bounds`):

1. The TREG route cap sent is `max(estimate, 0.001)`, while the estimate is what is reserved.
2. A search of 15 results reserves 1.5 blocks.
3. A Firecrawl scrape reserves 1 credit for a request that may use 5.
4. The prebuilt parsers reserve a guessed credit.

## 4. Reserve, settle, expire (one transaction each, idempotent)

**`public.spend_reserve(p_key, p_kind, p_op, p_bound_usd, p_mission_id, p_ttl_seconds) → jsonb`**

1. If `p_key` already exists:
   * the same reservation is returned when the amount, kind and mission are the same;
   * `key_conflict` otherwise.
2. The open grant is locked `FOR UPDATE`. None → `no_grant`. Outside its window → `grant_not_open` or `grant_expired`.
3. Its stale `held` reservations become `expired`, with the whole bound as spent.
4. Refused, with no row written, when any of these holds:
   * the kind is not covered;
   * the bound is ≤ 0, > `per_op_max_usd` or > $1;
   * the TTL is outside 5..900 s;
   * `reserved + spent + bound > ceiling`;
   * the mission's held + counted + overrun + bound > `per_mission_max_usd`.
5. Otherwise the reservation is inserted, `held`, with `expires_at = now() + ttl`, and `reserved_usd` is raised.

**`public.spend_settle(p_reservation, p_actual_usd) → jsonb`**

* `p_actual_usd` NULL means the charge is not known.
* A reservation that is not `held` is returned as it is (`replay`).
* If the reservation has passed its expiry, it expires as spent, and a late settle releases nothing.
* Unknown charge → counted = bound.
* Actual ≤ bound → counted = actual, and the rest is released.
* Actual > bound → counted = bound, `overrun_usd += actual − bound`, and the grant becomes `tripped`.

**Concurrency.** One row lock, on the open grant, serializes all reservations. This is tested with 2 × 100 parallel reservations from separate connections (PR B) and 400 in the reference model.

**Expiry.** Lazy, inside `reserve`. `spend_gate.expire_stale()` exists for an optional schedule.

## 5. Privileges (`sql/001_spend_gate.sql`)

**Ownership and the schema**

* `spend_gate_owner`, a `NOLOGIN` role, owns schema `spend_gate`, its tables and its functions.
* No one is granted membership in it.
* `REVOKE ALL ON SCHEMA spend_gate FROM PUBLIC, anon, authenticated, service_role`.
* The tables have RLS enabled with no policy, and no table privilege for anyone but the owner role.
* The schema is not in the API's exposed schemas, so PostgREST cannot reach it.

**The four `public.spend_*` functions**

* They are `SECURITY DEFINER`, owned by `spend_gate_owner`, with `SET search_path = pg_catalog, spend_gate, pg_temp`.
* `EXECUTE` is revoked from `PUBLIC`, `anon` and `authenticated`, and granted to `service_role` only.

**Owner-only functions**

* `spend_gate.issue_grant` and `spend_gate.revoke_grant` have `EXECUTE` granted only to `postgres`, the database owner role.
* Proven on a scratch Postgres 16:
  * `SET ROLE service_role` cannot call them;
  * it cannot read or write `spend_gate.*`;
  * it cannot call `issue_grant` through any public function.

**Validation**

* Every argument is validated: kind, bound, TTL, key length ≤ 200, op length ≤ 200.
* No ceiling or maximum is ever taken from a caller of the public functions.

## 6. The model: a hard per-request gate, measured with the real SDK

**Measured** on Agent SDK 0.3.312, against a fake upstream on 127.0.0.1, with no paid call:

* The SDK child sends every model request to `ANTHROPIC_BASE_URL`, plus one `HEAD /api/hello`.
* Each `/v1/messages?beta=true` request carries exactly these fields: `model, messages, system, tools, metadata, max_tokens (128000), thinking (adaptive), context_management (clear_thinking), output_config, stream`.

**How the gate works**

* `startModelGate` listens on loopback. The SDK child gets three things:
  * `ANTHROPIC_BASE_URL` pointing at the gate;
  * a random per-run token as `ANTHROPIC_API_KEY`. The real key stays in the worker, so the child **cannot reach the API except through the gate**;
  * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` = the cap.
* For each request:
  1. bound (§3);
  2. max_tokens lowered to the cap;
  3. reserve;
  4. send.
  * On refusal, it answers HTTP 400 and nothing is sent.
* After the answer:
  * the usage of the stream's `message_start` and `message_delta` settles the reservation;
  * a stream without `message_stop`, a cut or an error keeps the whole bound;
  * 400/401/403/404/413/429 release it;
  * other 5xx keep it.

**Measured with the real SDK** (`tests/spend-gate-r61-sdk.test.ts`, opt-in `DIGER_TEST_REAL_SDK=1`):

* **With a grant:** the run succeeds. Every request reaches the upstream with the real key and `max_tokens ≤ cap`, and the grant is charged by the usage.
* **Without a grant:** 3 requests (the SDK's own attempts), 3 refused, **0 forwarded**, $0. The run ends with `API Error: 400 spend_gate_refused: no_grant`.

**Exactly what is guaranteed**

* No model request of a gated mission run leaves the worker without a reservation of its bound.
* The output part of the bound is enforced by the API.
* The input part rests on «tokens ≤ bytes + 4,096». Every answer is checked against it, and a violation stops the grant (tested).
* `maxBudgetUsd` stays as a second, soft guard. **It is not a hard cap and is not described as one.**

**Not covered by the model gate.** These must be wired separately (§7):

* `agent/src/review.ts`, which calls the API directly from the worker;
* every website call.

## 7. Model call sites outside the SDK (inventory, `adb22f8`)

| File | What | Kind |
|---|---|---|
| `agent/src/review.ts` | Row review in the worker | model |
| `src/lib/agentMission/chatModel.ts` | Website chat replies (not in `llm_usage`) | chat |
| `src/lib/modelPlanner/transport.ts` | Website planner | model |
| `src/lib/server/companyRelevanceReview.ts`, `rowReviewAdvisor.ts`, `facebookReportAxisModel.ts`, `multiProvider/planRouting.ts`, `invoices/assist.ts` | Website reviews, routing, invoices | model |
| `src/functions/shared/llmClient.ts` | Functions | model |

Each one must call `guardedPaidCall` with `modelRequestBound` of its own body before it can be said to be gated. Until then, a grant covers **mission provider calls and mission SDK model requests**, and the owner's report must say so.

## 8. Evaluations

Evaluations reserve kind `eval` against a grant that names `eval`, through the same RPC. A local budget file is not an authorization. An evaluation run with a raw key bypasses the gate. The provider-side limit (decision 5) is the only control for that.

## 9. Modes and wiring (PR B)

**`DIGER_SPEND_GATE`**

* Unset, `off` or `0`: today's behaviour, byte for byte (tested).
* `observe`: reserve and settle run and are recorded. A refusal is logged, and the call proceeds unchanged. The model gate forwards the SDK's body unmodified.
* Any other value: enforce.

**Call sites**

* `agent/src/gateway.ts` (TREG): the reservation **equals** the route cap sent.
* `agent/src/webGateway.ts` (`execute`): the bound from §3. A parser with no bound is refused in enforce mode.
* `agent/src/sdkRuntime.ts`: the model gate's `childEnv` is merged into the SDK child's environment only when the mode is not off.

## 10. Migration and rollback

1. **`001_spend_gate.sql` (additive):** the role, the schema, the tables, the functions and the grants.
   * No existing function, table or grant is changed. `reserve_provider_spend_atomic` is untouched.
   * Rollback: `001_spend_gate.rollback.sql` drops the functions, then the schema, then the role. It refuses to run while a reservation is `held`, unless forced.
2. **`002_verify.sql`:** the read-only checks the owner runs after applying:
   * privileges;
   * no open grant;
   * the money function bodies unchanged.
3. **Configuration:** `DIGER_SPEND_GATE=observe` on Heroku, for one week, with an owner grant. Then `enforce`. Rollback: unset the variable.
4. **Later, separate:** `reserve_provider_spend_atomic` reads its cap from a grant instead of its argument.

## 11. Tests

**Done offline in round 61**

* `tests/spend-gate-r61.test.ts` (42):
  * bounds, model bounds;
  * the gate rules (no grant, window, kinds, 400 concurrent, idempotency, unknown charge, overrun trip, expiry, per mission);
  * modes;
  * the model gate against a fake upstream;
  * the not-wired pin.
* `tests/spend-gate-r61-sdk.test.ts` (2, opt-in): the real SDK through the gate.
* PR B: `tests/sql/spend-gate.local-pg.test.ts` on a scratch Postgres 16:
  * privileges;
  * parallel reservations from separate connections;
  * idempotency, overrun, expiry;
  * ledger and money functions unchanged;
  * rollback.

**Required in production before enforcement (owner-authorized, not done)**

* `002_verify.sql` returns all OK.
* One week of observe with zero unexplained refusals.
* A killed worker: its reservation is seen expiring as spent.
* The database made unreachable from the worker for one call (fail closed seen).
* A grant exhausted on a test mission (refused before sending, seen in the provider dashboards as no call).

## 12. Customer money

The gate never references `credit_ledger`, `accept_quote_atomic`, `settle_job_atomic` or `release_job_atomic`.

A mission refused by the gate ends as one stopped by `over_budget` does today:

* charge = ceil(delivered × unit);
* the rest is released;
* nothing delivered → full release and `JOB_BUDGET_STOP_AR`.

## 13. Owner decisions required (none applied)

1. **The first grant:** amount, window (≤ 31 days), kinds, per-operation maximum, per-mission maximum. Who may issue and revoke grants: the database owner role only.
2. **Apply `001_spend_gate.sql` to production**, then run `002_verify.sql`. This creates a role, a schema, 4 public functions and grants to `service_role`.
3. **Merge PR B** (the wiring, default off).
4. **Confirm that no database password or `DATABASE_URL` is in Heroku or Vercel configuration.** Without that, the separation of §5 does not hold.
5. **Provider-side limits**: an Anthropic Console spend limit on the workspace, and plan caps at Context.dev, Firecrawl and TREG. They are the only control against a leaked key.
6. **`DIGER_SPEND_GATE=observe`, then `enforce`**, on Heroku (the worker) and later Vercel.
7. **5xx and timeout policy:** keep the bound (now) or release it on a documented "not billed" status. This is accounting.
8. **Refusing Context.dev prebuilt parsers in enforce mode** until their credit cost is documented. This changes what the agent can use.
9. **Lowering `max_tokens` to the gate's cap** (proposed 32,000) for mission model requests.
10. **Wiring the website's 8 model call sites** and recording chat replies in `llm_usage`, before any claim of platform-wide coverage.
11. **A daily reconciliation** of settled spend against the providers' free usage APIs, to detect under-reported settles.
