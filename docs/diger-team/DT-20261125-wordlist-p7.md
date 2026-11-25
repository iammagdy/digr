# Phase 7: Ingest Reply Filter, Recovery Platform Hosts, and Workbook Bidi Cleanup

## Overview
Phase 7 cleans execution-layer keyword and regex dependencies across:
1. `agent/src/items/ingest.ts`: Replaces regex matching against Arabic column titles with key-only regex matching against English slug keys (`description`, `bio`, `about`, `summary`, `overview`), and makes the reply filter generic across compiled platforms without hardcoding `"x"`.
2. `agent/src/companyPeopleRecovery.ts`: Backs platform hosts with a clean data file `data/capabilities/platform-hosts.json` (12 hosts) instead of hardcoded Sets or regexes. Preserves `«شركة»` (L411) and `/مدير/` (L1054) verbatim as guarded by rules C8 and C9.
3. `agent/src/workbook.ts`: Eliminates `NAME_TITLE` regex by expanding `NAME_KEY` to include `person|person_?name`, attaches `key: pc.key` to context columns, recognizes `kind === "context"` in `isMetaColumnKey`, and matches delivery contract summary line using `startsWith("تم تسليم")` per correction K1.
4. `tests/execution-cleanup-wave2.test.ts`: Regression suite verifying the cleanups and counter-cases.

## Evidence & Verifications
- **Targeted Test Suites:**
  - `tests/x-account-rumors-replay.test.ts` (54/54 passed)
  - `tests/fx-m1-workbook-billing.test.ts` (5/5 passed)
  - `tests/mission-12-replay.test.ts` (16/16 passed)
  - `tests/round14-contract-unit.test.ts` (12/12 passed)
  - `tests/execution-cleanup-wave2.test.ts` (4/4 passed)
- **Typechecks:**
  - `npm run agent:typecheck`: exit 0
  - `tsc --noEmit`: exit 0
- **Recorded Replays (5/5 runs each):**
  - `msn_c41586cf9d40986250d0`: 5/5 PASSED (examined=40, accepted=0, card=0, delivered=0, $0 cost)
  - `msn_f91f7e220bbf60fd7c9c`: 5/5 PASSED (examined=16, accepted=2, question=2, card=2, delivered=2, accepted_ids == delivered_ids == [row_7, row_12], $0 cost)
