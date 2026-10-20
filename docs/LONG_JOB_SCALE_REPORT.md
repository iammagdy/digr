# Long jobs at scale: ceilings, measurements and what is still needed

Status of this file: written with the first scale PR (config-driven ceilings and the test harness); each later scale PR updates its own
section. Everything below was read from the code at `main` after PR #147, or measured in the deterministic harness
(`tests/helpers/scaleHarness.ts`: the real worker route, the real social chain, a fake provider, a fake clock). Nothing was measured
against the live provider and no money moved. Numbers marked **estimate** are not measured.

## 1. The ceilings, with file and line

| What limits a job | Value | Where | Config-driven now |
|---|---|---|---|
| Provider pages (chunks) per job | 30 (`ABSOLUTE_MAX_PAGES`) | `src/lib/server/providerCallCaps.ts:24`, used by `maxPagesForJob` `:42` | `LONG_JOB_MAX_PAGES` (default 30) |
| Pages per page a job would need if every record matched | 3 | `providerCallCaps.ts:22` | `LONG_JOB_PAGE_ALLOWANCE` (default 3) |
| Rows a chunk collects (the "page" of a feed job) | 50 (`SOCIAL_ROWS_PER_CHUNK`) | `src/lib/socialSources.ts:727`, `wanted` in `src/lib/server/socialAdapter.ts:415`, spec `pageSize` in `src/lib/server/jobExecutionSpec.ts:124` | not yet (PR 4d sizes it from measured call time) |
| Calls a chunk may make | 6 (`SOCIAL_MAX_CALLS_PER_CHUNK`) | `socialSources.ts:724` | no: it is the basis of the provider spend estimate of a chunk (money-adjacent), left as is |
| Chunk time budget / minimum time for one more call | 40 s / 9 s | `socialAdapter.ts:64`, `:65` | PR 4d |
| Worker deadline per request | 45 s inside a 60 s function | `src/app/api/worker/chunk/route.ts:224`, `:71`, `vercel.json` | no (platform limit) |
| Rows per plan item (customer-visible "most rows") | 500 (X posts, Facebook comments), 1,000 (TikTok and YouTube comments), 200 / 48 / 60 for videos and Facebook posts (source-limited) | `socialSources.ts:502-585` | `LONG_JOB_SOCIAL_MAX_ROWS` raises only comment services and big post services; never lowers |
| Comments taken from one video | 500 (`MAX_PER_VIDEO`) | `socialSources.ts:829`; duplicate constant `socialAdapter.ts` now imports it | `LONG_JOB_MAX_PER_VIDEO` (default 500) |
| Videos one job reads | 20 (`MAX_VIDEOS_PER_JOB`) | `socialSources.ts:830` | `LONG_JOB_MAX_VIDEOS` (default 20) |
| Channels / top videos per channel / videos kept in a mission | 10 / 20 / 100 | `socialSources.ts:632`, `:633`, `:636` | no (they travel inside the chunk cursor) |
| Rows a mission chunk may return | 500 | `socialAdapter.ts:70` | no |
| Points per job | 600 (`DEFAULT_JOB_POINTS_CAP`) | `src/lib/calculatorPricing.ts:16`, `getConfiguredJobPointsCap` in `src/functions/shared/providerSpend.ts:51` | **frozen**, money |

Two consequences that are not obvious from the table:

- **A feed job (comments, posts) cannot exceed 1,500 rows today** whatever the plan says: 30 pages x 50 rows. The harness shows it: a
  3,000-record job stops at exactly 1,500 delivered after 30 chunks, with the page-cap note, settled once for the 1,500 only
  (`tests/long-job-scale-harness.test.ts`, "DEFAULT ceilings"). With the page ceiling raised in test config the same job reaches 3,000
  in 60 chunks.
- A single video or post link (`mode url`) can give at most `min(500, target)` comments; larger jobs must discover several videos (20 by
  default, so at most 20 x 500 = 10,000 comments before the page ceiling).

## 2. Work that grows with the number of chunks

| Cost | Where | Measured in the harness (60 chunks, 3,000 rows) |
|---|---|---|
| Every chunk re-downloads **every earlier chunk's file** to rebuild the "already seen" set, the seen cursors and the earlier page counts | `route.ts:607` (`for (let step = 0; step < currentStep; step++)`) | 1,770 downloads |
| The final chunk downloads every chunk's file again to assemble the result | `route.ts:1186` (`for (let s = 0; s <= currentStep; s++)`) | 60 downloads |
| Total | n(n+1)/2 downloads | **1,830 downloads, 33 MB read** for 60 chunks |

Quadratic: a job of 1,000 chunks (50,000 rows at 50 per chunk) would make about **500,500 downloads and about 9 GB of reads** (33 MB x
(1000/60)^2). The last chunks would each download about 1,000 files one after the other before making a single provider call; at
an assumed 30 to 60 ms per storage round trip (**estimate, not measured**) that is 30 to 60 seconds, i.e. past the 45 s deadline. So the
re-reads, not the provider, would stop such a job. PR 4b replaces them with one running identity set.

