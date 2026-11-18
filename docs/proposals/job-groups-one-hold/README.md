Never DROP or REVOKE anything of this proposal; never revert PR-1…PR-9 or PR-12 as a rollback. The only stop is reverting PR-10.

# Job Groups with One Hold (One Approval, Sequential Parts, Write-Once Frozen Copies)

## 1. What and Why
For large requests where target volume exceeds what a single provider execution or job points cap allows (e.g. 120 companies where single-task volume is capped at 40), this proposal implements a sequential multi-part job group:
- **One Customer Approval**: The entire points reservation is held in one atomic reserve transaction (`res_grp_...`) at the start.
- **Sequential Execution**: Parts 1..K execute sequentially. Each part receives its reserved points from the group hold via a ledger transfer (`gdr_...` / `res_...`).
- **Write-Once Frozen Copies (D-1, K-1)**: No group part is ever charged until an immutable frozen dataset file has been uploaded to storage and bound atomically with its charge in `job_group_frozen` and `job_group_keys`.
- **Fail-Closed Unfrozen Handling (K-1f)**: If a completed chunk cannot produce a verified frozen dataset within the 20-minute freeze give-up window, it is released (never charged), the group is halted, and closed with `part_unfrozen`.
- **One Remainder Release**: Exactly one final line and remainder release (`rel_grp_...`) is recorded when the group closes.
- **Zero Alterations to Existing Functions**: `accept_quote_atomic`, `settle_job_atomic`, `release_job_atomic`, etc., remain 100% byte-identical.

## 2. Apply Order (GATE S)
This proposal is applied at **GATE S** (after PR-9 is merged & deployed, and before PR-4; PR-4, PR-5, PR-12, and then PR-10 follow it):
1. **Run Proof on Scratch Postgres**:
   ```bash
   DIGER_PROOF=1 DIGER_TEST_PG=<host>:<port> npx vitest run tests/sql/job-groups.local-pg.test.ts tests/sql/job-groups-ops.local-pg.test.ts --reporter=verbose
   ```
2. **Execute `00_verify_before_apply.sql`**:
   - Paste into Supabase SQL Editor.
   - Compare V1 output with `/tmp/job-groups-expected-md5.txt`.
   - Ensure all V3 objects are absent (NULL / 0).
3. **Execute `01_job_groups_one_hold.sql`**:
   - Creates the tables, triggers, and functions F1–F6 wrapped in `BEGIN; ... COMMIT;`.
4. **Execute `02_verify_after_apply.sql`**:
   - Confirms V1 functions remain unchanged.
   - Confirms only `service_role` has execute grants on the new functions and select grants on the new tables.
   - Confirms the probe test returns `group_not_found`.

## 3. Rollback & Stop Procedures
- **Stopping New Groups**: The only approved rollback is reverting the PR-10 merge commit (`git revert <PR-10_merge_commit>`). This turns off new group card offerings immediately. Any group quote already issued remains approvable for its remaining 30-minute validity and runs to normal completion.
- **Ending Running Groups Early**: If an operator must close open groups early, run `04_report_open_groups.sql` first, then run `03_operator_close_open_groups.sql`. Any group accepted while 03 runs closes later through normal continuation.
- **Never**: Never run `DROP` or `REVOKE` on tables or functions.

## 4. Guarantees (H1–H9)
- **H1 (One Reserve)**: Exactly one reserve ledger entry is created for the group (`res_grp_...`).
- **H2 (Transfer, Not Double-Hold)**: Part reservations are funded from the group hold (`gdr_...`), never from the user's free balance.
- **H3 (Idempotent Draws)**: Duplicate calls to `draw_next_group_part_atomic` return `already_drawn: true` with zero duplicate allocations.
- **H4 (Exclusion Keys)**: Companies delivered in part $k$ are excluded from parts $k+1..K$.
- **H5 (Failed Part Tolerant)**: A failed part does not halt continuation; the next part is drawn from the group hold.
- **H6 (Atomic Close)**: Remainder points release (`rel_grp_...`) and the final progress event line are committed in the same transaction as the group closure.
- **H7 (Cap Invariant)**: Total points held across all open parts and remainder never exceed initial hold $G$.
- **H8 (Charge Invariant)**: Total charged points never exceed delivered units across completed parts.
- **H9 (Freeze-Before-Charge)**: A group part is never charged before its write-once frozen copy and deduplication keys are committed to the database.

## 5. Fairness & Time Semantics
- **C-2 Fairness**: Round-robin selection among open actionable groups via `claim_next_job_group` ordered by `last_attempt_at NULLS FIRST, id` with `SKIP LOCKED`.
- **Freeze Budget**: 30-second budget per freeze attempt (`FREEZE_BUDGET_MS = 30_000`). If unfreezable or stuck retrying past 20 minutes (`FREEZE_GIVE_UP_MS = 20 * 60_000`), the part is released uncharged and the group halts.
- **Overdue Alerts**: `[job-groups:overdue]` is logged if an open group exceeds deadline + 2h 15m. `[job-groups:driver-stale]` is logged if `driver_heartbeat` has been silent > 10m. When seen, operators should run `04_report_open_groups.sql`.
