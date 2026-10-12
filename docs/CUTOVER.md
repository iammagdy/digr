# Production Cutover & Pre-Launch Runbook (Supabase + Vercel Hobby)

This document details the mandatory pre-launch checklist, verification leftovers reconciliation, Supabase Auth dashboard configurations, Vercel Hobby plan settings, environment variable placements, and DNS cutover runbook for launching **Diger (`diger.tech`)** on Supabase as the sole backend.

---

## 1. Pre-Cutover Verification Leftovers Reconciled

During automated live verification on Supabase project `pfinlfaqwnytesedchik`, test operations ran strictly against two isolated test users:
- **Test User 1 UUID:** `00000000-0000-0000-0000-000000000001` (balance: 1,917 points, 169 ledger rows)
- **Test User 2 UUID:** `00000000-0000-0000-0000-000000000002` (balance: 440 points, 18 ledger rows)
- **Fixture Key Prefixes:** `vrun_<timestamp>_<uuid>_`

### Expected Leftovers
- **Jobs Table:** Temporary test rows created under the `vrun_` prefix.
- **Topups Table:** Test top-up records created under the `vrun_` prefix.
- **Credit Ledger:** Test reservation (`res_`), release (`rel_`), charge (`chg_`), and top-up (`top_`) rows (187 total rows across test users 1 & 2).
- **Provider Costs:** Test verification spend rows logged under test jobs (`$0.6160` USD committed out of `$0.80` daily cap).
- **Storage:** Test objects uploaded during verification in private buckets `receipts` and `results`.

> [!IMPORTANT]
> Do NOT manually delete or modify ledger rows during development. All test ledger entries are protected by database immutability triggers (`trg_credit_ledger_immutable`) and are reconciled and purged only when the owner executes the child-first pre-launch reset in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md) (Stop Gate G4).

---

## 2. Seed Configuration Applied (Phase B Verified)

Seed data has been applied via migration `20261012200628_seed_initial_configuration.sql` and verified live:
- **`settings_public` (1 row, key = `pricing`):**
  - `usdToEgp = 55.0` fixed, `markup = 10.0` applied once, `creditValueEgp = 0.10` (`5,500` points per `1.00 USD` of provider cost), `safetyBuffer = 0.15` (on reserve only), `minPoints = 1`, `maxJobPoints = 600`.
- **`settings_private` (1 row, key = `provider_limits`):**
  - `providerDailySpendCapUsd = 0.80`, `jobMaxPointsCap = 600`.
- **`capability_registry` (12 rows):**
  - Only `tiktok-profile` is `enabled = true` (`unit_cost_usd = 0.0010`, `6 points` / `0.60 EGP`). All other 11 capabilities are seeded with `enabled = false` until individually verified.
- **`templates` (6 rows):**
  - Arabic research starter templates seeded.

---

## 3. Temporary Fixture RPC Removal (Stop Gate G4 — Owner SQL)

The RPC `public.create_verify_fixture(TEXT, JSONB)` exists strictly for automated verification without bypassing ledger immutability.

Before opening to live customer traffic, run in the **Supabase SQL Editor**:
```sql
DROP FUNCTION IF EXISTS public.create_verify_fixture(TEXT, JSONB);
```
Verify removal:
```sql
SELECT proname FROM pg_proc WHERE proname = 'create_verify_fixture';
-- Must return 0 rows
```

---

## 4. Owner Admin Role Assignment (Supabase SQL Editor)

After registering your owner account on Diger, assign the `admin` role in the **Supabase SQL Editor**:
```sql
UPDATE auth.users
SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
WHERE email = 'YOUR_OWNER_EMAIL@example.com';
```
Verify that the admin role is reflected:
```sql
SELECT id, email, raw_app_meta_data->>'role' AS role
FROM auth.users
WHERE email = 'YOUR_OWNER_EMAIL@example.com';
-- Role must be 'admin'
```

---

