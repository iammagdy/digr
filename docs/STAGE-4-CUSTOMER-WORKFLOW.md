# STAGE 4: the customer's review-and-edit workflow, remaining safe work (Stages A to F)

Stack (each PR targets its immediate predecessor; every one is a DRAFT; nothing is merged, no flag is set, nothing is deployed):

| Stage | Branch | Targets | What |
|---|---|---|---|
| (existing) | `money/7e-addon-isolation` (#388) | `money/7d-review-request` | the stack head this work starts from, `bf649517` |
| A | `stage-4/a-review-report` (#389) | `money/7e-addon-isolation` | the customer's review report |
| B | `stage-4/b-edit-requests` | `stage-4/a-review-report` | the customer's edit request before payment |

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
