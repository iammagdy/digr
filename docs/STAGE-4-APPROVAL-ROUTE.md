# STAGE 4: THE CUSTOMER APPROVAL ROUTE (launch round, workstream 2) - DRAFT, flag OFF

`POST /api/missions/[id]/addon-approval` lets a customer approve the price of a **review** or an **edit** of a delivered file. It is the one production caller of `guardApproval` and `approveAddonOnce`, which were built and tested in the safety rounds but unwired (`docs/STAGE-4-APPROVAL-BOUNDARY.md`). **It edits no money file, no SQL, no wallet code, no worker file.** It moves no money by itself; it composes two tested functions in the order the contract requires. Nothing here was activated, deployed or run against a real database, provider or wallet.

## 1. What the route does, in order (`src/lib/agentMission/stage4/approvalRoute.ts`)

| # | Step | Refusal | Money touched? |
|---|---|---|---|
| 0 | `DIGER_STAGE4_APPROVAL` is exactly `on` (read first by the route: before the id, the viewer, the body or the database) | 404 | no |
| 1 | the viewer is a signed-in customer: a guest signs up (401), an unverified account verifies its e-mail (403): the same gates as approving a mission | 401 / 403 | no |
| 2 | body is exactly `{ requestId, expectedPoints }` (any other key, a float, a string, 0, negative, above 5,000, an unsafe id: 400) | 400 | no |
| 3 | the request is this customer's, an add-on of THIS file (the URL's mission), of a kind that can run (`review`, `edit`; a `review_fix` is not offered), and that kind's flag (`DIGER_STAGE4_REVIEW` / `DIGER_STAGE4_EDITS`) is on: one «not found» for every other case | 404 | no |
| 4 | already `approved` / `executing` / `completed`: «already approved» (409), no money function attempted | 409 | no |
| 5 | `guardApproval`: published version, price recalculated by code and equal to `expectedPoints`, one open add-on per file (with the repair of UNPAID duplicates), no second paid review | 404/409/503 | no |
| 6 | `approveAddonOnce`: price again, compare-and-set `plan_ready -> approved`, then `create_quote_atomic`, `accept_quote_atomic`, `claim_job_chunk` with deterministic ids | 402/409 | **only here** |

Answers: `{ success, state: approved | already_approved | refused | uncertain, error?, code?, kind?, holdPoints? }`. The lost-answer family (`approval_unverified`, `record_unverified`, `claim_retry`, an exception) is `uncertain`: the words say the points MAY be held and the page re-reads the request's status; it never says «nothing was held». No job id, quote id, ledger id, provider or USD is returned.

`GET` answers `{ available: true }` (404 while off) so the page can decide whether to draw a button.

## 2. Contract checklist (docs/STAGE-4-APPROVAL-BOUNDARY.md section 4 and the launch brief)

| Requirement | Where it holds | Evidence |
|---|---|---|
| Quote calculated and validated on the server; the browser's number is only compared | `guardApproval` + `approveAddonOnce` (twice) | `tests/launch-approval-route.test.ts` section 5 (wrong prices 1, 99, 101, 5000; tampered stored price) |
| Customer approves explicitly before any reservation | nothing before step 6 calls a money function | sections 1-5 assert `out.money.calls == []`; creating requests and reading the page move nothing (`safety-approval-contract`) |
| No duplicate holds or charges; stable deterministic ids | `addonId`, `quote_addon_<id>`, `job_quote_<md5>`, `res_/rel_/chg_<job>` | five concurrent clicks: one 200, one reserve, unique ledger ids |
| Reservation never exceeds the authorised quote; charge never exceeds the reservation | hold == code price == `expectedPoints`; DB `LEAST(charge, reserve)` + `addonChargePoints` | section 5; `money7a-charge`, `money7a-settlement` (unchanged) |
| No negative balance | `accept_quote_atomic` balance check | section 6 (below the hold: 402, nothing reserved; exactly the hold: balance 0) |
| Release-first settlement | worker's `settleAddon` (unchanged) | `money7a-settlement` |
| Failed or uncertain approvals are recoverable | revert to `plan_ready`; `recoverAbandonedAddon` | section 7 (lost answer: `uncertain`, retry converges, ONE reserve) |
| Charged but unpublished reports cannot be charged again | `paidReviewVerdict` in the guard | `safety-paid-review` (unchanged) |
| Recovery never guesses | `readJobMoneyState` | `safety-approval-recovery` (unchanged) |
| Original files immutable; edits publish new versions | `editVersion`, create-only objects | `stage4-versions`, `stage4-edit-*` (unchanged) |
| Truthful statuses | Stage C workflow phases | `stage4-file-workflow` (unchanged) |

