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
| `src/lib/agentMission/stage3/b2bCards.ts` | `B2BCard`, `B2B_CARDS` (17 cards), `UNVERIFIED_B2B_CARDS`, `b2bCardsFor`, `readB2BRows`, `checkB2BCardOnPage` |
| `src/lib/agentMission/stage3/b2bCompile.ts` | `compileB2BPlan`, `markCellAr`, `removeExactDuplicates`, `resolveField`, `fillColumn`, `gapLineAr` |
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

## 5. Unverified Tool Cards (all 17: excluded from every customer path)

No stored real page of a B2B tool exists in the repo. The 36 stored missions in `tests/fixtures/live/missions` are all social (verified by a test). So every card is `unverified`, with an empty `verifiedOn`:

| Role | Cards (cheapest first) |
|---|---|
| companies.search | `tomba.companies.search.reveal`, `icypeas.companies.search`, `blitzapi.companies.search`, `aviato.companies.search` |
| company.people | `blitzapi.people.employee-finder`, `aviato.companies.employees` |
| people.search | `treg.people.search` (list path unknown), `icypeas.people.search` |
| person.email | `treg.people.email.find`, `tomba.people.email.find`, `hunter.people.email.find` |
| person.phone | `treg.people.phone.find`, `aiark.people.phone.find`, `tomba.people.phone.find` |
| company.emails | `tomba.companies.emails.list` |
| company.phone | `crawl4ai.google.serp.maps`, `anyapi.google.serp.maps` |

Guesses are marked in each card's `note`. They are:
- the `filters` / `company` inputs of tomba and blitzapi carrying size;
- the nested paths of `aviato.companies.employees`.

## 6. Acceptance tests (fixtures named)

| Test | Fixture | Proves |
|---|---|---|
| `stage3-b2b-ask.test.ts` | the live request of `msn_7539ea17512cf58aa0e7` (its words, already in `tests/limits-live-7539.test.ts`) | the Ask by code; flags off |
| `stage3-b2b-cards.test.ts` | the catalog snapshot `data/treg`; `tests/fixtures/live/missions` (36, all social) | cards match the catalog's prices and list paths; all unverified; customer paths get none; the verifier works on pages built from the card's own paths with fake values |
| `stage3-b2b-compile.test.ts` | `tests/fixtures/extraction/companies-electricity-eg.json` (already committed, clearly fake: `example.eg`) | column plan; no verified card means no plan; mark columns; exact duplicates only; fallthrough and «غير متوفر» only after every tool; gap lines pass the customer-text rules |
| `stage3-queue-email.test.ts` | none (pure) | the queue's reasons and positions, no unmeasured time, the measured-time line; the e-mail decision's eight outcomes |
| `stage3-isolation.test.ts` | the repo's sources | no production file imports a `stage3/` module |

**Not possible here (real replay):** FOUNDATION-PLAN PR 5 asks for replays of `msn_7539ea17512cf58aa0e7` and `msn_4969a50fed8c45b37d8f` on their raw pages. Those pages are in the owner's ZIP, not in the repo. They hold personal data (names, e-mails, phones), so they must be anonymised before they are committed (see decision 1). No fixture was redacted or added in this branch.

## 7. Done by Opus

1. The B2B Ask (new types, new file).
2. 17 B2B Tool Cards from the catalog, all honestly unverified, with a verifier and readers.
3. The compiler core: tool choice, column plan (general e-mail, HQ phone, HQ, people with e-mail and mobile), marks, exact-duplicate removal, the fallthrough chains, gap lines.
4. The queue model with whitelisted lines.
5. The pure e-mail decision.

## 8. Left for Sonnet (step by step)

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

1. **Real B2B pages for verification.** Download the raw pages of `msn_7539ea17512cf58aa0e7` and `msn_4969a50fed8c45b37d8f` (PR 1 admin ZIP), anonymise them on your device with `anonymise.py`, and commit them. Without this, every B2B card stays unverified and Stage 3 cannot go to customers. Recommended: yes.
2. **Unverified cards for test accounts?** The social rule (decision 7.4) allows `catalog_only` cards for test accounts within a dollar cap. Should B2B do the same, to collect the first real pages? Recommended: yes, test accounts only, with a cap per mission.
3. **The e-mail template in `src/functions/**`** (section 9). Explicit go needed.
4. **How the monthly e-mail count is known.** Options: the Resend usage endpoint, or a count of stored markers. Until a count exists, `quota_unknown` sends nothing. Proposal (no migration written): either a small table `email_notices(job_id primary key, sent_at)`, or count the `notices/email_sent.json` markers per month. Recommended: the markers (no schema change).
5. **The measured wait for the e-mail:** approval to finish (as here), or queue entry to start. Recommended: approval to finish (what the customer actually waited).

6. **A nationality word as the search's country** («شركات مصرية»). The existing guard `tests/golden-r2-request-country-not-a-filter.test.ts` (G1) allows `countryOfRequestText` only in the company-phone step, so the B2B Ask reads only a NAMED country or city. Should a nationality word set the companies search's country INPUT (a request to the source, never a row rule)? If yes, the guard's list must be extended by that one file, with its own test. Recommended: yes, as an input only.

## 11. Verified facts vs assumptions

- **Verified by tests:** section 6. The catalog prices and list paths match `data/treg`.
- **Assumptions** (marked GUESS in the cards): the filter inputs of tomba and blitzapi carry size; the nested employee paths of aviato. None of them is used on a customer path.
- **Read-only SELECT queries run for this stage:** none.
