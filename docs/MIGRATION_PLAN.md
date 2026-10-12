# Digr Backend Migration Plan: Appwrite to Supabase

## 1. Overview & Objectives
- **Target Project:** Supabase project `pfinlfaqwnytesedchik` (clean, verified via MCP).
- **Core Principle:** Exact preservation and strengthening of all money, ledger, and execution invariants.
- **Client Security:** Strict Row Level Security (RLS) on all public tables. Zero client write access to financial or execution tables (`credit_ledger`, `topups`, `jobs`, `plans_quotes`).
- **Resilience:** Resumable chunked worker execution model to guarantee zero job loss under platform timeouts.

---

## 2. Old-to-New Architectural Mapping

### A. Collections to Postgres Tables
| Appwrite Collection | Supabase Table | Key Types & Constraints | Access Policy (RLS) |
| :--- | :--- | :--- | :--- |
| `profiles` | `public.profiles` | `id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`, `email TEXT`, `phone TEXT`, `sender_name TEXT`, `deletion_scheduled_for TIMESTAMPTZ` | Select: own profile (`auth.uid() = id`) or admin. Update: own profile. Insert: via auth trigger. |
| `credit_ledger` | `public.credit_ledger` | `id TEXT PRIMARY KEY` (deterministic: `res_`, `rel_`, `chg_`, `top_`, `gwl_`), `user_id UUID REFERENCES auth.users(id)`, `delta NUMERIC NOT NULL`, `type TEXT NOT NULL`, `job_id TEXT`, `topup_id TEXT`, `note TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()` | **Append-Only via DB Trigger**. Select: own rows (`auth.uid() = user_id`) or admin. **Insert/Update/Delete by clients FORBIDDEN** (Service role / Security Definer RPC only). |
| `topups` | `public.topups` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `amount_egp NUMERIC NOT NULL`, `reference TEXT UNIQUE NOT NULL`, `sender_name TEXT NOT NULL`, `sender_phone TEXT NOT NULL`, `receipt_file_id TEXT NOT NULL`, `status TEXT DEFAULT 'pending'`, `created_at TIMESTAMPTZ` | Select: own rows or admin. Insert: own pending topup via server validation route. Update/Delete: admin / service role only. |
| `jobs` | `public.jobs` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `status TEXT NOT NULL`, `endpoint_id TEXT`, `target_volume_min INT`, `target_volume_max INT`, `reserved_credits NUMERIC`, `charged_credits NUMERIC`, `delivered_units INT`, `result_file_id TEXT`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | Select: own rows or admin. **Writes by clients FORBIDDEN** (Server routes / Service role only). |
| `job_events` | `public.job_events` | `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE`, `user_id UUID`, `message TEXT`, `units INT`, `event_type TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()` | Select: own rows where `user_id = auth.uid()` or admin. Insert: service role only. |
| `plans_quotes` | `public.plans_quotes` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `quote_hash TEXT NOT NULL`, `status TEXT DEFAULT 'quoted'`, `items JSONB NOT NULL`, `total_reserved_credits NUMERIC NOT NULL`, `output_formats JSONB`, `expires_at TIMESTAMPTZ NOT NULL`, `created_at TIMESTAMPTZ` | Select: own quotes or admin. **Writes by clients FORBIDDEN** (Server route generates quotes). |
| `conversations` | `public.conversations` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `title TEXT`, `status TEXT`, `brief JSONB`, `created_at TIMESTAMPTZ`, `updated_at TIMESTAMPTZ` | Select/Insert/Update: own rows (`auth.uid() = user_id`) or admin. Delete: own rows. |
| `messages` | `public.messages` | `id TEXT PRIMARY KEY`, `conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE`, `user_id UUID REFERENCES auth.users(id)`, `role TEXT NOT NULL`, `content_ar TEXT NOT NULL`, `clarification_items JSONB`, `plan JSONB`, `quote JSONB`, `created_at TIMESTAMPTZ` | Select: own rows (`auth.uid() = user_id`) or admin. Insert: own rows or server chat route. |
| `artifact_versions` | `public.artifact_versions` | `id TEXT PRIMARY KEY`, `job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE`, `user_id UUID`, `version_number INT NOT NULL`, `file_id_xlsx TEXT`, `file_id_pdf TEXT`, `file_id_csv TEXT`, `created_at TIMESTAMPTZ` | Select: own rows or admin. Writes: service role only. |
| `notifications` | `public.notifications` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `title TEXT`, `body TEXT`, `read BOOLEAN DEFAULT FALSE`, `link TEXT`, `created_at TIMESTAMPTZ` | Select/Update: own rows (`auth.uid() = user_id`). Insert: service role only. |
| `admin_audit_log` | `public.admin_audit_log` | `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `actor_id UUID`, `action TEXT`, `target_type TEXT`, `target_id TEXT`, `details JSONB`, `created_at TIMESTAMPTZ` | Select: admin only (`is_admin()`). Insert: service role only. |
| `provider_costs` | `public.provider_costs` | `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `job_id TEXT`, `provider TEXT`, `units INT`, `cost_usd NUMERIC`, `created_at TIMESTAMPTZ` | Select/Insert: admin / service role only. |
| `settings_public` | `public.settings_public` | `key TEXT PRIMARY KEY`, `value JSONB NOT NULL`, `updated_at TIMESTAMPTZ` | Select: public (`anon` & `authenticated`). Writes: admin only. |
| `settings_private` | `public.settings_private` | `key TEXT PRIMARY KEY`, `value JSONB NOT NULL`, `updated_at TIMESTAMPTZ` | Select/Writes: service role only. |
| `capability_registry` | `public.capability_registry` | `slug TEXT PRIMARY KEY`, `name_ar TEXT`, `description_ar TEXT`, `endpoint_id TEXT`, `unit_price_credits NUMERIC`, `enabled BOOLEAN` | Select: public (`anon` & `authenticated`). Writes: admin only. |
| `llm_usage` | `public.llm_usage` | `id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `user_id UUID`, `tokens_in INT`, `tokens_out INT`, `model TEXT`, `latency_ms INT`, `reason TEXT`, `created_at TIMESTAMPTZ` | Select/Writes: service role only. |
| `templates` | `public.templates` | `id TEXT PRIMARY KEY`, `title_ar TEXT`, `prompt_ar TEXT`, `category TEXT`, `enabled BOOLEAN` | Select: public. Writes: admin only. |
| `notes` | `public.notes` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `title TEXT`, `body TEXT`, `created_at TIMESTAMPTZ` | Select/Insert/Update/Delete: own rows (`auth.uid() = user_id`). |
| `capability_requests` | `public.capability_requests` | `id TEXT PRIMARY KEY`, `user_id UUID REFERENCES auth.users(id)`, `query TEXT`, `created_at TIMESTAMPTZ` | Select: own rows or admin. Insert: own rows. |

---

### B. Storage Buckets & Policies
1. **`receipts` (Private)**:
   - For user payment proof uploads (Max 10MB; images, pdf).
   - User policy: `INSERT` with check `(bucket_id = 'receipts' AND (storage.foldername(name))[1] = auth.uid()::text)`.
   - Read policy: Owner can read own receipts, Admins can read all.
2. **`results` (Private)**:
   - For job output files (`xlsx`, `pdf`, `csv`) and methodology documents.
   - Client access: No direct public access. Accessible only via short-lived signed URLs generated server-side for authenticated job owners.
3. **`partials` (Internal)**:
   - Temporary JSONL storage for chunked pagination intermediate data. Service role only.

---

### C. Appwrite Functions to Supabase Architecture
| Appwrite Function | New Supabase / Next.js Implementation | Execution Model |
| :--- | :--- | :--- |
| `on-user-create` | Postgres Database Trigger (`AFTER INSERT ON auth.users`) | Executes in DB: creates initial `profiles` row, sets default preferences, logs welcome notification. |
| `submit-topup` | Next.js Server Route Handler (`POST /api/topup/submit`) | Authenticates session via `@supabase/ssr`, validates 3-part Arabic name, Egyptian mobile number, receipt file in bucket, inserts `topups` row (`status = 'pending'`). |
| `approve-topup` | Next.js Server Route Handler (`POST /api/admin/topups/approve`) | Admin-only route (`is_admin()`), inserts `credit_ledger` entry (`top_<topupId>`) idempotently, marks topup `approved`, emits notification. |
| `create-job` | Invoked within `POST /api/chat/accept-quote` | Atomic reserve via `reserve_credits_atomic`, creates job row (`queued`), enqueues/invokes initial worker chunk. |
| `job-worker` | Resumable Chunked Worker (`POST /api/jobs/worker` or Edge Function) | Reads job state from DB, processes bounded batches (up to timeout limit), checkpoints state, reschedules next chunk if not done. |
| `watchdog` | Scheduled Cron (pg_cron or Vercel Cron every 10 min) | Finds stale jobs (>30m queued/running), calls `release_reservation` (`rel_<jobId>`) idempotently, marks job `failed`. |
| `request-account-deletion` | Next.js Server Route Handler (`POST /api/account/delete`) | Requires `"حذف"` confirmation, sets `deletion_scheduled_for = now() + interval '30 days'` in `profiles`, revokes user sessions. |
| `purge-deleted-accounts` | Scheduled Cron (daily at 03:00 UTC) | Deletes expired user profiles, non-financial files, conversations, while preserving all financial `credit_ledger` entries. |

---

## 3. Money Rules & SQL Functions Implementation

### A. Immutability Trigger
```sql
CREATE OR REPLACE FUNCTION block_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

