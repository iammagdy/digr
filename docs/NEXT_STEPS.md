# Diger: next steps (updated 14 Nov 2026, Phase 5.3 and Phase 6 campaign)

**Read first:** `docs/HANDOFF.md`, section «CURRENT STATE», and `docs/intelligence/PHASE-5-3-AND-6.md`.

## Current state (verified 14 Nov 2026)

* **Latest verified baseline:** `8c30294`, the merge of PR #494 (PR #493 is merged too, `7d9bcad`):
  * Vercel production deployment `dpl_ETmFhPpr7bWBWQmqzGLegDqMtg3W` READY on `8c30294`;
  * Heroku release v202, worker heartbeat `version 8c30294`, `active_missions 0`.
* The nine stale `vrun_` verification jobs are **closed** (no queued or running job, read-only check).
* **This campaign's PRs** (Phase 5.3-A, Phase 6) and their production results are in `docs/intelligence/PHASE-5-3-AND-6.md`. Check `git log origin/main` for the current tip.
* **Statuses are kept apart everywhere:** code complete ≠ offline verified ≠ live verified ≠ production enabled. No Intelligence switch is set in production.
* **Deployment discipline (mandatory):** one push, one preview and one production deployment per focused PR; everything is verified locally first (report «Deployment discipline»).
* **Round 61** (the hard spend gate) is still **merged as disconnected code only** (not wired, no SQL, no grant, `DIGER_SPEND_GATE` unset). **Budget enforcement is NOT live.**
* **Historical (13 Nov 2026):** the last code change was then `7d30ec8` (PR #479); suite 13,563 passed at `61338a2`.

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

## Phase 5.3 and Phase 6 (14 Nov 2026)

* **5.3-A exclusion files:** merged and deployed (PR #495, `390b6a2`), offline verified, behind `customer_exclusion_files_v1` (**not enabled**). Owner: turn it on for the test account, then customers; decide whether possible matches are excluded too.
* **5.3-B enrichment files:** **stopped**; it needs a new quote model and a new settlement rule. Proposal: report §B.3 (owner approval).
* **6.1 / 6.2 provider sync and breaking changes:** code complete and offline verified; one manual public-metadata sync was run (report §C.4, `docs/capabilities/sync-2026-11-14.md`). Owner: review the report; decide on a reviewed PR that refreshes the pinned TREG snapshot and registry (29 endpoints are no longer offered on TREG's platform key); weekly manual sync (`sync-providers.ts`, no cron).
* **Next roadmap priority after this campaign:** Phase 7 (shadow evaluation) and Phase 8 (controlled activation) need owner decisions first; they were not started.

## Phases 2–4 of the Diger Intelligence Audit (14 Nov 2026)

* **State:** code complete and offline verified, **not enabled**. See `docs/intelligence/PHASES-2-4-ACCEPTANCE.md`.
* **Owner decisions** (§7 of that report), each needing approval:
  1. switches on for the test account only;
  2. one capped enrichment capture (≤ $0.03);
  3. additions to the reviewed production list;
  4. direct provider keys (proposal);
  5. the cap accounting of an unanswered web call;
  6. the chat policy for «personal e-mails of employees»;
  7. the Phase 1 understanding gaps;
  8. the Next build heap.
* **Phase 5** was done on 14 Nov 2026 (PRs #487–#489 and the report PR). See the next section.

## Phase 5 (14 Nov 2026): offline complete, NOT enabled

* **Report:** `docs/intelligence/PHASE-5-CONTACTS-AND-REVERSE-LOOKUP.md`.
* **Owner decisions** (report §9):
  1. person mobiles from B2B phone finders (keep with legal sign-off / restrict / relabel);
  2. the chat wording for «personal e-mails of employees»;
  3. fail closed for every admin sensitive call;
  4. per-field contact pricing (a pricing change);
  5. the `admin_lookup_history` table with a retention period;
  6. lawful basis, retention, opt-out and a provider-terms review before any verified-business sensitive access;
  7. live acceptance L1–L4 (≤ $0.30);
  8. price confirmation for automatic e-mail reverse endpoints above a threshold;
  9. `multi_stage_engine` for the test account.
* **PR #481** must be rebased: #489 also edits `agent/src/runMission.ts`.

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
