# REDESIGN: from "customer types a request" to "customer receives the file"

Status: DESIGN, owner-approved in the brief that started this task (2026-11-01). Nothing in this document is built yet.
This file is the single source of truth for WHAT the new pipeline does. HOW and in WHAT ORDER it is built is in `docs/REDESIGN-PLAN.md`.
Written against `main` = `e2c4fda` (merge of #328). Docs only: no runtime code, config, env var, database or SQL was changed to produce it.

Evidence marks used in both files:
- **V** = I read the line myself in this session.
- **V-R** = a read-only research agent read the line and reported it; I did not re-read it.
- **GUESS** = inference, not read.
- **NOT VERIFIED** = needs live data, the live database, Heroku, Vercel env, or the paid provider; none of these was touched.

---

## 0. Why we are redesigning (root cause, agreed with the owner)

Data comes back incomplete or wrong mainly because **the request we send to the provider is incomplete or ambiguous**. Then about twenty post-fetch rules throw away data we already paid for. Every earlier fix was local and was later undone (`docs/AUDIT-2026-11.md` section 0).

Measured in the code today (details and file:line in the plan, section "Findings"):
1. The provider request is written by the model and frozen as the stage recipe. Code adds only the cursor, the parent id, and a date window in three narrow cases. No code maps "language", "country", "date range", "sort" or "replies" onto a tool's input fields. (V: `agent/src/gateway.ts:188-206`, `agent/src/engine/spec.ts:160-169`; V-R: `spec.ts:103,193`.)
2. Those conditions are instead enforced AFTER the fetch, by filters that remove rows we paid for. We counted **25 drop points** in the agent pipeline, not 12 (plan, finding F4).
3. Tool choice is by price only. Nothing checks that the chosen tool's input schema can express the customer's conditions. (V-R: `src/lib/agentMission/sourceRanking.ts:144-199`.)

---

## 1. Understanding the request

1. The customer writes freely in Arabic.
2. **Models.** Fast chat replies and cards: Claude Haiku 5.5 (`claude-haiku-5-5`). Planning and building the provider request: Claude Haiku 5.5 with extended thinking enabled. **No other model is introduced.** (Today the code also allows `claude-sonnet-5-5` for planning through an admin setting: `src/lib/agentMission/constants.ts:51-52`, V. The new pipeline pins Haiku 5.5 and ignores that setting. See open decision D4.)
3. **Catalog first.** Before asking the customer anything, the agent searches the provider catalog and reads the input schemas of the candidate tools, so it asks only what changes a tool input. No generic questions.
4. **"Understood your request as" card**, editable. Fields, each tappable to edit:

   | Field | Meaning |
   |---|---|
   | المنصة | platform |
   | الموضوع | topic / keywords |
   | المصدر | account, URL, page or channel when the customer named one, else "بحث عام" |
   | الفترة | date range |
   | اللغة | language |
   | الدولة | country |
   | العدد | count |
   | الردود | replies yes/no (and how many per comment) |

5. **Question cards.** A missing important field becomes at most **three** question cards, each with ready options plus «شيء آخر». Questions are chosen from the candidate tools' input schemas (a field the tool has and the request does not fill).
6. **Plan, price, approval.** Then the plan with the price, then the customer approves. **Nothing is spent before approval.**
7. **The cards that stopped appearing.** Investigated; the cause and the fix are in the plan (findings F8 and PR 2.1, 2.2). Short version: the old question/plan cards were bypassed when the agent took over the chat, and the «how we understood your request» block was folded into a closed `<details>` on 2026-10-31.

## 2. Building the provider request

1. Search the catalog, **compare candidate tools**, read the chosen tool's input schema, and fill **every field that matches a customer condition**: date, language, country, account/URL, count, replies (and sort, where the customer implied one).
2. **Compare by what the tool can express, then by price.** A cheaper tool that cannot take the date range loses to a dearer one that can, unless no tool can.
3. If a condition has no field in that tool, look for another tool that has it. If none exists, **say it honestly in the plan before approval** (plain Arabic line on the card, e.g. «لا يوفّر المصدر تحديد اللغة، فنسلّمك النتائج كما وردت ونضع عمودًا يبيّن لغة كل نص»).
4. **The request is built by code from a structured "understood" record**, not free-typed by the model. The model proposes the record and picks the tool; code writes the tool input from the tool's schema (types, enums, min, max, required) and refuses an unknown or invalid field instead of silently deleting it.
5. TREG only for now. Firecrawl and Context.dev are out of scope.

## 3. Execution

1. **Fetch in batches/pages until the requested count is reached.** "All comments" means all of them (read each parent until its source ends; the approved reserve and the job cap bound it, see section 9).
2. **The customer always receives the count they approved**, or an honest, code-computed statement of the shortfall and its reason, and is charged only for what was delivered.
3. **Tool fails or returns empty: move to the next suitable tool and continue from where it stopped, not from the start.** "Where it stopped" means: keep every item already accepted, continue to fill the remaining count, carry the date boundary reached (oldest or newest item so far), and skip ids already stored. A provider cursor cannot be carried to a different provider, so the continuation is by count, date boundary and id, not by cursor.
4. **Before saying "not found"** (for example a company e-mail or phone), try every relevant tool in the catalog, cheapest first, inside the reserve.
5. **Retries and alternative tools happen inside the approved reserve.** If more is needed, stop and ask the customer with a **new priced plan**.
6. **Checkpointing.** Every batch is saved as it arrives (the item store is already append-only; the planning step is not, see plan finding F10). After a worker crash or restart (the known memory stop near 580 MB), the job resumes from the last saved batch, and so does planning.

## 4. Delivery: RAW, no filters

1. The roughly twenty post-fetch rules are removed in the new pipeline. The inventory (file:line, what each drops, what replaces it) is in the plan, section "Filter inventory".
2. **The only removal allowed is an exact duplicate:**
   - Social posts, comments, replies: **the same record id returned twice** (for example by pagination or overlapping windows). The key is platform + record id within the stage. **The same text from different people is kept.**
   - Companies: the same company twice (same provider company id or same web domain). People: the same person twice (same profile URL, or same name at the same company). Name-only matches are NOT enough to remove a company (open decision D5).
3. **Nothing is judged on content.** Comments are never filtered. No language rule, no topic rule, no relevance model, no "is this a person" rule removes a row.
4. **Mark instead of drop.** A condition the customer asked for that we cannot enforce at the source becomes a column. Found values are always delivered, marked:

   | Today's drop (reason code) | New mark column (Arabic header) | Values |
   |---|---|---|
   | `not_at_company` | «يعمل حاليًا في الشركة» | نعم / غير مؤكد / لا |
   | `no_verified_contact` | «حالة توثيق الإيميل» / «حالة توثيق الهاتف» | موثّق / غير موثّق |
   | `not_a_person` (role mailbox, department) | «نوع الجهة» | شخص / بريد عام للشركة |
   | `filter_reply` | «نوع التعليق» (exists) / «رد أم أصلي» for posts | أصلي / رد |
   | `filter_repost` | «إعادة نشر» | نعم / لا |
   | `filter_language` | «لغة النص» | العربية / أخرى / غير محددة |
   | `filter_period` | «ضمن الفترة المطلوبة» | نعم / لا / تاريخ غير معروف |
   | `filter_place` | «المكان» | مؤكد / غير مؤكد |
   | `filter_account` | «المصدر المسمّى» | الاسم / غير مطابق |
   | `filter_media`, `filter_government` | «يحمل فيديو أو صورة» / «جهة حكومية» | نعم / لا |
   | `no_term`, `mention_only`, `other_person`, `name_extended`, `other_meaning`, `uncertain`, `review_no` (topic and namesake rules, LLM review) | none: removed, nothing replaces them | |

5. **Parent link is sheet structure, not a filter.** Comments and replies stay linked to their parent post: parent link and title on every row, parent comment id on a reply, a reply sits under its comment (the structure of `docs/AUDIT-2026-11.md` section 1C).
6. **Claude only organizes and formats the sheet.** No model decides which rows are in the file.
7. **Count rule with raw delivery.** The customer's number is a cap on what is fetched and charged. Rows beyond it that the provider already returned in the same page are not delivered (the customer pays for N). This is unchanged from today (`agent/src/items/ingest.ts:260`, V) and stays an owner decision (D6).

## 5. Optional paid review

1. A checkbox «راجع الملف قبل التسليم», or requested after delivery.
2. **Review never deletes a row.** It produces a report and a score (for example «٧٠٪ مؤكد») and lists problems: missing data, numbering, formatting, broken links.
3. The customer chooses **yes / no / other** through interactive buttons.
4. If the customer wants the missing or wrong part fetched: a **new priced plan**, approval, then a **NEW VERSION of the same file** with the fixed rows merged in. **The old version is kept.**
5. **Review price is computed by code from the file size** and shown before approval. The model never decides money.

## 6. Post-delivery edits

1. The customer says something is wrong or asks for a change: Claude checks and edits **the same file as a new version**, not a new plan from scratch. Only the changed part is read.
2. **Price = real cost of the edit x markup, minimum 100 points**, computed by code, shown before approval. (Conflict to resolve: `docs/AUDIT-2026-11.md` section 9 item 4 recorded a 20-point minimum as DECIDED. See D2.)
3. **OPEN DECISION, not implemented: whether fixes caused by our own mistake are free.** (D1.)

## 7. Live sheet while waiting

1. **Each batch is written immediately to a "preview" store.** The site shows rows as they arrive. The preview is **display only and never touches money.**
2. **Target design (owner-approved): a Supabase table with Row Level Security (each customer sees only their own rows) and Supabase Realtime.** That needs SQL and a Realtime publication, and Realtime is today deliberately forbidden by a test (plan finding F9, open decision D3). So the build is staged: (a) the same UI fed by a polling endpoint that reads the item store, no SQL; (b) the preview table, RLS and Realtime later, behind explicit owner approval.
3. **Desktop:** looks like a real Excel sheet inside the site: frozen header with **the same column names as the final file**, Arabic, RTL, row numbers, each new row appears with a soft highlight that fades.
4. **Mobile:** no table. Small cards for the latest rows (newest on top, replies indented under their comment), with a counter and a progress bar on top.
5. **Counter:** «X من N» in Arabic-Indic numerals. When done, a «تحميل الملف» button replaces the counter.
6. **"Claude's work notebook":** one plain-Arabic line that updates («وجدنا الفيديوهات، ونجلب الآن الردود»). It is chosen from a fixed code whitelist keyed by stage events; it **never** names a provider, endpoint id, USD amount, or model vendor.
7. **The final file is built from the same rows the customer watched** (the same item-store segments; a test compares preview rows to workbook rows).

## 8. Queue

1. If another job is running: a friendly message with the customer's position and an approximate start time, plus an option «راسلني عند بدء مهمتي».
2. **One e-mail per job at most, and only if the wait is longer than one minute.** Respect the Resend limit (50,000 e-mails per month); never spam. (Today the agent path sends no "started" e-mail: `src/lib/agentMission/notices.ts:48`, V-R `email: null`.)

---

## 9. Money rules (sacred, unchanged by this redesign)

Append-only ledger. Deterministic ids `res_`, `rel_`, `chg_`, `top_`. Release-first. Idempotent. **Charge = ceil(delivered x unit price), never above the reserve.** 15% buffer on the reserve only. Nothing spent before approval. **The LLM never decides money: code computes every price and charge.** `PROVIDER_DAILY_SPEND_CAP_USD` stays 0.80. Markup 10x (1 USD of cost = 5,500 points).

**Job cap.** Owner decision: 25,000 points per job; bigger jobs are split into stages, each with its own plan, approval and charge. **Current value in code: `JOB_MAX_POINTS_CAP = 25_000`** at `src/lib/jobPointsCap.ts:13` (V); the `JOB_MAX_POINTS_CAP` environment variable may only LOWER it (`jobPointsCap.ts:20-23`, V). It is not 600 in code. The old 600 survives only in the seed migration (`supabase/migrations/20261012200628_seed_initial_configuration.sql:25`, V) and in comments. The live environment variable and the live SQL functions were NOT read (no SQL allowed in this task); `docs/HANDOFF.md:256` records them as 25,000 on 2026-10-31. The staged-job flow for jobs above the cap does not exist yet (plan PR 6.4).

## 10. Owner rules for customer-facing text

Customers never see provider names, endpoint ids, USD, or the model vendor. Arabic only, Arabic-Indic numerals, no emoji, in every customer-facing string (cards, notebook line, preview headers, review report, e-mails). The existing guard is `checkCustomerText` (`src/lib/agentMission/text.ts`). Every new string goes through it, and the preview and notebook strings get a test that scans them.

## 11. Switching: feature flag per request type

The new pipeline sits **behind a flag per request type**: social posts search, account posts, comments and replies, companies, people, places. Default OFF. The old pipeline keeps working until each type is proven live. There is no big-bang switch. Flags are read from the existing `agent_settings` key/value table (no SQL), and flipping one is a settings change, not a deploy.

---

## 12. Current vs new

| Area | Current (evidence) | New |
|---|---|---|
| Who builds the provider request | The model writes sample params; code freezes them as the recipe (V `spec.ts:160-169`; V-R `spec.ts:103,193`) | Code builds the input from a structured understood record and the tool schema |
| Conditions in tool input | Only if the model happens to write them. Unknown keys are deleted silently (V `gateway.ts:201-202`); enum/min/max not validated (V-R) | Every matching field filled; unknown or invalid fields refused; unexpressible conditions stated on the plan |
| Tool choice | Cheapest first; the only checks are model-supplied reasons (V-R `sourceRanking.ts:144-199`, `tools.ts:176-214`) | Rank by condition coverage, then price |
| Reading the tool schema | Prompt advice only; `describe_endpoint` need not be called before `treg_call` (V-R `tools.ts:375-399`); `catalog_search` shows 10 inputs (V-R `modelPlanner/tools.ts:76-80`) | Mandatory; the profile of each candidate is computed by code |
| Questions before planning | One model question at most, 2 to 4 options, prompt says "decide, do not ask" (V `tools.ts:531-558`; V `agent/prompts/system.md:13`) | Up to three catalog-driven cards plus «شيء آخر» |
| Understood card | Folded in a closed `<details>` since 2026-10-31 (V `AgentMissionCard.tsx:196-201`) | Open, editable, drives the request |
| Pagination | One page for endpoints whose catalog `pagination` lacks a cursor input (V `spec.ts:164`; V `run.ts:394-396,425-426`) | Cursor discovered from inputs; read until count or source end |
| All comments | Needs a number; per-parent cap; 5,000 rows total cap (V-R `quantity.ts:230-238`, `constants.ts:234`) | Read to the source's end inside the approved reserve; staged above the job cap |
| Failure / empty | Same endpoint only; no switch to another tool (V `run.ts:398-407`; V-R) | Next suitable tool, continuing by count, boundary and id |
| Post-fetch rules | 25 drop points (plan F4) | Exact duplicates only; the rest become columns |
| Same-text posts | Merged across authors for top-level posts (V `ingest.ts:87,132-139`) | Kept when from different people |
| Planning restart | New SDK session, no conversation; only call digests are replayed (V `sdkOptions.ts` `persistSession: false`; V `runMission.ts:92-106,279`) | Planning state checkpointed and resumed |
| Live sheet | Card polls mission state; no rows shown (V-R `AgentMissionCard.tsx:51-77`) | Rows stream into a sheet or cards |
| Realtime | Zero uses; a test forbids it (V `tests/supabase-free-plan-limits.test.ts:18-27`) | Optional, behind owner approval |
| Edits after delivery | Only while `plan_ready` (`docs/AUDIT-2026-11.md` G16) | New version of the same file |
| Queue message | Position line exists (V-R `customerView.ts:194-200`); no start e-mail | Position, ETA, one optional e-mail |
