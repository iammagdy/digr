# Discovery and output safeguards — verification report

Date: 2026-10-17 (Africa/Cairo)

## Change under review

- Draft PR: https://github.com/iammagdy/digr/pull/79
- Branch: `codex/discovery-stage-fixes`
- Commit: `64abfb22c4562d5705ae5b3404ebc76cf4b397b7`
- Vercel deployment: `dpl_EwWo8C2Adj5AnQhTvJjf9YZbuDaV`
- Deployment state: `READY`; reported commit SHA exactly matches the branch commit.
- Preview: `https://diger-mx7soexnw-iam-magdy.vercel.app`
- Database migrations: none added; no migration was applied.

## AUDIT / RESULT

| Scenario | Result | Evidence / limitation |
|---|---|---|
| a. TikTok starter placeholder is fill-only, unchanged send is blocked, real handle gets account plan | **NOT RUN (UI flow)** | Preview API guard was exercised directly on deployment `dpl_EwWo8C2Adj5AnQhTvJjf9YZbuDaV` with the exact message `بيانات حساب [@اسم_الحساب] على تيك توك مع الإحصائيات العامة`. HTTP `400`, `success:false`, request id `req_c8542bd2-fe09-49aa-bd84-670c3db2f51e`, elapsed `2059 ms`, Arabic response `استبدل النص الموجود بين الأقواس بالمعلومة المطلوبة، مثل اسم الحساب، ثم أرسل طلبك.` This demonstrates the server rejects the unresolved placeholder before auth/model work. Starter click/fill and real-handle plan were not exercised in an authenticated browser. |
| b. `عايز خمس شركات في مجال الكهرباء` | **NOT RUN** | No authenticated browser session; no request sent. |
| c. Five contracting companies in Egypt; inspect delivered and review rows | **NOT RUN** | No provider call or job approval; no rows to inspect. |
| d. Ten IT companies in Saudi Arabia; inspect request body if empty | **NOT RUN** | No provider call; therefore no live request body or result. |
| e. Liechtenstein rockets and software companies in Germany | **NOT RUN** | No provider call or job approval. |
| f. Five electromechanical companies with decision makers and contact fields | **NOT RUN** | No provider call/job approval; no delivered workbook or contact-rate denominator. |
| g. Greeting, new chat after 3 minutes, edit repricing, expired quote | **NOT RUN (live)** | Related local code tests passed, but browser/session and elapsed live-flow checks were not run. |
| h. 30–50 records complete automatically; report batch gaps/durations | **NOT RUN** | No job was approved or dispatched; no live batch measurements. |
| i. Download/open Excel and PDF; inspect 390×844 layout | **NOT RUN** | No authenticated live downloads or mobile viewport check. |

No job was approved, no methodology add-on was purchased, and no provider call was made. Provider spend for this verification was **$0.00**. No ledger rows were created, so there is no reserve/charge/release arithmetic to report. The API guard test returned before authentication, persistence, rate-limit consumption, and model invocation.

## Local verification

- Focused tests: **98 passed** across 10 files.
- `npm run build`: passed; the client-bundle checker reported 87 files and 0 detected secrets.
- `npx tsc --noEmit`: passed after the production build completed.
- `git diff --check`: passed.
- Full test suite: **860 passed, 41 failed** (111 files / 901 tests). Several failures assert older behavior that conflicts with the supplied owner decisions (including legacy discovery and workbook expectations). The complete run is not a pass; individual failures still need review before merge.

## Changes included in this PR

- Structured required-input metadata and deterministic discovery questions for company, decision-maker, social-topic, and social-account requests.
- Server-side unresolved-placeholder rejection and discovery/quote guards; greeting path is kept separate from research planning.
- Arabic-number count extraction, world-country parsing, account-lookup plan shaping, and customer-selected format handling with an editable XLSX suggestion.
- Decision-maker capability enabled with contact-field collection/status handling and pre-approval availability wording.
- Provider response failure distinguished from valid empty results; country/industry request normalization and relevance/output corrections.
- Corrected stale chat job state, post-approval copy, request-status polling, page activity records, and server-side ETA from observed event timing.
- Excel/PDF wording and field-verification reporting corrections.

## Known incomplete work / risks

