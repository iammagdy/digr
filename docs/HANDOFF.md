# Diger Platform Engineering Handoff & QA Status

This handoff document provides a clear, factual status of the Diger platform (`iammagdy/digr`) for engineering agents (Codex), developers, and the project owner.

---

## 0. Conference-readiness session (2026-10-21): where things stand

**Merged to main (merge commits; each PR body carries its evidence block):**

| PR | Merge SHA | What |
|---|---|---|
| #173 | d35a3ad | capacity gate uses the provider's real balance (fresh reading, 5 min max age, fallback to the estimate) |
| #174 | 49ee886 | admin provider tab shows the connected account e-mail (admin-only, memory-only) |
| #175 | 8e5fb4d | YouTube/TikTok topic comments: 20-video discovery, videos judged before comments are read, deep reads that resume inside a video, unusable comments never fill the volume, Arabic first, date/video/language columns |
| #176 | a301d7b | Part A: coverage matrix (15 families), structured understanding, curated newspapers + pick question + news/price output standards (switched off), unserved-requests log + `/admin/requests`, `docs/CAPABILITY_COVERAGE.md` |
| #177 | c12de75 | Part B: three new showcase templates, honest plan tests, fake-provider worker tests |
| #178 | 18f8c23 | Part D: busy mode (daily allowance or REAL balance used up), sign-up path (QR `/join`, invitation code, welcome balance, rate-limit and late-e-mail messages, resend limits) |

**Production:** the latest READY deployment read from the API at the time of writing was `dpl_B9eDj4pee4pLsAawBUMfjuUkEvWa` (built SHA `c12de75`); #178's own deployment is read again in the final report.

**Work in progress (do not merge as is):**
- `claude/wip-load-and-limits`: adaptive job polling with jitter, public pages skip the sign-in call in the middleware, wallet history reads the newest 500 rows in one query, the per-user daily spend read no longer scans every customer's cost rows, the admin's per-user daily limit also shapes the plan. Missing: tests for these, the per-user concurrent-job limit, raising the shared-IP public limiters.
- `claude/conference-dashboard`: finished by a helper agent (35 tests, build green) but not yet re-verified against current main and not yet a PR.

**Exact next step:** verify and merge the conference dashboard; add the concurrent-job guard in `accept-quote` (before the reserve) and the limiter changes; finish and test the load branch (P2: fewer database calls and invocations); then the offline 500-visitor harness, the pressure-test scripts and runbook, `docs/CONFERENCE_READINESS.md`, the final batch test.

**Risks to know:**
- The sign-in service's own limits (e-mails per hour on the built-in sender, sign-ups per IP behind one venue network) are outside the code: see the owner list in `docs/CONFERENCE_READINESS.md` when it lands.
- Public limiters are per server instance and per IP; at a venue every visitor shares one IP (the busy-status limiter and the calculator ones must be raised: in the load branch).
- A job is capped at 600 points: 57 YouTube comments, 86 TikTok comments, 104 X posts, 3 decision makers with e-mail and phone per request. Templates that promise more are cut by the plan with a plain sentence.
- Nothing reads news, prices, ads, maps, search results, jobs or forums: those requests are answered as «not available» and logged.

**NOT VERIFIED (never exercised live):** the real balance read on the deployed plan path; whether the provider's identity answer contains an e-mail; the YouTube search recency parameters and the video-level review on real data; the new deep read on a live source; the busy banner and the invitation-code redeem with a real account and a real e-mail confirmation; the conference dashboard on production data; all of Part E's pressure test (to be run by the owner on a preview, never on production).

---

## 1. System Architecture & Core Stack

- **Framework**: Next.js 15.5 (App Router, React 19, Tailwind CSS v4) hosted on Vercel.
- **Database & Auth**: Supabase PostgreSQL (Project `pfinlfaqwnytesedchik`), using Row-Level Security (RLS) and atomic RPC functions for all balance/financial operations.
- **AI & Planning**: Anthropic Claude Haiku 3.5 (`claude-3-5-haiku-20241022`) via `@anthropic-ai/sdk`, with structured fallback plans.
- **Data Catalog & Ingestion**: TREG catalog integration for B2B company discovery, social data, and profile endpoints.
- **Deliverables**: Excel (.xlsx) generated via `exceljs`, CSV (UTF-8 BOM), and PDF methodology reports via `pdfkit`.

---

## 2. What Works (Verified Subsystems)

1. **Authentication & Session Security**:
   - Supabase Auth integration via `@supabase/ssr` cookies and JWT bearer headers.
   - Non-admin test account login and role separation verified.
   - Zero client bundle secrets validated via `scripts/check-client-bundle-secrets.ts`.
2. **Financial Guardrails & Append-Only Ledger**:
   - `credit_ledger` alterations strictly mediated by deterministic IDs (`res_<jobId>`, `rel_<jobId>`, `chg_<jobId>`, `top_<topupId>`).
   - Reserve-first hold and release-first completion order (`rel_` +reserve, followed by `chg_` -actual).
   - Zero charge for missing records or non-matching results.
3. **Arabic-First Interface & UX Invariants**:
   - Native RTL layout with Arabic typography and formatting.
   - Activity panel appears only when an active or completed job exists and remains absent on fresh chats.
   - Sidebar collapse and responsive navigation work across desktop and mobile (tested at 390x844).
   - Session reset via "+ سؤال بحثي جديد" clears active job state and session storage without reopening stale jobs.
4. **Artifact Downloads**:
   - PDF, Excel, and CSV download routes verify user authorization and generate time-limited signed URLs (`/api/jobs/[id]/download`).
   - Direct download links link reliably to stored deliverables in the Supabase `results` bucket.

