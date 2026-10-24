# Visitor analytics: SQL proposal (NOTHING HERE IS APPLIED)

The site now sends a small, privacy-safe beacon (`src/lib/analytics`, `src/app/api/analytics/collect`) and the admin has a «الزوّار» tab (`/admin/visitors`) and a small summary on the overview.
**Until the owner applies these three steps nothing is stored and nothing breaks:** the beacon route drops what it cannot write, and the admin tab says «تتبع الزوّار غير مُفعَّل بعد».

## Apply order

| Step | File | What |
|---|---|---|
| 0 | `00_verify_before_apply.sql` | read only: the table is not there yet |
| 1 | `01_visitor_events_table.sql` (+ `.rollback.sql`) | the table, its checks, RLS enabled with NO policy |
| 2 | `02_visitor_events_indexes.sql` (+ rollback) | five indexes for the bounded admin reads |
| 3 | `03_visitor_events_access.sql` (+ rollback) | REVOKE from PUBLIC, anon, authenticated; GRANT to service_role only |
| 4 | `04_verify_after_apply.sql` | read only checks, the expected answer in each comment |

**Rollback order: 3, 2, 1.** Nothing depends on the table (no money table, no function, no foreign key), so dropping it is safe.

## Privacy (what the table can and cannot hold)

Kept: an anonymous visitor id (first-party cookie `dgr_v`, set by the server), a random session id (the tab's session storage), the beacon kind, the path without its query and without identifiers
(a referral code, a UUID or a long id becomes `:code` / `:id`), the host of the referring site, a two-letter country from the hosting platform's header, the device class, the time, the seconds spent, and the account id ONLY on a sign-in row (verified by the server, never taken from the page).
Not kept anywhere: the IP address, the user agent (the class is read from it and it is dropped), a fingerprint, a query string, a request body, chat text, an e-mail address, a token.
Not tracked: the admin pages, the admin account, the API, visitors who send Do Not Track or Global Privacy Control, and bots / crawlers / link previews.

## Load

One tiny POST when a page is viewed and one when it is left. The route is public (no call to the sign-in service per beacon), answers 204 at once and writes after the answer; a slow or failing write is dropped. Per visitor session at most 40 beacons a minute and 3,000 a minute per server instance.
The admin screen reads at most 20,000 newest rows of the chosen range in pages of 1,000 (it says when a range is larger), counts accounts and requests with head counts, and reads the first request of the accounts that logged in (bounded).
No Realtime, no polling.

## Funnel and «first request»

Derived at query time by read-only joins: visitors with a view; of them, those with a sign-up row; of them, those whose account (linked by a sign-in row of the same visitor) has a row in `jobs`. A sign-up from another browser is not linked, and the screen says so.

## Retention

Not decided here. `service_role` has DELETE, so the owner can purge by hand, e.g. `DELETE FROM public.visitor_events WHERE started_at < now() - interval '13 months';` (a decision for the owner; no schedule is created).
