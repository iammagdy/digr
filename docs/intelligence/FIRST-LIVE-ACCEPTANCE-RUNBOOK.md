# First live acceptance: exact runbook (PREPARATION ONLY, nothing here has been run)

**Status (14 Nov 2026): NOT AUTHORIZED, NOT STARTED.** This is the procedure for ONE test-account-only, hard-capped (USD 0.30 in total) Intelligence acceptance mission, **after** the owner approvals of `docs/intelligence/SPEND-SAFETY-ACCEPTANCE.md` §10. Every step that changes production is marked **[OWNER]**. A step marked **[READ-ONLY]** changes nothing. No step may be started before the one above it is verified.

**This runbook is the command appendix of the master checklist `docs/intelligence/PHASE-8-EXECUTION-CHECKLIST.md`** (gates G0 to G13, the two approval decisions D1 and D2, and the exact guarantee statement). The SQL facts, the offline rehearsal and the rollback table are in `docs/proposals/spend-gate/SQL-PREFLIGHT.md`. Where the two differ, the checklist wins.

**What the cap covers, exactly:** the worker's paid calls (TREG, Context.dev, Firecrawl, the Agent SDK's model requests, the review requests) for the missions ENROLLED in the campaign grant, which belong to the test account. It does **not** cover the website's customer chat, the admin reverse lookup, the TREG key check, the smoke test or any script. Those must not be used for the test account while the window is open (step 0).

## 0. Preconditions

