# Per-job cap 600 -> 25,000 points: owner proposal (NOTHING HERE IS APPLIED)

**Owner decision (final):** a customer can request about 300 Facebook posts about a topic with about 5 comments per post (1,500 comments) in one plan.
**Recommended cap: 25,000 points (2,500 EGP).** It is ONE shared constant in code, `JOB_MAX_POINTS_CAP` in `src/lib/jobPointsCap.ts`, and ONE number in SQL (below).

Why 25,000: the reserve of that request is `ceil(300 x 8 x 1.15) + ceil(1,500 x 11 x 1.15) = 2,760 + 18,975 = 21,735` points (posts 8 points and comments 11 points, each rounded
up by the older whole-point rule; the 15% buffer is on the reserve only). 22,000 is the least that holds it; 25,000 holds it with about 15% to spare, so a small price
change or "about 300 posts, about 6 comments each" does not need another SQL change. The charge of a full delivery is `ceil(delivered x unit price)` = 18,900 points, never above the reserve.

State: proposal and replica tests only. No SQL was applied to Supabase, no Vercel setting was changed, no provider was called.
Every function keeps `SECURITY DEFINER` and its pinned `search_path`; execute is revoked from `PUBLIC`, `anon` and `authenticated` and granted to `service_role` only (the last two statements of each file).
The function bodies are the PRODUCTION definitions read with SELECT on 2026-10-21 (`tests/replica/prod-definitions/`); only the cap number changes. Run `00_verify_before_apply.sql` first.

## What changes (the cap constant, nothing else)

| Step | File | Change |
|---|---|---|
| 1 | `01_settle_job_atomic_cap_25000.sql` (+ `.rollback.sql`) | `settle_job_atomic`: default of `p_points_cap` 600 -> 25000. The charge stays `LEAST(ceil(delivered x unit_price), reserved, p_points_cap)`. |
| 2 | `02_settle_people_job_atomic_cap_25000.sql` (+ rollback) | `settle_people_job_atomic`: default of `p_points_cap` and the hard `600` inside `LEAST(...)` -> 25000. |
| 3 | `03_settings_pricing_job_cap_25000.sql` (+ rollback) | `settings_private` row `pricing`: `jobMaxPointsCap` 600 -> 25000 (data, one number, idempotent; no money table). |
| 4 | `04_create_quote_atomic_cap_25000.sql` (+ rollback) | `create_quote_atomic`: `v_cap` 600 -> 25000. **This is the step that opens the gate.** |
| 5 | `05_verify_after_apply.sql` | Read-only checks to paste after each step; the expected answer is in each comment. |

**Apply order: 1, 2, 3, 4, then 5 (after each).** Steps 1 to 3 only lift an upper limit that a charge never reaches (the charge is also `LEAST`-ed with the reserve), so nothing can be sold above 600 until step 4.
**Rollback order: 4, 3, 2, 1** (the gate closes first). A rollback never rewrites money history: ledger rows written under the new cap stay (the ledger is append-only).
**Deploy the code AFTER step 4.** The code in this PR plans up to 25,000; with the old quote writer a quote above 600 is refused by the database.

The replica test `tests/sql/job-cap-25000.replica.test.ts` (real PostgreSQL 16 with the production schema and bodies) proves: 601 refused and 600 accepted at the baseline; the steps apply in order; 25,000 is accepted and
25,001 refused; the owner's job (1,800 records at 10.5 points, reserve 21,735) is accepted and charged 18,900 (the old default would have cut it at 600); a partial delivery charges `ceil(delivered x price)`; nothing delivered
releases the whole hold; settling twice charges once; a charge is never above the reserve; decision-maker settlement is above 600 and clipped by reserve and cap; only `service_role` can execute; the ledger stays append-only;
the steps write no ledger row; every step and every rollback applies twice; every rollback restores each definition byte for byte (md5 of `pg_get_functiondef`).
Run it: `npx vitest run tests/sql/job-cap-25000.replica.test.ts` (skipped visibly when no local PostgreSQL server is installed).

## What does NOT change, and why the record limit stays 5,000

* **`accept_quote_atomic`'s record limit (`v_target_max > 5000`) is unchanged.** The owner's request needs 300 posts and 1,500 comments, and every service ceiling in code is at or below 5,000 (X posts 4,500, TikTok and YouTube comments 2,000,
  Facebook comments 1,500); the plan schema in `planManager.ts` (`max(5000)`) agrees with it.
* **`accept_quote_atomic` accepts ONE item per quote** (`single_item_quote_required`; the app says the same, `src/lib/supabase/quoteAccept.ts`). Neither is changed. A plan of two services (a posts service and a comments service) can be shown but still cannot be approved.
  The owner's request is therefore served as ONE item: the service `social-facebook-keyword-comments` (a keyword, the posts found and judged, their comments; 12.925 points a comment, 1,500 comments, reserve 22,296). The replica test
  `tests/sql/job-cap-25000.replica.test.ts` accepts that one item after the steps below and charges 19,388; it also shows the database still refusing two items. See `docs/COST_REPORT_FACEBOOK_TOPIC_300.md`.
* Unit prices, the 15% buffer, the charge formula, the ledger ids (`res_`, `rel_`, `chg_`), release-first and idempotency are untouched.

## Risks the owner must weigh

1. **Provider balance.** One point costs the platform at most `1 / 5,500` USD at the unit-price rule. A full 25,000-point job can in the worst case spend about 4.5 USD of provider money (the request above is estimated at about 0.65 to 1.2 USD, see `docs/COST_REPORT_FACEBOOK_TOPIC_300.md`).
2. **The provider daily limit (admin-editable, default 0.80 USD) is now the real brake.** The plan gate estimates the keyword mission at 1,500 x 0.00235 = 3.525 USD and, because the gate keeps 10% back, needs 3.92 USD of the day's remaining limit and of the provider's real balance. For a plan above 600 points it REFUSES the request
   in one Arabic sentence instead of clipping it (`src/lib/capacityRefusal.ts`). To let it through the admin must raise the daily limit in «حدود المزود»; no code change is needed. The estimate of the job itself is 3.5 USD on the stated assumptions and at most 5.0 USD by the adapter's own bounds.
3. **Long jobs on Vercel Hobby.** The page must stay open (driver mode `tab`): 1,800 records is about 36 chunks at 50 rows; the always-on driver is still not installed.
4. **A bigger hold.** The customer's balance is held for the whole duration; the concurrency limit (2 active jobs) is unchanged.
5. **People jobs.** The cap is shared: a decision-makers job (193 points a person) can now reserve up to 25,000 points (about 112 people) against the more expensive provider; the daily limit and the 5,000-record limit still apply.
6. **Per-job and per-user provider limits** (`perJobUsd`, `perUserDailyUsd`, admin-editable) still apply and are not changed.

## Alternative kept for later

`docs/proposals/job-cap-balance/` (policy: the cap follows the customer's balance) is untouched and still valid as the later, more general design; it would replace the constant in step 4 by `job_points_cap_for(user)`.
