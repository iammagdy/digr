# Phase 5.3 + Phase 6 campaign: emergency pause handoff (14 Nov 2026)

The session was paused by the owner (usage limit). **Nothing was pushed, no PR was opened or merged, nothing was deployed, production was not changed.** All work below is LOCAL to this cloud container.

> **Durability warning.** The work exists only in this container (working tree + one local documentation commit). If the container is reclaimed, it is lost unless the next session in the same container pushes it. Two recovery patches are saved next to this file: `docs/ops/phase-5-6-wip/pr-a-exclusion.patch` (all PR A changes, including new files) and `docs/ops/phase-5-6-wip/pr-c-provider-drift.patch` (the PR C module). `git apply <patch>` on `main` = `8c30294` reproduces them.

## 0. Recovery branch (published backup)

This file and the two patches are on the recovery-only branch `claude/phase-5-6-recovery-backup` (based on `8c30294`, pushed once, **no PR, never to be merged as is**). Recover with:

```
git fetch origin claude/phase-5-6-recovery-backup
git checkout -b claude/phase-5-6-resume origin/main            # main must still be 8c30294, or rebase the result
git show origin/claude/phase-5-6-recovery-backup:docs/ops/phase-5-6-wip/pr-a-exclusion.patch > /tmp/pr-a.patch
git show origin/claude/phase-5-6-recovery-backup:docs/ops/phase-5-6-wip/pr-c-provider-drift.patch > /tmp/pr-c.patch
git apply --check /tmp/pr-a.patch && git apply /tmp/pr-a.patch     # PR A: 16 modified + 4 new files
# PR C goes on its own branch after PR A merges: git apply /tmp/pr-c.patch (1 new file)
```

**Verified before publishing (14 Nov 2026):** both patches apply cleanly to `8c30294` in clean worktrees. PR C restores `providerDrift.ts` byte for byte. PR A restores 19 of its 20 files byte for byte; the twentieth, `tests/customer-exclusion-phase53.test.ts`, differs on ONE fixture line only, because a made-up but realistic personal address was replaced by `nobody@gmail.example` before publishing. That value sits in a column the parser never reads, the test still asserts that «gmail» never leaks, and the affected test group passed on the restored copy (6/6). The local-only commit `6964a91` in the paused container holds the byte-exact original.

A secret scan of the three files found no credentials, tokens, keys or connection strings. The only e-mail addresses are synthetic test fixtures on `.example` domains.

## 1. Current project state

