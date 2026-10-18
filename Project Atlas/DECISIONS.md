# Digr Decisions

Architectural and business decisions. Status is one of:
APPROVED, IMPLEMENTED, PENDING, SUPERSEDED.
Unapproved decisions stay PENDING.

## D-001 — Points-based billing (1 point = 0.10 EGP)
- **Date:** before 2026-10 (foundation).
- **Reason:** simple, transparent internal unit; manual Instapay top-ups.
- **Status:** APPROVED + IMPLEMENTED.
- **Evidence:** `credit_ledger` collection, top-up flow in app.
- **Affects:** pricing, ledger, UI.

## D-002 — Append-only ledger with deterministic transaction IDs
- **Date:** before 2026-10 (foundation).
- **Reason:** prevent double charging and race conditions; make retries
  idempotent (`res_` / `rel_` / `chg_` / `top_` / `gwl_` + job/topup ID).
- **Status:** APPROVED + IMPLEMENTED.
- **Evidence:** `tests/ledger.test.ts`, `src/functions/shared/ledger`.
- **Affects:** `create-job`, `approve-topup`, `job-worker`.

## D-003 — Fake-mode default for AI and data calls
- **Date:** before 2026-10 (foundation).
- **Reason:** no uncapped third-party spend; all automated tests use
  fixtures (`LLM_PROVIDER=fake`).
- **Status:** APPROVED + IMPLEMENTED.
- **Evidence:** `README.md` env docs, `scripts/fake-treg-server.ts`.
- **Affects:** `/api/chat`, `job-worker`.

## D-004 — Branch → PR → owner-merge workflow
- **Date:** before 2026-10 (foundation).
- **Reason:** nontechnical owner supervises via PRs; agents never merge.
- **Status:** APPROVED + IMPLEMENTED (process).
- **Affects:** all development.

## D-005 — Server-only provider calls (TREG)
- **Date:** before 2026-10 (foundation).
- **Reason:** protect credentials and costs; white-label requirement.
- **Status:** APPROVED + IMPLEMENTED.
- **Affects:** `job-worker`, client bundle.

## D-006 — Project Atlas as governance hub
- **Date:** 2026-10-11.
- **Reason:** agents were losing context across sessions; decisions,
  terminology, and safety rules needed one canonical home.
- **Status:** APPROVED (owner task) + IMPLEMENTED (this PR).
- **Affects:** all future development and documentation.

## D-007 — Cost-based pricing model (10x multiplier) — PROPOSAL
- **Date:** 2026-10-11 (proposal).
- **Reason:** owner is considering cost-based pricing: selling price =
  10x of (upstream API cost + AI processing cost + operational cost).
- **Status:** PENDING — business proposal only. NOT approval to change
  production pricing. No implementation in this task.
- **Affects (if approved):** pricing engine, quotes, UI copy.
