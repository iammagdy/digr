# Per-job cap relative to the customer's balance: owner proposal (NOTHING HERE IS APPLIED)

**Owner goal:** the limit on one request should be the customer's points balance, not a fixed per-job cap.
**State:** proposal and replica tests only. No SQL was applied to Supabase, no Vercel setting was changed, no provider was called.
Every step has a rollback. Every function is `SECURITY DEFINER`, has a pinned `search_path`, and is revoked from `PUBLIC`, `anon` and
`authenticated` and granted to `service_role` only.

## What enforces the cap today (read from the repository; `file:line`)

**SQL (the real gate is the first one):**

| What | Where |
|---|---|
| A quote whose reserve is above **600** is refused: `v_cap numeric := 600`, `p_total_points > v_cap` | `supabase/migrations/20261017180000_create_quote_atomic.sql:19` and `:28-29` |
| `settle_job_atomic`: charge = `LEAST(ceil(delivered x unit_price), reserved, p_points_cap)`, `p_points_cap` defaults to **600** | `supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql:3` (default) and `:98` (the `LEAST`) |
| `settle_people_job_atomic`: `LEAST(raw, reserved, COALESCE(p_points_cap,600), 600)`: a hard **600** inside the function | `supabase/migrations/20261017181000_settle_decision_maker_fields.sql:7` (default) and `:75` |
| The seeded setting the worker reads (`settings_private` key `pricing`, `jobMaxPointsCap`) | `supabase/migrations/20261012200628_seed_initial_configuration.sql:25` |
| The first version of `settle_job_atomic` (superseded by the one above) | `supabase/migrations/20261012135427_settle_job_atomic_functions.sql:5` |

No other money function holds the number: `reserve_credits_atomic` and `accept_quote_atomic` only compare the reserve with the balance.

**TypeScript (the plan is cut to the cap before the quote is written, so the SQL gate is rarely reached):**

| What | Where |
|---|---|
| The one constant: `JOB_MAX_POINTS_CAP = 600`; the environment may only lower it (`effectiveJobPointsCap`) | `src/lib/jobPointsCap.ts:8`, `:11-14` |
| The cap in force for a plan: `Math.min(getConfiguredJobPointsCap(), DEFAULT_JOB_POINTS_CAP)` | `src/functions/shared/planManager.ts:622` (cut to it at `:829-885`) |
| `getConfiguredJobPointsCap()` returns `effectiveJobPointsCap()` | `src/functions/shared/providerSpend.ts:56-58` (`DEFAULT_JOB_POINTS_CAP` at `:9`) |
| The worker reads `jobMaxPointsCap` from settings (NOT clamped to 600) and passes it as `p_points_cap` | `src/app/api/worker/chunk/route.ts:139-148` and `:2210`, `:2215` |
| Other readers of the constant | `src/lib/calculatorPricing.ts:18,106,130`, `src/lib/recordPricing.ts:115,120`, `src/functions/shared/decisionMakerPricing.ts:51,63`, `src/functions/shared/platformGuide.ts:22-23`, `src/lib/multiProvider/router.ts:36`, `src/functions/shared/multiStepWorker.ts:624,688` |
| A proposal constant that nothing reads (`JOB_MAX_POINTS_CAP_LARGE = 2000`, flag `LARGE_JOB_CAP_ENABLED`) | `src/lib/jobCaps.ts:14` |

**The Facebook ceilings are NOT the points cap; they are the service's own record ceilings (`src/lib/socialSources.ts`):**

| Service | Ceiling | Line |
|---|---|---|
| Facebook page **posts** | **60** records per job; cannot be raised by `LONG_JOB_SOCIAL_MAX_ROWS` (only comments, and posts of 500 or more, can) | `:612` (the raise rule: `src/lib/scaleConfig.ts:75-79`) |
| Facebook **comments** | **500** records per job (raisable by `LONG_JOB_SOCIAL_MAX_ROWS`) | `:572` |
| TikTok / YouTube comments | 2,000 | `:542`, `:557` |
| X posts | 4,500 | `:529` |
| TikTok videos / YouTube videos | 200 / 48 | `:586`, `:599` |
| Posts a page or channel contributes to one mission: `MAX_TOP_PER_CHANNEL = 20`, channels `MAX_CHANNELS_PER_JOB = 10`, mission videos `MAX_MISSION_VIDEOS = 100` | `:659-663` |
| Comments from one video: `maxPerVideo` (500), videos per job `maxVideosPerJob` (20) | `src/lib/scaleConfig.ts:41-42` (read at `src/lib/socialSources.ts:861-862`) |

Raising the points cap does **not** raise these. For the owner's example (400 Facebook posts with their comments) the ceilings, not the points, are what
limit the request today: 20 posts per page and 500 comments per job. Phase 5 says so plainly on the plan.

## What the proposal does

| Step | File | Effect |
|---|---|---|
| 1 | `01_job_cap_policy.sql` (+ rollback) | A policy row `job_cap_policy` in `settings_private` (default: `fixed` 600 = today), an append-only audit table, `job_points_cap_for(user)` and the audited admin setter `admin_set_job_cap_policy_atomic`. **Changes nothing by itself.** |
| 2 | `02_create_quote_atomic_policy_cap.sql` (+ rollback) | The quote writer reads the cap from `job_points_cap_for(user)` instead of the constant. With the policy on `fixed` 600 the answer is 600. |
| 3 | `03_settle_job_atomic_no_fixed_cap.sql` (+ rollback) | The charge is `LEAST(ceil(delivered x unit_price), reserved)`. The reserve was already held under the cap of the quote, so a second fixed cap at settlement could only **under-charge** a job whose reserve is above 600. |
| 4 | `04_settle_people_job_atomic_no_fixed_cap.sql` (+ rollback) | The same for decision makers (the hard `600` is removed). |
| 5 | `05_verify_after_apply.sql` | Read-only checks to run by hand after applying. |

