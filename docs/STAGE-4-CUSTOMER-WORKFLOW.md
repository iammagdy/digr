# STAGE 4: the customer's review-and-edit workflow, remaining safe work (Stages A to F)

Stack (each PR targets its immediate predecessor; every one is a DRAFT; nothing is merged, no flag is set, nothing is deployed):

| Stage | Branch | Targets | What |
|---|---|---|---|
| (existing) | `money/7e-addon-isolation` (#388) | `money/7d-review-request` | the stack head this work starts from, `bf649517` |
| A | `stage-4/a-review-report` | `money/7e-addon-isolation` | the customer's review report |

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
