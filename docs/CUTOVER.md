# Production Cutover & Pre-Launch Runbook (Supabase + Vercel Hobby)

This document details the mandatory pre-launch checklist, verification leftovers reconciliation, Supabase Auth dashboard configurations, Vercel Hobby plan settings, environment variable placements, and DNS cutover runbook for launching **Diger (`diger.tech`)** on Supabase as the sole backend.

---

## 1. Pre-Cutover Verification Leftovers Reconciled

During automated live verification on Supabase project `pfinlfaqwnytesedchik`, test operations ran strictly against two isolated test users:
- **Test User 1 UUID:** `00000000-0000-0000-0000-000000000001` (balance: `1,917` points / `191.70` EGP, `169` ledger rows)
- **Test User 2 UUID:** `00000000-0000-0000-0000-000000000002` (balance: `400` points / `40.00` EGP, `28` ledger rows)
- **Fixture Key Prefixes:** `vrun_<timestamp>_<uuid>_`

### Expected Leftovers
- **Jobs Table:** `73` test rows created under the `vrun_` / `job_quote_` prefixes.
- **Job Events Table:** `11` test event rows.
- **Plans Quotes Table:** `19` test quote rows.
- **Topups Table:** Test top-up records created under the `vrun_` prefix.
- **Credit Ledger:** Test reservation (`res_`), release (`rel_`), charge (`chg_`), and top-up (`top_`) rows (`197` total rows across Test Users 1 & 2).
- **Provider Costs:** `12` test verification spend rows logged under test jobs (`$0.6400` USD committed out of `$0.80` daily cap; `$0.1600` USD remaining).
- **Storage:** Test objects uploaded during verification in private buckets `receipts` and `results` (`partials` cleaned up automatically on job completion).

> [!IMPORTANT]
> Do NOT manually delete or modify ledger rows during development. All test ledger entries are protected by database immutability triggers (`trg_credit_ledger_immutable`) and are reconciled and purged only when the owner executes the child-first pre-launch reset in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md) (Stop Gate G4).

---

## 2. Seed Configuration Applied (Phase B Verified)

Seed data has been applied via migration `20261012200628_seed_initial_configuration.sql` and verified live:
- **`settings_public` (`1` row, `key = 'pricing'`):**
  - `value`: `{"markup": 10, "usdToEgp": 55, "minPoints": 1, "safetyBuffer": 0.15, "creditValueEgp": 0.1}`
  - Read by `public.approve_topup_atomic` (`(value->>'creditValueEgp')::numeric`) and `src/hooks/useCreditValue.ts`.
- **`settings_private` (`1` row, `key = 'pricing'`):**
  - `value`: `{"markup": 10, "usdToEgp": 55, "jobMaxPointsCap": 600, "minMarginThreshold": 0.2, "providerDailySpendCapUsd": 0.8}`
  - Read/updated by `/api/admin/settings` (`src/lib/server/adminAuth.ts`). Runtime code also enforces `usdToEgp = 55`, `markup = 10`, `minPoints = 1`, `safetyBuffer = 0.15` in `src/functions/shared/quotes.ts` & `src/functions/shared/capabilityRegistry.ts`, and `PROVIDER_DAILY_SPEND_CAP_USD = 0.80` & `JOB_MAX_POINTS_CAP = 600` in `src/functions/shared/providerSpend.ts` and the atomic RPCs.
- **`capability_registry` (`12` rows):**
  - Columns populated by migration: `slug, name_ar, description_ar, endpoint_id, unit_price_credits, enabled`.
  - Only `tiktok-profile` is `enabled = true` (`unit_price_credits = 6` points / `0.60 EGP`, `0.001` USD provider cost with `10x` markup applied once). All other `11` capabilities are seeded with `enabled = false` until individually verified.
- **`templates` (`1` row):**
  - `tpl-tiktok-profile` seeded with `enabled = true`.

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

## 4. Owner Admin Account Creation & Role Assignment

Follow these exact steps to create and promote the owner admin account:

1. **Create the Owner Account:**
   - Either sign up normally on `/register` using your owner email address and confirm the email link, **OR** open **Supabase Dashboard -> Authentication -> Users -> Add user -> Create new user** (enter your owner email, strong password, and check **Auto Confirm User**).
   - A `public.profiles` row is created automatically by the `on_auth_user_created` database trigger (`handle_new_user()`).
