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
| **5.3-A exclusion files** | Yes (PR A) | Yes (§A.5) | **No** | **No.** `customer_exclusion_files_v1` is unset. | Turning the switch on (test account first) |
| **5.3-B enrichment files** | **No: stopped** (§B) | The honest refusal is (§A.3) | No | No | A pricing and settlement decision (§B.3) |
| **6.1 provider sync** | see §C (PR C) | | | | |
| **6.2 breaking changes** | see §C (PR C) | | | | |

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

## C. Phase 6: provider update intelligence

Added by PR C.

## Owner decisions (new in this campaign)

1. Turn `customer_exclusion_files_v1` on for the test account, then for customers.
2. Whether a POSSIBLE match (shared brand word only) should also be excluded.
3. The Phase 5.3-B proposal (§B.3): its settlement rule, its switch and its live capture.
