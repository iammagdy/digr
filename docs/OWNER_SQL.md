# Owner Manual SQL Guide (Digr Supabase Production)

This document contains manual SQL operations that must be executed strictly by the project owner in the Supabase SQL Editor.

---

## 1. Pre-Cutover Test Ledger Reset

> [!CAUTION]
> **Run ONLY once, before the first real user, never after launch.**
> Executing this after launch will destroy production financial audit records and violate ledger immutability invariants.

### Step 1: Pre-Check Query (Run First)
Execute this query to confirm that all rows in `credit_ledger` belong strictly to the dedicated test user (`00000000-0000-0000-0000-000000000001`):

```sql
-- Verification: Must return 0 rows before proceeding with reset
SELECT id, user_id, delta, type, created_at
FROM public.credit_ledger
WHERE user_id != '00000000-0000-0000-0000-000000000001'::uuid;

-- Summary check: Reconcile the test-only total, including the known 24 compensating rows noted below
SELECT 
  count(*) AS total_rows,
  count(*) FILTER (WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid) AS test_user_rows
FROM public.credit_ledger;
```

If `total_rows` equals `test_user_rows` and the first query returns 0 rows, it is safe to proceed with the pre-cutover reset.

> [!NOTE]
> The known test-only residue is limited to the dedicated test user: **24 compensating ledger rows** and **71 orphan ledger references**. Do not edit or delete these ledger records manually. They are to be removed only by the documented pre-launch reset above, after its pre-check passes. This note is not authorization to run the reset, and it must never be run after launch.

### Step 2: Clean Reset Execution (Child-First Order)
```sql
-- 1. Temporarily disable ledger immutability triggers
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_truncate;

-- 2. Child-first deletion of all test records (test user 00000000-0000-0000-0000-000000000001)
-- Delete dependent grandchild/child rows first to maintain foreign key integrity:
DELETE FROM public.provider_costs WHERE job_id IN (
  SELECT id FROM public.jobs WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid
);
DELETE FROM public.job_events WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
TRUNCATE TABLE public.credit_ledger;
DELETE FROM public.jobs WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.topups WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.plans_quotes WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;
DELETE FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001'::uuid;

-- 3. IMMEDIATELY re-enable ledger immutability triggers
ALTER TABLE public.credit_ledger ENABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger ENABLE TRIGGER trg_block_ledger_truncate;

-- 4. Post-reset verification: Ensure ledger is completely empty
SELECT count(*) AS remaining_ledger_rows FROM public.credit_ledger;
```

---

## 2. Setting Owner Admin Role

To designate the owner account as the system administrator:

```sql
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'::jsonb
WHERE email = 'YOUR_OWNER_EMAIL@example.com';
```

---

## 3. Manual Initial Points Grant (If Needed)

To grant initial credits to a user:

```sql
INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
VALUES (
  'grt_' || gen_random_uuid(),
  'USER_UUID'::uuid,
  300,
  'grant',
  'منحة رصيد افتتاحية'
);
```

---

## 4. Public Pricing Configuration (Optional)

> [!NOTE]
> If this row is omitted from `settings_public`, the atomic function (`approve_topup_atomic`) automatically defaults to `0.1` EGP per credit (`creditValueEgp`).

To explicitly set or customize the credit conversion rate:

```sql
INSERT INTO public.settings_public (key, value)
VALUES ('pricing', '{"creditValueEgp": 0.10}'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Verification query:
```sql
SELECT key, value FROM public.settings_public WHERE key = 'pricing';
```

---

## 5. Remove Temporary Test Fixture RPC (Pre-Launch Step)

Before production cutover, remove the temporary verification fixture function:

```sql
DROP FUNCTION IF EXISTS public.create_verify_fixture(TEXT, JSONB);
```
