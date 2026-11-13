# Starting fresh on Diger (for a Claude Code session with no prior context)

## 1. Project identity

* **Repository:** https://github.com/iammagdy/digr. Primary branch: `main`.
* **Production (last verified 13 Nov 2026):** last code change = **`7d30ec8`**, the merge of PR #479 (https://github.com/iammagdy/digr/pull/479), round 61.
  * Vercel production READY on it; Heroku v188, worker heartbeat `7d30ec8`.
  * Later documentation-only merges (PR #480) move `main` without changing code; check `git log origin/main`.
* **Branches:**
  * `ccr-9dc4c8d3-d0ae22` (round 61) is fully merged.
  * **Round 62 (PR B, worker wiring of the spend gate)** is an OPEN, unmerged review PR on `claude/round-62-spend-gate-worker-wiring`; see `docs/proposals/spend-gate/WIRING-R62.md`.
  * Start new work from `main` on a new branch.
* **Recent merged PRs:**
  * #479 (round 61 spend gate, offline and disconnected, merge `7d30ec8`; reviewed head `61338a2`);
  * #478 (round 60, merge `adb22f8`);
  * #477 (round 59, merge `9974769`);
  * #475 (round 58 follow-up, `4ef32c3`);
  * #473 (round 58, `99acb4f`).

## 2. Read, in this order

1. `docs/HANDOFF.md`: the section «CURRENT STATE» only. The rest is history, newest first.
2. `docs/NEXT_STEPS.md`: the single best next task, and everything still open.
3. `README.md`: the product, environment variable names, local commands.
4. For the spend-gate work: `docs/proposals/spend-gate/SPEC-v2.md` and `THREAT-MODEL.md`.
5. As needed:
   * `docs/PAGE-REUSE-R60.md` (round 60);
   * `docs/QUALITY-COST-R59.md` (round 59);
   * `docs/CUSTOMER-JOURNEY-R58.md`.

## 3. Environment

* **Tools:** Node 22.x, npm, git. Optional: PostgreSQL 16 binaries, for the scratch-database tests only.
* **Install:** `npm install`. The worker's dependencies are installed with `npm ci --prefix agent` (as in `heroku-postbuild`).
* **Tests:**
  * `npm test` (Vitest, full suite; it takes several minutes; run it with no other job editing files).
  * One file: `npx vitest run tests/<file>.test.ts`.
  * The real-SDK test (no paid call; fake upstream): `DIGER_TEST_REAL_SDK=1 npx vitest run tests/spend-gate-r61-sdk.test.ts`.
  * Scratch-Postgres tests (never Supabase): start a local Postgres 16 as the `postgres` OS user on a private socket, then `DIGER_TEST_PG=<socket dir>:<port> npx vitest run tests/sql/spend-gate.local-pg.test.ts`.
* **Typecheck:** `npm run agent:typecheck` and `npx tsc --noEmit -p .`.
* **Build:** `npm run build`. It runs `next build`, then the client-bundle secret scan (`npm run check:secrets`).
* **External services:**
  * Vercel (website);
  * Heroku app `diger-agent` (worker);
  * Supabase (database; the session had read-only SQL access);
  * Anthropic, TREG, Context.dev, Firecrawl (paid providers).

## 4. Security

* **Never write** passwords, API keys, tokens, session cookies or `.env` values into files, commits, PRs or chat. Document variable names only (listed in `docs/HANDOFF.md`).
* **Nothing is transferred** from the previous account. Each connection needs fresh authorization on the new account:
  * GitHub (the Claude GitHub App on `iammagdy/digr`);
  * Vercel;
  * the Heroku API proxy, restricted to `/apps/diger-agent`;
  * Supabase read-only.
* **Do not** try to reuse sessions or browser logins.
* **Test accounts:** an earlier round used a disposable test account given by the owner in chat. Its credentials are not stored anywhere. Ask the owner for new ones if an authenticated journey is needed.
* **No paid API call** (provider or model) without the owner's explicit authorization for that round.
* **No change** to pricing, the credit ledger, settlement, database permissions, infrastructure or provider limits without specific owner approval.
* **Merges:** only through a PR after the exact head SHA is reviewed. Never push to `main`.

## 5. Current status

* **Works in production (`7d30ec8`):**
  * everything through round 60. The chat plans and prices missions, the worker executes them, and files are delivered.
  * Round 60: one paid fetch per page; no paid page for an unsaved company.
  * Round 59: company quality notes in the delivered file.
* **Merged and deployed as disconnected code only:** the round-61 hard spend gate (PR #479).
  * It is not wired, no SQL is applied, `DIGER_SPEND_GATE` is unset, and it is **not enabled**.
  * Production spending behaviour is unchanged from round 60.
* **Verified on the merged tree** (`61338a2`, locally; the repository has no GitHub Actions):
  * full suite: 13,563 passed, 0 failed;
  * both typechecks clean;
  * build and secret scan clean.
* **Incomplete:**
  * wiring the gate: PR B, worker only, **implemented in the round-62 open PR, NOT merged, NOT active** (the owner decides the merge);
  * the website's model calls going through the gate;
  * an honest plan estimate (a pricing decision).
* **Blockers:** owner decisions (SPEC-v2 §13).
  * No migration may be applied, and no flag set, without them.
  * **Observe mode can forward paid calls without a reservation. It is NOT budget enforcement.**
  * **Budget enforcement is NOT live. Do not claim it is.**

## 6. First action

1. Fetch `main`. Check that `git diff --stat 7d30ec8 origin/main -- . ':!docs'` is empty: no code changed after the last verified production code. If it is not empty, read the newer HANDOFF entry first.
2. Install: `npm ci`, then `npm ci --prefix agent`.
3. Run, one after another, with nothing else running:
   * `npm test`;
   * `npm run agent:typecheck`;
   * `npx tsc --noEmit -p .`;
   * `npm run build`.
4. Report the numbers. The last baseline is 13,563 passed, 0 failed.
5. Then wait for the owner.

* The current engineering milestone is **PR B** (the spend-gate wiring; `docs/NEXT_STEPS.md`). It is implemented for the worker as the round-62 open PR, which is **NOT merged**. Do not merge it, deploy it or activate the gate without the owner's separate authorization.
* T1 (the round-61 review PR) is complete; see the history section of `docs/NEXT_STEPS.md`.
* Do not redo rounds 57 to 61. They are complete as described in `docs/HANDOFF.md`.