CREATE TRIGGER trg_block_ledger_mutation
BEFORE UPDATE OR DELETE ON public.credit_ledger
FOR EACH ROW
EXECUTE FUNCTION block_ledger_mutation();
```

### B. Atomic Concurrency-Safe Reserve Function
```sql
CREATE OR REPLACE FUNCTION public.reserve_credits_atomic(
  p_user_id UUID,
  p_job_id TEXT,
  p_amount NUMERIC,
  p_note TEXT DEFAULT 'حجز رصيد للطلب'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_res_id TEXT := 'res_' || p_job_id;
  v_current_balance NUMERIC;
  v_already_reserved BOOLEAN;
BEGIN
  -- 1. Check idempotency: res_<job_id>
  IF EXISTS (SELECT 1 FROM credit_ledger WHERE id = v_res_id) THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_current_balance FROM credit_ledger WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', true, 'already_reserved', true, 'balance', v_current_balance);
  END IF;

  -- 2. Concurrency lock on user profile row
  PERFORM 1 FROM profiles WHERE id = p_user_id FOR UPDATE;

  -- 3. Calculate true balance across all ledger entries (no pagination limit)
  SELECT COALESCE(SUM(delta), 0) INTO v_current_balance FROM credit_ledger WHERE user_id = p_user_id;

  -- 4. Check sufficient balance
  IF v_current_balance < ABS(p_amount) THEN
    RETURN jsonb_build_object('success', false, 'error', 'insufficient_balance', 'balance', v_current_balance);
  END IF;

  -- 5. Append deterministic reservation row
  INSERT INTO credit_ledger (id, user_id, delta, type, job_id, note, created_at)
  VALUES (v_res_id, p_user_id, -ABS(p_amount), 'reserve', p_job_id, p_note, NOW())
  ON CONFLICT (id) DO NOTHING;

  SELECT COALESCE(SUM(delta), 0) INTO v_current_balance FROM credit_ledger WHERE user_id = p_user_id;
  RETURN jsonb_build_object('success', true, 'already_reserved', false, 'balance', v_current_balance);
END;
$$;
```

### C. Release-First Settlement & Refund Logic
- **Release:** Inserts `rel_<jobId>` with `+reservedCredits`. Idempotent with `ON CONFLICT (id) DO NOTHING`.
- **Charge:** Only if release succeeded (or was newly created), inserts `chg_<jobId>` with `-ceil(delivered * unitPrice)`.
- **Refusal / Error:** Calls `release_reservation(rel_<jobId>)` immediately with zero charge.

---

## 4. Admin Role & Authentication Security
- Admin verification relies on `(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'`.
- Dedicated SQL helper:
  ```sql
  CREATE OR REPLACE FUNCTION public.is_admin()
  RETURNS BOOLEAN
  LANGUAGE sql
  STABLE
  AS $$
    SELECT COALESCE((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  $$;
  ```
- Clients can never modify `app_metadata` (restricted to service role / Supabase dashboard).

---

## 5. Resumable Chunked Worker Execution Model
1. **Checkpointing:** The `jobs` table maintains `current_cursor`, `delivered_units`, `accumulated_cost_usd`, and `status`.
2. **Bounded Execution:** Each invocation runs for at most 8–10 seconds (well within the platform timeout), processing up to $N$ pages/records.
3. **Re-invocation:** Before exiting, if more records remain, the worker dispatches the next execution step with the updated cursor.
4. **Idempotency:** Every provider request passes `Idempotency-Key: <jobId>_<cursor_or_step>`.

---

## 6. Testing & Verification Strategy
- **Port Existing Tests (397 tests):** Replace Appwrite SDK mocks with Supabase client / DAL mocks.
- **New Test Additions:**
  1. *Concurrent Reserve Test:* Run concurrent simulated reserves on the same account to verify zero overspending.
  2. *Ledger Immutability Test:* Attempt `UPDATE` and `DELETE` on `credit_ledger` and verify trigger rejection.
  3. *RLS Privilege Tests:* Verify client tokens cannot read other users' data and cannot write to financial tables.
- **Advisor Audits:** Run `get_advisors` (Security and Performance) via Supabase MCP to achieve 100% clean reports.
