# Digr Master Handbook

The primary operating manual for coding agents working on Digr.

## 1. Product overview

Digr (دِقْر) is an Arabic-first research-data platform for students,
researchers, professors, statisticians, analysts, marketers, and content
creators.

A user talks to an AI assistant that:

1. Understands the research requirement.
2. Asks intelligent clarification questions.
3. Creates an editable research plan with a points price.
4. Requests explicit user approval before any paid collection.
5. Coordinates collection of PUBLIC data only.
6. Tracks execution progress.
7. Produces Excel, CSV, and PDF deliverables with methodology notes,
   source information, and honest data-coverage reporting.
8. Lets the customer review results, request corrections, modify
   deliverables, and commission additional collection.

Billing is points-based: **1 point = 0.10 EGP**. Top-ups are manual and
approved by an admin (Instapay receipts). The points ledger is append-only,
server-controlled, and auditable.

Customer-facing content is in Arabic. It must never expose upstream provider
identities, API credentials, internal costs, profit margins, or internal
endpoint identifiers.

## 2. Technical architecture

- **Web app:** Next.js 15 + React 19 + TypeScript + Tailwind CSS v4,
  server-side rendering, deployed via Appwrite Sites (`output: "standalone"`).
- **Backend:** Appwrite Cloud — Authentication, Databases (`digr`),
  Storage (buckets `receipts`, `results`), and server Functions
  (Node.js 22): `create-job`, `job-worker`, `approve-topup`,
  `on-user-create`, `submit-topup`.
- **Data provider:** TREG public-data API, called server-side only from
  `job-worker`. Never exposed to the client.
- **AI:** LLM integration is planned (OpenAI). Production runs in
  `FAKE_MODE` until the owner explicitly approves capped live tests.
  `LLM_PROVIDER=fake` is the default.

Key routes: `/` landing, `/login`, `/register`, `/dashboard/chat` (AI
discovery + editable plan), `/dashboard/order` (direct order),
`/dashboard/jobs` (results canvas + downloads), `/dashboard/topup`
(balance top-up), `/admin/topups` (ledger approval).

Key API routes: `/api/chat`, `/api/chat/accept-quote`,
`/api/chat/edit-plan`, `/api/jobs/[id]/data`,
`/api/jobs/[id]/methodology`, `/api/onboarding`.

See `Project Atlas/ARCHITECTURE.md` for the full request flow and
`Project Atlas/CURRENT_STATE.md` for what is verified today.

## 3. Development workflow

1. Read `Project Atlas/skills/agent-bootstrap.md` and follow it.
2. Inspect the actual code before changing anything. Verify assumptions.
3. Work on a feature branch. Never commit to `main`.
4. Keep changes small and independently reviewable.
5. Open a pull request against `main` (or the correct parent branch for
   stacked work). Never merge — the owner merges.
6. Every PR report must include: changed files, test results, screenshots
   for UI changes, and outstanding risks.
7. Update the relevant Project Atlas files in the same PR when the change
   affects architecture, terminology, decisions, or project state.

## 4. Critical project rules (summary)

The full mandatory rules live in `Project Atlas/GOVERNANCE.md`. The
short version every agent must internalize:

- **Money:** append-only ledger, deterministic transaction IDs
  (`res_<jobId>`, `rel_<jobId>`, `chg_<jobId>`, `top_<topupId>`,
  `gwl_<jobId>`), server-side balances with full pagination, no duplicate
  charges, no negative balances, release-before-charge, charges never
  exceed reserved points, no spending without explicit user approval.
- **AI boundaries:** the AI proposes; the server disposes. The AI never
  sets prices, issues refunds, reads the ledger, sees upstream costs,
  touches secrets, or triggers paid operations. All model output is
  schema-validated server-side.
- **Production safety:** no unapproved production changes, no real
  third-party calls without explicit owner approval and caps, no fake
  data presented as real results, no silently substituting fake results
  in production.
- **Secrets:** never ask for, read, print, or store secrets, tokens,
  API keys, passwords, or `.env` values.

## 5. Agent responsibilities

- Act as implementer and verifier: write code, write tests, run checks,
  report evidence.
- Translate technical findings into simple language for the owner.
- Distinguish what is proven, what is unverified, what could go wrong,
  and the single next action.
- Resolve one verified technical problem at a time; prefer small,
  reversible changes with explicit approval checkpoints.

## 6. Owner approval boundaries

The owner (Magdy) explicitly approves:

- Merging any pull request.
- Any production deployment or configuration change.
- Any real expenditure (TREG calls, OpenAI calls) — always capped tests.
- Any change to pricing, the ledger, authentication, or permissions.
- Any new dependency or infrastructure change.
- Enabling `LIVE_MODE` for the AI assistant.

If a task touches money, permissions, infrastructure, secrets, or
production behavior and approval is ambiguous: **STOP and ask.**
