# Tables, constraints, triggers, indexes (production, read 2026-10-21)

## Columns (money-relevant)
| Table | Column | Type | Null | Default |
|---|---|---|---|---|
| credit_ledger | id text PK, user_id uuid, delta **numeric**, type text, job_id text, topup_id text, note text, created_at timestamptz | | delta/type/user_id NOT NULL | created_at now() |
| credit_ledger_kinds | ledger_id text PK, kind text, actor_id uuid, created_at | | | |
| jobs | id text PK, user_id uuid, status text, endpoint_id text, target_volume_min **integer**, target_volume_max **integer**, reserved_credits **numeric**, charged_credits **numeric**, delivered_units **integer** (default 0), current_cursor text, accumulated_cost_usd numeric (default 0), attempt_count int, result_file_id, error_message, next_attempt_at, step int, lease_until, **unit_price numeric** | | | |
| plans_quotes | id text PK, user_id, quote_hash text, status text, items jsonb, total_reserved_credits **numeric** NOT NULL, output_formats jsonb, expires_at, created_at | | | status 'quoted' |
| provider_costs | id bigint PK, job_id, provider text, units int, cost_usd numeric NOT NULL, created_at, is_estimate boolean | | | |
| topups | id, user_id, amount_egp numeric, reference unique, ..., status | | | 'pending' |
| profiles | id uuid PK, email, sender_name, sender_phone, deletion_scheduled_for, created_at, updated_at | | | (no balance column: the balance is SUM(credit_ledger.delta)) |

## CHECK constraints
- `credit_ledger.chk_ledger_delta_direction`: type in (reserve, charge) requires delta < 0; type in (release, topup, grant, goodwill) requires delta > 0.
- `credit_ledger.chk_ledger_type`: type in (reserve, release, charge, topup, grant, goodwill).
- `jobs.chk_jobs_status`: queued, running, completed, failed, refused.
- `jobs.chk_jobs_unit_price_positive`: unit_price IS NULL OR unit_price > 0 (numeric: fractional prices are accepted).
- `plans_quotes.chk_quotes_status`: quoted, accepted, expired, refused.
- `topups.chk_topups_amount_positive`, `topups.chk_topups_status`; `credit_ledger_kinds.kind` in (topup_instapay, promo_code, admin_grant).
- No CHECK on reserved_credits, charged_credits, total_reserved_credits, balance or any upper bound of points.

## Triggers
- `credit_ledger`: `trg_block_ledger_mutation` BEFORE DELETE OR UPDATE (row) -> block_ledger_mutation(); `trg_block_ledger_truncate` BEFORE TRUNCATE -> block_ledger_truncate().
- `credit_ledger_kinds`: `trg_block_credit_kind_mutation` BEFORE DELETE OR UPDATE -> block_credit_kind_mutation().

## Indexes
credit_ledger: pkey(id), job_id, topup_id, user_id. jobs: pkey, lease_until, status, (status,next_attempt_at), user_id. plans_quotes: pkey, quote_hash, user_id. provider_costs: pkey, job_id, (created_at,cost_usd).

## Foreign keys
All `user_id` -> auth.users(id) ON DELETE RESTRICT; credit_ledger_kinds.ledger_id -> credit_ledger(id); job_events.job_id -> jobs(id); provider_costs.job_id -> jobs(id).
