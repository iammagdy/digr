# STAGE 4: the customer's review-and-edit workflow, remaining safe work (Stages A to F)

Stack (each PR targets its immediate predecessor; every one is a DRAFT; nothing is merged, no flag is set, nothing is deployed):

| Stage | Branch | Targets | What |
|---|---|---|---|
| (existing) | `money/7e-addon-isolation` (#388) | `money/7d-review-request` | the stack head this work starts from, `bf649517` |
| A | `stage-4/a-review-report` (#389) | `money/7e-addon-isolation` | the customer's review report |
| B | `stage-4/b-edit-requests` (#390) | `stage-4/a-review-report` | the customer's edit request before payment |
| C | `stage-4/c-file-workflow` (#391) | `stage-4/b-edit-requests` | one understandable file page: the truthful status of every request |
| D | `stage-4/d-approval-boundary` (#392) | `stage-4/c-file-workflow` | the financial approval boundary: design, contract, fake-only tests (approval NOT wired) |
| E | `stage-4/e-concurrency` (#393) | `stage-4/d-approval-boundary` | concurrency and database safety: analysis and fake tests (index: owner approval required) |
| F | `stage-4/f-e2e-tests` | `stage-4/e-concurrency` | end-to-end regression flows 1 to 10, fake-only, plus this integration section |

All flags stay OFF (`DIGER_STAGE4_VERSIONS`, `DIGER_STAGE4_REVIEW`, `DIGER_STAGE4_EDITS`). No file under `supabase/**` and no existing money file is edited.

---

## A. The review report viewer (`DIGER_STAGE4_REVIEW`)

**What the customer sees.** On the request's own page, under the review section, «نتيجة مراجعة الملف»: which version was reviewed, the score out of 100, the cells checked, the items reviewed, and every issue the automated checks found, each with the review engine's own Arabic sentence (correct for the count). It always says what the score is: «هذه الدرجة تقيس الفحوصات الآلية فقط ... ولا تقيس صحة المعلومات ولا دقة البحث نفسه.» Whenever the score is 100 it adds: «الدرجة ١٠٠ تعني أن الفحوصات الآلية لم تجد مشكلة، ولا تعني أن كل البيانات صحيحة.» A report that already exists is shown again free of charge; showing it creates no add-on row and no request. «الصفوف» is a word the customer-text rules forbid, so the items of the file are «العناصر».

**The route** `GET /api/missions/[id]/review-report` (`DIGER_STAGE4_REVIEW` must be exactly `on`, read FIRST; off is a 404 before the id, the viewer or the database is looked at):

| Request | Answer |
|---|---|
| `?version=N` | 200 `{ report: { version, reason, score, cells, rowsReviewed, reviewedAt, issues: [{ code, sheet, column, count, textAr }] } }` |
| (no version) | 200 `{ versions: [N, ...] }`, the versions that have a published report |
| bad id, `version` repeated or not one positive whole ASCII number | 400 |
| not signed in | 401 |
| the mission is not the caller's / does not exist; the version or its report is not published (a pending report is not) | 404, one body for all |
| the storage or the database could not answer | 503 (never «missing», never a guessed score) |
| the stored version or report is not exactly what it claims to be | 500 `damaged`, never shown |

**What "checked" means** (`reviewReport.ts`, `checkReviewReport`). The server reads `reviews/rNNNN.json` only after `readPublishedVersion` proved the reviewed version is the customer's own, published and intact (its digest matches its own sheets). The report is shown only if: its mission id and version number are this mission's and this version's; its `baseDigest` equals the digest of the version as stored NOW; its `cells` and `rowsReviewed` equal that version's; its score is a whole number from 0 to 100; every issue names a real code, a real sheet, a real readable column of that sheet (a duplicate is reported against its sheet), a count between 1 and the sheet's size, and real, unique item ids of that sheet (at most 20); no finding is repeated; and the score lies between the score the biggest single finding would give and the score all findings together would give (a stated gap counts for nothing, a duplicate counts every readable cell of its item). A score of 100 with a fault, or below 100 with none, is refused. No score is ever invented or repaired.

**What the customer never receives:** a storage path, an add-on id, an item id, a digest.

**Limit of the check (honest).** The check proves the report belongs to this exact version and is internally consistent. It does not re-run the review engine: re-running would mark every older report "damaged" the day the engine's wording or rules change. The worker (service role) is the only writer of `reviews/`.

**Files.** New: `reviewReport.ts` (server), `reviewReportLabels.ts` and `reviewReportClient.ts` (client-safe), the route, `components/mission/ReviewReport.tsx`, tests `stage4-review-report.test.ts` (server, 31) and `stage4-review-report-ui.test.ts` (words, component, client, 21). Changed: the request page (one line and an import), and three guard tests with explicit, commented entries (`stage4-isolation`: the route and the component are wiring that reads the flag first; `money7e-isolation`: the report module reads the delivered mission's own row; `money7a-isolation`: a new section proving the report modules are read-only and reach no card, quote, money file or `agent/` code).

**Not verified.** Everything ran on fakes (a fake bucket with the real `reviewFile` output, a fake table, fake auth). No real storage listing, no real browser, no Vercel build of this branch.


---

## B. The customer's edit request, before payment (`DIGER_STAGE4_EDITS`)

**What the customer can do.** On the request's own page, «تعديل الملف»: pick a kind of change on the LATEST version, fill a small form, press «احسب تكلفة التعديل», and read: which version is edited, what will change, what the request covers, the estimated charge in points, the most that may be reserved, that the original stays unchanged, that no item is deleted, and that **nothing has been held or charged before approval**. «تجهيز طلب التعديل» then makes a request that WAITS (an unpaid `plan_ready` row); after a refresh the page finds it again; «إلغاء الطلب» cancels it while it is unpaid. There is **no approval button and no price field**: the browser sends what the customer typed and formats what the server answered.

**What is offered (the contracts of `EditIntent`, as the worker can carry them out with no provider call):**

| Kind | Input | Price |
|---|---|---|
| Rename a column | sheet, column, new title | `editCard({ kind: "edit", units: 1, tools: [] })` |
| Correct selected cells | up to 100 cells: item number in its sheet, column, a value the customer TYPED (a real value; empty and stated gaps are refused) | the same card, `units` = cells |
| Add items | up to 50 items, every readable column filled with a real value (ids are made by the server: `add_v<new version>_<n>`; nothing is invented and no «لم يكتمل البحث» is written for something nobody searched) | the same card, `units` = items |

**What is NOT offered, and says so (state `unsupported`, no price, nothing created):**

- **Add a column**, **correct a cell by search** and **a correction from a review issue** all need a NEW LOOKUP of values. Nothing in the repository produces a re-read recipe from a customer's words, and no lookup price is known (docs/MONEY-PR-7A.md section 13.2 item 2 and section 13.4: "the card step of 2B-2"). The rule is to refuse to quote rather than guess, so the answer is «unsupported / lookup_needed». For a review fix the issue is still recomputed by code from the WHOLE version (`reviewFile` with every row id), so the answer says how many cells it would cover, and an issue the review does not have is refused. A duplicate is never "fixed": rows are never removed («duplicates»).
- **Removing items**: never offered (`row_removal_not_offered`, in the quote, the creation and the engine).
- Anything else is `unknown_edit`.

**Server rules.** The browser sends `{ action, version, edit }` (or `{ action: "cancel", requestId }`) and nothing else: any other key, in the body or inside the edit, is a 400. An item is named by its NUMBER; the server resolves the id from the published version. The edit is checked against the version by the edit engine's own rules (`applyEditCore`, a dry run). The price is `editCard`, never a browser number and never a model. The creation is `createAddonRow` (the rules of `canCreateAddon`: ONE open add-on per file, the latest version only, a version already edited is not edited again, the deterministic id, `checkAddon` prices it again). A second click for the very same edit returns the request that already waits (`created: false`, compared on a canonical form because the database's JSON reorders keys); a different edit while one waits is `open_addon`. A waiting review request blocks an edit and the reverse.

| Route `/api/missions/[id]/edit-request` | Answer |
|---|---|
| `GET` | `{ request }`: the waiting edit request or `null`, priced AGAIN by the card from its units (a stored price that differs is shown at the code's price) |
| `GET ?schema=1` | the latest version, its sheets, editable columns (never the id columns) and item counts; no item id, value, digest or path |
| `POST quote` | 200 with a state: `offer` (with the change, units, estimate and hold), `unsupported`, `rejected` (with its sentence), `blocked`, `not_latest`, `already_edited`, `too_large`; read-only, not one write |
| `POST create` | 201 `{ created: true }` / 200 `{ created: false }` / 409 (`open_addon`, `not_latest_version`, `already_edited`, `too_large`, `unsupported`, `rejected`) |
| `POST cancel` | one compare-and-set on `plan_ready` with no job and no approval; 409 `changed` otherwise; only the customer's own EDIT request of this file (a review request, a stranger's request and an ordinary mission read the same 404) |
| any | 400 bad input, 401, 404 (not theirs / missing / version not published, one body), 503 storage or database failure (never "missing"), 500 a stored version that is not what it claims to be |

**Money.** None moves. The route writes the `missions` table only (one insert of a `plan_ready` row, one cancelling update through the shared store), calls no rpc, makes no job, no ledger row and no storage write, and never imports a gateway, a worker file or a provider client (guard tests). The original version is never written. The completed edit will create a NEW published version when the worker runs it after approval (Stage D explains why approval is not wired).

**Files.** New: `editRequest.ts` (server), `editRequestLabels.ts`, `editRequestForm.ts` and `editRequestClient.ts` (client-safe), the route, `components/mission/EditRequestCard.tsx`, tests `stage4-edit-request.test.ts` (server, 47) and `stage4-edit-request-ui.test.ts` (words, form, card, client, 32). Changed: `versionFile.ts` (additive: `latestPublishedNumber`), the request page (one line and an import), and four guard tests with explicit, commented entries.

**Not verified.** Everything ran on fakes (a stateful fake table with a primary key and compare-and-set updates, a fake bucket). The JSON-path read `plan->addon->>of` and the insert's `23505` are the existing, still-unrun assumptions of the review request. No real browser.


---

## C. One understandable file page (`DIGER_STAGE4_REVIEW` or `DIGER_STAGE4_EDITS`)

**What the customer sees.** On the request's page, for a delivered mission, in this order: the mission card (the original file and its download), **«حالة طلباتك على هذا الملف»** (new), the file's versions with an Excel download button for every published version, the review price preview and request, the review report, and the edit request. Nothing existing was redesigned; the page is unchanged while the flags are off (every new route answers 404 and every new component draws nothing).

**The status card** (`FileWorkflow`, route `GET /api/missions/[id]/workflow`, read-only) lists up to five requests on the file (an open one first, then the newest) and says, for each, exactly one of:

| Phase | Label | Decided on the server when | What it may say |
|---|---|---|---|
| not requested | (the plain sentence) | no add-on row | what can be asked; nothing moves before approval |
| waiting for approval | بانتظار اعتمادك | `plan_ready`, no job, no approval time | «لم يُحجز أو يُخصم شيء» (the ONLY place besides «cancelled») |
| approval unverified | نتحقق من حالة الاعتماد | `plan_ready` but a job or an approval time exists | «قد تكون نقاطك قد حُجزت»; never «nothing held», never a confirmation |
| approved and processing | اعتُمد الطلب ويجري تنفيذه | `approved` / `executing` / queued / planning | the hold is stated as fact only when the row has a job; otherwise «قد تكون ... حُجزت»; «لم يُنشر الناتج بعد» |
| delivered | اكتمل وسُلِّم | `completed` AND the output is VERIFIED in storage (a review's `reviews/rNNNN.json`, an edit's or fix's `versions/vNNNN.json`) | where to find it; «سُجّل خصم X نقطة» only with a recorded charge |
| charged, delivery pending | خُصم الطلب والتسليم لم يكتمل | a recorded charge or the worker's `charged_not_published`, and no published output | the recorded charge, that the output is not published, that it is not complete |
| failed without charge | لم يكتمل الطلب | `failed` / `unserved`, no recorded charge | only «لم يُسجَّل أي خصم لهذا الطلب.» (what is known, not "points returned") |
| cancelled | أُلغي الطلب | `cancelled`, never put through an approval attempt | nothing held |
| closed after an attempt | أُغلق الطلب | `cancelled` but a job or approval time exists | «نتحقق من حالة نقاطك»; no claim either way |
| completed, no output | اكتمل التنفيذ ولم يُؤكَّد النشر | `completed`, no verified output, no charge | «لن نعرضه لك كمكتمل حتى يُنشر» |

"Price preview" is the review/edit section's own state after «احسب التكلفة» (nothing is stored, nothing moved).

**Rules, each pinned by a test.** Success is never shown before successful publication (a `completed` row with no object in storage is `charged_delivery_pending` or `delivery_pending`, and the word «delivered» never appears in its answer). The view carries a charge only for the two phases that may show one; the browser rejects the whole answer if a charge or hold flag arrives anywhere else, so a payment line cannot be invented. A storage or database failure is a 503, never an empty list or a "delivered". The view carries no request id, job id, path, digest, summary or error text. Customer text is Arabic, in points, and passes `checkCustomerText`; a request that is being processed is announced with `aria-live="polite"` so the change to «delivered» is read out.

**Supported states of the page.** Mobile (one column, wrapping text, 44 px controls), loading (`role=status`), retryable errors (`role=alert` + a real retry button), page refresh and reopening (every section reads its own state from the server), multiple versions (the versions list, the report picker, the edit card always on the latest), and ownership/access errors (404 with one body for a stranger's file and a missing one; 401 hides the card).

**Honest limit.** No approval route exists yet (Stage D), so in production-like use the only phases that can occur are *not requested*, *waiting for approval*, and *cancelled*. The other phases are modelled and tested so that when approval and the worker are wired the page is already truthful. **Do not turn `DIGER_STAGE4_REVIEW` or `DIGER_STAGE4_EDITS` on before the approval route exists:** a customer would be able to prepare a request that nothing can approve.

**Files.** New: `fileWorkflow.ts` (server), `fileWorkflowLabels.ts` and `fileWorkflowClient.ts` (client-safe), the route, `components/mission/FileWorkflow.tsx`, tests `stage4-file-workflow.test.ts` (21) and `stage4-file-workflow-ui.test.ts`. Changed: the request page (one line and an import) and three guard tests with explicit, commented entries.

**Not verified.** Everything ran on fakes; no real browser; the phases past «waiting» have never been produced by a real worker run in this environment.


---

## D, E, F in one paragraph each

- **D** (`docs/STAGE-4-APPROVAL-BOUNDARY.md`): the customer's approval is **not wired and BLOCKED FOR OWNER APPROVAL**. The doc has the endpoint contract the missing route must keep and 17 fake-only tests (the hold reserved equals the price shown; creating a request is free; settlement within the hold; nothing in production can approve).
- **E** (`docs/STAGE-4-CONCURRENCY.md`): the ten concurrency scenarios, with evidence. **Database-level uniqueness is required before `on`** (a migration, OWNER APPROVAL REQUIRED, not made). New money findings (an unchecked last update inside `approveAddonOnce`; a second paid review after a charged-but-unpublished one; a request stuck after the watchdog released its job) are documented, not fixed, because they sit in protected money code. The index was modelled; no disposable Postgres was available.
- **F** (`docs/STAGE-4-E2E-TESTS.md`): the ten flows, real routes and engines on fakes, real `.xlsx` read back with exceljs. Findings: the versions list answers 404 (not 503) when the database is down (`ownsMission` reads an error as "not theirs"; nothing exposed or charged); the unresolved "one open add-on per file" risk is shown on purpose; the synthetic delivered original has no summary sheet (the real file does).

## Integration with `main` (rehearsal, local, never pushed)

`main` was `220e152f` when this was written; the stack's base (`stage-4/review-edits-versions`) forked from `0bf7b2cf`, **37 commits behind**. A non-destructive merge of the stack head into `main` in a throwaway worktree conflicts in **four files, all owned by the earlier PRs (#371 to #388), none by Stages A to F**:

| File | Conflict | Resolution used in the rehearsal |
|---|---|---|
| `src/app/api/missions/[id]/file/route.ts` | `main` added customer CSV downloads (round 32: `CUSTOMER_CSV_NAMES`, `customerCsvFile`); the stack added `?version=N` | `?version` is branched first and still serves only `result.xlsx`; the ordinary path keeps main's CSV handling and its 400 sentence |
| `src/lib/agentMission/customerActions.ts` | adjacent imports | keep both |
| `src/lib/agentMission/methodology/missions.ts` | an import and the column list (`updated_at` vs the add-on marker column) | keep both |
| `src/lib/agentMission/openMissions.ts` | `main` added `ownRunning`; the stack filters add-on rows | filter add-on rows in both queries (an add-on row with a live lease must not count as a running mission) |

The resolved tree type-checks and was run through the full suite (results in the final report). The resolution is the owner's call and must be done on the owner's PR #371 to #388, not here; no PR base was changed and nothing was pushed to `main`.

## Exact owner approvals required (nothing below is done)

1. **The approval route** (a new file calling `approveAddonOnce`), with the guard of `STAGE-4-CONCURRENCY.md` section 2 (`reconcileOpenAddons` first; refuse unless this request is the keeper).
2. **The database uniqueness migration** (partial unique index, one open add-on per file) after the read-only pre-checks, plus the small insert-classification change in `createAddonRow`.
3. **Edits in protected money code** found by Stage E: check the error of the last update in `approveAddonOnce`; refuse a new paid review of a version whose earlier review was charged; end (not leave waiting) a request whose job the watchdog released.
4. **PR #378 and its financially sensitive descendants (#381 to #388, and Stages A to F on top)** must not be merged until 1 to 3 are decided; the wallet label (decision D9), the watchdog release of a cancelled add-on, and whether an unpaid add-on request expires.
5. **Deploying the Heroku worker** with the add-on dispatch and the live check of `docs/MONEY-PR-7A.md` section 8 on a `test` account.
6. **Conflict resolution against `main`** (above) on the owner's earlier PRs.
7. A **real-browser pass** on a preview with a test account (only a layout check of the components was possible here).

## Recommended merge order (when the approvals exist)

`main` <- #371 <- #378 <- #381 <- #384 <- #386 <- #388 <- #389 (A) <- #390 (B) <- #391 (C) <- #392 (D) <- #393 (E) <- F, each rebased onto the previous result with the four conflicts above resolved once, at #371. A to C only add read-only, flag-off features, so they could land earlier than the approval route, but they depend on #371 to #388 which include the financially sensitive core (#378).

## Before production activation (all flags are OFF and must stay off until every item is done)

1. Items 1 to 3 above merged and tested; the index applied and verified on the real database.
2. The worker deployed (Heroku) and the live check done with `DIGER_STAGE4_VERSIONS=test`, then `DIGER_STAGE4_EDITS=test`, then `DIGER_STAGE4_REVIEW=test` on a test account only; read-only ledger check after one small edit and one review.
3. A real-browser pass (phone and desktop) of the request page with the flags on.
4. Only then `on`, one flag at a time. Rollback: unset the flag; ledger rows are never deleted.
