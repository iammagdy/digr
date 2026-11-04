# MONEY PR 7a: charges for the review, the review fix and the edit (DESIGN ONLY)

Branch `money/7a-design`, from `stage-4/review-edits-versions` at `d5336220`. Draft PR; never merged.

**This is Phase 1 of FOUNDATION-PLAN "PR 7", part 7a.**

- **What it is.** A design read from the code. Nothing here was run against a database. No code, test, config, flag or environment variable was changed, and no SQL of any kind was run (not even a SELECT).
- **What it is not.** Phase 2 (the code) needs its own brief naming the files. Staged jobs above 25,000 points are PR 7b (section 9).

**The design in ten lines.**

1. Each review, review fix or edit is an **add-on**: a new row in the existing `missions` table, linked to the delivered mission inside its existing `plan` JSON. There is no new table and no new column.
2. The add-on is priced **by code before approval**, with **no provider call**:
   - review: `reviewQuote`;
   - fix and edit: `priceMissionByCode` on a one-stage plan, with its per-row cost read from the delivered mission's own recorded calls, or from the catalog.
3. On approval, the add-on goes through the **existing money functions, unchanged**: `create_quote_atomic`, `accept_quote_atomic` (writes `res_<job>`) and `claim_job_chunk`. Its hold is the estimate plus the 15% buffer, at least 100 points.
4. The re-read runs only after approval, in the worker. Its provider budget is **hold ÷ 5,500 USD**, so the real cost times the markup can never pass the hold.
5. It is settled through the **existing `settleMission`**: `complete_chunk`, then `settle_job_atomic`, which releases first (`rel_<job>`) and then charges (`chg_<job>`). Nothing delivered means `release_job_atomic` and no charge.
6. The charge is computed by code: `min(hold, max(ceil(real cost × markup), the share of the 100-point minimum that was delivered))`. It is passed to the existing functions as "points delivered at 1 point each".
7. The ids are deterministic: the quote id is `quote_addon_<add-on id>`, and the add-on id is a hash of (mission, base version, attempt). A double click, a retry or a restart reaches the same quote, the same job and the same ledger rows.
8. The work is stored **before** the charge and shown **after** it. A pending version is always published by the retry.
9. **No migration, no new SQL function, and no edit to any existing money file** is needed:
   - `gateway.ts`, `price.ts`, `jobPointsCap.ts`, `finalize.ts`, `lifecycle.ts`, `approval.ts`, `src/functions/**` and `supabase/**` stay unchanged;
   - the new money code is new files.
10. `quotes.ts` stays display-only, and the charge is a separate money-side function. A test pins the shown price and the charge equal.

---

## 1. How money works today (with evidence)

"V" means verified by reading the code at `d5336220`. "I" means inferred.

**SQL caveat.** The SQL quoted below is the text of `supabase/migrations/*.sql` in the repository. The live database was **not** read (no SQL allowed). Where the docs say the live function differs from the repository file, that is stated.

### 1.1 A normal mission: approve, reserve, run, settle

