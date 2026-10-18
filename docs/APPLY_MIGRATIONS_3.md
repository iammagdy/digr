# Applying the provider key store migrations (set 3)

None of these files was applied by the author. They are proposals for review. The live code works **before and after**
they are applied: until they are applied the admin tab shows an Arabic notice that the key store is not ready and the
key from the environment variable (`TREG_TOKEN` / `TREG_API_KEY`, `ANTHROPIC_API_KEY`) keeps being used.

Neither file touches `credit_ledger`, `jobs`, `topups`, `plans_quotes`, `provider_costs` or `profiles`.

## Before applying anything (owner steps, in this order)

1. Generate the encryption key on your computer (32 random bytes, base64) and **never paste it in a chat**:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. In Vercel: Project, Settings, Environment Variables, add `PROVIDER_KEYS_ENCRYPTION_KEY` (Production), paste the value, save.
3. Click **Redeploy** on the latest production deployment so the variable reaches the running code.
4. Only then apply the two SQL files below, in order.
5. Open the admin page «مزودو الخدمة», choose the tab, press «استبدال المفتاح» and paste the current key to move it into the store.

Keep the encryption key somewhere safe (a password manager). If it is lost, stored keys cannot be decrypted: the platform
falls back to the environment variable key and the tab says so; paste the keys again to re-store them.

## Apply order

### 1. `supabase/migrations/20261018160000_provider_api_keys_tables.sql`

Creates `provider_api_keys` (encrypted active and previous key per provider) and the append-only `provider_key_audit`
(who, when, provider, last 4 characters, action). RLS on, `REVOKE` from `PUBLIC, anon, authenticated`, `service_role` may only `SELECT`.

Verify (expect `keys_table` and `audit_table` set, `keys_rls` and `audit_rls` true, the next three false, `audit_trigger` 1):

```sql
SELECT to_regclass('public.provider_api_keys') AS keys_table,
       to_regclass('public.provider_key_audit') AS audit_table,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_api_keys'::regclass) AS keys_rls,
       (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.provider_key_audit'::regclass) AS audit_rls,
       has_table_privilege('authenticated', 'public.provider_api_keys', 'SELECT') AS authenticated_can_read_keys,
       has_table_privilege('anon', 'public.provider_api_keys', 'SELECT') AS anon_can_read_keys,
       has_table_privilege('service_role', 'public.provider_api_keys', 'INSERT') AS service_role_can_write_keys_directly,
       (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_block_provider_key_audit_mutation') AS audit_trigger;
```

Rollback (only while no key has been saved through the store): `DROP TABLE public.provider_key_audit; DROP TABLE public.provider_api_keys;`

### 2. `supabase/migrations/20261018160500_provider_api_keys_functions.sql`

Creates `admin_set_provider_key_atomic` and `admin_rollback_provider_key_atomic`: `SECURITY DEFINER`, `search_path` pinned to
`public, pg_temp`, executable by `service_role` only. The admin role is checked **inside** each function from the auth record
(`raw_app_meta_data` role = admin). They accept only ciphertext in the application's format, never a plaintext key.

Verify (expect 2 rows, `prosecdef` true, `proconfig` containing `search_path=public, pg_temp`, `service_role` true, `authenticated` false, `anon` false; `keys_saved` 0 until you save a key):

```sql
SELECT p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('admin_set_provider_key_atomic', 'admin_rollback_provider_key_atomic')
ORDER BY p.proname;
SELECT count(*) AS keys_saved FROM public.provider_api_keys;
```

Rollback: `DROP FUNCTION public.admin_set_provider_key_atomic(uuid, text, text, text); DROP FUNCTION public.admin_rollback_provider_key_atomic(uuid, text);`

## After applying: confirm the audit trail works (read-only)

After the first key replacement from the admin page:

```sql
SELECT provider, action, last4, actor_id, created_at FROM public.provider_key_audit ORDER BY id DESC LIMIT 5;
SELECT provider, active_last4, previous_last4, version, active_set_at FROM public.provider_api_keys;
```

Both show only the last 4 characters. The `*_ciphertext` columns hold ciphertext and are never shown by the admin screens.

## If you must go back to the environment variable

The platform uses the environment variable whenever the store is empty, missing or cannot be decrypted. Before dropping the
tables, make sure the environment variable in Vercel holds the key that currently works (the stored one may be newer).
