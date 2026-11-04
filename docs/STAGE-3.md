# STAGE 3: companies, decision makers and the queue (FOUNDATION-PLAN section 5, "PR 5")

Branch `stage-3/companies-and-queue`, started from `main` = `239ca94`. Draft PR only. **Nothing here changes what a customer sees or receives.** Every new module is reached by tests only (`tests/stage3-isolation.test.ts`). Every new behaviour sits behind a new flag that is OFF when unset. No e-mail is sent and no template is made.

No SQL, no migration, no new table, no paid call, no model call, no money file. **No existing file was changed.**

---

## 1. Goal, in plain words

Companies and decision-maker requests get the same shape as social requests:

1. The customer's words become one typed **Ask**, by code.
2. Each provider tool is described by a **Tool Card**.
3. A **compiler** chooses the tools and the columns by code.

The company sheet carries:
- the name;
- the head office («المقر الرئيسي»);
- the company's **general e-mail**;
- the **HQ phone**.

The decision-maker sheet carries each person's **e-mail and mobile**.

A condition that no tool can send (for example «تأسست بعد ٢٠١٥») is never dropped and never used to remove rows. It becomes a **mark column** with «نعم», «لا» or «غير معروف».

Only **exact duplicates** are removed. «غير متوفر» is written only after **every relevant tool** has been tried. Every gap is written in the file.

While a request waits, the customer sees two things:
- its **position**;
- an **honest reason** («قبله طلبين لعملاء آخرين»).

A time is shown only if it was **measured**: the time the request has already waited, never a guess of the time left.

A job sends **one e-mail** only when the customer's measured wait was over one minute. This stays within Resend's 50,000 e-mails a month.

## 2. Flags (all OFF by default)