- Retry still starts a new request rather than reusing stored partial rows and fetching only the deficit. This is not fixed in this PR.
- Purchase-methodology charge-after-delivery/release behavior was not exercised end to end; no paid add-on or job was approved.
- Sidebar/activity panel behavior, all workbook/PDF contents, privacy/terms wording, and the mobile results table were not fully checked against the live UI.
- Real provider behavior for decision-maker emails/phones, Saudi IT search, international coverage, relevance decisions, and contact verification rates remains unverified. No live data claim is made.
- Live scenarios b–i and the UI portions of scenario a remain unverified because there was no test-account session available through the permitted environment-variable-only credential path. No password files or `.env` files were read.

## Money-table write audit

Read-only repository search found direct table writes outside the approved atomic SQL RPC path. These are pre-existing paths and were not changed by this PR:

- `src/functions/shared/quoteAccept.ts`: `reserveCredits` / `releaseCredits` helper path, direct `plans_quotes` update, and direct `jobs` creation instead of one `accept_quote_atomic` operation.
- `src/functions/shared/planManager.ts` and `src/functions/shared/chatHandler.ts`: direct quote persistence/update in `plans_quotes`.
- `src/functions/shared/providerCosts.ts` and `src/functions/shared/providerSpend.ts`: direct `provider_costs` insert/update for spend accounting.
- `src/functions/shared/multiStepWorker.ts`: legacy direct `jobs` mutations; its watchdog report also gives manual instructions to create a `rel_` row directly in `credit_ledger` (around lines 1238–1261). That manual-ledger instruction conflicts with the append-only/atomic-function rule and should be removed.
- `src/app/api/topup/submit/route.ts`: direct `topups` insert.
- `src/app/api/admin/topups/approve/route.ts` and `src/functions/submit-topup/src/main.ts`, `src/functions/approve-topup/src/main.ts`: direct top-up state writes; confirm which deployed path is authoritative and route mutations through `approve_topup_atomic`.
- Profile updates also exist in onboarding/account deletion/watchdog paths. These are profile writes, not balance changes, but must remain behind the approved safe profile path.
- `src/app/api/jobs/[id]/methodology/route.ts` contains `credit_ledger` access; a separate exhaustive classification of its read/write calls is still required before certifying atomic-only behavior.

This is a material outstanding compliance issue. No live financial rows were inspected or modified during this task.

## Caps, scripts, and workspace hygiene

- Provider daily cap default: **$0.80 USD** in `src/functions/shared/providerSpend.ts` / `src/lib/calculatorPricing.ts`; runtime environment override was not read. `JOB_MAX_POINTS_CAP` default: **600 points**.
- LLM daily spend cap default in code: **$50.00 USD** (`src/functions/shared/rateLimits.ts`); runtime override or `settings_private` value was not read, so the effective production cap is **unverified**. No cap was changed.
- The prohibited `scripts/verify/run-tiny-live-preview.ts` and `scripts/verify/verify-spend-cap.ts` were not run.
- Other helper scripts are present under `scripts/`, including live acceptance/evaluation, site audit/screenshot, build/deploy, cleanup/setup, PDF/report, provider/mock, download, and atomic-function verification scripts. These were not run unless named in Local verification above.
- Existing untracked paths were left untouched: `.vitest/`, `docs/AUDIT_AND_PLAN.md`, `supabase/.temp/`, and `tmp/` (including prior QA screenshots and a standalone build backup). None was added to the commit. No credentials were printed; no credential-bearing file was opened.

## Files read for this report

`src/app/api/chat/route.ts`, `src/lib/researchPlaceholders.ts`, `src/functions/shared/quoteAccept.ts`, `src/functions/shared/providerCosts.ts`, `src/functions/shared/providerSpend.ts`, `src/functions/shared/planManager.ts`, `src/functions/shared/multiStepWorker.ts`, `src/functions/shared/rateLimits.ts`, `src/app/api/topup/submit/route.ts`, Vercel deployment metadata for the exact commit, and the Git working-tree status. The repository hint `docs/AUDIT_AND_PLAN.md` was read earlier; owner decisions in the supplied task override conflicting text in that hint.

## Unverified before merge

All live scenarios marked NOT RUN; contact completeness and true contracting relevance; downloaded artifacts and mobile rendering; job completion/partial retry and measured ETA; methodology billing; actual effective LLM/provider caps; all 41 full-suite failures; and remediation/classification of the direct money-table write paths above.
