# LLM Planner Simplest Query Forms, Bounded Paging, Judge Strictness & Honesty (DT-20261123-x-account-rumors r4+r5)

Task: DT-20261123-x-account-rumors r4 + r5 (Non-money, LLM planning / execution quality).
Branch: `team/DT-20261123-x-account-rumors-r4` from `origin/main` (`0d4e7445`).
Steps & Patches: `/srv/diger-team/architect2/work/x-rumors-r4.patch` and `/srv/diger-team/architect2/work/x-rumors-r5.patch` by نفادي.
Order: الكبير (combined order, msgs `c16c51f0-f0c0-4ab6-942b-583dfceb4553`, `2bc13841-b777-45f6-99d2-0b6d8b1c3f77`, `5f3ca011-f546-4edd-9b7b-102c5dafcc32`).
Design Check Amendment: Kept `TEXT_ITEM_NOUNS` in `contract.ts` unchanged; news deduplication relies structurally on `rowKeyOf(row)` matching normalized `title` (via `textDedupeKey` with publisher suffix stripped) and URLs (`link`/`url`/`canonical_url`).

## Live Root Cause

Following the deployment of r3, live testing and team investigation revealed several quality gaps:
1. **Search Single-Page Limitation & Thin Samples:** Search endpoints returning thin pages or multi-page results were evaluated solely on their first page; if page 1 had fewer than expected matches, the planner risked prematurely declaring shortfalls or under-sizing cards without traversing available pagination cursors.
2. **Provider Query Form Rejection:** Search providers frequently rejected complex or over-specified query structures (such as boolean OR expressions, quotes, or redundant date constraints), resulting in HTTP 400 bad_input errors.
3. **Judge Leniency on Off-Country / Off-Entity News:** News search queries frequently returned items about another country's entity (e.g. Egyptian Ministry of Health rumor denials when the customer requested Saudi Ministry of Health). A lenient judge accepted off-target rows.
4. **News Duplication Across Providers/Syndication:** Multiple articles across news syndication networks carried identical headlines with differing publisher suffixes (e.g. " - مصراوي" or " - الوطن"). Without suffix stripping and title-based row keys, near-identical duplicate articles were included.
5. **Count Shortfalls vs. Megz D-0197 Honesty:** When a source only holds $N$ true matches (e.g. 7 out of 20 requested), the customer must be presented with an honest choice: accept the actual $N$ found («سلّمني الـ٧» / «سلّمني الـN») or widen to other platforms/catalog sources. Choosing $N$ sizes the card to $N$, delivers $N$, and charges $N$.

## What Changes in r4 + r5

1. **Simplest Accepted Query Forms (r4):**
   - Prompt guidance and parameter rewrite logic prioritize the simplest valid query form accepted by search providers, eliminating complex boolean operators, quotes, parentheses, and dates that trigger 400 errors.
2. **Bounded Cursor Paging with Model Judge (r4):**
   - If more pages exist and either 0 matches were found so far or the initial sample is thin (`< THIN_PAGE_ROWS`), the planner actively follows pagination cursors (`next_cursor`), evaluating sample rows with `judge_sample`.
   - Cursor traversal is strictly bounded by `maxWindowPages` (up to 4 additional pages), preventing infinite loops.
   - Absent or failing model judge safely falls back to preserving rows.
3. **Strict All-Constraints Evaluation (r5):**
   - Both planning-time sample judging (`judge_sample`) and execution-time review (`REVIEW_SYSTEM`) enforce ALL constraints of the request: entity, account, country, and topic.
   - Items from another country's entity (e.g. Egyptian MOH instead of Saudi MOH) or off-target entities are rejected with verdict 0.
4. **Structural Deduplication by Title & Canonical URL (r5):**
   - `textDedupeKey` strips trailing publisher suffixes (` - اليوم السابع`, ` | سكاي نيوز`, etc.) from titles.
   - `rowKeyOf(row)` in `tools.ts` and `planner.ts` maps rows by normalized `title:<textKey>` before other fields, and checks `canonical_url ?? url ?? link`.
   - Per Commander's design check, `TEXT_ITEM_NOUNS` in `contract.ts` is preserved as-is.
5. **Shortfall Honesty Over Count (r5 / Megz D-0197):**
   - When real searches exhaust with fewer items than requested, prompts explicitly present option 1 as «سلّمني الموجود فقط» or «سلّمني الـN» naming the exact number found.
   - When accepted, the plan sizes the card to $N$, delivers $N$, and charges $N$, with an honest explanatory assumption.

## Verification

Full suite of planner-importing test files, catalog reach, regression guards, and TypeScript checks:
- All 31 test files importing `llmPlanner/planner.ts` or `catalogView.ts`
- `tests/release-text.test.ts`
- `tests/planner-web-and-engines.test.ts`
- `tests/flags-off-byte-identical.test.ts`
- `tests/x-account-rumors-replay.test.ts` (all r1-r5 tests passing, including deduplication, strict judge, and D-0197 shortfall)
- `npm run agent:typecheck`
- `npx tsc -p tsconfig.json --noEmit`
