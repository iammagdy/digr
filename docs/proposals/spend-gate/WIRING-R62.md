# Round 62 (PR B): the hard spend gate wired into the WORKER (INACTIVE)

**Status: an open review PR, NOT merged, NOT deployed, NOT active.**

* `DIGER_SPEND_GATE` is unset in production. With it unset, `workerSpendGateFromEnv` returns `null`, and the worker builds nothing from this round. Every gateway, model run and review then runs exactly as in round 61; tests pin this.
* No SQL is applied, and no grant exists.
* Production spending is unchanged.
* **Observe mode can forward paid calls without a reservation. It is NOT budget enforcement.**
* **Budget enforcement is NOT live.**

Read with: `SPEC-v2.md` (the design), `THREAT-MODEL.md`, `sql/001_spend_gate.sql` (not applied).

## 1. What this PR connects (worker only)

| Paid operation (worker) | Call site | Bound reserved BEFORE the call (`bounds.ts` / `modelBound.ts`) | Settled AFTER the call with |
|---|---|---|---|
| TREG catalog call (planning, execution, the code engine, contact finders, add-on re-reads) | `agent/src/gateway.ts` `tregCall`, step 6b, after the provider daily-cap reservation | The route cap SENT as `X-Treg-Route-Max-Cost`: `tregRouteCapUsd(estimate)` = `max(estimate, 0.001)`, the same number as the reservation. TREG refuses before billing a call it cannot run under it. | `X-Treg-Cost-Micro` as reported. **Unknown** (whole bound stays spent): a timeout, network failure, thrown call, or a charge TREG did not report (`costIsEstimate`). 0: nothing was sent (blocked, audit refused before the call). |
| Context.dev page read (round 60 page cache, execution) | `webGateway.ts` `pageField` → `execute` | Documented scrape: 1 credit | Credits the answer reports (`key_metadata.credits_consumed`) |
| Context.dev scrape | `webScrape` (contextdev) | 1 credit | As reported |
| Firecrawl scrape | `webScrape` (firecrawl) | **5 credits**: the adapter sends `proxy: "auto"`, which may escalate to the stealth proxy | Firecrawl's scrape reports no credits, so it is **unknown** (the whole 5-credit bound stays spent) |
| Context.dev / Firecrawl web search | `webSearch` | Whole blocks of ten results (Context.dev 1 credit per block; Firecrawl 2) | As reported (`credits_consumed` / `creditsUsed`) |
| Context.dev people search | `peopleSearch` | Fast mode: 10 credits for one page | As reported |
| Context.dev pre-built parser (maps, social, app stores, g2; planning field parsers; a page with almost no text) | `parsePage` → `contextDevParse` | **None documented: refused in enforce** (`no_safe_bound`). This is SPEC-v2 §13 decision 7. | n/a |
| Agent SDK model request (planning turns, every execution round) | `sdkRuntime.ts`: the model gate (`modelGate.ts`) started per run by `spendGateWiring.ts`, the child pointed at 127.0.0.1 | `modelRequestBound`: body bytes + 4096 tokens × input rate × cache multiplier, plus `max_tokens` (enforce lowers it to 32,000) × output rate | The stream's `usage`. **Unknown**: a cut stream, a missing `message_stop`, an error. A bound violation trips the grant (enforce). |
| Direct model request of the worker (`review.ts`: row review, channel choice, capability choice, names step) | `main.ts` gives `anthropicReviewCall` the gated fetch `spendGateWiring.ts` `gatedModelFetch` | `modelRequestBound` of the body | `usage` of the answer. 0: an unbilled 4xx. **Unknown**: a 5xx or a thrown request. |

**Common rules:**

* **One reservation per paid attempt.** Each key carries a random part (`spendGateKeys.ts`). A retry, a model's repeated call, review.ts's second request after a 400, or the same call id after a restart is a NEW reservation.
* **Enforce: no reservation, no request.** A refusal, a database error or a reserve slower than 2 s means nothing is sent. Enforce refuses with:
  * «spend_gate» for TREG and web calls (the model reads it and stops honestly);
  * HTTP 400 at the model gate;
  * HTTP 403 for direct model requests.
