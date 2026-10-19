# Production Cutover & Pre-Launch Runbook (Supabase + Vercel Hobby)

This document details the mandatory pre-launch checklist, verification leftovers reconciliation, Supabase Auth dashboard configurations, Vercel Hobby plan settings, environment variable placements, and DNS cutover runbook for launching **Diger (`diger.tech`)** on Supabase as the sole backend.

---

## 1. Pre-Cutover Verification Leftovers Reconciled

During automated live verification on Supabase project `pfinlfaqwnytesedchik`, test operations ran strictly against two isolated test users:
- **Test User 1 UUID:** `00000000-0000-0000-0000-000000000001` (balance: `1,917` points / `191.70` EGP, `169` ledger rows)
- **Test User 2 UUID:** `00000000-0000-0000-0000-000000000002` (balance: `380` points / `38.00` EGP, `33` ledger rows after real `/api/worker/chunk` dry-run)
- **Fixture Key Prefixes:** `vrun_<timestamp>_<uuid>_`

### Expected Leftovers
- **Jobs Table:** `75` test rows created under the `vrun_` / `job_quote_` prefixes.
- **Job Events Table:** `13` test event rows.
- **Plans Quotes Table:** `21` test quote rows.
- **Topups Table:** Test top-up records created under the `vrun_` prefix.
- **Credit Ledger:** Test reservation (`res_`), release (`rel_`), charge (`chg_`), and top-up (`top_`) rows (`202` total rows across Test Users 1 & 2).
- **Provider Costs:** `15` test verification spend rows logged under test jobs (`$0.6400` USD on `2026-10-12` + `$0.0100` USD dry-run on `2026-10-13` out of `$0.80` daily cap).
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
- **`templates` (`6` rows, `1` enabled):**
  - `tiktok-profile` seeded with `enabled = true`; `5` other templates seeded with `enabled = false`.

---

## 3. Temporary Fixture RPC Removal & Pre-Launch Reset (Stop Gate G4 — Owner SQL)

The RPC `public.create_verify_fixture(TEXT, JSONB)` exists strictly for automated verification without bypassing ledger immutability.