| Item | Value |
|---|---|
| `origin/main` | `8c3029428e45ea8c1c1ba9d7604e67cdc38b05d9` (merge of PR #494), unchanged by this session |
| Production last verified (this session, read-only, before any change) | Vercel `dpl_ETmFhPpr7bWBWQmqzGLegDqMtg3W` READY on `8c30294`; Heroku release v202 «Deploy 8c302942»; worker heartbeat `8c30294`, `active_missions 0` |
| Production data (read-only) | `agent_settings` keys: `redesign_flags`, `social_discovery` only; `credit_ledger` 1,247 rows, sum 16,086, last row 2026-11-13 16:06 UTC; `jobs`: completed 291, failed 152, refused 2 (no queued/running: the nine stale `vrun_` jobs are closed); `missions`: completed 167, cancelled 34, unserved 25, failed 17, plan_ready 2, none queued/planning/approved/executing |
| Main worktree | `/home/user/digr`, branch `claude/peaceful-babbage-c096ym` at `8c30294` (the designated push branch; never pushed in this session) |
| PR C worktree | `/home/user/digr-c`, local branch `pr-c-local` at `8c30294` (created from `origin/main`; `node_modules` and `agent/node_modules` are symlinks to the main worktree's, git-ignored) |
| Local branch `main` | stale (`b61a514`, behind origin by 76); not used |
| Uncommitted changes | PR A: everything listed in §2 (16 modified files + 4 new files) in `/home/user/digr`; PR C: one new file in `/home/user/digr-c` |
| Local commits not pushed | one documentation-only commit on `claude/peaceful-babbage-c096ym` adding THIS file and the two recovery patches (no code staged in it) |
| Remote PRs from this session | none |
| PR #481 | not touched |

## 2. PR A — exclusion files (Phase 5.3-A): implementation complete locally, final gates NOT run

**Feature switch:** `agent_settings.customer_exclusion_files_v1`, read with `scopedFlagOn`. **OFF; set by nothing; never enabled.** Nothing was pushed.

### What it does
* **Chat** (`src/lib/agentMission/chatTurn.ts` `exclusionForCard`, called from `startMission` and the multi-part group cards; `src/functions/shared/chatHandler.ts` passes `brief.exclusionFile` to `agentChatTurn`): with a server-parsed file in the conversation and the switch ON, a snapshot (organisation identifiers only, ≤ 5,000, SHA-256 digest) is written on the card's assistant message (`plan.customerExclusion`) in the same update as `agentMissionId`. Switch OFF: nothing stored; the message gets an honest line «استلمنا ملف الاستبعاد … تطبيقه على نتائج البحث غير مفعّل حاليًا». Empty file: said, never stored. A request asking to research the companies IN the file (`uploadIntentOf` = enrichment) is NEVER applied as an exclusion (any switch state) and says enrichment files are not supported.
* **Worker planning** (`agent/src/customerExclusion.ts` `withCustomerExclusion`, called in `runPlanning` just before `plan_ready`): switch ON for the mission's user → reads the card (`missionExclusionReader`: same `user_id`, `role=assistant`, `plan->>agentMissionId`), copies the list to the private folder `inputs/customer-exclusion.json`, sets `plan.customer_exclusion = { digest, entities, applies }` and one card sentence. Read failure / malformed list throws (existing planning retry).
* **Worker execution** (`runExecution`): a plan carrying an applying mark loads the private copy (`loadApprovedExclusion`, digest + size must match) or stops with `admin: customer_exclusion_unavailable` (nothing called, hold released by existing settlement). The matcher is passed to the model tools (`ToolContext.exclusion`) and the engine (`EngineDeps.exclusion`).
* **The boundary** (`agent/src/items/ingest.ts`): on top-level company stages and people stages (`exclusionStageKind`; people rows matched by employer fields only), a CONFIRMED match is stored `excluded` with new reason `customer_exclusion` (never delivered/counted/charged); a POSSIBLE match (shared brand word only) is delivered with internal mark `_excl_possible`. A plan with an applying mark and no matching list in deps → the batch throws (fail closed).
* **Matcher** (`src/lib/agentMission/customerExclusion.ts`): deterministic, indexed, same rules as `negativeListEngine.compareOrganizations` (domain, registration number, normalized full name, distinctive brand-word set); shared hosts/free mailboxes never count as domains.
* **Customer text**: `REASON_TEXT_AR.customer_exclusion`, zero-delivery clause, `OUR_FILTER_REASONS`, methodology item «ملف الاستبعاد» and possible-match count line (`agent/src/finalize.ts`, `agent/src/methodology.ts`).
* Pricing, reservation, approval, settlement arithmetic: unchanged.

### Files
New: `src/lib/agentMission/customerExclusion.ts`, `agent/src/customerExclusion.ts`, `tests/customer-exclusion-phase53.test.ts`, `docs/intelligence/PHASE-5-3-AND-6.md` (campaign report: status table, deployment discipline, §A, §B blocker; §C is a placeholder).
Modified: `agent/src/engine/run.ts`, `agent/src/finalize.ts`, `agent/src/items/ingest.ts`, `agent/src/items/itemStore.ts`, `agent/src/main.ts`, `agent/src/methodology.ts`, `agent/src/runMission.ts`, `agent/src/tools.ts`, `src/functions/shared/chatHandler.ts`, `src/lib/agentMission/chatTurn.ts`, `src/lib/agentMission/plan.ts` (`customer_exclusion?` type), `src/lib/agentMission/rawDelivery.ts` (new reason, allowed raw removal), `tests/raw-delivery-contract.test.ts` (inventory pin updated on purpose: 24 reasons, 5 allowed; marked CHANGED), `docs/HANDOFF.md`, `docs/NEXT_STEPS.md`, `docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md` (historical banner + corrected outdated statements: #493/#494 merged, stale jobs closed, PR D = #486, baseline `8c30294`).

### Known issues / remaining for PR A
* Limitations (documented in the report §A.4): organisation lists only; possible matches are delivered (owner choice); plan-card sample rows are not filtered; admin free re-runs carry no file (and claim none); intent read from words only.
* Remaining gates: re-run the targeted tests, BOTH typechecks (test file changed after the last root typecheck), the FULL suite, `npm run build` (includes the client-bundle secret scan); review the whole diff; then the single push / PR / preview / merge / production verification.
* Docs to finish before the push: add the free re-run limitation to report §A.4; fill test counts after the final suite.

## 3. PR B — enrichment files (Phase 5.3-B): NOT implemented (stopped per the brief's own criteria)

* Investigation complete; result written in `docs/intelligence/PHASE-5-3-AND-6.md` §B (part of the uncommitted PR A docs).
* Blocker: making an uploaded list the starting dataset needs (1) a new quote/approval model (a file-fed stage has no capability record, no measured price, and must pass `verifyApprovedScope`), (2) a new settlement rule (a supplied row with nothing found must not be charged), (3) a new paid per-row enrichment operation. All require owner approval.
* Reusable: PR A's snapshot path (card → private copy → digest), the `web_via_treg` company → website → contacts chain, `contact_steps`.
* Already shipped inside PR A: enrichment-intent detection and honest refusal (never applied as an exclusion).
* Smallest proposal for approval: report §B.3 (switch `customer_enrichment_files_v1`, `_input_row` provenance, existing pricing function, delivered unit = row with ≥ 1 field found from an official source, one capped test capture ≤ $0.20).

## 4. PR C — provider intelligence (Phase 6.1 / 6.2): started, NOT complete

* Location: worktree `/home/user/digr-c`, branch `pr-c-local` (from `8c30294`), **one uncommitted new file**: `src/lib/agentMission/capabilities/providerDrift.ts`. Not pushed.
* What the module contains (pure, no IO): `isMetadataUrl` / `assertNoCredentials` (allowlist of public metadata URLs only: `treg.to` /meta, /openapi.json, /catalog/search, /catalog/endpoints/{id}; `docs.firecrawl.dev/api-reference/v2-openapi.json`; `www.firecrawl.dev/changelog/rss.xml`; `docs.context.dev/openapi.json` and changelog RSS); `contractFromSnapshot` / `contractFromLive`; `contractFingerprint`; `diffContracts` (added, removed only on complete evidence, renamed, unverified on failed fetch, input breaking/additive, output breaking/unknown, price changed/unknown, deprecated, policy breaking, suspicious); `safeReplacement` (same fallback group, ≥ approved verification tier, same constraints/inputs/outputs, public policy, known price ≤ approved) and `impactOf`; `summarizeOpenApi`, `diffWebProvider`, `feedItems`, `newFeedItems`.
* **Not typechecked, no tests yet, not run.** The sync script, baseline file, report and tests do not exist yet.
* Facts gathered by free public GETs (no keys, no billable call): TREG `/meta` gives `treg_version` 0.30.0 and `paused_providers` (datagma, google-business-profile); `/catalog/search` needs `q` or `added_within_days`, `limit` max 100, no offset (188 added in 30 days; 8 in 8 days); `/catalog/endpoints/{id}` returns `{endpoint:{input:{body|queryParams…}, cost, status, superseded_by, platform_blocked…}, example_response}`, unknown id → HTTP 404 `{"detail":{"error":"unknown endpoint '…'","did_you_mean":[]}}`; Firecrawl v2 OpenAPI (44 paths, server `https://api.firecrawl.dev/v2`); Context.dev OpenAPI v1.0.0 (45 paths) whose parser enum is at `/components/schemas/ScrapeParseParams/oneOf/1/properties/parser` with 27 parsers, more than Diger's `PARSERS` (e.g. g2-reviews, tiktok-comments, reddit-*, `yelp-search`/`yelp-reviews` — the registry's `contextdev.parse.yelp` placeholder name is outdated); GitHub releases.atom returned 403 (not used).
* Diger's web calls to watch: Firecrawl POST `/v2/scrape`, `/v2/search`, `/v2/map`; Context.dev POST `/v1/web/scrape` (incl. prebuilt parsers), `/v1/web/search`, GET `/v1/web/urls`, POST `/v1/people/search`.

## 5. Testing (exact; nothing incomplete is claimed)

| Check | Result |
|---|---|
| `tests/customer-exclusion-phase53.test.ts` | last whole-file run 41/41 passed; the 42nd test (whole chat turn, enrichment request) was added afterwards and passed when run alone (`-t "ENRICHMENT request"`). The whole file was not re-run after that. |
| `tests/raw-delivery-contract.test.ts` | passed (run together with the exclusion file earlier, 40/40 combined at that point) |
| PR A mutation checks | 29/29 mutants caught (scratchpad runner, mutations restored after each) |
| `npm run agent:typecheck` | clean (last run after the reader refactor) |
| `npx tsc --noEmit` | clean at its last run; test-file additions made after it are NOT typechecked |
| Full suite | NOT completed for PR A. An early run that picked up half-written edits: 13,817 passed, 2 failed (the raw-delivery pins, since fixed deliberately). The final PR A full run was **stopped by the pause**. |
| `npm run build` + secret scan | NOT run |
| PR C | nothing run (no tests, no typecheck) |
| Live provider/model/customer verification | none (only free public metadata GETs for PR C design) |

## 6. Deployment safety

* GitHub pushes: **0**. PRs opened: **0**. PRs merged: **0**. Vercel previews created by this session: **0**. Production deployments: **0**. Heroku releases: **0** (still v202).
* No switch set, no SQL, no migration, no ledger/settlement/pricing change, no paid call, no secret printed.
* Risks: the unpushed work can be lost with the container; PR A must not be pushed before its full suite, build and secret scan pass.

## 7. Continuation plan (exact order)

1. In `/home/user/digr` (`git status` must show the PR A files; if the container was reclaimed, check out `claude/peaceful-babbage-c096ym` from `origin/main` and `git apply docs/ops/phase-5-6-wip/pr-a-exclusion.patch` — the patch is only on this local commit, so a lost container means rebuilding PR A from this document).
2. Verify production state again read-only (Vercel production SHA, heartbeat, `agent_settings`, open missions, ledger count).
3. PR A gates, locally: `npx vitest run tests/customer-exclusion-phase53.test.ts tests/raw-delivery-contract.test.ts`; `npm run agent:typecheck`; `npx tsc --noEmit`; full `npx vitest run`; `npm run build` (includes `check:secrets`); fix any failure without weakening tests. Add the free re-run limitation and final counts to `docs/intelligence/PHASE-5-3-AND-6.md`.
4. Decide what to do with this pause commit: either keep it (it only adds `docs/ops/PHASE-5-6-SESSION-PAUSE.md` and the patches) or replace it before the push by a fresh branch commit that excludes the patch files (do not ship 2,000-line patch files to `main`). Do not amend; create the PR A commit(s) on top, then remove `docs/ops/phase-5-6-wip/` in a normal commit if preferred.
5. Commit PR A, push `claude/peaceful-babbage-c096ym` ONCE, open one PR, verify the single Vercel preview at the head SHA, check no mission is executing, merge through the PR, verify Vercel production + heartbeat + Heroku release on the merge SHA, `agent_settings` unchanged, ledger unchanged.
6. PR B: no code. Its blocker/proposal is in the report §B (merged with PR A). Wait for the owner.
7. PR C: after PR A is merged, in `/home/user/digr-c`: `git stash -u` is NOT needed — the file is untracked; `git fetch origin main` then `git checkout -B pr-c-local origin/main` keeps the untracked file. Then: write `scripts/capabilities/sync-providers.ts` (read-only; uses `isMetadataUrl`/`assertNoCredentials`; fetch injectable; `--offline <dir>`, `--save <dir>`, `--out`, `--plans <json>`, `--write-baseline` for `data/capabilities/provider-metadata.json` only; never writes `registry.json` or `production-eligible.json`; TREG ids = registry TREG capabilities; 404 «unknown endpoint» = removal evidence, other errors = unverified; policy via `classify` from `scripts/treg/build-data-policy.mjs`; live contracts compared with `outputs: false`); tests `tests/provider-drift-phase6.test.ts` with stored fixtures (removal, rename, schema fingerprint change, list-path change, unknown price, blocked/sensitive change, invalid fallback, no safe fallback, failed fetch ≠ removal, URL guard refuses billable paths, no `process.env` read, data files unchanged); mutation checks; one manual free sync run to produce `docs/capabilities/sync-2026-11-xx.md`; report §C; record PR A's production result in the docs; then the same single-push PR flow on the designated branch (reset it to the new `main` after PR A merges: `git checkout -B claude/peaceful-babbage-c096ym origin/main`, bring PR C's files over, force-with-lease is acceptable only after PR A is merged). No cron, no scheduler.
8. Final Arabic report per the campaign brief. Do not start Phase 7 or 8.

## Ready-to-paste continuation prompt

```
You are resuming the DIGER «Phase 5.3 + Phase 6» campaign (repo iammagdy/digr) after an emergency pause.
Read docs/ops/PHASE-5-6-SESSION-PAUSE.md first, then docs/intelligence/PHASE-5-3-AND-6.md, docs/HANDOFF.md (CURRENT STATE) and docs/NEXT_STEPS.md.
All rules of the original campaign still apply: no paid calls ($0 budget), no switches enabled, no migrations, no ledger/pricing/settlement/permission/RLS/cron changes, no secrets printed, never push to main, PR #481 untouched,
one push + one preview + one production deployment per PR, everything verified locally first (targeted tests, full suite, both typechecks, npm run build with the secret scan, mutation checks, full diff review).
State at pause: nothing pushed or deployed; production verified on 8c30294 (Vercel dpl_ETmFhPpr7bWBWQmqzGLegDqMtg3W, Heroku v202, heartbeat 8c30294).
PR A (exclusion files, switch customer_exclusion_files_v1 OFF) is implemented UNCOMMITTED in /home/user/digr on branch claude/peaceful-babbage-c096ym (recovery patch: docs/ops/phase-5-6-wip/pr-a-exclusion.patch);
its targeted tests and 29/29 mutation checks passed, but the full suite, the final typecheck and the build/secret scan were NOT run.
PR B (enrichment files) is stopped for owner approval (report §B); do not implement it.
PR C (provider sync) has only src/lib/agentMission/capabilities/providerDrift.ts, untracked in the worktree /home/user/digr-c (branch pr-c-local), untested.
Do, in order: (1) re-verify production read-only; (2) finish PR A's gates and docs, push once, open the PR, verify the preview at the head SHA, merge through the PR when no mission is executing, verify production, heartbeat and Heroku on the merge SHA;
(3) build PR C in /home/user/digr-c following §7 step 7 of the pause document, test it offline, run one manual free metadata sync, document it, and ship it with the same single-push flow;
(4) give the final Arabic report (five lines + evidence appendix). Do not delete the worktrees or reset branches that hold unpushed work. Stop and ask the owner only for genuine financial, security, infrastructure or production-data risks.
```
