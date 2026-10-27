# Agent loop: recipes, exploration calls, unknown keys (PROPOSAL, **NOT APPLIED**)

Nothing in this folder has been run against Supabase. The owner applies it by hand, after review, in the order below. No code in the repository reads or writes these
tables yet (PR B wires nothing). **No money table is touched**: not `credit_ledger`, `jobs`, `topups`, `profiles`, `plans_quotes`, `provider_costs`, and no money
function. A recipe never stores a customer price; the price is computed by code from the catalog cost and the shared pricing function, every time.

Ids are prefixed like the others (`res_`, `rel_`, `chg_`, `top_`, `promo_`, `adm_`): `rcp_` for a recipe, `exp_` for an exploration call. They are not money ids.

| Step | File | What | Rollback |
|---|---|---|---|
| 0 | `00_verify_before_apply.sql` | READ ONLY: the tables do not exist yet, the extensions and roles are as expected | none |
| 1 | `01_recipes.sql` | `recipes`: a reviewed, versioned recipe = endpoint + parameter template + field map + filters; a reviewed recipe is immutable | `01_recipes.rollback.sql` |
| 2 | `02_exploration_calls.sql` | `exploration_calls`: one row per budgeted exploration call (cost, endpoint, where the raw answer is stored) | `02_exploration_calls.rollback.sql` |
| 3 | `03_unknown_keys.sql` | `unknown_keys`: a field a real answer carried that no field map knows; never charged, queued for a human | `03_unknown_keys.rollback.sql` |
| 4 | `04_verify_after_apply.sql` | READ ONLY: shape, constraints, RLS on, no grant to `anon` or `authenticated` | none |

Rollback order: 03, then 02, then 01 (`unknown_keys` points at `recipes`).

Checked (not applied anywhere that matters): files 00 to 04 and the three rollbacks were run on a THROW-AWAY local PostgreSQL 16 with stand-in roles, never on Supabase:
every statement ran, a recipe cannot be reviewed without a reviewer and a fixture, a reviewed recipe cannot be changed or deleted, a second reviewed version of a slug is refused,
a retired recipe stays retired, constraints on the other two tables hold, and the rollbacks leave nothing behind. Real Supabase behaviour (role names, `service_role` bypass) is NOT PROVEN.

## Security stance
Row-level security is ON and there is NO policy: only the service role (which bypasses RLS) can read or write. `anon` and `authenticated` get no privilege. A
customer never sees a recipe, an exploration call or an unknown key.

## What a recipe holds (one row, `params_template` and `field_map` are JSON)
- `endpoint_id`: one id of the sellable catalog (`data/treg/treg_catalog_sellable.json`); code refuses a write action, an own-account endpoint or an unknown id.
- `params_template`: each parameter with its **provenance**: `{"handle": {"from": "customer_text"}, "limit": {"from": "plan_volume"}, "cursor": {"from": "prior_page"}}`.
  A value with no provenance is refused (`src/lib/paramProvenance.ts`).
- `field_map`: `rowsPath`, `cursorPath` and `cursorKind`, `idField`, `textField`, `authorField`, `dateField` with its format (`unix_s`, `iso`), boolean and number
  coercions, the filters (a closed language, no code), the dedupe key, and the output columns (Arabic headers).
- `price_basis`: the catalog cost per call and per record, and the yield the recipe was reviewed with. **Not** a customer price.
- `fixture_refs`: the replay fixtures (real rows, never only a catalog example) the recipe was proven on with zero provider calls.
- `catalog_snapshot_sha256`: which snapshot the recipe was written against.

## Verification after applying
Run `04_verify_after_apply.sql`: three tables, RLS on, no policies, no grants to `anon` or `authenticated`, the immutability trigger present.
