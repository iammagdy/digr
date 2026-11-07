# Digr Architecture

## Request flow

```
User
  → AI Assistant (chat, discovery questions, editable plan)
  → Server Validation (schemas, capability registry, plan hash)
  → Pricing Engine (server-side quote, 30-min expiry)
  → User Approval (explicit "Start" — nothing reserved before this)
  → Job Worker (multi-step execution, activity events)
  → Data Provider (TREG, server-side only)
  → Artifact Generation (Excel / CSV / PDF + methodology)
  → Results Canvas (review, corrections, downloads)
```

## Actual implementation vs planned architecture

### Implemented (per docs/HANDOFF.md — REPORTED)

- Next.js 15 SSR app on Appwrite Sites; routes for landing, auth,
  chat, order, jobs, top-up, and admin top-up approval.
- API routes: `/api/chat`, `/api/chat/accept-quote`,
  `/api/chat/edit-plan`, `/api/jobs/[id]/data`,
  `/api/jobs/[id]/methodology`, `/api/onboarding`.
- Appwrite Functions: `create-job` (quote verification + reserve),
  `job-worker` (execution + artifacts), `approve-topup` (manual
  top-up approval), `on-user-create` (profile bootstrap),
  `submit-topup` (receipt submission).
- Points ledger (`credit_ledger`) with deterministic IDs and
  release-first settlement.
- Fake-mode AI assistant and fake TREG fixtures for development.

### Planned / not yet live

- Real OpenAI assistant (`LIVE_MODE`): PROPOSED, requires owner
  approval + spend caps + safety checks.
- Real TREG data collection end-to-end: PROPOSED, requires owner
  approval.
- Additional capabilities (X, YouTube): PROPOSED, pending
  real-cost benchmarking. Only `tiktok-profile` is verified active.
- Real-time Activity Canvas (live stage/query/source/progress as
  specified in the task brief): PROPOSED — current activity
  capabilities are limited to stored `job_events`; all future
  activity data must come from actual server-side execution events,
  never fabricated.

## Key invariants in the flow

- The assistant never writes to the database and never triggers spend;
  it proposes plan edits through the typed `edit_plan` schema only.
- Every plan edit produces a new server-side quote bound to a SHA-256
  `PLAN_HASH` with 30-minute expiry. Jobs start only on the latest
  valid quote.
- Pricing is computed server-side. The AI explains estimates; it never
  determines chargeable amounts.
- The data provider is called server-side only. No provider identity,
  cost, or endpoint ever reaches the client.
- Deliverables are generated server-side with methodology and honest
  coverage reporting (`COLLECTED_COUNT` vs `AVAILABLE_COUNT`).
