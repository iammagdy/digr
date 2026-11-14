# Phase 5.3 and Phase 6: customer files and provider update intelligence (14 Nov 2026)

**Reference documents:** `DIGER_INTELLIGENCE_AUDIT.md` (historical, Chapters 7, 9, 14 PR-5.3 / PR-6.1 / PR-6.2), `PHASES-2-4-ACCEPTANCE.md`, `PHASE-5-CONTACTS-AND-REVERSE-LOOKUP.md`.

**Starting point:** `main` = `8c30294` (PR #494), verified before any change:

* Vercel production `dpl_ETmFhPpr7bWBWQmqzGLegDqMtg3W` READY on `8c30294`;
* Heroku release v202 «Deploy 8c302942», worker heartbeat `8c30294`, `active_missions 0`;
* `agent_settings` keys: `redesign_flags`, `social_discovery` only (no Intelligence switch set);
* `credit_ledger`: 1,247 rows, sum 16,086, last row 13 Nov 2026 16:06 UTC;
* `jobs`: no queued or running job (the nine stale `vrun_` jobs are closed); `missions`: none queued, planning, approved or executing (two `plan_ready` wait for their customers).

**Rules kept throughout:** no paid call (provider or model), no switch set, no migration, no secret read or printed, no change to pricing, ledger, reservation, settlement, refunds, permissions, RLS, crons or infrastructure. PR #481 was not touched.

## Status at a glance

| | CODE COMPLETE | OFFLINE VERIFIED | LIVE VERIFIED | PRODUCTION ENABLED | NEEDS THE OWNER |
|---|---|---|---|---|---|
| **5.3-A exclusion files** | Yes (PR A, #495) | Yes (§A.5) | **No** | **No.** `customer_exclusion_files_v1` is unset. | Turning the switch on (test account first) |
| **5.3-B enrichment files** | **No: stopped** (§B) | The honest refusal is (§A.3) | No | No | A pricing and settlement decision (§B.3) |
| **6.1 provider sync** | Yes (PR C) | Yes (§C.6) | Public metadata only: one manual sync, 14 Nov 2026 (§C.4). No provider data call. | **No.** Nothing is activated, re-routed or re-priced by it. | Reviewing the first report (§C.4); a reviewed PR for anything it proposes |
| **6.2 breaking changes** | Yes (PR C) | Yes (§C.6) | Not applicable: detection runs on public metadata; no fallback was exercised live | **No** | The 6 capabilities with no safe replacement (§C.5) |

«Code complete» is not «live». Nothing in this campaign was run against a real customer, a real provider or a real model.

## Deployment discipline (in force from this campaign)

Measured before this campaign: 76 Vercel deployments in about 36 hours (25 production, 47 successful previews, 3 failed previews, 1 cancelled).

1. Local commits are allowed; intermediate GitHub pushes are not.
2. One branch from the current `main` per focused PR; the whole scoped change, its tests and its documentation are finished locally first.
3. Before the single push: targeted tests, the full suite, both typechecks, `npm run build` (with the client-bundle secret scan), the relevant mutation checks, and a review of the whole diff.
4. Push once, open one PR, verify its one preview at the exact head SHA, merge through the PR (never to `main` directly), then verify production on the merge SHA and the worker heartbeat on the same SHA.
5. No documentation-only PR when the documentation belongs to a code change; no push to re-test what can be checked locally; no redeploy of an already verified SHA; no merge of `main` back into a finished branch just to synchronise it.
6. Extra pushes only for genuine review findings or failed deployment gates.
7. The production result of one PR is recorded in the NEXT code PR of the campaign (never in a documentation-only PR). The last PR's own production result is in the campaign's final report.

## A. Phase 5.3-A: exclusion files (PR A)

### A.1 The flow before this PR (audit)

| Step | Where | What happened |
|---|---|---|
| Upload | `Composer.tsx` → `POST /api/chat` | `.xlsx` / `.csv` up to 5 MB, signed-in users only |
| Parsing, validation | `src/app/api/chat/route.ts`, `exclusionFileParser.ts` | server-side; company name, corporate domain, registration number; at most 5,000 rows; personal columns never read |
| Persistence | `chatHandler.ts` → `saveConversationBrief` | `brief.exclusionFile` on the conversation (owner checked by the route) |
| Mission creation | `chatTurn.ts` `startMission` → `createCustomerMission` | **the mission row held only the request text: the list never reached the worker** |
| Planning, approval, execution | `agent/src/runMission.ts` | no knowledge of the list |
| Ingestion, deduplication, files, delivered rows, settlement | `agent/src/items/ingest.ts`, `finalize.ts`, settlement | **excluded companies could be delivered and charged** |

The old jobs path (`src/app/api/worker/chunk/route.ts`) does apply `exclusionRules`, and the old plan text says so; that path is not reachable in production while `AGENT_SERVES_CHAT` is true (every research request goes to the agent). It is unchanged.

### A.2 The change (behind `customer_exclusion_files_v1`, default OFF)

* **Switch:** `agent_settings.customer_exclusion_files_v1`, read with the existing `scopedFlagOn` (`true` / `"on"` for everyone, `{ "user_ids": [...] }` for named accounts, `expires_at` honoured). Nothing in the repository sets it.
* **Chat (`chatTurn.ts` `exclusionForCard`):** with a file in the conversation and the switch ON for the account, a snapshot of the server-parsed list (`customerExclusion.ts` `exclusionSnapshotOf`: organisation identifiers only, repeats removed, at most 5,000, SHA-256 digest) is written on the assistant message of the new mission's card, in the SAME update as `agentMissionId`. Customers cannot write an assistant message's plan (messages RLS: insert only `role = 'user'` with `plan IS NULL`; no update policy).
* **Planning (`agent/src/customerExclusion.ts` `withCustomerExclusion`):** with the switch ON for the mission's user, the worker reads that card (same `user_id`, same mission id: `missionExclusionReader`), copies the list to the mission's private folder (`inputs/customer-exclusion.json`) and pins `plan.customer_exclusion = { digest, entities, applies }`. The card gets one sentence: applied to the plan's company or people stages, or «not applicable to this kind of data» (posts, comments, places). A failed read or a malformed list throws (the existing planning retry), never a silent «no list». The list itself is never in the plan (the plan text reaches models; the list does not).
* **Execution (`runExecution`):** a plan approved WITH a list never runs without exactly that list, whatever the switch says at execution time. The private copy is loaded and its digest and size must equal the approved ones; otherwise nothing is called and the hold is released whole by the existing settlement (`admin: customer_exclusion_unavailable`).
* **The one boundary (`agent/src/items/ingest.ts`):** every row enters the item store through `ingestRows` (engine pages, the pinned approved rows, retried pages, fallback sources, the model's `save_rows`). On a top-level company stage (the row is the company) or people stage (the row's employer fields only, never the person's name or job title), a row the matcher CONFIRMS is in the list is stored as `excluded` with the new reason `customer_exclusion`: never delivered, never counted, never charged. Its id is remembered, so a retried page cannot bring it back under the same id, and a new id meets the same check. If a plan carries an applying mark and the batch has no list with that digest, the batch throws before anything is saved (fail closed).
* **Matching (`exclusionMatcherOf`, deterministic, no model):** the rules of `negativeListEngine.compareOrganizations`, indexed (constant time per row for 5,000 listed companies): equal corporate domain (registrable form; social networks, free mailboxes and site builders never count as a domain); equal registration number (Arabic digits read); equal normalized full name (Arabic letter forms and diacritics unified); equal set of distinctive brand words (generic words such as «شركة», «مقاولات», «group» never count). A shared brand word only is a POSSIBLE match: kept and delivered (the negative-list engine's owner rule: an uncertain case is never silently deleted), marked on the row (`_excl_possible`, internal) and counted in the methodology.
* **What the customer reads:** the card's sentence; the methodology item «ملف الاستبعاد»; the reason «وارد في ملف الاستبعاد الذي أرسلته» in the counts table and the shortfall sentence; the number of delivered rows that only resemble a listed name. Counts only, never a listed name.
* **Unchanged:** pricing, reservation, approval, settlement arithmetic (charge = ceil(delivered × unit), never above the reserve), the source-link and source-identity rules, the people-at-company confirmation, every provider gateway and cap. The list never goes to a provider or a model.

### A.3 Customer honesty while the switch is OFF (documented wording exception)

The only customer-facing change with the switch OFF, and only for a conversation that has an uploaded file:

* the new mission's chat message gets one more line: «ملاحظة: استلمنا ملف الاستبعاد (ن شركة)، لكن تطبيقه على نتائج البحث غير مفعّل حاليًا، فقد تتضمن النتيجة شركات واردة فيه.»;
* a file with no usable company: «لم نجد في ملف الاستبعاد المرفوع أسماء شركات صالحة، فلن يُستخدم في هذا الطلب.»;
* a request that asks to research the companies IN the file (`uploadIntentOf` = enrichment, any switch state): «استخدام ملف مرفوع كقائمة شركات تُكمَل بياناتها غير متاح حاليًا، فلن تُستخدم شركات الملف كبداية للبحث ولن يُطبَّق الملف كقائمة استبعاد …». The list is then never applied as an exclusion, because it would remove the very companies the customer asked about.

Without a file nothing is read or written and the message is exactly today's. Tests: `tests/customer-exclusion-phase53.test.ts` («the chat card», «ENRICHMENT»).

### A.4 Limitations (said, not hidden)

* The parser is organisation-focused. Exclusion lists of social accounts, comment authors or people are **not supported**; on a plan of posts or comments the card says the file does not apply.
* A possible match (shared brand word) is delivered, with its count in the methodology. Excluding possible matches too would be stricter and is an owner choice.
* A sample row shown on the plan card is from planning; the delivered file is filtered.
* The file of a conversation applies to every new mission of that conversation (the brief keeps it), and each card says so.
* **A free re-run (the admin's «إعادة تشغيل مجانية») carries no file.** It creates a new mission without a card message, so the worker finds no list and applies none; it also says nothing about a file. A customer who relied on the list should not be given a free re-run of that request until the list is attached to it (not built).
* Upload intent is read from the request words; an enrichment request worded in an unforeseen way and uploaded in an earlier turn is read as an exclusion request (the upload control is labelled «ملف استبعاد»).

### A.5 Tests (offline only)

Final counts (resumed session, local): the exclusion file **45 tests** and the raw-delivery contract file 3, both passing; the FULL suite 13,860 passed, 47 expected-fail, 78 skipped, with ONE failure that was environmental (a test reads `agent/node_modules/...sdk.d.ts` and `agent/` had not been installed yet); after `npm ci` in `agent/` that file passes (40/40). Both typechecks and `npm run build` with the secret scan: see the final report.

`tests/customer-exclusion-phase53.test.ts`: CSV and XLSX fixtures through the real parser; exact, domain, registration, Arabic-normalized and brand matches; ambiguous matches; duplicate entities; empty and invalid files; tampered snapshots; retried pages; a fallback source under new ids; people stages; fail-closed ingest; switch OFF / ON / ON-for-another-account; the reader's user filter (cross-account isolation); a whole replayed mission on the model path (2 + 4 + 3 delivered, the excluded company and everything under it absent, charge = ceil(delivered × unit)); a whole replayed mission on the code engine (no people asked for the excluded company); the fail-closed execution (no provider call, no charge, balance unchanged). `tests/raw-delivery-contract.test.ts`: the reason inventory pin is updated on purpose (24 reasons; `customer_exclusion` is an allowed raw removal), marked CHANGED.

Mutation checks (runner kept outside the repository; one protection removed at a time, the file restored after each): **38 of 38 mutants caught** after this resumed session: the skip, the fail-closed throw, the approved digest and size (at ingest and at load), each matcher rule, the shared-host and free-mailbox guards, the people/company reading, internal keys, the 5,000 cap, repeats, the switch checks (chat and planning), the private copy, the reader's user and mission filters, the execution stop, the engine, model and `save_rows` wiring, the plan mark, the methodology line, the raw-mode allowance, the customer text, the chat's OFF sentence and the enrichment-intent guard. The first run of the 38 left four alive (internal keys under a nested record, the 5,000 cap, and the approved digest and size compared at load, which the old «altered copy» test changed together); three tests were added for them and all four are now caught.

## B. Phase 5.3-B: enrichment files (STOPPED for owner approval)

### B.1 What exists

* Upload, server parsing and conversation persistence (§A.1), and from PR A a secure way to associate a server-parsed list with ONE mission and give the worker the approved copy (card snapshot → private copy → digest on the plan). No migration is needed for that part.
* Company → official website → public contacts chain through TREG (`web_via_treg`, Phase 2, OFF) and the contact steps (`contact_steps`) that fill cells of delivered rows.

### B.2 The precise blocker

Making an uploaded list the approved starting dataset needs three things that the brief puts outside this campaign without owner approval:

1. **A new quote and approval model.** Every stage of a plan today is a provider capability, priced by `price.ts` from measured calls, recorded in the capability selection and re-verified at execution (`verifyApprovedScope`). A stage whose rows come from the customer's file has no capability, no measured cost and no record; adding one changes the pricing function's inputs and the approved-scope verification (a security control).
2. **New settlement semantics.** Settlement charges `ceil(delivered rows × unit)`. A supplied company is the customer's own row: delivering it again with nothing found would charge for nothing, and charging only rows with at least one found field is a new definition of a delivered unit.
3. **Paid enrichment calls per supplied row.** Each row needs a priced website and contact lookup that the customer approves in advance; that is a new paid operation with its own price per row.

PR B was therefore not implemented, and no workaround was improvised. PR A makes sure such a request is never applied as an exclusion and tells the customer plainly that it is not supported (§A.3).

### B.3 Smallest safe proposal (for owner approval)

* **Input:** reuse PR A's snapshot path unchanged, with its own switch `customer_enrichment_files_v1` (default OFF) and the intent reader; company name and corporate domain as identifiers; each supplied row keeps its original row number (`_input_row`) and is never replaced by another company (a found value is written only when its source names the same company by domain or exact name).
* **Plan:** one stage «الشركات من ملفك» (rows = supplied rows after repeats are removed, said on the card) feeding the existing `company.enrich` → official website → public contacts chain, plus social profile links read from the official site only. The count is the supplied count; no other company is searched for.
* **Price:** the existing pricing function over the enrichment chain's measured cost per supplied row (no new formula), reserved before approval as today.
* **Settlement (the decision):** a supplied row is a delivered unit only when at least one requested field was found from an official, publicly verifiable source; rows with nothing found are delivered free, marked «غير متوفر» per field.
* **Evidence first:** one capped live capture on the test account (≤ $0.20) before any customer use.

## PR A: result (recorded here, in the next code PR, as the discipline requires)

* PR [#495](https://github.com/iammagdy/digr/pull/495), one push (head `454aa5e`), one preview, merged through the PR as `390b6a2`.
* Preview `dpl_AECHFWcY5pGNF5v3o6xAcTa6Ahq5` READY on `454aa5e`; no mission or job was active at the merge (read-only check).
* Production `dpl_BPJaobJH97erx44pzfRiz1vUedH1` READY on `390b6a2` (alias `diger.tech`); Heroku release v203 «Deploy 390b6a2b»; worker heartbeat `390b6a2`, `active_missions 0`.
* After the deployment (read-only): `credit_ledger` 1,247 rows, sum 16,086 (unchanged); `agent_settings` keys `redesign_flags`, `social_discovery` only (no `customer_*` row); no queued, planning, approved or executing mission.
* Verification kinds: offline tests, typechecks, build, secret scan and mutation checks locally; preview and production deployment states and the read-only database checks above. **Not done: a real-browser test, a live customer mission, a live provider or model call.**

## C. Phase 6: provider update intelligence (PR C)

### C.1 What was built

| Part | File |
|---|---|
| Pure comparison, classification and fallback rules (no IO) | `src/lib/agentMission/capabilities/providerDrift.ts` |
| The read-only sync (manual command, injectable fetch, offline replay) | `scripts/capabilities/sync-providers.ts` |
| Last known-good metadata (the baseline the next sync compares with) | `data/capabilities/provider-metadata.json` |
| The reviewable report of the first sync | `docs/capabilities/sync-2026-11-14.md` |
| Offline tests and stored fixtures | `tests/provider-drift-phase6.test.ts`, `tests/fixtures/provider-drift/` |

It reuses the existing registry (`data/capabilities/registry.json`, its levels, fallback groups, policy and prices), the pinned TREG snapshot, the data-policy classifier that built `data_policy.json` (`scripts/treg/build-data-policy.mjs` `classify`) and `levelRank`. Nothing else was duplicated.

### C.2 The rules (all enforced by code and pinned by tests)

* **Public metadata only.** Allowed addresses: TREG `/meta`, `/openapi.json`, `/catalog/search` (four query keys only), `/catalog/endpoints/{id}`; the public OpenAPI files and changelog feeds of Firecrawl and Context.dev. Every other address (TREG `/call`, any `api.` host, another scheme, port, user-info, fragment, a credential in a query) is refused BEFORE a request is made. GET only, no credential header, redirects refused, a generic client name. The scripts never read the environment, a database or a secret.
* **A failed request is never a removal.** A time-out, a network error, a 429 or 5xx (retried twice), an unreadable answer, an answer for another id and a 404 that is not TREG's «unknown endpoint» are all «unverified»: the last known-good metadata is kept and nothing is concluded. Only a clear «unknown endpoint» is removal evidence, and more than a fifth of the ids asked answering that way is treated as an outage. A failed `/meta` keeps the last known paused providers. A public OpenAPI or feed that cannot be read is «unverified», never «no operations».
* **Discovered tools are reported, never activated.** A new endpoint is listed with its data-policy category and «never selectable until a reviewed PR adds it with evidence». The sync cannot write `registry.json`, `production-eligible.json`, `deprecated.json` or the reliability snapshot: its only writes are the report (`--out`), the replay folder (`--save`) and `provider-metadata.json` (`--write-baseline`; any other file name is refused). Production eligibility, routing, budgets and prices are not read or changed.
* **Classification:** added; removed (complete evidence only); renamed (a removed id and a new id with the same provider, capability and inputs; one new id renames at most one removed id); input breaking (a new required input, an input that became required, a removed input, a retyped input; a widened type such as `object` to `boolean|object` is additive); input additive; output breaking and output unknown (compared only where both sides state them: two snapshots; TREG's live answers state no list path, cursor or record fields, so they are never guessed); price changed (with its percentage), price unknown, a changed billing label; deprecated (status or `superseded_by`, naming the replacement the provider names); policy breaking (now blocked or paused with TREG's own reason, turned private, a stricter data-policy category); suspicious (negative price, a required input with no type). Schema fingerprint: sha256 of inputs and, when compared, list path, cursor path and record fields.
* **Web providers:** the public operations Diger calls (Firecrawl `POST /v2/scrape`, `/v2/search`, `/v2/map`; Context.dev `POST /v1/web/scrape`, `/v1/web/search`, `GET /v1/web/urls`, `POST /v1/people/search`) and every prebuilt parser Diger sends are checked against the provider's public OpenAPI. A call or parser Diger uses that disappeared is breaking and is mapped to the registry capabilities that stand on it (a removed `/web/scrape` breaks `contextdev.scrape` and every `contextdev.parse.*`). A new operation, a new parser, a changed version or server is reported, never adopted. Changelog items newer than the baseline are listed; one whose text announces a removal, deprecation or breaking change is marked for a human to read (a heuristic: «remove» alone is not enough).
* **Impact and safe fallback:** every breaking change is joined with the registry capabilities that call it, the approved plans given with `--plans`, and the review it needs (any production-eligible capability, or any plan). The only replacement proposed is a capability of the SAME fallback group that is at least as verified as the broken one (a production-eligible capability only by a production-eligible one) and never below `schema_checked`; not broken or deprecated; not itself changing in the same sync; not sensitive or blocked, and never stricter data than the approved source (a b2b-contact capability is not replaced by a sensitive one); carries every constraint and input class and documents every output of the broken one; and has a KNOWN price no higher per row than the approved one (the plan's own price when a plan is given). **When none qualifies the report says «no safe replacement» and substitutes nothing.** A proposal is for a reviewed PR; no code applies it.

### C.3 How it is run

```bash
NODE_USE_ENV_PROXY=1 npx tsx scripts/capabilities/sync-providers.ts --out docs/capabilities/sync-YYYY-MM-DD.md --save <folder> [--write-baseline] [--plans plans.json]
npx tsx scripts/capabilities/sync-providers.ts --offline <folder> --out report.md      # replays stored answers, no request
```

Manual, weekly at most. No cron, no scheduler, no Vercel, Heroku or Supabase change. (`NODE_USE_ENV_PROXY=1` only makes Node's `fetch` honour a sandbox proxy; the script reads no variable.)

### C.4 The first sync (14 Nov 2026, one manual run, free)

Public GETs only: 470 TREG endpoint answers, `/meta`, one catalog listing, two public OpenAPI files, two changelog feeds. No key, no billable call. The first run compared the live answers with the PINNED snapshot (27 Oct 2026); the baseline was then written, and a sync against it reports nothing (tested). Report: `docs/capabilities/sync-2026-11-14.md`.

* **TREG** 0.30.0; paused providers: `datagma`, `google-business-profile`. 470 of 470 registry ids answered (0 unknown, 0 unverified).
* **30 breaking changes, none on a production-eligible capability.** 29 are endpoints TREG now answers `platform_eligible: false` for («no longer offered through TREG's platform key»; several with TREG's own reason, for example no record cap on its key, «connect your own key»); 1 is a removed input (`exa.companies.search` `startPublishedDate`). 24 have a proposed replacement, 6 have none (§C.5). All 30 are `advertised` (26), `schema_checked` (3) or `broken` (1) in the registry: none is selectable for a customer today, so no plan is affected.
* **113 other changes:** 81 price changes (18 higher, up to +153%; 1 lower; 62 show the same USD figure), 63 changes of the billing LABEL (`per_success` ↔ `per_call`) and 32 new optional inputs. **The live answers do not say whether a failed or empty call is billed** (the pinned snapshot had a field for it), so the report says «confirm before relying on it» and does not claim either way. 14 of the 20 production-eligible capabilities have one of these (11 new optional inputs on `anyapi.*`, 3 `tikhub.*` label changes): nothing changed for them.
* **8 new TREG endpoints** in the last 8 days (5 are b2b-contact): listed, not selectable.
* **Firecrawl** v2 (56 operations) and **Context.dev** 1.0.0 (52 operations): every operation and parser Diger calls is present. Context.dev offers 7 parsers Diger does not implement (`reddit-post`, `reddit-search`, `reddit-subreddit`, `reddit-user`, `tripadvisor-reviews`, `yelp-reviews`, `yelp-search`). Firecrawl's `/extract` is still in the public OpenAPI (its announced removal is not visible in a 30-day feed window).
* Much of the diff is age: the snapshot is 18 days older than the live catalog. Refreshing the pinned snapshot and the registry from it is a separate, reviewed change (owner decision below); this campaign did not touch them.

### C.5 Fallback validation and the honest gap

For the 30 breaking changes the registry's rules proposed a replacement for 24 and found none for 6 (for example `exa.companies.search`: its same-group candidates are below the required tier or do not document every output; `crunchbase.people.search`: below the tier, or without every constraint it carries). Candidates are rejected with their reason in the report (tier, policy, missing constraint or input, unknown or higher price, itself changing). Nothing is substituted by code, and no production-eligible capability is replaced by a lower tier.

### C.6 Tests (offline only)

`tests/provider-drift-phase6.test.ts`, 81 tests: the address guard (accepted and refused addresses, credentials in headers and queries, the live fetcher refused before any request and its headers); every drift class above; schema fingerprints; the fallback rules one refusal at a time, the plan price ceiling, determinism and the honest «none»; impact and review; the whole sync on the real registry, pinned snapshot and committed baseline served from memory (nothing changed, removal, rename, a failed request in six forms, a wave of «unknown endpoint», a failed `/meta`, breaking schema with a plan, price and billing-label changes, deprecation, policy and pause, additions, Firecrawl and Context.dev path and parser removal, additions and failed documents, changelog flags); the command (writes only what it is told to, protected data files byte for byte unchanged, a baseline that is not named `provider-metadata.json` refused, replay of saved answers); the list of calls the sync watches against the adapters; no `process.env`, database or secret in the sources.

Final local gates for PR C: the whole suite 13,945 passed, 0 failed, 47 expected-fail, 78 skipped (991 files); `tsc --noEmit` and `npm run agent:typecheck` clean; `npm run build` and the client-bundle secret scan clean (210 files, zero secrets; the build needs `NODE_OPTIONS=--max-old-space-size=8192` in a 16 GB sandbox: the default 2 GB heap runs out).

Mutation checks (runner outside the repository, one protection removed at a time, the file restored each time): **56 of 56 caught**. The first run left three alive (a sensitive replacement for a b2b-contact capability, a broken candidate's own reason, and an endpoint of the pinned snapshot that the registry does not use being reported as «added»); tests were added and all three are caught.

### C.7 Limitations (said, not hidden)

* TREG's live answers state no list path, cursor path or record fields: the output contract is compared only against the stored real pages by the existing registry and card checks, not by this sync.
* Only the 470 TREG ids the registry uses are asked (of the 3,276 sellable); new endpoints come from the 8-day listing, which TREG caps at 100 with no offset (a partial listing is said to be partial).
* The list of web calls and parsers the sync watches is kept by hand (`USED_WEB_CALLS`); a test checks it against the adapters and the registry's parsers.
* The first sync's feed window is 30 days; a changelog item older than that is not read until a baseline date exists.
* Billing semantics for failed calls cannot be read from the live answers (§C.4).
* GitHub's `releases.atom` answered 403 and is not used.

### C.8 Not done, by design

No cron or scheduler; no registry, eligibility, price, route, budget or customer-text change; no automatic demotion or activation; no provider data or billable call; no infrastructure, migration or switch.

## Owner decisions (new in this campaign)

1. Turn `customer_exclusion_files_v1` on for the test account, then for customers.
2. Whether a POSSIBLE match (shared brand word only) should also be excluded.
3. The Phase 5.3-B proposal (§B.3): its settlement rule, its switch and its live capture.
4. Phase 6: whether to open a reviewed PR that refreshes the pinned TREG snapshot and marks the 29 endpoints TREG no longer offers on its platform key (§C.4); the weekly manual sync; asking TREG how failed calls are billed under the changed billing labels; whether to implement any of Context.dev's 7 new parsers.
