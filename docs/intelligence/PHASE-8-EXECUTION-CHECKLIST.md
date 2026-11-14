# Phase 8: the ONE integrated execution checklist (first live acceptance, capped at USD 0.30 in total)

**Status (14 Nov 2026): PREPARATION ONLY. Nothing here has been run. No SQL applied, no grant issued, no variable or switch changed, no paid call made. Spend to date: USD 0.00.** Live testing starts only after the owner separately approves actual spending (decision **D2**).

This file is the **master checklist**. Exact commands live in `docs/intelligence/FIRST-LIVE-ACCEPTANCE-RUNBOOK.md` (referred to as "runbook §n"); the SQL facts, rehearsal and rollback are in `docs/proposals/spend-gate/SQL-PREFLIGHT.md`; what the code covers is in `docs/intelligence/SPEND-SAFETY-ACCEPTANCE.md`.

## 1. Three tiers, kept apart

| Tier | What | Who | Spends money |
|---|---|---|---|
| **A. Safe preparation** | Merge the inactive code, verify the deployment, read-only production checks, offline rehearsal, documents | Claude | **no** |
| **B. Production changes, zero spend** | Apply the SQL, set provider-side limits, confirm backups and the absence of a database password in the web configuration | **Owner**, after approval **D1** | **no** (no grant exists: every reservation is refused) |
| **C. Paid execution** | Issue the one grant, configure the worker, switch the test account, run one mission | **Owner**, after separate approval **D2** | **yes, at most USD 0.30 in total** |

Between B and C there is an **independent verification gate** (G5): Claude re-reads production read-only and the owner's evidence, and reports GO or NO-GO for D2. Live testing does not start before it says GO **and** D2 is given.

## 2. The hard-guarantee statement (what may and may not be claimed)