| Moment | Function (file:line) | What it does |
|---|---|---|
| Double click guard | `approveMissionOnce`, `src/lib/agentMission/approval.ts:26-45` | (V) A **compare-and-set** on the mission row `plan_ready → approved` (`:30`). A claim that changed no row is «هذه الخطة اعتُمدت بالفعل» (`:33`). The money functions are called only after the claim (`:37`). On failure the row goes back to `plan_ready` (`:39`). |
| Price again by code | `repriceStoredPlan` and `approveMission`, `src/lib/agentMission/lifecycle.ts:34-44` | (V) The stored plan is priced again by `priceMissionByCode`. Any difference in unit, reserve or rows is `plan_changed`. Over the cap, or more than 5,000 rows, is `quote_failed`. |
| Quote | `create_quote_atomic`, called at `lifecycle.ts:58`; SQL `supabase/migrations/20261017180000_create_quote_atomic.sql` | (V) The quote id is **random** (`quote_<24 hex>`, `lifecycle.ts:47`). The function is idempotent on the same id (`:45-56`) and raises on a conflicting re-use (`:51`). **The repository file caps the total at 600 (`:19`) and is marked "Proposal only".** `src/lib/jobPointsCap.ts:3-6` and `docs/HANDOFF.md` say the live function holds 25,000. That is NOT verified here. |
| Reserve | `accept_quote_atomic`, called at `lifecycle.ts:64`; SQL `20261012172705_accept_quote_atomic.sql` | (V) Job id `job_quote_<md5(quote id)>` (`:59`). Idempotent on an accepted quote (`:61-87`). A single item with a positive `unitPricePoints` (`:112-124`). `targetVolumeMax ≤ 5000` (`:128`). At most two active jobs per user (`:143-148`). It calls `reserve_credits_atomic` (`:151`). |
| Reserve row | `reserve_credits_atomic`, `20261012122154_atomic_reserve_function.sql:23-80` | (V) Id `res_<job id>` (`:35`). It locks the profile (`:44`). Idempotent if the row exists (`:55`). It checks the balance against the ledger sum (`:64`). It inserts `delta = -amount`, type `reserve`, `ON CONFLICT DO NOTHING` (`:73-75`). |
| Keep the old driver off | `claim_job_chunk`, `lifecycle.ts:70` | (V) A 6-hour lease on the job (`AGENT_JOB_LEASE_SECONDS`, `constants.ts:160`). A failed claim releases the whole hold (`:72`). |
| Spend limits during the run | `agent/src/gateway.ts:28-29, :228, :244-249`; `createJobCallBudget`, `src/lib/server/callBudget.ts:42`; `runMission.ts:538` | (V) Every provider call is refused before it is made if it would pass the phase budget (execution: 40% of the hold's value, `HOLD_SPEND_SHARE` `callBudget.ts:17`, `executionBudgetUsd` `price.ts:177`). It is also refused by the provider's daily cap, reserved before the call through `reserve_provider_spend_atomic` (default 0.80 USD: `20261016205259_fix_provider_spend_scope.sql:6, :25`; `DEFAULT_PROVIDER_DAILY_LIMIT_USD` `src/lib/server/providerLimits.ts:15`). A refused call costs nothing. |
| Settle | `settleMission`, `lifecycle.ts:96-114`; called at `agent/src/runMission.ts:719` (normal), `:708` (files failed), `:834` (recovery) | (V) With rows delivered: `complete_chunk` (delivered units, cost; it clears the lease) then `settle_job_atomic`. With none: `complete_chunk(0)` then `release_job_atomic`. |
| Release first, then charge | `settle_job_atomic`, `20261017175500_settle_completed_jobs_with_stale_lease.sql` | (V) Idempotent on a completed job (`:27-35`). `res_<job>` must exist (`:66`). It inserts **`rel_<job>` = +reserve first** (`:70-94`), then `charge = LEAST(CEIL(delivered × unit), reserve, cap)` (`:97-98`), then `chg_<job>` = −charge if more than 0 and not already there (`:100-124`). All in one transaction. |
| Release only | `release_job_atomic` (3 arguments), `20261012170038_release_job_atomic_strict_fix.sql:6-122` | (V) It refuses a completed job (`:34-35`). It checks `res_` against the job (`:47-60`). Idempotent when `rel_` exists and the job failed (`:62-85`). It inserts `rel_<job>` = +reserve (`:96-103`) and marks the job failed. |
| Dead worker | `src/app/api/cron/watchdog/route.ts:50, :69-72` | (V) Any job still `queued` or `running` whose lease ended more than 30 minutes ago is released whole (`p_force: true`), and the customer is told. |
| Top-up | `approve_topup_atomic`, `20261017180500_approve_topup_atomic_privileges.sql:63` (`top_<topup id>`); route `src/app/api/admin/topups/approve/route.ts:79` | (V) The route also has a direct-write fallback (`applyTopup`, `:89`), named as a risk in `docs/MONEY_WRITES_PLAN.md`. Not touched by this design. |
| Append-only ledger | `20261012122120_ledger_triggers_and_checks.sql:18-38` | (V) The types are reserve, release, charge, topup, grant and goodwill. The sign is forced by type (`:20-23`). UPDATE, DELETE and TRUNCATE are blocked by trigger (`:26-53`). |

**The price arithmetic (V).**

| Item | Where | Rule |
|---|---|---|
| Mission price | `priceMissionByCode`, `src/lib/agentMission/price.ts:124-147` | provider cost plus the model estimate, per delivered row |
| Unit and hold | `priceByRule`, `src/lib/missionPricing.ts:118-135` | unit = cost per row × markup × 55 ÷ 0.10; hold = `max(minimum, ceil(volume × unit × 1.15))` (`:132`) |
| Settings | `missionPricing.ts:27` | markup 10, minimum 200 |
| Buffer | `src/lib/recordPricing.ts:26` | 15%, on the hold only |
| Points per USD | `pointsPerCostUsd`, `missionPricing.ts:69` | 5,500 with markup 10 |
| Charge | `settlementChargeFor`, `missionPricing.ts:141-144` | `min(ceil(delivered × job unit), hold, cap)` |
| Cap | `JOB_MAX_POINTS_CAP` = 25,000 (`jobPointsCap.ts:13`), `AGENT_JOB_POINTS_CAP` (`constants.ts:194`) | per job |
| Row limit | `AGENT_MAX_DELIVERED_ROWS` = 5,000 (`constants.ts:238`) | per job |

The minimum is spread into the job's unit price (`missionPricing.ts:127-128`), so a partial delivery pays a **proportional** share of it (I, from the arithmetic).

**Who decides money (V).** Only code: the plan's price is recomputed at approval (`lifecycle.ts:41-43`). The model never states a number (`price.ts:10`).

### 1.2 The methodology add-on (the closest existing pattern)

| Step | Where | What |
|---|---|---|
| Price the page showed | `src/app/api/jobs/[id]/methodology/route.ts:92-95` | (V) The request must name `expectedPoints` equal to the price (50, `METHODOLOGY_POINTS` `src/lib/methodologyOffer.ts:4`). Otherwise 409, before anything is read or charged. |
| Work first | same route, about `:180-225` | (V) The PDF is built and **saved before** the charge. Any failure answers «لم يتم خصم أي نقاط». |
| Single charge, no hold | `purchase_methodology_atomic`, `supabase/migrations/20261016002600_purchase_methodology_atomic.sql:4-71`; called at `route.ts:241` | (V) Id `chg_meth_<job id>` (`:16`). Idempotent if the row exists (`:36`). Balance check (`:46`). Insert `ON CONFLICT DO NOTHING` (`:55-57`). The route also reads the row first (`route.ts:227-236`). |
| Already bought? | `isMethodologyPurchased`, `src/lib/server/methodologyPurchase.ts:32-45` | (V) Reads `chg_meth_<job>`. A re-download is free. |

**Why it is not reused as-is (I).** Its SQL hard-codes the prefix `chg_meth_` (`:16`), so a review charged through it would be written as a methodology purchase. It also has no hold and no release, which an edit needs: an edit spends provider money before its real cost is known. A generic "single charge" would need a new SQL function, which is not needed here (section 6).

---

## 2. The key problem: no provider money before approval

`docs/STAGE-4.md` S4 step 2 says: "The real cost of that re-read gives `editQuote(realCostUsd)`, shown before the customer approves". **To know the real cost before approval, the re-read would have to run before approval, which spends provider money first.** That breaks the sacred rule. **Phase 2 must rewrite that step** (this PR changes no other file).

**The fix.**

1. **The quote is made by code, with no provider call.** The edit request becomes a one-stage plan:
   - rows = the delivered rows the change needs;
   - cost per row = the full lookup chain of the column's verified tools.

   The per-row cost of each tool is read, in this order:
   - (a) **the delivered mission's own recorded calls** for the same endpoint: `measuredCostPerRowUsd` (`price.ts:28`) over its `mission_calls` rows (cost and rows returned), money already spent and recorded;
   - (b) otherwise the **catalog price** (`estimateCallUsd`, `agent/src/gateway.ts:94`, divided by the page's rows);
   - (c) otherwise **no quote**: «تعذّر تسعير هذا التعديل الآن؛ لم يُحجز ولم يُخصم شيء.» The gateway's flat guess for unknown prices (`GATEWAY_UNKNOWN_PRICE_ESTIMATE_USD`) is never used for money.

   Using the full chain is an **upper bound**: every tool is assumed to be tried for every row.
2. **The price uses the function normal missions use.** `priceMissionByCode([{ rows, costPerRowUsd, deliver: true, codeOnly: true }], { settings: { markup, minChargePoints: 100 } })`. It gives the hold `R = max(100, ceil(estimate × markup × 1.15))`, the buffer on the hold only. The card shows the estimate and the most it can cost.
   - **Side effect (I):** the function adds its fixed model estimate (planning plus one execution, `price.ts:114-122`). The edit runs no model, so that part only makes the hold larger. It is never charged, because the charge is the real cost.
3. **Approval holds R** through the existing functions (section 3). Nothing has been spent yet.
4. **The re-read starts only after approval**, in the worker, with a provider budget of **R ÷ `pointsPerCostUsd(settings)` USD** (R ÷ 5,500 with markup 10). That is a new value handed to the existing `createJobCallBudget`. The gateway already refuses any call that would pass it (`gateway.ts:228`), so `ceil(real cost × 5,500) ≤ R` holds by construction.
   - It is not `executionBudgetUsd(R)`, which is 40% of the hold's value (R ÷ 1,375 USD). That would allow a real cost whose markup is four times the hold.
   - A provider that charges more than its estimate can still push the real cost a little over. The settlement clips the charge at R (`settle_job_atomic` `:98`), so the platform absorbs the excess.
5. **The charge is computed by code after the run**, by a new money-side function `addonChargePoints`:

   ```
   filled   = cells that received a VALUE (a stated gap «غير متوفر» / «لم يكتمل البحث» is not a value)
   if filled = 0                         -> 0  (release the whole hold, nothing charged)
   raw      = ceil(real provider cost USD × pointsPerCostUsd(settings))       (integer micro-arithmetic, as editQuote)
   minPart  = ceil(100 × filled / requested)                                   (the minimum, in proportion: decision D2)
   charge   = min(R, max(raw, minPart))
   ```

   **The real cost** is the sum of the add-on's own execution calls in `mission_calls`, the cost the recorder committed. A failed call commits 0.

**Real cost below the hold.** `settle_job_atomic` writes `rel_<job>` = +R **first**, then `chg_<job>` = −charge, in one transaction. The customer keeps R − charge.

**The provider fails, or the daily cap stops the re-read.**

- The gateway refuses the next call (`daily_cap`), or calls fail (cost 0). The engine stops.
- Every requested cell that got no value says «لم يكتمل البحث» (the Stage 3 fallthrough rule): never an empty cell, never a guess.
- **Partial** (`filled > 0`): charge by the formula, on what was filled. Customer text: «توقّف التعديل قبل أن يكتمل، فأضفنا ما وجدناه فقط. خُصم مقابل ما اكتمل، وعاد باقي الحجز إلى رصيدك.»
- If the daily cap was the reason: «بلغت عمليات البحث حدّها لهذا اليوم، فتوقّف التعديل قبل أن يكتمل.»
- **Nothing filled**: no new version, `release_job_atomic`, charge 0. Customer text: «لم نجد قيمًا جديدة لهذا التعديل، فلم نُنشئ نسخة جديدة. عاد الحجز كاملًا إلى رصيدك ولم يُخصم شيء.»
- Every sentence goes through `checkCustomerText` in a Phase 2 test. Arabic-Indic numerals, no tool, provider or USD.

**Fix and review, the same rule.**

- **Review fix.** The chosen review issue becomes a `set_cells` edit of **exactly** that issue's cells, priced and charged as an edit (owner decision 3).
  - **Note:** `ReviewIssue.rowIds` keeps only the first 20 ids (`review.ts`, `rowIds.slice(0, 20)`).
  - The fix must recompute the full list by code: `reviewFile` on the same version is deterministic. It must never use the truncated list.
  - Duplicates are never "fixed": rows are never removed.
- **Review.** It makes **no provider call** (pure code, `reviewFile`), so its price is exact: `P = reviewQuote(reviewCellsOf(version))`. The hold is P, with no buffer (decision D5), and the charge is P when the report is stored. A review that fails releases P.

---

## 3. Ledger flows

### 3.0 Shared shape

| Item | Design |
|---|---|
| **Add-on row** | A row in `missions` (existing table and statuses, `docs/proposals/agent-worker/01_agent_tables.sql:18`). Its `plan` JSON carries `addon: { kind: "review" \| "review_fix" \| "edit", of: <delivered mission id>, baseVersion: N, newVersion: N+1, attempt: k, request }` plus a one-stage `PricedPlan`. `request_text` holds the customer's words. It is created as `plan_ready`: priced by code, never planned by the worker. |
| **Add-on id** | `msn_` + the first 20 hex characters of `sha256("<mission id>\|v<N>\|a<k>")`, where `k` = 1 + the number of **ended** add-on rows (cancelled, failed, unserved) for that mission and base version. Two creations of the same request compute the same id, and the primary key refuses the second. An open add-on blocks a second one on the same base version (decision D10). |
| **Quote id** | `quote_addon_<add-on id>`: deterministic. `create_quote_atomic` returns `already_created` on the same id and contents (`:45-56`). |
| **Job id** | `job_quote_<md5("quote_addon_<add-on id>")>`: deterministic, made by the existing SQL (`accept_quote_atomic.sql:59`). |
| **Ledger ids** | `res_<job id>`, `rel_<job id>`, `chg_<job id>`: the existing functions, unchanged. Each id names the add-on's own job, and through the quote id the add-on, which names the mission, the base version and the attempt. A readable id (`res_edit_<job>_v0002`) would need a new SQL function (decision D7). |
| **Quote item** | One item, as `accept_quote_atomic` requires (`:112`): `{ capabilitySlug: "agent-review" \| "agent-fix" \| "agent-edit", endpointId: same, missionId: <delivered mission>, addonId, unitPricePoints: 1, targetVolumeMin: 1, targetVolumeMax: R }`. The job's `endpoint_id` then names the kind. **Units are points:** the job sells up to R points at 1 point each, so `settle_job_atomic` charges exactly `LEAST(delivered, R, cap)`. |
| **Limit** | `targetVolumeMax ≤ 5000` (`accept_quote_atomic.sql:128`), so **an add-on can hold at most 5,000 points**. A larger estimate is refused before any hold: «هذا التعديل أكبر من الحد المسموح لطلب واحد؛ قسّمه إلى أجزاء أصغر. لم يُحجز شيء.» At markup 10 that is about 0.79 USD of real cost with the buffer: about the provider's daily cap, so in practice no reachable edit is refused (I). |
| **Approval** | A new function, `approveAddonOnce`, in a **new** file. It copies the CAS claim of `approval.ts:30-33` on the add-on row and checks that the stored price equals a fresh reprice by code. Then it calls `create_quote_atomic`, `accept_quote_atomic` and `claim_job_chunk` with the same arguments shape as `lifecycle.ts:58-74`. On failure the row goes back to `plan_ready`. |
| **Settlement** | The **existing** `settleMission(client, { jobId, deliveredUnits: chargePoints, unitPricePoints: 1, reservedPoints: R, costUsd: real, resultPath })` (`lifecycle.ts:96`). With 0 points it releases; otherwise `complete_chunk` then `settle_job_atomic` (release first). |

**Order of work and money (all three kinds).**

```
1. run (worker)                  -> results in the add-on's own item log (existing ItemStore, resumable)
2. store the work, PENDING       -> create-only addons/<add-on id>/v<N+1>.json (or review.json) in the DELIVERED mission's folder
3. check nothing else published  -> versions/v<N+1>.json must not exist (else: release, no charge, flag for the admin)
4. settle                        -> settleMission (release first, then charge)
5. publish                       -> create-only versions/v<N+1>.json (or reviews/r<NNNN>.json), same bytes as the pending object
6. the add-on row                -> completed, charged_points, summary; the customer is told
```

The work exists before the charge (step 2 before step 4). It becomes visible only after the charge (step 5). A restart after step 4 finds the job `completed`: `settle_job_atomic` returns `already_settled` (`:27-35`) and charges nothing. The runner then repeats step 5 from the pending object.

The balance after each step is written below as B for the starting balance.

### 3.1 (a) Paid review of version N

| Step | Ledger | Balance |
|---|---|---|
| Card | none. P = `reviewQuote(reviewCellsOf(vN))`, shown with the existing `quoteLineAr` | B |
| Approve | `res_<job>` = −P (`reserve_credits_atomic` refuses if B < P: `insufficient_balance`, nothing written) | B − P |
| Run | `reviewFile(vN)`: no provider call, no row changed. The report is stored pending | B − P |
| Settle (report stored) | `rel_<job>` = +P, then `chg_<job>` = −P | B − P |
| Settle (report could not be made) | `rel_<job>` = +P | B |

Idempotency: CAS on the add-on row, the deterministic quote and job ids, and the SQL idempotency of each function.

**One review per version (decision D11).** A second review request on a version that already has `reviews/` for it shows the stored report free; no add-on is created.

### 3.2 (b) Review fix (from a review of version N)

| Step | Ledger | Balance |
|---|---|---|
| Card | none. The `set_cells` edit over the issue's full cell list (recomputed by code), priced as in section 2: hold R ≥ 100 | B |
| Approve | `res_<job>` = −R | B − R |
| Run | re-read of those cells only, budget R ÷ 5,500 USD | B − R |
| Settle, something filled | `rel_<job>` = +R, then `chg_<job>` = −C with 100 × filled ÷ requested ≤ C ≤ R | B − C |
| Settle, nothing filled | `rel_<job>` = +R | B |

The new version has `reason: "review_fix"`, `parent: N`. Decision 3 (owner): priced like an edit, no free path.

### 3.3 (c) Edit of version N

Same rows and balances as 3.2.

- The request is one `EditRequest` (`add_column`, `rename_column`, `set_cells` or `add_rows`); removing rows is refused before any price (`row_removal_not_offered`).
- **Edits that need no re-read cost nothing in provider calls.** A rename, or a cell the customer typed, has real cost 0, so raw = 0 and the charge is the proportional minimum. With everything applied, that is **100 points** («our own mistake is not free»; decision D12).
- The new version has `reason: "edit"`, `parent: N`.

---

## 4. Failure matrix

| What happens | Ledger state afterwards | Why it is safe |
|---|---|---|
| Customer cancels before approval | nothing | The add-on is `plan_ready`. `cancelForCustomer` (`customerActions.ts:119-129`) only changes a status; no money function was called. |
| Insufficient balance at approval | nothing | `reserve_credits_atomic` returns `insufficient_balance` before writing (`:64-70`). `accept_quote_atomic` returns it (`:154-156`). The add-on goes back to `plan_ready` with «رصيدك لا يكفي لهذا الطلب. اشحن رصيدك ثم اعتمده؛ لم يُخصم شيء.» |
| Double click on «اعتمد» | one `res_` | The CAS lets only one request through (pattern of `approval.ts:30-33`). Even without it, the same quote id gives the same job, and `accept_quote_atomic` answers `already_accepted` (`:61-87`). |
| Double click on «اطلب التعديل» (creation) | nothing | The deterministic add-on id makes the second insert fail on the primary key. The second click is shown the first add-on's card. |
| Retry of the approval request (lost answer) | one `res_` | As above. The client reads the add-on row to learn the outcome (the pattern of `src/lib/missionApprove.ts`). |
| Worker dies after the hold, before any call | `res_` only, until resumed or released | The add-on row is `approved` or `executing` with a lease. `agent_claim_mission` takes it again when the lease ends (`docs/proposals/agent-worker/02_agent_claim_function.sql:24-25`), and nothing was spent. If no worker comes back, the job lease ends and the watchdog releases R whole (`watchdog/route.ts:50, :69-72`): `res_` −R, `rel_` +R, net 0. |
| Worker dies after provider calls, before the charge | `res_` only | On resume, the add-on's item log and its recorded calls are read back: `createJobCallBudget({ spentUsd: sum of its execution calls })`, as `runMission.ts:538` does. The total spend across restarts stays ≤ R ÷ 5,500 USD, and the charge is computed once at settlement. If the watchdog released first, the job is `failed`: `settle_job_atomic` refuses it (`:38-40`), the pending version is **never published**, the customer is told the hold came back, and the platform absorbs the provider cost. |
| Worker dies after the charge, before the version is visible | `res_`, `rel_`, `chg_` (one each) | The version was stored pending **before** the charge (step 2). On resume, `settle_job_atomic` answers `already_settled` (no second row), and the runner publishes the pending object (step 5). The customer was charged once, and the version appears on the retry. |
| Retry of the settlement | unchanged | `settle_job_atomic` is idempotent on a completed job (`:27-35`). `rel_` and `chg_` are only inserted if absent (`:71-75, :101-105`). |
| Another version was published for the same base (zombie worker) | `res_`, `rel_` (no charge) | Step 3 finds `versions/v<N+1>.json` already there, so the add-on is released and the admin is flagged. The window between step 3 and step 5 is a residual risk; the worst case is a free version, never a double charge. |
| Rejected edit (row removal, unknown column, bad title, …) | nothing | `applyEditRequest` refuses at **card time** (`EDIT_REJECTIONS`), so no add-on row is created and no money function is called. |
| Zero cells filled | `res_`, `rel_` | `settleMission` with 0 points runs `complete_chunk(0)` then `release_job_atomic` (`lifecycle.ts:98-104`). No new version. |
| Daily cap stops the re-read | `res_`, `rel_`, `chg_` (partial) or `res_`, `rel_` | The gateway refuses before the call (`gateway.ts:244-249`), so the refused call costs nothing. The charge follows section 2 on the filled cells only. |
| Charge would pass the hold | `chg_` = R at most | The provider budget is R ÷ 5,500 USD, `addonChargePoints` clips at R, and `settle_job_atomic` clips again with `LEAST(…, reserved, cap)` (`:98`). |
| The review cannot be made (unreadable version) | `res_`, `rel_` | Nothing stored, release whole. |
| Settlement call fails (database error) | `res_` (and maybe `rel_` + `chg_` if the call committed but the answer was lost) | The runner retries settlement, which is idempotent. The watchdog cannot release a `completed` job, because `release_job_atomic` refuses completed (`:34-35`). |

---

## 5. Invariants and their proofs

| Invariant | Test (Phase 2) |
|---|---|
| **Balanced ledger.** For every add-on job: `res_` = −R, `rel_` = +R (exactly one each), at most one `chg_` = −C with 0 < C ≤ R, and the net is −C (or 0 when nothing was charged). | Every scenario of section 7 ends with this check on the money fake's ledger. Section 8 uses the same SELECT live. |
| **Never above the hold.** C ≤ R for any real cost. | A property test of `addonChargePoints` over random costs, fills and holds (integer arithmetic). The replay checks the ledger. A test runs a provider whose real charge is twice its estimate: C = R. |
| **Nothing spent before approval.** | The card routes make **zero** provider calls: `fetch` stubbed to throw (as `tests/helpers/agentReplay.ts` does) and the recorder's `reserve` never called before `accept_quote_atomic`. The add-on row is `plan_ready` with no `mission_calls` rows. |
| **Idempotent.** | Double creation, double approval, approval retried, settlement retried, worker killed at each step: each scenario ends with one `res_`, one `rel_` and at most one `chg_`. |
| **A review never changes a row.** | The version's digest and JSON are identical before and after. The review writes only `addons/<id>/review.json` and `reviews/r<NNNN>.json`, and no `versions/` object (a storage listing check). This repeats `tests/stage4-review.test.ts` on the path that charges. |
| **The quote functions stay display-only.** | Kept. The existing import-graph test (`tests/stage4-quotes.test.ts:82-95`) stays and must stay green. The charge is a **separate money-side function**, `addonChargePoints`, in a new file whose name matches the test's money pattern (`addonSettlement.ts` matches `settle`), so the test automatically forbids it from importing `quotes.ts`. A second test pins the display and the charge equal, on a grid of costs below the hold: `editQuote(c) === addonChargePoints({ realCostUsd: c, filled: n, requested: n, holdPoints: ∞ })`. **Why:** a wording or rounding change of a screen can then never change a charge, and a charge change cannot slip by unnoticed, because the equality test fails. |
| **`lifecycle.ts` is a money file the guard does not name.** | Phase 2 adds `lifecycle` to the `MONEY` pattern of `tests/stage4-quotes.test.ts:82`. That is a test change, not a money change. |

---

## 6. File plan for Phase 2

### 6.1 Existing money files: **none changes**

Read and reused, not edited:

- `src/lib/agentMission/lifecycle.ts` (`settleMission`);
- `src/lib/agentMission/price.ts` (`priceMissionByCode`, `measuredCostPerRowUsd`);
- `src/lib/missionPricing.ts` (`pointsPerCostUsd`);
- `src/lib/server/callBudget.ts` (`createJobCallBudget`);
- `agent/src/gateway.ts` (the budget and the daily cap, unchanged);
- every SQL function.

Not touched:

- `jobPointsCap.ts`;
- `finalize.ts` (settlement lines included);
- `agent/src/runMission.ts`;
- `src/lib/agentMission/approval.ts`;
- `src/functions/**`;
- `supabase/**`.

### 6.2 New files

| File | What | Money? |
|---|---|---|
| `src/lib/agentMission/addonSettlement.ts` | `addonChargePoints`, `approveAddonOnce` (the CAS plus the three existing RPCs), `settleAddon` (calls `settleMission`), the deterministic ids | **yes, new** |
| `src/lib/agentMission/stage4/addonQuote.ts` | the card: request to one-stage plan to `priceMissionByCode` (no provider call); the review price through `reviewQuote` | display |
| `src/lib/agentMission/stage4/addonRow.ts` | create or read the add-on row (deterministic id, attempt count, one open per base) | no |
| `agent/src/stage4/runAddon.ts` | the worker's run of an add-on: the re-read on the engine (budget R ÷ 5,500), the review, store pending, check, settle, publish, recovery | calls money |
| `src/app/api/missions/[id]/addons/route.ts` | GET the card, POST create, POST approve, POST cancel; behind `DIGER_STAGE4_REVIEW` / `DIGER_STAGE4_EDITS` | calls money |
| `src/components/mission/ReviewReport.tsx`, `EditRequestCard.tsx` | the screens (STAGE-4 S3, S4) | no |
| tests (section 7) | | |

### 6.3 Existing non-money files that must change

| File | Why |
|---|---|
| `agent/src/main.ts` (`:90`) | Dispatch: an add-on row goes to `runAddonSafely`, every other mission to `runMissionSafely` as today. It is one line; **`runMission.ts` is not touched**. |
| `agent/src/supabaseStore.ts` / `memoryStore.ts` | A create-only write that **reports** an existing object (today `putNew` treats "exists" as done, `supabaseStore.ts:30-39`), needed by step 3 and step 5. It is a new method; `putNew` is unchanged. |
| `src/lib/requests/buildIndex.ts` | «طلباتي» lists jobs (`:103`). An add-on job's `delivered_units` holds **points** (section 3.0), so it must be shown as a line under its mission, never as a separate request with «وصل X من Y». |
| `src/lib/agentMission/openMissions.ts` | An add-on in `plan_ready` must not count as one of the customer's open missions (the open-missions limit). |
| `src/lib/agentMission/stage4/quotes.ts` | A line for a hold: «يُقدَّر التعديل بنحو X نقطة، ولن يتجاوز R نقطة؛ يُخصم ما كلّفه فعلًا فقط.» `quoteLineAr` stays as is for the review. |
| `docs/STAGE-4.md` S4 step 2 | Rewrite it as section 2 here: the quote by code before approval, the real cost after. |
| `tests/helpers/agentMoney.ts` | The money fake is **too lenient** for these tests: its `create_quote_atomic` overwrites (`:17-21`), `accept_quote_atomic` checks no quote status and would push a second `res_` with the same id, and ids are not unique. Phase 2 makes it match the SQL: unique ledger ids, `already_created`, `already_accepted`, and the md5 job id. |
| `tests/stage4-quotes.test.ts:82` | Add `lifecycle` to the money pattern. |

### 6.4 On the forbidden list, and needed or not

| Forbidden file | Needed by this design? |
|---|---|
| `agent/src/gateway.ts` | **No** (its budget is passed in) |
| `src/lib/agentMission/price.ts`, `src/lib/missionPricing.ts`, `recordPricing.ts` | **No** (read only) |
| `jobPointsCap.ts` | **No** |
| `finalize.ts` (settlement lines) | **No** |
| `src/functions/**`, `supabase/**` (no migration, no SQL function) | **No** |
| money, ledger, billing logic: `lifecycle.ts`, `approval.ts`, `runMission.ts` | **No** (reused or untouched) |
| **`src/app/api/wallet/history/route.ts`** (ledger, display only) | **Yes, by choice.** Today a `chg_` line is labelled by the mission that owns the job (`:30-36, :56`). An add-on job's mission is the add-on row, so without a change the line says nothing of «تعديل» or «مراجعة». **Needs the owner's OK** in the Phase 2 brief. The alternative leaves it untouched; the line then reads as a delivery of the add-on row. |
| New money file `addonSettlement.ts` | New, not existing; named here so the brief can name it. |

**If the owner prefers readable ledger ids, or a single charge with no hold for the review**, that needs a new SQL function: a migration in `supabase/**`, which is forbidden. Not recommended (decisions D5, D7).

---

## 7. Test plan (Phase 2)

All tests use the money fake (hardened, section 6.3), `fetch` stubbed to throw, and the fake recorder (`tests/helpers/agentHarness.ts:32-43`, with a daily cap option). There are no real calls.

| Test | Fixture | Proves |
|---|---|---|
| `tests/money7a-edit-m12-replay.test.ts` | M12 (`msn_5851abc92a1e6645a9cd`) rebuilt by `tiktokWorld()` in `tests/helpers/round11Worlds.ts` from `tests/fixtures/live/missions/msn_5851abc92a1e6645a9cd/`; its version 1 from S1 (`agent/src/stage4/firstVersion.ts`); fake answers for the added column; per-row cost from `tests/fixtures/live/call-index.json` | The FOUNDATION acceptance case: «ضيف عمود …» gives a card with no provider call, then approval (`res_` −R), the re-read, settlement (`rel_` +R, `chg_` −C, C = `min(R, max(ceil(real × 5,500), proportional 100))`), and v2 published. v1 is unchanged, and the balance moved by −C exactly. |
| `tests/money7a-double-click.test.ts` | M12 | Two creations in parallel give one add-on row. Two approvals in parallel give one `res_` and one 409. An approval retried after a lost answer changes nothing. |
| `tests/money7a-worker-dies.test.ts` | M12 | A throw injected (1) after the hold, (2) after the first provider call, (3) after settlement before publish. A second run resumes. Each case ends with one `res_`, one `rel_`, at most one `chg_`, and the version published once. A fourth case has the watchdog release first: no charge and no published version. |
| `tests/money7a-daily-cap.test.ts` | M12 | `fakeRecorder({ dailyCapUsd })` stops the re-read half way: a partial charge on the filled cells, «لم يكتمل البحث» in the rest, the Arabic text checked. A cap of 0 gives nothing filled: `rel_` only and no version. |
| `tests/money7a-review.test.ts` | M14 (`msn_b060d3347ed7660f972e`, `xWorld`) and M12 | P = `reviewQuote(reviewCellsOf(v))`, `res_` −P, `rel_` +P, `chg_` −P. The version's digest is unchanged, and no `versions/` object is written. A second review of the same version is free and creates no row. |
| `tests/money7a-review-fix.test.ts` | the small fake sheet of `tests/stage4-review.test.ts` (score 40) | The fix covers **all** cells of the issue, not the first 20, and is charged like an edit. Duplicates offer no fix. |
| `tests/money7a-charge.test.ts` | none (pure) | A property test of `addonChargePoints` (never above R; 0 when nothing filled; integer exact). Display equals charge (`editQuote`). A provider that charges twice its estimate still gives C ≤ R. |
| `tests/money7a-refusals.test.ts` | M12 | Row removal, an unknown column and a bad title create no row and call no money function. An over-limit hold (more than 5,000 points) is refused before any hold. Insufficient balance writes nothing. Cancel before approval writes nothing. |
| `tests/money7a-flags-off.test.ts` | the replay worlds of `tests/stage4-first-version.test.ts` | With `DIGER_STAGE4_REVIEW` and `DIGER_STAGE4_EDITS` unset: the add-on routes answer 404; no add-on row and no ledger row; the delivered mission, its events and its single settlement are identical to today (the comparison of `tests/stage4-first-version.test.ts`). `tests/stage4-quotes.test.ts` stays green. |

---

## 8. Flags and rollout

- `DIGER_STAGE4_REVIEW` and `DIGER_STAGE4_EDITS` **stay unset** (off) until the Phase 2 PR is merged and the live check below passes. `DIGER_STAGE4_VERSIONS` (S1, S2) is separate.
- Order: `test` (test accounts only), then `on`. Rollback: unset the flag. Ledger rows are never deleted.

**The live check** (described only; nothing is run now):

1. After Heroku Build succeeded and Deployed, set `DIGER_STAGE4_EDITS=test` and `DIGER_STAGE4_VERSIONS=test` (the owner does this).
2. On a delivered test-account mission, ask one small edit («ضيف عمود …» on a few rows). Read the card: the estimate, and the most it can cost. Approve.
3. Read-only SELECT on `credit_ledger` where `job_id` = the add-on's job. Expect exactly `res_` = −R, `rel_` = +R and `chg_` = −C with 0 < C ≤ R; the sum is −C. The `jobs` row is `completed`, `charged_credits` = C, `reserved_credits` = R.
4. The versions list shows «النسخة ٢ (تعديل)». Version 1 is unchanged (same digest).
5. Optional: the same for one review (`DIGER_STAGE4_REVIEW=test`), where C = P.

---

## 9. Out of scope: PR 7b, jobs above 25,000 points in stages

**Not designed here.** Where it would touch:

- `approveMission` refuses `overCap` (`lifecycle.ts:44`);
- `priceByRule` sets `overCap` (`missionPricing.ts:134`);
- `create_quote_atomic`'s cap (`:19` in the repository, 25,000 live per the docs);
- `accept_quote_atomic`'s `targetVolumeMax ≤ 5000` (`:128`) and `AGENT_MAX_DELIVERED_ROWS` (`constants.ts:238`);
- the card's «smaller version» (`smallerVersionForCustomer`);
- here, the 5,000-point add-on limit of section 3.0, which 7b's staging could lift.

---

## 10. Open decisions for the owner

| # | Question | Recommended answer |
|---|---|---|
| D1 | Is an edit charged by its **real cost × markup** (as briefed), or like a mission, **per filled cell at the quoted price**? | **Real cost × markup**, as decided; this design. The per-cell way would reuse `approveMissionOnce` unchanged and keep `delivered_units` meaning cells, but the price would no longer follow the real cost. |
| D2 | When an edit is partial, is the 100-point minimum charged whole, or in proportion to what was filled? | **In proportion** (`ceil(100 × filled ÷ requested)`), as a mission's minimum already is (`missionPricing.ts:127-128`). Never above the hold. |
| D3 | If the tools ran but filled nothing, is anything charged? | **No**: release the whole hold. The platform absorbs the cost, as for a mission that delivers nothing. |
| D4 | Does a cell that says «غير متوفر» (every tool answered with nothing) count as filled? | **No**: only a value counts. |
| D5 | The review's price is exact. Is it held with the 15% buffer, or exactly? | **Exactly P.** The buffer exists for estimates; a review spends nothing on providers. |
| D6 | One add-on may hold at most 5,000 points (the database's volume limit). Accept, or change the SQL? | **Accept.** It is about the provider's daily cap anyway; 7b can lift it. |
| D7 | Are ledger ids of the form `res_job_quote_<md5>` acceptable (deterministic, with the mapping in the quote and the add-on row), or must they read `res_edit_<job>_v0002`? | **Accept the existing form.** A readable form needs a new SQL function (a migration). |
| D8 | Does an add-on count toward the limit of two active jobs (`accept_quote_atomic.sql:143-148`)? | **Yes** (no SQL change). It is short. |
| D9 | Where does an add-on appear: «طلباتي», the wallet? | **As a line under its request**, in both places; never as a request of its own. The wallet needs the owner's OK (section 6.4). |
| D10 | One open add-on per file at a time? | **Yes**: it keeps versions in a line (v2 from v1, v3 from v2) with no merge. |
| D11 | A second review of the same version: free (show the stored report) or charged again? | **Free**: nothing new is done. |
| D12 | A rename, or cells the customer typed (no provider call): 100 points? | **Yes**, the minimum (owner rule «no free path»). Or decide a lower minimum for edits with no re-read. |

---

## 11. Verified facts vs assumptions

**Verified by reading the code at `d5336220`:**

- every function name, id format and line in section 1;
- that `settle_job_atomic` releases before it charges, in one transaction, and clips at the reserve and the cap;
- that every money SQL function in the repository is idempotent on its deterministic id;
- that the watchdog releases stale jobs whole;
- that the mission approval is a compare-and-set before any money call;
- that the methodology charge is `chg_meth_<job>`, single, after the file is saved;
- that `accept_quote_atomic` limits a job to 5,000 units and two active jobs per user;
- that the gateway refuses a call that would pass its budget or the daily cap, before the call;
- that `quotes.ts` is unreachable from money paths by an existing test, and that `lifecycle.ts` is not in that test's pattern;
- that the money fake of the tests does not enforce unique ledger ids or quote status;
- that the seven customer sentences proposed here pass the project's `checkCustomerText` (run locally on a scratch script, no repository change).

**Assumed (not verified):**

- **The live database's functions equal the repository's migrations.** They do not for `create_quote_atomic`: the repository caps at 600, while `jobPointsCap.ts:3-6` and `docs/HANDOFF.md` say the live cap is 25,000. Checking that needs a read-only SELECT of the function body, which was not allowed here. **Phase 2 must check it** (`pg_get_functiondef`) before relying on any SQL line quoted above.
- `agent_claim_mission` is quoted from `docs/proposals/agent-worker/02_agent_claim_function.sql`, not from the live database.
- The add-on's per-row cost from the delivered mission's recorded calls is close to the real cost of the re-read. If it is far below, the platform absorbs the difference above the hold; if far above, more of the hold is released.
- Holding about 0.79 USD at most per add-on is enough for real edits (not measured).
- The worker can run the engine on a one-stage plan over the delivered rows' ids. That is STAGE-4 S4 engineering, not money, and is not checked here.
- The «طلباتي» and wallet changes are display only, and no other screen reads `jobs.delivered_units` for an agent job. Not searched exhaustively.

**Not done:** no SQL, no code, no test, no flag, no environment variable, no provider or model call, no e-mail.
