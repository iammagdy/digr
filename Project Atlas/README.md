# Project Atlas — Digr Governance System

Project Atlas is the central documentation, governance, architectural knowledge,
terminology, and AI-agent onboarding system for Digr.

**Purpose:** any coding agent — human or AI — must be able to understand the
project, follow established decisions, respect safety boundaries, and continue
development without losing context or repeating previous mistakes.

## How coding agents should use Atlas

1. Start at `Project Atlas/skills/agent-bootstrap.md` and follow the onboarding
   protocol. It defines the mandatory reading order using progressive reading:
   read the minimum first, then only task-relevant specifications.
2. Never change code before inspecting the actual code.
3. Never assume a feature mentioned in a PR, a document, or a conversation is
   deployed. Statuses are defined below and must never be confused.

## Status vocabulary (never confuse these)

| Status               | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| VERIFIED             | Confirmed by direct inspection (code, API, CI, console).        |
| REPORTED             | Claimed by an agent or document, not yet independently checked. |
| PROPOSED             | Suggested, not approved.                                       |
| APPROVED             | Owner explicitly approved.                                     |
| IMPLEMENTED          | Code exists on a branch or in main.                            |
| TESTED               | Automated tests exist and pass (state where).                  |
| DEPLOYED             | Running in the production environment.                         |
| PRODUCTION_VERIFIED  | Confirmed working in production with real evidence.            |

## Mandatory reading order (progressive)

1. `Project Atlas/README.md` (this file) — navigation.
2. `Project Atlas/MASTER_HANDBOOK.md` — how Digr works and how we work.
3. `Project Atlas/GOVERNANCE.md` — non-negotiable rules.
4. `Project Atlas/CURRENT_STATE.md` — what is true right now.
5. `Project Atlas/WHERE_WE_STOPPED.md` — handover: what is next.
6. Only the task-relevant specifications after that.

## Where each type of information belongs

| Information type                                  | Canonical home                        |
| ------------------------------------------------- | ------------------------------------- |
| Navigation, reading order, status vocabulary       | `Project Atlas/README.md`             |
| Product + architecture + workflow + agent duties   | `Project Atlas/MASTER_HANDBOOK.md`    |
| Mandatory rules (branches, money, security, AI)   | `Project Atlas/GOVERNANCE.md`         |
| Canonical terms (code + Arabic customer terms)    | `Project Atlas/GLOSSARY.md`           |
| Verified current system, evidence, known problems | `Project Atlas/CURRENT_STATE.md`      |
| Living handover: stage, PRs, risks, next priority | `Project Atlas/WHERE_WE_STOPPED.md`   |
| System architecture: actual vs planned            | `Project Atlas/ARCHITECTURE.md`       |
| Product goals, personas, proposed vs implemented  | `Project Atlas/PRODUCT.md`            |
| Architectural and business decisions              | `Project Atlas/DECISIONS.md`          |
| Chronological history                             | `Project Atlas/CHANGELOG.md`          |
| Agent onboarding protocol                         | `Project Atlas/skills/agent-bootstrap.md` |

## Relationship to existing documentation

- `docs/HANDOFF.md` is preserved as-is. It is the deployment-focused handover.
  Atlas is the governance hub and references it; it does not replace it.
- `README.md` (repository root) remains the developer entry point and links here.
- When Atlas and an older document contradict: record the discrepancy in the
  relevant Atlas file, cite evidence, and correct only what is verified.
  Never silently invent missing facts.
- Actual code and verified runtime evidence take precedence over any document,
  including this one.

## Maintenance

- Atlas is a living system. Every code change that affects architecture,
  terminology, decisions, or project state must update the relevant Atlas file
  in the same pull request.
- `WHERE_WE_STOPPED.md` and `CHANGELOG.md` are updated on every meaningful
  milestone.
- Documentation-only pull requests are welcome and follow the same
  branch → PR → owner-review → owner-merge workflow as code.
