# Where We Stopped

Living project handover. Keep concise; update on every milestone.
Last updated: **2026-10-11**.

## Current stage

Foundation is implemented on `main`. Seven feature PRs (#3–#9) are open
and stacked; nothing from the stack has merged yet.

## PR dependencies (stack order)

`#3` → `#4` → `#5` → `#6` → `#7` → `#8` → `#9`
(each targets the previous PR's branch; only #3 targets `main`)

## Pending reviews

- **PR #3** (`feat/discovery-question-cards`): next in line. Must be
  reviewed and fixed first before the rest of the stack can move.
- PRs #4–#9: blocked behind #3 (stacked).

## Open technical risks

- PR #2 was reported as merged but GitHub shows it closed without merge
  — confirm whether its changes are in `main` by another path.
- Dependency audit: 6 findings (2 critical, 2 high) reported 2026-10-11,
  not yet independently verified or resolved.
- Test-count claim (153 passing / 20 files) does not match the 11 test
  files on `main` — verify against CI before trusting.
- Live TREG/OpenAI spend needs explicit owner approval + caps (standing).

## Next approved priority

1. Review and fix PR #3, then merge it (owner merges).
2. Rebase and review #4, then continue up the stack in order.
3. Resolve dependency audit findings.

## Blocked tasks

- End-to-end live extraction test: blocked on owner spend approval.
- OpenAI `LIVE_MODE` go-live: blocked on owner approval + capped tests.
- Appwrite Sites live SSR verification: blocked on latest build serving
  the live domain.