Before opening to live customer traffic, run in the **Supabase SQL Editor**:
1. Run the child-first pre-launch reset transaction in [OWNER_SQL.md](file:///d:/Digr/docs/OWNER_SQL.md) to remove all test verification rows for Test Users 1 & 2 (`00000000-0000-0000-0000-000000000001` and `00000000-0000-0000-0000-000000000002`).
2. Drop the temporary verification fixture function:
```sql
DROP FUNCTION IF EXISTS public.create_verify_fixture(TEXT, JSONB);
```
Verify removal:
```sql
SELECT proname FROM pg_proc WHERE proname = 'create_verify_fixture';
-- Must return 0 rows
```

---

## 4. Owner Admin Account Creation, Instapay Handle & Spend Caps

### A. Create and Promote the Owner Admin Account
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

### B. Where the Instapay Handle (`ipa@instapay`) Lives
The wallet page (`src/app/dashboard/topup/page.tsx`, lines 25 and 69–74) resolves the Instapay handle in this exact order:
1. **Database (`public.settings_public`, `key = 'pricing'`, JSON field `value.ipa`):**
   - Editable directly from the Admin Settings UI (`/admin/settings` -> `PATCH /api/admin/settings` in `src/app/api/admin/settings/route.ts`), or via SQL in the Supabase SQL Editor:
   ```sql
   UPDATE public.settings_public
   SET value = COALESCE(value, '{}'::jsonb) || '{"ipa": "yourhandle@instapay"}'::jsonb,
       updated_at = NOW()
   WHERE key = 'pricing';
   ```
2. **Environment Variable Fallback (`NEXT_PUBLIC_INSTAPAY_HANDLE`):**
   - Read at `src/app/dashboard/topup/page.tsx:25` if `settings_public.value.ipa` is not set.

### C. Anthropic Monthly Spend Cap (Console Protection)
In addition to the in-code daily LLM spend cap (`LLM_DAILY_SPEND_CAP_USD = 2.00` USD/UTC day in `src/functions/shared/rateLimits.ts:138`) and provider daily spend cap (`PROVIDER_DAILY_SPEND_CAP_USD = 0.80` USD/UTC day), set a hard monthly cap in the **Anthropic Console**:
1. Open `https://console.anthropic.com/settings/limits`.
2. Set **Monthly spend limit** to your desired hard ceiling (e.g., `$15` or `$20` USD/month) and configure email alert thresholds at `50%` and `80%`.

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
   - `https://*-iam-magdy.vercel.app/**`
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

Use the token-hash link below instead of `{{ .ConfirmationURL }}`. The confirmation page waits for the customer to press its button before using this one-time token, so link scanners do not consume the confirmation before the customer opens the message. Apply this template in Supabase Authentication settings; a repository change cannot update the hosted template.
```html
<div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; text-align: right; color: #1c1917; line-height: 1.8;">
  <h2>مرحباً بك في ديجر</h2>
  <p>شكراً لتسجيلك في منصة ديجر للبيانات البحثية. لتفعيل حسابك والبدء في استخدام المنصة، يرجى الضغط على الزر التالي:</p>
  <p style="margin: 24px 0;">
    <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=signup" style="background: #1c1917; color: #ffffff; padding: 12px 24px; border-radius: 999px; text-decoration: none; display: inline-block;">تفعيل البريد الإلكتروني</a>
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

### A. Required Environment Variables (Owner Must Set in Vercel)

| Variable Name | Stage | Client Exposed? | Required Value / Purpose |
| :--- | :---: | :---: | :--- |
| `NEXT_PUBLIC_SUPABASE_URL` | Build + Runtime | Yes | `https://pfinlfaqwnytesedchik.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Build + Runtime | Yes | Supabase public publishable / anon key (code also accepts `NEXT_PUBLIC_SUPABASE_ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Runtime | **NO** | Supabase `service_role` secret key (server-only) |
| `CRON_SECRET` | Runtime | **NO** | Strong random secret (32+ hex chars) for `/api/cron/watchdog` and `/api/worker/chunk` |
| `ANTHROPIC_API_KEY` | Runtime | **NO** | Anthropic server API key (`sk-ant-...`) |
| `TREG_TOKEN` | Runtime | **NO** | Live provider API token (`treg_...`) |
| `TREG_LIVE` | Runtime | **NO** | Set to `true` when ready for live provider calls (when unset or `false`, `/api/chat/accept-quote` returns HTTP 503 with zero credit reservation and `/api/worker/chunk` releases any existing reserve with zero charge) |

### B. Optional Environment Variables (Safe Code Defaults Exist)

| Variable Name | Stage | Client Exposed? | Default in Code / Purpose |
| :--- | :---: | :---: | :--- |
| `NEXT_PUBLIC_SITE_URL` | Build + Runtime | Yes | Defaults to `https://diger.tech` in `src/lib/site.ts`, and worker/nudge routes check `VERCEL_URL` first |
| `NEXT_PUBLIC_INSTAPAY_HANDLE` | Build + Runtime | Yes | Fallback IPA handle when `settings_public` (`key = 'pricing'`) has no `value.ipa` field |
| `TREG_BASE_URL` | Runtime | **NO** | Defaults to `https://treg.to` |
| `LLM_ENABLED` | Runtime | **NO** | Defaults to `true` unless set to `"false"` |
| `LLM_PROVIDER` | Runtime | **NO** | Defaults to `"anthropic"` when `ANTHROPIC_API_KEY` is present |
| `ANTHROPIC_MODEL` | Runtime | **NO** | Defaults to `"claude-haiku-4-5"` |
| `PROVIDER_DAILY_SPEND_CAP_USD` | Runtime | **NO** | Defaults to `0.80` (hard UTC daily cap) |
| `JOB_MAX_POINTS_CAP` | Runtime | **NO** | Defaults to `600` (hard per-job points cap) |

> [!CAUTION]
> - Do **NOT** add `SCRAPECREATORS_API_KEY` (not read anywhere in the codebase; `TREG_TOKEN` is the provider token) or `INSTAPAY_HANDLE` (the code reads `NEXT_PUBLIC_INSTAPAY_HANDLE` or `settings_public.value.ipa`).
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

