# Exact minimum charge for a partial delivery: owner proposal (NOTHING HERE IS APPLIED; NO CODE DEPENDS ON IT)

**Rule (owner decision of 2026-10-28):** a mission that delivers at least one row is charged at least the minimum (200 points today, an admin setting); a mission that delivers nothing is charged nothing; the charge is never above the reserve and never above the cap.

## What the code already does without any SQL
`settle_job_atomic` charges `ceil(delivered_units x jobs.unit_price)` and a job stores ONE unit price. So `src/lib/missionPricing.ts` stores, as the job's unit, `max(rule unit, floor(minimum / volume))`:
a mission that delivers **everything it was sold** is charged exactly `max(minimum, ceil(volume x rule unit))` (300 tweets: unit 0.666666 and 300 rows = 200 points; reserve `max(200, ceil(300 x rule unit x 1.15))`).
Nothing in a money table is written by hand and no function was changed.

## What it cannot do (the reason for this proposal)
A **partial** delivery is charged in proportion to that unit, so 3 rows of 300 are charged 2 points, not 200. The database function cannot know the minimum. Writing the minimum into `delivered_units` would
make the count the customer sees wrong, so the code does not do it.

## The proposal
`01_settle_job_min_atomic.sql` creates a NEW function `settle_job_min_atomic(p_job_id, p_min_charge, p_points_cap, p_result_file_id)`: the body of the live `settle_job_atomic` (read with SELECT on 2026-10-28,
md5 `a7bb7aed118732d1664442cd13b978ac`) with one change, the charge: `GREATEST(ceil(delivered x unit_price), p_min_charge)` when delivered > 0, else 0; then `LEAST(.., reserved, cap)`.
The live function is NOT modified, so nothing that works today can break. Rollback: `01_settle_job_min_atomic.rollback.sql` (one `DROP FUNCTION`).
`02_replica_test.sql` is the replica test: run it on a scratch PostgreSQL (`psql -v ON_ERROR_STOP=1 -f 02_replica_test.sql`); it installs the live body and the new function side by side and asserts the eight cases listed in its header, then runs the rollback.
**It was NOT run by the session that wrote it** (no PostgreSQL server there), and it is a plain SQL script rather than a vitest file so that the repository's skipped-test count does not change.

## To use it (a separate change, after the owner's go)
In `src/lib/agentMission/lifecycle.ts`, `settleMission` would call `settle_job_min_atomic` with `p_min_charge = plan.price.minChargePoints` instead of `settle_job_atomic`, and `settlementChargeFor` in `src/lib/missionPricing.ts`
would apply `max(minimum, ...)` when delivered > 0. Until then the two stay as they are and this folder is documentation only.
