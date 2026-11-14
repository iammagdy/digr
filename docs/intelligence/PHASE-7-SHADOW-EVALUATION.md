# Phase 7: regression and shadow evaluation (PR-7.1), 14 Nov 2026

**Reference documents:** `DIGER_INTELLIGENCE_AUDIT.md` (historical; chapters 10 «production preservation», 11 «evaluation», 14 PR-7.1), `PHASE-5-3-AND-6.md`, `PHASE-5-CONTACTS-AND-REVERSE-LOOKUP.md`, `../capabilities/sync-2026-11-14.md`.

**Starting point (read-only, verified before any change):** `main` = `02ba17f` (PR #496); Vercel production `dpl_FVdY3Yxagz4VMSUNAXs52vekKToB` READY on it; worker heartbeat `02ba17f`, `active_missions 0`; `agent_settings` keys `redesign_flags`, `social_discovery` only (no Intelligence switch set); `credit_ledger` 1,247 rows; no queued or running job, no queued, planning, approved or executing mission. Open PRs: #481 and old drafts; none touched.

**Rules kept:** no paid call (provider or model); no switch set or read; no migration; no change to pricing, ledger, settlement, balances, RLS, permissions, crons or infrastructure; no secret read or printed; Phase 5.3-B and PR #481 untouched; Phase 8 not started.

## Status at a glance

| | CODE COMPLETE | OFFLINE VERIFIED | LIVE VERIFIED | PRODUCTION ENABLED | NEEDS THE OWNER |
|---|---|---|---|---|---|
| **7.1 admin shadow comparison** | Yes (this PR) | Yes (§6) | **No.** Nothing live was compared. | Admin-only screen and API, deployed with the PR; it changes no customer behaviour and no switch | A daily cap for any LIVE shadow (§9) |

«Code complete» is not «live». The screen compares what the repository's own pure code does with the switches off and on; it does not show what a real customer, provider or model would do.

## 1. What was built

| Part | File |
|---|---|
| Types, evidence labels, dimensions | `src/lib/agentMission/shadow/types.ts` |
| The words reading today vs with the semantic layer (read-only view over the existing pure functions) | `src/lib/agentMission/shadow/understanding.ts` |
| The engine: one case → findings; a corpus → report with gates | `src/lib/agentMission/shadow/compare.ts` |
| Redaction of everything the screen shows | `src/lib/agentMission/shadow/redact.ts` |
| Context (catalog snapshot, reviewed registry artifact, data policy, hand cards; no network, DB or secret) | `src/lib/agentMission/shadow/context.ts` |
| Corpus and the open risks | `src/lib/agentMission/shadow/corpus.ts`, `auditScenarios.ts`, `data/shadow/corpus.json`, `scripts/shadow/build-corpus.ts` |
| Arabic labels of every finding, severity and evidence | `src/lib/agentMission/shadow/labels.ts` |
| Admin API (GET summary / one case, POST a typed request) | `src/app/api/admin/shadow/route.ts` |
| Admin screen, on the agent console | `src/components/admin/ShadowPanel.tsx` (mounted in `src/app/admin/agent/page.tsx`) |
| Tests | `tests/shadow-phase7.test.ts` (63) |

The only configuration change: `next.config.mjs` traces the catalog snapshot and `registry.json` into `/api/admin/shadow` (the same way the other admin routes that read the catalog are traced).

## 2. What is compared

**«Today»** is every Intelligence switch OFF: the words reading without `semantic_normalization_v1`, the chat's fixed pre-model guards, the compiled social path, and the legacy planner for everything else. The legacy planner is a MODEL: its provider choice cannot be replayed offline, so a provider baseline exists only where a stored approved plan exists. Nothing is invented for the rest.

**«Proposed»** is the switches ON: `semantic_normalization_v1`; `capability_discovery_v1` with `registry_router` (and the enrichment step); `customer_exclusion_files_v1`. A customer account uses production-eligible capabilities only; a test account (the controlled-activation path) also fixture- and live-verified ones. The registry is built for an ordinary account; web providers are assumed to have a key and a small cap (the worker's key and cap facts are not read).

| Dimension (the brief's list) | Today | Proposed | What decides a difference |
|---|---|---|---|
| Arabic request understanding and corrections | `buildRequestContract` / `buildAsk`, semantic layer off | same, layer on | per field: a labelled meaning (audit table, 98 labelled requests) decides; otherwise a lost value is a regression and a filled one is an UNVERIFIED improvement |
| Platform, country, date, requested fields | contract and Ask fields | same, layer on | same rules |
| Selected providers and eligibility | the stored approved plan's sources | router verdict for a customer and a test account | each historical stage: same / still a validated candidate / excluded with the router's reason; hard rules on every selection |
| Stage chaining and approval scope | the stored plan's stages | chain, binding, approval record | chain binding, the plan's own record, and three tampers (a swapped capability, an added stage, changed parameters) must all be refused |
| Company and professional-contact coverage | stored stages | need and selected stages | an asked item with a selected stage, said to the customer, or a silent drop |
| Privacy and authorization | chat pre-filter and the deterministic guards | discovery status, policy category, customer text | a refusal that stops holding; a router that does not carry the guard; a private, sensitive or blocked source; a provider or price in a customer sentence |
| Exclusion list | not applied, and the customer is told so | the matcher on synthetic rows | a listed organisation is removed, a person's own name is not, a shared brand word is delivered and marked, an enrichment request is never an exclusion |
| Estimated cost and budget safety | planned rows through the historical source | the same rows through the proposed source | catalog prices (an estimate, not a measurement); the existing pure money functions are only CALLED to check that a settlement charge cannot exceed its reserve or the cap |
| Missing, unsupported, uncertain outputs | stored gaps | status, unsupported reasons, limitations, unproven outputs | an unsupported verdict with no sentence for the customer is a regression; unproven outputs are reviewed |

Every finding carries an **evidence label**: `stored_real` (a stored real request, plan or labelled meaning), `code_computed` (the repository's own code, offline), `recorded` (Diger's recorded calls or catalog prices), `simulated` (synthetic input), `unverified` (cannot be known offline). A bare «the new reading filled a value» is an improvement but NOT a verified one; the report counts the two apart.

**Interpreter events do not exist.** The audit's model interpreter (PR-1.3) was never built, and the semantic layer is a deterministic reading that records nothing. The screen says so; its «understanding» columns compare the words reading with and without that layer.

## 3. The corpus

156 cases, all committed anonymised fixtures, no database read: the audit's 35 scenarios (with the routing the Phase 2-4 acceptance pinned); the 20 stored approved missions of `tests/fixtures/live/replay-missions.json` (49 stages); the 98 labelled requests of the Phase 0 baseline; 3 synthetic exclusion-list cases (the safe `.example` domain). The website cannot read `tests/`, so `data/shadow/corpus.json` is a committed copy (`scripts/shadow/build-corpus.ts --check` and a test keep it current). An admin can also type a request: it is compared, echoed back redacted, and never stored.

## 4. The regression gates (audit §10.4, made objective)

25 regression codes, each watched by one of seven gates; a regression not in the reviewed `ACCEPTED_DIFFERENCES` list (empty) fails its gate, and one that no gate watches fails a catch-all gate.

| Gate | Rule |
|---|---|
| G1 | no lost constraint, stage or asked item |
| G2 | nothing production completes becomes unserved or silently unanswered |
| G3 | privacy refusals hold; no private, sensitive or blocked source selected; no provider or price in customer text |
| G4 | **no silent capability approval**: a customer account is routed only to a reviewed production capability, a test account never to a broken or below-tier one; every selected capability has a known price and the required outputs |
| G5 | the approved scope is enforced (chains bound by documented fields; swap, add and change are refused) |
| G6 | the estimated reserve stays under the job cap and a settlement charge cannot exceed its reserve |
| G7 | exclusion correct on synthetic rows |

Not recomputed here (kept by existing suites, which stay green): the flags-off digests (byte-identical OFF behaviour), the pricing function, the scrub of provider names in the existing customer texts.

## 5. Result on the corpus (offline, deterministic)

156 cases; **0 regressions, 0 accepted, all 7 gates pass**. Findings: 130 to review, 114 improvements (**81 verified**, 33 not backed by a label), 355 unchanged, 257 informational. Verdict per case: 0 regression, 55 review, 52 improvement, 49 same. Digest of the report: `4a3a29ea…` (changes whenever a fixture or the registry changes: that is a reviewed change).

## 6. Phase 7 acceptance report

### 6.1 Verified improvements (81, each checked against a labelled meaning or a hard rule)

* **77 corrections of the words reading** against the labelled meaning: 42 in request understanding (comments, replies, kind, topic, source) and 35 in conditions (platform, country, period, count, language). Example: a period «من ١ لـ ١٥ أكتوبر» read as the whole month today and as 1–15 October with the layer (audit scenario 25).
* 1 value cleared together with a corrected platform (a «tweets» kind read from a bare «X» in «مطعم اسمه X»).
* 1 historical source avoided because it is measured broken (billed calls, no usable rows: `scrapecreators.x.v1-facebook-post-comment-replies`).
* 2 exclusion checks on synthetic rows: listed organisations removed, a person's own name never removing a row.
* The privacy refusals in the corpus (a private message, a commenter's mobile number) hold before and after, and the router plans nothing for them (8 unchanged privacy findings).
* Approval scope is enforced for every proposed chain (255 unchanged chaining findings): a swapped capability, an added stage or changed parameters are refused.
* 33 further improvements are **not verified** (a value filled, a topic cleared of a date or country phrase, a route that follows a newly read platform): plausible, with no label to confirm them.

### 6.2 Regressions

* **None unaccepted** on the corpus (§5). One case is a recorded trade-off to look at: `pl-15` «عايز تعليقات Twitter عن السياحة»: the layer corrects the platform and the route (2 fields) but reads «comments» as none for X (1 field). That is the Phase 1 baseline's «partial»; X comments are replies in the contract.
* **Open understanding gaps the layer does not close** (5, from the Phase 0 baseline): `cm-08` (a topic with no marker word), `pl-19` (a Reddit request goes to the legacy planner because «شركات» is checked first), `rt-03` and `sa-04`/`sa-06` («اللي الناس كاتباه تحت» and «الكومنتس» are not read as comments).

### 6.3 Review items: what activation would change (not regressions today, decisions before activation)

| Finding | Cases | Meaning |
|---|---|---|
| `legacy_served_gated_by_router` | 29 (20 companies, 6 social, 2 places, 1 web) | with the router ON for **customer** accounts, requests the legacy planner may serve today become «unsupported» until their families are promoted with evidence. **Do not turn the router on for customers first**; test account first. UNVERIFIED (the legacy planner cannot be replayed) |
| `estimated_cost_higher` / `estimated_reserve_higher` | 9 / 11 of 20 stored missions | the router's choice costs more than the historical source for the same planned rows: from +1.2% to +297% provider cost; worst reserve 293 → 672 points (`msn_a6dacebc…`), 273 → 335, 200 → 252. The customer would be quoted more. Catalog prices, not measured. 2 missions get cheaper (−12%, −26%) |
| `historical_source_below_verification` | 9 stages | live-verified sources (TikTok comments `crawl4ai`/`tikhub`, YouTube search `crawl4ai`) are not on the reviewed production list: a customer account loses them until the owner promotes them with their evidence |
| `provider_changed_validated` | 10 stages | a different but equally validated source is preferred |
| `scope_expanded` | 8 | the proposed chain adds a stage the approved plan lacked (the customer would approve a different scope) |
| `asked_not_covered_but_said` | 27 | an asked website, public contact or professional has no production-eligible source for a customer: said to the customer, never dropped silently |
| `outputs_unproven` | 14 | the selected source documents its output fields; no stored real page proves them |
| `historical_source_not_routable` | 2 | Instagram sources whose inputs are not mapped to an input class: the compiled path uses its own verified cards |
| `router_verdict_differs_from_compiled_path` | 3 | the compiled social path serves it; the router records a different verdict and never blocks it |

### 6.4 Customer journeys NOT tested

Nothing live was run. Not tested: a real browser journey on any screen (including this one); a mission planned by the router and executed (its approval, quote, settlement, file); the legacy planner's behaviour on companies, places and web requests; a real exclusion file uploaded in the chat and applied to a real mission; the exclusion card text in the chat on a real conversation; enrichment files (blocked, §10); a free re-run of a mission that used a list; multi-turn corrections typed in the chat UI; the platform card and its tapped answer; payments, top-up and refund journeys under a new plan; mobile layouts; provider answers (every price here is the catalog's or Diger's recorded figure, not a new measurement); real concurrency and Heroku restarts during a router-planned mission.

### 6.5 Operational risks

* **The router changes quotes** (§6.3): a customer shown a higher reserve than for the same request today.
* **Gating**: customer-side activation without family promotion hides services the legacy planner may serve today.
* **Free re-run drops the exclusion list** (§7).
* **The 30 breaking changes of the Phase 6 sync** (29 endpoints TREG no longer offers on its platform key, one removed input) are reviewed, not yet applied to the pinned snapshot or the registry; the registry the router reads is 18 days behind TREG's live catalog.
* **The spend ceiling is not enforceable** (`PRODUCTION_BUDGET_GUARANTEE.enforceable` is false: model calls are not reserved before they are sent; provider caps are shared and estimated; there is no aggregate ledger). The acceptance workflow refuses to start for that reason.
* **Open PR #481** (spend gate wiring) edits files the router path also touches and needs a rebase.
* **Vercel**: Hobby plan, 3× Active CPU limits granted for 30 days after a deployment block; the always-on admin and driver traffic dominates.
* **Build**: `next build` needs a larger heap in a 16 GB sandbox (`NODE_OPTIONS=--max-old-space-size=8192`); Vercel's own builds succeed.
* **Deployments restart the worker** and requeue running missions: deploy only with `active_missions 0`.

### 6.6 Remaining requirements before controlled activation

1. The owner decides what to do about the quote increase (§6.3) and the 9 live-verified sources: promote them with evidence, or accept the higher reserve.
2. Promote families for customers (companies, places, web) with evidence **before** the router is on for customers; until then the router is for the test account only.
3. Apply the Phase 6 sync's reviewed changes to the pinned snapshot and registry in a separate PR.
4. Close or accept the 5 open understanding gaps and the `pl-15` trade-off.
5. Fix or document-around the free re-run drop (§7) before any customer relies on an exclusion list.
6. A **live** shadow, with a daily cap the owner approves, on the test account for two weeks (audit D5), before comparing real traffic.
7. A spend ceiling that is enforceable for the test account's acceptance missions.
8. An acceptance mission per family on the test account under the ceiling (the existing `ACCEPTANCE-WORKFLOW.md`), reviewed by the owner.
9. A real-browser pass of the customer chat with each switch on, on the test account.
10. Rebase PR #481 and decide its place.
11. Then, and only then, Phase 8 (flags per family, rollback = switch off). **Phase 8 was not started.**

## 7. The exclusion-file free re-run risk (documented, not fixed)

The admin's «إعادة تشغيل مجانية» (`freeRerun.ts`) creates a NEW mission for the customer's account with no assistant card message. The worker finds an exclusion list only on the mission's own card message (`agent/src/customerExclusion.ts`: same `user_id`, same `agentMissionId`), so a re-run of a request that relied on a list **applies no list, and says nothing**. Companies the customer excluded can then be delivered, which breaks the customer's own instruction (money handling of the re-run is unchanged and was not examined here).

* Pinned by a test: `freeRerun.ts` and `freeRerunMark.ts` never mention the exclusion; if someone fixes it, that test fails and this section and the `exclusion_free_rerun_carries_no_file` finding must be updated.
* Until it is fixed: do not re-run a request that carried a list; if a re-run is needed, deliver the file to the customer only after removing the listed companies by hand.
* A fix needs the list attached to the new mission (a card snapshot copied under the same approval rule) and a customer-facing sentence; that touches the free re-run flow and was not done here.

## 8. Limitations of the screen (said, not hidden)

* Offline and deterministic: not a live comparison and not a prediction of real quality.
* No provider baseline for requests with no stored approved plan (the legacy planner is a model).
* Web providers are assumed to have a key and a $1 daily cap; the worker's real key and cap facts are not read.
* Costs are catalog or recorded figures, never measured here; every USD and points figure is admin-only.
* The corpus has real requests only from the stored fixtures; no live request is read.
* Redaction removes e-mails (including a truncated one), links, handles, phone-shaped numbers and credential shapes from everything the screen returns; a stored fixture handle (`@brand_eg`, a made-up brand) is redacted too.

## 9. Not done, by design

No live shadow (needs an owner-approved daily cap); no interpreter (not built); no switch read or written; no database read; no change to the router, the registry, eligibility, prices, the exclusion code, pricing, settlement or any customer text; no fix of the free re-run; no Phase 8.

## 10. Still blocked for the owner (unchanged)

Phase 5.3-B (enrichment files: a new quote model, new settlement semantics, paid enrichment per supplied row, report `PHASE-5-3-AND-6.md` §B) was not touched. PR #481 was not touched.

## 11. Tests and checks (local; the repository has no GitHub Actions)

* `tests/shadow-phase7.test.ts`: **63 tests**: redaction (e-mails including a truncated one, links, handles, phones in Latin and Arabic digits, credential shapes, and what must be kept); the corpus (a current committed copy, 35 + 20 + 98 + 3 cases, equal to the Phase 2-4 acceptance's scenarios, no personal identifier); the whole-corpus report (deterministic, zero unaccepted regressions, all gates pass, verified vs unlabelled improvements kept apart, the stored missions classified exactly as the Phase 2-4 acceptance recorded, customer accounts only on production-eligible sources, privacy scenarios refused, the gating of non-social requests visible, exclusion cases); **regression detection: every one of the 25 regression codes is triggered by a case built to break it** (a test fails if a watched code has no such case); the free re-run risk pinned to the source; no network, model, database, switch, secret or write in the engine; the admin API (admin only for GET, one case and POST; extra fields, empty and oversized text refused; typed personal data never returned); the screen.
* **Full suite: 14,008 passed, 0 failed**, 47 expected-fail, 78 skipped (992 files; the baseline on `main` before this PR was 13,945 passed in 991 files).
* `tsc --noEmit` and `npm run agent:typecheck`: clean.
* `npm run build` and the client-bundle secret scan: clean (211 files, zero secrets; the build needs `NODE_OPTIONS=--max-old-space-size=8192` in a 16 GB sandbox).
* **Mutation checks** (runner outside the repository; one protection removed at a time, the file restored each time): **63 of 63 caught.** The first run left four alive (a catch-all gate for an unwatched regression, the redaction of what `compareCorpus` is handed, the redaction of a failed comparison, and the chat guards read by `understandForShadow`); tests were added for them and all are now caught. The same tests found a real leak: an address cut at a dot by a topic parser («amira@example») was not redacted; it is now.
* Verification kinds: offline tests, typechecks, build, secret scan and mutation checks locally. Preview and production states are recorded in the final report. **Not done: a real-browser test, a live comparison, a live provider or model call.**

## Owner decisions (new in this phase)

1. How to treat the quote increase of the router's choices (§6.3): promote the live-verified sources, or accept.
2. Whether a LIVE shadow may run on the test account, and its daily cap (audit D5).
3. Whether to fix the free re-run so it carries the exclusion list (§7).
4. Which families are promoted for customers first (§6.6).