* **Settled once.** The database and the memory model treat a repeated settle as a replay; a failed settle leaves the reservation held, and it then **expires as spent**.
* **The in-memory mission budget (`callBudget.ts`) is kept** as an additional safeguard. It is checked first, with the estimate, exactly as before.
* **Round 60 page reuse is kept.** A page answered from the mission's cache is not a paid call and reserves nothing: one reservation per page bought (test «ROUND 60 PAGE REUSE PRESERVED»).
* **The model budget no longer resets per round in enforce.** The grant's per-mission maximum is counted in the database across every model run, execution round, retry and worker restart of a mission. The tests stop a mission's third request after two rounds plus a restart. The SDK's own `maxBudgetUsd` per round is unchanged; it is now an inner limit only.
* **The child never holds the real key.** `buildQueryOptions` refuses a gate environment whose base URL is not `http://127.0.0.1:<port>`, whose token is not a gate token, or whose token equals the real key. The round-61 protections are unchanged:
  * constant-time child authentication;
  * the strict `anthropic-beta` allowlist;
  * the loopback-only listener;
  * the bounds;
  * fail-closed enforcement.
* **Enforce: a model gate that cannot start stops the run** (`stop: "spend_gate"`): the SDK is never started with the real key. In observe the run goes on ungated and is counted as `model.start_failures`.

## 2. OBSERVE IS NOT BUDGET ENFORCEMENT: what is recorded

* **One log line per mission claim:** `[agent] spend_gate.summary {…}`. It carries counts and amounts only: no key and no request content.
* **The labels:**
  * observe: `protection: "NOT_PROTECTED_OBSERVE_ONLY"` with the note «observe: NOT budget enforcement; requests were sent even without a reservation»;
  * enforce: `"ENFORCED"`.

| Field | Meaning |
|---|---|
| `reservations`, `reserved_usd` | Bounds reserved before paid requests |
| `settled_usd` | What settled reservations counted (reported charge capped at the bound; unknown = the whole bound) |
| `overrun_usd`, `overruns` | Charges above their bound (each trips the grant) |
| `unknown_charges` | Reservations settled with an unknown charge |
| `refused` | ENFORCE: operations refused, so NOT sent |
| `would_refuse`, `refusal_reasons` | OBSERVE: operations enforce would have refused, which WERE sent |
| `unreserved_ops`, `unreserved_usd`, `unreserved_unknown_charge` | OBSERVE: provider calls and direct model requests sent WITHOUT a reservation, their reported charge, and those whose charge is unknown |
| `model.*` | The model gate's own counts per mission: runs, requests, forwarded, refused, unauthorized, unknown charge, bound violations, `unreserved`, `unreserved_usd`, start failures |
| `total_unreserved_requests`, `total_unreserved_usd` | Everything sent without a reservation (always 0 in enforce) |
| `settle_failures` | Settlements that failed (left held: they expire as spent) |

Each enforce refusal and each bound violation is also logged on its own line, with the operation and the reason only.

## 3. Coverage matrix (every paid call site found, 13 Nov 2026)

**GATED (this PR, worker, only when `DIGER_SPEND_GATE` is set):**

| Call site | Notes |
|---|---|
| `agent/src/gateway.ts` `tregCall` | Every TREG call of the worker: the planner, execution, the code engine (`engine/run.ts`, `engine/contacts.ts`, `compiled.ts`), `tools.ts`, and the add-on re-reads (`stage4/runAddon.ts`, `stage4/rereadRun.ts`) |
| `agent/src/webGateway.ts` `execute` | Context.dev page reads, scrapes, searches and people search; Firecrawl scrapes and searches. Context.dev pre-built parsers are refused in enforce (no documented bound). |
| Agent SDK model requests (`agent/src/sdkRuntime.ts` via `agent/src/modelGate.ts`) | Planning runs and every execution round |
| `agent/src/review.ts` `anthropicReviewCall` | The direct requests: row review, channel understanding, capability choice, names step. Gated through `gatedModelFetch` from `main.ts`. |

**NOT GATED (the website and the platform outside the worker): the next separate task, which needs owner approval.**

| Call site | What it pays for |
|---|---|
| `src/lib/agentMission/chatModel.ts` | Website chat replies (model). These are also not recorded in `llm_usage`. |
| `src/lib/modelPlanner/transport.ts` | Website model planner (model) |
| `src/lib/server/companyRelevanceReview.ts`, `src/lib/server/rowReviewAdvisor.ts` | Model-powered reviews on the website |
| `src/lib/server/facebookReportAxisModel.ts` | Model |
| `src/lib/server/multiProvider/planRouting.ts` | Model plan routing |
| `src/lib/server/invoices/assist.ts` | Model (invoice assistant) |
| `src/functions/shared/llmClient.ts` | Model calls of the Supabase-function jobs |
| `src/functions/shared/tregClient.ts` `executeTregCall` as used by `src/functions/shared/multiStepWorker.ts`, `src/lib/server/tregAdapter.ts`, `src/lib/modelPlanner/{exploration,interpreter,stageCall}.ts`, `src/lib/server/rawCapture.ts`, `src/lib/server/adminLookup.ts` | TREG calls of the website's job runner, planner and admin lookups |
| `src/lib/server/multiProvider/chainRunner.ts` and the adapters (`adapters/contextdev.ts`, `firecrawl.ts`, `treg.ts`) as used by the website | Context.dev / Firecrawl / TREG calls of the website's multi-provider jobs |
| `src/lib/server/tregKeyCheck.ts` (admin) | The 3-step TREG key check: step 3 is a real (paid) data call |
| `src/functions/shared/smokeTest.ts` via `src/app/api/admin/smoke/route.ts` (admin) | A live smoke test from the admin page, under its own hard cap of $0.02 |