---

## 3. Known Open Issues & UNVERIFIED Items (For Codex / QA)

The following items are explicitly marked as **OPEN** or **UNVERIFIED** and require further testing, owner decision, or remediation:

1. **[OPEN - UNVERIFIED] 50-Company Autonomous Worker Progression**:
   - A 50-company job finishing entirely on its own through the worker/cron path with zero client-side pushing or manual intervention remains unproven under full production isolation.
2. **[OPEN] Plan Proposal Latency (12–16 Seconds)**:
   - Initial plan card generation in chat takes between 12 and 16 seconds (target is under 10 seconds). Root cause includes sequential upstream capability lookup, schema reflection, and multi-turn Claude prompt reasoning.
3. **[OPEN] Excel Executive Summary Sheet vs Data-Only Requirement**:
   - The generated Excel workbook currently includes an executive summary sheet (`الملخص التنفيذي ومؤشرات السوق`) in addition to the data sheets (`دليل الشركات المعتمد` and `بيانات الشركات للتصفية`). The owner has stated a preference for data-only workbooks; this sheet must either be removed or formally approved.
4. **[OPEN - UNVERIFIED] Plan Edit Industry Filter Persistence in Database**:
   - While client-side form state and quote recalculation show the edited industry, end-to-end database proof that subsequent worker execution applies the modified industry filter in SQL/TREG params remains unverified.
5. **[OPEN] Decision-Makers Work Email Unavailability**:
   - B2B decision-maker queries deliver names, titles, and LinkedIn URLs, but work emails are consistently unavailable from the current upstream provider endpoint. The plan card now includes an explicit disclaimer before approval, but upstream email enrichment remains unavailable.
6. **[OPEN] Database Cleanup Plan Correction**:
   - Helper SQL cleanup scripts generated during chat sessions were flawed and must **NOT** be used. The only authoritative, transaction-safe reset script is documented in [`docs/OWNER_SQL.md`](file:///d:/Digr/docs/OWNER_SQL.md) and must be executed exclusively by the owner.
7. **[OPEN] Unexplained `settings_private` Write for 0.80 USD Provider Cap**:
   - The origin and historical write of the `0.80 USD` provider daily cap in `settings_private` requires owner verification against real budget constraints.
8. **[OPEN] LLM Daily Spend Cap (50 USD) Policy Decision**:
   - The LLM daily spend cap is currently configured at 50 USD in `settings_private` and enforced at runtime. This limit requires an explicit business policy decision by the owner prior to public scaling.

---

## 4. How the Worker & Cron Execution Path Runs

1. **Job Initialization**:
   - Customer approves a quote via `POST /api/chat/accept-quote`.
   - `accept_quote_atomic` holds reserved credits in `credit_ledger` and inserts a `queued` job into `jobs`.
   - `accept-quote` triggers the first chunk via `dispatchWorkerChunk` calling `POST /api/worker/chunk`.
2. **Chunk Execution & Self-Chaining**:
   - `/api/worker/chunk` claims an execution lease on the job, queries the data provider, filters/deduplicates records, and saves partials to Supabase Storage.
   - If more records are required, the chunk self-chains by firing an asynchronous `POST` to `/api/worker/chunk` for `step + 1`.
3. **Client Polling & Nudge Route**:
   - While the user has the chat or requests page open, `/dashboard/chat` and `/dashboard/requests` periodically check active job status.
   - If a lease has stalled or expired without completion, the client triggers `POST /api/jobs/[id]/nudge` to safely re-dispatch the next worker chunk.
4. **Watchdog Cron**:
   - Vercel daily cron triggers `GET /api/cron/watchdog`.
   - Stale running jobs past timeout are identified, compensating releases (`rel_<jobId>`) are checked, and stuck holds are released safely.

---

## 5. How to Run Tests & Verification

All automated tests and validation scripts run locally with:

```bash
# 1. Run all unit and integration test suites (Vitest)
npm run test

# 2. Verify TypeScript types across the entire project
npx tsc --noEmit

# 3. Build Next.js production bundles and check for client secret leaks
npm run build

# 4. Standalone client bundle secret scan
npm run check:secrets
```

---

## 6. Recorded Test Top-Ups Note for Owner

All balance top-ups performed on the test account (`iam.magdy@outlook.com`, UID `47693c59-89f1-405d-bec1-e72271517870`) are recorded below for pre-launch ledger cleanup per [`docs/OWNER_SQL.md`](file:///d:/Digr/docs/OWNER_SQL.md):

| Topup ID | Amount (EGP) | Points (Delta) | Reference | Ledger ID |
| :--- | :---: | :---: | :--- | :--- |
| `top_req_1792156256768` | 25 | +250 | `REF_1792156256769` | `top_top_req_1792156256768` |
| `topup_6ac474bae339871ce7473c18` | 20 | +200 | `TEST_REF_1792164072210` | `top_topup_6ac474bae339871ce7473c18` |

---

## 7. Operational Rules & Security Invariants

- **Zero Direct Writes to Money Tables**: Never run ad-hoc SQL `INSERT`/`UPDATE` statements against `credit_ledger`, `jobs`, `topups`, or `profiles`. All balance mutations must use approved database functions.
- **Never Print Secrets**: Passwords, API keys, tokens, and database credentials must remain in environment variables and never be logged, committed, or typed into reports.
- **No Unchecked Merges**: Merges to `main` must use pull requests with passing CI checks. Never use `--admin` merge overrides.
