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

**Where it runs.** (1) **The approval's own retry**: when the quote is already accepted and the claim fails, `approveAddonOnce` reads the job state; a **proved release** ends the request and answers `released_before_start` («the points came back, you can make a new request») instead of `claim_retry`. (2) **The customer's file reads**: `createAddonRow` and the two `current…Request` functions list the add-on rows through `listWithRecovery`, which recovers only when a row is an abandoned approval and otherwise performs exactly the one read it always did (so no existing step order changed). The store hook is optional: memory stores of the pure tests behave as before.

**Evidence.** `tests/safety-approval-recovery.test.ts` (30; red commit `fe951616`, 29 of 30 failed on stub modules): the six states, every row of the table, the watchdog case (`release_job_atomic` with force), idempotence under five concurrent calls, the bound of three per file, a failing database, the proof that no money function is called in any state, and the end-to-end «recover then the worker settles it once: one reserve, one release, one charge, never above the hold». `tests/stage4-concurrency-approval.test.ts` now shows the stuck request freed by the next click **and** by a page read, and a still-held request **not** freed by a page read.

**Customer sentences (all pass the customer-text check; Arabic only, no digits, no provider, no id).** Ended after release: «لم يبدأ تنفيذ هذا الطلب، وعادت النقاط التي حُجزت له إلى رصيدك كاملة. لم يُسجَّل أي خصم، ويمكنك تقديم طلب جديد.» The workflow status of such a row is «لم يكتمل الطلب — لم يُسجَّل أي خصم لهذا الطلب» (phase `failed_no_charge`), unchanged code of Stage C.

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
| `stage4/addonRow.ts`, `addonRowStore.ts`, `reviewRequest.ts`, `editRequest.ts` | `lease_until` read, optional store hook, `listWithRecovery` |

`approval.ts` (ordinary missions), `lifecycle.ts`, the watchdog route and every SQL function are **unchanged**; the ordinary mission approval tests pass unchanged.
