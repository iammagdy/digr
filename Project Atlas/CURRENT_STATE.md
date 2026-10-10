# Digr Current State

Verified current system. Every claim is labeled with its status — see
`Project Atlas/README.md` for the status vocabulary. Evidence date:
**2026-10-11** unless stated otherwise.

## Architecture (VERIFIED via repository inspection)

- **Web app:** Next.js 15.4.8, React 19.1.2, TypeScript 5.9.3,
  Tailwind CSS v4. Source layout: `src/app` (routes + API routes),
  `src/lib` (`appwrite.ts`, `constants.ts`), `src/hooks` (`useUser.tsx`),
  `src/functions` (Appwrite Functions source), `src/assets`.
- **Scripts:** `npm test` → `vitest run`; `npm run build` →
  `next build && tsx scripts/check-client-bundle-secrets.ts`
  (client-bundle secret scan is part of every build).
- **Appwrite config:** `appwrite.json` declares project `6ac947090008606ef482`
  ("Digr") with functions `on-user-create`, `submit-topup`,
  `approve-topup`, `create-job`, `job-worker` (Node.js 22 runtime).
- **Database:** database `digr` exists and is `ready` (VERIFIED via
  Appwrite API, 2026-10-11). Collections per `docs/HANDOFF.md`
  (REPORTED): `profiles`, `templates`, `templates_private`, `settings`,
  `topups`, `credit_ledger`, `jobs`, `job_events`, `job_calls`,
  `capability_registry`. Buckets `receipts`, `results` (REPORTED).
- **Tests:** 11 test files in `tests/` (VERIFIED present):
  `chat-discovery-ui`, `ledger`, `methodology`, `p1-arabic-requests`,
  `p1-capabilities-quotes`, `p1-chat-auth-and-limits`,
  `p1-llm-trust-boundary`, `p2-execution-and-plans`,
  `phase-a-permissions`, `strict-no-fake`, `treg`.

## Implemented functionality

- Foundation (auth, onboarding, chat, editable plans, manual top-ups,
  job execution, file generation, result presentation): IMPLEMENTED per
  `docs/HANDOFF.md` (REPORTED; not independently re-verified here).
- Financial invariants (deterministic IDs, release-first settlement,
  TOCTOU protection): IMPLEMENTED per `docs/HANDOFF.md` and
  `tests/ledger.test.ts` (REPORTED).
- 5 Appwrite Functions deployed and active: REPORTED in
  `docs/HANDOFF.md` (not independently verified in this task).

## PR status (VERIFIED via GitHub API, 2026-10-11)

| PR | State  | Merged | Branch → Base                              | Title                                    |
| -- | ------ | ------ | ------------------------------------------ | ---------------------------------------- |
| #1 | closed | no     | `fix/chat-discovery-ui` → `main`           | Fix chat discovery questions and mobile layout |
| #2 | closed | no     | `fix/hermetic-auth-tests` → `main`         | test: make auth checks hermetic          |
| #3 | open   | —      | `feat/discovery-question-cards` → `main`   | A: Typed discovery question cards        |
| #4 | open   | —      | `feat/persona-modules` → `feat/discovery-question-cards` | B: Persona-aware assistant modules |
| #5 | open   | —      | `feat/result-review` → `feat/persona-modules` | C: Result review and versioned artifact edits |
| #6 | open   | —      | `feat/goodwill-refunds` → `feat/result-review` | D: Bounded goodwill refunds and notifications |
| #7 | open   | —      | `feat/dependent-plans` → `feat/goodwill-refunds` | E: Bounded dependent plans (fake-fixture only) |
| #8 | open   | —      | `feat/openai-readiness` → `feat/dependent-plans` | F: OpenAI go-live safeguards and readiness |
| #9 | open   | —      | `feat/visual-polish` → `feat/openai-readiness` | G: Responsive chat and accessibility polish |

**Discrepancy — PR #2:** previously REPORTED as "merged". GitHub API
shows `state=closed, merged=false`. It is not known from available
evidence whether its changes reached `main` by another path. Owner to
confirm.

## Existing limitations (VERIFIED/REPORTED)

- AI assistant runs in `FAKE_MODE` in production (REPORTED). Real
  OpenAI calls require explicit owner approval and capped tests.
- Real TREG calls require explicit owner approval (REPORTED).
- Only the `tiktok-profile` capability is verified active; others are
  "coming soon" (REPORTED in `docs/HANDOFF.md`).
- Appwrite Sites live SSR verification: pending (REPORTED).
- End-to-end live extraction test: pending, awaiting spend approval
  (REPORTED).

## Known problems

- PR #2 merge-status discrepancy (see above). Needs owner confirmation.
- Dependency audit findings (6 incl. 2 critical + 2 high) were REPORTED
  on 2026-10-11; independent verification not established in this task.
- Test count claim ("153 passing tests, 20 files") was REPORTED by a
  coding agent; the repository currently contains 11 test files on
  `main`. Treat the claim as UNVERIFIED until CI evidence is reviewed.
