# Production Cutover & Pre-Launch Runbook (Supabase)

This document details the mandatory steps, verification leftovers reconciliation, and security actions required prior to opening Digr to live customer traffic on Supabase.

---

## 1. Pre-Cutover Verification Leftovers Reconciled

During local and synthetic verification, test operations run against the isolated test user:
- **Test User UUID:** `00000000-0000-0000-0000-000000000001`
- **Fixture Key Prefixes:** `vrun_<timestamp>_<uuid>_`

### Expected Leftovers
- **Jobs Table:** Temporary test rows with status `running`, `queued`, `completed`, or `failed` created under the `vrun_` prefix.
- **Topups Table:** Test top-up records created under the `vrun_` prefix.
- **Credit Ledger:** Test reservation (`res_`), release (`rel_`), charge (`chg_`), and top-up (`top_`) rows.
- **Provider Costs:** Test synthetic calls or small verification spend rows logged under test jobs.

**Important:** Do NOT manually delete or modify ledger rows during Phase B development. All test ledger entries are protected by database immutability triggers and are strictly reconciled and purged only during the clean child-first pre-launch reset detailed in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md).

---

## 2. Temporary Fixture RPC Removal

The RPC `public.create_verify_fixture(TEXT, JSONB)` exists strictly to facilitate automated live verification without bypassing ledger immutability or granting client write privileges.

Before moving to production traffic (Phase C cutover):
1. Execute the following SQL statement in the Supabase SQL Editor:
```sql
DROP FUNCTION IF EXISTS public.create_verify_fixture(TEXT, JSONB);
```
2. Verify removal:
```sql
SELECT proname FROM pg_proc WHERE proname = 'create_verify_fixture';
-- Must return 0 rows
```

---

## 3. Provider Spend-Cap Verification Notice

The script `scripts/verify/verify-spend-cap.ts` interacts with external provider tracking and records actual spend commits against the daily spend ceiling:
- **Mandatory Flag:** Running the script requires the explicit flag:
  ```bash
  npx tsx scripts/verify/verify-spend-cap.ts --i-know-this-uses-budget
  ```
- **Budget Consumption:** Each run commits $0.60 USD against the configured daily ceiling (`0.80` USD/day).
- **Rule:** Never execute this script on a live production deployment while real customer jobs are in flight.

---

## 4. Final Pre-Launch Child-First Reset

Immediately before pointing live DNS / Vercel production domains to Supabase:
1. Verify no external real users exist in `credit_ledger` (run Step 1 query in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md)).
2. Execute the child-first clean reset script from Step 2 in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md).
3. Confirm that the ledger is 0 rows and immutability triggers are re-enabled.
4. Set the Owner admin account and verify the pricing row in `settings_public`.
