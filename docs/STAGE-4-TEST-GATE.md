# Stage 4 test-account gate (launch round, 5 Nov 2026)

Purpose: test the Stage 4 customer routes (versions, review, edits, **financial approval**) on explicitly authorized test accounts WITHOUT exposing approval to every customer.

## Values of each Stage 4 site flag (`DIGER_STAGE4_VERSIONS|REVIEW|EDITS|APPROVAL`)

| Value | Site routes serve | Changed by this PR? |
|---|---|---|
| unset / empty / `off` / `test` / any other word | nobody (404 before the id, viewer or database is looked at) | **no** (every existing test of this rule still passes) |
| `on` | every customer | **no** |
| `allowlist` (new) | ONLY a signed-in, non-guest, e-mail-verified customer whose **user id** is in `DIGER_STAGE4_TEST_USER_IDS` | new |

(`test` is still read by the worker for the read-only version-1 write; it is not a site mode. See «Worker flag» below.)

## What decides «authorized»
1. The sign-in service's immutable `user.id`, from the verified token (`resolveMissionViewer`).
2. Membership in the **server-only** env var `DIGER_STAGE4_TEST_USER_IDS` (comma/space separated UUIDs). Empty, missing, wildcard, e-mail or non-UUID entries authorize **nobody**.
3. Verified e-mail by the service's own confirmation (PR #419) and not a guest.

Never read: `user_metadata`, e-mail address or domain, headers, query, cookies, request body, any customer-writable column.

## Worker (Heroku) flag: important
The worker does not know `allowlist` (it maps it to OFF, by design: worker logic is unchanged). Its only Stage 4 flag is `DIGER_STAGE4_VERSIONS`, which makes it write the READ-ONLY version-1 file after a delivery. For gated testing set it on the **worker** to `on` (or `test`, which limits the write to the worker's own test-account list): the write is a storage object only; WHO may list, download, review, edit or approve is decided by the site's gate. If the worker has it unset, no version 1 is written and the site routes have nothing to serve. Add-on execution by the worker is not flag-gated (a hold is always run to its end) and is reachable only after a gated approval.

## Not revealed to the browser
No `NEXT_PUBLIC_` twin. Only `testGate.ts` reads the variable; it is imported only by API routes and server libs (pinned by `tests/stage4-test-gate.test.ts`, which also scans for a client import). A refused request gets the same plain 404 as a feature that is OFF (unauthenticated, guest, unverified, not listed alike); panels draw nothing on 404.

## Operating it (owner/infra, after the worker + migration + prechecks are verified; nothing is set by this PR)
Vercel env (server, Production): `DIGER_STAGE4_TEST_USER_IDS=<uuid of the approved test account>`, then the flags in the order of `docs/launch/LAUNCH-CHECKLIST.md` §5 with value `allowlist` (not `on`). Rollback: unset the flags.

## Tests
`tests/stage4-test-gate.test.ts` (22: parsing, route behaviour for OFF/on/allowlist, forged flags, guest/unverified/unauthenticated, ownership, all 8 routes, no leak to the browser) and `tests/stage4-test-gate-mutations.test.ts` (8: guest check, verified check, membership, empty-list-means-everybody, UUID filter, mode check; on copies of the source).
