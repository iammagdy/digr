# Production SQL preflight: `001_spend_gate.sql`, `003_campaign_scope.sql`, `002_verify.sql`, `004_verify_campaign.sql`

**Status (14 Nov 2026): PREPARED, NOT APPLIED.** Nothing in this document changed production. Applying these files needs the owner's explicit approval of these exact files (decision D1 of `docs/intelligence/PHASE-8-EXECUTION-CHECKLIST.md`). Every production check below was a **read-only** query through the read-only Supabase connection.

## 1. What the four files do

| File | Effect | Reversible by |
|---|---|---|
| `001_spend_gate.sql` | Creates the NOLOGIN role `spend_gate_owner`, the schema `spend_gate` (3 tables, 3 owner-only functions), and 4 `public.spend_*` functions executable by `service_role` only. **Creates no grant.** | `001_spend_gate.rollback.sql` (refuses while a reservation is held) |
| `002_verify.sql` | 15 read-only checks. Every row must say `true`. | n/a |
| `003_campaign_scope.sql` | Adds the campaign scope: 2 columns on `spend_gate.grants`, the table `spend_gate.enrollments`, the immutability trigger, `spend_gate.mission_owner` and `issue_campaign_grant`, replaces `spend_reserve` and `spend_status`, adds `public.spend_enroll_mission`. **Creates no grant.** | `003_campaign_scope.rollback.sql` (refuses while ANY campaign grant row exists; restores 001's functions verbatim) |
| `004_verify_campaign.sql` | 13 read-only checks. Every row must say `true`. | n/a |

Each of the four applying files is one transaction (`BEGIN` ... `COMMIT`): a failure at any statement applies nothing. No file touches `credit_ledger`, pricing, quotes, settlement, points or any existing function; the only existing object read is `public.missions` (`id`, `user_id`), by one function.

## 2. Production facts observed (read-only, 14 Nov 2026, ~19:20 UTC)

| Fact | Observed | Consequence |
|---|---|---|
| Postgres | **17.11** (the offline rehearsal ran 16) | See §6: the role semantics used are the same in 16 and 17, but it was not run on 17 |
| `spend_gate` schema, any `spend_*` function | **none** (0 and 0) | No name collision; the first file's own guard also refuses if the schema exists |
| Role `postgres` | not superuser; `CREATEROLE`; `BYPASSRLS`; can log in | It can create the role and the schema, and it reads `public.missions` through RLS |
| Role `service_role` | NOLOGIN, `BYPASSRLS`, not superuser | It is the worker's role; the SQL gives it execute on 5 functions and nothing else |
| `anon`, `authenticated` | NOLOGIN, no bypass | Revoked everywhere (§4) |
| `public.missions` | owner `postgres`; RLS **on**, not forced; `id text`, `user_id uuid` (both NOT NULL) | `spend_gate.mission_owner` is created by `postgres` (RLS-bypass role) and reads one `user_id`; the column types match |
| `public.credit_ledger` | owner `postgres`; RLS on | Not referenced by any new object |
| Default privileges (public, functions) | `EXECUTE` is granted automatically to `anon`, `authenticated`, `service_role` for functions created by `postgres` or `supabase_admin` | **The hazard the REVOKEs exist for** (§4) |
| Public functions today | 70, of which 55 are SECURITY DEFINER | The 5 new ones add to this; the security advisor is the check (§7) |
| Extensions | `pgcrypto`, `pg_cron`, `pg_stat_statements`, `supabase_vault`, `uuid-ossp` | The SQL needs none beyond core (`gen_random_uuid()` is core in 13+) |
| Missions `queued` / `planning` / `executing` | **0** of 247 | Nothing is in flight |
| Security advisor baseline | 30 INFO (`rls_enabled_no_policy`), 2 WARN (`recipes_guard` search path; leaked-password protection), **0 ERROR** | The post-apply advisor run must show **no new finding** |
| `archive_mode` | `on`, `wal_level=logical` | Consistent with WAL archiving; it does **not** prove that backups or point-in-time recovery exist (§5) |

## 3. Role ownership

* The role `spend_gate_owner` is created NOLOGIN, NOINHERIT, with no other privilege. Only `CURRENT_USER` (the dashboard's `postgres`) is granted membership. `002_verify.sql` checks that no other role is ever a member.
* `spend_gate` and everything in it are owned by `spend_gate_owner`. The five `public.spend_*` functions are SECURITY DEFINER **owned by `spend_gate_owner`**, with `search_path = pg_catalog, spend_gate, pg_temp`.
* `spend_gate.mission_owner` is the one object owned by `postgres` (it must read `public.missions` past RLS). It is SECURITY DEFINER, `search_path = pg_catalog, public, pg_temp`, qualifies `public.missions`, and is executable by `spend_gate_owner` only.
* Briefly during apply, `GRANT CREATE ON SCHEMA public TO spend_gate_owner` lets that role create the `public.spend_*` functions; it is revoked in the same transaction (`REVOKE CREATE ON SCHEMA public FROM spend_gate_owner`).

## 4. Public grants, SECURITY DEFINER and RLS: the matrix

| Object | PUBLIC / anon / authenticated | service_role | owner role (`postgres` via `spend_gate_owner`) |
|---|---|---|---|
| Schema `spend_gate` | no usage | **no usage** | usage |
| Tables `grants`, `reservations`, `events`, `enrollments` | no privilege; RLS enabled, no policy | **no privilege** | owner |
| `spend_gate.issue_grant`, `issue_campaign_grant`, `revoke_grant`, `expire_stale_open` | no execute | **no execute** | execute |
| `public.spend_reserve`, `spend_settle`, `spend_stop`, `spend_status`, `spend_enroll_mission` | **explicitly revoked** (`REVOKE ALL ... FROM PUBLIC, anon, authenticated`) | **execute** | owner |

* **Default-privilege hazard:** because Supabase auto-grants `EXECUTE` on new public functions to `anon`/`authenticated`/`service_role`, both SQL files revoke those grants explicitly, function by function and with `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA spend_gate`. `002`/`004` check `anon cannot reserve`, `authenticated cannot reserve`, `authenticated cannot settle`, `service_role cannot issue/revoke a grant`. Without these REVOKEs the website's anonymous visitors could call the gate; with them they cannot.
* **Row-level security:** the four new tables have RLS enabled and **no policy**: no role without `BYPASSRLS` can read or write them; `service_role` bypasses RLS but has no table privilege, so it cannot either. All access is through the SECURITY DEFINER functions. **No existing table's RLS or policy changes.**
* **SECURITY DEFINER inventory:** every SECURITY DEFINER function in the two files carries a fixed `search_path` (checked by the catalog rows of `002` and `004`, and re-read in the independent review). `expire_stale` is a plain internal function, also with a fixed path. `002`/`004` verify this against the catalog.
* **What a service_role holder CAN do** (stated, not hidden): reserve, settle, stop and enroll. `spend_stop` trips the open grant (a denial of the campaign, never an increase). `spend_settle` accepts any held reservation id with any actual amount, including 0, so a **leaked service key** could free held bounds; provider-side limits (§5 of the checklist) are the control for that, as the design already says. It cannot issue, raise, extend, reopen or delete a grant: terms are immutable (trigger), and only the owner role holds the issue and revoke functions.

## 5. Backup and recovery

* **Not verified from here.** The read-only connection cannot see the project's backup schedule or point-in-time-recovery setting. `archive_mode=on` is consistent with it but is not evidence.
* **Owner check before applying (the dashboard, Database → Backups):** a backup exists from the last 24 hours, or point-in-time recovery is on. Record which, with the timestamp.
* **Why the risk is small even so:** the change is **additive** (no existing object is altered; the only existing table touched is read), each file is one transaction, and both rollbacks exist and were run in the rehearsal (§6). The recovery path for a bad apply is the rollback pair, in this order: `003_campaign_scope.rollback.sql`, then `001_spend_gate.rollback.sql`. A restore from backup is the second path and is not needed for an additive change.

## 6. Offline rehearsal (what was and was not shown)

`docs/proposals/spend-gate/sql/rehearse-as-supabase-owner.sh` runs 001, 003, both verifies, a functional pass and both rollbacks on a **scratch** Postgres, as a **non-superuser** `CREATEROLE`/`BYPASSRLS` owner of the schema and tables, with Supabase's default privileges and RLS on `missions` and `credit_ledger`. Result on 14 Nov 2026: **`REHEARSAL OK`**.

* 002: 15/15 true; 004: 13/13 true; 002 again after 003: 15/15 true.
* Another account's mission is refused (`wrong_account`); an unknown mission is refused; an unenrolled mission cannot reserve; an enrolled one reserves; a reservation above the per-operation maximum and a `chat` kind are refused.
* `service_role` is refused every table read, a direct `UPDATE` of a grant, and a grant issue (`permission denied`); the owner role itself cannot change a grant's terms (the trigger refuses).
* 003's rollback **refuses** while a campaign grant exists; after a revoke, a second campaign grant that would take the campaign past 0.30 in total is **refused**.
* On a clean rebuild: 003's rollback restores 001 (15/15 true); 001's rollback leaves no `spend_gate` schema, no `spend_gate_owner` role, and `credit_ledger` unchanged (1 row, sum 100).

**Not shown, stated plainly:** the rehearsal ran on **Postgres 16**, production is **17.11**; the role model is an emulation, not Supabase's own (for example the dashboard's SQL editor, the `supabase_admin` ownership of some objects, and platform event triggers are not emulated); the SQL has **never run on the production database**. The four verify files are the real-database check, and they are read-only: if any row says `false`, **stop**, do not continue, and run the rollback.

## 7. Exact apply procedure (for the owner, after approval)

0. **Before:** confirm a backup (§5); confirm no mission is `queued`/`planning`/`executing`; note the security advisor counts (30 INFO, 2 WARN, 0 ERROR).
1. In the Supabase dashboard SQL editor (role `postgres`), paste `001_spend_gate.sql` **whole** and run it. It must end without an error.
2. Run `002_verify.sql`: **every row `true`** (15). Else run `001_spend_gate.rollback.sql` and stop.
3. Paste `003_campaign_scope.sql` whole and run it.
4. Run `004_verify_campaign.sql` (13 rows) and `002_verify.sql` again (15 rows): **every row `true`**. Else run `003_campaign_scope.rollback.sql`, then `001_spend_gate.rollback.sql`, and stop.
5. Re-run the security advisor: **no new finding**. (Expected: none, because the new public functions are revoked from `anon`/`authenticated`.)
6. Read-only checks: `select count(*) from spend_gate.grants;` is **0** (no grant exists); `credit_ledger` row count and `sum(delta)` equal the values noted before (1,247 rows, sum 16,086 on 14 Nov 2026). Nothing calls the new functions yet (the worker gate is unset).

After step 6 the state is: objects present, **no grant, every reservation refused (`no_grant`), the worker unchanged**. Nothing is enabled, no money can be spent.

## 8. Rollback safety

| Situation | What happens | Effect on customers |
|---|---|---|
| A statement fails during 001 or 003 | The transaction aborts: nothing applied | none |
| A verify row says `false` | Run the rollbacks (003's, then 001's) | none |
| Rollback of 003 with a campaign grant present (even revoked) | **Refused**, nothing changed: the grant would otherwise silently become a general grant | none |
| Rollback of 001 with a reservation held | **Refused** (a paid call may be in flight); `spend_gate.force_rollback = 'on'` overrides | none |
| Worker runs with `DIGER_SPEND_GATE` unset (today and after applying) | Never calls any `spend_*` function | none |

## 9. Remaining SQL risks (from the independent review, reading only)

* The `spend_reserve` replay branch returns `ok` before the grant-state checks: a replay of a reservation key on a tripped or expired grant would succeed. Keys are random per attempt and never replayed by the worker, so it is **not reachable today**; an owner may ask for it to be closed in a later reviewed change.
* A `003` rollback issued when 003 was never applied errors on the missing column. Harmless (it aborts).
* The dashboard role's membership in `spend_gate_owner` (`INHERIT`/`SET`) is the PG16+ default and worked in the rehearsal on 16; it is checked on the real database by the first run of `002_verify.sql` and by the apply itself (a failure aborts the transaction).
