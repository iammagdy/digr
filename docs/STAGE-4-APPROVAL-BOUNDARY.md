# STAGE D: the financial approval boundary (BLOCKED FOR OWNER APPROVAL)

**Decision.** The customer's approval of a displayed price (a review or an edit) is **not wired in this stack and must not be wired without the owner's explicit approval.** Approving moves real money: it reserves points through the existing money functions. This stage changed no money file, no SQL, no wallet code, no flag and no environment variable, exposes no money-moving route, and ran no live transaction. It adds a design, the contract the missing route must keep, and fake-only characterization tests (`tests/stage4-approval-boundary.test.ts`, 17 tests, the hardened money fake only).

> Nothing in the Stage A to D PRs is "payment complete". Everything the customer can do today ends at an **unpaid, waiting** request. UI and mock tests passing is not evidence that payment or delivery works.

## 1. What already exists (isolated, unwired)

`approveAddonOnce(client, { id, actorId, expectUserId })` in `src/lib/agentMission/addonSettlement.ts` (referenced by no route, component or worker file: a test scans the source). It: reads the row (add-on, `plan_ready`, the user's own); prices it again by code (`checkAddon`; a stored price that is not the code's is refused with nothing written); claims `plan_ready -> approved` with a compare-and-set; calls `create_quote_atomic` (id `quote_addon_<id>`), `accept_quote_atomic` (`res_<job>`, balance check, two-active-jobs limit, 5,000-point limit) and `claim_job_chunk`; records job, quote and reserve on the row; and on any failure puts the row back to `plan_ready` (an expired quote ends it `cancelled`). The ids are deterministic, so a double click or a retry converges on the same quote, job and ledger rows. The worker side (`runAddon`, dispatched by `agent/src/stage4/dispatch.ts`) runs an approved add-on and settles it with `settleAddon` (release first, then charge, never above the hold), publishing only after the charge.

## 2. What this stage proves (fake money core, rows made by the real Stage A to B creation code)

| Fact | Test |
|---|---|
| The hold reserved at approval equals the price the customer was shown (`review`, rename, correct cells, add items): `res_<job> = -(hold shown)`; nothing else moves | "the price the customer was shown is exactly what an approval would reserve" |
| Creating a request is free: no ledger row, job, quote or rpc exists before approval | "before approval there is no ledger row..." |
| For a typed edit the estimate, the maximum hold and the charge are all 100 points (no provider cost exists) | "the estimate shown, the most that may be held and the charge..." |
| A settled typed edit is charged 100, never above the hold, never a negative balance, once (a second settlement writes nothing); a review is charged its exact hold when its report is stored and released whole when it is not | "settling an approved typed edit" |
| A balance below the shown hold is refused before anything is written; the row stays `plan_ready` | same |
| A stored price that is not the code's, or a stranger's request, is refused with nothing written | "it never creates, cancels or reads..." |
| No production file references `approveAddonOnce` except its own; no Stage 4 route contains an approval or money function; no Stage 4 component or client sends an approval | "the boundary in the source" |

## 3. What the approval path does NOT do (documented findings, tests show them as they are)

1. **It does not check that no other add-on of the file is open.** The "one open request per file" rule lives only in the creation protocol (`createAddonRow` / `reconcileOpenAddons`), which is a protocol over ordinary reads and writes, not a database constraint. With two unpaid rows on one file, both can be approved (two jobs, two reserves). The approval route **must** run `reconcileOpenAddons` for the file first and refuse unless the row being approved is the one that stays (Stage E, `docs/STAGE-4-CONCURRENCY.md`, decides whether a database constraint is also required).
2. **It does not check that the kind can be run.** A hand-written add-on that needs a lookup (a new column with no recipe) would be held; the worker would fill nothing and release it whole (no charge). The Stage B creation code never produces such a row, so the route must approve only rows that module made (and must treat any other shape as "not ready").

## 4. The endpoint contract the missing route must keep (DESIGN ONLY: not implemented)

`POST /api/missions/[id]/addon-approval`, body `{ requestId, expectedPoints }` and nothing else.

1. Flag (`DIGER_STAGE4_REVIEW` for a review, `DIGER_STAGE4_EDITS` for an edit) read FIRST; off is a 404 before anything is looked at.
2. Authenticate the customer on the server; the request must be theirs and for this file (404, one body, otherwise).
3. `expectedPoints` must equal the hold the page showed (the card recomputed by code from the stored request), else 409 before anything is read for money (the pattern of the methodology route's `expectedPoints`). The browser never sends a price that is used.
4. Run `reconcileOpenAddons`; refuse unless this row is the keeper and `isUnpaidAddonRow` (never a started row).
5. Call `approveAddonOnce` with `expectUserId`. Map its results to the existing Arabic messages (`ADDON_APPROVE_MESSAGES_AR`).
6. **Lost answer.** The browser never assumes the outcome of an approval it did not hear back from: it re-reads the file's workflow status (Stage C), which says `processing` (hold known only when the row has a job), `approval_unverified` (money may have moved), or still `waiting`. The page already refuses to say "nothing was held" after an attempt.
7. Never display success before successful publication (Stage C: only `delivered` says so, and only when the output is verified in storage).

## 5. The read-only UI states that already explain approval (Stage C)

Waiting for approval, approval unverified, approved and processing, delivered, charged but delivery pending, failed without a recorded charge, cancelled, closed after an attempt. They are modelled and tested; with no approval route only *waiting* and *cancelled* can occur.

## 6. The minimal protected changes needed (each needs the owner)

| # | Change | Why protected |
|---|---|---|
| 1 | The approval route above (a new file calling `approveAddonOnce`) | it moves money |
| 2 | Deploy and verify the Heroku worker with the add-on dispatch (`runAddon`) and its env | production infrastructure |
| 3 | Wallet history label for add-on jobs (decision D9) in `src/app/api/wallet/history/route.ts` | ledger display (money file area) |
| 4 | The watchdog's release of a cancelled add-on whose approval was interrupted (docs/MONEY-PR-7A.md section 12.4) | money release path |
| 5 | A database-level guarantee of "one open add-on per file" (Stage E) | a migration under `supabase/**` |
| 6 | Decision: does an unpaid add-on request expire (today `expiry.ts` ignores it)? the customer's notice words | product + money wording |
| 7 | Optional choke point: a one-line guard in `approval.ts` | money file |
| 8 | The live check of docs/MONEY-PR-7A.md section 8 with `test` flags on a test account | a live run |

## 7. Do not turn the flags on yet

With `DIGER_STAGE4_REVIEW` / `DIGER_STAGE4_EDITS` on, a customer could prepare a request that nothing can approve. Keep every Stage 4 flag OFF until items 1, 2, 4 and 5 are decided and done.