Policy modes (all numbers are points; a hard maximum of **10,000** is inside the function and no setting can pass it):
- `fixed`: every reserve may be at most `fixedCap` (the **"raise it to a higher constant"** option: `{"mode":"fixed","fixedCap":3000}`).
- `balance` (the owner's goal): a reserve may be at most the customer's **available balance at the moment of the quote** (holds are already out of it),
  never below `balanceFloor` and never above `balanceCeiling`. The floor keeps a small-balance customer on today's 600 quote, so a plan above their balance
  can still be quoted and topped up for ("اشحن ثم ارجع إلى هذه المحادثة"). The ceiling is the safety limit for the provider (see the risks).

Order to apply by hand, in the Supabase SQL editor: 1, 2, 3, 4, then 5. Step 3 and 4 must be applied **before** the policy is set above 600 (otherwise a settlement still cuts the charge at 600).
Order to roll back: 4, 3, 2, 1. A rollback never rewrites money history: ledger rows written under the new cap stay (the ledger is append-only).

### What must also change in the app for the new cap to show (companion code change, NOT in this PR)
Applying the SQL alone changes nothing visible: the app still cuts every plan at 600 (`planManager.ts:622`) and says so. To use a higher cap the quote builder must
ask the same function for the customer's cap (one RPC call to `job_points_cap_for`) instead of reading the constant, the calculator and the public pages must read
the same number, and the worker must stop reading `jobMaxPointsCap` as a cap on the charge. That change is small, but it changes what customers are sold, so it waits for the owner's decision.

## Replica tests (scratch PostgreSQL 16, never Supabase)

`tests/sql/job-cap-balance.local-pg.test.ts` loads every repository migration (the baseline), then the steps, and checks at the OLD cap (policy `fixed` 600) and at a NEW cap
(`balance`, floor 600, ceiling 3,000): 601 is refused at the old cap and 600 accepted; at the new cap a customer may quote up to their balance and not one point more, a small
balance keeps 600, a rich customer stops at the ceiling, and a hostile or missing policy reads as 600, never as "no cap"; a settlement charges `ceil(delivered x unit price)`
(1,800 for 1,800 delivered, a rounded-up fraction, and exactly the reserve when more was delivered than the reserve covers), and the old function is shown cutting the same job at 600;
the decision-makers settlement charges 750 (above the old 600); settling twice charges once; no quote or cap read writes a ledger row; the ledger stays append-only; only
`service_role` can run any of the functions; the audit table is append-only; and the rollbacks restore the three functions byte for byte (`md5` of `pg_get_functiondef`).
Run it: `DIGER_TEST_PG=<socket dir>:<port> npx vitest run tests/sql/job-cap-balance.local-pg.test.ts` (skipped when no scratch database is set).

## Risks the owner must weigh before changing the cap

1. **Provider balance.** One point costs the platform about `1 / 5,500` USD (`src/functions/shared/quotes.ts:45`). A 3,000-point job can spend up to about **0.55 USD** of provider money
   (600 points = 0.11 USD). The provider account must hold that, and a failed job still spent what it spent before it failed. The reserve is what the customer holds; the provider is paid first.
2. **Daily limits.** The default provider daily limit is **0.80 USD** (`providerSpend.ts:7`; admin-editable). One 3,000-point job uses about two thirds of it, and two together pass it:
   the plan-time capacity gate (`planManager.ts`, "capacity") then cuts later plans, or the worker stops a job at the daily limit and delivers what it has. A higher cap without a higher daily limit
   mostly moves the stop from "the cap" to "the daily limit".
3. **Per-user limits.** `perUserDailyUsd` and `perJobUsd` (admin limits) still apply and may be lower than the new cap; they are not changed here.
4. **Long jobs on Vercel Hobby.** A function lives at most 60 s (the worker stops a chunk at 45 s) and a chunk reads about 50 records. A 3,000-point comments job is roughly 200 chunks:
   hours, not minutes. Today the chain continues by itself (`after()`) but a broken chain is resumed only by an open page, because the always-on driver is **not** set up (`LONG_JOB_DRIVER` unset, the
   database scheduler not installed); the daily watchdog refunds a job idle for more than 25 minutes. Until the driver is on, a bigger cap makes "keep the page open" a real cost for the customer.
5. **A bigger hold.** A customer's balance is held for the whole duration; a long job locks it for hours. The existing concurrency limit (2 active jobs) is unchanged.
6. **Quote drift.** The cap is read when the quote is written. A customer who tops up and re-quotes gets a higher cap; the quote already written keeps its own reserve.
7. **The 15% buffer** stays on the reserve only; the charge is never above the reserve (tested). The model never writes a number: the plan's text is built by code from the quote.

## Decisions for the owner
1. `balance` mode, or a higher fixed constant (and which number)?
2. The ceiling (the tests use 3,000; the function's hard maximum is 10,000).
3. Whether to turn on the always-on driver before raising the cap (recommended: see risk 4).