1. No mission is `queued`, `planning` or `executing` (**[READ-ONLY]**: `select status, count(*) from missions where status in ('queued','planning','executing') group by 1;`). The worker is deployed on the commit that contains the campaign gate (heartbeat `version` equals the merge SHA of the spend-safety PR).
2. `DIGER_SPEND_GATE` and `DIGER_SPEND_CAMPAIGN_ACCOUNT` are unset on Heroku and Vercel (key names only).
3. Nobody uses the customer chat, the reverse lookup, the TREG key check or the smoke test with the test account during the window.
4. The execution model is Haiku (the default; `AGENT_MODEL` unset or Haiku) and the `planning_model` setting is unset or Haiku. **Sonnet cannot run under this cap** (its smallest request bound is above the grant's per-operation maximum, §6 of the acceptance report).
5. No database password or `DATABASE_URL` is set on Heroku or Vercel (SPEC-v2 decision 4): without that the grant's separation does not hold.
6. Provider-side limits exist and are **read back** (checklist §6, G4): a **dedicated, non-default** Anthropic workspace and key for the worker (Anthropic does not allow a spend limit on the Default Workspace) with a monthly spend limit and token rate limits on it, and prepaid credit with auto-reload off if the organization uses prepaid credit; plan caps at TREG, Context.dev and Firecrawl. The spend limit is monthly and its enforcement speed is not documented: it is a **backstop**, not an exact USD 0.30 cap. These limits are the only control against a leaked key and against the tokenizer assumption.

## 1. Apply the database objects **[OWNER]** (DONE on 14 Nov 2026: applied by the owner and re-confirmed read-only; do NOT re-apply. See the checklist §8.1. Keep this section for the rollback.) (Supabase dashboard SQL editor, the database owner role)

First read `docs/proposals/spend-gate/SQL-PREFLIGHT.md` (what the files do, the production facts, the grants matrix, the rollback table) and confirm a backup. Apply in this order, each in its own run:

1. `docs/proposals/spend-gate/sql/001_spend_gate.sql`, then `002_verify.sql`: every row must say `true`.
2. `docs/proposals/spend-gate/sql/003_campaign_scope.sql`, then `004_verify_campaign.sql` and `002_verify.sql` again: every row must say `true`.

No grant exists after this: every reservation is refused (`no_grant`). Nothing calls these functions yet (the worker gate is off).

## 2. Scoped campaign activation **[OWNER]**

**One mission only, and in this order.** The grant enrolls the FIRST mission of the test account that the worker claims after step 3 (`max_missions` 1). Create no other test-account mission (and do not touch the older `plan_ready` one) until the L4 mission of §4 has finished; create the L4 mission only after step 3 is verified.

1. **Issue the campaign grant** (the immutable campaign id is the first argument; use a new id for every issue; the account is the test account's id, never an e-mail):

```sql
select spend_gate.issue_campaign_grant(
  'camp-l4-001',                    -- campaign id, unique and immutable
  '<TEST_ACCOUNT_ID>'::uuid,        -- the test account (the admin console's test account)
  0.30,                             -- cumulative ceiling for the WHOLE campaign
  0.10,                             -- per operation maximum
  0.30,                             -- per mission maximum
  '{provider,model}',               -- kinds: never chat or eval
  now(), now() + interval '3 hours',
  1,                                -- enrolled missions: ONE
  'owner', 'first live acceptance (L4)');
```

   The function refuses a ceiling above 0.30, a window above 72 hours, more than 5 missions, and any total that would pass 0.30 counting everything earlier grants used or still hold.
2. **Rehearse (no paid call, **[READ-ONLY]** in effect: refusals write nothing)**, in the same editor as the API role:

```sql
set role service_role;
select public.spend_status();                                                                    -- campaign true, ceiling 0.3, enrolled 0
select public.spend_reserve('rehearse-1','provider','x',0.001,'msn_not_enrolled',60);            -- must say mission_not_enrolled
select public.spend_reserve('rehearse-2','provider','x',0.5,'msn_not_enrolled',60);              -- must say over_op_max or mission_not_enrolled
reset role;
```

3. **Configure the worker (Heroku)**, then restart it:
   * `DIGER_SPEND_GATE=campaign`
   * `DIGER_SPEND_CAMPAIGN_ACCOUNT=<TEST_ACCOUNT_ID>`
   * `DIGER_SPEND_MAX_OUTPUT_TOKENS=8000` (owner decision: the lower the cap, the smaller each request's bound; see §6 of the acceptance report).
4. **Verify (read-only):**
   * the worker log shows `spend gate: CAMPAIGN scope (account <first 8 characters>…)`. **If the worker does not start, or the line says `ENFORCE` or `OBSERVE`, stop and unset both variables.**
   * the worker heartbeat shows the new process and `active_missions 0`.
5. The admin acceptance panel («حملة القبول الحي») stays **refused** (`budget_not_enforceable`): `PRODUCTION_BUDGET_GUARANTEE` is a reviewed constant, replaced only by a separately approved change. This runbook therefore does **not** use the panel.

## 3. Intelligence switches for the test account only **[OWNER]**

Set the L4 switches in the scoped form with an expiry (the exact form `docs/intelligence/ACCEPTANCE-WORKFLOW.md` §4 describes): `{"user_ids":["<TEST_ACCOUNT_ID>"],"expires_at":"<now + 2 hours, ISO>"}` for `semantic_normalization_v1`, `capability_discovery_v1`, `registry_router`, `web_via_treg`, `multi_stage_engine`. **Do not set `customer_exclusion_files_v1`** (the exclusion file path is Phase 5.3-B territory and the free re-run drops the list). The switches turn themselves off at the expiry.

## 4. One representative Intelligence mission

1. In the admin agent console (`/admin/agent`) create the L4 mission for the test account with the scenario request (`B2B_ACCEPTANCE_REQUEST_AR`: two Egyptian-exchange companies headquartered in Cairo, one decision-maker each, work e-mail and professional phone if available).
2. The worker **claims** it, **admits** it (the gate reads the mission's own `user_id`) and **enrolls** it in the grant. Log line: `spend_gate campaign msn_… ENROLLED`. **If the line says `NOT ENROLLED`, every paid call of the mission is refused: stop and read the reason.**

## 5. Customer request and plan

1. Planning runs (model requests through the model gate; TREG and web calls reserved first). The mission reaches `plan_ready`.
2. Read the plan card: stages, sources, the estimated points, the maximum charge, and that each stage names a source. **Check:** the priced maximum is within the L4 scenario ceiling of USD 0.10.

## 6. Explicit plan approval **[OWNER]**

Approve the plan **in the console** (the existing `approvePlan`, test account only). Nothing in this campaign approves it. The approval reserves the test account's points by the existing quote path; the gate never touches points.

## 7. Provider execution

The worker executes. Watch (read-only), every minute:

```sql
set role service_role; select public.spend_status(); reset role;   -- spent_usd + reserved_usd must never pass 0.30
```

**Stop at once (see §11)** if `spent_usd + reserved_usd` passes 0.25, `state` becomes `tripped`, or the mission has made no progress for 10 minutes.

## 8. Actual public-data results

When the mission is `delivered` (or ended with a stated shortfall), check against the scenario checklist (`scenarios.ts`, L4 `checksAr`): two real companies with a source per row; each person works at their company; the work e-mail is not a personal mailbox; the verification status is shown; the delivered count equals the requested count or the shortfall is stated.

## 9. Excel / CSV / PDF delivery

Download the three files from the mission's job. Check: the row counts match; no provider or price names appear in customer-visible text; Arabic renders; the PDF opens.

## 10. Cost and point accounting; no duplicate charges (read-only)

* The gate: `select * from spend_gate.reservations order by held_at;` as the database owner. **Expected:** every row `settled` (none `held`, none `expired` unless a call was cut), `spent_usd` at or under 0.30, `overrun_usd` 0.
* The customer side: one reservation and one settlement for the mission in `credit_ledger` (no second charge); `charged_points` plus released points equals the reserved points; the balance moved by the charge only.
* The campaign's real cost: the sum of the mission's recorded calls (`planning_treg_usd`, `execution_treg_usd`, `llm_usd`) against `spent_usd` of the grant.

## 11. Safe stop and rollback

Any time, in this order (each step is independent and safe to repeat):

1. **Stop spending now [OWNER or service role]:** `select public.spend_stop('manual stop');` (trips the open grant: every later reservation is refused; nothing new is sent). To end it for good: `select spend_gate.revoke_grant('camp-l4-001','manual stop');` (owner).
2. **Remove the worker setting:** unset `DIGER_SPEND_GATE` and `DIGER_SPEND_CAMPAIGN_ACCOUNT`, restart. The worker returns to today's behaviour.
3. **Switches:** delete the scoped switch values (or wait for their expiry).
4. **A running mission** stops on its next refused call and ends as an `over_budget`-style stop: delivered rows are charged, the rest is released. If it does not end, use the existing admin stop.
5. **SQL rollback (optional):** `003_campaign_scope.rollback.sql` refuses while a campaign grant exists; `001_spend_gate.rollback.sql` refuses while a reservation is held.

## 12. Final owner review

The owner reviews: the grant's final state (`spent_usd`, `overrun_usd`, `state`), the reservations table, the ledger check of §10, the files, and the worker's `spend_gate.summary` log line for the mission (counts and amounts only). The campaign's ceiling is **spent for good**: a new campaign needs a new owner decision, and the 0.30 total counts everything this one used.

## Stop rules

Any spend above the ceiling; the account not shown as the test account; a refusal the owner did not expect; a private mailbox delivered; `NOT ENROLLED` for the mission; the worker log not showing `CAMPAIGN scope`.
