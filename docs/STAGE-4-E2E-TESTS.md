# STAGE F: end-to-end regression tests (fake-only)

Branch `stage-4/f-e2e-tests`, from `stage-4/b-edit-requests` (`cb3f01de`). **New files only**: no file under `src/`, `agent/` or `supabase/` and no existing test, helper or doc was edited. Nothing here reaches a database, a bucket, a provider, a model or a live account: `fetch` is stubbed to throw in every test, the money core is the hardened fake (`tests/helpers/agentMoney.ts`), storage is a memory map.

## What is composed (all REAL code, fake clients)

| Piece | Real or fake |
|---|---|
| The routes: versions list, file (`?version=N`), review quote, review request, review report (Stage A), edit request (Stage B) | real handlers, real `NextRequest`s; the viewer and the admin client are the shared mocked session (`tests/helpers/e2eSession.ts`) |
| The approval | the real `approveAddonOnce` of the existing money core, called as a **function** on the fake client (there is no live approval endpoint: Stage D) |
| The worker | the real `runAddon` / `runAddonSafely` on a memory store, a fake recorder and a fake provider |
| The review engine, the edit engine, the pricing cards | real |
| The `.xlsx` files | real workbooks built by the site's own writer and **read back with exceljs** |
| Data | one world shared by the routes and the worker (`tests/helpers/e2eWorld.ts`: the routes' client answers over the worker's own `missions` map and `files` map), a small two-sheet Arabic file with honest faults (empty name, bad e-mail, short phone, a stated gap), and the stored real TikTok file M12 in flow 1 |

## Flows and their tests

| File | Flow | Tests |
|---|---|---|
| `tests/stage4-e2e-review.test.ts` | 1 original -> version list -> the right Excel download | 6 (list and genuine workbook; ordinary link unchanged; real M12 file; ownership and auth; storage 503; documented finding) |
| | 2 review quote -> unpaid request -> refresh, double click, parallel clicks -> cancel -> no charge | 1 |
| | 3 quote -> request -> fake approval (hold) -> fake review -> published report -> the customer's view | 1 |
| | 4 completed review -> reuse, no second request, no second charge | 2 |
| `tests/stage4-e2e-edit.test.ts` | 5 completed review -> a correction (customer-typed cells) -> approval -> execution -> new version -> download both | 1 |
| | 6 edit quote -> prepare -> approval -> execution -> new version (set cells; rename; add items; what is not offered; ownership) | 5 |
| `tests/stage4-e2e-resilience.test.ts` | 7 storage fails after settlement -> one charge, recoverable pending delivery (edit and review) | 2 |
| | 8 two workers overlap -> one settlement; a foreign object on the path -> release, no charge | 2 |
| | 9 concurrent creation (routes) and the documented uniqueness risk | 2 |
| | 10 flags OFF -> every new route 404 first; the ordinary journey unchanged; flags ON and only looking changes nothing | 3 |

**25 tests, all passing.** Every flow ends with the ledger invariant (`checkAddonLedger`: one reserve, one release, at most one charge, 0 < charge <= hold, net = -charge) where money moved.

## What the flows assert, across them

- **No cost before approval**: after quote, request and refresh the ledger holds only the starting top-up, no job exists, the balance is unchanged, the provider was never called.
- **Never negative, never double, never above the hold**: the balance after each flow is `start - charge >= 0`; a repeated run, a retry, a second worker or a recovery adds no ledger row.
- **No duplicate version, no foreign publish**: `versions/` holds exactly the published numbers; a rival object on the path releases the whole hold with no charge and is never served (the route says 500, the list leaves it out).
- **Excel truth**: sheet names, headers, row counts and every cell of a downloaded version equal the stored version (real parse); v1 is byte-identical before and after an edit; v2 differs in exactly the cells the customer typed; added items get server-made ids and nothing is invented.
- **Arabic numerals and wording**: every sentence a flow shows passes `checkCustomerText` and contains no ASCII digit.
- **Ownership and authentication**: another customer's file reads the same 404 body as a missing one; signed out is 401; nothing is written by a GET.
- **Storage 404 versus 5xx**: a storage outage is a 503 on the list, the file, the report, the quote and the edit routes, never "missing". A pending (unpublished) report or version is never shown.

## Findings (documented honestly in the tests; nothing was fixed)

1. **`GET /api/missions/[id]/versions` answers 404 when the DATABASE is down** (`ownsMission` treats a read error as "not theirs"), while the download, report, quote and edit routes answer 503. Nothing is exposed or charged, but the list cannot tell an outage from a missing file. Test: flow 1, "DOCUMENTED FINDING".
2. **"One open add-on per file" is still not a database guarantee** (flow 9, "DOCUMENTED RISK"): a creator whose read was stale and which loses the database right after its own insert leaves two open, unpaid requests; the next customer-side read repairs it. Nothing is held at that stage. This is the risk docs/MONEY-PR-7A.md section 17.4/17.5 describes; the partial unique index there is still only a proposal and needs the owner's approval.
3. The "delivered original" of the synthetic world is a workbook built by the version writer; the real delivered file also has a summary sheet (not versioned). Flow 1 therefore proves the ordinary link is unchanged and serves the mission's own `result/result.xlsx`, not the real file's layout.

## Limits

No real browser, no real storage listing, no real Postgres (the JSON-path read `plan->addon->>of` and the `23505` of a duplicate insert are modelled, not run), no Vercel or Heroku. The approval is exercised only as a function on fake clients; the live paid route does not exist and is BLOCKED FOR OWNER APPROVAL.
