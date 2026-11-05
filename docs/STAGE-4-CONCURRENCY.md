# STAGE 4, STAGE E: concurrency and database safety of the add-on requests and their approval

**Status: analysis and tests only. No migration was written or applied. Nothing under `supabase/` was changed. No existing source, test or document was edited. No SQL of any kind was run, no database was contacted, no flag was set.** Every test uses fake clients (a stateful `missions` table with a primary key and compare-and-set updates, the hardened money fake `tests/helpers/agentMoney.ts`, a read-only fake bucket). The proposed index was modelled, not run: **a disposable local Postgres was NOT available** in this environment (no `postgres`/`initdb` binaries; the `docker` CLI exists but has no daemon), and no tool was installed. The local-pg tests of `tests/sql/` skip without `DIGR_TEST_PG`; none was added here because a skipped test proves nothing.

> **UPDATE (financial safety round, docs/STAGE-4-FINANCIAL-SAFETY.md):** the statements below that say «no local PostgreSQL was available», «the migration is not written» and «`approveAddonOnce` ignores the error of its last update» are now historical. The server binaries WERE available (`/usr/lib/postgresql/16/bin`); the index was **prepared** as `supabase/migrations/20261104222136_one_open_addon_per_file.sql` (NOT applied) and verified on a disposable local PostgreSQL 16 (51 checks); the last update is now proved by a read-back (Fix A); the stuck request is recovered (Fix C); the charged-but-unpublished review blocks a second paid review (Fix B). The risks that remain are listed in section 4 of that document.

Evidence lives in three new test files and one helper:

| File | What |
|---|---|
| `tests/helpers/scheduledWorld.ts` | the scheduled world: one shared `missions` table (PK, compare-and-set), optional model of the proposed index, the money fake behind `rpc`, a scheduler that picks which pending atomic step runs next, and `explore` that walks EVERY order of the steps |
| `tests/stage4-concurrency-requests.test.ts` (24) | scenarios 1, 2, 4, 5, 10: the real `createReviewRequest`, `createEditRequest`, `currentReviewRequest`, `currentEditRequest`, `reviewQuoteFor` |
| `tests/stage4-concurrency-approval.test.ts` (27) | scenarios 3, 6, 7, 8, 9: the real `approveAddonOnce`, `settleAddon`, `cancelReviewRequest`, `createReviewRequest` |
| `tests/stage4-concurrency-index-model.test.ts` (19) | the proposed partial unique index on the same world |

A test whose name starts with «DOCUMENTED UNRESOLVED RISK» shows an end state that exists TODAY, on purpose; it passes because the risk is real. None is skipped and no existing assertion was weakened.

---

## 1. The ten scenarios

Severity: **MONEY** = money can be held, double-reserved or charged wrongly; **MONEY-ADJACENT** = the product rule that protects money is broken but each ledger stays sound; **UX** = the customer is told something wrong or is blocked, no money lost.

The money invariant checked on every end state: ledger ids unique; at most one `res_` per job; `rel_`/`chg_` only after a settlement; a charge never above its reserve; the balance never negative.