## 5. Supabase Auth Dashboard Settings

Configure the following settings in the **Supabase Dashboard** (`Authentication`):

### A. Leaked Password Protection
1. Open **Authentication** -> **Providers** -> **Email** (or **Authentication** -> **Attack Protection / Security**).
2. Enable **Prevent use of leaked passwords** (HaveIBeenPwned check).
3. Set **Minimum password length** to `8` characters.

### B. Site URL & Redirect URLs
1. Open **Authentication** -> **URL Configuration**.
2. **Site URL:** `https://diger.tech`
3. **Redirect URLs:**
   - `https://diger.tech/auth/callback`
   - `https://diger.tech/verify`
   - `https://diger.tech/reset`
   - `https://diger.tech/dashboard/**`
   - `http://localhost:3000/auth/callback`
   - `http://localhost:3000/verify`

### C. Custom SMTP Configuration (Resend)
1. Open **Authentication** -> **SMTP Settings**.
2. Enable **Custom SMTP**:
   - **Sender Email:** `noreply@diger.tech`
   - **Sender Name:** `ديجر`
   - **Host:** `smtp.resend.com`
   - **Port:** `465` (SSL) or `587` (STARTTLS)
   - **Username:** `resend`
   - **Password:** `<RESEND_API_KEY>`

### D. Arabic RTL Email Templates
Open **Authentication** -> **Email Templates** and paste these RTL Arabic templates:

#### 1. Confirm Signup (`تأكيد بريدك الإلكتروني في ديجر`)
```html
<div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; text-align: right; color: #1c1917; line-height: 1.8;">
  <h2>مرحباً بك في ديجر</h2>
  <p>شكراً لتسجيلك في منصة ديجر للبيانات البحثية. لتفعيل حسابك والبدء في استخدام المنصة، يرجى الضغط على الزر التالي:</p>
  <p style="margin: 24px 0;">
    <a href="{{ .ConfirmationURL }}" style="background: #1c1917; color: #ffffff; padding: 12px 24px; border-radius: 999px; text-decoration: none; display: inline-block;">تفعيل البريد الإلكتروني</a>
  </p>
  <p style="font-size: 12px; color: #78716c;">إذا لم تقم بإنشاء هذا الحساب، يمكنك تجاهل هذه الرسالة بأمان.</p>
</div>
```

#### 2. Reset Password (`إعادة تعيين كلمة المرور في ديجر`)
```html
<div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; text-align: right; color: #1c1917; line-height: 1.8;">
  <h2>إعادة تعيين كلمة المرور</h2>
  <p>تلقينا طلباً لإعادة تعيين كلمة المرور الخاصة بحسابك في ديجر. اضغط على الزر التالي لاختيار كلمة مرور جديدة:</p>
  <p style="margin: 24px 0;">
    <a href="{{ .ConfirmationURL }}" style="background: #1c1917; color: #ffffff; padding: 12px 24px; border-radius: 999px; text-decoration: none; display: inline-block;">تعيين كلمة مرور جديدة</a>
  </p>
  <p style="font-size: 12px; color: #78716c;">إذا لم تطلب تغيير كلمة المرور، فلا داعي لاتخاذ أي إجراء.</p>
</div>
```

---

## 6. Vercel Hobby Plan Configuration (`vercel.json`)

The repository includes `vercel.json` tailored for the **Vercel Hobby** plan:
- **Cron Schedule:** Exactly 1 daily cron job (`/api/cron/watchdog` at `0 0 * * *` UTC), which:
  1. Releases expired unaccepted quotes (`status = 'quoted'` past `expires_at`).
  2. Force-releases stalled running/queued jobs whose worker lease has expired (`release_job_atomic(job_id, reason, true)` — full reserve refunded, zero charge).
  3. Purges accounts whose 30-day deletion grace period (`deletion_scheduled_for <= now()`) has elapsed (isolating each user in its own `try/catch`, deleting `results` storage files and non-financial rows, preserving `receipts` and all financial ledger rows, anonymizing the profile, and banning the auth account).