| Flag | Values | Default | Gates |
|---|---|---|---|
| `DIGER_STAGE3_COMPANIES` | `on`, `test` (test accounts only), anything else = off | **off** | the B2B Ask, cards and compiler on the planning path |
| `DIGER_STAGE3_QUEUE` | same | **off** | the new queue line (today's `queueLine` stays when off) |
| `DIGER_STAGE3_EMAIL_NOTICE` | same | **off** | the one-e-mail-per-job decision |

Read with `stage3Enabled(flag, isTestAccount)` (`src/lib/agentMission/stage3/flags.ts`). No existing switch, flag or variable was changed. Nothing was set in Vercel, Heroku or Supabase.

## 3. Files

**New:**

| File | What |
|---|---|
| `src/lib/agentMission/stage3/flags.ts` | the three flags |
| `src/lib/agentMission/stage3/b2bAsk.ts` | `B2BAsk`, `buildB2BAsk`, `b2bConditionLabelAr` |
| `src/lib/agentMission/stage3/b2bCards.ts` | `B2BCard`, `B2B_CARDS` (19 cards, 6 verified), `UNVERIFIED_B2B_CARDS`, `b2bCardsFor`, `readB2BRows`, `checkB2BCardOnPage` |
| `src/lib/agentMission/stage3/b2bCompile.ts` | `compileB2BPlan`, `markCellAr`, `removeExactDuplicates`, `resolveField`, `fillColumn`, `gapLineAr` |
| `src/lib/agentMission/stage3/b2bDelivery.ts` | (Sonnet session) `buildB2BDelivery`: the contact cells by the fallthrough, mark columns, exact duplicates only, gap and mark lines |
| `src/lib/agentMission/stage3/queueView.ts` | (Sonnet session) `stage3QueueOn` (only «on» on the site), `queueLineV2` |
| `src/lib/agentMission/stage3/queue.ts` | `queueStateOf`, `queueLineAr`, `waitedAr` |
| `src/lib/agentMission/stage3/emailTrigger.ts` | `emailDecision`, `shouldNotifyByEmail`, `measuredWaitMs` |
| `tests/stage3-b2b-ask.test.ts`, `tests/stage3-b2b-cards.test.ts`, `tests/stage3-b2b-compile.test.ts`, `tests/stage3-queue-email.test.ts`, `tests/stage3-isolation.test.ts` | red-then-green tests |
| `docs/STAGE-3.md` | this file |

**Changed:** none. All new types are in new files, so there is no rebase point with the Stage 2 and Stage 4 branches.

## 4. Data shapes and contracts

### 4.1 Ask (`b2bAsk.ts`)

```ts
B2BAsk = {
  kind: "companies" | "companies_people" | "people";
  companies: number | null; peoplePerCompany: number | null; people: number | null;
  sector: string[];            // entities.ts sectorWordsOf
  country: string | null;      // places.ts countryOfValue: a country or city NAMED («في مصر»); a nationality word alone is not read (golden G1 guard), see decision 6
  roles: "decision_makers" | null;
  fields: { companyEmail; hqPhone; personEmail; personMobile };   // company columns always for companies; e-mail + mobile for people
  conditions: Array<{ kind: "size_min" | "size_max" | "founded_after" | "founded_before"; value: number }>;
  budget: number | null;       // countChoice.ts budgetOfWords
}
buildB2BAsk(text) -> B2BAsk | null        // null: not a companies / decision-makers request
```

### 4.2 Tool Cards (`b2bCards.ts`)

```ts
B2BCard = { endpointId; role; status: "verified" | "unverified" | "broken"; carries: ("sector"|"country"|"size"|"founded"|"title")[];
            needs: ("domain"|"company_linkedin"|"person_name"|"person_linkedin"|"company_name")[];
            page: { list: path | null; cursor: path | null };
            reader: { kind: "list"; fields } | { kind: "found_email" } | { kind: "found_phone" } | { kind: "company_mailbox" };
            costUsd; costUnit; verifiedOn: { mission; calls }[]; note }
roles: companies.search, company.people, people.search, person.email, person.phone, company.emails, company.phone
b2bCardsFor(role, { allowUnverified?, cards? })   // verified only by default; cheapest first; never a broken card
```

- Lookup readers reuse the shared readers of `contactFinders.ts` (`foundContactIn`, `companyMailboxIn`).
- Prices and list paths are the catalog's (`data/treg`); a test checks them against the catalog.

### 4.3 Compiler (`b2bCompile.ts`)

```ts
compileB2BPlan(ask, { allowUnverified?, cards? }) ->
  { ok: true; companiesCard; peopleCard; columns: { company: B2BColumn[]; person?: B2BColumn[] }; marks: B2BMark[];
    chains: { general_email: id[]; hq_phone: id[]; email: id[]; mobile: id[] }; unverified: id[] }
| { ok: false; reason: "no_verified_card"; role; unverified }
```

- **Tool choice:** the card that carries the most of the Ask's conditions wins, then the cheapest.
- **Company columns:** م، اسم الشركة، النشاط والتخصص، الموقع الإلكتروني، **المقر الرئيسي**، الإيميل العام للشركة، هاتف المقر الرئيسي، [marks]، ملاحظات. These are the reference titles of `taskContracts.ts`, plus the HQ.
- **People columns:** م، اسم صانع القرار، المسمى الوظيفي، (اسم الشركة for a people-only request)، صانع قرار، إيميل المسؤول المباشر، هاتف / محمول المسؤول، ملاحظات.
- **Marks:** a condition the chosen companies card does not carry becomes a mark column. `markCellAr(condition, row)` returns «نعم» / «لا» / «غير معروف» from the row's `employees` (a number or a range such as «51-200» or «1000+») or `founded`. **A row is never removed.**
- **Chains:** the chosen search's own field comes first (when it has one), then every lookup of the role, cheapest first.
- **Fallthrough** (`resolveField(chain, attempts)`):
  - a cell takes the value of the earliest tool in the chain that gave one;
  - «غير متوفر» is written only when **every** tool answered empty or failed;
  - a tool that was not tried, or was `refused` (daily cap, budget, time), gives «لم يكتمل البحث» (`incomplete`), never «غير متوفر».
- **Exact duplicates** (`removeExactDuplicates`): a row is removed only when an earlier row has exactly the same values (strings compared without their outer spaces). There is no fuzzy matching.
- **Gap line** (`gapLineAr`), for example: «الإيميل العام للشركة: وُجد لشركتين من ٥ شركات، وغير متوفر لشركتين بعد تجربة ٣ مصادر، ولم يكتمل البحث لشركة واحدة.» It never names a provider.

### 4.4 Queue (`queue.ts`)

```ts
queueStateOf({ status, queue: QueueInfo (customerView.ts), queuedAtMs: number | null, nowMs }) -> { position; reason; measuredWaitMs | null; ahead; aheadOwn } | null
QUEUE_REASONS = starting_now | behind_own | behind_others | behind_both | service_paused
queueLineAr(state) -> one fixed sentence per reason [+ « ينتظر طلبك منذ X.» only when measured]
```

`measuredWaitMs` is `now - queuedAt`, taken from the stored time the request entered the queue (approval). A missing time, or one in the future, gives null. When the wait was not measured, the line has no time word at all (a test checks this).

### 4.5 E-mail decision (`emailTrigger.ts`)

```ts
emailDecision({ status, approvedAtMs, finishedAtMs, alreadyEmailed, emailable, sentThisMonth }) -> { send; reason; waitMs }
reasons: waited_long (send) | not_finished | wait_not_measured | already_emailed | not_emailable | short_wait (≤ 60 s) | quota_unknown | monthly_limit (≥ 50,000)
```

## 5. Tool Cards: six verified on real pages, thirteen still unverified

**Verified (Sonnet session, S1).** The first real company and decision-maker pages are in the repo (`tests/fixtures/live/missions/msn_4969a50fed8c45b37d8f` and `msn_7539ea17512cf58aa0e7`, 87 raw pages, anonymised). A stored page does not name its tool, so each page was **attributed to its tool by shape**, and the attribution is tested (`tests/stage3-b2b-real-pages.test.ts`): the page's top-level keys equal that endpoint's own catalog example and no other endpoint in the whole catalog has them. The maps pages share a generic wrapper with 84 endpoints, so they are matched by item fields instead (the 15 observed fields equal the catalog's 15; the next closest endpoint is 0.45). `verifiedOn` is **derived from the stored pages by the test**, never typed by hand.

| Card | Role | Real pages | What the real pages showed |
|---|---|---|---|
| `tomba.companies.search.reveal` | companies.search | 4 (50 companies each) | maps with no issue. The page echoes `meta.filters`: a **country** and an **industry** filter were sent, **no size**. `phone_number` is the **boolean «false» on all 200 companies** (a flag, never a number). `company_size` and `founded` are text |
| `aviato.companies.employees` | company.people | 6 (5 to 10 people each) | the guessed paths `person.fullName` and `positionList[0].title` were right |
| `blitzapi.people.employee-finder` | company.people | 8 | maps with no issue; some answers are empty (no result). It carries country and job level, and gives the person's profile link |
| `crawl4ai.google.serp.maps` | company.phone | 4 (one place each) | the phone is text |
| `blitzapi.people.email.find` (new card) | person.email | 18 | **4 found, 14 not found**. Takes the person's profile link |
| `blitzapi.people.phone.find` (new card) | person.phone | 18 | **2 found, 16 not found**. Takes the person's profile link |

Two corrections the real pages forced (they are in the green commit):
1. The tomba card mapped `phone_number` as the HQ phone, which would have written `false` into the HQ-phone column. The card no longer maps it, and the verifier now reports «a contact field holds a non-text value» for any contact column (HQ phone, general e-mail, e-mail, mobile) whose value is not text.
2. The tomba card claimed it carries a **size**. Nothing shows that, so it now claims only sector and country, and a size condition becomes a **mark column**.

The people's values in the stored pages are placeholders, so the finders' value path is tested by putting a made-up value at the page's **own** key (the real structure, a fake value).

**Still unverified (13): no stored page.** Never offered to a customer: `icypeas.companies.search`, `blitzapi.companies.search`, `aviato.companies.search`, `treg.people.search`, `icypeas.people.search`, `treg.people.email.find`, `tomba.people.email.find`, `hunter.people.email.find`, `treg.people.phone.find`, `aiark.people.phone.find`, `tomba.people.phone.find`, `tomba.companies.emails.list`, `anyapi.google.serp.maps`.

**Pages in the two missions that no card covers (left alone, listed for the strong model):**
- 16 pages with `code, data, message, meta, success` and `data: []` (an empty answer from a lookup tool), and one (`msn_4969a50fed8c45b37d8f/raw/call_0018.json`) whose `data` has `employee_phone`, `company_phone`, `email` ...: the tool is **not identified** (the top-level keys do not match one catalog example).
- 6 pages with `results` and `telephone_number` fields: a phone **validator** family (three catalog endpoints share the shape). Validators are not a card role yet.
- 2 pages with `output.data` (`msn_7539ea17512cf58aa0e7/raw/call_0013.json` and `call_0018.json`) and 2 pages with `error`, `error_code`: not identified.
- `msn_4969a50fed8c45b37d8f/raw/call_0004.json` (`count, items, pages, totalResults`, an empty list) and `call_0005.json` (`errors, message, success`): not identified.

**The attribution by shape is an inference, not a call log.** Decision 7 below asks for the one read-only query that settles it (`endpoint_id` per call, no personal data).

## 6. Acceptance tests (fixtures named)

| Test | Fixture | Proves |
|---|---|---|
| `stage3-b2b-ask.test.ts` | the live request of `msn_7539ea17512cf58aa0e7` (its words, already in `tests/limits-live-7539.test.ts`) | the Ask by code; flags off |
| `stage3-b2b-cards.test.ts` | the catalog snapshot `data/treg`; the social missions' call index | cards match the catalog's prices and list paths; a card is verified only with pages in `verifiedOn`; a customer path gets verified cards only; the verifier works on pages built from the card's own paths with fake values |
| `stage3-b2b-real-pages.test.ts` | `msn_4969a50fed8c45b37d8f`, `msn_7539ea17512cf58aa0e7` (87 raw pages) | S1: the attribution of pages to tools by shape; `verifiedOn` derived from the pages; each list card maps its real pages; tomba's `phone_number` is a boolean and no HQ phone is mapped; the filters the live call carried; the finders on the stored structure; the contact-field type rule; the plan for the live request compiles on verified cards alone |
| `stage3-b2b-delivery.test.ts` | `tests/fixtures/extraction/companies-electricity-eg.json` (fake) with made-up sizes and years; the real `buildMissionFiles` | S2/S4: the delivery builder (exact duplicates only, fallthrough cells, «لم يكتمل البحث» for a refused call, mark cells, the lines); the lines reach the summary's «حدود هذا التسليم»; without the option the file is identical; no row is lost |
| `stage3-queue-view.test.ts` | the in-memory database helper | S5: the flag (only «on»), the new line for every reason, no time word when the approval time is missing, flag off equals today's `queueLine` for every shape and status, `approved_at` read only when the flag is on |
| `fixtures-anonymised.test.ts` | all 39 missions (769 files) | the privacy scan, extended with the two anonymiser rules |
| `stage3-b2b-compile.test.ts` | `tests/fixtures/extraction/companies-electricity-eg.json` (already committed, clearly fake: `example.eg`) | column plan; no verified card means no plan; mark columns; exact duplicates only; fallthrough and «غير متوفر» only after every tool; gap lines pass the customer-text rules |
| `stage3-queue-email.test.ts` | none (pure) | the queue's reasons and positions, no unmeasured time, the measured-time line; the e-mail decision's eight outcomes |
| `stage3-isolation.test.ts` | the repo's sources | only the two wiring files (`customerView.ts`, `customerActions.ts`) import a `stage3/` module, and each reads the flag first |

**Replay of the two real missions' plans (FOUNDATION-PLAN PR 5 acceptance): not done.** The stored pages are in the repo now, but the real plans, the file columns of the two missions and the call log (which tool each call used) are not, and the planning wiring (S3) is not built, so there is nothing to compare a compiled plan with. What is proven on the real pages is in the `stage3-b2b-real-pages.test.ts` row above. Two facts the acceptance text did not expect: the stored delivered rows of both missions have **no general e-mail and no HQ phone column** (the owner's reference sheet has them), and the HQ phone from the companies page is **never filled** (`phone_number` is `false` everywhere).

## 7. Done by Opus

1. The B2B Ask (new types, new file).
2. 17 B2B Tool Cards from the catalog, all honestly unverified, with a verifier and readers.
3. The compiler core: tool choice, column plan (general e-mail, HQ phone, HQ, people with e-mail and mobile), marks, exact-duplicate removal, the fallthrough chains, gap lines.
4. The queue model with whitelisted lines.
5. The pure e-mail decision.

## 8. Left for Sonnet (step by step)

### 8.0 Status after the Sonnet session (branch rebased on `main` = `4aae39a`)

| Step | Status | What was done | Why not (if skipped) |
|---|---|---|---|
| A: fixtures | done | the two anonymised missions (91 files, copied byte for byte from the owner's ZIP), the two anonymiser rules, the scan test (39 missions, 769 files) | |
| S1: verify cards | **done** | six cards verified, two corrections, one new verifier rule, two new cards (section 5) | |
| S2: gaps and marks in the file | **done at the file level** | `buildMissionFiles` accepts `extraLimitLines` (nothing passes it yet); `buildB2BDelivery` writes the lines and the mark cells | the call from the real finalize waits for S3 and the engine part of S4 (there is no B2B plan to deliver yet) |
| S3: planning wiring | **skipped** | | it needs more than mapping: the companies plan is built by the model's `propose_plan` and every stage carries an engine recipe (endpoint, params, cursor, map code, parent binding, per-parent limits, contact steps). Building that from a compiled B2B plan is the same work the social compiler does, in the pipeline the doc says to leave for the strong model. No stored real companies plan exists to compare with |
| S4: engine fallthrough | **core done, engine skipped** | `buildB2BDelivery`: `fillColumn`, `removeExactDuplicates`, «لم يكتمل البحث» for a refused call, tested | recording each real lookup as an `Attempt` means changing `agent/src/engine/contacts.ts`, which already has its own finder chain, budget stops and «غير متوفر» rule (written only for cells that were asked). Replacing it is a live-pipeline change |
| S5: queue line | **done** | `queueView.ts`, a flag-gated pass-through in `customerView.ts` and `customerActions.ts` | |
| S6: e-mail trigger | **skipped, as the doc says** | | it waits for the owner's approval of the template in `src/functions/**` (decision 3) |
| S7: wording | **done** | the gap line (§ below), «طلبًا واحدًا» after «لأن قبله» | |

**What changed in S5, exactly.** `customerMissionView` has a new optional input `stage3Queue`; when absent (always, today) the line is `queueLine`'s, untouched. `loadCustomerMission` reads `approved_at` and passes `stage3Queue` **only when `DIGER_STAGE3_QUEUE` is exactly `on`**; otherwise its select is the same string as before. On the site `test` does not turn the flag on, because the site cannot know a test account (the guard `tests/admin-calls-log.test.ts` keeps that rule out of customer code), so a test-account preview needs `on`, or a worker-written marker like Stage 2's. The new line says the position, the reason and, only when `approved_at` is stored and in the past, `ينتظر طلبك منذ ...` (the time already waited, never the time left); a request that is only `queued` has no approval yet and never shows a time.

**What changed in S7.** (1) The gap line: when nothing was found it said «لم يوجد لأي شركة من ٥ شركات، وغير متوفر ...», which claims a negative answer even when no source ran. It now says «غير متوفر لكل الشركات (٥ شركات) بعد تجربة ٣ مصادر» when every source was tried, and «لم يكتمل البحث لكل الشركات (٥ شركات)» when none ran to the end. (2) After «لأن قبله» the counted noun is accusative: «طلبًا واحدًا», «طلبين», «٣ طلبات». The mark titles of `b2bAsk.ts` were read and left as they are.

**For the next session, S3 and the engine part of S4, in this order:**
1. Confirm the page-to-tool attribution with the one query in decision 7.
2. Planning: build the companies plan from `compileB2BPlan` the way `compilePlan` builds a social plan (stages with a recipe from the card, `cardMapCode`-style map code for the B2B cards, the people stage bound to the company's website or profile link, contact steps from the chains). Flag `DIGER_STAGE3_COMPANIES`, test accounts first.
3. Engine: record every lookup's outcome per row and column as an `Attempt`, then call `buildB2BDelivery` and pass its `limitLines` to `buildMissionFiles` as `extraLimitLines`.
4. The people sheet (decision-maker mark, per-person e-mail and mobile, per-person gaps) is not in `buildB2BDelivery` yet.


**S1. Verify cards on real pages (needs decision 1 first).**
1. When the owner adds the anonymised raw pages of `msn_7539ea17512cf58aa0e7` / `msn_4969a50fed8c45b37d8f` under `tests/fixtures/live/missions/<id>/raw/`, use `tests/fixtures/live/anonymise.py`, the same rule as the social fixtures.
2. For each tool those missions called, add a test that runs `checkB2BCardOnPage(card, page)` with no issues.
3. Fix the card's paths if needed.
4. Set `status: "verified"` and `verifiedOn: [{ mission, calls }]`.
5. Extend `tests/fixtures-anonymised.test.ts` to the new files.
6. Only data and tests change in this step. If the compiler itself has to change, that goes back to the strong model.

**S2. Gaps and marks in the file.**
1. In the B2B finalize wiring, write each `gapLineAr(...)` line into the methodology's «حدود هذا التسليم».
2. Write each mark column's cells with `markCellAr`.
3. Test with fake rows that the gap line appears in the summary sheet and that no row count changes.

**S3. Planning wiring (behind `DIGER_STAGE3_COMPANIES`).**
1. In the companies planning entry (`agent/src/tools.ts` `propose_plan`, which prices through `validateAndPricePlan` in `src/lib/agentMission/plan.ts`), add a flag-gated branch: `buildB2BAsk` → `compileB2BPlan`.
2. If `ok: false`, keep today's path. A customer never gets an unverified card.
3. Map `columns` and `chains` onto the existing `PricedStage` shape. Reuse `withContractColumns` (`taskContracts.ts`) and `buildCompanySteps` / `buildContactSteps` (`contactFinders.ts`, called from `validateAndPricePlan`): the chain order becomes the steps' finder order.
4. Price only with the existing pricing functions (read only).
5. This step touches the planning pipeline. If it needs more than mapping, stop and leave it for the strong model.

**S4. Engine fallthrough.**
1. Record each lookup's `Attempt` (`value` / `empty` / `failed` / `refused`) per row and column.
2. Write the cell with `fillColumn`.
3. Remove only `removeExactDuplicates` rows.
4. Test on a fake world (`tests/helpers/agentFakeWorld.ts` style) that a refused call gives «لم يكتمل البحث», not «غير متوفر».

**S5. Queue UI (behind `DIGER_STAGE3_QUEUE`).**
1. In `customerView.ts` `customerMissionView`, when the flag is on for the viewer, set `queueLineAr` from `queueLineAr(queueStateOf({ status, queue, queuedAtMs: Date.parse(mission.approved_at), nowMs }))`. `approved_at` is already stored on the mission row; read it if it is not in `MissionRowForCustomer` yet.
2. Keep today's `queueLine` when the flag is off.
3. Test that the line never has a time word when `approved_at` is missing.

**S6. E-mail trigger (behind `DIGER_STAGE3_EMAIL_NOTICE`). Only after the owner approves the `src/functions/**` change (decision 3).**
1. At finalize, build `EmailJobFacts`:
   - `approvedAtMs` and `finishedAtMs` from the mission row;
   - `alreadyEmailed` from an immutable storage marker `notices/email_sent.json` in the mission folder (create-only, so it can never be sent twice);
   - `emailable` from `userWillBeEmailed`;
   - `sentThisMonth` from the count of decision 4.
2. Call the existing sender `sendMissionNotice` only when `emailDecision(...).send` is true.
3. Write the marker first, then send.

**S7. Wording review** of the fixed sentences in `queue.ts`, `b2bCompile.ts` (gap lines) and `b2bAsk.ts` (mark titles).

## 9. Needs change in a locked file (not done here)

- **`src/functions/**` (forbidden): the e-mail template.** Proposal, for the owner's explicit go only:
  - Subject: «ملفك جاهز: <عنوان الطلب>».
  - Body: «انتهينا من طلبك "<نص الطلب مختصرًا>". سلّمنا <X من N> <الاسم>. الملف جاهز للتنزيل من صفحة طلباتك: <رابط>. لم يُخصم منك إلا ما سُلّم.»
  - Arabic only, Arabic-Indic numerals, no provider name, no USD.
  - Sent at most once per job (marker of S6).
- **`src/app/dashboard/chat/page.tsx` and its routing:** if the queue line should show inside the chat, the chat page renders `queueLineAr` from the mission view (it already does through `AgentMissionCard`, so likely no change is needed).
- No other locked file is needed.

## 10. Open decisions for the owner

1. **DONE: real B2B pages for verification.** (kept for the record) Download the raw pages of `msn_7539ea17512cf58aa0e7` and `msn_4969a50fed8c45b37d8f` (PR 1 admin ZIP), anonymise them on your device with `anonymise.py`, and commit them. Without this, every B2B card stays unverified and Stage 3 cannot go to customers. Recommended: yes.
2. **Unverified cards for test accounts?** The social rule (decision 7.4) allows `catalog_only` cards for test accounts within a dollar cap. Should B2B do the same, to collect the first real pages? Recommended: yes, test accounts only, with a cap per mission.
3. **The e-mail template in `src/functions/**`** (section 9). Explicit go needed.
4. **How the monthly e-mail count is known.** Options: the Resend usage endpoint, or a count of stored markers. Until a count exists, `quota_unknown` sends nothing. Proposal (no migration written): either a small table `email_notices(job_id primary key, sent_at)`, or count the `notices/email_sent.json` markers per month. Recommended: the markers (no schema change).
5. **The measured wait for the e-mail:** approval to finish (as here), or queue entry to start. Recommended: approval to finish (what the customer actually waited).

6. **A nationality word as the search's country** («شركات مصرية»). The existing guard `tests/golden-r2-request-country-not-a-filter.test.ts` (G1) allows `countryOfRequestText` only in the company-phone step, so the B2B Ask reads only a NAMED country or city. Should a nationality word set the companies search's country INPUT (a request to the source, never a row rule)? If yes, the guard's list must be extended by that one file, with its own test. Recommended: yes, as an input only.

**New, found in the Sonnet session:**

7. **Confirm which tool each stored call used.** The two missions' call log is not in the repo, so the pages were attributed by shape (section 5). One read-only query settles it with no personal data: `select id, endpoint_id, status, rows_returned from mission_calls where mission_id in ('msn_4969a50fed8c45b37d8f','msn_7539ea17512cf58aa0e7') order by id`. Recommended: run it once and add the result to `call-index.json` the way the social missions' calls are.
8. **The queue flag on the site.** Only `on` works (the site cannot know a test account). Should a test account see the new line first? Recommended: a worker-written marker like Stage 2's, in the next session.
9. **HQ column.** The owner's reference sheet (`OWNER_SHEET_HEADERS_AR`) has no «المقر الرئيسي» column and the Stage 3 brief asks for one: the compiled company sheet has it between the website and the general e-mail. FOUNDATION-PLAN PR 5 says the compiled columns equal the reference in order. Recommended: keep the HQ column and change the acceptance wording.
10. **The general e-mail has no verified tool.** `tomba.companies.emails.list` and the other listers have no stored page, so today the column would say «لم يكتمل البحث» for every company. Recommended: run one verified-pages round for a lister on a test account.
11. **Low finder yields, measured on the real pages.** E-mail 4 found of 18, phone 2 of 18, and the companies tool gives no HQ phone. The product rule (every tool tried before «غير متوفر») is what makes these gaps honest; a better source would help more than a rule.
12. **For the strong model: ranking with the unverified switch.** With `allowUnverified`, `compileB2BPlan` ranks by the conditions a card CLAIMS, so an unverified card with a still-unproven claim (`blitzapi.companies.search` claims size) outranks the verified tomba card. No customer path can reach it. Recommended: rank verified cards first when the switch is on.
13. **Likely rebase point with the Stage 2 draft (#369).** Both change the top of `buildMissionFiles` in `agent/src/workbook.ts`: Stage 2 moves the first steps into `deliveredSheetsOf`; this branch adds `extraLimitLines` (an option and four lines after the contract step). The conflict is mechanical.


## 11. Verified facts vs assumptions

- **Verified by tests:** section 6. The catalog prices and list paths match `data/treg`. Six cards map their real pages; the findings of section 5 are read from the stored pages.
- **Inference, not verified:** which tool produced each stored page (by shape and the catalog's own examples; decision 7).
- **Assumptions still standing** (marked GUESS in the cards): the filter inputs of blitzapi's companies search carry size; none is used on a customer path.
- **Privacy scan of the two missions before they were committed** (counts only, never values): 0 e-mail addresses, 0 phone-like values, 0 person-profile links, every name-like field a placeholder or empty, every LinkedIn and website host replaced by `host-<hex>.invalid`, every URL path segment a hash or an id; what stays is company-level (ids and counters, the company domains used as ids, dates, country codes, provider error codes). The repo's own scan then passes on all 39 missions.
- **Not measured:** the load of the new queue line (it is one extra column in a select that already runs on every mission read, only with the flag on).
- **Read-only SELECT queries run for this stage:** none.