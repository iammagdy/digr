# Diger: next steps (written 13 Nov 2026, at an account switch)

**Read first:** `docs/HANDOFF.md`, section «CURRENT STATE».

**Update (13 Nov 2026, after T1):** T1 is DONE. PR #479 was reviewed, the three security review findings were fixed (`61338a2`), and it merged as `7d30ec8` (Vercel production READY, Heroku v188, worker heartbeat `7d30ec8`). The gate is in `main` as **disconnected code only**: not wired, no SQL applied, `DIGER_SPEND_GATE` unset, not enabled.

**Activation blocker:** observe mode forwards paid requests it could not reserve (`unreservedUsd`). It is measurement only, never budget protection. See HANDOFF «ACTIVATION BLOCKER». The next task is PR B below, and it starts only when the owner asks.

**State at the time of writing:**

* Production runs `main` = `adb22f8`.
* The work branch `ccr-9dc4c8d3-d0ae22` holds round 61 (`f0fe65d8`) plus the handoff docs. It has **no PR**.
* Nothing below has been started unless it says so.

## The single best next task

**T1. Open a review PR for round 61 and complete its verification, without merging.**

* **WHAT:**
  1. Run the three checks on the work branch:
     * `npm test` (full suite);
     * `npm run agent:typecheck` and `npx tsc --noEmit -p .`;
     * `npm run build` (it includes the client-bundle secret scan).
  2. Open a PR from `ccr-9dc4c8d3-d0ae22` to `main`, titled as round 61 «spend gate: offline build, NOT wired, NOT applied». Put the test numbers in the body.
  3. Do not merge it. A merge is a separate decision after review of the exact head SHA.
* **WHY:**
  * The round-61 code exists only on a branch.
  * Its full-suite run was interrupted by the account switch, and its build was never run. Until both pass, nobody can say it is safe to merge, even though it is unwired.
* **FILES (all from commit `f0fe65d8`):**
  * `src/lib/server/spendGate/{bounds,modelBound,gate}.ts`, `agent/src/modelGate.ts`;
  * `tests/spend-gate-r61.test.ts`, `tests/spend-gate-r61-sdk.test.ts`, `tests/sql/spend-gate.local-pg.test.ts`;
  * `docs/proposals/spend-gate/**`.
* **ALREADY DONE:**
  * the targeted tests: 42/42, 2/2 opt-in, 11/11 on a scratch Postgres;
  * mutation checks: 15/15 and 11/11;
  * both typechecks clean.
  * One full-suite run was started and stopped before it finished: it was tainted by mutation runs editing files mid-run. The second run did not finish before the switch.
