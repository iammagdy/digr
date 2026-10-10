# Digr Platform Handoff

This document records the repository architecture, the last read-only public deployment check, and operational items that remain with the owner. It is not authorization to change production.

## 1. Architecture

- **Web app:** Next.js 15, React 19, Tailwind CSS v4; Appwrite Sites SSR with `output: "standalone"`.
- **Appwrite endpoint:** `https://fra.cloud.appwrite.io/v1`.
- **Project database:** `digr`.
- **Appwrite Functions source folders:** `create-job`, `job-worker`, `on-user-create`, `submit-topup`, and `approve-topup`; common server logic is in `src/functions/shared`.
- **Current API routes:** `/api/chat`, `/api/chat/metadata`, `/api/chat/accept-quote`, `/api/chat/edit-plan`, `/api/jobs/[id]/data`, `/api/jobs/[id]/artifacts`, `/api/jobs/[id]/methodology`, `/api/jobs/[id]/complaint`, `/api/notifications`, `/api/admin/goodwill`, and `/api/onboarding`.

## 2. Appwrite schema recorded in `scripts/setup-db.ts`

The idempotent setup script defines these tables in database `digr`:

`templates`, `settings_public`, `profiles`, `credit_ledger`, `topups`, `jobs`, `job_events`, `conversations`, `messages`, `plans_quotes`, `artifact_versions`, `notes`, `capability_requests`, `templates_private`, `settings`, `job_calls`, `notifications`, `jobs_internal`, `capability_registry`, and `llm_usage`.

It defines these storage buckets:

| Bucket | Allowed file extensions |
|---|---|
| `results` | `xlsx`, `pdf`, `csv` only |
| `receipts` | `png`, `jpg`, `jpeg`, `pdf` |
| `partials` | `jsonl` |

The results bucket does not permit JSON. Schema definitions in this repository are not proof that the corresponding production schema has been applied. Review the full script before an authorized operator runs it; never run it against the live project as part of local development.

## 3. Deployment status and pending owner actions

- **Public read-only check:** on 2026-10-10, `https://digr.thewise.cloud` returned HTTP 200 from Appwrite Sites. This verified public site reachability only; it did not test authentication, Functions, database permissions, or create any production data.
- **This feature stack is not deployed:** branches and pull requests remain pending owner review and merge. Do not push to `main` or merge PRs on the owner's behalf.
- **Section D schema step:** `notifications` is defined in the setup script for goodwill notices/review-queue storage. The owner or an authorized operator must review the complete script and apply the required schema through the approved operational procedure, then verify user-read/server-write permissions before setting `GOODWILL_ENABLED=true`. This task did not run a setup script on production.
- **OpenAI go-live:** `LLM_PROVIDER=fake` remains the safe development default. The owner must review and merge the stack, configure server-side variables and the `llm_usage` table, and explicitly authorize any live model smoke test. See [GO_LIVE.md](GO_LIVE.md). No live model request was made during development.
- **Data providers:** dependent-plan execution remains fake-fixture-only. No real provider capability was enabled and no live provider request was made.
- **Stacked PR merge order:** #3 (A) → #4 (B) → #5 (C) → #6 (D) → #7 (E) → #8 (F) → #9 (G). Each section after A targets the preceding section branch.

## 4. Non-negotiable invariants

### Money and ledger

- Ledger operations are append-only, use deterministic IDs, release before charge, and never charge more than the reserved amount.
- Balances are computed server-side from complete pagination. Delivery-based proportional settlement must not be duplicated by goodwill refunds.
- Only the section D code path is authorized for goodwill adjustments; other sections must not alter ledger behavior.

### Permissions and security

- Do not weaken collection permissions, expose server-only records, or place a secret in client-visible configuration, source, or logs.
- Model output is untrusted and cannot write to the database, start collection, or spend points. Any newly chargeable work requires a new quote and explicit user approval.
- Production account access, if used, is read-only. Do not visit `/admin/*`, create a job/plan, change settings, or modify onboarding data.

### White-label and local testing

- Customer-facing copy remains Arabic and RTL, with no provider names, internal costs, or unsupported completeness claims.
- Use fake fixtures and network mocks for tests. Do not contact live TREG or OpenAI during development.
- Do not change DNS, hosting, GitHub settings, Appwrite Console settings, collections, or permissions as part of this task.