Until these are gated, **the platform is NOT protected by the spend gate**, whatever the worker's mode. Only provider-side limits (P1.2) bound them.

**NOT APPLICABLE (no paid charge):**

| Call site | Why |
|---|---|
| `src/lib/server/providerStatus.ts` | Balance and health reads: Anthropic `GET /v1/models`, Firecrawl `team/credit`, Context.dev `org/usage`, TREG `openapi` (documented as unbilled) |
| `agent/src/webGateway.ts` page-cache answers (`page.reuse`) | Read from what the mission already bought |

**REQUIRES SEPARATE APPROVAL (scripts run by a person, never by production):**

| Call site | Notes |
|---|---|
| `scripts/eval-real-model.ts`, `scripts/measure-llm-cost.ts`, `scripts/evaluate-understanding.ts`, `scripts/acceptance-round3-live.ts`, `scripts/e2e-live-browser-acceptance.ts`, `scripts/live-additional-scenarios.ts`, `scripts/agent-loop/`, `scripts/pressure/`, `scripts/capacity/`, `scripts/browser-journey/` | Live evaluations and acceptance runs: each one needs the owner's explicit authorization for paid calls in that round. They are not gated; the `eval` kind of the grant exists for them (SPEC-v2). |

## 4. Database migration requirements (NOT done; owner only)

1. Apply `docs/proposals/spend-gate/sql/001_spend_gate.sql` to production. It creates schema `spend_gate` and the functions `spend_reserve`, `spend_settle`, `spend_stop` and `spend_status`. Then run `002_verify.sql`; every row must say ok.
2. The owner issues a grant with `spend_gate.issue_grant`. That is the owner's database role, never the service role. It sets the amount, the window of at most 31 days, the kinds (`provider`, `model`), and the per-operation and per-mission maximums.
3. Until 1 and 2 are done, every reservation fails:
   * the functions are missing, so the adapter returns `gate_unavailable`;
   * or there is no grant, so the result is `no_grant`.
   * Therefore:
     * **enforce refuses every paid call**: planning cannot sample, and missions end unserved;
     * **observe sends every call unreserved**.
4. No change to customer tables or money functions. The worker's adapter calls only `spend_reserve`, `spend_settle` and `spend_stop`, and a test pins it. The scratch-Postgres test shows the money functions and `credit_ledger` unchanged.

## 5. Production activation prerequisites (all still open)

1. **Owner decisions in SPEC-v2 §13:**
   * the first grant;
   * applying the SQL;
   * provider-side spend limits (the Anthropic Console workspace limit; Context.dev, Firecrawl and TREG plan caps);
   * confirming that no database password or `DATABASE_URL` is in the Heroku or Vercel configuration;
   * the `max_tokens` cap;
   * refusing pre-built parsers;
   * the 5xx policy.
2. **This PR is reviewed and merged only with the owner's separate authorization.** Merging activates nothing: the mode stays off.
3. **An observe period.** Read the `spend_gate.summary` lines. Every unreserved request and every `would_refuse` reason must be understood and accepted as NON-protection.
4. **The production failure tests of SPEC-v2 §11 before `enforce`:**
   * a database outage;
   * no grant;
   * a tripped grant;
   * a restart mid-call.
5. **The website's paid call sites (section 3) are a separate task.** The platform must not be described as protected while they are not gated.

## 6. Remaining security risks (known, documented)