* **SUCCESS:**
  * the full suite reports 0 failed, with the count of passed tests at least 13,505 + 42 = 13,547 (round 60's 13,505 plus the 42 new);
  * both typechecks print nothing;
  * the build ends with the secret scan passing;
  * the PR exists and is NOT merged.
  * If a pre-existing test fails, compare it with `main` before touching anything.

## Remaining work, by priority

### P1: needed before the spend gate can protect production

1. **T1 above: DONE** (PR #479 → `7d30ec8`).

2. **Wire the gate into the call sites, behind `DIGER_SPEND_GATE` (default off): "PR B".**
   * **WHAT:**
     * Add `gateBefore`/`gateAfter` (drafted in `docs/proposals/spend-gate/drafts/gateHooks.ts.txt`) to `src/lib/server/spendGate/gate.ts`.
     * Add the Supabase adapter (drafted in `drafts/supabaseGate.ts.txt`) as `src/lib/server/spendGate/supabaseGate.ts`.
     * `agent/src/gateway.ts`: after the provider daily-cap reservation (step 6, around line 259), reserve `providerCallBound({provider:"treg", op:"call", routeCapUsd: tregRouteCapUsd(estimate)})`. Send the SAME number as `routeMaxCostUsd`. Settle after the call: actual, or null when unknown. A refusal gets a new `RefusalCode` "spend_gate".
     * `agent/src/webGateway.ts` `execute`: reserve the bound of each operation after the key check:
       * page read: contextdev scrape;
       * search: limit;
       * scrape: Firecrawl `proxy: "auto"` = 5 credits;
       * people search: fast;
       * prebuilt parser: no bound, refused in enforce mode.
     * `agent/src/sdkOptions.ts` / `agent/src/sdkRuntime.ts`: start `startModelGate` per run when the mode is not off, and merge its `childEnv` into the SDK child's environment. With the mode off, `buildQueryOptions` output must be byte-identical (existing tests in `tests/agent-worker.test.ts`).
     * `agent/src/main.ts`: build the gate context from `spendGateMode(process.env)`.
     * `agent/src/runMission.ts`: pass it to the gateways (lines ~445/452/777/779).
     * Update the «NOT WIRED» pin test in `tests/spend-gate-r61.test.ts` to the new allowed importers.
   * **WHY:** without wiring, the gate protects nothing.
   * **VERIFY:**
     * Off: the whole suite is unchanged.
     * Enforce with an in-memory gate and no grant: no fetch happens, and the call row is `refused`.
     * With a grant: TREG reserves exactly the route cap sent.
     * The real-SDK opt-in test still passes through the driver.
   * **Do not merge without owner approval** (spec §13 decision 3).

3. **Owner decisions (SPEC-v2 §13). Nothing to do until the owner answers:**
   * the first grant (amount, window ≤ 31 days, kinds, per-op and per-mission maximum);
   * applying `001_spend_gate.sql` to production, then `002_verify.sql`;
   * confirming that no database password or `DATABASE_URL` is in Heroku or Vercel configuration;
   * provider-side spend limits: the Anthropic Console workspace limit, and the Context.dev, Firecrawl and TREG plan caps;
   * `DIGER_SPEND_GATE=observe`, then `enforce`;
   * the 5xx policy (keep or release the bound);
   * refusing Context.dev prebuilt parsers in enforce mode;
   * the `max_tokens` cap of 32,000;
   * wiring the website's model calls;
   * a daily reconciliation against provider usage APIs.

### P2: correctness and cost (known limitations)

4. **Website model calls are not gated and chat replies are not recorded in `llm_usage`.**
   * Eight call sites are listed in SPEC-v2 §7: `chatModel.ts`, `modelPlanner/transport.ts`, `companyRelevanceReview.ts`, `rowReviewAdvisor.ts`, `facebookReportAxisModel.ts`, `multiProvider/planRouting.ts`, `invoices/assist.ts`, `functions/shared/llmClient.ts`. There is also `agent/src/review.ts` in the worker.
   * **Verify:** each one calls `guardedPaidCall` with `modelRequestBound`.
   * It needs owner approval: it changes what cost reports include.
5. **The model budget is given to EACH execution round** (round 59 gap; `tests/cost-audit-r59.test.ts` documents it). Fixed only by the model gate once it is wired.
6. **The plan estimate counts one page per company row.** Execution reads more pages: the replay of msn_088c gave 11 pages for 9 companies after round 60. An honest estimate changes customer prices, so it is an owner pricing decision (spec v1 §10.8).
7. **TREG `routeMaxCostUsd` is `max(estimate, 0.001)` while the estimate is reserved** (round-61 finding 1). Under the gate, reservation and header become the same number (T2). Without the gate it is a small known under-reservation.

### P3: open PRs on GitHub not from this session (left as they are)

* #440, #439, #438 (a11y and error PRs, 7 Nov), #425 (launch news e-mail: code only, not sent).
* #346 (FOUNDATION-PLAN, docs).
* #221 (draft), #194, #85 / #83 (drafts), #69 (draft), #44, #41, #40, #11, #10, #9, #8, #7, #6, #5.
* Their status was not reviewed in this session. Do not merge or close any without the owner.

## Security concerns (open)

* **A leaked provider or Anthropic key bypasses any gate.** Only the provider-side limits (P1.3) stop that.
* **`reserve_provider_spend_atomic` takes its daily cap from its caller** (`p_daily_cap_usd DEFAULT 0.80`). Spec v2 §10.4 proposes reading the cap from a grant. It is not built.
* **A dishonest settle (reporting $0) can only be detected by reconciliation** (P1.3).

## Uncommitted changes

None at the time of writing. All work is in commits on `ccr-9dc4c8d3-d0ae22`, pushed to GitHub (see `docs/NEW_ACCOUNT_START.md` for the SHAs).
