# Spend safety acceptance (14 Nov 2026): the USD 0.30 campaign ceiling

**Verdict for the first live test: NO-GO today.** The code is ready for review and, once merged, is inactive. Nothing in production can enforce the ceiling until the owner approves the steps of §10. This report separates what exists as code, what was verified offline, what is deployed, what is enforceable, and what was seen live (nothing was).

* **Owner authorization used:** development and offline testing only. **No paid call, no SQL applied, no grant issued, no configuration or switch changed, no customer money touched. Total spend of this milestone: USD 0.00.**
* **Base:** `main` at `e550178424976c9a76e98f6156b8fb4c63590d52` (verified before work).
* **Reused, not replaced:** PR #481 (round 62, the worker wiring) was **not merged, rebased or modified**. Its code was merged into the new branch and conflicts in three files were resolved by hand (`agent/src/runMission.ts`, `agent/src/webGateway.ts`, `docs/NEXT_STEPS.md`). There is one spending system, not two. PR #481 stays open and is now **superseded** by this milestone's PR (owner decision, §10).

## 1. The six statuses, kept apart

| Status | State | Evidence |
|---|---|---|
| **CODE IMPLEMENTED** | Yes. Campaign scope (SQL 003, reference model, worker admission), the paid-call inventory, TREG single-attempt, stricter unknown-charge handling. | The files of §9. |
| **OFFLINE VERIFIED** | Yes, with fakes, a reference model and a scratch Postgres 16. No provider or model was called. | §7. |
| **PRODUCTION DEPLOYED BUT INACTIVE** | Only after the PR is merged. Then the worker contains the gate; `DIGER_SPEND_GATE` is unset, so it builds nothing. The SQL is **not** applied. | Recorded in the next code PR (policy: no documentation-only PR). |
| **HARD CAP ENFORCEABLE** | **No.** Production has no schema, no grant and no worker setting. `PRODUCTION_BUDGET_GUARANTEE` is unchanged (`enforceable: false`) and a test pins it. | §8. |
| **LIVE VERIFIED** | **No.** No reservation, refusal, expiry, restart or database outage was seen on the production store. | §10, step 4. |
| **OWNER APPROVAL REQUIRED** | Yes: 9 items. | §10. |

**Code-ready versus production-ready.** Code-ready means a reviewer can read it and the tests pass. Production-ready means the schema exists on the production database, an owner-issued grant is open, the worker runs in campaign mode on the commit with the gate, provider-side limits exist, a rehearsal has refused a call before any provider was reached, and a failure test (killed worker, unreachable store) was seen. **Only the first is true.**

## 2. What the existing gate (PR #481) did, and what this milestone changed

PR #481 wires the worker's four paid paths to the round-61 gate behind `DIGER_SPEND_GATE` (off by default). Reviewed and kept as it is: the loopback model gate (the SDK child never holds the real key), the `anthropic-beta` allowlist, per-attempt reservations with random keys, idempotent settlement, expiry as spent, fail-closed enforce, and customer money untouched.

Limits found, and what was done:

| # | Limit of PR #481 | Consequence for a campaign | Done here |
|---|---|---|---|
| 1 | **The grant is global.** Enforce mode refuses every paid worker call that has no reservation, so every customer would be refused. | A campaign could not coexist with paying customers. | **Campaign scope** (§3): the worker gates only the test account's enrolled missions; every other mission never touches the gate. |
| 2 | Any mission could draw on the grant. | A customer's call could spend the campaign's money. | The grant is bound to one account; the store refuses an unenrolled mission (`mission_not_enrolled`). |
| 3 | The ceiling was per grant. A new grant started from zero. | The "one cumulative ceiling" was not true across grants. | `issue_campaign_grant` counts everything every campaign grant used or still holds; revoke and expiry give nothing back. |
| 4 | A TREG key-pool hop was "documented as unbilled", and the client reports the cost of the LAST attempt only. | A billed hop would be unreserved and unsettled. | A campaign mission passes the worker's token explicitly, so the client makes **one** attempt and never hops (by construction, `tregClient.ts`). Without a token the reservation covers all 4 possible attempts. |
| 5 | A TREG answer whose cost was not a number settled as **zero**. | An unknown charge was treated as zero. | Not a finite number now settles **unknown** (the whole bound stays spent). The real client always sets a number, so production behaviour is unchanged. |
| 6 | No test said which paid file belongs to which path. | A new paid path could appear unclassified. | `paidPaths.ts` and test Q: any source file with a paid-call marker must be classified. |
| 7 | A typo in `DIGER_SPEND_GATE` fails closed **for everyone**. | A typo during activation would stop customers' paid calls. | An account id beside ANY enforcing value (`enforce`, a typo) now means the campaign scope, never a global enforce; a campaign (or such a value) without a valid account **stops the worker from starting** (it never runs ungated). The global modes without an account id are unchanged and the runbook does not use them. |

