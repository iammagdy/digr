# Production SQL definitions (read 2026-10-21, SELECT only)

Source: `pg_get_functiondef`, `pg_constraint`, `pg_trigger`, `pg_indexes`, `pg_attribute` on project `pfinlfaqwnytesedchik`. Definitions only: no data, no secrets. Used as the base for the replica test database and for the cap proposals in `docs/proposals/`.

Files: `create_quote_atomic.sql`, `accept_quote_atomic.sql`, `reserve_credits_atomic.sql`, `settle_job_atomic.sql`, `settle_people_job_atomic.sql`, `release_job_atomic.sql` (two overloads), `approve_topup_atomic.sql`, `claim_complete_failure_functions.sql` (claim_job_chunk, complete_chunk, record_chunk_failure), `ledger_trigger_and_provider_functions.sql`, `tables.md` (columns, constraints, triggers, indexes, grants).

Every function listed: `SECURITY DEFINER`, EXECUTE granted to `postgres` and `service_role` only (ACL `{postgres=X/postgres,service_role=X/postgres}`), none to PUBLIC, anon or authenticated.