Mutation checks run on the new function (a removed check must fail a test): no mission-of-file check, no kind flag, no guard, no guest gate, `uncertain` demoted to `refused`: each fails at least one test. (A mutation that removes only the redundant `keys.length !== 2` survives by design: the per-key and type checks already refuse every bad body.)

## 3. Risk analysis

| Risk | Control | Residual |
|---|---|---|
| The route is reachable before the owner approves | `DIGER_STAGE4_APPROVAL` off by default (unset, empty or any value but `on` is off); the guard flags of the kind are also required | none while the flags are unset |
| A customer approves another customer's or another file's request | ownership and `addon.of === URL mission` checked before the guard; one 404 for all | none found |
| Price tampering (body, stored plan) | server recomputes; `expectedPoints` compared only | none found |
| Double click / two tabs / retry | compare-and-set claim; deterministic ids; «already approved» short-circuit | a DB outage can leave two open requests: guarded by `reconcileOpenAddons`; the prepared unique index (NOT applied) makes it impossible |
| A lost answer after the hold | `uncertain` + deterministic retry + abandoned-approval recovery | the worker's «no hold» path and the watchdog's release of an interrupted approval remain as documented in `STAGE-4-FINANCIAL-SAFETY.md` section 4 (owner items) |
| **Customer-side flags have no test-account mode** | Stage 4 customer routes serve only `on` (customer code never imports the test-account list). A real-money pilot therefore needs `on`, which is for EVERY customer | **OWNER DECISION**: either run the pilot with `on` for a short, supervised window, or approve a server-side test-account gate for this route (a ~10-line change in `approvalAvailable`, importing `isTestAccount`) |
| The worker is not deployed with the add-on dispatch | not checked here (no Heroku access) | **OWNER/INFRA**: deploy and verify the worker at the exact SHA before any approval is allowed |
| The one-open-add-on unique index is not applied in production | guard + reconcile cover it in code | **OWNER**: apply after review (see the migration verification) |

## 4. What this PR does NOT include

The customer's approval **button** (separate draft PR on top of this one). Applying any SQL, deploying the worker, setting any flag, a live-money test, the wallet-history label (decision D9), the `approval.ts` choke point.

## 5. Enabling (owner, later, in this order, each step reversible by unsetting the variable)

1. Worker at this stack's SHA deployed and checked; migration applied (separate approval).
2. `DIGER_STAGE4_VERSIONS`, `DIGER_STAGE4_REVIEW`, `DIGER_STAGE4_EDITS` `on` (read-only surfaces and unpaid requests).
3. `DIGER_STAGE4_APPROVAL=on` on a bounded pilot: one test account, one review (about 100 points), one edit, balances read before and after.
4. Roll back: unset `DIGER_STAGE4_APPROVAL` (the button disappears and the route answers 404; a hold already made is always run to its end by the worker).

## 6. The customer's approval button (this PR, on top of the route PR)

`src/components/mission/ApproveAddon.tsx` + `src/lib/agentMission/stage4/addonApprovalClient.ts`, drawn under a WAITING review request (`ReviewQuote`) and a WAITING edit request (`EditRequestCard`) and nowhere else.

- **Off means invisible.** On mount it asks `GET /api/missions/[id]/addon-approval`; any answer but `{success:true, available:true}` (404 while `DIGER_STAGE4_APPROVAL` is off, signed out, an outage, a malformed answer, a lost connection) draws NOTHING. The cards' default markup is byte-for-byte unchanged without the button (tested).
- **Consent is explicit.** One sentence (what approving does: the points are held, only what is delivered is charged, the rest returns) and one button «اعتمد الطلب واحجز N نقطة» whose N is the price the card already shows. Nothing is held before the click.
- **The browser sends two fields**: `{ requestId, expectedPoints }` (the hold shown). The server recomputes and compares.
- **One click, one request**: the button is disabled while the request is in flight (and the server is idempotent as well).
- **Truthful outcomes**: approved → «اعتُمد الطلب وحُجزت النقاط؛ يبدأ التنفيذ الآن»; a second click → «اعتُمد بالفعل»; a refusal → the server's own sentence (it says nothing was held only where that is true); a lost answer, a gateway error or an unreadable reply → «قد تكون نقاطك حُجزت مؤقتًا» (never «nothing was held»), and the button stays so a retry converges on the same hold.
- **After any answer** the file's status panel (`FileWorkflow`) and the waiting request are re-read from the server (window event `diger:file-workflow-refresh`): the page shows the server's truth, not the browser's guess.

Tests: `tests/launch-approval-button.test.tsx` (21).
