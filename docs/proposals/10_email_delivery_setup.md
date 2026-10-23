# Customer e-mail delivery: what is missing in production (proposal, nothing here is applied)

**Why this note exists.** Phase 4 checked the e-mail path from the app to the customer's inbox. The app side is wired; the part that
actually sends (a Supabase Edge Function) was found missing in production. No secret is printed below, and none is needed to read it.

## How an e-mail is sent today (from the code)

1. The worker (completion, partial completion, failure), the daily watchdog (stalled job), the top-up routes and the start of a large
   request call `sendPlatformEmail` (`src/lib/server/sendPlatformEmail.ts`).
2. It posts to `<NEXT_PUBLIC_SUPABASE_URL>/functions/v1/send-email` with the service-role key (`SUPABASE_SERVICE_ROLE_KEY`).
3. The Edge Function `supabase/functions/send-email` renders one of seven Arabic templates (`templates.ts`) and calls Resend with
   `RESEND_API_KEY` read from the **Supabase function's own secrets** (`Deno.env`). The sender is fixed: `Diger <noreply@diger.tech>`.
4. A failure is logged with a fixed reason code and swallowed: it never blocks a job, a charge or a release.

## What was found (read-only checks, names and presence only)

| Check | Result |
|---|---|
| Edge Functions deployed on the Supabase project linked to this repository | **none** (the list is empty), so `send-email` is not published: every customer e-mail currently ends as `function_unavailable` |
| `RESEND_API_KEY` | exists in **Vercel (Production)**, but no Vercel code reads it; the function reads it from **Supabase secrets**. Whether it is also set there cannot be seen without deploying |
| `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `CRON_SECRET` | present in Vercel (Production and Preview) |
| Sender domain `diger.tech` verified on Resend | cannot be seen from here; a test e-mail answers it (`resend_rejected` if not) |
| `LONG_JOB_DRIVER` | not set; `/api/driver-status` answers `{"mode":"tab"}`; `pg_cron` and `pg_net` are not installed on the database |

## Owner steps (about 5 minutes; never paste a key in chat)

1. Supabase dashboard, Edge Functions: deploy `send-email` from `supabase/functions/send-email` of the `main` branch (this PR's template
   fix is needed: the old copy still said «رجعت نقاطك» and «استرداد»). With the CLI: `supabase functions deploy send-email`.
2. Supabase dashboard, Edge Functions, Secrets: add `RESEND_API_KEY` (the same value as in Vercel). With the CLI: `supabase secrets set RESEND_API_KEY=...`.
3. Open `/admin/settings`, card «فحص البريد الإلكتروني للعملاء»: press «افحص الإعداد» (it must say the function is published and knows the
   template), then press «أرسل لي رسالة «اكتمال»». The result is the real one; a failure names the reason in Arabic.

## Alternative if you prefer not to run the function

Send directly from the app with the key already in Vercel. That is a code change (a second transport inside `sendPlatformEmail`, and the
seven templates moved into the app), so it is not part of this proposal; say so if you want it.

## Turn it off

Nothing to undo: deleting the function only returns to today's state, where e-mails are skipped and the in-app notices still work.
