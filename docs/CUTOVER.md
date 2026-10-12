# Production Cutover & Pre-Launch Runbook (Supabase)

This document details the mandatory steps, verification leftovers reconciliation, Supabase Auth dashboard configurations, environment variable placements, and security actions required prior to opening Digr to live customer traffic on Supabase.

---

## 1. Pre-Cutover Verification Leftovers Reconciled

During local and synthetic verification, test operations run against two isolated test users:
- **Test User 1 UUID:** `00000000-0000-0000-0000-000000000001` (balance: 1917 points, 169 ledger rows)
- **Test User 2 UUID:** `00000000-0000-0000-0000-000000000002` (balance: 440 points, 18 ledger rows)
- **Fixture Key Prefixes:** `vrun_<timestamp>_<uuid>_`

### Expected Leftovers
- **Jobs Table:** Temporary test rows with status `running`, `queued`, `completed`, or `failed` created under the `vrun_` prefix.
- **Topups Table:** Test top-up records created under the `vrun_` prefix.
- **Credit Ledger:** Test reservation (`res_`), release (`rel_`), charge (`chg_`), and top-up (`top_`) rows (187 total rows across test users 1 & 2).
- **Provider Costs:** Test synthetic calls or small verification spend rows logged under test jobs ($0.6160 USD committed out of $0.80 daily cap).
- **Storage:** Test objects uploaded during verification in buckets `receipts` and `results`.

> [!IMPORTANT]
> Do NOT manually delete or modify ledger rows during Phase B development. All test ledger entries are protected by database immutability triggers and are strictly reconciled and purged only during the clean child-first pre-launch reset detailed in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md).

---

## 2. Temporary Fixture RPC Removal (Mandatory Pre-Launch Step)

The RPC `public.create_verify_fixture(TEXT, JSONB)` exists strictly to facilitate automated live verification without bypassing ledger immutability or granting client write privileges.

Before opening to live production traffic:
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

## 3. Owner Admin Role Assignment

To assign the system administrator role to the owner in Supabase without relying on Appwrite:
1. In the Supabase SQL Editor, execute:
```sql
UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
WHERE email = 'YOUR_OWNER_EMAIL@example.com';
```
2. Verify that the admin role is reflected in `auth.users`:
```sql
SELECT id, email, raw_app_meta_data->>'role' AS role
FROM auth.users
WHERE email = 'YOUR_OWNER_EMAIL@example.com';
-- Role must be 'admin'
```
3. Ensure the environment variable `ENABLE_APPWRITE_ADMIN_FALLBACK` is set to `false` (or left unset, as default is `false`) so all administrative access is strictly authenticated via Supabase JWTs.

---

## 4. Supabase Auth Dashboard Settings

Configure the following settings in the **Supabase Dashboard** under **Authentication**:

### A. Leaked Password Protection (Security Advisor)
- Navigate to **Authentication** -> **Security**.
- Under **Password Protection**, turn ON:
  - **Prevent leaked passwords** (checks against HaveIBeenPwned.org database).
  - Minimum password length: 8 characters.

### B. Redirect URLs
- Navigate to **Authentication** -> **URL Configuration**.
- **Site URL:** `https://diger.tech`
- **Redirect URLs:**
  - `https://diger.tech/auth/callback`
  - `https://diger.tech/dashboard`
  - `http://localhost:3000/auth/callback` (for local development)

### C. Custom SMTP Configuration (Resend)
- Navigate to **Authentication** -> **SMTP Settings**.
- Enable **Custom SMTP**.
- **Sender Email:** `noreply@diger.tech`
- **Sender Name:** `ديجر | Diger`
- **Host:** `smtp.resend.com`
- **Port:** `465` (SSL) or `587` (TLS)
- **Username:** `resend`
- **Password:** `[RESEND_API_KEY]` (from your Resend account)

### D. Arabic Email Templates (RTL)
- Navigate to **Authentication** -> **Email Templates**.
- **Confirm Signup:**
  - Subject: `تأكيد بريدك الإلكتروني في ديجر`
  - Body: Arabic RTL formatted message with confirmation link.
- **Magic Link / Login:**
  - Subject: `رابط تسجيل الدخول إلى ديجر`
- **Password Reset:**
  - Subject: `إعادة تعيين كلمة المرور في ديجر`

---

## 5. Environment Variables Placement

Ensure the following environment variables are set in the respective environments:

| Variable Name | Location | Client Exposed? | Purpose |
| :--- | :--- | :---: | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Vercel / `.env.local` | Yes | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel / `.env.local` | Yes | Supabase Public Anonymous API Key |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel (Server Only) | **NO** | Supabase Backend Elevated Key (Security Definer RPCs) |
| `CRON_SECRET` | Vercel (Server Only) | **NO** | Timing-safe secret for watchdog cron & worker chunk chaining |
| `ENABLE_APPWRITE_ADMIN_FALLBACK` | Vercel (Server Only) | **NO** | Set to `false` (disables legacy Appwrite fallback) |
| `RESEND_API_KEY` | Vercel (Server Only) | **NO** | Transactional email delivery via Resend API / SMTP |
| `TREG_API_KEY` | Vercel (Server Only) | **NO** | Research capability data provider key |
| `ANTHROPIC_API_KEY` | Vercel (Server Only) | **NO** | LLM assistant integration key |

> [!CAUTION]
> Never expose `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `RESEND_API_KEY`, `TREG_API_KEY`, or `ANTHROPIC_API_KEY` to client-side bundles. Run `scripts/check-client-bundle-secrets.ts` to verify before production deployments.

---

## 6. Seed Data Application (Gate G2)

Seed tables (`settings_public`, `settings_private`, `capability_registry`, `templates`) currently hold **0 rows** in production.
- Review proposed rows in [SEED_PROPOSAL.md](file:///d:/Digr/docs/SEED_PROPOSAL.md).
- Once approved by the owner, execute the transaction-wrapped SQL in [SEED_PROPOSAL.md](file:///d:/Digr/docs/SEED_PROPOSAL.md) in the Supabase SQL Editor.

---

## 7. Final Pre-Launch Child-First Reset Execution

Immediately prior to opening live customer traffic (Phase C cutover):
1. Confirm all existing rows in `credit_ledger` belong strictly to test users (run Step 1 query in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md)).
2. Execute the child-first clean reset script from Step 2 in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md).
3. Confirm that the ledger is 0 rows and immutability triggers are active.
4. Execute temporary RPC drop: `DROP FUNCTION IF EXISTS public.create_verify_fixture(TEXT, JSONB);`.
5. Verify admin account role and pricing settings.
