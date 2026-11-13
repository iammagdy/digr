# Starting fresh on Diger (for a Claude Code session with no prior context)

## 1. Project identity

* **Repository:** https://github.com/iammagdy/digr. Primary branch: `main`.
* **Production (last verified 13 Nov 2026):** `main` = **`adb22f8`**, the merge of PR #478 (https://github.com/iammagdy/digr/pull/478).
* **Work branch:** `ccr-9dc4c8d3-d0ae22`.
  * `f0fe65d8`: round 61, spend gate offline build. NOT reviewed, NOT merged.
  * Then one documentation commit (this file, `docs/HANDOFF.md`, `docs/NEXT_STEPS.md`).
  * The branch has **no PR**.
* **Recent merged PRs:**
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

* **Works in production (`adb22f8`):**
  * everything through round 60. The chat plans and prices missions, the worker executes them, and files are delivered.
  * Round 60: one paid fetch per page; no paid page for an unsaved company.
  * Round 59: company quality notes in the delivered file.
* **Implemented and tested offline, not merged, not wired, not deployed:** the round-61 hard spend gate (`f0fe65d8`).
* **Not verified on the round-61 tree:** a complete full-suite run, and `npm run build`.
* **Incomplete:**
  * wiring the gate (PR B);
  * the website's model calls going through the gate;
  * an honest plan estimate (a pricing decision).
* **Blockers:** owner decisions (SPEC-v2 §13).
  * No migration may be applied, and no flag set, without them.
  * **Budget enforcement is NOT live. Do not claim it is.**

## 6. First action

On branch `ccr-9dc4c8d3-d0ae22` (fetch it, check it out), run, one after another and with nothing else running:

1. `npm test`;
2. `npm run agent:typecheck`;
3. `npx tsc --noEmit -p .`;
4. `npm run build`.

Then report the exact numbers, and open (do not merge) a PR from that branch to `main`. Its title should say «round 61 spend gate: offline build, NOT wired, NOT applied», and its body should state the test numbers.

That is task T1 of `docs/NEXT_STEPS.md`.

Do not redo rounds 57 to 61. They are complete as described in `docs/HANDOFF.md`.
