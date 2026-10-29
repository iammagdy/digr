# Diger Platform Engineering Handoff & QA Status

This handoff document provides a clear, factual status of the Diger platform (`iammagdy/digr`) for engineering agents (Codex), developers, and the project owner.

---

## START HERE (2026-10-29, after #292): the six compound missions (fix mission 6)

`main` before it was `dfefa2989e06b004e35c2fa870558f2385cd87ed` (#292); its merge commit is the head of `main` after it. Evidence, root causes 1-7, tests and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 10. No SQL written or applied; no Edge Function changed; no price, cap or model string changed.

- **The 1,000-tweet refusal was a DEPLOY of the worker, not a size limit** (the model's process ended with exit code 143 one minute after #292 was merged). A run cut short by a restart now goes back to the queue (planning: `queued`; execution: `approved` with what it saved), own counter, own limit. 1,000 and 5,000 tweets reach a card and are delivered in full (`tests/large-missions.test.ts`; they also passed on the code before).
- **Per-parent numbers are the customer's**: the child stage's target is parents x the number in the request (the card said «حتى ٧» for 5 x 10); every parent is read up to its share, in the source's order; a lower target is shared out equally.
- **The child rule on the card**: the language/topic sentences name the PARENTS only; a sentence that promises a language or topic for the children is refused; the shortfall reason of a child stage is «بعض الفيديوهات عليها تعليقات أقل من العدد المطلوب لكل فيديو» (never the language: the TikTok source itself gave 10, 6, 10, 10, 5).
- **No step dropped silently**: a step asked per parent that the plan cannot serve is shown on the card before approval («خطوة لم تُضَف إلى الخطة») with its reason (`unserved_steps`); the companies mission also failed because a country field holding «EG» was no place evidence, the sector words were garbled and English names never matched the Arabic sector word; fixed.
- **File names** always carry the subject (account / channel / topic / sector); **media-only posts** show «منشور بصورة أو فيديو دون نص» in the file.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #291): the admin panel reorganised (layout and navigation only)

`main` before it was `32fcd5c38cdde4e87c414b7b5cb2e07398c024a2` (#290); its merge commit is the head of `main` after it. Map, screenshots and details: `docs/admin-reorg/README.md`. No API, SQL, money, key-pool behaviour, worker, price or customer text changed; no admin address moved.

- **Menu**: 20 pages in six sections (`src/components/admin/nav.ts`; `ADMIN_PAGES` in `icons.tsx` unchanged). Only the open section is unfolded; every page has a one-line description and section chips under its title.
- **«مزودو الخدمة»**: four short views per provider (status and balance, keys, limits, call log), kept in the address `?p=<provider>&v=<view>`.
- **Key pool table**: no horizontal scroll at 1280 px, cards at 390 px (`.rtable` / `.rtable-wrap` in `globals.css`, a container query, also used by the call logs), number once, status badge, main key marked, one action visible and the rest in a small menu.
- Tests: `tests/admin-navigation.test.tsx`; two selectors moved from `AdminShell.tsx` to `nav.ts` (`tests/conference-dashboard.test.tsx`, `tests/phase4-failures-board.test.ts`).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, after #289): the TREG key pool (many keys, one active, a fallback chain ending at the main key)

`main` before it was `51e5d3a1dfee5c5fcb32db7d22dcec9f3a7ede8c` (#289); its merge commit is the head of `main` after it. Design, SQL proposals, owner decisions D1 to D8, rollout checklist and NOT PROVEN: `docs/proposals/treg-key-pool/README.md`. SQL 01 to 04 were applied by the owner; **06 (`treg_pool_keys_for_check`) is a later addition and must be applied before the background health check works**. No money table or function, no price, cap, model string or customer text changed.

- **Rollout switch, OFF by default** (admin «مزودو الخدمة» → TREG → «مجمّع مفاتيح TREG»). OFF = exactly today: website store key then `TREG_TOKEN`; Heroku worker `TREG_TOKEN`. Turning it OFF restores that within about 3 seconds. `TREG_TOKEN` on Heroku is never touched; it is the worker's legacy and emergency source.
- **One shared module** (`src/lib/server/tregKeyPool.ts`) used by the website (resolver + `executeTregCall`) and the worker (gateway passes `legacyToken`). ON: the active pool key from a 3-second view of `treg_pool_runtime()`, so a switch is live on the next call; a running mission continues on the new key.
- **Failover**: 401/403 (verified with the free `/auth/me`) or 402 (not a price cap) on the active key → recorded (`treg_pool_record_failover`, compare-and-set) → next healthy key of the admin's chain, main always last → the call is retried once on it (at most 3 hops, the last on main) → admin e-mail through the outbox. Timeouts, 5xx, 429, 400/404/422 and price caps never switch.
- **Secrets**: keys AES-256-GCM encrypted in the app (AAD = the key's row id) with a key generated inside Supabase Vault (`diger-treg-pool-enc-key`, read via the service-role-only `treg_pool_enc_key()`); no Vercel/Heroku variable was added; the old key store and `PROVIDER_KEYS_ENCRYPTION_KEY` are untouched. Keys never reach a browser, a log, an error, an audit line or an e-mail.
- **Emergency**: pool/DB/Vault unreadable → the worker uses `TREG_TOKEN` (never a non-main key after a 30 s grace on the admin's own active key) and the admin is told (queued, sent when the DB is back; direct if `ADMIN_ALERT_EMAIL` is set on Heroku).
- **Health check**: pg_cron `diger-treg-pool-tick` → `/api/cron/treg-pool` (cron secret): sends waiting e-mails and, at most once per 10 minutes, checks every key with read-only identity and balance calls.
- **Call log per key**: `treg_pool_calls` (cost row → key number and label); calls log key filter, column and per-key spend; the export gets one extra column only when rows carry marks.
- Tests: `tests/treg-pool-*.test.ts*` (fake TREG, in-memory model of the SQL functions) + `tests/helpers/tregPoolKit.ts`. One existing test changed: `tests/provider-status.test.ts` (it passed four different random keys where it meant one key; the status cache is now per key).
- Rollback: switch OFF in the admin (seconds), then `git revert -m 1 <merge commit>`, then the rollback SQL files in reverse order (06, 04, 03, 02, 01).

---

## START HERE (2026-10-29, after #288): raw child items, place enforced, Facebook always reaches a card, scale (fix mission 5)

`main` before it was `90ca9010a4eafb17caaf538eecdee2ed971bdf4e` (#288); its merge commit is the head of `main` after it. Details, evidence, the scale table and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 9. No SQL written or applied; no Edge Function changed; prices and settings untouched.

- **Child items are raw** (comments, replies, reviews, employees): no topic, language, place or text-dedup rule on them; only the same item id is one item; the card says so; relevance/language/place choose the parents and the top-level items.
- **Facebook**: planning budget scaled to the platform's cost by code (0.1254 for posts + comments, hard cap 0.20), the honest cost sentence on the card, two give-up attempts sent back; the quantity «٥ بوستات ... مع كل بوست ١٠ تعليقات» now counts the posts (it counted the comments).
- **Place/country** is enforced from mapped fields (country, city, address, website suffix, phone prefix); companies of a sector are checked by kind (exhibition / other trade go to the model check).
- **Scale**: page cap grows with the volume sold; `listCalls` reads every call (pages of 1,000); measurements in `tests/scale-engine-2000.test.ts`.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, late night): cheapest source first, source health, planning budget split (after #287)

`main` before it was `3349e3d3ae55b9872fcdd2ded2b7f5b195e2b8f4` (#287); its merge commit is the head of `main` after it. Details, the offline re-plan table and NOT PROVEN: `docs/ENGINE_AND_ITEM_STORE.md` section 8. No SQL written or applied; no Edge Function changed; prices and settings untouched.

- **Ranking by code** (`sourceRanking.ts`, `candidates.ts`): the sources that do the job, ranked by expected cost per delivered item (measured from `mission_calls`, the catalog otherwise); `catalog_search` returns that list; a pricier source of the same job needs `skip` {id: reason} or `why`; a third sample of one source stays refused.
- **Source health** (generic, no provider rules): configuration failures skip a source, input/validation failures demote (1) or skip (3) for 24 h until it gives rows again; admin list: `GET /api/admin/agent/sources` and the «صحة المصادر» panel.
- **Planning budget split**: 30% kept for the first sample of every stage not yet sampled (`stage_reserved`).
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, night): the five-mission live run (after #286)

`main` before it was `3a3e6b0709b4b8cebe163cb3ac0d2645345be31f` (#286); its merge commit is the head of `main` after it. Details, evidence and the companies price breakdown: `docs/ENGINE_AND_ITEM_STORE.md` section 7. No SQL written or applied; no Edge Function changed; prices untouched.

- **Four honest classes for a no-card end** (`refusal.ts`): needs a detail (one question with answers), unsupported, OUR planning failed (budget/limits/all sources failed: status `failed`, admin flag, «من جانبنا»), source truly empty (only after a real empty sample). The live Facebook request was our planning budget (three 5-post searches of one source), shown as «لم نجد ما يطابق» because a stored sentence with a digit is dropped; the planning now refuses a third sample of one source.
- **Parents tell the truth**: card «حتى ١٠ فيديوهات», tracker and summary sheet «قُرئ ١٠، ومنها ٦ لها نتائج»; counts from the item store; no «صف»/«سجل» in file notes.
- **One language rule**: the request's language is the default content language of every text stage (filter added by code, stated on the card, editable); shortfall says so.
- **Download name**: one function on every route; a place request names the file after the place.
- Open owner decision: the companies price (63 points per company, source `companyenrich` 0.0098 USD per company vs 0.00025 before): section 7 of the engine doc.
- Rollback: `git revert -m 1 <merge commit>`.

---

## START HERE (2026-10-29, evening): the delivered file of the live run (after #285)

Written after the live run `msn_169c911fd8a0a5c89cf1` (67 of 300, charge 45, hold released: the count/charge core was right and is untouched). `main` before it was `8f9b2acfc4811c7a0411f9b851edb034811c5f71` (#285); its merge commit is the head of `main` after it. Details and root causes 1-7: `docs/ENGINE_AND_ITEM_STORE.md` section 6. No SQL was written or applied; no Edge Function changed.

- **Namesakes:** a full name extended by more name words («محمد صلاح عبد الفتاح», «أبو عمر») is another person, excluded by rule; the plan lists the other meanings it found (`relevance.competing_meanings`); a row with the full name and no context word that looks like an advert or a list goes to the model check.
- **Repeats:** the same text with other emoji, hashtags, links or a leading «عاجل» is one item. **Replies:** a text that starts with `@handle` is a reply whatever the source's flag says.
- **One download name** (`missionDownloadName`) for the panel, «طلباتي» and the admin; **render-time guard** (`customerSafeText`) so no English or internal phrase reaches a customer in any state; release reasons are written in Arabic; **file notes** describe only the sheets and columns the file has.
- Rollback: `git revert -m 1 <merge commit>`. NOT PROVEN list: end of section 6 of the engine doc.

---

## START HERE (2026-10-29, later): the contract between the plan and the engine

Written by the session that diagnosed the two missions of 2026-10-29 (read-only) and fixed them. `main` before it was `a9c8666386e62e0e3f8b31b3b09195adf693126e` (#284); its merge commit is the head of `main` after it. Details and evidence: `docs/ENGINE_AND_ITEM_STORE.md` section 5. No SQL was written or applied; no Edge Function changed.

- **M1 was our failure, not memory:** the plan's mapping had no `id`, the engine rejected every item. Now the recipe proof requires an id (or a key code derives one from) and every column and filter field, the engine derives ids, and zero items stored from non-empty pages is an INTERNAL failure (hold released whole, admin flagged in `missions.error` and an `adm_source_rows` event, the customer told it was ours).
- **The quantity is set by code** from the customer's words (digits and number words); the model may go lower only with a reason shown on the card; one target everywhere; settlement against the approved target; below the request is `partial`, never «N من N».
- **Every card promise is a filter in code** (replies, reposts, language, period, account, place) and posts/comments with the same text are one item. A promise without its filter is refused at plan time.
- **«عدّل الطلب» edits the plan itself** (count, period, language, exclusions, columns), priced again by code; «اكتب الطلب من جديد» (cancel and retype) stays.
- **The card never goes deaf** (polls while waiting and working, reads on tab focus, says the end once); the worker writes a heartbeat history as object names under `_worker/heartbeat/` (no SQL).
- Rollback: `git revert -m 1 <merge commit>`. NOT PROVEN list: end of section 5 of the engine doc.

---

## START HERE (2026-10-29): the agent, the item store and the engine

Written by the session that fixed the lost-items defect (PR: «One item store, a code engine, settle from the file»; its merge commit is the head of `main` after it; before it `main` was `f6dfd3e30f5474c23eadbe7e177570db4e795663`, #283). Everything about the agent is in `agent/README.md`; this change is explained, with the raw evidence, in `docs/ENGINE_AND_ITEM_STORE.md`.

- Diger runs missions through a Claude agent (`agent/`, Heroku app `diger-agent`, auto-deploys from `main`, model `claude-haiku-5-5`, never change it). `AGENT_SERVES_CHAT = true`: every customer is served by it. Supabase `pfinlfaqwnytesedchik`: tables `missions`, `mission_events`, `mission_calls`, `agent_worker_heartbeat`, `agent_settings`; private bucket `agent-missions`.
- **The incident**: a mission showed 300 of 300, delivered and charged 192, and its file held 77 items. Cause: items were kept in one object that every save read, extended and overwrote, and Storage serves an overwritten object stale (up to 60 s). Fixed by ONE append-only item store of immutable objects, a code engine for plans whose stages have a proven recipe, a `finish` gate for the model path, and settlement from the read-back file.
- **Money text**: one line per mission everywhere (panel, «طلباتي», notification, e-mail, wallet): «خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة». The wallet groups a mission's ledger rows under it. The plan card: the price shown is the full-delivery price, fewer costs in proportion, nothing costs nothing.
- No SQL was written or applied. No e-mail template changed (the `job-update` template only receives other text), so no Edge Function deploy is waiting.
- The rules below ("Standing rules") still hold. Everything older in this file is history and may be stale.

---

## START HERE. Current state (main = `2d698d3`, 2026-10-25)

A fresh session can start from this section. Facts come from git, the Vercel deployment API and the owner's briefs; anything not verified in the repo or in a brief is marked **owner-reported**. No secrets or passwords are written here.

### Main and production

- `main` head: `2d698d3bac86266c4785797f7d6c55902c3da854` (merge of PR #251). Production deployment `dpl_81J9hF66CDRQRTdJptLKeRbScDpx`, READY on that SHA (one check, before this handoff PR).
- Merge rule: MERGE COMMITS only (never squash, never `--admin`, never force-push). Rollback of any PR: `git revert -m 1 <merge commit>`.

### Merged since the UI/UX audit (PR, merge commit)

| PR | Merge | What |
|---|---|---|
| #236 | `b772c7d` | live-check fixes |
| #237 | `510cf4e` | invalid contact values |
| #238 | `f8c0a52` | small fix batch 2 |
| #239 | `f8636f8` | send-email caller authorization |
| #240 | `7236994` | hero effect restored |
| #241 | `31abb74` | hero sentence |
| #242 | `72ae38a` | sidebar polish |
| #243 | `693739d` | admin export as ZIP |
| #244 | `b0c7ecd` | shared test-account classifier |
| #245 | `d440537` | InstaPay link and QR |
| #246 | `faf99e9` | InstaPay guard for a handle |
| #247 | `c3ce0a2` | top-up logic and owner alert e-mail |
| #248 | `8596019` | wallet and top-up visual redesign |
| #249 | `ac2a7d4` | e-mail fixes (send-email v3) |
| #250 | `edd114d` | one right-to-left base layout for all 8 e-mail templates (send-email v4) |
| #251 | `2d698d3` | rejection reason shown to the customer from their own notification `notif_<topupId>`; no SQL |

#251 detail: `reject_topup_atomic` stores only the status, so the reason is read from the customer's own notification row (RLS: own rows). A durable column is only a proposal: `docs/proposals/topup-reject-reason-column.md` is **NOT APPLIED** and nothing depends on it.

### Owner-applied production changes that are NOT in git

All applied by the owner by hand; the repo only has proposals or code that expects them.
- Supabase Auth rate limits back to defaults: e-mails 30/h, sign-ups and sign-ins 30 per 5 min, token verifications 30, refresh 150 (owner-reported).
- `send-email` Edge Function deployed as **version 4**, `verify_jwt=false`, files `index.ts`, `authorize.ts`, `templates.ts`, `resendHeaders.ts`. Caller key is checked by a real admin call (`authorize.ts`). Deployed through the Supabase connector and verified by a hash read-back. Edge Function deploys happen only on the owner's explicit go.
- Avatar SQL applied: `profiles.avatar_path` with a CHECK and a column grant; private bucket «avatars» (2 MB, jpeg/png/webp); four own-folder storage policies (owner-reported).
- Function `create_verify_fixture` dropped (verified: 0 rows). `docs/OWNER_SQL.md` section 5 is done.
- Manual backups through `/admin/export`, including the ZIP (owner-reported).
- Vercel variable `ADMIN_ALERT_EMAIL` set (owner-reported). The InstaPay details are real (owner-reported).

### Decisions (keep them)

- **No reset of test data.** There are real customers (two accounts, owner-reported) and the ledger is append-only. Test accounts stay and are told apart by the shared classifier: `@digr.local`, `iam.magdy@outlook.com`, `iam.magdy+*@outlook.com`, known test ids. The admin account is not a test account. `iam.magdy+1` keeps its balance.
- `docs/OWNER_SQL.md` **section 1 (reset) must NEVER be run**; section 6 (seed) is stale and must never be run.
- Anthropic monthly limit: 50 USD (owner-reported). An InstaPay link cannot carry an amount.
- Review sentence on the top-up page: «غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط».

### Standing rules

- Merge commits only. A PR merges only when the preview is READY on the exact full head SHA, only the skipped Supabase Preview check is non-green, tests pass (skipped = 57) and main has not moved; a BUILDING preview waits for the owner's GO. One production status check after each merge.
- No SQL run by agents: SQL is a proposal under `docs/proposals/` marked NOT APPLIED, and the owner applies it by hand after review. No Edge Function deploy without the owner's explicit go, verified by hash read-back. No background timers. One Vercel check per report.
- Customer text: Arabic only, Arabic-Indic digits, «حجز مؤقت مُحرَّر» as the only released-hold form, no provider names, no USD, no internal ids.
- Money: append-only ledger; charge = ceil(delivered x unit price), never above the reserve; the 15% buffer applies to the reserve only; the LLM never decides money. Do not touch ledger, pricing or `approve_topup_atomic` without an explicit brief.

### NOT PROVEN / open

- A real-device mobile check by the owner (the 14-item list below).
- The Phase 1 to 4 NOT PROVEN lists below stay valid.
- E-mails were not tested in Gmail, Outlook desktop or Apple Mail dark modes; the full-completion e-mail and the admin alert were not seen after the unified layout; e-mail button destinations were not clicked.
- The welcome e-mail is sent by a database trigger and was not re-tested.
- The avatar object is not deleted when an account is deleted.
- Excel and screen company columns follow the screen; optional columns depend on the source.
- The generic executor for most catalog services is unproven.
- Large jobs need the page open (driver-mode tab).
- The refund sentence «لا يُعاد الرصيد عن سجل تم تسليمه» in `src/lib/legalText.ts` is an owner and legal decision.
- Older sections further down are history and may be stale: for example the `send-email` function is deployed now (version 4, see above), although an older section says it is not.
- Phase 4 below was written while its deployment was BUILDING; later merges were all followed by a READY production deployment (the latest is named above).

---

## 0000000000. UI/UX audit of diger.tech, phases 1 to 4 (2026-10-24 and 2026-10-25, main = `65c3c1d`)

One session, one branch and one draft PR per phase, each merged with a MERGE COMMIT after the owner's go. Written from git and the deployment API (read only). No SQL was written or run: nothing in this audit touched the database, and no price, cap or pricing-function value changed.

### The four phases (PR, head SHA, merge commit, production deployment)

| Phase | PR | Head SHA | Merge commit | Production deployment | What |
|---|---|---|---|---|---|
| 1 | #231 | `a5cbbb5979641834aa62b396ceee8a3123223e69` | `fcedf71d8be07a40886d9e471bd0bcd33f7904cd` | `dpl_CzcvaBcJt3FUamqYyyjeJfktoKMi` READY | Money and trust: plan edit and its saved summary, sector typos, skip handling, retry line, wallet, released-hold wording, requested/duplicate notes (audit points 2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 18, 28 and the edit-mode buttons) |
| 2 | #232 | `42fb0f96ec6319dce4f35896ef4f0df2a5649868` | `511d65cde256bc3bfe1a3b8047825c3fd2dea85f` | `dpl_6c8ApVfn6T94vqwY5bmdZss1SvJ3` READY | Flow clarity: points 1, 8, 9, 15, 16, 17, 19 to 27, 29, 30 (cost form, company columns and phone, status vocabulary, plan card money lines, question card, starters, titles, redirects, bell badge, top-up texts, one closing instruction) |
| 3 | #233 | `a415edf656956f889565014019f7d3fe67c45ede` | `90157dd743b2009bc1e4247fe37987c01ab7d13e` | `dpl_5M8j8Fc6KLwBoavzFLWXKnnhYbWu` READY | Landing page rebuilt (one sentence, one box, one action, computed price strip, two merged sections, labelled sample, 4-question FAQ, one closing action) plus every refund-style sentence replaced by «حجز مؤقت مُحرَّر» |
| 4 | #234 | `96dd305a23408fc3462b6c927903fa699dd23df3` | `65c3c1da64d9d01c0b0b3c74c0f5c76dd6985587` | `dpl_4eR1UWwWNDAnJqDdf4T4qEgpuny9`: **BUILDING** at the only check made; confirm READY in the Vercel dashboard | Mobile audit without a browser (390 x 844), «حجز مؤقت مُحرَّر» as the ONLY customer-facing form, one phone format in the decision-makers workbook |

Rollback of any phase: `git revert -m 1 <merge commit>` (newest first if more than one).

Suite on the merge parents (skipped is always 57): after phase 2 418 files / 4513 passed; after phase 3 420 / 4539; after phase 4 422 / 4564. `npx tsc --noEmit -p .`, `npm run build` and the client-bundle secret scan were clean on every phase head.

### Rules the audit worked under (keep them)

- Customer text: Arabic only, Arabic-Indic digits, no emoji, no markdown symbols, no provider or model names, no USD, no internal ids.
- A released hold is ONLY «حجز مؤقت مُحرَّر». Banned in customer text: the verb «حُرّر الحجز المؤقت», «تحرير الحجز المؤقت», «ويُحرَّر الباقي», «استرداد», «إرجاع», «أُعيدت», «أعدنا», «وعادت … إلى رصيدك», «يُرد». The list is `BANNED_RELEASE_FORMS_AR` in `src/lib/walletText.ts`; old stored rows are read through `normalizeReleaseWording` (`src/lib/releaseWording.ts`) and `walletDisplayText`; `tests/audit-phase4-release-form.test.ts` scans `src` and the e-mail function for the verb forms. Exceptions the owner kept: `src/lib/legalText.ts`, the admin pages, the top-up wording, the account-deletion line.
- Money: append-only ledger, release first, idempotent, nothing spent before approval, charge = ceil(delivered unique matching units x unit price) never above the reserve, one shared pricing function (`estimateMission`), the model never states money.
- The approval sentence «لا يبدأ أي جمع ولا يُخصم أي رصيد قبل موافقتك» appears ONCE on the landing page (the hero); a test counts it.
- Two copies of the e-mail templates exist (`src/functions/shared/emailTemplates.ts` and `supabase/functions/send-email/templates.ts`); change both.

### NOT PROVEN (nothing here was seen in a real browser or on real data)

Phase 1 (what the tests do and do not cover):
- Every flow was driven through `ChatHandler.handleUserMessage` and component renders with an in-memory database and `renderToStaticMarkup`. None of it was seen in a browser.
- The duplicate-request lookup and the plan-change note read earlier quotes and jobs; they ran only against the in-memory test database, not Supabase.
- The retry flow was checked server side (period kept, no repeated question) in four phrasings guarded by tests; the real customer wording of a retry on the live site was not tried.

Phase 2:
- Everything that needs a real browser: layout, scroll, focus, the canvas opening on reopen, the RTL table.
- The real shape of delivered company rows. The shared company column list was built from code, not from live rows; the workbook keeps its fixed 11 columns, and fields the screen can show (description, headcount, founding year, presence statuses) are not in the workbook.
- The conversation title update and the duplicate lookup against live Supabase.
- `/terms` and `/privacy` redirects were checked in `next.config.mjs` only, not served live.

Phase 3:
- How the landing page looks in a browser (hero, price strip, FAQ, contrast).
- How the stored-notice normalizer reads real old rows (tested on the sentence shapes known from the code only).
- Pages other than the landing page were not re-audited for wording beyond a grep.

Phase 4:
- Everything in the real-device checklist below.
- The landing header cutoff («خدماتنا» hidden below 480px) is a width ESTIMATE, not a measurement.

### Real-device checklist (390 x 844 or a real phone)

1. iPhone Safari: with the keyboard open in the chat, whether the composer stays visible (`visualViewport` offset), whether the page jumps on focus, and whether the shell height settles after the keyboard closes.
2. iPhone with a notch or home indicator: the composer, the results sheet buttons and the bottom of the settings, top-up and requests pages against the safe areas, in portrait and landscape.
3. Android Chrome: the same keyboard test (`resizes-content`), and whether Escape or the back gesture closes the drawer.
4. The landing header at 360, 390 and 430px: no overflow, and sign-up and login both reachable.
5. The landing price strip, the hero form (box above the button, then side by side from 560px) and the single-column FAQ.
6. RTL reading in the real chat: the user bubble with a pasted long link, the plan card (price block, count line, edit and approve rows) and the revision card.
7. The results table on a phone: horizontal swipe, the hint, long company names, the left-to-right phone cell, and the live-preview table scroll in the activity panel.
8. The pricing and calculator tables, and the sample table on the landing page, with horizontal swipe.
9. The sidebar drawer: opening from the right, overlay tap, the account menu at the bottom, the notification panel width, scroll lock behind the drawer.
10. Touch targets by thumb: the buttons raised to 44px, the attachment-remove button (hit area only) and the terminal close button.
11. The wallet capacity cards (stacked below 480px) and the three-column stat rows on the requests page.
12. The terminal's 10 to 11px text for legibility, and the contrast of muted text in light and dark modes.
13. Arabic text rendering: font loading, line breaks in long Arabic sentences, and mixed Arabic and Latin cells (phone, handle).
14. Any admin page on a phone (not audited).

### Open owner decisions

1. **Top-up review time.** `TOPUP_REVIEW_TIME_AR` in `src/lib/topupConfig.ts` is `null` on purpose, so the top-up screen promises no duration. Set it to a time you can keep («خلال ساعة في أيام العمل»), or set `reviewTimeAr` in the public settings row `pricing` (it wins over the constant).
2. **Payment label and address.** The label above the address is `TOPUP_PAYMENT_LABEL_AR` («عنوان الدفع اللحظي · منصة ديجر»; override with `paymentLabelAr` in the same settings row). The ADDRESS under it is the value saved in the admin settings (`ipa`); if it is a personal handle, replace it there. The code cannot know.
3. **The refund sentence in the terms.** `src/lib/legalText.ts` (section «٣. النقاط واحتساب التكلفة») still says «بعد التسليم لا يُعاد الرصيد عن سجل تم تسليمه». It was left unchanged on purpose: it is legal text, so wording and any refund policy are the owner's call.

Smaller choices left open:
- The landing sample files carry no link, e-mail or domain: the comments sample has no link column, and the website and e-mail cells of the companies and decision-makers samples say «غير متاح». The alternative is a visibly fake address; the decision-makers sample no longer shows an example e-mail.
- The sidebar drawer and the chat history panel have no focus trap or `aria-modal`.
- Admin pages still use the verb form («تحرير حجز» in `AdminShell`, the admin recover route) and were not audited on mobile.
- Landing components no longer on the page (`Statements`, `Sheets`, `ProductLines`, `DemoConversations`) stay in `src/components/landing/Sections.tsx` only because existing tests render them.
- The mission templates (bracketed) stay in the dashboard's empty chat; the landing hero offers none.

---

## 000000000. Live-check fixes, batch 2 (branch `claude/live-fixes-batch-2`, from main `f10aacd`)

- «المنشورات فقط» on a Facebook topic: no comments plan, no default of 500, one honest sentence, nothing quoted or held (`FACEBOOK_POSTS_ONLY_UNAVAILABLE_AR`, `commentsAnsweredNo` in `src/lib/socialTasks.ts` and `src/lib/socialDiscoveryCard.ts`). The cause was the label «التعليقات المطلوبة» carrying the comment word; the intent now reads the answer, not the label.
- A tatweel («بـ») is stripped before topic tokens are read (`topicTokens`, `src/lib/socialTasks.ts`); «فقط»، «بس»، «بدون» are answer words, never topic.
- «أخرى» then a typed name: a served name continues; an unserved one gets `UNSUPPORTED_PLATFORM_AR` naming تيك توك، فيسبوك، يوتيوب، ومنصة X. A bare «أخرى» is not a name (`unsupportedPlatformAnswerAr`, `src/lib/socialDiscoveryCard.ts`).
- A Facebook page plan shows «الصفحة:» with the handle only (`pageHandleOf`, `src/lib/planMethodSteps.ts`; `planScopeRows`, `src/lib/quoteScopeGaps.ts`). Numbers unchanged.
- `normalizePhone` in `src/lib/multiProvider/policy.ts` drops the bracketed trunk zero («+20 (0)22…» → `+20225087419`). The other eleven forms match origin/main output.
- Tests: `tests/posts-only-answer.test.ts`, `tests/platform-other-typed.test.ts`, `tests/facebook-page-chip.test.ts`, `tests/phone-trunk-zero.test.ts`; changed `tests/platform-follow-up.test.ts` and `tests/phone-digits-kept.test.ts`.

---

## 00000000. Live-check fixes, batch 1 (branch `claude/live-fixes-batch-1`, from main `c4b5088`)

- «أخرى» on the platform question asks ONE free-text follow-up (`social_platform_other_required`); a name this service does not read gets one honest sentence (`UNSUPPORTED_PLATFORM_AR`), no plan, no hold. Snapchat is named by the platform detector but no service reads it, so the check runs before the platform-missing branch (`src/functions/shared/chatHandler.ts`, `src/lib/socialDiscoveryCard.ts`, `src/lib/consultantCopy.ts`).
- The data word «داتا» and «بيانات» are request wording, dropped from the topic (`TOPIC_NOISE`, `src/lib/socialTasks.ts`).
- A page plan's methodology says the posts are read from the page (`src/lib/planMethodSteps.ts`, used by `PlanQuoteCard.tsx`).
- The review sheet column is «العنوان كما ورد» (it holds addresses).
- The Facebook keyword card carries one sample line (text only).
- The admin stats read «completed» and `deliveredUnits` (`src/lib/server/adminJobEvents.ts`).
- TikTok and X customer files drop the source id column (`sourceIdHiddenFor`, `src/lib/server/normalizationPipeline.ts`).
- The shortfall sentence states the posts requested and read (`src/lib/server/zeroDeliveryDiagnostic.ts`).
- The wallet's «this month» starts at Cairo midnight, not the server's (`cairoMonthStartMs`, `src/lib/walletView.ts`).
- Findings not changed: company review rubric (`src/lib/server/companyRelevanceReview.ts`) and phone normalisers (no digit dropped; `policy.ts` adds a zero to «+20 (0)22…»).

---

## 0000000. Facebook topic request: no Page question, keyword plan (branch `claude/fb-topic-keyword-routing`, from main `b252666`)

- Evidence: the owner's tester (production, 24 Oct 2026) answered platform, comments, posts and comments per post, then was asked «فيسبوك: ما اسم الصفحة العامة أو رابطها؟» with the sentence «فيسبوك لا يتيح البحث بالموضوع». The explicit sentence went straight to the keyword card.
- Cause: `socialDiscoveryTrigger` (`src/lib/socialDiscoveryCard.ts`) asked for a page when no other verified Facebook service was in the list it was given. The fast plan path (`buildDeterministicPlanFromIntent`, fed the full catalog, which holds the verified `facebook-post-search`) and the discovery path (fed the enabled list, which in production lacks it) disagreed, so one request got the page question and the other did not.
- Fix: a Facebook request WITH a topic never asks for a page (the keyword service searches the topic). Only a request with NO topic asks for «الموضوع أو اسم الصفحة أو رابطها». The platform options now include «فيسبوك» (`src/lib/clarification.ts`, `src/lib/consultantCopy.ts`, `src/functions/shared/chatHandler.ts`). The outdated sentence is removed.
- Tests: `tests/facebook-topic-keyword-route.test.ts` (production-like enabled list), and the two phase5 assertions that pinned the page question for a topic request.

## 000000. Facebook topic report (branch `claude/intelligent-volta-hgqmy5`, from main `6832fa9`)

- New capability `facebook-topic-report` (one item per quote, unit = delivered comment, 3.025 points proposed; the owner decides): vetted public Pages browsed round-robin with a 20% per-publisher cap and an exact date window, comments never judged, posts placed on health axes by rules plus one model call per 50 ambiguous posts, an Excel (data only) and a separate Arabic methodology PDF. Design, tests and NOT PROVEN list: `docs/FACEBOOK_REPORT.md`; Pages the owner must review: `docs/FACEBOOK_REPORT_PAGES.md`; price arithmetic: `docs/proposals/facebook-topic-report/PRICING.md`. No SQL, no price/cap/ceiling changed. **Gated off** until a registry Page has `ownerReviewed: true` (`FACEBOOK_REPORT_ENABLED`).
- Period fix: «آخر ٣ شهور» was replaced by «آخر شهر» (shared per-item-phrase reader, number words) and a period's number could become the record count (`understandMission`); both fixed, with tests.

---

## 00000. Facebook keyword comment quality (branch `claude/fb-comment-quality`, from main `7d0e54b`)

- The pleasantry rule of the Facebook keyword service (`isPureWellWish(text, { topic })` in `src/lib/server/commentQuality.ts`) is now a RATIO rule: normalised text (emoji, tatweel, spellings, stretched letters, glued formulas, repeated phrases), connecting words neutral, at least one strong marker, at least 75% of the other words pleasantry words and at most three others; any number, question, request, complaint/duty/opinion word or word of the topic keeps the comment. It replaced «every word on a list», which missed one extra word, a typo («دكتر»), «شاءالله» and a repeated phrase. Other services are untouched.
- The «why fewer rows» sentence now also says how many posts were approved, that a job reads only the posts the customer asked for, how many posts gave no delivered comment, and how many comments the source did not return (`keywordShortfallReasonAr`).
- No price, cap or money rule changed; fewer delivered rows means a smaller charge (`ceil(delivered x 12.925)`).

---

## 0000. Facebook keyword polish and visitor analytics (branch `claude/fb-polish-and-visitors`, from main `3a20c2f`)

- **Facebook keyword service** (`social-facebook-keyword-comments`, identity and wording in `src/lib/facebookKeywordService.ts`): customer files say «المنشور» (not «الفيديو»), carry a post number instead of the post's text and link in every comment row, a second sheet «المنشورات», and never the platform's own comment id. Other services keep their headers.
- **Live preview** had no moment with accepted rows on a small job (a chunk carries up to 50 rows and the step file is written at its end): the first chunk of a paged job now reads one post's share (`PAGED_FIRST_CHUNK_ROWS`). A chunk that ends inside a post no longer reads that post again (`pu` in the adapter state).
- **Comment quality**: pure well-wishes («بالتوفيق والنجاح الدائم») are left out before the charge for this service only (`isPureWellWish`); a job that delivers fewer comments says why from counted numbers (`keywordShortfallReasonAr`).
- **Visitor analytics**: beacon `src/lib/analytics` + `/api/analytics/collect`, admin tab `/admin/visitors`, overview card. SQL is a PROPOSAL (`docs/proposals/visitor-analytics/`, NOT APPLIED); until it is applied nothing is stored and the tab says so.

---

## 000. Status after PR #211 (2026-10-23, main = `d12b831`)

Written from git, the deployment API and the project's schema (read only). No secret appears here; where a setting matters only its NAME and where it lives are given.

### Merged PRs #200 to #211 (merge commit, first parent, second parent)

| PR | Merge SHA | Parents (main before, branch head) | What |
|---|---|---|---|
| #200 | `0b3922c` | `e4d8f4b`, `b18e6a8` | multi-provider contact chain |
| #201 | `ecb5636` | `a2c2367`, `c8e04ae` | company review batch |
| #202 | `e4d8f4b` | `ecb5636`, `c81acbd` | conference readiness |
| #203 | `ad87357` | `0b3922c`, `c33260f` | admin calls log |
| #204 | `b9d1215` | `ad87357`, `ada87ef` | wallet display fixes |
| #205 | `4a7493b` | `b9d1215`, `1ab6dfd` | social root-cause fixes |
| #206 | `cb766fe` | `4a7493b`, `b7accfd` | mega-fixes phase 1 |
| #207 | `38541d3` | `cb766fe`, `d44684e` | mega-fixes phase 2 (request understanding) |
| #208 | `a9da0d6` | `38541d3`, `5187905` | mega-fixes phase 3 (quality and text) |
| #209 | `5ed38ce3503a6573be1cfe62ccd6a3391f711cdf` | `a9da0d6`, `6674f6c` | phase 4: one ETA, live preview, e-mail wiring and admin e-mail check |
| #210 | `b0559ace66dca30812cd0f5e27238816cc1a3c33` | `5ed38ce`, `e3726ec` | phase 5: smart discovery, honest limits, balance verdict; job-cap-from-balance SQL proposal (NOT applied) |
| #211 | `d12b831aad19aebc34f4ad480854d783c56318f2` | `b0559ac`, `b5789ae` | the remaining failures of the customer browser test: TikTok basketball relevance, Facebook page link question, follow-up numbers and topic, price per record on every plan, hold wording, live preview column bug |

Short SHAs are the first seven characters of the merge commit in `git log --merges origin/main`. Rollback of any one merge: new branch from main, `git revert -m 1 <merge sha>`, open a PR; never push to main.

### Proven live (read from the deployment API or the live site)

- Production `diger.tech` runs the merge of #211: deployment `dpl_3QH9XRcpiqi334rDL4F22M8wsiq9`, READY, built SHA `d12b831aad19aebc34f4ad480854d783c56318f2`.
- Without login: `/` 200 and `/login` 200 with no provider name in the HTML, `/api/jobs/x/preview` 401.
- The production `jobs` table has NO `template_slug`, `platform` or `capability_slug` column (project schema, read only). The live preview route selected them, so it never returned a row; fixed in #211.
- The ledger kinds are reserve, release, charge, topup, grant and goodwill; the wallet shows a release as «تحرير حجز مؤقت». Worker failure texts now say the same («حُرّر الحجز المؤقت كاملًا ولم يُخصم أي رصيد»), never a refund.

### NOT PROVEN (nothing below has been seen on real data or in the real browser)

- TikTok and Facebook results on live data. The basketball relevance fix (comments judged by their video), the video-level review and the Facebook link question are shown only by fixtures with a FAKE reviewer; no live paid call was made. The owner's 113-comments-0-delivered request has not been re-run.
- That a Facebook page named only by its display name never works at the source. The code now asks for the link or username first; it was not shown that the name path always returns nothing.
- A row appearing in the production live-preview panel after #211 (the column bug is proven and the new test fails before the fix; the panel itself was not watched).
- The «٢٩ دقيقة» countdown being constant: not reproduced. It is read from the quote's own expiry and the clock; a freshly written quote reads ٢٩ and each follow-up writes a new quote.
- The exact plan numbers of the live-model Facebook topic plan (513 points, 800 cut to 54): fake-model tests cannot build that plan. Only the deterministic parts were fixed (the topic no longer takes «بالتعليقات», the newest count wins, the price per record is on the plan).
- Firecrawl and Context.dev chain yield and price per contact: unmeasured.
- Authenticated production paths of #211 (plan card, the page-link card, worker messages): not exercised.

### Open problems

1. **TikTok and Facebook live results unproven** (see above).
2. **E-mail:** the `send-email` Edge Function is NOT deployed in production, and `RESEND_API_KEY` exists only in Vercel (the function reads its own Supabase secrets). Until both are done no e-mail goes out; the in-app notices work. Setup and the admin check: `docs/proposals/10_email_delivery_setup.md`.
3. **Driver mode is `tab`** (`LONG_JOB_DRIVER` unset): the chunks chain themselves and an open page resumes a broken chain; the customer is told «أبقِ الصفحة مفتوحة حتى تكتمل المهمة». The always-on driver is documented, not installed: `docs/proposals/08_long_job_driver_setup.md` and `08_pg_cron_driver.sql`.
4. **Per-job cap is 600 points** (`JOB_MAX_POINTS_CAP`, and a hard 600 inside `create_quote_atomic` and the two settle functions). The proposal to make it depend on the customer's balance is `docs/proposals/job-cap-balance/` (steps 01 to 05 with rollbacks) and is NOT APPLIED; applying it also needs a companion code change (see its README). The Facebook ceilings (60 page posts, 500 comments per job, 20 posts per page) are the service's own and are not changed by it.
5. **Firecrawl / Context.dev chain:** yield and price per contact are unproven.
6. **`MULTI_PROVIDER_ENABLED` is true on Production.** The chain can therefore take company-contact jobs today with unmeasured yield and price. Keep that in mind before any spend decision (switch is `src/lib/multiProvider/flag.ts`).
7. **Model-planned Facebook topic requests** still go through the live model; their numbers are not covered by fixtures (see NOT PROVEN).

### Exact next steps

1. Owner: re-run the TikTok request «٥٠ تعليق من فيديوهات تيك توك الأكثر انتشارًا عن كرة السلة في مصر» on the test account; read the activity lines (videos adopted, comments delivered) and the delivered count. If it is still 0, read the per-video decisions in the job events before changing the gate.
2. Owner: re-run «١٠ بوست من صفحة اليوم السابع» and answer the link question with the page's real link; check rows arrive and the live preview shows them while the job runs.
3. Owner (Supabase and Vercel settings, not code): deploy the `send-email` Edge Function, put the Resend key in Supabase secrets, then use the admin e-mail check. Keep the key out of the repository and of any message.
4. Decide the driver: either install the scheduler and set `LONG_JOB_DRIVER=cron`, or keep `tab` and keep the page guidance as is.
5. Decide the cap: choose `fixed` or `balance` and the ceiling, apply `job-cap-balance` steps 3 and 4 BEFORE the policy goes above 600, then 1, 2, 5 as its README orders them, then the companion code change. Not before the provider daily limit and the driver are decided.
6. Measure the Firecrawl / Context.dev chain with one small owner-approved paid test (fake provider in all automated tests) and decide `MULTI_PROVIDER_ENABLED` from the measured yield and price.
7. Process rules that cost time here: after every merge read the production deployment and compare its built SHA with the merge SHA; a removed-test-lines gate is a COUNT taken from `git diff -U0 origin/main -- tests | grep '^-' | grep -v '^---' | wc -l` on the head under review (a count stated from memory was wrong once: 29 said, 27 real); the Hobby plan allows 100 deployments per 24 hours, so push each branch as few times as possible.

---

## 00. Second session (new account, 2026-10-21 Wednesday): verification of #175 to #182 and the failed harness build

### Failed preview build of `claude/wip-e1-harness` (read from the deployment API, now fixed)

Deployment `dpl_7hzrxw7xEwrQq5Lz48J7Z6zj2hcg` (head `c50e2fd`) ended in ERROR at the type-check step of `next build`: `tests/helpers/loadHarness.ts:48:101 Type error: Expected 1 arguments, but got 2.` The wrapper `rpc: async (name, args) => base.client.rpc(name, args)` passed two arguments to the fake client's one-argument `rpc`. Fixed in PR `claude/e1-harness` (`rpc(name, ..._args)`). Next compiled successfully; only the test helper failed the type check, so production was never affected.

### Evidence for PRs #175 to #182 (git and the deployment API; suite = `npx vitest run` on the merge commit, skipped counts are always 27 tests / 3 files)

| PR | Merge SHA | Diff vs first parent | Suite after (files / tests) | Removed test lines | Production deployment (state, built SHA) |
|---|---|---|---|---|---|
| #175 | 8e5fb4d | 17 files, +664 -42 | 285 / 2839 passed (before, at 49ee886: 283 + 1 flaky file / 2816 passed, 1 failed) | 5, all pin replaced STEP 0 behavior with stricter assertions (link columns 120 to 60, comment columns, comments under 3 letters rejected) | `dpl_2BTsn8p34vL3JFzbt1PBGfBUJAkk` READY, 8e5fb4d |
| #176 | a301d7b | 21 files, +1650 -3 | 292 / 2964 passed (an earlier run showed 1 failure: the memory-timing test `result-assembly-scale`, which also failed once at 49ee886 under CPU load and passes alone) | 0 | `dpl_6wBZx8hjgcPXuoGmtAybxD3FPQ88` READY, a301d7b |
| #177 | c12de75 | 4 files, +164 -4 | 293 / 2973 | 2 (template list 4 to 7, stricter list) | `dpl_B9eDj4pee4pLsAawBUMfjuUkEvWa` READY, c12de75 |
| #178 | 18f8c23 | 19 files, +740 -37 | 295 / 3002 | 0 | `dpl_2snYqmDgbmsvfQA49YzvB3YsQwLh` READY, 18f8c23 |
| #180 | ae80409 | 7 files, +944 -3 | 296 / 3037 | 0 | `dpl_D11oukHn59KZRB9L2NUErnpYoTru` CANCELED (superseded by the next merge 3 seconds later) |
| #179 | f0724f0 | 1 file, +31 | 296 / 3037 | 0 | `dpl_ngkEDTNm3XYn5BqmfUsg6nVwXNXS` READY, f0724f0 (contains #173 to #180) |
| #181 | 9c49459 | 21 files, +356 -46 | 297 / 3048 | 14 (see flag) | `dpl_AdfR6ZJtxzK4WAXWb3WsvCwCMjhp` READY, 9c49459 |
| #182 | eadea2d | 1 file, +76 -24 | 297 / 3048 | 0 | `dpl_58Vyaig41FHTmHJfEoV5sH5sroZQ` READY, eadea2d (production at the start of this session) |

**FLAG for the owner (rule 3):** #181 edited `tests/usage-reads-beyond-1000.test.ts` (11 removed lines): the provider-spend sum test «the provider spend sums count every row», rewritten so the per-user daily cap reads only the user's own jobs and then only their cost rows (assertion: groups of 100 and 1 instead of 4 groups). It is a provider-spend read test, close to the «caps» money family. The new assertion is not weaker (it asserts the exact group sizes `[1, 100]`), but the owner should look at that one diff. The other removed lines: limiter sizes replaced by the named constant (`busy-mode`, `mission-estimate`), one mock extended (`wallet-arabic-and-demo-cta`).

### Production deployments per PR (Hobby: 100 per day)

Every push to a PR branch creates a preview deployment and every merge creates a production one. The API list shows 37 deployments created on 2026-10-21 (UTC) before this session started; push each branch as few times as possible.

### Merged by this session

| PR | Merge SHA | What | Production deployment |
|---|---|---|---|
| #183 | ce03b7e | harness (type error fixed), concurrent-approval tests, this evidence | `dpl_FwLsqE9GVtRkVu8BvAdxRz1tKm5B` READY, built ce03b7e |
| #184 | 7cdd847 | Supabase free plan: no Realtime, fewer sign-in calls, static landing page, admin backup export, `docs/SUPABASE_FREE_PLAN.md` | none appeared by itself; created by hand: `dpl_GjHSHmJrbARfEk44RAPzrA77AfVp` READY, built 7cdd847, aliased to diger.tech (this is what is LIVE) |
| #185 | 615b002 | CPU model (`docs/CPU_MODEL.md`), degraded mode (`DEGRADED_MODE`), edge-cached status routes, balance focus throttle | **none**: the hosting plan's 100 deployments per day ran out (see below) |
| #186 | 3c36c84 | measured database/storage/CPU per action; counts written in words or with a magnitude word; quantity words out of the topic | **none** (same) |
| #187 | (this PR) | fake provider for a preview, staged pressure scripts and runbook, `docs/CONFERENCE_READINESS.md` | **none** (same) |

**The hosting plan stopped all deployments on 2026-10-21 at about 09:03 UTC:** `api-deployments-free-per-day` (Hobby: 100 per rolling 24 hours). Previews of #185 (once, by hand, before the limit), #186 and #187 were not built, and no production deployment exists for 615b002, 3c36c84 or the merge of #187. **Production (diger.tech) runs `7cdd847`** (it has #184 but not the edge cache, the degraded switch, the count fixes or the CPU model). The first slots return from about 11:44 UTC on 2026-10-21 and then about one every few minutes. Next step for the next account: when `create_deployment` succeeds, create ONE production deployment from `main` and read it to READY with the built SHA; do not push anything else before that.

**Process note:** a merge whose tree is identical to a branch head Vercel already built (the branch had merged `main` and `main` had not moved) got NO production deployment. After every merge read `list_deployments` (target production) and compare the built SHA with the merge SHA; if it is missing, create the deployment from `main` at that SHA.

### Status of every item (checked by reading the code and running the tests; nothing here is verified on the live site)

| Item | Status |
|---|---|
| P1 conference survival (sign-up path, rate-limit and late-e-mail screens, busy mode, per-user chat and job limits, conference dashboard) | DONE-MERGED (#178, #180, #181) |
| P2 CPU and invocation reduction | DONE-MERGED (#181, #184, #185, #186); the three status routes and the deployed code of #185 and later are NOT yet live (deployment quota) |
| P3 honest understanding for any request | DONE-MERGED (#176); fixed and tested further in #186 (counts in words, topic words). The capped discovery search for unnamed source sets is not built: no service in the live catalog can read news pages, so the pick question uses the curated list only |
| P4 showcase missions | DONE-MERGED (#177): four templates plus three more, each with fake-provider worker tests |
| P5 news and price sources | audited: the live catalog has no news, price or web-reading service, so the answer stays an honest «غير متاح» (in code and tested); nothing sold |
| P6 STEP 0 YouTube topic comments | DONE-MERGED (#175), unverified on live data |
| P7 offline 500-visitor harness | DONE-MERGED (#183, #186) |
| Part E2 pressure scripts and runbook | this PR (#187): `scripts/pressure/`, `docs/PRESSURE_TEST_RUNBOOK.md`, a guarded fake provider for a preview; never run |
| Part C long-job audit | DONE, in `docs/CONFERENCE_READINESS.md` section 5 (no money defect found) |
| Part D dashboard, busy mode, sign-up path | DONE-MERGED (#178, #180) |
| Part F `docs/CONFERENCE_READINESS.md` | this PR (#187) |
| Free-plan work (Realtime, auth calls, egress, backups, limits) | DONE-MERGED (#184), measured per action in #186 |

### Findings of this session

1. **The model-spend guard reads the whole day on every chat turn** (`checkGlobalDailySpendCap`, 1 request up to 900 rows, 5 at 2500, 12 at 10 000 and a fail-closed 503 at 50 000). Measured in `tests/conference-load-harness.test.ts`. Fixed with the owner's explicit authorization: the READ of the day's sum is cached 45 s per instance plus the instance's own spend since the read; cap, limits, prices and the enforcement rule are unchanged (`src/functions/shared/rateLimits.ts`, `tests/daily-spend-read-cache.test.ts`; `docs/proposals/spend-cap-read-cache.md`).
2. **Corrected 2026-10-21:** the plain `getUser` check (`/auth/v1/user`) is NOT in the sign-up/sign-in bucket (the official page ties that limit to e-mail-change calls; an earlier version of these docs said otherwise and was wrong). The real walls for a shared venue IP are the sign-up and sign-in bucket (30, refill 6 a minute: 500 sign-ups = about 78 minutes), the confirmation e-mails (stated default 30 an hour: about 16.7 hours for 500), the `/verify` clicks and the token refresh. Values, steps and the confirmation-off fallback with abuse controls: `docs/SUPABASE_FREE_PLAN.md` section 4b. `AUTH_LOCAL_CLAIMS` stays OFF.
3. **A count written in words or with a magnitude word was ignored or misread** (fixed in the PR after #185): «٥ آلاف» read as 5, «٢ مليون» as 2, «خمسين ألف» as 1050, and the plan's own reader accepted digits only, so «ثلاثين تعليق» fell to the default of 500 (a 594-point hold the customer never asked for) with the sentence «لأنك لم تحدد عددًا». The words also leaked into the search topic («آلاف كرة القدم», «خمسين كرة القدم»), so the provider was asked a wrong query. Now: counts read as asked up to 100 000, the plan says how much of a very large request fits, and quantity words stay out of the topic. `tests/large-counts.test.ts`.
4. **Every download rebuilds the file from the saved data** (Excel and PDF are CPU work on each click; by design, so a stored file is never stale). Measured in `docs/CPU_MODEL.md`; the model now charges it.
5. Concurrency: 20 simultaneous approvals of one quote reserve once (`tests/accept-quote-concurrency.test.ts`; the database function itself is a stand-in, real locks are SQL and unverified).

---

## 0. Conference-readiness session (2026-10-21, Wednesday): FINAL HANDOFF to the next account

Conference: Saturday 2026-10-24, 500+ attendees on one venue network. Code freeze Friday evening. The owner is on a phone: no stop-and-ask loops, small PRs, merge commits only.

### (a) Merged to main in this session (merge commits)

| PR | Merge SHA | What |
|---|---|---|
| #173 | d35a3ad | capacity gate uses the provider's real balance (fresh reading, fallback to the estimate) |
| #174 | 49ee886 | admin provider tab shows the connected account e-mail (admin-only) |
| #175 | 8e5fb4d | STEP 0: YouTube/TikTok topic comments: 20-video discovery, videos judged before comments are read, deep resumable reads, Arabic first, date/video/language columns |
| #176 | a301d7b | Part A: coverage matrix (15 families), structured understanding, newspapers pick question, news/price output standards, unserved-requests log + `/admin/requests`, `docs/CAPABILITY_COVERAGE.md` |
| #177 | c12de75 | Part B: three new showcase templates + fake-provider worker tests |
| #178 | 18f8c23 | Part D: busy mode, sign-up path (`/join`, invitation code, welcome balance, rate-limit and late-e-mail screens, resend limits) |
| #180 | ae80409 | Part D: read-only conference dashboard `/admin/conference` |
| #179 | f0724f0 | earlier handoff text |
| #181 | 9c49459 | P1/P2: adaptive jittered polling, public paths skip the sign-in call, wallet history newest-500 in one query, per-user spend read, per-user daily cap shapes the plan, public limiters sized for one venue IP, per-account concurrent-job limit (3) before the reserve; suite 297 files, 3048 passed / 27 skipped, tsc clean, build OK, preview READY |

**Production (last one read from the API):** `dpl_ngkEDTNm3XYn5BqmfUsg6nVwXNXS`, state READY (2026-10-21 about 07:28 UTC), built SHA `f0724f0a41e25835620cc612470da62a9b79473d` (contains #173 to #180). The production builds of #181 (`9c49459`) and of this handoff PR were started after that reading: READ THEM FIRST (`list_deployments`, target production, then `get_deployment` for state and built SHA) and confirm READY.

### (b) Branches not on main

| Branch | Head | Contains | Missing |
|---|---|---|---|
| `claude/wip-e1-harness` (SUPERSEDED by PR `claude/e1-harness`, type error fixed) | c50e2fd | `tests/helpers/loadHarness.ts` (latency-counting fake DB) and `tests/conference-load-harness.test.ts` (500 visitors through the real `/api/chat` route, 3 messages each, no model) | first run printed per-turn stage timings (about 12 awaits per turn, auth 11 ms, rate limit 15 ms, writes about 140 ms with 4 ms fake round trips); the results were not read to the end, assertions not tuned, numbers not recorded; silence console JSON from `chat_stage_timings`; no concurrency/idempotency section yet; not on main |
| `claude/wip-load-and-limits` | 72dd425 | superseded by merged #181 | delete or ignore |
| `claude/money-bundles-and-pricing` | 3ed699d | parked by the owner | NEVER touch |

### (c) Status of every item

| Item | Status |
|---|---|
| STEP 0 (YouTube deep reads, quality filter, columns, honest plan) | DONE-MERGED (#175) |
| Part A (A1 to A6) | DONE-MERGED (#176) |
| Part B (showcase missions) | DONE-MERGED (#177) |
| Part C (long-mission audit) | NOT STARTED as a written audit (the long-job machinery was built and tested in earlier missions; no new defect found or fixed in this session) |
| Part D (dashboard, busy mode, sign-up path, rate-limit screens) | DONE-MERGED (#178, #180) |
| P1 sign-up path, rate-limit/slow-e-mail screens, busy mode | DONE-MERGED (#178) |
| P1 per-user chat limit | already existed (20 per minute, database counted); unchanged |
| P1 per-user concurrent-job limit | DONE-MERGED (#181) |
| P1 conference dashboard | DONE-MERGED (#180) |
| P2 CPU/invocation reduction (polling, middleware, history, spend reads) | DONE-MERGED (#181) |
| Part E1 offline harness | WRITTEN-NOT-MERGED (WIP branch, unfinished) |
| Part E2 pressure-test scripts + runbook | NOT STARTED |
| Part F `docs/CONFERENCE_READINESS.md` + report | NOT STARTED |
| Final "READY FOR LIVE VERIFICATION" post + ONE batch test | NOT STARTED |

### (d) Exact next step, in priority order

1. Read the production deployments of `9c49459` (#181) and of the handoff merge: state READY and built SHA from the API.
2. Finish E1 on `claude/wip-e1-harness`: mock or silence the `chat_stage_timings` console output (it floods), read the results (`HARNESS_OUT=<file> npx vitest run tests/conference-load-harness.test.ts`), tune bounds, add a concurrency section: the same quote approved 20 times at once through `accept-quote` must reserve once (use the stand-in functions in `tests/helpers/scaleHarness.ts`), and document per-instance state (`publicRateLimit.ts`, `busyState.ts` 15 s cache, `conferenceCache.ts`). Open a PR, merge.
3. E2: `scripts/pressure/` (50/100/250/500 virtual visitors against a PREVIEW URL with a fake-provider flag and a separate test database; never production, never run by the agent) and `docs/PRESSURE_TEST_RUNBOOK.md` with exactly what the owner must create (a second Supabase project, preview env values by name, a test provider flag). SQL index ideas only as files under `docs/proposals/`, never applied.
4. `docs/CONFERENCE_READINESS.md` (Part F): coverage results (`docs/CAPABILITY_COVERAGE.md`), working showcase list (Part B), harness numbers and the first bottleneck, the owner's manual list (g), the fallback plan for the day, the Friday checklist. Include the Part C audit (chunks, resume, notifications, duration range, partial settlement): read `src/app/api/worker/chunk/route.ts` and `src/lib/server/longJob*.ts`.
5. Final post: "READY FOR LIVE VERIFICATION" with SHA, deployment id, READY time, evidence of every PR, NOT VERIFIED, and ONE batch test (each showcase mission once within a small budget; YouTube 30 comments football last month quote at most 300; TikTok 30 comments football in Egypt last month at most 220; X 30 posts about Egypt vs Morocco window 2026-06-11 to 2026-07-19 at most 200; the dollar-news request; six other scenario-matrix requests asked and not approved; the sign-up path from a clean browser).

### Standing rules (do not break)

Feature branches from clean `origin/main`; merge commits only (no squash, no `--admin`, no rebase, no force-push); evidence block after each PR (PR number, merge SHA, `git diff --stat`, suite before/after with skipped counts, `git diff origin/main -- tests | grep '^-' | grep -v '^---'`, tsc, build, Vercel deployment READY with the built SHA from the API). SELECT-only database access; no migrations; no live provider or model calls by the agent; Customer text in Arabic only, Arabic-Indic digits, no emoji, no provider names or USD. `rm -rf .next/types` before `tsc` after switching branches.

### (e) Risks and NOT VERIFIED

- Public limiters and the busy-state cache are per server instance (memory), per IP; the venue shares one IP (limits raised in #181, documented in code).
- The sign-in service's own limits (confirmation e-mails per hour, sign-ups per IP) are outside the code: owner list (g).
- A job is capped at 600 points: about 57 YouTube comments, 86 TikTok comments, 104 X posts per request; templates promising more are cut by the plan with a plain sentence.
- News, prices, ads, maps, search, jobs and forums are answered as «not available» and logged (no approved service).
- NOT VERIFIED live: the real balance read on the deployed plan path; the YouTube recency parameters and video-level review on real data; the deep read on a live source; TikTok video-level relevance; the X completion notification; the busy banner and invitation-code redeem with a real account and real e-mail; the conference dashboard on production data; the adaptive polling in a real browser; the concurrent-job 429 in production; all of Part E's pressure test.

### (f) Decisions already taken by the owner

Keep the current Vercel and Supabase plans; Resend already upgraded; NO changes to money, price, cap or provider-limit code (prices, unit costs, `JOB_MAX_POINTS_CAP`, `settle_job_atomic`, `release_job_atomic`, `approve_topup_atomic`, reserve/ledger code, bonuses, referrals, any SQL, the model string); the parked branch `claude/money-bundles-and-pricing` stays untouched; old PRs #3 to #11, #40, #41, #44, #69, #83, #85 stay untouched. If a test is about money: stop and report, never edit it.

### (g) What the owner must do manually before Saturday

1. Supabase Auth: raise the per-hour e-mail and sign-up rate limits for the venue (all attendees share one IP); confirm the e-mail sender is the upgraded Resend one.
2. Provider account: top up the balance and set the daily cap (admin tab) for the day; the busy mode closes the door by itself when the real balance or the daily allowance runs out.
3. Free points per new user: decide the welcome amount (admin setting) and the invitation code to print on the QR (`/join/<code>`).
4. Anthropic: set a monthly spend alert/limit.
5. Optional env: `MAX_CONCURRENT_JOBS_PER_USER` (default 3), `CHAT_MESSAGES_PER_MINUTE` (default 20).
6. For the pressure test (run by the owner, on a PREVIEW only): create a separate Supabase test project and give its values to Vercel preview env (names in the runbook when written); never use production.
7. Friday evening: freeze code; read `/admin/conference` once; run the sign-up path once from a clean phone browser.

---

## 1. System Architecture & Core Stack

- **Framework**: Next.js 15.5 (App Router, React 19, Tailwind CSS v4) hosted on Vercel.
- **Database & Auth**: Supabase PostgreSQL (Project `pfinlfaqwnytesedchik`), using Row-Level Security (RLS) and atomic RPC functions for all balance/financial operations.
- **AI & Planning**: Anthropic Claude Haiku 3.5 (`claude-3-5-haiku-20241022`) via `@anthropic-ai/sdk`, with structured fallback plans.
- **Data Catalog & Ingestion**: TREG catalog integration for B2B company discovery, social data, and profile endpoints.
- **Deliverables**: Excel (.xlsx) generated via `exceljs`, CSV (UTF-8 BOM), and PDF methodology reports via `pdfkit`.

---

## 2. What Works (Verified Subsystems)

1. **Authentication & Session Security**:
   - Supabase Auth integration via `@supabase/ssr` cookies and JWT bearer headers.
   - Non-admin test account login and role separation verified.
   - Zero client bundle secrets validated via `scripts/check-client-bundle-secrets.ts`.
2. **Financial Guardrails & Append-Only Ledger**:
   - `credit_ledger` alterations strictly mediated by deterministic IDs (`res_<jobId>`, `rel_<jobId>`, `chg_<jobId>`, `top_<topupId>`).
   - Reserve-first hold and release-first completion order (`rel_` +reserve, followed by `chg_` -actual).
   - Zero charge for missing records or non-matching results.
3. **Arabic-First Interface & UX Invariants**:
   - Native RTL layout with Arabic typography and formatting.
   - Activity panel appears only when an active or completed job exists and remains absent on fresh chats.
   - Sidebar collapse and responsive navigation work across desktop and mobile (tested at 390x844).
   - Session reset via "+ سؤال بحثي جديد" clears active job state and session storage without reopening stale jobs.
4. **Artifact Downloads**:
   - PDF, Excel, and CSV download routes verify user authorization and generate time-limited signed URLs (`/api/jobs/[id]/download`).
   - Direct download links link reliably to stored deliverables in the Supabase `results` bucket.

---

## 3. Known Open Issues & UNVERIFIED Items (For Codex / QA)

The following items are explicitly marked as **OPEN** or **UNVERIFIED** and require further testing, owner decision, or remediation:

1. **[OPEN - UNVERIFIED] 50-Company Autonomous Worker Progression**:
   - A 50-company job finishing entirely on its own through the worker/cron path with zero client-side pushing or manual intervention remains unproven under full production isolation.
2. **[OPEN] Plan Proposal Latency (12–16 Seconds)**:
   - Initial plan card generation in chat takes between 12 and 16 seconds (target is under 10 seconds). Root cause includes sequential upstream capability lookup, schema reflection, and multi-turn Claude prompt reasoning.
3. **[OPEN] Excel Executive Summary Sheet vs Data-Only Requirement**:
   - The generated Excel workbook currently includes an executive summary sheet (`الملخص التنفيذي ومؤشرات السوق`) in addition to the data sheets (`دليل الشركات المعتمد` and `بيانات الشركات للتصفية`). The owner has stated a preference for data-only workbooks; this sheet must either be removed or formally approved.
4. **[OPEN - UNVERIFIED] Plan Edit Industry Filter Persistence in Database**:
   - While client-side form state and quote recalculation show the edited industry, end-to-end database proof that subsequent worker execution applies the modified industry filter in SQL/TREG params remains unverified.
5. **[OPEN] Decision-Makers Work Email Unavailability**:
   - B2B decision-maker queries deliver names, titles, and LinkedIn URLs, but work emails are consistently unavailable from the current upstream provider endpoint. The plan card now includes an explicit disclaimer before approval, but upstream email enrichment remains unavailable.
6. **[OPEN] Database Cleanup Plan Correction**:
   - Helper SQL cleanup scripts generated during chat sessions were flawed and must **NOT** be used. The only authoritative, transaction-safe reset script is documented in [`docs/OWNER_SQL.md`](file:///d:/Digr/docs/OWNER_SQL.md) and must be executed exclusively by the owner.
7. **[OPEN] Unexplained `settings_private` Write for 0.80 USD Provider Cap**:
   - The origin and historical write of the `0.80 USD` provider daily cap in `settings_private` requires owner verification against real budget constraints.
8. **[OPEN] LLM Daily Spend Cap (50 USD) Policy Decision**:
   - The LLM daily spend cap is currently configured at 50 USD in `settings_private` and enforced at runtime. This limit requires an explicit business policy decision by the owner prior to public scaling.

---

## 4. How the Worker & Cron Execution Path Runs

1. **Job Initialization**:
   - Customer approves a quote via `POST /api/chat/accept-quote`.
   - `accept_quote_atomic` holds reserved credits in `credit_ledger` and inserts a `queued` job into `jobs`.
   - `accept-quote` triggers the first chunk via `dispatchWorkerChunk` calling `POST /api/worker/chunk`.
2. **Chunk Execution & Self-Chaining**:
   - `/api/worker/chunk` claims an execution lease on the job, queries the data provider, filters/deduplicates records, and saves partials to Supabase Storage.
   - If more records are required, the chunk self-chains by firing an asynchronous `POST` to `/api/worker/chunk` for `step + 1`.
3. **Client Polling & Nudge Route**:
   - While the user has the chat or requests page open, `/dashboard/chat` and `/dashboard/requests` periodically check active job status.
   - If a lease has stalled or expired without completion, the client triggers `POST /api/jobs/[id]/nudge` to safely re-dispatch the next worker chunk.
4. **Watchdog Cron**:
   - Vercel daily cron triggers `GET /api/cron/watchdog`.
   - Stale running jobs past timeout are identified, compensating releases (`rel_<jobId>`) are checked, and stuck holds are released safely.

---

## 5. How to Run Tests & Verification

All automated tests and validation scripts run locally with:

```bash
# 1. Run all unit and integration test suites (Vitest)
npm run test

# 2. Verify TypeScript types across the entire project
npx tsc --noEmit

# 3. Build Next.js production bundles and check for client secret leaks
npm run build

# 4. Standalone client bundle secret scan
npm run check:secrets
```

---

## 6. Recorded Test Top-Ups Note for Owner

All balance top-ups performed on the test account (`iam.magdy@outlook.com`, UID `47693c59-89f1-405d-bec1-e72271517870`) are recorded below for pre-launch ledger cleanup per [`docs/OWNER_SQL.md`](file:///d:/Digr/docs/OWNER_SQL.md):

| Topup ID | Amount (EGP) | Points (Delta) | Reference | Ledger ID |
| :--- | :---: | :---: | :--- | :--- |
| `top_req_1792156256768` | 25 | +250 | `REF_1792156256769` | `top_top_req_1792156256768` |
| `topup_6ac474bae339871ce7473c18` | 20 | +200 | `TEST_REF_1792164072210` | `top_topup_6ac474bae339871ce7473c18` |

---

## 7. Operational Rules & Security Invariants

- **Zero Direct Writes to Money Tables**: Never run ad-hoc SQL `INSERT`/`UPDATE` statements against `credit_ledger`, `jobs`, `topups`, or `profiles`. All balance mutations must use approved database functions.
- **Never Print Secrets**: Passwords, API keys, tokens, and database credentials must remain in environment variables and never be logged, committed, or typed into reports.
- **No Unchecked Merges**: Merges to `main` must use pull requests with passing CI checks. Never use `--admin` merge overrides.

### Added in the follow-up PR (2026-10-21)

- Deployment discipline: `vercel.json` `ignoreCommand` runs `scripts/vercel-ignore.sh` (`tests/vercel-ignore-command.test.ts`): production always builds; a preview whose commit message contains `[skip ci]` or `[skip deploy]` is skipped. Vercel has no built-in commit-message marker; this is the documented Ignored Build Step. WIP branches are pushed once with the marker in the head commit.
- Free-point grant throttle in our own code (`src/lib/server/grantThrottle.ts`, `tests/grant-throttle.test.ts`): per IP 900 an hour, per device cookie 5 a day (env `PROMO_GRANTS_PER_IP_PER_HOUR`, `PROMO_GRANTS_PER_DEVICE_PER_DAY`); no money value changed.
- Tests for the owner's items: fake provider cannot be on in production and never reaches the live database (`tests/fake-provider-production-refusal.test.ts`, `tests/fake-provider-mode.test.ts`); `/admin/export` admin-only for every verb, no secrets, absent from customer surfaces (`tests/admin-export-access.test.ts`, `tests/admin-export.test.ts`).
- Sign-up arithmetic and the confirmation-off fallback: `docs/SUPABASE_FREE_PLAN.md` section 4b.
