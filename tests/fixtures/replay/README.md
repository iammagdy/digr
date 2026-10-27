# Replay fixtures

Answers the gateway gave (or the catalog says it gives), stored so a full request can be replayed with ZERO provider calls (`tests/helpers/replayWorld.ts`,
`tests/replay-harness.test.ts`). The file name says what a fixture is:

- `real-rows_<endpoint>.json`: rows read from a LIVE job's step file (after the worker's flattening). Keys and text starts are the real ones; ids, counts and
  dates are synthetic where the file says so. Types are the live types (all strings for `anyapi.x.user.posts`: «True»/«False», Unix seconds as text).
- `catalog-example_<endpoint>.json`: the catalog's own trimmed `example_response_trimmed` (written by `scripts/treg/extract-replay-fixtures.mjs` from the
  catalog snapshot). It has the right field NAMES, but its TYPES can differ from a live call, it holds ONE list item, strings are cut at 120 characters, emails
  are masked, its dates are the snapshot's, and an endpoint may omit fields the live rows carry (the `anyapi.x.user.posts` example has no `authorHandle`).

Raw first pages of real jobs (flag `RAW_FIRST_PAGE_CAPTURE=on`, `src/lib/server/rawCapture.ts`) are the source of the next `real-rows_` fixtures.