* **Observe forwards unreserved paid calls.** It is not protection (section 2).
* **The website is not gated** (section 3).
* **A leaked provider or Anthropic key bypasses any gate.** Only provider-side limits stop that.
* **The model input bound is an assumption:** «tokens ≤ bytes + 4096». It is checked on every answer; a violation trips the grant in enforce.
* **TREG key-pool hops.** With the pool switch ON, a call that fails for the KEY's reason (revoked, out of balance, verified first) is retried on the next key with the same idempotency key, at most three times. The pool documents these as unbilled. The gate reserves one route cap per call, not per hop. If TREG ever billed a hop, the reported charge would exceed the bound, count as an overrun and trip the grant: the overrun would be visible, but it would not have been prevented.
* **Firecrawl scrapes always count their whole 5-credit bound** (no reported credits). This is conservative, but it uses grant room faster than the real charge.
* **Pre-built parsers are refused in enforce.** Missions that need them (maps, social, app stores) cannot run in enforce until a documented bound exists or the owner decides otherwise.
* **Enforce with no grant or no database stops all paid work.** Missions end unserved (fail closed). That is a customer-visible effect, and it is the intended one.
* **A model request longer than about 595 s is cut by the model gate** (round 61, `ttl - 5 s`) and settled as unknown.
* **The summary is per claim, not per mission lifetime.** The per-mission maximum itself is enforced by the database across claims.
* **The SDK's own requests to paths other than `/v1/messages` are refused** by the model gate (403). This was measured harmless on SDK 0.3.312; a future SDK may need review, and the same applies to a new `anthropic-beta` value.

## 7. Files changed in this PR

* **New:**
  * `agent/src/spendGateWiring.ts`: the worker's gate, its per-mission tally and summary, and the gated direct-model fetch;
  * `agent/src/spendGateKeys.ts`: per-attempt reservation keys and the TTL;
  * `src/lib/server/spendGate/supabaseGate.ts`: the database adapter (was `drafts/supabaseGate.ts.txt`);
  * the tests (section 8) and this document.
* **Changed:**
  * `src/lib/server/spendGate/gate.ts`: `gateBefore` / `gateAfter`, with typed events (was `drafts/gateHooks.ts.txt`);
  * `agent/src/gateway.ts`: step 6b, refusal `spend_gate`; the route cap sent is the same value as before;
  * `agent/src/webGateway.ts`: the bound per operation, the reservation after the key check, settlement from the provider's report;
  * `agent/src/sdkOptions.ts`: the gated child environment;
  * `agent/src/sdkRuntime.ts`: starts and closes the model gate per run; enforce fails closed;
  * `agent/src/driver.ts`: `RunInput.modelGate`;
  * `agent/src/runMission.ts`: passes the gate to the gateways and to every model run;
  * `agent/src/stage4/runAddon.ts`: add-on re-reads;
  * `agent/src/main.ts`: builds the gate from `DIGER_SPEND_GATE`, gates the review calls, logs the summary;
  * `agent/src/modelGate.ts`: comment only;
  * `tests/spend-gate-r61.test.ts`: the «NOT WIRED» pin becomes the R62 pin. Only the listed worker files may use the gate, and no website file;
  * `tests/spend-gate-r61-sdk.test.ts`: two opt-in tests of the real driver.

## 8. Tests (offline: fakes, a memory gate, a scratch Postgres; no paid call)

* `tests/spend-gate-r62-wiring.test.ts`: 41 tests.
  * **OFF:** byte-identical TREG and web requests and records; identical SDK options.
  * **ENFORCE:** no grant, database failure, slow database, unknown charge, overrun trips, retries, 20 concurrent calls, the in-memory budget first, an unbounded parser, Firecrawl stealth bound, search blocks, people search, daily cap, page reuse.
  * **OBSERVE:** honest unreserved accounting.
  * **MODEL:** planning, execution rounds, the per-mission maximum across rounds and a restart, an interrupted stream, unknown model, unknown beta, database failure, observe.
  * **DIRECT MODEL:** no grant, grant, a 400 retry, a 5xx, a thrown request, observe.
  * **CUSTOMER MONEY:** a whole mission enforced vs off gives the same charge, balance and records; no grant means no paid call; the adapter calls only `spend_*`.
* `tests/spend-gate-r61-sdk.test.ts` (`DIGER_TEST_REAL_SDK=1`): 4 tests, 2 of them new. They run the worker's real driver and the real SDK through the wired gate against a fake upstream: every request is gated and the real key is used only upstream; with no grant nothing reaches upstream; a gate that cannot start does not start the model.
* `tests/sql/spend-gate-r62-worker.local-pg.test.ts` (`DIGER_TEST_PG`): 3 tests. The worker's adapter and TREG gateway against the real SQL: two workers make 30 concurrent calls and never pass the ceiling.
* **Mutation check:** with the gateway hooks disabled, 18 of the 41 wiring tests fail.
* **Results of the full verification:** in the PR description.
