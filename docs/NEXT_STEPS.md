# Diger: next steps (updated 13 Nov 2026, after the merge of PR #479)

**Read first:** `docs/HANDOFF.md`, section «CURRENT STATE».

## Current state (verified 13 Nov 2026)

* **Last code change in production:** `7d30ec8`, the merge of PR #479 (round 61). Verified after that merge:
  * Vercel production deployment `dpl_FM1Ej2fSqeY1hgLwuTYtDTQu4th7` READY on `7d30ec8`;
  * Heroku release v188, worker heartbeat `version 7d30ec8`.
* **Later documentation-only merges** (this file's PR #480) move `main` without changing any code. Check `git log origin/main` for the current tip.
* **Round 61** (the hard spend gate) is **merged as disconnected code only**:
  * not wired into any call site;
  * no SQL applied;
  * no grant issued;
  * `DIGER_SPEND_GATE` unset on Heroku and Vercel;
  * **not enabled**.
* **Spending behaviour in production is unchanged** from round 60.
* **Tests on the merged tree** (`61338a2`, run locally; the repository has no GitHub Actions, so GitHub ran no tests):
  * full suite: 13,563 passed, 0 failed, 47 expected-fail, 78 skipped;
  * both typechecks clean;
  * `npm run build` and the client-bundle secret scan clean.
* **Branches:**
  * `ccr-9dc4c8d3-d0ae22` is fully merged (PR #479) and needs no further work.
  * New work starts from `main` on a new branch.
* **Budget enforcement is NOT live.**

## ACTIVATION BLOCKER: observe mode is NOT budget enforcement

**Observe mode can forward paid calls without a reservation. It is NOT budget enforcement.**

* In `observe`, the model gate forwards every request, including those it could not reserve (`stats().unreservedUsd`).
* It is a measurement mode only. See HANDOFF «ACTIVATION BLOCKER» for the conditions that must all hold before any activation.

## The next engineering milestone: PR B (NOT started)

**PR B = the spend-gate wiring.**

* Do not confuse it with the unrelated open PR #439, whose title says «PR-B» (API error messages).
* **It has NOT started.** It needs the owner's separate authorization:
  * to start it;
  * before any sensitive change (pricing, ledger, settlement, permissions, configuration, SQL);
  * to merge it (SPEC-v2 §13, decision 3).
* Merging PR B would still not activate anything: the mode stays off by default.
* Activation (`observe`, then `enforce`) is a further, separate owner decision.

## Remaining work, by priority

### P1: needed before the spend gate can protect production

1. **Wire the gate into the call sites, behind `DIGER_SPEND_GATE` (default off): PR B. NOT started; owner authorization required.**
   * **WHAT:**
     * Add `gateBefore`/`gateAfter` (drafted in `docs/proposals/spend-gate/drafts/gateHooks.ts.txt`) to `src/lib/server/spendGate/gate.ts`.
     * Add the Supabase adapter (drafted in `drafts/supabaseGate.ts.txt`) as `src/lib/server/spendGate/supabaseGate.ts`.
     * `agent/src/gateway.ts`: after the provider daily-cap reservation (step 6, around line 259):
       * reserve `providerCallBound({provider:"treg", op:"call", routeCapUsd: tregRouteCapUsd(estimate)})`;
       * send the SAME number as `routeMaxCostUsd`;
       * settle after the call: actual, or null when unknown;
       * a refusal gets a new `RefusalCode` "spend_gate".
     * `agent/src/webGateway.ts` `execute`: reserve the bound of each operation after the key check:
       * page read: contextdev scrape;
       * search: limit;
       * scrape: Firecrawl `proxy: "auto"` = 5 credits;
       * people search: fast;
       * prebuilt parser: no bound, refused in enforce mode.
     * `agent/src/sdkOptions.ts` / `agent/src/sdkRuntime.ts`:
       * start `startModelGate` per run when the mode is not off;
       * merge its `childEnv` into the SDK child's environment;
       * with the mode off, `buildQueryOptions` output must be byte-identical (existing tests in `tests/agent-worker.test.ts`).
     * `agent/src/main.ts`: build the gate context from `spendGateMode(process.env)`.
     * `agent/src/runMission.ts`: pass it to the gateways (lines ~445/452/777/779).
     * Update the «NOT WIRED» pin test in `tests/spend-gate-r61.test.ts` to the new allowed importers.
   * **WHY:** without wiring, the gate protects nothing.
   * **VERIFY:**
     * Off: the whole suite is unchanged.
     * Enforce with an in-memory gate and no grant: no fetch happens, and the call row is `refused`.
     * With a grant: TREG reserves exactly the route cap sent.
     * The real-SDK opt-in test still passes through the driver.
     * Observe: unreserved forwards are counted and reported (the activation blocker above).
   * **Do not merge without owner approval** (SPEC-v2 §13, decision 3).

2. **Owner decisions (SPEC-v2 §13). Nothing to do until the owner answers:**
   * the first grant: amount, window ≤ 31 days, kinds, per-op and per-mission maximum;
   * applying `001_spend_gate.sql` to production, then `002_verify.sql`;
   * confirming that no database password or `DATABASE_URL` is in Heroku or Vercel configuration. At the merge of #479, neither had such a key, judged by key names only;
   * provider-side spend limits: the Anthropic Console workspace limit, and the Context.dev, Firecrawl and TREG plan caps;
   * `DIGER_SPEND_GATE=observe`, then `enforce`. Observe is measurement only (blocker above);
   * the 5xx policy: keep or release the bound;
   * refusing Context.dev prebuilt parsers in enforce mode;
   * the `max_tokens` cap of 32,000;
   * wiring the website's model calls;
   * a daily reconciliation against provider usage APIs.

### P2: correctness and cost (known limitations)

3. **Website model calls are not gated, and chat replies are not recorded in `llm_usage`.**
   * Eight call sites are listed in SPEC-v2 §7: `chatModel.ts`, `modelPlanner/transport.ts`, `companyRelevanceReview.ts`, `rowReviewAdvisor.ts`, `facebookReportAxisModel.ts`, `multiProvider/planRouting.ts`, `invoices/assist.ts`, `functions/shared/llmClient.ts`. There is also `agent/src/review.ts` in the worker.
   * **Verify:** each one calls `guardedPaidCall` with `modelRequestBound`.
   * It needs owner approval: it changes what cost reports include.
4. **The model budget is given to EACH execution round** (round 59 gap; `tests/cost-audit-r59.test.ts` documents it). Only the model gate fixes it, once wired.
5. **The plan estimate counts one page per company row.** Execution reads more pages: the replay of msn_088c gave 11 pages for 9 companies after round 60. An honest estimate changes customer prices, so it is an owner pricing decision (spec v1 §10.8).
6. **TREG `routeMaxCostUsd` is `max(estimate, 0.001)` while the estimate is reserved** (round-61 finding 1).
   * Under the gate, the reservation and the header become the same number.
   * Without the gate, it is a small, known under-reservation.
7. **New Agent SDK versions:** the model gate's `anthropic-beta` allowlist is exactly what SDK 0.3.312 sends. An SDK upgrade that sends a new beta is refused in enforce until the beta is reviewed and allowlisted. This fails closed.

### P3: open PRs on GitHub not from this session (left as they are)

* #440, #439, #438 (a11y and error PRs, 7 Nov; #439's «PR-B» is not the spend-gate PR B), #425 (launch news e-mail: code only, not sent).
* #346 (FOUNDATION-PLAN, docs).
* #221 (draft), #194, #85 / #83 (drafts), #69 (draft), #44, #41, #40, #11, #10, #9, #8, #7, #6, #5.
* Their status was not reviewed in this session. Do not merge or close any without the owner.

## Security concerns (open)

* **Observe mode can forward paid calls without a reservation. It is NOT budget enforcement** (blocker above).
* **A leaked provider or Anthropic key bypasses any gate.** Only the provider-side limits (P1.2) stop that.
* **`reserve_provider_spend_atomic` takes its daily cap from its caller** (`p_daily_cap_usd DEFAULT 0.80`). Spec v2 §10.4 proposes reading the cap from a grant. It is not built.
* **A dishonest settle (reporting $0) can only be detected by reconciliation** (P1.2).

## History: T1 (completed)

**T1:** «Open a review PR for round 61 and complete its verification, without merging». **DONE.**

1. On `ccr-9dc4c8d3-d0ae22`, the full suite, both typechecks, the build and the secret scan all passed. The first run was on `0dc19d74`: 13,547 passed, 0 failed.
2. PR #479 was opened.
3. Three security review findings were fixed in `61338a2`:
   * observe accounting;
   * a strict `anthropic-beta` allowlist;
   * constant-time child authentication.
   * 16 new tests were added, and the suite then gave 13,563 passed, 0 failed.
4. The owner authorized a merge as disconnected code only. PR #479 merged as `7d30ec8`, pinned to the reviewed head `61338a2`.

Its original instructions are no longer needed. The tests and commands are listed in `docs/NEW_ACCOUNT_START.md` §3.

## Uncommitted changes

None. All work is merged into `main` or is in an open PR.