## 3. The campaign design (all of it offline)

| Requirement | How it is met | Where |
|---|---|---|
| Unique immutable campaign id | The grant's id (a primary key). A trigger refuses any change to its id, account, amounts, kinds, window or mission limit; a tripped or revoked grant never reopens; spent and overrun never go down. | `003_campaign_scope.sql` |
| Explicit test-account binding | `account_id` on the grant. Enrollment reads the mission's owner from `public.missions` **inside the database**; the caller's word decides nothing. | SQL, `spend_enroll_mission` |
| Explicit enrolled missions | A table of (grant, mission), at most 5, set to **1** in the runbook. A call with no mission, or an unenrolled mission, is refused. | SQL |
| Cumulative 0.30 | Constraint `ceiling <= 0.30` and the cumulative check at issue. Reserved plus spent never passes the ceiling (a check constraint), an overrun is recorded apart and trips the grant. | SQL |
| Expiry | `closes_at`, at most 72 hours after opening, read from the **database clock**. Both reserve and enroll refuse after it. | SQL |
| Emergency stop | `public.spend_stop` (trips the open grant), the owner's `revoke_grant`, and unsetting the worker variable. | SQL, runbook §11 |
| Reversible activation | Nothing is created by a mission or a deploy. Activation is an owner issue plus two worker variables; deactivation is a revoke plus unsetting them; `003_campaign_scope.rollback.sql` restores 001's functions byte for byte (a test proves it). | SQL, runbook |
| Account isolation on the worker | `DIGER_SPEND_GATE=campaign` plus `DIGER_SPEND_CAMPAIGN_ACCOUNT`. At claim, the mission's own `user_id` decides: another account's mission is `ungated` (no gate object, no database call, byte-for-byte today's behaviour); the test account's mission is enrolled or `blocked` (every paid call refused). A mission nobody admitted is `blocked`. | `agent/src/spendGateWiring.ts`, `main.ts` |
| Fail closed | An enrollment that errors, hangs (2 s) or is refused means `blocked`. A reserve that errors or hangs means refused. A customer who is not in the campaign is not affected by a store outage. | tests L |

## 4. The coverage matrix: every billable path

This is `src/lib/server/spendGate/paidPaths.ts`, enforced by test Q. "Gated" means the campaign grant reserves the **maximum** charge before the request leaves the worker, for enrolled missions only.

| Path | Files | Bound (why it is a maximum) | Reservation | In the campaign |
|---|---|---|---|---|
| Worker TREG (planning samples, execution pages, engine stages, contact finders, add-on re-reads) | `agent/src/gateway.ts`, `runMission.ts`, `tregClient.ts` | The `X-Treg-Route-Max-Cost` sent (TREG refuses above it before billing). One attempt (explicit token); 4 attempts if no token can be passed. | `spend_reserve` per attempt, random key; settle by the reported cost; cut call, thrown call or unreported cost = unknown (whole bound spent) | **Gated, safe** |
| Worker Context.dev and Firecrawl | `agent/src/webGateway.ts` | Documented credits: scrape 1, search 1 per 10 results, people search 10; Firecrawl scrape 5 (the request uses `proxy: auto`), search 2 per 10. **Context.dev pre-built parsers: no documented cost, refused.** | as above; Firecrawl reports no credits for a scrape: unknown (bound spent) | **Gated, safe** (parsers refused) |
| Worker Agent SDK model requests (planning and every execution round) | `agent/src/sdkRuntime.ts`, `modelGate.ts` | (bytes + 4096) tokens at the dearest input rate + `max_tokens` (lowered to the cap) at the output rate. `max_tokens` is enforced by the API; the input part assumes tokens ≤ bytes, **checked on every answer** (a violation trips the grant). Server tools, fast mode, images, documents, MCP and unknown betas are refused. | A loopback gate is the child's only route to the API; the child holds a per-run token, never the real key. Reserve before forwarding; usage settles; a cut stream keeps the whole bound. | **Gated, safe** (the assumption is stated in §6) |
| Worker direct model requests (`review.ts`) | `agent/src/review.ts` | The same request bound, from the body about to be sent. | `gatedModelFetch`; 4xx settles 0; 5xx or a thrown request is unknown | **Gated, safe** |
| Website customer chat | `chatModel.ts`, `/api/chat`, `chatHandler.ts`, `llmClient.ts` | None computed | None. A `chat` reservation would be refused (kinds are provider and model) | **EXCLUDED.** The test account must not chat during the window. |
| Website planners, interpreter, mission engine, routing, the multi-step worker | `modelPlanner/*`, `planRouting.ts`, `chainRunner.ts`, `multiStepWorker.ts`, `/api/worker/chunk` | None | None | **EXCLUDED.** Not reached by a console mission. |
| Website reviews, relevance, report axis model, invoices assist, social and TREG adapters | 10 files | None | None | **EXCLUDED** |
| Admin paid screens: reverse lookup, TREG key check (step 3), smoke test, LLM status | `adminLookup.ts`, `tregKeyCheck.ts`, `smokeTest.ts`, `llm-status` | The reverse lookup has its own USD 2 cap | None from the gate | **EXCLUDED.** The owner must not run them during the window. |
| Evaluation and live scripts | `evals/live-intelligence/*`, `scripts/eval-real-model.ts`, `measure-llm-cost.ts`, `test-disabled-caps-eval.ts`, registry sync | A local budget file (not an authorization) | None; a raw key bypasses every gate | **EXCLUDED.** Never part of the campaign. |
| Status and balance reads, provider admin screens, env admin, the LLM-enabled flag | 6 files | Unbilled | n/a | Not billed |

**Plainly:** the cap covers the worker's paid calls for the enrolled mission. It does not cover "the platform", the website, the customer chat or any script. A test (`the worker makes no network call outside those four paths`) pins that the worker has no other egress.

## 5. Money-safety guarantees and how each is shown

| Guarantee | How |
|---|---|
| Reserved + counted never passes the ceiling | A check constraint; a 2 × 40 parallel test from separate connections on a scratch Postgres (exactly 20 of 80 succeeded); a 40-call test on the worker, measured after every reserve and settle. |
| A paid request has an atomic reservation before it is sent | `spend_reserve` is one transaction under one row lock; the worker sends only after `proceed`. |
| Model and provider spending share the budget | One grant with kinds provider and model; test N. |
| Exact idempotency | The same key returns the same reservation; the same key with another amount is `key_conflict`; a second settle is a replay. A retry of a provider call is a new attempt with a new random key. |
| Failed calls, timeouts | A refusal (4xx) settles 0; a timeout, a cut stream, a thrown call, a 5xx and an unreported charge settle **unknown**: the whole bound counts. |
| Delayed charges | Not released: a held reservation expires **as spent**. |
| Worker crash and restart | Spending lives in the store. A restarted worker has no mission admitted, so every paid call is refused until it admits the mission again (test G). |
| Duplicate callbacks | Settlement is idempotent. |
| Store unavailable | Fail closed for the enrolled mission; no effect on other accounts (test L). |
| Customer ledger | Not read or written: the money functions' bodies and the ledger totals are hashed before and after on the scratch database; the gate's source names no ledger, balance or settlement function. |

## 6. The honest limits of the bound, and what USD 0.30 can buy

**The model bound is an assumption plus an enforced cap.** Output is bounded by the API (`max_tokens`). Input is bounded by "tokens ≤ bytes + 4096", an assumption about byte-level tokenizers that holds for plain text but is **not a provider guarantee**. It is checked on every answer; one violation trips the grant. This is stated, not hidden: it is the reason the owner should also set the provider-side limit (§10, item 5).

**The bound is conservative, so the cap shrinks what a mission can do.** Computed with the real bound function (Haiku 5.5, USD 0.10 / 0.50 per million tokens):

| Body | `max_tokens` cap 32,000 | cap 8,000 | cap 4,000 |
|---|---|---|---|
| 20 KB | 0.0190 | 0.0070 | 0.0050 |
| 60 KB | 0.0240 | 0.0120 | 0.0100 |
| 120 KB | 0.1576 (above the 0.10 per-op maximum: **refused**) | 0.0976 | 0.0876 |
| 300 KB | 0.2701 (refused) | 0.2101 (refused) | 0.2001 (refused) |

* The worker's system prompt alone is about 40 KB, so a body starts near 60 KB and **grows with every tool result of the conversation**. Past about 125 KB a request's bound exceeds the grant's per-operation maximum of 0.10 and is **refused**: a long mission ends unserved. That is the safe failure (customer points released, nothing sent), and it is the main risk to a *useful* first run.
* **Sonnet cannot run under this cap**: its smallest bound (20 KB, cap 4,000) is 0.1005, above 0.10.
* A reservation is released down to the real usage at settlement, so the bound limits **headroom**, not total spend: a call is refused only when spent + held + its bound would pass 0.30.
* A TREG call reserves its route cap (0.05 for the posts endpoint in the tests), so at most 6 are in flight at once, and a call whose charge is unknown burns its whole cap.
* A tighter, still-enforceable input bound exists (Anthropic's free `count_tokens` endpoint), but its count is documented as an estimate: **not built**, an owner decision.

## 7. Offline verification

(Counts are those of the final local run on the PR's head; the repository has no GitHub Actions.)

| Check | Result |
|---|---|
| Letter tests A to P and the inventory (`tests/spend-campaign.test.ts`) | 30 tests, all pass |
| SQL on a real Postgres 16 (`tests/sql/spend-campaign.local-pg.test.ts`) | 16 tests, all pass; plus the 14 of rounds 61 and 62 |
| Rounds 61 and 62 suites kept | `tests/spend-gate-r61.test.ts` 58, `tests/spend-gate-r62-wiring.test.ts` 42, all pass (two assertions were extended, not weakened: the allowed RPC names gained `spend_enroll_mission`, and the gate's method list gained `enroll`) |
| Full suite (with the scratch Postgres for the SQL tests) | **14,167 passed, 0 failed**, 47 expected-fail, 12 skipped (1,002 files passed, 1 skipped). The baseline on `e550178` was 14,008. |
| Opt-in real Agent SDK against a fake upstream (`DIGER_TEST_REAL_SDK=1`) | 4/4 |
| Website typecheck, agent typecheck | clean |
| `npm run build` and the client-bundle secret scan | built; 211 client files, **zero secrets** |
| Mutation check | 36 mutants (26 in TypeScript: the reference model, the worker's admission, the wiring keys, the bounds, the gateway and the readiness checklist; 10 in the SQL). The first run caught 32 and four survived; each survivor became a test (an overrun counts in the exposure, the 72-hour window, an ungated mission's context is off, a held reservation counts after a revoke) and **all 36 are caught**. |

| Letter | Required test | Test |
|---|---|---|
| A | A call below the remaining budget succeeds | `A:` (two) |
| B | A call over the remaining budget is refused before the provider is invoked | `B:` |
| C | Concurrent calls cannot pass the limit | `C:` and the SQL test `C:` |
| D | Retries cannot double-reserve or double-spend | `D:` and the SQL test `D/E/F` |
| E | A timed-out call keeps its reservation | `E:` and SQL |
| F | An unknown charge cannot free budget | `F:` (two cases) and SQL |
| G | A worker restart cannot reset spending | `G:` and the SQL `G` |
| H | Expiry refuses new paid requests | `H:` and the SQL `H` |
| I | The campaign belongs to the test account only | `I/J:` |
| J | A different customer cannot use the grant | `I/J:`, the whole-mission test for another account, SQL `J` |
| K | An unbounded operation is refused | `K:` (three) |
| L | An unavailable store fails closed for the campaign | `L:` |
| M | With the feature off, customers are unchanged | `M:` (three), including identical dependency objects |
| N | Model and provider share one budget | `N:` |
| O | No customer ledger transaction changes | `O:` whole mission, gated vs off; SQL money-hash test |
| P | The acceptance workflow cannot start while the ceiling is unenforceable | `P:` (three) and the existing `acceptance-campaign.test.ts` |
| Q (added) | No paid file is outside the inventory | `Q:` (four) |

## 8. Is the ceiling technically enforceable?

* **In code, yes**, for the worker's paid calls of enrolled missions, under the stated bounds and the stated tokenizer assumption.
* **In production, no.** `campaignReadiness` (a pure checklist, called by no production code) names eight conditions: the SQL applied, an open campaign grant at or under 0.30 bound to the test account, the worker in campaign mode on a commit with the gate, the inventory complete, a rehearsal on the production store, and provider-side limits. Today six are missing.
* The admin acceptance panel keeps refusing (`budget_not_enforceable`); the guarantee constant changes only in a separate reviewed change that reads live evidence. The runbook therefore starts the mission from the admin console, without the panel.

## 9. Files changed

Merged from PR #481 (reviewed, kept): `agent/src/{driver,gateway,main,modelGate,runMission,sdkOptions,sdkRuntime,spendGateKeys,spendGateWiring,webGateway}.ts`, `agent/src/stage4/runAddon.ts`, `src/lib/server/spendGate/{gate,supabaseGate}.ts`, `docs/proposals/spend-gate/WIRING-R62.md`, `tests/spend-gate-r62-wiring.test.ts`, `tests/sql/spend-gate-r62-worker.local-pg.test.ts`, and the round-62 edits to two tests and the docs.

New in this milestone: `src/lib/server/spendGate/campaign.ts`, `paidPaths.ts`; `docs/proposals/spend-gate/sql/003_campaign_scope.sql`, `003_campaign_scope.rollback.sql`, `004_verify_campaign.sql`; `tests/spend-campaign.test.ts`, `tests/sql/spend-campaign.local-pg.test.ts`; this report and `docs/intelligence/FIRST-LIVE-ACCEPTANCE-RUNBOOK.md`. Edited: `gate.ts` (campaign scope in the reference model), `bounds.ts` (attempts), `gateway.ts` (explicit token, attempts, unknown cost), `spendGateWiring.ts`, `spendGateKeys.ts`, `runMission.ts`, `main.ts` (admission), `supabaseGate.ts` (enroll), `002_verify.sql`, `HANDOFF.md`, `NEXT_STEPS.md`.

No migration, pricing, ledger, settlement, permission, RLS, balance or infrastructure file was changed.

## 10. Owner approval required (none given, none assumed)

1. **Apply `001_spend_gate.sql`, then `003_campaign_scope.sql`** (with `002_verify.sql` and `004_verify_campaign.sql`) on the production database. This creates a role, a schema, tables and functions, and grants `execute` on five functions to `service_role`. **It also needs the table owner to be able to read `public.missions`**: `spend_gate.mission_owner` is created by the database owner role and reads only a user id for one mission.
2. **Issue the one campaign grant** (§2 of the runbook: ceiling 0.30, per-op 0.10, one mission, 3 hours).
3. **Set `DIGER_SPEND_GATE=campaign`, `DIGER_SPEND_CAMPAIGN_ACCOUNT` and `DIGER_SPEND_MAX_OUTPUT_TOKENS` on the Heroku worker**, then unset them afterwards.
4. **A rehearsal and failure tests on the production store** (SPEC-v2 §11): a refusal before any provider is reached, a killed worker's reservation seen expiring as spent, an unreachable store seen failing closed. Each is free (no provider is called).
5. **Provider-side limits** (Anthropic Console workspace limit; TREG, Context.dev and Firecrawl plan caps): the only control against a leaked key and against the token assumption.
6. **Confirm no `DATABASE_URL` or database password is set on Heroku or Vercel** (otherwise the grant's separation does not hold).
7. **The `max_tokens` cap** for campaign model requests (proposed 8,000) and **Haiku only** for the planning and execution models.
8. **Refusing Context.dev pre-built parsers** for campaign missions (already the behaviour; it changes what the mission can use).
9. **PR #481:** close it as superseded by this milestone's PR, or keep it open; it was not touched. And a **separate** change to replace `PRODUCTION_BUDGET_GUARANTEE` with a live check, only after items 1 to 6 are seen.

## 11. Remaining risks

* **Usefulness:** a long mission will meet the per-operation maximum and end unserved (§6). The safe outcome is fixed; whether a representative L4 fits is **not tested live**.
* **The tokenizer assumption** (§6) and any provider billing beyond its documentation (for example a TREG route that bills without a header: counted as unknown only when the client marks it an estimate).
* **Uncovered paid paths** exist (§4): the website, the admin lookups and the scripts. The runbook forbids them for the window; nothing technical stops an owner from using them.
* **Observe mode** forwards unreserved requests and is not enforcement; the runbook never uses it. A typo of `DIGER_SPEND_GATE` WITHOUT `DIGER_SPEND_CAMPAIGN_ACCOUNT` still fails closed for **all** accounts (the pre-existing global enforce); with the account id set it is a campaign.
* **The free re-run** still creates a mission with no exclusion list (Phase 7 risk); the campaign does not set `customer_exclusion_files_v1`.
* The SQL was tested on a scratch Postgres as a superuser. Supabase's role model (the table owner reading `public.missions` under row-level security) is argued from the design and checked by `004_verify_campaign.sql` on the real database, not proven here.
* Phase 5.3-B, PR #481 and Phase 8 were not touched.
