# Phase 5: B2B contact enrichment, admin reverse lookup, multi-provider execution (14 Nov 2026)

**Reference documents:**

* `docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md` (Chapter 9, PR-5.1 / PR-5.2);
* `PHASES-2-4-ACCEPTANCE.md`;
* `PHASES-2-4-BASELINE.md`.

**Starting point:** `main` = `e0ebe47` (PR #486). PR #481 (spend-gate wiring, open, INACTIVE) was not touched.

**Rules kept throughout:**

* No paid call.
* No flag set.
* No migration.
* No secret read or printed.
* No change to permissions, pricing, the ledger, reservation or settlement.
* Every change went through a PR merged at its verified head.

## 1. Status at a glance

| | CODE COMPLETE | OFFLINE VERIFIED | LIVE VERIFIED | PRODUCTION ENABLED | NEEDS THE OWNER |
|---|---|---|---|---|---|
| **B2B contacts** (company → employees → professional identity → work e-mail → business phone) | Yes (existed; Phase 5 adds the private-mailbox guard and provenance) | Yes | Partly. Historic live missions, e.g. msn_088c on 13 Nov. Nothing new live. | **Yes.** Already in production; the guard is on by default (§3.2). | Decisions 1 and 2 (phones, chat wording) |
| **Sensitive contacts** (private mailboxes, private mobiles, identity reverse lookups) | Access model exists (admin + «verified business») | Yes (existing tests plus Phase 5) | n/a | Admin only in practice: `verified_business_accounts` has **0 rows** | Legal review, lawful basis, retention, opt-out (§4) |
| **Admin reverse lookup** | Yes | Yes (Phase 5 hard cap, fail-closed audit, input compatibility, ambiguity) | **No** new call. 11 historic admin lookups, $0.325340 (27–29 Oct). | The screen is live for admins | Live acceptance L1/L2 (§8); server history table (§5.4) |
| **Multi-provider execution** (SourceGateway, per-stage dispatch, provenance) | Yes | Yes (unit, chain, end-to-end replay, recorded-call replay) | **No** | **No.** `multi_stage_engine` is off and set by nothing. | Turn it on for the test account; live acceptance L3/L4 |

**The sensitive-contact service is NOT fully live.** The legal, access, provider and financial acceptance gates in §4 have not passed. Nothing in this campaign claims otherwise.

## 2. Audit of the existing behaviour (task 1)

| File | Implemented and working | Incomplete | Untested before Phase 5 | Depends on authorization |
|---|---|---|---|---|
| `agent/src/engine/contacts.ts` | Company e-mail and HQ phone steps; per-person finder chains, decision makers first; e-mail verifiers, phone validators; step caps and job budget; «غير متوفر» vs «لم يكتمل البحث» (stage 3) | **No contact-type check on finder answers.** A gmail/outlook address from a finder was written as a work e-mail, «غير موثّق لهذه الشركة», or «موثّق» when the company domain was unknown (fixed, §3.2). No provenance per cell (added). | A private-mailbox answer (two tests asserted the leak) | Finder chains filtered by `policyVerdict` (the account's access) |
| `src/lib/agentMission/contactFinders.ts` | Finder, verifier, validator, lister and maps ranking, priced by one real call; `foundContactIn` refuses masked values | `foundContactIn` returns unverifiable values as «unverified» (kept: the engine now classifies them) | — | `EMAIL_FINDER_CAPABILITIES` includes `people.email.find.personal` (sensitive): only admin and verified-business chains can hold it |
| `src/lib/agentMission/contacts.ts` | `verifyContactValue` refuses personal mail domains and placeholders; contact-source rows without a verified value are not saved (not charged) | — | — | — |
| `src/lib/agentMission/guardRules.ts` | Refuses phones, home addresses and personal e-mails of private individuals before any model call | Allows «personal e-mails of company employees» in a business context (PHASES-2-4 §6.3; downstream it becomes company-level contacts) | — | Owner policy (decision 2) |
| `src/lib/treg/dataPolicy.ts` | 4 categories, 50 sensitive endpoints (S1–S8), 231 b2b_contact, 278 blocked; generated and checked byte for byte | **The 18 `people.phone.find` finders are b2b_contact; 8 of them describe their result as a MOBILE** («Find a mobile phone number», «verified mobile number»). See §3.3. | — | Owner + legal (decision 1) |
| `src/lib/server/sensitiveAccess.ts` | Policy → purpose (customers, ≥ 5 chars) → daily count limit (50) → audit row before the call → completion; masked values only | Admin calls went ahead when the audit row could not be written (kept for worker and planner admin paths; the reverse lookup now fails closed). **No lawful-basis field, no retention, no opt-out.** | — | `verified_business_accounts` (0 rows) |
| `src/lib/server/adminLookup.ts` | Evidence-ordered candidates; paid phone endpoints only after price confirmation; US-only detection; company-only branddev skip; field merge with sources | **The cap was a soft cap**: it used process memory plus a read before the call, so concurrent requests passed it. Unknown charges were counted as $0. The audit could be skipped. One candidate sent the e-mail as a `full_name`. Multi-person answers were not flagged. All fixed, §5. | Concurrency, unknown charges, audit loss | Admin session (`authenticateAdmin`) |
| `src/lib/server/adminLookupHistory.ts` | Masked input; server table code | **The table `admin_lookup_history` is not in production** (proposal only). The saved fields are sent by the browser. | — | Owner: apply the SQL |
| `src/app/api/admin/reverse-lookup/route.ts` | `authenticateAdmin` before every action, both GET and POST (pinned by a test) | — | — | Admin |
| `src/app/admin/reverse-lookup/page.tsx` | Live attempts, paid confirmation, history | **The browser history stored the identity fields** (name, employer, title, profile link) in `localStorage`, unencrypted, with no retention (fixed, §5.4) | — | — |

**Production facts (read-only SQL, 14 Nov 2026):**

* `sensitive_lookup_audit` exists:
  * 11 rows, all admin reverse lookups (10 called, 1 failed), $0.325340;
  * RLS is on, with an admin-only read policy;
  * the `outcome` check allows `pending … refused_audit`.
* `verified_business_accounts` exists with 0 rows.
* `admin_lookup_history` does not exist.
* `agent_settings` holds `redesign_flags` and `social_discovery` only.

## 3. The B2B contact service (task 2)

### 3.1 What a customer gets

* **The flow:** companies → people (decision makers first) → each person's work e-mail → their direct business phone, or the company's HQ phone labelled «رقم الشركة». It also gives the company's own role mailbox (info@, sales@ on its own domain).
* **Access:** every capability stays under the `b2b_contact` policy. Nothing was removed or restricted for B2B data.
* **Never invented:**
  * a masked, malformed or missing value leaves the cell empty;
  * a map result for another business is not the company's phone;
  * a found value is written only with its status.
* **Status:** «موثّق» only when a verifier says deliverable (e-mail) or valid (phone). Otherwise «غير موثّق».
* **Employer association:** an address on another **company's** domain stays, labelled «غير موثّق لهذه الشركة».
* **Charging:** the contact steps fill CELLS of rows already delivered. They add no row, so the charge (ceil(delivered rows × unit)) does not depend on what was found.
  * **Fields that were not found are not charged as fields.**
  * Contact-source rows without a verified value are not saved at all.
  * Note: the per-person unit price includes the step's *expected* cost (`per_person_usd`, measured hit rates). A person whose e-mail was not found still pays that blended unit price. This is the existing pricing (unchanged). Charging per delivered field would be a pricing change (decision 4).

### 3.2 Change: a private mailbox is not a work e-mail (PR #488)

* **The bug:** a person finder can return a gmail/outlook/yahoo/icloud/proton address. The engine wrote it in the work-email cell:
  * as «غير موثّق لهذه الشركة» when the company domain was known;
  * as «غير موثّق», or **«موثّق»** after a verifier, when it was not.
* **Why that was wrong:** that delivered a private mailbox, which belongs to the **sensitive** category (S1 personal contact), to ordinary customers through the B2B path. It contradicted the documented policy (`contacts.ts`, audit Chapter 12 «never personal mailboxes») and the decision-makers path (`contactValueDelivered`).
* **Now:**
  * `emailValueTypeOf` classifies a value as `professional` / `personal_mailbox` / `invalid`;
  * a `personal_mailbox` is never written, for any account, and the next finder is asked;
  * `withheld.personal_email` counts it.
* **Two existing tests asserted the leak.** They now assert the stricter rule (no gmail written); each is commented CHANGED.
* **Provenance:** every contact cell a call filled carries `_src_<column>` (endpoint) and `_call_<column>` (the recorded `mission_calls` id, raw answer at `raw/<call>.json`). These are internal marks: the workbook writes stage columns only.

### 3.3 Not changed: mobiles from B2B phone finders (owner and legal decision 1)

* **The facts:**
  * 18 `people.phone.find` endpoints are `b2b_contact` (rule C1);
  * 8 of them say they return a **mobile** («Find a mobile phone number», «Reveal a verified mobile number»); the others say «direct», «business» or nothing;
  * in Egypt and the Gulf most direct business lines are mobiles, so a «direct dial» cannot be told from a private mobile by its number.
* **The current label:** the engine writes such a number with type «شخصي» (the person's own) next to the HQ phone «رقم الشركة».
* **Why nothing changed:** tightening this would remove a production capability. Loosening the policy is forbidden. Both are permission decisions. Phase 5 pins today's behaviour and asks the owner (§9, decision 1).
* **Options:**
  * (a) keep it, with legal sign-off that direct mobiles from B2B providers are business contact data;
  * (b) deliver only HQ / landline numbers to ordinary customers and move person mobiles to the sensitive category;
  * (c) rename «شخصي» to «مباشر» (direct) without changing access.

## 4. Sensitive contacts: access-model audit (task 3)

| Gate | What exists | Gap |
|---|---|---|
| Who | Admin (session role) or «verified business» (`verified_business_accounts.verified`; 0 rows today). A missing table or an error means NOT verified. The gateway refuses a sensitive endpoint unless the audited path set `sensitiveAccess` (pinned: only `stageCall.ts` and `adminLookup.ts` set it). | None found |
| Use purpose | Customer accounts must give a purpose of ≥ 5 characters before approval. It is stored on the plan item and the audit row. | Free text. Nothing checks that it is a lawful purpose. |
| Lawful basis | **None.** No field, no check, no record of the basis (consent / contract / legitimate interest). | Owner + legal: define the bases and record one per lookup |
| Provider terms | Firecrawl and Context.dev terms forbid unlawful personal-data processing; TREG binds to upstream terms (audit §12). Not reviewed for each sensitive endpoint. | Legal review of the 50 sensitive endpoints' upstream terms |
| Record retention | The audit row keeps the masked value, purpose, cost and outcome. **No retention period, no deletion job.** The raw provider answer of a mission call is kept in the private bucket under the mission. | Owner: a retention period for `sensitive_lookup_audit` and for raw answers of sensitive calls |
| Opt-out | **None.** No suppression list for people who asked not to be looked up, and no check before a call. | Owner + legal: an opt-out list checked before every sensitive call |
| Daily limits | Customers: 50 lookups a UTC day (a count). Admin: $2 a UTC day (cost; now a hard cap, §5.2). | — |
| Audit reliability | Customer calls fail closed. The admin reverse lookup now fails closed (§5.3). Admin sensitive calls from the worker or the planner still go ahead with a log line when the audit row cannot be written (unchanged; decision 3). | Decision 3 |

**Conclusion:**

* Access is restricted correctly today (admin only in practice).
* Opening it to verified-business customers must wait for lawful basis, retention, opt-out and a provider-terms review.
* No restriction was loosened.

## 5. Admin reverse lookup readiness (task 4)

### 5.1 Candidates (catalog snapshot, real prices)

* **E-mail → identity/company:** 20 candidates (21 before the input fix).
  * The evidence order is fiber-ai ($0.04), blitzapi ($0.000495), quickenrich ($0.004834), aiark ($0.0026335), findymail ($0.0198), treg identity ($0.25), branddev by-email ($0.02534, company domains only) and companyenrich ($0.049).
  * Then the rest cheapest first, up to $0.65. All are paid and «auto»: the walk stops at the first useful answer.
* **Phone → identity:**
  * `getleadsio.people.phone.lookup`: free, auto;
  * `blitzapi.people.phone.reverse`: $0.000495, **US only** (skipped for other countries);
  * `enrichlayer.contacts.reverse-phone`: $0.30, confirmation required, with a warning outside the US.
  * **For Egyptian and Gulf numbers only the free endpoint is automatic. Coverage there is unproven.**
* **Country restrictions:** read from each endpoint's own catalog text (US-only phrases). Anything else is «unproven», with a warning on paid calls.
* **Response schemas:** read with `readShape` and the endpoint's hints. Name, company, title, profile link and country come from flat, nested or split names. A brand record is a company, never a job title.
* **Match confidence:** there is no score. The first row is shown. **New:** an answer naming several *different* people is flagged `ambiguous` («نتيجة غير مؤكدة: أكثر من شخص»), and it is not a confirmed match.
* **Input compatibility (fixed):** `limadata.people.identity.resolve` took the typed e-mail as `full_name`. Its one required input names a person, so it is no longer a candidate. The fallback input must be a generic search input; a test pins this over the whole catalog.

### 5.2 The $2 daily cap (PR #487)

| Before | After |
|---|---|
| Read the day's sum, then call. The sum also used process memory. | **Reserve, then check:** the pending audit row is written WITH the route cap, then the sum is re-read; over $2 means refused, with no call |
| Concurrent requests both passed the read | Of two racing requests at least one sees the other's row (12 racing, room for 3 → at most 3 called) |
| Process memory (one Vercel instance) | Audit log only; a second process sees the first one's spend |
| Checked against the estimate | Checked against the most the call can cost (the route cap; a free endpoint reserves $0.001) |
| A timeout or unreachable call counted $0 | It counts at its reservation; a thrown call too; a lost completion leaves the row `pending` at its reservation |

### 5.3 The audit fails closed

* An unreadable sum, an unwritable row or a failed re-read means refused, and nothing is called.
* The existing test «without the audit table the admin lookup still runs» now asserts the refusal. This is stricter, as the brief requires.
* No call bypasses authentication: GET and POST both run `authenticateAdmin` before any client is created (pinned).

### 5.4 History

* **Server:** `admin_lookup_history` is a proposal (`docs/proposals/admin-lookup-history/`, NOT applied).
  * It is admin-only (RLS, service role) and has **no retention period**: add one before applying it (decision 5).
  * The saved fields are sent by the admin's browser. A server-derived record would be stronger (follow-up).
* **Browser fallback (PR #487):**
  * only the masked input, the outcome, the attempts and the cost are kept, never the identity fields;
  * the earlier v1 key (with fields) is stripped and migrated on first load;
  * reopening a local entry says the fields are not kept.

## 6. Multi-provider execution (task 5, PR #489)

* **`agent/src/engine/sourceGateway.ts`:** one provider-neutral way for a stage to call its source.
  * **The stored scope:** a stage may call only its approved recipe's endpoint and that recipe's approved fallbacks (`engine.alternatives`), within an optional stage cap.
  * A call outside the scope is refused with no request and no cost.
  * **Dispatch:** a TREG id goes to `Gateway.tregCall`; a direct web id (`firecrawl.*`, `contextdev.*`) goes to the existing `WebGateway`. Both keep every check: policy, sensitive audit, job budget, daily cap, record, raw answer.
  * Without a web key, a web stage is refused. It is never re-routed.
  * Every call is recorded with stage, provider, route (treg / web) and call id.
* **Per-stage dispatch** (`stageDispatchOf`): stages with a recipe whose parent is on the engine run on the engine; the rest go to the model path, which continues from what is saved. Before, one stage without a recipe sent the whole mission to the model.
* **Provenance:** saved rows carry `_src` and `_call`. These are internal: never a column, never part of an item's id.
* **The switch:** `multi_stage_engine` (agent_settings, scoped like the Phase 2–4 switches). It is **OFF and set by nothing**. Off, execution is byte-identical: the flags-off digests are green.
* **Money:** no change to pricing, ledger, approval, reservation or settlement. An end-to-end replay with the switch on gives the same calls, delivered count, charge, release and file, cell for cell.
* **Not covered offline:** the model path that continues after the engine stages is exercised only by a source-level test. An executed mixed engine + model mission needs the live acceptance (L4).

## 7. Tests (local; the repository has no GitHub Actions)

| PR | Head | Full suite | New / changed tests | Typechecks | Build + secret scan | Mutations |
|---|---|---|---|---|---|---|
| #487 admin lookup | `fc3ddd9` | 13,697 passed, 0 failed, 47 expected-fail, 78 skipped | 18 new; 1 made stricter | clean | clean | 9/9 |
| #488 B2B contacts | `5c052db` | see the PR | 17 new; 2 made stricter | clean | see the PR | 6/6 |
| #489 SourceGateway | `2a8a909` | see the PR | 17 new | clean | see the PR | 9/9 |
| this PR | see the PR | see the PR | input compatibility + ambiguity (2); recorded-call replay (1) | see the PR | see the PR | 3/3 |

**Real vs simulated:**

* **Real:**
  * the TREG catalog snapshot and the data policy;
  * the recorded calls of the production mission msn_088c (13 Nov 2026: endpoint, page, status, real cost), replayed through the SourceGateway in `tests/phase5-recorded-replay.test.ts`;
  * production row counts (read-only SQL).
* **Simulated** (labelled in every file): the provider answer bodies (names, addresses, map results), the reverse-lookup answers, and the X pages of the end-to-end replay.

**Coverage of the brief's list:**

| Brief item | Test file |
|---|---|
| Companies with named employees; professional e-mails; business phones; missing or invalid values; private boundary; row identity; no charge per field | `phase5-b2b-contacts.test.ts` |
| Admin reverse e-mail and phone; ambiguous matches; provider failures and timeouts; concurrent cap; unknown charges; audit/history unavailable; input compatibility | `phase5-admin-lookup-hardening.test.ts` |
| Cross-provider stage dependencies; scope; dispatch; approval and financial invariants (e2e) | `phase5-multi-provider-execution.test.ts` |
| Recorded real calls | `phase5-recorded-replay.test.ts` |

No existing privacy or money assertion was weakened. Three assertions were made stricter, each marked CHANGED (Phase 5).

## 8. Live acceptance proposal (NOT run; owner approval required)

All steps use the existing caps. **The total ceiling is $0.30.** Order:

| # | What | Account / switch | Exact calls | Ceiling |
|---|---|---|---|---|
| L1 | Admin reverse e-mail on the owner's OWN work address (consent) | admin screen | attempt by attempt: blitzapi ($0.000495), aiark ($0.0026335), quickenrich ($0.004834); stop at the first useful answer | **$0.01** |
| L2 | Admin reverse phone on the owner's OWN number | admin screen | `getleadsio.people.phone.lookup` (free; reserves $0.001); no paid phone endpoint | **$0.001** |
| L3 | B2B mission on the test account: 2 Cairo companies, 1 decision maker each, work e-mail + phone | test account; switches unchanged | the existing contact chain; the mission's own reserve and execution budget | **$0.10** provider spend (existing practice ≤ $0.20) |
| L4 | The same request with `multi_stage_engine = { "user_ids": ["<test account>"] }`, then remove the key | test account only | the same chain through the SourceGateway; review `_src` / `_call` against `mission_calls` | **$0.10** |

* **Check after each step (read-only SQL):**
  * `sensitive_lookup_audit` rows: the pending reservation, then the real cost;
  * `mission_calls` / `provider_costs`;
  * the delivered file (no gmail in a work-email cell; statuses; «رقم الشركة» labels);
  * the charge ≤ the hold.
* **Stop rules:**
  * any cost above its ceiling;
  * any private mailbox delivered;
  * any call outside the scope;
  * any audit row missing.
* **Rollback:** remove the `multi_stage_engine` key. No deploy is needed.

## 9. Owner decisions (nothing here was done)

| # | Decision | Effect |
|---|---|---|
| 1 | Person mobiles from `people.phone.find` (b2b_contact): (a) keep with legal sign-off, (b) restrict to sensitive, or (c) relabel «شخصي» → «مباشر» | Permission / product |
| 2 | Chat wording for «personal e-mails of employees» (PHASES-2-4 §6.3): refuse, or explain that only work e-mails are delivered | Chat policy, every customer |
| 3 | Fail closed for ALL admin sensitive calls (worker and planner), not only the reverse lookup | Admin missions stop when the audit is down |
| 4 | Charge contact fields per delivered value instead of the blended per-person unit | **Pricing** change |
| 5 | Apply `admin_lookup_history` with a retention period (e.g. 90 days), or keep only the browser summary | Migration |
| 6 | Sensitive access for verified-business customers: lawful-basis field, retention for `sensitive_lookup_audit` and raw sensitive answers, opt-out list, provider-terms review | Legal + migration |
| 7 | Live acceptance L1–L4 (§8), ≤ $0.30 | Spend |
| 8 | Price confirmation for automatic e-mail reverse endpoints above a threshold (e.g. > $0.05: treg identity $0.25 and the $0.19–$0.65 tail are «auto» today, bounded only by the $2 cap) | Admin UX / spend |
| 9 | Turn `multi_stage_engine` on for the test account (L4), later for customers | Flag |

## 10. Production state

See `docs/HANDOFF.md` «CURRENT STATE» for each merge's Vercel deployment and Heroku release. `agent_settings` was unchanged throughout: `redesign_flags` and `social_discovery` only.