| # | Scenario | What happens today | Evidence | Residual risk | Severity |
|---|---|---|---|---|---|
| 1 | Two simultaneous review requests | The same version twice: one id, one row, both told ok, exactly one «created». Two versions: exactly one stays open in every order (the creator protocol: insert, read again, cancel unpaid duplicates, lowest id stays). | requests: «SCENARIO 1» (every order) | **A creator can be told «ready» and a moment later its request is cancelled by the other creator's repair** (two tabs, the same instant). The page then shows the request that stays. | UX |
| 2 | Review and edit racing | Same base version: the deterministic id collides (`attempt = 1 + all rows of the base`), the primary key decides, exactly ONE creator is told ok, the other `open_addon`, either kind can win. Different base versions: one open at the end. Same edit twice: one request; a different edit while one waits: refused. Old version vs latest: the old one is never made. | requests: «SCENARIO 2» | The same-base safety rests on both creators computing the same attempt number; if a row appears between their reads the ids differ and only the creator protocol protects (scenario 1's risk). | UX |
| 3 | Approval starting during another creation | A started request outranks every unpaid one: in every order exactly one request is open, a started request is never cancelled, money is held only if the approval won, and the new request never stays open next to a started one. | approval: «SCENARIO 3» | (a) When the approval LOSES it says «already approved»/«not ready» for a request that was cancelled (wrong sentence, right money state). (b) **`approveAddonOnce` does not check «no other add-on is open»**: with two open requests (scenario 5's end state) BOTH approvals succeed, two holds are reserved, two add-ons run on one file. Each job's ledger is sound. | (a) UX (b) MONEY-ADJACENT |
| 4 | Read failure after insert | The creator whose read failed withdraws its own unpaid row and reports a failure (503): at most ONE open request in every order, three pairs of creators tried. | requests: «SCENARIO 4» | None found while writes still work. | none |
| 5 | Complete database outage after insert | **Two open requests CAN remain on one file** (review/review and review/edit), until the next reader repairs them (the customer's page, or any creator before it refuses): exactly one stays (lowest id), nothing started is cancelled. Nothing is held by an unpaid row. | requests: «SCENARIO 5» (the repair is proved on every such end state) | Between the outage and the next reader both rows are approvable (see 3b). The repair is a protocol, not a constraint. | MONEY-ADJACENT |
| 6 | Failed approval with unknown money state | For each of six injected failures (create quote, accept, claim; before and after): the row goes back to «waiting» marked as approved-once; ONE retry converges on the same quote, job and ledger rows; the settlement charges once, never above the hold; a lost settlement answer retried charges once. The page does not show such a row as «nothing held», cancel is refused, a new request is blocked. | approval: «SCENARIO 6 and 8» (first six tests, then the page/cancel/blocked test) | (a) **If the retry never comes the watchdog releases the abandoned job (net zero), but the REQUEST stays «waiting» with an approval mark: it can be neither cancelled nor approved again (`claim_retry` for ever) and it blocks the file.** (b) An insufficient-balance refusal also leaves the approval mark, so the customer cannot cancel a request for which no money moved. | (a) UX + file blocked (b) UX |
| 7 | Repeated approval clicks | Two clicks, every order (42 orders: the second stops after one or two steps): exactly one approval, one set of three money calls, one reserve, the other click told «already approved». Five clicks, 300 random orders: one approval, one reserve. | approval: «SCENARIO 7» | None found. | none |
| 8 | Retry after a partially completed reservation | See 6. A quote that expired before the retry ends the request with no money moved (row cancelled, `quote_expired`) and the next request gets the next attempt number. A refused reserve writes nothing and the balance never goes negative. | approval: «SCENARIO 6 and 8» | **`approveAddonOnce` ignores the error of its LAST update (the one that records the job on the row).** If it fails after the hold, the customer is told «approved», the row is `approved` with NO job id, the worker ends it `failed` ("no hold") without releasing, and the hold stays until the watchdog frees it (job lease 6 h, plus the watchdog's 30 minutes). | **MONEY HELD (bounded, about 6.5 h)** |
| 9 | Cancellation racing with approval | In every order either the request is cancelled and NO money moved, or it is approved with one reserve and the cancel is refused (409 `changed`). A cancel never lands on a claimed row (the claim sets the approval mark first). With an approval that fails at the reserve: either cancelled-unmarked or waiting-marked, nothing held. | approval: «SCENARIO 9» | A creator whose list read was stale before a cancel computes the cancelled row's id again and is told «you have an open request» though none is open; asking again succeeds. | UX |
| 10 | Existing completed review reuse | A completed review of a version: a new review request is refused `review_exists` (free), the preview says `reuse`, no row is made, even with two creators at once. A completed review does not block an edit of the same version; after the edit the new version can be reviewed. Reading never creates a row. | requests: «SCENARIO 10» | **A review that was CHARGED but could not be published ends `failed` (`charged_not_published`, a job and a charge exist). `failed` does not block, so the customer can be offered and can approve a SECOND paid review of the same version.** `canCreateAddon` sees the status only. | **MONEY (customer pays twice for one version; the first charge stands for a manual refund)** |

---

## 2. Is database-level uniqueness REQUIRED before paid approval is enabled?

**YES, for `on` (every customer). For `test` (test accounts only) the approval guard of section 3 is the minimum and the index can follow.**

Reasoning, from the tests:

1. The creation protocol (read, insert, read again, cancel unpaid duplicates) is **a protocol over ordinary reads and writes**. Scenario 5 shows the end state with two open requests on every run of the model where a creator goes dark after its insert. It repairs itself only when someone reads next.
2. **Until that read happens, the two rows are approvable**, and `approveAddonOnce` (read in `src/lib/agentMission/addonSettlement.ts`) does exactly this and nothing about other rows: read the row; refuse unless `plan_ready` and the owner's; `checkAddon` (identity and price again); ONE compare-and-set `plan_ready -> approved` on THIS row; then `create_quote_atomic`, `accept_quote_atomic`, `claim_job_chunk`; then the record update. It never lists the file's other add-ons. The test «approveAddonOnce does NOT check…» shows both approvals succeed in every order: two holds, two started add-ons.
3. Money per job stays sound in that state (the ledger tests pass), and two edits on one base cannot both publish (the second finds `version_exists` and is released with no charge). So the exposure is not a double charge of one job but the **product rule «one open add-on per file» (decision D10) breaking while money is held**, plus the duplicate-paid-review and stuck-row findings above, which an index does not fix.
4. An index makes the end state unreachable at any step, with any failure (model: «WHAT THE INDEX GUARANTEES»: `maxOpen <= 1` after every step in every order, 400 random three-creator orders with and without a blackout) and removes the «told ready, then cancelled» risk of scenario 1 (the loser's insert is simply refused).

**What an approval route MUST do regardless of the index** (these are design requirements, NOT built; the route and `approveAddonOnce` are protected money paths):

1. Read `DIGER_STAGE4_REVIEW` / `DIGER_STAGE4_EDITS` FIRST; authenticate; check the owner (`expectUserId`).
2. **Before the claim, run `reconcileOpenAddons(store, of)` and refuse unless THIS request is the one that stays.** Modelled in the test «THE GUARD AN APPROVAL ROUTE MUST ADD»: at most one of two approvals succeeds in every order and the other request is cancelled unpaid.
3. Recover a request whose approval was attempted: converge (retry) while its job is live; if its job is `failed` (the watchdog released it) END the request (a status, a sentence) instead of answering `claim_retry` for ever. **Needs an owner decision** (what status, what sentence, does the customer get the points back automatically: they already did).
4. **Check the error of the final record update inside `approveAddonOnce`** (scenario 8). This is a change in a protected money file: **BLOCKED FOR OWNER APPROVAL.**
5. Refuse a new paid review of a version whose earlier review was charged (`charged_not_published`, or any `charged_points > 0`): the rule needs the row's charge columns, which `canCreateAddon` does not read. **BLOCKED FOR OWNER APPROVAL** (a change to the add-on rules and the row store).
6. Say the true thing when it loses to a cancel (UX).

---

## 3. The proposed migration (design only; NOT written, NOT applied)

The proposal of `docs/MONEY-PR-7A.md` section 17.5, reviewed:

```sql
create unique index missions_one_open_addon_per_file
  on public.missions ((plan->'addon'->>'of'))
  where plan ? 'addon' and status in ('queued','planning','needs_input','plan_ready','approved','executing');
```

**Review.**

- **Expression index on jsonb.** `plan->'addon'->>'of'` is built from immutable jsonb operators, so it is allowed as an index expression. `plan` is `jsonb` with a `CHECK (jsonb_typeof(plan) = 'object')` in the repository's table proposal (`docs/proposals/agent-worker/01_agent_tables.sql`); **the live table was not read**: confirm the type first (a `json` column has no `?`).
- **Predicate.** `plan ? 'addon'` is `jsonb_exists`, immutable, allowed in a predicate, but it differs from the key being present and non-null (`{"addon": null}` or an add-on object with no `of` matches the predicate and has a NULL key; NULLs are distinct in a unique index, so such a row escapes). **Recommend a predicate that is the key itself: `(plan->'addon'->>'of') is not null`.** It also avoids the `?` character, which some drivers read as a placeholder.
- **Status list.** The proposal lists the six open statuses (the code's `OPEN_STATUSES`). The repository's `CHECK` lists exactly ten statuses (the six, `completed`, `failed`, `unserved`, `cancelled`); the model test pins that the two lists together are all of them. **Recommend the deny-list** `status not in ('completed','failed','unserved','cancelled')`: a status added later then HOLDS the slot (the refusal is "you have an open request", safe) instead of silently freeing it (two requests, unsafe). Adding a status needs a `CHECK` change, which is the moment to review the index.
- **A started row holds the slot**, including the state `plan_ready` + approval mark + held money (model: «a STARTED request … keep the slot»). Rows that end (cancel, complete, fail, unserve) free it at once.
- **Interaction with the primary key.** Both refusals are `23505`; they differ by constraint name in the message (`"missions_pkey"` vs `"missions_one_open_addon_per_file"`; PostgREST returns it in `message`, **assumed, not run**). Today's store reports both as `duplicate: true`. **Verified on the model:** today's `createAddonRow` ALREADY answers a violation of the index correctly for the customer («open request», 409), because the page then finds no waiting request for the id it was given. **The change that would make it exact (specified, NOT made):** `AddonRowStore.insert` returns `{ ok: false, duplicate: true, by: "same_id" | "other_open" }` from the constraint name; `createAddonRow` handles `same_id` as today, and on `other_open` RE-LISTS the file's open add-ons and refuses with `open_addon` and the id of the one that stays, so the answer names a request that exists even if the engine's order of checking unique indexes ever differs (when the same click violates both, the engine reports the first index it checks; the model reports the primary key). Any other failure throws. Both files (`addonRow.ts`, `addonRowStore.ts`) are non-money.
- **The key.** `of` is the delivered mission's own id, written by `createAddonRow` through the service client only; the customer's column grants leave `plan` out (`docs/proposals/agent-worker/01_agent_tables.sql` line 7; **confirm on the live grants**), so a customer cannot forge the key.
- **Read benefit.** The customer-side list filter (`plan->addon->>of = …`) cannot use a partial index unless the query implies its predicate; the index is a guard, not a read optimisation. The table is small.

**Proposed statement (for the owner to read; not a file):**

```sql
-- PROPOSAL ONLY. NOT APPLIED. NOT A FILE UNDER supabase/.
create unique index if not exists missions_one_open_addon_per_file
  on public.missions ((plan->'addon'->>'of'))
  where (plan->'addon'->>'of') is not null
    and status not in ('completed','failed','unserved','cancelled');
```

**Evidence of the failure it prevents.** `tests/stage4-concurrency-requests.test.ts` «DOCUMENTED UNRESOLVED RISK» scenario 5 (two open rows remain) and the approval test showing both approvals succeed; the same walks on the index model never exceed one open row at any step (`tests/stage4-concurrency-index-model.test.ts`). The model fails on those assertions when the index is switched off (checked by a temporary copy of the test file, not committed).

**Required pre-migration checks (read-only query TEXT only, NOT run; the owner or a read-only session runs them first):**

```sql
-- 1. rows that would violate the index: MUST return zero rows
select plan->'addon'->>'of' as of, count(*) as open_rows, array_agg(id order by id) as ids, array_agg(status order by id) as statuses
from public.missions
where (plan->'addon'->>'of') is not null and status not in ('completed','failed','unserved','cancelled')
group by 1 having count(*) > 1;
-- 2. add-on rows that would ESCAPE the key (should be zero)
select id, status from public.missions where plan ? 'addon' and (plan->'addon'->>'of') is null;
-- 3. the live column type and the live status CHECK (must match the repository's proposal)
select data_type from information_schema.columns where table_schema = 'public' and table_name = 'missions' and column_name = 'plan';
select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.missions'::regclass and contype = 'c';
-- 4. the name is free, and the table is small
select indexname from pg_indexes where schemaname = 'public' and tablename = 'missions';
select count(*) from public.missions;
-- 5. customers cannot write the plan (expect no insert or update privilege for these roles on the column)
select grantee, privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name = 'missions' and column_name = 'plan' and grantee in ('anon', 'authenticated');
-- 6. requests that were approved once and are `plan_ready` again, with no job: their money state needs a person
select id, status, approved_at, job_id from public.missions where (plan->'addon'->>'of') is not null and status = 'plan_ready' and approved_at is not null;
-- 7. open add-on rows whose job already ended (the stuck rows of scenario 6)
select m.id, m.status, j.status as job_status from public.missions m join public.jobs j on j.id = m.job_id where (m.plan->'addon'->>'of') is not null and m.status not in ('completed','failed','unserved','cancelled') and j.status in ('failed','completed');
```

If check 1 returns rows, **repair first with the existing protocol** (cancel the unpaid duplicates, lowest id stays; never touch a started or marked row). A pair that includes a started row needs a person. Building the index over violators fails, which is the point of the check (model: «THE PRE-MIGRATION CHECK»: every end state of scenario 5 is a violation the check finds, and one repair makes it clean).

**Compatibility.**

- **RLS and column grants:** an index changes neither. The routes use the service client (`createAdminClient`), so a `23505` reaches the code, not the customer.
- **Existing readers:** none is affected (they only select). The change is only to writers: `createAddonRow`'s insert (above) and any UPDATE that would REOPEN an ended row while another is open (model: refused; the worker's requeue goes open to open and is never refused).
- **Build and lock:** a plain `CREATE UNIQUE INDEX` takes a SHARE lock: reads continue, writes to `missions` (the worker's leases, status updates) wait for the build; on a table this small that is milliseconds. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, and a Supabase migration file normally runs in one (**verify**), so a concurrent build means running the single statement by hand outside the migration and recording it afterwards; a failed concurrent build leaves an INVALID index that must be dropped. **Recommend the plain statement in a low-traffic window after check 4 shows a small table.**
- **Order:** (1) owner approval; (2) the read-only checks; (3) repair violators; (4) the code change for the insert path (harmless without the index: it never sees `other_open`); (5) the migration; (6) verify `indisvalid` and `indisunique` read-only; (7) a smoke test on a test account with `test` mode.

**Rollback.** `drop index if exists public.missions_one_open_addon_per_file;` is immediate and only removes a restriction. Everything in the tests above passes WITHOUT the index, so the code never depends on it; the classified insert is backward compatible. No data is changed by the migration or its rollback.

---

## 4. Findings that add to or contradict `docs/MONEY-PR-7A.md` section 17

Consistent with section 17: the creation protocol, the repair, the outage end state (17.4 item 1), «a started request outranks the new one» (item 2), the approval mark (item 3), and «`approveAddonOnce` itself does not check "no other add-on is open"» (item 4) are all confirmed by walking every order.

New, not in section 17 (all with a test named «DOCUMENTED UNRESOLVED RISK»):

1. **The last update of `approveAddonOnce` is not checked** (scenario 8): the customer is told «approved», no job id is recorded, the worker ends the row `failed` without a release, and the hold waits for the watchdog (about 6.5 hours). MONEY HELD, bounded. Protected code.
2. **A request can be stuck for ever after the watchdog releases its job** (scenario 6): not cancellable (approval mark), not re-approvable (`claim_retry`), blocks every new request. The section's «a request that an approved add-on leaves stuck» is listed as not done but not described as blocking the file.
3. **A review that was charged but not published does not block a second paid review of the same version** (scenario 10). Decision D11 covers completed reviews only.
4. An insufficient-balance refusal marks the row so it can no longer be cancelled although nothing moved (UX).
5. The approval answers «already approved» or «not ready» when it lost to a cancel or a repair (UX).
6. Section 17.5's predicate `plan ? 'addon'` and allow-list status list are improvable (section 3 above).
7. The same-base review/edit race is safe because both creators compute the same attempt number and therefore the same id; the primary key is doing the work there, not the protocol.

---

## 5. OWNER APPROVAL REQUIRED

Nothing below was done. Each needs an explicit owner decision before paid approval (`DIGER_STAGE4_REVIEW=on` / `DIGER_STAGE4_EDITS=on`) is turned on:

1. **Apply the partial unique index** (section 3) after the read-only checks; plain build in a low-traffic window; deny-list statuses and a key-based predicate recommended. A migration under `supabase/` is forbidden to this work and was not written.
2. **Approve the approval route's guard** (reconcile before claim; refuse unless this request stays).
3. **Authorize a change to the protected approval code** to check the error of the final record update (finding 1), and decide the **recovery rule for a request whose job the watchdog released** (finding 2).
4. **Decide the rule for a charged-but-unpublished review** (finding 3): block a second paid review, or refund first.
5. **Decide whether `test` mode may start before the index exists** (the guard alone is the minimum).
6. Authorize the small non-money change to the insert path (`insert` classifies the constraint; `createAddonRow` re-lists on `other_open`).

**Not verified:** the index on a real engine; PostgREST's exact error body for a unique violation; whether Supabase migrations run in a transaction; the live column type, `CHECK`, grants and watchdog behaviour (all read from the repository, not from the live database); real storage and a real browser. Do not read this document as a statement that the paid flow is safe: it is a statement of exactly which guarantees hold, which do not, and what would close each.
