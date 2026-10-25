# send-email Edge Function

Sends the six approved Arabic platform email templates, plus the compact `job-update` template and the owner's `admin-topup-alert`, via the **Resend API**.
Replaces the cancelled Appwrite Messaging path. No Appwrite code is used.

## Files

- `index.ts` — POST handler: auth → validate → render → Resend.
- `templates.ts` — the six templates **verbatim** + subjects + renderer.
  Do not hand-edit the HTML; it must stay byte-identical to the approved brief.
- `index.test.ts` — render + payload tests (no network). Run: `deno test --allow-env`

## Deploy

```bash
supabase secrets set RESEND_API_KEY=...        # Resend API key (send-only)
supabase functions deploy send-email
```

`SUPABASE_SERVICE_ROLE_KEY` is already present in the function's env on Supabase.
`SITE_URL` is optional (defaults to `https://diger.tech`).

## Call it (server-to-server only)

```bash
curl -X POST "$SUPABASE_URL/functions/v1/send-email" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"template":"topup-approved","to":"customer@example.com",
       "vars":{"Name":"...","Credits":"5000","ConfirmedAmountEgp":"500",
               "Reference":"REF-1","Balance":"5200"}}'
```

The caller must be server-side (API route / trigger / admin flow). The service-role
key never goes to the client.

## Trigger points (wired by the migration)

| Template | When | Vars |
|---|---|---|
| `welcome` | New user confirms email (auth trigger) | `Name` |
| `topup-received` | Top-up submitted | `Name`, `AmountEgp`, `Credits`, `ReviewNote` (the review-time sentence of the top-up page), `CreatedAt` — all in Arabic-Indic digits; the internal receipt id is never sent |
| `topup-approved` | Admin approves top-up | `Name`, `Credits`, `ConfirmedAmountEgp`, `Balance` |
| `topup-rejected` | Admin rejects top-up | `Name`, `AmountEgp`, `RejectReason` |
| `job-done` | Job completes with files | `Name`, `JobTitle` |
| `refund` | Points refunded | `Name`, `Points`, `JobTitle`, `Reason`, `Balance` |
| `job-update` | A long job started, stalled temporarily, or completed partially | `Name`, `Subject`, `Heading`, `Lead`, `DetailOne`, `DetailTwo`, `ButtonLabel`, `JobURL` (all plain Arabic, written by the app from real numbers) |
| `admin-topup-alert` | A new top-up request, to the owner's address (`ADMIN_ALERT_EMAIL` on the app) | `CustomerName`, `CustomerEmail`, `Points`, `AmountEgp`, `RequestTime`, `AdminURL` (right-to-left; no receipt image, receipt id or token) |

All eight templates are built by ONE base layout (`layout()` in `templates.ts`): right-to-left and right-aligned on the wrapper table and on every cell, the brand mark on a small light rounded background (visible in dark-mode clients), a card (status chip, heading, short body, boxed reason, label/value table, one primary button, note) and a footer (the preferences footer for customers, the admin footer only for `admin-topup-alert`). Inline CSS only; no external fonts or scripts; `color-scheme` is light only. A template's variables never change name; new ones may only be added as optional.

Missing vars render as `""` — no raw `{{ .Var }}` token ever reaches a customer.
Values are HTML-escaped in the body; the subject is plain text.


## Welcome trigger (DB trigger, not an API call)

`welcome` is NOT sent from an API route. It fires from a Postgres trigger on
`auth.users` when `email_confirmed_at` goes from NULL -> set (covers email-link
confirmation and OAuth signup):

- Migration: `supabase/migrations/20261013170000_welcome_email_on_confirm.sql`
  (pg_net -> this function; silent no-op if the Vault secret is missing,
  never breaks auth).
- One-time owner step in the SQL Editor (never paste the key in chat):
  `select vault.create_secret('<SERVICE_ROLE_KEY>', 'send-email-service-role-key');`

The other five templates are sent from API routes via this function (see the
trigger table above).

## Notes

- Sender is fixed: `Diger <noreply@diger.tech>` (domain verified on Resend).
- The old Appwrite `notify.ts` / Messaging wiring is dead code — it is removed
  at cutover, not adapted. This function is its replacement.
- Email preferences: the caller checks the user's notification preferences
  before invoking this function (same rule as before).