## 3. Final assembly and the workbook

- There is **no 40,000-row constant** in the code. The limit is memory: `generateExcelReport` builds the whole workbook in memory
  (`src/functions/shared/fileGenerators.ts:262` `new ExcelJS.Workbook()`, a styled row per record at `:282`), `generateCsvReport`
  builds one string of all rows (`:729`, `:743`), and the worker holds every row of the job in one array before generating either
  (`route.ts:1186` onward, files at `:1428`, `:1446`, `:1464`). Peak memory therefore grows with rows x columns x styles. The size
  of the produced file is also bounded by the storage bucket's object size limit (**estimate**: the platform default is 50 MB; the
  bucket's own setting was not read). PR 4c measures the real generators and stages the assembly.
- The result files are uploaded before settlement and the delivered-rows reconciliation (`route.ts:1247`) stays exactly as it is.

## 4. Reads that silently stop at 1,000 rows

PostgREST returns at most 1,000 rows per request unless the client pages. The ledger balance already pages (`src/lib/supabase/ledger.ts`,
`calculateBalance`, and `typedLedger.readAll`). These sums of `provider_costs` do not:

- `src/lib/server/providerLimits.ts:237` (this job's real spend) and `:239` (today's spend of all jobs, for the per-job and per-user ceilings),
- `src/functions/shared/providerSpend.ts:72` (today's provider spend) and `:119` (total provider spend, which feeds the available provider balance),
- `src/lib/server/providerLimitsAdmin.ts:69`, `src/lib/server/providerKeyAdmin.ts:278` (the numbers on the admin pages).

One cost row is written per chunk and per call, so a single 1,000-chunk job passes 1,000 rows by itself, and a busy day passes it without any
big job. The sums then under-count, so a ceiling that should stop a job does not, and an admin page shows too little spend. PR 4e pages
these reads (same graceful fallback the ledger already uses) and tests them with 2,500 rows. The client-side fallback balance
(`src/hooks/useBalance.tsx:43`, used only if `/api/wallet/balance` fails) sums ledger rows without paging: it is ledger-adjacent and is
**reported, not changed**.

## 5. What a real 50,000-comment or 37,500-post job would still need that is money code or SQL (proposal only, nothing applied)

1. **The per-job points cap.** `JOB_MAX_POINTS_CAP` is 600 points (60 EGP); the unit price decides how many rows that buys (for illustration only: at 0.2 points a record it would be 3,000 rows). A 50,000-row job needs the cap to be at least `ceil(50,000 x unit price x 1.15)` points. `src/lib/jobCaps.ts` already
   documents a proposal (`JOB_MAX_POINTS_CAP_LARGE = 2000`); even that is far too small for 50,000 rows. Changing a cap is a money decision for the owner and is
   enforced inside `settle_job_atomic`'s `p_points_cap` argument and the quote builder: not touched.
2. **The plan-time provider gate prices a record at one call's price.** `checkPlanProviderCapacity` (`src/functions/shared/providerSpend.ts:264-303`)
   estimates `targetVolume x primaryUnitCostUsd` with `rowCostUsd` equal to the price of one call (for TikTok comments 0.001 USD for a call of up to 20
   comments), so it prices a record 20 times too high and downscales large plans to `floor(safeBudget / unitCost)` rows. The real provider spend of 50,000
   comments at 20 per call is about 2,500 calls (about 2.5 USD, **estimate** from the catalog price). The gate would have to price per call, and the
   daily provider cap (a provider limit, frozen) would still allow only what it allows per day: a 50,000-row job needs several days or a higher daily cap.
3. **Reserve and settlement for a job of many days.** The reserve is taken once at approval and released or settled once; a job that runs for days keeps the reserve for days.
   The watchdog refunds a job idle for 30 minutes, which is right for a stuck job; no change is needed, but the owner should know a multi-day job holds its points meanwhile.
4. **SQL.** `claim_job_chunk`, `complete_chunk` and `record_chunk_failure` take one lease per chunk and store the whole job state in one row; at 1,000 chunks that is 1,000
   claims and 1,000 completions: no change needed. A real measurement of `job_events` volume (about 3 to 5 rows per chunk) is advised before 1,000-chunk jobs: the page
   reads the newest rows only, so it stays correct.

## 6. Tests that run through the real worker (`tests/long-job-scale-harness.test.ts`)

Completion through chunks with the page closed (a simulated driver, one chunk per minute); repeated records at page edges never delivered or billed twice; kill (a lease taken and the
instance lost) and resume without duplicates; settled once; charge = ceil(delivered unique matching units x unit price) never above the reserve; partial settlement on 429, 402, 503
and timeout mid-job; full release when the source fails from the first call; the daily provider budget closing mid-job; no chunk above 45 simulated seconds even with a 12-second source; the
plain-Arabic progress line from real chunk times; the ceilings stop a 3,000-row job at 1,500 by default and let it reach 3,000 with the page ceiling raised in test config only.
