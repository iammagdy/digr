# Diger Platform Handoff Document

This document summarizes the current architecture, deployed state, pending items, and non-negotiable operational invariants for the Diger platform.

---

## 1. Architecture Overview

- **Frontend & App Server**: Next.js 15 (React 19, Tailwind CSS v4) hosted on Vercel with Server-Side Rendering (SSR).
  - Routes: `/` (Landing/Home), `/login`, `/register`, `/dashboard/chat` (AI Discovery & Editable Plan), `/dashboard/order` (Direct Order), `/dashboard/jobs` (Results Canvas & Downloads), `/dashboard/topup` (Balance Top-up), `/admin/*` (Management, Ledger, Jobs, Provider Status).
  - API Routes: `/api/chat`, `/api/chat/accept-quote`, `/api/chat/edit-plan`, `/api/jobs/[id]/data`, `/api/jobs/[id]/methodology`, `/api/jobs/[id]/download`, `/api/worker/chunk`, `/api/cron/watchdog`.
- **Backend & Database**: Supabase PostgreSQL.
  - **Schema**: Tables include `profiles`, `templates`, `settings_public`, `settings_private`, `topups`, `credit_ledger`, `jobs`, `job_events`, `job_calls`, `capability_registry`, `plans_quotes`, `artifact_versions`, `admin_audit_log`.
  - **Atomic RPC Functions**:
    1. `accept_quote_atomic`: Atomic validation, reservation, and job creation in a single ACID transaction.
    2. `release_job_atomic`: Safe, idempotent release of reserved points when a job fails or terminates.
    3. `settle_job_atomic`: Strict release-first settlement: charge = `ceil(delivered_units * unit_price)`, capped at reservation.
    4. `approve_topup_atomic`: Admin approval with automatic ledger topup record creation.
  - **Storage Buckets**: `receipts` (private user payment receipts), `results` (final exports: XLSX, CSV, PDF, JSON), `partials` (intermediate chunk data and raw outputs).
  - **Authentication**: Supabase Auth (JWT bearer tokens and SSR cookies).
- **AI Planning Engine**: Anthropic Claude (with OpenAI fallback and deterministic `fake` fixture provider).
- **Execution & Ingestion**: TREG unified data catalog and execution API with multi-step chunked processing.
- **Reporting & Deliverables**: Professional multi-sheet Excel (Arabic RTL), CSV (UTF-8 BOM), and PDF exports matching academic standards.

---

## 2. Platform Status & Deployed Components

| Component | Status | Details |
| :--- | :---: | :--- |
| **Supabase PostgreSQL & Migrations** | Active & Versioned | 6 SQL migrations applied, RLS enabled, indexes and financial triggers verified. |
| **Atomic Financial RPCs** | Active | `accept_quote_atomic`, `release_job_atomic`, `settle_job_atomic`, `approve_topup_atomic`. |
| **Supabase Storage** | Configured | Buckets `receipts`, `results`, and `partials` configured with signed URLs and RLS. |
| **Next.js 15 Application** | Active | Fully compatible with Vercel deployment; 23 routes static/dynamic. |
| **GitHub Repository** | Synced | Target PR #43 on branch `migrate/supabase` targeting `main`. |

---

## 3. Non-Negotiable Operational Invariants

### A. Money & Ledger Invariants
1. **Deterministic Document IDs**: All financial transactions use deterministic IDs to prevent double-charging or race conditions:
   - Reserve: `res_<jobId>`
   - Release: `rel_<jobId>`
   - Charge: `chg_<jobId>`
   - Top-up: `top_<topupId>`
2. **Release-First Finish Sequence**: When settling a completed job, the ledger strictly follows:
   - Reserve: `-R`
   - Release: `+R`
   - Charge: `-C` (where `C <= R`)
3. **Hard Cap on Charges**: `chargedCredits` must NEVER exceed `reservedCredits`.
4. **Append-Only Ledger**: No updates or deletions on `credit_ledger`. All balance alterations are net sums of immutable deltas.

### B. Permission Tiers & Security
1. **Server-Only Tables & Keys**: `job_calls`, `settings_private`, and `admin_audit_log` have NO public/anon permissions.
2. **Client Write Boundary**: In `topups`, the client can only write `amount_egp`, `reference`, and `receipt_file_id`. The status is forced to `pending`. Credits are calculated server-side at approval time.
3. **Admin Verification**: Admin API routes strictly verify `app_metadata.role === 'admin'`.

### C. White-Labeling & Brand Integrity
1. **Zero Upstream Leakage**: No upstream provider names (e.g. TREG, TikHub), internal cost basis, or profit margins are ever exposed to the client or written into customer-facing outputs.
2. **Arabic-First UX**: Full RTL layout, clean Arabic typography, and factual academic methodology documentation.

### D. LLM Trust Boundary & Editable Plan
1. **Strict Plan Edits**: The LLM can never directly write to the database or trigger spend. It can only propose plan edits through typed tool schemas.
2. **Server-Side Validation**: All plan modifications are validated by server-side schemas against the capability registry before generating quotes.
3. **Quote Expiration & Hash Binding**: Every edit produces a new quote bound to a SHA-256 hash of the plan. Jobs can only start on the latest valid quote after explicit user approval.
4. **Zero Unapproved Live Spend**: Never make live paid third-party API calls without explicit user authorization.
