# send-email Edge Function

Sends the six approved Arabic platform email templates via the **Resend API**.
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
| `topup-received` | Top-up submitted | `Name`, `AmountEgp`, `Credits`, `Reference`, `CreatedAt` (Arabic date, e.g. `13 أكتوبر 2026` — use `formatArabicDate`) |
| `topup-approved` | Admin approves top-up | `Name`, `Credits`, `ConfirmedAmountEgp`, `Reference`, `Balance` |
| `topup-rejected` | Admin rejects top-up | `Name`, `AmountEgp`, `Reference`, `RejectReason` |
| `job-done` | Job completes with files | `Name`, `JobTitle` |
| `refund` | Points refunded | `Name`, `Points`, `JobTitle`, `Reason`, `Balance` |

Missing vars render as `""` — no raw `{{ .Var }}` token ever reaches a customer.
Values are HTML-escaped in the body; the subject is plain text.

## Notes

- Sender is fixed: `Diger <noreply@diger.tech>` (domain verified on Resend).
- The old Appwrite `notify.ts` / Messaging wiring is dead code — it is removed
  at cutover, not adapted. This function is its replacement.
- Email preferences: the caller checks the user's notification preferences
  before invoking this function (same rule as before).
