# Owner Manual SQL Guide (Digr Supabase Production)

This document contains manual SQL operations that must be executed strictly by the project owner in the Supabase SQL Editor.

---

## 1. Pre-Cutover Test Ledger Reset

> [!CAUTION]
> **Run ONLY once, before the first real user, never after launch.**
> Executing this after launch will destroy production financial audit records and violate ledger immutability invariants.

### Step 1: Pre-Check Query (Run First)
Execute this query to confirm that **100% of rows** in `credit_ledger` belong strictly to the dedicated test user (`00000000-0000-0000-0000-000000000001`):

```sql
-- Verification: Must return 0 rows before proceeding with reset
SELECT id, user_id, delta, type, created_at
FROM public.credit_ledger
WHERE user_id != '00000000-0000-0000-0000-000000000001'::uuid;

-- Summary check: Count test rows (should be exactly 14 test rows)
SELECT 
  count(*) AS total_rows,
  count(*) FILTER (WHERE user_id = '00000000-0000-0000-0000-000000000001'::uuid) AS test_user_rows
FROM public.credit_ledger;
```

If `total_rows` equals `test_user_rows` and the first query returns 0 rows, it is safe to proceed with the pre-cutover reset.

### Step 2: Clean Reset Execution
```sql
-- 1. Temporarily disable ledger immutability triggers
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_mutation;
ALTER TABLE public.credit_ledger DISABLE TRIGGER trg_block_ledger_truncate;

-- 2. Truncate ledger and clean test user records
TRUNCATE TABLE public.credit_ledger;
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
