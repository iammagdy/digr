# Structural Deduplication, Factual Shortfall Without Customer Count, and Topic Strictness (DT-20261123-x-account-rumors r6)

Task: DT-20261123-x-account-rumors r6 (Non-money, LLM planning / execution quality).
Branch: `team/DT-20261123-x-account-rumors-r6` from `origin/main` (`3729b775`).
Steps & Patch: `/srv/diger-team/architect2/work/x-rumors-r6.patch` by نفادي.
Order: الكبير (msg `71e01c46-7176-43fb-9d8c-ba82c900832b`).

## Commander Design Check Amendments

1. **Structural Deduplication vs. Word Lists (`src/lib/agentMission/contract.ts`):**
   - `TEXT_ITEM_NOUNS` in `contract.ts` is kept strictly unchanged from `main` (no `خبر/مقال/تقرير/موضوع/نتيجه…`).
   - Deduplication of news and articles is purely structural via `canonicalUrlKey` (URL protocol/host lowercase, tracking parameters stripped, trailing slash removed) and `titleDedupeKey` (publisher suffixes stripped, normalized text, min 4 chars) in `agent/src/items/ingest.ts` and `agent/src/tools.ts`.

2. **Factual Shortfall Question Without Customer Count (`agent/src/llmPlanner/planner.ts`):**
   - When the customer did not specify a count (`step.count.total === null`), the prompt given to the scout question model sets `requested: null`.
   - The shortfall question text is ALWAYS the code-built factual sentence (`fallback.question_ar`, using the «جرّبنا البحث عن … فوجدنا نحو N فقط، ولا يعرض المصدر أكثر من ذلك لهذه الشروط.» template).
   - Removed any regex word matching on Arabic words (`/طلبت|من الـ/u`).

3. **Regression Guard on Review Language Clause (`agent/src/review.ts`):**
   - Kept `never reject a row because of the language it is written in or because of who published it (the customer may have named the source)` intact, preventing regressions in `tests/mission-10-units.test.ts:60`.
   - Added the topic strictness rule: a page, article, or post that merely belongs to the ministry/entity without specifically addressing rumors/misinformation receives verdict 0.

## Key Changes in r6

1. **Ingest & Tools Structural Deduplication:**
   - In `agent/src/items/ingest.ts`, incoming items are checked against `seenUrls` (via `canonicalUrlKey`) and `seenTitles` (via `titleDedupeKey`) within the parent scope before insertion. Duplicate links and titles increment duplicate tallies and are safely skipped.
   - In `agent/src/tools.ts`, `rowKeyOf(row)` prioritizes canonical URL, then normalized title via `titleDedupeKey`, before falling back to row key fields.

2. **Execution Review Strictness:**
   - `REVIEW_SYSTEM` in `agent/src/review.ts` explicitly clarifies that a page or post merely belonging to the requested entity/ministry (official homepages, general ministry announcements, preventative health tips, etc.) without addressing the specific topic constraint (rumors, denials, false claims) is 0. Both entity AND topic must be satisfied.

3. **Shortfall Honesty Without Customer Count (D-0197):**
   - When no count was requested, shortfall fallbacks state what was found without claiming the customer requested a target number.
   - Sizing in `assemblePlan` when `s.count.total === null` sizes planned rows to the deliverable sample count or bounded page reach (`Math.max(1, Math.min(b.rowsPerPage * 2, 20))`), avoiding arbitrary 20-row assumptions when fewer exist.

4. **Real-world Replay & Deduplication Fixture:**
   - Added 36-row fixture `msn_fd91804494b88c7b7d82_36_rows.json` from live runs.
   - Added tests in `tests/x-account-rumors-replay.test.ts` verifying structural deduplication collapses duplicate links and syndicated titles, and that shortfall questions never invent counts or state «طلبت» when no count was requested.

## Verification

- `tests/mission-10-units.test.ts`
- `tests/x-account-rumors-replay.test.ts`
- `tests/agent-general-checking.test.ts`
- `tests/agent-relevance-and-pricing.test.ts`
- `tests/items-store.test.ts`
- `tests/p0-research-spec.test.ts`
- `tests/review-to-completion.test.ts`
- `tests/release-text.test.ts`
- `tests/flags-off-byte-identical.test.ts`
- `NODE_OPTIONS="--max-old-space-size=4096" npm run agent:typecheck`
- `NODE_OPTIONS="--max-old-space-size=4096" npx tsc -p tsconfig.json --noEmit`