2. **Promote the Account to Admin (Supabase SQL Editor):**
   - Open **Supabase Dashboard -> SQL Editor** and run (replacing `YOUR_OWNER_EMAIL@example.com` with your real email):
   ```sql
   UPDATE auth.users
   SET raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
   WHERE email = 'YOUR_OWNER_EMAIL@example.com';
   ```
3. **Verify Role in Database:**
   ```sql
   SELECT id, email, raw_app_meta_data->>'role' AS role
   FROM auth.users
   WHERE email = 'YOUR_OWNER_EMAIL@example.com';
   -- Must return role = 'admin'
   ```
4. **Refresh Session:**
   - Sign out of Diger and sign back in at `/login` so your session JWT refreshes and carries `app_metadata.role = "admin"`, unlocking `/admin` and `/api/admin/*`.

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
3. **Redirect URLs** (scoped strictly to `diger.tech` and the owner's Vercel project — **do NOT** use a global `https://*.vercel.app/**` wildcard):
   - `https://diger.tech/**`
   - `https://*-magdys-projects.vercel.app/**` (replace `magdys-projects` with your exact Vercel team/account slug if different)
   - `http://localhost:3000/**` (optional, for local development only)

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

### A. Required Environment Variables (Owner Must Add in Vercel)

| Variable Name | Stage | Client Exposed? | Required Value / Purpose |
| :--- | :---: | :---: | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Build + Runtime | Yes | `https://pfinlfaqwnytesedchik.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Build + Runtime | Yes | Supabase public publishable / anon key (code also accepts `NEXT_PUBLIC_SUPABASE_ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Runtime | **NO** | Supabase `service_role` secret key (server-only) |
| `CRON_SECRET` | Runtime | **NO** | Strong random secret (32+ hex chars) for `/api/cron/watchdog` and `/api/worker/chunk` |
| `ANTHROPIC_API_KEY` | Runtime | **NO** | Anthropic server API key (`sk-ant-...`) |
| `TREG_TOKEN` | Runtime | **NO** | Live provider API token (`treg_...`) |
| `TREG_LIVE` | Runtime | **NO** | Set to `true` when ready for live provider calls (`false` until live preview) |

### B. Optional Environment Variables (Safe Code Defaults Exist)

| Variable Name | Stage | Client Exposed? | Default in Code / Purpose |
| :--- | :---: | :---: | :--- |
| `NEXT_PUBLIC_SITE_URL` | Build + Runtime | Yes | Defaults to `https://diger.tech` in `src/lib/site.ts`, and worker/nudge routes check `VERCEL_URL` first |
| `NEXT_PUBLIC_INSTAPAY_HANDLE` | Build + Runtime | Yes | Fallback IPA handle when `settings_public` row has no `ipa` field |
| `TREG_BASE_URL` | Runtime | **NO** | Defaults to `https://treg.to` |
| `LLM_ENABLED` | Runtime | **NO** | Defaults to `true` unless set to `"false"` |
| `LLM_PROVIDER` | Runtime | **NO** | Defaults to `"anthropic"` |
| `ANTHROPIC_MODEL` | Runtime | **NO** | Defaults to `"claude-haiku-4-5"` |
| `PROVIDER_DAILY_SPEND_CAP_USD` | Runtime | **NO** | Defaults to `0.80` (hard UTC daily cap) |
| `JOB_MAX_POINTS_CAP` | Runtime | **NO** | Defaults to `600` (hard per-job points cap) |

> [!CAUTION]
> - Do **NOT** add `SCRAPECREATORS_API_KEY` (not read anywhere in the codebase; `TREG_TOKEN` is the provider token) or `INSTAPAY_HANDLE` (the code reads `NEXT_PUBLIC_INSTAPAY_HANDLE`).
> - Do **NOT** set `ENABLE_MOCK_PROVIDER` in Vercel (test-only flag; blocked in production when `NODE_ENV=production`).
> - Do **NOT** set `NEXT_PUBLIC_APPWRITE_ENDPOINT`, `NEXT_PUBLIC_APPWRITE_PROJECT_ID`, or `APPWRITE_API_KEY` in Vercel. Run `npm run build` (which automatically executes `scripts/check-client-bundle-secrets.ts`) to verify zero secrets leak into `.next/static`.

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
   - Run the single-unit preview check (`tiktok-profile`, 1 unit = 7 points reserved, 6 points charged, 1 point refunded) only after explicit owner approval.
