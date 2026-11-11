# Agent Bootstrap — Mandatory Onboarding Protocol

Every coding agent (human or AI) working on Digr MUST follow this
protocol before writing any code. It uses progressive reading: start
with the minimum, then read only what the task needs.

## Steps

1. Read `Project Atlas/README.md` — navigation, status vocabulary,
   reading order.
2. Read `Project Atlas/MASTER_HANDBOOK.md` — product, architecture,
   workflow, agent duties, approval boundaries.
3. Read `Project Atlas/GOVERNANCE.md` — non-negotiable rules
   (branches, money, security, AI boundaries, production safety).
4. Read `Project Atlas/CURRENT_STATE.md` — what is verified true now,
   including known problems and discrepancies.
5. Read `Project Atlas/WHERE_WE_STOPPED.md` — current stage, PR stack,
   risks, next priority, blocked tasks.
6. Read only task-relevant specifications:
   - UI work → `ARCHITECTURE.md` (flow) + `PRODUCT.md` (features);
     also consult the installed front-end skills.
   - Money/pricing work → `GOVERNANCE.md` §2 + `GLOSSARY.md`.
   - New capability → `PRODUCT.md` + `GOVERNANCE.md` §5.
   - Docs-only work → `README.md` (this Atlas) routing table.
7. Inspect the actual code before changing anything. Verify assumptions
   against the implementation, not against older documents.
8. Check the current PR stack (`WHERE_WE_STOPPED.md`) so the new work
   targets the correct parent branch.
9. Follow approval boundaries (`MASTER_HANDBOOK.md` §6): if the task
   touches money, permissions, infrastructure, secrets, or production
   behavior — STOP and ask the owner.
10. Update the relevant Atlas documentation in the same PR, and append
    to `CHANGELOG.md` on meaningful milestones.

## Status discipline

Never confuse REPORTED with VERIFIED, or PROPOSED with APPROVED or
DEPLOYED. When a document and the code disagree, the code and verified
runtime evidence win — record the discrepancy instead of guessing.