1. **Never claimed:** that detecting an overrun afterwards (a trip) caps spending. A trip stops *later* calls; the call that exceeded has already been billed.
2. **What the gate does:** before any paid call of an enrolled mission it atomically reserves a **defensible maximum charge** against one cumulative USD 0.30 (spent + held + overrun, across every campaign grant); no reservation, no request; an unknown, delayed or unreported charge counts as the **whole reserved bound**, never zero; a restart, expiry or revoke gives nothing back. This is a **hard cap on the bounded exposure**, provided the bound itself holds.
3. **Where the bound is a documented maximum:** TREG (the route cap sent in `X-Treg-Route-Max-Cost`, one attempt, no key-pool hop: an explicit token), Context.dev and Firecrawl (documented credits per operation; pre-built parsers refused), the Agent SDK's output (`max_tokens`, lowered to the owner's cap, proposed 8,000).
4. **Where it rests on an assumption (the one honest gap):** the model **input**. The bound is `(request bytes + 4,096)` tokens priced at the dearest rate the request allows (long-context price above 100K tokens, 2× for a one-hour cache write). It assumes a token covers at least one byte of the request (true of byte-level tokenizers). Anthropic publishes **no guarantee** of that. The gate checks every answer's `usage` against the bound and a violation trips the grant, which is **detection, not prevention**. A provider-independent ceiling on one request does exist (the model's context window), but for Haiku 5.5 (1M-token window; USD 0.10 / 0.50 per million tokens up to 100K, 0.50 / 2.50 beyond) it is far above the per-operation maximum of 0.10, so it cannot replace the assumption.
5. **What makes the cap independent of our code:** only the **provider-side limits**. From Anthropic's documentation (read 14 Nov 2026): spend limits are set **per workspace** in the Console (not on the Default Workspace, so a dedicated workspace and key are required), are **monthly**, can only be lower than the organization's limit, and when reached requests fail with HTTP 400; the documentation does **not** state how fast they are enforced or the smallest amount, so treat the spend limit as a **backstop, not an exact USD 0.30 cap**. A workspace's **rate limits** (requests, input tokens and output tokens per minute) can also be set per workspace and cap the *burn rate*. An organization on **prepaid credit with auto-reload off** stops serving when the balance is exhausted. Sources: [Workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces), [API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers). TREG, Context.dev and Firecrawl plan caps were **not** read and are **not verified**: the owner supplies them.
6. **The sentence that may be said once G4 and G5 pass:** "Spending is capped by an atomic pre-send reservation at USD 0.30 in total, under the stated bounds and the tokenizer assumption; independently of Diger's code, provider-side limits bound the worst case at **the sum of the limits the owner set** (recorded in §6, G4)." It is **not** "USD 0.30 is guaranteed."
7. **Residual cases not prevented by any of this:** a leaked service or provider key (provider limits are the only control; any holder of the service key can settle a held reservation at zero and free its bound), a provider billing beyond its own documentation, and the paid paths the campaign does not cover (the website's customer chat, planners, reverse lookup, admin tools and scripts: **forbidden for the test account during the window**, not technically blocked).

## 3. The approval decisions

### D1: approve preparation with zero spend (one decision, one message)

Approving D1 means the owner authorizes **only** these, each at its stated step, and nothing that spends:

1. Merge of the inactive code (done in tier A before D1 is asked, if approved earlier; recorded in §7).
2. **G3:** applying `001_spend_gate.sql`, `003_campaign_scope.sql`, then `002_verify.sql` and `004_verify_campaign.sql`, exactly as in `SQL-PREFLIGHT.md` §7, after the owner confirms a backup.
3. **G4:** setting provider-side limits and reading them back (§6) and confirming no `DATABASE_URL` or database password in the Heroku or Vercel configuration.
4. The assumption in §2 item 4 is **accepted as stated** (or the owner asks for the free `count_tokens` cross-check to be built first; not built).
5. The campaign shape: Haiku only, `max_tokens` cap 8,000, Context.dev pre-built parsers refused, one mission, 3-hour window.

D1 does **not** authorize: a grant, a worker variable, an Intelligence switch, a mission, or any paid call.

### D2: approve actual spending (separate, after G5 says GO)

The owner states, in one message: the campaign id, the test account id, the ceiling (0.30), the window (3 hours), one mission, and that G6 to G13 may run. D2 expires with the window.

## 4. True remaining blockers (as of 14 Nov 2026)

| # | Blocker | Closed by |
|---|---|---|
| 1 | The SQL is not applied on production (the gate has no store) | D1, G3 |
| 2 | Provider-side limits are not set or not evidenced (the only independent cap) | D1, G4 |
| 3 | No rehearsal or failure test on the production store | free, inside D2 (G6), before any variable or switch |
| 4 | `PRODUCTION_BUDGET_GUARANTEE` is still `enforceable:false`, so the admin acceptance panel keeps refusing | **Not blocking** the first test (the runbook does not use the panel); a separate reviewed change replaces it with a live check afterwards |
| 5 | Usefulness, not safety: a long mission can meet the per-operation maximum and end unserved | accepted in D1; it is the safe failure |

Everything else is closed in code and tested offline (see the acceptance report).

## 5. The checklist

`Who`: **C** = Claude, **O** = owner. Each step is verified before the next starts. A step that fails stops everything and goes to §5a "Stop and rollback".

| ID | Step | Who | Evidence required | Stop if |
|---|---|---|---|---|
| **G0** | Verify `main`, the PR head, the full diff (money and security), tests, typechecks, build, secret scan | C | Section 7 | any failure |
| **G1** | Merge the inactive code at the verified head; verify Vercel production and the worker heartbeat on the merge SHA; `DIGER_SPEND_GATE` stays unset | C | §7 | a mission is `queued`/`planning`/`executing` at merge; deployment not READY on the SHA |
| **G2** | Preflight and rehearsal | C | `SQL-PREFLIGHT.md` §6 `REHEARSAL OK` | any `false` |
| **G3** | Backup confirmed, then apply 001 + 003 and run both verifies | **O** (D1) | 15 + 13 + 15 rows all `true`; security advisor shows no new finding; `spend_gate.grants` is empty; ledger unchanged | any `false` or error: run the rollbacks |
| **G4** | Provider-side limits set and read back (§6); no `DATABASE_URL` in Heroku or Vercel | **O** (D1) | the §6 table filled with the values and where they were read | a limit cannot be set; a database password is present |
| **G5** | **Independent verification gate:** read-only checks of production (objects exist, no grant, grants of `service_role` limited to five functions, `credit_ledger` unchanged, no active mission) plus the owner's G3/G4 evidence | C | a written GO or NO-GO | any mismatch |
| | **D2: the owner's separate approval to spend** | **O** | the message of §3 | none given |
| **G6** | Issue the one campaign grant (runbook §2.1), then the free rehearsal as `service_role` (runbook §2.2): `mission_not_enrolled`, `over_op_max`; confirm `spend_status` shows campaign `true`, ceiling 0.3, enrolled 0 | **O** | the three answers | any other answer; `spend_stop` at once |
| **G7** | **Worker enforcement:** set `DIGER_SPEND_GATE=campaign`, `DIGER_SPEND_CAMPAIGN_ACCOUNT`, `DIGER_SPEND_MAX_OUTPUT_TOKENS=8000` (runbook §2.3); the log says `CAMPAIGN scope`; the heartbeat shows the new process with 0 active missions | **O** + C reads | the log line | the worker does not start, or the line says `ENFORCE` or `OBSERVE`: unset both variables |
| **G8** | **Account isolation:** only the test account's mission is enrolled (`enrolled` 1); no other account's mission is `queued`/`planning`/`executing` unexpectedly, and ordinary customers' paid calls are unchanged (their missions never touch the gate) | C | `spend_status`; mission list read-only | a non-test mission enrolled; a customer mission refused |
| **G9** | Intelligence switches for the **test account only**, with expiry (runbook §3) | **O** | the scoped values with `expires_at` | a switch without a scope |
| **G10** | **One real mission:** request, plan (priced maximum ≤ 0.10), explicit approval in the console, execution. Watch `spend_status` every minute | **O** + C reads | `spent + reserved` ≤ 0.25; the mission progresses | `spent + reserved` > 0.25, state `tripped`, no progress for 10 minutes: §5a |
| **G11** | **Delivery:** Excel, CSV and PDF downloaded and checked against the scenario (runbook §8 and §9) | **O** | counts match; sources shown; no provider or price names; Arabic renders; PDF opens | a private mailbox delivered; counts differ without a stated shortfall |
| **G12** | **Settlement:** gate reservations all `settled`, `overrun_usd` 0; one reservation and one settlement for the mission in `credit_ledger` (no duplicate charge); points reserved = charged + released; the mission's recorded call costs against the gate's `spent_usd` (runbook §10) | **O** + C reads | the three tallies | any `held`/`expired` row unexplained; a second ledger charge |
| **G13** | **Close-out:** `spend_stop` or `revoke_grant`, unset the two worker variables and restart, let the switches expire, owner review (runbook §11 and §12). The campaign's 0.30 is spent for good | **O** | final grant state recorded | n/a |

## 5a. Stop and rollback (any time, each step safe to repeat)

1. `select public.spend_stop('manual stop');` then `select spend_gate.revoke_grant('<id>','manual stop');` (the second as the owner role).
2. Unset `DIGER_SPEND_GATE`, `DIGER_SPEND_CAMPAIGN_ACCOUNT`, `DIGER_SPEND_MAX_OUTPUT_TOKENS`; restart. The worker is exactly as today.
3. Delete or let expire the scoped switches.
4. A running mission stops on its next refused call; delivered rows are charged, the rest is released by the existing settlement.
5. SQL rollback only if wanted: `003_campaign_scope.rollback.sql` (refuses while any campaign grant exists), then `001_spend_gate.rollback.sql` (refuses while a reservation is held).
6. Provider side: lower or remove the workspace key; this is also the control for a leaked key.

**Stop rules, always:** any spend above 0.30; the account not shown as the test account; a refusal the owner did not expect; `NOT ENROLLED` for the mission; the worker log not showing `CAMPAIGN scope`; a mission started during a deployment, or a deployment during the mission.

## 6. Provider-side limits: the table the owner fills at G4

| Provider | Control to set | Value | Read back where and when | Worst case if our gate failed |
|---|---|---|---|---|
| Anthropic | A **dedicated, non-default workspace** and key for the worker; monthly spend limit on it; rate limits on it (input and output tokens per minute); prepaid balance with auto-reload off if the organization uses prepaid credit | | | the workspace limit (monthly, not instant) |
| TREG | The worker key's balance or plan cap; the per-call route cap is already sent | | | the key's remaining balance |
| Context.dev | The plan's credit cap | | | the plan's remaining credits |
| Firecrawl | The plan's credit cap | | | the plan's remaining credits |

The worst case of the whole campaign if the gate failed is the **sum of the last column**. The owner decides if that sum is acceptable (D1 item 3). If the Console refuses a spend limit as low as USD 0.30, the owner records the lowest it accepts here and the sentence of §2 item 6 uses that number.

## 7. Evidence log (Claude fills; every line states what was observed)

| Item | Observed |
|---|---|
| `main` before the merge | `e550178424976c9a76e98f6156b8fb4c63590d52` |
| PR #498 head reviewed | `7c04cedec650697a27c0e32eb62a2297720c6685` (the head to merge is stated in the PR conversation and the final report) |
| #481 superseded | all 22 files of #481 are present in #498; the only differences are later `main` work and the campaign additions (checked line by line: every line #481 added is in #498 except the lines this milestone rewrote on purpose) |
| Independent review of the money diff | one reviewer, reading only. **Fixed before merge:** a TREG answer with no reported charge settled at 0 (now unknown); Context.dev `credits_consumed: null` read as 0 (now unreported). **Open notes** (documented, not changed): any `DIGER_SPEND_GATE` value other than `off`/`0`/`observe` means enforce, so a typo with no account id makes the worker refuse every account's paid calls (the runbook's stop rule catches it: the log must say `CAMPAIGN scope`); a service-key holder can settle any held reservation at 0; the `spend_reserve` replay branch answers `ok` before the grant-state checks (not reachable, keys are random per attempt) |
| Offline gates after the fixes | see the acceptance report §7 |
| Production facts (read-only, 14 Nov 2026) | `SQL-PREFLIGHT.md` §2 |
| Merge SHA, Vercel production, Heroku heartbeat | filled at G1, in the PR conversation and the final report |
