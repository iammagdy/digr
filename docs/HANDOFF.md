# Digr Platform Handoff Document

This document summarizes the current architecture, deployed state, pending items, and non-negotiable operational invariants for the Digr project.

---

## 1. Architecture Overview

- **Frontend & App Server**: Next.js 15 (React 19, Tailwind CSS v4) with Server-Side Rendering (SSR) deployed via Appwrite Sites (`output: "standalone"`).
  - Routes: `/` (Landing/Home), `/login`, `/register`, `/dashboard/chat` (AI Discovery & Editable Plan), `/dashboard/order` (Direct Order), `/dashboard/jobs` (Results Canvas & Downloads), `/dashboard/topup` (Balance Top-up), `/admin/topups` (Ledger Approval).
  - API Routes: `/api/chat`, `/api/chat/accept-quote`, `/api/chat/edit-plan`, `/api/jobs/[id]/data`, `/api/jobs/[id]/methodology`, `/api/onboarding`.
- **Backend Services**: Appwrite Cloud (`cloud.appwrite.io/v1`).
  - **Database (`digr`)**: Collections include `profiles`, `templates`, `templates_private`, `settings`, `topups`, `credit_ledger`, `jobs`, `job_events`, `job_calls`, `capability_registry`.
  - **Storage Buckets**: `receipts` (user payment receipts), `results` (export files: CSV, JSON, PDF).
  - **Serverless Functions**: 5 Appwrite Cloud Functions running Node.js 22 runtime:
    1. `job-worker`: Background multi-step job processor with live event streaming and artifact generation.
    2. `create-job`: Server-side quote verification, ledger reserve, and job enqueueing.
    3. `on-user-create`: Automated profile creation triggered by Appwrite Auth user creation.
    4. `submit-topup`: Safe deposit receipt submission.
    5. `approve-topup`: Admin top-up approval and ledger credit calculation.

---

## 2. What Is Deployed

| Component | Status | Details |
| :--- | :---: | :--- |
| **Appwrite Functions** | Deployed & Active | All 5 functions deployed to Appwrite Cloud with required execution scopes. |
| **Appwrite Database** | Configured | All collections, schemas, indexes, and document permission rules applied. |
| **Appwrite Storage** | Configured | Buckets `receipts` and `results` configured with size and MIME restrictions. |
| **GitHub Repository** | Synced | Private repo `iammagdy/digr` on branch `main`. |
| **Appwrite Sites** | Configured for SSR | Standalone output enabled in `next.config.mjs`, adapter set to SSR. |

---

## 3. What Is Pending

1. **Appwrite Sites Live Verification**: Confirm Appwrite Sites successfully serves the live domain with SSR enabled once the latest commit build completes.
2. **End-to-End Live Test**: Run a single live extraction test on the deployed stack with a test account (awaiting explicit user approval for real TREG/OpenAI spend).
3. **Additional Capability Providers**: Activate X and YouTube capabilities after real-cost benchmarking (currently only verified `tiktok-profile` is active in the capability registry; others are marked "coming soon").

---

## 4. Non-Negotiable Rules & Invariants

### A. Money & Ledger Invariants
1. **Deterministic Document IDs**: All financial transactions use deterministic IDs to prevent double-charging or race conditions:
   - Reserve: `res_<jobId>`
   - Release: `rel_<jobId>`
   - Charge: `chg_<jobId>`
2. **Release-First Finish Sequence**: When settling a completed job, the ledger strictly follows:
   - Reserve: `-R`
   - Release: `+R`
   - Charge: `-C` (where `C <= R`)
3. **Hard Cap on Charges**: `chargedCredits` must NEVER exceed `reservedCredits`.
4. **TOCTOU Protection**: In `create-job`, the reservation entry is written FIRST, then the user balance is verified across paginated ledger records. If the balance becomes negative, a compensating release is immediately recorded and the job is rejected.

### B. Permission Tiers & Security
1. **Server-Only Collections**: `job_calls`, `templates_private`, and `settings` have NO read permissions for the `users` role. They are accessible only by server Functions using Appwrite Server API keys.
2. **Client Write Boundary**: In `topups`, the client can only write `amountEgp`, `reference`, and `receiptFileId`. The `status` field is forced to `pending` upon creation. `credits` are calculated server-side at approval time by `approve-topup`.
3. **Profile Creation**: Profiles are created solely by the `on-user-create` function triggered by `users.*.create`. Role is always set to `user`.

### C. White-Labeling & Brand Integrity
1. **Zero Upstream Leakage**: No upstream provider names (e.g. TREG), internal cost basis, or profit margins are ever exposed to the client or written into client-accessible collections.
2. **Arabic-First UX**: Consistent RTL layout with verified font rendering, clean Arabic typography, and factual methodology notes free of marketing buzzwords.

### D. LLM Trust Boundary & Editable Plan
1. **Strict Plan Edits**: The LLM can never directly write to the database or trigger spend. It can only propose plan edits through the typed `edit_plan` tool schema.
2. **Server-Side Validation**: All plan modifications are validated by server-side schemas against the capability registry before updating quotes.
3. **Quote Expiration & Hash Binding**: Every edit produces a new quote (30-minute expiry) bound to a SHA-256 hash of the plan. Jobs can only start on the latest valid quote. Nothing is reserved or spent prior to the customer explicitly clicking "Start".

### E. Operational Guardrails
1. **No Unapproved Live Spend**: Never make real TREG or OpenAI API calls without explicit, direct user authorization. Use fake fixtures and local mock servers for all automated testing.
2. **Zero Secrets in Code**: Never commit, log, or leak API keys, tokens, or private environment variables into the repo or client bundles.
3. **No Machine or DNS Alterations**: Never modify host OS, network, firewall, DNS, or browser settings.