- **Function Max Duration:** `60` seconds (`"maxDuration": 60`) for both `src/app/api/worker/chunk/route.ts` and `src/app/api/cron/watchdog/route.ts`.
- **Worker Self-Chaining:** Because Hobby crons run once daily, job execution does not wait for cron. `/api/chat/accept-quote` immediately triggers `/api/worker/chunk` with `x-cron-secret: CRON_SECRET`, and `/api/worker/chunk` self-chains the next chunk until all chunks complete and `settle_job_atomic` runs. Users can also nudge a stalled job via `/api/jobs/[id]/nudge`.

---

## 7. Production Environment Variables (Vercel)

Set the following environment variables in **Vercel Project Settings -> Environment Variables** (Production & Preview):

| Variable Name | Client Exposed? | Required Value / Purpose |
| :--- | :---: | :--- |
| `NEXT_PUBLIC_SITE_URL` | Yes | `https://diger.tech` |
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | `https://pfinlfaqwnytesedchik.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase public `anon` key |
| `NEXT_PUBLIC_INSTAPAY_HANDLE` | Yes | Owner Instapay IPA address |
| `SUPABASE_SERVICE_ROLE_KEY` | **NO** | Supabase `service_role` secret key (server-only) |
| `CRON_SECRET` | **NO** | Strong random secret (32+ hex chars) for `/api/cron/watchdog` and `/api/worker/chunk` |
| `TREG_TOKEN` | **NO** | Live provider API token (`treg_...`) |
| `TREG_LIVE` | **NO** | `true` in production when ready for live provider calls |
| `TREG_BASE_URL` | **NO** | `https://treg.to` |
| `LLM_ENABLED` | **NO** | `true` |
| `LLM_PROVIDER` | **NO** | `anthropic` |
| `ANTHROPIC_API_KEY` | **NO** | Anthropic server API key (`sk-ant-...`) |
| `ANTHROPIC_MODEL` | **NO** | `claude-haiku-4-5` |
| `RESEND_API_KEY` | **NO** | Resend API key (`re_...`) for email notifications |
| `PROVIDER_DAILY_SPEND_CAP_USD` | **NO** | `0.80` (hard UTC daily cap) |
| `JOB_MAX_POINTS_CAP` | **NO** | `600` (hard per-job points cap) |
| `ENABLE_APPWRITE_ADMIN_FALLBACK` | **NO** | `false` |

> [!CAUTION]
> Do **NOT** set `NEXT_PUBLIC_APPWRITE_ENDPOINT`, `NEXT_PUBLIC_APPWRITE_PROJECT_ID`, or `APPWRITE_API_KEY` in Vercel. Run `npm run build` (which automatically executes `scripts/check-client-bundle-secrets.ts`) to verify zero secrets leak into `.next/static`.

---

## 8. Final Cutover Sequence (Stop Gates G3, G4, G5)

1. **Gate G4 (Pre-Launch Clean Reset):**
   - Run the pre-check query and child-first reset transaction in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md) in the Supabase SQL Editor.
   - Drop `public.create_verify_fixture(TEXT, JSONB)`.
2. **Gate G3 (Deploy & Domain Cutover):**
   - Merge PR #43 (`migrate/supabase` -> `main`) **ONLY after explicit owner approval**.
   - Connect the GitHub repository to Vercel and deploy `main` with the environment variables in Section 7.
   - Point `diger.tech` DNS (`A` record -> `76.76.21.21`, `CNAME` `www` -> `cname.vercel-dns.com`) to Vercel and verify SSL certificate issuance.
3. **Gate G5 (Tiny Live Preview Job):**
   - Run the single-unit preview check (`tiktok-profile`, 1 unit = 6 points reserved, 5 points charged, 1 point refunded) only after explicit owner approval.
