# STAGE D: the financial approval boundary (BLOCKED FOR OWNER APPROVAL) - revised by the financial safety round

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

## 3. What the approval function does NOT do, and who does it instead (revised by the safety round)

`approveAddonOnce` itself still **does not look at other add-ons of the file** and **does not check that the kind can be run**; that is by design (it is the money core). The safety round added the missing checks as a **separate, read-only, UNWIRED guard** (`src/lib/agentMission/stage4/approvalGuard.ts`, `guardApproval`) that the planned route MUST pass first, and fixed the three money-state defects the earlier version of this document listed or found (`docs/STAGE-4-FINANCIAL-SAFETY.md`):

| Earlier finding | Status now |
|---|---|
| The last update of the approval was not checked (a hold with no job recorded, told «approved») | **Fixed (Fix A):** 3 bounded tries each proved by a read-back; an unproved record is not success; uncertain outcomes say the points may be held |
| A stuck request after the watchdog released its job (not cancellable, `claim_retry` for ever, file blocked) | **Fixed (Fix C):** a proved release ends the request (`failed`, no charge); the customer's file reads recover it; a still-held or charged request is never ended |
| A charged-but-unpublished review did not block a second paid review | **Fixed (Fix B):** judged by the job's money state and the published report; creation, preview and the guard refuse |
| Two open requests after a database outage are both approvable | **Guard + prepared index:** `guardApproval` runs `reconcileOpenAddons` and refuses unless this request stays; the index (`supabase/migrations/20261104222136_one_open_addon_per_file.sql`, **NOT applied**) makes the end state impossible in the database |
| The approval does not check that the kind can be run | Unchanged by design: the route must approve only rows made by the Stage A/B creation code (the guard recomputes the price and checks the file, which any other shape fails) |

## 4. The endpoint contract the missing route must keep (DESIGN ONLY: not implemented; every item below is exercised in `tests/safety-approval-contract.test.ts` by a composition that lives in the TEST file only)

`POST /api/missions/[id]/addon-approval`, body `{ requestId, expectedPoints }` and nothing else.

| # | Contract item | Where it is enforced / tested |
|---|---|---|
| 1 | Flag (`DIGER_STAGE4_REVIEW` for a review, `DIGER_STAGE4_EDITS` for an edit) read FIRST; off is a 404 before anything is looked at | route (not built); the flag helpers exist (`stage4FlagMode`) |
| 2 | Authenticate the customer on the server; the request must be theirs and an add-on of this file (404, one body, otherwise) | `guardApproval` (owner check, not an add-on, missing: one `not_found`) |
| 3 | The selected version must be PUBLISHED in storage and the customer's own; an edit or a fix must still be on the latest version; a review's stored cell count must be the file's | `guardApproval` (`version_changed`) |
| 4 | **The price is recalculated on the server**: the stored plan must be what the code computes (identity, price again, the 5,000-point limit) | `guardApproval` then `approveAddonOnce` again (`price_mismatch`, `plan_changed`) |
| 5 | **`expectedPoints` must equal that hold**, else 409 before any money function; the browser's number is only compared, never used | `guardApproval` (`price_mismatch`) |
| 6 | Run `reconcileOpenAddons`; refuse unless this request is the one that stays (a started request outranks) | `guardApproval` (`open_addon`) |
| 7 | Refuse a second review when a review of the version is completed or its report is published (free reuse), and refuse while an earlier review of the version is **charged and unresolved** | `guardApproval` (`review_exists`, `review_unresolved`) |
| 8 | Call `approveAddonOnce` with `expectUserId`; map its results to `ADDON_APPROVE_MESSAGES_AR` (now including `approval_unverified`, `record_unverified`, `released_before_start`) | route (not built) |
| 9 | Only the three existing money functions are called, in order (`create_quote_atomic`, `accept_quote_atomic`, `claim_job_chunk`); no provider | tested |
| 10 | **Double clicks:** five clicks at once give exactly one approval and one reserve | tested |
| 11 | **Lost answers:** the browser re-reads the Stage C workflow status (`approval_unverified` is shown, never «nothing was held»); a retry converges on the same quote, job and reserve | tested; Fix A and Fix C |
| 12 | **Consent before any reservation:** creating a request, reading the page, the price preview and the guard itself call no money function; the ledger holds only the top-up until the explicit approval | tested |
| 13 | Never display success before successful publication (Stage C: only `delivered` says so, and only when the output is verified in storage) | Stage C tests |

## 5. The read-only UI states that already explain approval (Stage C)

Waiting for approval, approval unverified, approved and processing, delivered, charged but delivery pending, failed without a recorded charge (now also the state of a request ended by Fix C), cancelled, closed after an attempt. They are modelled and tested; with no approval route only *waiting* and *cancelled* can occur.

## 6. The protected changes still needed (each needs the owner; NOTHING here was activated)

| # | Change | Why protected |
|---|---|---|
| 1 | The approval route above (a new file calling the guard, then `approveAddonOnce`) | it moves money |
| 2 | Deploy and verify the Heroku worker with the add-on dispatch (`runAddon`) and its env | production infrastructure |
| 3 | Wallet history label for add-on jobs (decision D9) in `src/app/api/wallet/history/route.ts` | ledger display (money file area) |
| 4 | The watchdog's release of a cancelled add-on whose approval was interrupted (docs/MONEY-PR-7A.md section 12.4); the worker's «no hold» path (it ends a row without releasing: `docs/STAGE-4-FINANCIAL-SAFETY.md` section 4, residual 1) | money release path / worker |
| 5 | **Apply the prepared migration** (checks first; section 5.7 of the safety document) | a migration under `supabase/**` applied to a real database |
| 6 | Decisions: does an unpaid add-on request expire (today `expiry.ts` ignores it)? how does an administrator mark a charged-unpublished review resolved? the customer's notice words | product + money wording |
| 7 | Optional choke point: a one-line guard in `approval.ts` | money file |
| 8 | The live check of docs/MONEY-PR-7A.md section 8 with `test` flags on a test account | a live run |

## 7. Do not turn the flags on yet

With `DIGER_STAGE4_REVIEW` / `DIGER_STAGE4_EDITS` on, a customer could prepare a request that nothing can approve. Keep every Stage 4 flag OFF until items 1, 2, 4 and 5 are decided and done. **Nothing in this stack is "payment complete"**: fake-only tests passing is not evidence that payment or delivery works.
