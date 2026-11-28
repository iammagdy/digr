# Task Record: DT-20261128-treg-company-tools (Plan v1.2) — PR-1

## 1. Overview and Decisions
- **Task ID:** `DT-20261128-treg-company-tools`
- **Decisions:** D-0263, D-0264, D-0265, D-0267
- **Plan Version:** v1.2 (Section "PR-1 — G1a + G1b, shared dormant catalog admission")
- **Base Commit:** `370f2d5ec66a67dde131d930ff01534b24014b64`
- **Implementer (PR-1):** Developer (FAWAALY-2)

## 2. Pinned Bytes and Checksums
- `data/treg/treg_catalog_sellable.json`:
  - SHA-256: `5d8a125d5a563d892cfabceef2a21a0429191bba8017e2707d1bf626035315cc`
  - Count: 3,276 endpoints (excluded: own_account 652, write 29, paused 12)
- `data/treg/treg_write_actions.json`:
  - SHA-256: `0570489d74ee86b4abc14e7e66764546cbb0eae924c63d2518823ed179754909`
  - Count: 276 write actions
- `data/treg/data_policy.json`:
  - Counts: `{ public: 2993, b2b_contact: 231, sensitive: 50, blocked: 278 }`
  - Total classified: 3,552
- `data/treg/treg_catalog_index.json`:
  - Pinned index matching source snapshot

## 3. Denominator Distinction: Bundled Snapshot vs Effective Runtime
- **Bundled Snapshot:**
  - Pinned baseline catalog input (`treg_catalog_sellable.json`), exactly 3,276 endpoints.
  - Used for static checksum assertions, weekly rebuild comparisons, and baseline pricing sync tests.
- **Effective Runtime:**
  - Evaluated in-memory catalog composed of the verified bundled snapshot plus valid entries from `sellable_additions.json`.
  - In PR-1 and PR-2, `sellable_additions.json` ships dormant and empty (`{"version":1,"entries":[]}`), so effective runtime count equals bundled snapshot count (3,276).
  - A custom `dir` fixture cannot mint transport authority and loads only its local base without merging runtime additions.

## 4. PR Sequence and Dormant State
- **PR-1 (Developer / FAWAALY-2):** G1a + G1b shared dormant catalog admission (exactly 6 files):
  1. `data/treg/sellable_additions.json` (NEW, `{"version":1,"entries":[]}`)
  2. `src/lib/treg/blockList.ts` (validateCatalogAdditions pure validator, cycle-free policy check)
  3. `src/lib/treg/dataPolicy.ts` (consults validated additions, classifies explicit public)
  4. `src/lib/treg/catalog.ts` (in-memory merge for verified bundled snapshot, contract normalization)
  5. `tests/treg-catalog-additions.test.ts` (NEW unit test suite covering validation, boundaries, and empty manifest)
  6. `docs/diger-team/tasks/DT-20261128-treg-company-tools/plan.md` (NEW task record)
- **PR-2 (Lead Architect / ARCHITECT):** G2 + G3 funded worker and engine routing (12 files, manifest remains empty).
- **PR-3 (separate CTO GO required):** A activation of the 4 approved entries (3 files).

## 5. Rollback Plan
- Reverting additions: Emptying `data/treg/sellable_additions.json` returns effective runtime to base 3,276 endpoints immediately with zero code changes.
- PR rollback: Revert PRs in reverse dependency order (PR-3 -> PR-2 -> PR-1).
- Invariants: No changes to ledger, points, pricing, SQL migrations, database tables, or production feature flags.

## 6. PR-2 funded execution and planning

- Plan v1.2 G2.1–G2.7 and G3.1–G3.6, including D-0267 G2.5a. The approved PR-1 head is `5f03ad4ce2057beeeb542e742927153d06a5fd97`. The branch also incorporates main through `5a73861b`.
- A tagged paid request needs a funded preflight and a strict persisted reservation before dispatch. The transport permit is single-use. Unprovable journal exposure leaves zero paid capacity for funded, legacy, and web routes in that phase. A proven-empty journal preserves ordinary routing.
- Company search estimates use validated free helpers. Funded delivery uses the trusted adapter contract and canonical domain identity. Fixtures cover delivered-only settlement and full release when nothing is delivered.
- The manifest remains empty. The company phone endpoint is disabled. Activation requires a separate CTO GO.
