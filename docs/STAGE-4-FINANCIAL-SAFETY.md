# STAGE 4: financial safety round (fixes A and C, then B and the database guard)

**Status: code fixes with fake-only tests. Nothing was applied to any database, no SQL was run, no flag was set, no real money, provider or payment was touched, no live approval endpoint exists.** The money files changed are named in section 5; no price formula, no ledger function and no SQL function was changed. Every test runs the REAL production functions over fakes: the hardened money fake (`tests/helpers/agentMoney.ts`: the same arithmetic and rules as the live SQL, ledger ids unique, a refused reserve writes nothing) and a fault-injecting world (`tests/helpers/safetyWorld.ts`).

This document grows with the stack: **PR A** (this section: fixes A and C), **PR B** (the charged-but-unpublished review), **PR C** (the database guard, prepared and NOT applied).

---

## 1. Fix A: an approval never reports success it cannot prove

**Root cause.** `approveAddonOnce` (`src/lib/agentMission/addonSettlement.ts`) reserves the hold with three money calls and then records `job_id`, `quote_id` and `reserved_points` on the add-on row with one `update`. **The answer of that update was never read.** If it failed after the hold was reserved, the customer was told «approved», the row stayed `approved` with no job id, the worker ended it `failed` with «no plan or no hold» without releasing, and the hold stayed until the watchdog freed it (job lease 6 h plus the watchdog's 30 min). A second defect of the same kind: an error from `accept_quote_atomic` (which may have committed) or a refused `release_job_atomic` after a failed claim was described as «nothing was held» / «the hold came back in full».

**Fix (narrow, in the approval only).**

1. The record is written with up to **three** tries (`APPROVAL_RECORD_ATTEMPTS`), each followed by a **read-back** that must show exactly this job, this quote and this hold. The update's own answer is never trusted in either direction (an error may hide a commit, «no row» may hide a commit). The update is a compare-and-set on `approved`.
2. If the record cannot be proved, the approval is **not success**: it answers `record_unverified` (409), and puts the row back to `plan_ready` with a compare-and-set on `approved` (a row that moved on is not overwritten). The approval mark stays, so the page never says «nothing was held». The hold is kept; **the retry converges on the same quote, job and reserve** (the deterministic ids; `create_quote_atomic`, `accept_quote_atomic` and `claim_job_chunk` are idempotent). If even the revert fails, the row stays `approved` with its one-hour lease and Fix C finishes it.
3. **Honest sentences.** From `accept_quote_atomic` on, the reservation MAY exist whatever the answer was, so a returned error or a thrown call answers `approval_unverified` («the points may have been held temporarily, only what is done will be charged, retry; nothing will be held twice»). A refused or lost release after a failed claim answers the same, never «returned in full». A **definite** refusal in the body of the answer (`insufficient_balance`, `concurrency_limit`, `quote_expired`) and a failed `create_quote_atomic` (a quote reserves nothing) keep the «nothing was held» sentences, because they are certain.

**Evidence.** `tests/safety-approval-record.test.ts` (25): written first; **19 of 25 failed on the unfixed code** (commit `8c0b8765`), all pass after the fix. Shapes injected at the one update that carries `job_id`: never ran, error answer, threw, «no row», committed with an error answer, committed with a thrown answer, committed with a «no row» answer; a failing read-back; five concurrent clicks. Two Stage E tests that documented this defect as `DOCUMENTED UNRESOLVED RISK` now assert the fix, and a third records the residual (every update failing, section 4).

## 2. Fix C: abandoned approvals are recovered, never guessed

**Root cause.** A failed approval puts the row back to `plan_ready` **with** `approved_at` (money may have moved). If the job was then released (the approval's own release after a failed claim, or the watchdog's forced release), nothing ended the request: `approveAddonOnce` answered `claim_retry` for ever (the quote is accepted, its job is `failed`), `cancelUnpaidAddonRow` refuses a marked row, and `canCreateAddon` counts `plan_ready` as open: **the file was blocked for good.** (Scenario 6 of `docs/STAGE-4-CONCURRENCY.md`.)

**Fix.** Two new files, both read-only on the money tables:

- `addonMoneyState.ts`: `readJobMoneyState(client, jobId)` reads the job and its ledger rows (select only) and names the state: **`none`** (no job, no ledger row), **`active`** (queued/running, reserve matches, no release, no charge), **`released`** (failed, reserve matches, the **release row exists** with the reserve's amount, no charge), **`charged`** (completed, release and charge rows, charge = the job's charged points and within the hold), **`settled_free`**, and **`unknown`** (`read_failed` or `inconsistent`: never read as `none` or `released`).
- `addonRecovery.ts`: `recoverAbandonedAddon` does the one thing the state proves, with **one compare-and-set on the request's own row pinned to the status, job and approval mark it read**:

| State of the job | What recovery does | Request afterwards |
|---|---|---|
| never approved (no mark, no job) | nothing, reads nothing | waiting (unpaid) |
| `none`: marked, nothing reserved | nothing | waiting; the customer may approve again |
| `active` + **running** | finishes the record the approval could not write (same job, quote, hold; checked against `checkAddon`) | `approved`, the worker runs it |
| `active` + only **queued** (reserved, never claimed) | nothing | waiting; the approval's retry claims it |
| `released` (**proved by the ledger**) | **ends** it: `failed`, `charged_points` 0, `error approval_released`, the job recorded for audit, one event | ended; the file is free (the next attempt number makes a new id) |
| `charged` | **nothing**: never ended as unpaid, never cancelled | unchanged; the worker or an administrator resolves it |
| `settled_free`, `unknown`, hold mismatch | nothing (reported unresolved) | unchanged, still blocking: never freed on a guess |

It calls **no rpc at all**: it never reserves, releases, charges or refunds, so it cannot release twice or make a balance negative. A row `approved` with no job id is touched only after its one-hour lease ran out (an approval still in flight is not disturbed). Repeated and concurrent recoveries end a request once (the second compare-and-set matches nothing).

**Where it runs.** (1) **The approval's own retry**: when the quote is already accepted and the claim fails, `approveAddonOnce` reads the job state; a **proved release** ends the request and answers `released_before_start` («the hold was released in full, you can make a new request») instead of `claim_retry`. (2) **The customer's file reads**: `createAddonRow` and the two `current…Request` functions list the add-on rows through `listWithRecovery`, which recovers only when a row is an abandoned approval and otherwise performs exactly the one read it always did (so no existing step order changed). The store hook is optional: memory stores of the pure tests behave as before.

**Evidence.** `tests/safety-approval-recovery.test.ts` (30; red commit `fe951616`, 29 of 30 failed on stub modules): the six states, every row of the table, the watchdog case (`release_job_atomic` with force), idempotence under five concurrent calls, the bound of three per file, a failing database, the proof that no money function is called in any state, and the end-to-end «recover then the worker settles it once: one reserve, one release, one charge, never above the hold». `tests/stage4-concurrency-approval.test.ts` now shows the stuck request freed by the next click **and** by a page read, and a still-held request **not** freed by a page read.

**Customer sentences (all pass the customer-text check; Arabic only, no digits, no provider, no id).** Ended after release: «لم يبدأ تنفيذ هذا الطلب، والنقاط المحجوزة له حجز مؤقت مُحرَّر كاملًا. لم يُسجَّل أي خصم، ويمكنك تقديم طلب جديد.» (the owner's released-hold wording, pinned by `tests/audit-phase3-release-wording.test.ts`) The workflow status of such a row is «لم يكتمل الطلب — لم يُسجَّل أي خصم لهذا الطلب» (phase `failed_no_charge`), unchanged code of Stage C.

## 2b. Fix B: no second paid review of a version whose first review was charged and not published (PR B)

**Root cause.** A review that is charged and cannot publish its report ends `failed` with `error charged_not_published` (`agent/src/stage4/runAddon.ts`, `parkPaid` after its retries, or `recoverAddon`). `canCreateAddon` blocks on **open** statuses and reuses a **completed** review only; `failed` blocks nothing. So the customer was offered, and could approve, a second paid review of the same version. A second source: two open review requests of the same version can coexist after a database outage (scenario 5); if the first is approved, charged and fails to publish, the second is still `plan_ready` and approvable.

**Fix.** `stage4/paidReview.ts` judges earlier reviews of the version from authoritative state, not from customer-facing text:

1. **Published?** `reviews/rNNNN.json` in storage settles it: the second review is refused as «reviewed already, free» and the preview shows the stored report (`reuse`).
2. Otherwise, for each earlier review of this version that **ended** (`failed` or `unserved`), the money state of its **deterministic job** (`readJobMoneyState`, read only, the same reader as Fix C): **charged** → `unresolved`; **active** (the job still holds the points under an ended request) → `unresolved`; **unknown** (a read failed or the ledger contradicts the job) → `unresolved`, never read as free; **none / released / settled with no charge** → not charged, does not block («failed review with no charge» is allowed).

The creation (`createAddonRow` through an optional guard passed by `createReviewRequest`), the **preview** (`reviewQuoteFor`: state `unresolved`, **no price**) and the **approval guard** (`stage4/approvalGuard.ts`, below) all use it. A storage or database error **throws**, so the creation answers `unavailable` (503) and the preview answers 503: never «allowed on a guess». When there is no earlier ended review of the version, nothing is read at all, so the ordinary path performs the same reads as before.

**Customer sentence** (Arabic, passes the customer-text check, never says nothing was charged, promises no refund): «سُجّل خصم لمراجعة سابقة لهذه النسخة ولم يُنشر تقريرها بعد؛ سيراجع فريقنا الأمر.»

**What it does not touch.** No row of the first review is written (its row, job, three ledger rows and pending objects stay as they are, so the worker's own recovery of the pending report stays open). No refund is issued, no charge or reservation is created, nothing is published or marked delivered. Different versions are reviewed normally; an edit is not blocked by an unresolved review (it makes a new version); a completed review is still reused free.

**The approval guard (UNWIRED).** `guardApproval(client, {id, userId})` is what the planned approval route must pass **before** the approval function: owner check, `plan_ready`, `reconcileOpenAddons` (only the request that stays may start: a started request first, then the lowest id), a completed review or a published report → «free reuse», and the paid-review verdict → «unresolved». It decides nothing about money and **no route calls it**; the approval route stays **BLOCKED FOR OWNER APPROVAL**.

**What an administrator does with an `unresolved` review** (not built): publish the stored report (then step 1 applies and the customer sees it free) or resolve the charge by hand. Until then the version cannot be paid-reviewed again. **Owner decision:** how an administrator marks such a review resolved without a published report (for example a refund recorded by hand plus a row marker).

**Evidence.** `tests/safety-paid-review.test.ts` (22; red commit `ca558683`, 15 failed on the unfixed code): the exact scenario, judged by the money state and not the row's words, a held or unprovable state, a published report, storage down then restored, a database error, different versions, completed reuse, an edit, every order of two concurrent creators (same and different versions), repeated and concurrent guard calls, the guard next to a started request. `tests/safety-mutations-paid-review.test.ts` (6) removes the charged branch, the unknown branch, the storage check, the creation guard, the verdict check of the approval guard and the «this request stays» check, and shows each property break.

## 3. Mutation tests

`tests/safety-mutations-approval.test.ts` (10) removes ONE protection from a copy of the source (`tests/helpers/mutants.ts`: an exact edit that must match once, imports pointed at the original files, copies deleted after) and runs the scenario the protection exists for; the property must break: without the record check or the read-back the approval reports success with no job on the row; with 50 tries the database is asked 50 times; without the uncertain sentence the customer is told «nothing was deducted» while a reserve exists; without the proof of the release a refused release is reported as returned; a failed job without its release row is read as released; a charged job ended as unpaid; without the compare-and-set pin concurrent recoveries end the request repeatedly; without the in-flight guard a live approval is touched; a recovery that called a money function shows in the rpc log.

## 4. Residual risks (stated, not fixed)

1. **A database that is down for every write after the claim** leaves the row `approved` with its one-hour lease and no job id and the hold reserved; nothing can be recorded or reverted. The approval is **not** reported ok. After the lease the recovery finishes the record if the database answers; if the worker claims the row first it ends it `failed` («no hold») **without** releasing, and the hold waits for the watchdog (lease 6 h + 30 min). Closing this needs a change in the worker (`agent/src/stage4/runAddon.ts`: derive the deterministic job when the row has none) and is **not** made here.
2. **A request whose job is `active` but only queued** is left for the approval's retry; until then it blocks the file (honest: the hold exists). There is no live approval route yet.
3. **`unknown` states** (a read failed, the ledger contradicts the job) are left blocking on purpose; they need a person.
4. **A customer who never returns** after a `none` state keeps an open waiting request that blocks the file; whether unpaid requests expire is an owner decision (D-expiry).
5. Real SQL, real PostgREST error bodies and the live watchdog were **not** exercised (fakes only).

## 5. Protected code touched (the complete list)

| File | Change |
|---|---|
| `src/lib/agentMission/addonSettlement.ts` | `approveAddonOnce`: proved record (`recordApproval`), stage-aware failure sentences, a proved release before «returned», the released branch of the retry; new messages `approval_unverified`, `record_unverified`, `released_before_start`; new `releasedRowPatch`, `ADDON_RELEASED_*`. **No pricing, no ledger id, no rpc name, no `settleAddon` change.** |
| `src/lib/agentMission/addonMoneyState.ts` (new) | read-only reader, imports nothing |
| `src/lib/agentMission/addonRecovery.ts` (new) | compare-and-set on the request's own row; no rpc |
| `stage4/addonRow.ts`, `addonRowStore.ts`, `reviewRequest.ts`, `editRequest.ts` | `lease_until` read, optional store hook, `listWithRecovery`; PR B: optional `paidReviewGuard` in `createAddonRow`, the `review_unresolved` sentence |
| `stage4/paidReview.ts`, `stage4/approvalGuard.ts` (new, PR B) | read only (storage list, money state); the guard is UNWIRED |
| `stage4/reviewPreview.ts`, `reviewPreviewLabels.ts`, `reviewPreviewClient.ts`, `reviewRequestLabels.ts`, `reviewRequestClient.ts` (PR B) | the `unresolved` preview state and the refusal code |

`approval.ts` (ordinary missions), `lifecycle.ts`, the watchdog route and every SQL function are **unchanged**; the ordinary mission approval tests pass unchanged.
