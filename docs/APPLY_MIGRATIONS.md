# Migration application guide

Do not run these files until the reviewer approves the PR. Apply one file at a time in the listed order. Run its verification `SELECT` before starting the next file. The agent did not connect to or write to Supabase.

Run each complete file as one transaction. If the SQL editor reports an error before commit, roll back that transaction and stop. The two quote/top-up atomic migrations are safe with the application deployed either before or after them: the code uses the RPC when present and falls back to the legacy path only for a missing-function response. A permission or data error is not treated as a missing function. `settle_people_job_atomic` is required before running a decision-maker job on this code; its missing-function error is not hidden because doing so could charge missing contact fields.

## Order

### 1. `supabase/migrations/20261017150000_register_professional_people_search.sql`

Registers the professional people capability and disables the legacy people-search entry. It is a prerequisite for the people capability switch in the registry. Its existing price is a seed; live quote code derives each unit from the endpoint catalog and the shared points calculator.

Verify:

```sql
SELECT slug, endpoint_id, enabled, unit_cost_usd, unit_price_credits
FROM public.capability_registry
WHERE slug IN ('professional-people-search', 'icypeas-people-search')
ORDER BY slug;
```

Rollback: if the file fails, roll back the transaction. After a successful commit, do not delete either row automatically: `ON CONFLICT DO NOTHING` may mean a row existed before this migration. If the owner confirms the people row was newly created by this migration, remove only that row using its slug and endpoint id; re-enable the legacy slug only if it was enabled before, using the owner's pre-migration snapshot.

### 2. `supabase/migrations/20261017175000_cleanup_capability_registry_social.sql`

Stores exact JSON snapshots of the listed registry rows in `capability_registry_backup_20261017175000`, registers six social capabilities using the existing pricing formula and defaults, then removes the disabled/stale endpoint ids named in the file. The snapshot includes colliding social slugs so a rollback can restore their prior values.

Verify:

```sql
SELECT slug, endpoint_id, enabled, unit_price_credits
FROM public.capability_registry
WHERE slug IN ('social-tiktok-comments','social-youtube-comments','social-facebook-comments','social-tiktok-videos','social-youtube-videos','social-facebook-posts')
   OR endpoint_id IN ('facebook.page.posts','google.serp.organic','instagram.user.profile','instagram.user.posts','telegram.channel.messages','tikhub.tiktok.search.video','tikhub.tiktok.user.posts','twitter.search.tweets','twitter.user.tweets','youtube.channel.details','youtube.search.video','internal-facebook-post-comments','internal-youtube-comments')
ORDER BY slug;
SELECT count(*) AS preserved_rows FROM public.capability_registry_backup_20261017175000;
```

Rollback after commit (run as the migration owner, inside a transaction):

```sql
DELETE FROM public.capability_registry
WHERE slug IN ('social-tiktok-comments','social-youtube-comments','social-facebook-comments','social-tiktok-videos','social-youtube-videos','social-facebook-posts');
INSERT INTO public.capability_registry
SELECT (jsonb_populate_record(NULL::public.capability_registry, row_data)).*
FROM public.capability_registry_backup_20261017175000
ON CONFLICT DO NOTHING;
```

### 3. `supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql`

Replaces only `settle_job_atomic` so a job with a persisted terminal cursor or completed target can settle after the worker's lease remains active. Incomplete collection still cannot settle. Both live `release_job_atomic` overloads are left untouched.

Verify:

```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'settle_job_atomic';
```

Rollback: reapply the prior approved definitions from `supabase/migrations/20261012135427_settle_job_atomic_functions.sql` only if that is still the live pre-migration definition. Check the live function definition first; do not overwrite a later owner change.

### 4. `supabase/migrations/20261017180000_create_quote_atomic.sql`

Adds idempotent `create_quote_atomic`. It locks the profile and prior quote rows, supersedes only server-resolved prior quote ids, and inserts the server-priced quote under the 600-point cap. It accepts no LLM-selected price.

Verify:

```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'create_quote_atomic';
```

Rollback: the deployed caller recognizes a missing function and uses the legacy quote path. After confirming the application version still has that fallback, the migration owner may drop `public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[])`.

### 5. `supabase/migrations/20261017180500_approve_topup_atomic_privileges.sql`

Adds the idempotent `approve_topup_atomic` approval function and `reject_topup_atomic`. Each locks the top-up row. Approval appends `top_<id>` and updates status in one transaction; rejection changes only a pending request. Both are service-role only. The route falls back to its legacy writes only if the function is missing.

Verify:

```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('approve_topup_atomic','reject_topup_atomic')
ORDER BY p.proname;
```

Rollback: the route has a missing-function fallback. After confirming that caller is deployed, the migration owner may drop `public.approve_topup_atomic(text,numeric)` and `public.reject_topup_atomic(text)`.

### 6. `supabase/migrations/20261017181000_settle_decision_maker_fields.sql`

Adds `settle_people_job_atomic`. It locks the job and accepted quote, reads the three point prices stored in that server-priced quote, and charges only the delivered base/email/phone units. Rows with neither requested contact field are retained for review and contribute zero units. Charge is capped at the reserve and 600 points; the reserve buffer is not used in charge calculation.

Verify:

```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'settle_people_job_atomic';
```

Rollback: do not drop this function while the new application version can accept or run decision-maker jobs. First stop new jobs and roll the application back to a version that uses `settle_job_atomic`; only then may the migration owner drop `public.settle_people_job_atomic(text,integer,integer,integer,numeric,text)`.

## Stop conditions

Stop at the first failed verification. Do not retry a migration whose outcome is unknown until a read-only query establishes whether its objects are present. Do not manually insert ledger rows or edit jobs/top-ups/quotes to repair a failed migration. Keep the query output and ask the reviewer to inspect it.
