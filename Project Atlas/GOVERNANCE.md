# Digr Governance

Mandatory development governance. These rules are non-negotiable.
Violations block merging.

## 1. Branches and pull requests

- All work happens on feature branches. Never commit or push to `main`.
- Open a pull request for every change, including documentation.
- Never merge a pull request. The owner merges.
- Never rebase or modify another agent's open PR without owner approval.
- PRs must be small and independently reviewable.
- Every PR description must include: changed files, test results,
  screenshots (for UI changes), and outstanding risks.
- Stacked PRs must declare their parent branch and merge order.

## 2. Financial safety

- The points ledger is **append-only**. Records are never edited or deleted.
- All financial transactions use **deterministic transaction IDs**:
  `res_<jobId>` (reserve), `rel_<jobId>` (release), `chg_<jobId>`
  (charge), `top_<topupId>` (top-up), `gwl_<jobId>` (goodwill adjustment).
- Balance calculations happen **server-side only**, with **full pagination**
  over ledger records. Never trust a client-supplied balance.
- **No duplicate charges.** Deterministic IDs make retries idempotent.
- **No negative balances.** `create-job` writes the reservation first, then
  verifies the balance across paginated records; on violation it records a
  compensating release and rejects the job (TOCTOU protection).
- **Release-first settlement:** reserve (`-R`) → release (`+R`) → charge
  (`-C`), where `C <= R` always. Final charges can never exceed reserved
  points.
- **No spending before explicit user approval.** Quotes are validated
  server-side; plan hashes (SHA-256) and 30-minute expirations are enforced.
  Jobs start only on the latest valid quote.
- Clients cannot modify ledger records. AI cannot independently calculate
  final prices or issue refunds. Refunds follow code-defined rules only.

## 3. Security and permissions

- `job_calls`, `templates_private`, and `settings` are server-only:
  no read permission for the `users` role. Server Functions access them
  with server API keys only.
- Client write boundary on `topups`: the client may write only
  `amountEgp`, `reference`, and `receiptFileId`. `status` is forced to
  `pending` on creation; `credits` are computed server-side at approval.
- Profiles are created solely by `on-user-create` on `users.*.create`;
  role is always `user`.
- Never ask for, read, print, or store secrets, tokens, API keys,
  passwords, or `.env` values — in chat, code, logs, or files.
- The client bundle is scanned at build time
  (`scripts/check-client-bundle-secrets.ts`) to prevent secret leakage.
- Customer-facing surfaces must never expose upstream provider identities,
  credentials, internal costs, margins, or endpoint identifiers.

## 4. AI trust boundaries

- The AI **proposes** (understands requests, asks questions, recommends
  capabilities, drafts plans, explains server-generated prices,
  summarizes verified results). The **server** validates, prices,
  enforces limits, controls execution, protects financial records, and
  generates deliverables.
- The AI must never: access credentials or secrets, read the internal
  ledger, see upstream costs or margins, execute unapproved paid
  operations, bypass server validation, fabricate research data, or
  decide refunds independently.
- All model outputs require schema validation before affecting behavior.
- Production must never silently fall back to fake results, and fake
  data must never be presented as real production data.
- `FAKE_MODE` is the production default until the owner approves capped
  live tests and a `LIVE_MODE` go-live.

## 5. Production safety

- No unapproved production changes: no code, config, DNS, hosting, or
  GitHub settings changes without explicit owner approval.
- No real third-party API calls (TREG, OpenAI) without explicit owner
  approval **and** a spend cap. Use fake fixtures and local mock servers
  (`scripts/fake-treg-server.ts`) for automated testing.
- No database collection or permission changes without approval.
- Do not run scripts that touch production.
- Do not modify the ledger, pricing calculations, authentication, or
  permissions in a routine change — these need dedicated review.

## 6. Documentation maintenance

- Project Atlas is the canonical documentation hub.
- Every change affecting architecture, terminology, decisions, or project
  state must update the relevant Atlas file in the same PR.
- `WHERE_WE_STOPPED.md` and `CHANGELOG.md` are updated on every
  meaningful milestone.
- `docs/HANDOFF.md` is preserved as-is.
- When documents contradict: record the discrepancy, cite evidence,
  correct only what is verified, never invent missing facts.
- Actual code and verified runtime evidence outrank any document.

## 7. Testing requirements

- Add tests for every change where applicable.
- Run `npm install`, `npm test` (vitest), TypeScript checks, and
  `npm run build` before opening a PR. All checks must pass.
- Do not introduce uncapped or production-touching tests. Automated
  tests use fake fixtures only.
- A dependency audit finding (critical/high) must be addressed or
  explicitly risk-accepted by the owner before merging.

## 8. Approval requirements

Owner approval is required before:

- Merging any PR.
- Any production change (code, config, DNS, hosting, settings).
- Any real third-party spend (always with a cap).
- Changes to pricing, ledger, auth, or permissions.
- New dependencies or infrastructure changes.
- Switching the AI assistant to `LIVE_MODE`.

When in doubt about money, permissions, infrastructure, or secrets:
**STOP and ask the owner.** A wrong guess here costs more than a delay.
