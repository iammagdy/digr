# DT-20261123-design-guards (D-0199 Point 3: Design Guard Tests)

- **Date:** 2026-11-23
- **Author:** العترة (FAWAALY-3)
- **Branch:** `team/DT-20261123-design-guards`
- **Base Commit:** `b1cb521fe3dc525ae81019f7ec33c4e7e3ea8f04` (origin/main)
- **Status:** DRAFT PR (Early Draft Push per D-0199)

## Purpose & Scope
Implements automated design guards scanning all source files under `src/` and `agent/src/` (excluding `tests/`, `data/`, `docs/`) to detect and fail on design regressions:
1. **Arabic Regex Literals / RegExp()**: Regex literals or `RegExp()` calls whose patterns contain Arabic letters (word-list matching of customer text), guarding against hardcoded arabic keyword lists.
2. **Hardcoded Endpoint / Provider IDs**: Any endpoint ID or provider ID from `data/treg/*.json` matched as whole tokens in string literals, guarding against hardcoded provider/platform names (D-0086 / D-0198).
3. **Local Server Paths**: Any string literal containing `«/srv/»`, guarding against hardcoded local server paths.
4. **Fallback Array Literals**: Array literals of 4+ short lowercase parameter-like strings used as fallback via `.find(` or `.some(`.

## Components
- `tests/designGuardsScanner.ts`: Fast AST-based scanner and token parser with allow-list indexing and whole-token matching.
- `tests/design-guards.test.ts`: Test suite containing:
  - 4 unit test cases with fixture code strings verifying that each detector fires and reports `file:line`.
  - Full codebase regression test scanning all 1,213 source files in `< 5s`.
  - Baseline allow-list integrity test.
- `tests/fixtures/design-guards-allow.json`: Explicit baseline allow-list capturing existing legacy occurrences on current main so current main passes green; any new occurrence fails.

## Zero Production Code Changes
Touches strictly `tests/` and `docs/`. Zero production code modified.
