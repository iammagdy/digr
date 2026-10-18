# Provider keys: admin tabs, encrypted key store, real balance and health

Branch `claude/provider-keys`, from main `83ef3483ce759f04394c2f051cd82dc8a927e76d`. The merge commit, the production deployment id
and the smoke-test results are in the final report message (they do not exist until after this file is merged).

## What the owner gets («مزودو الخدمة»)
- One tab per provider: **مزود البيانات** (TREG, first) and **مزود النموذج الذكي** (Anthropic).
- **Replace the key from the admin screen** and the platform switches to it without a redeploy: a validated, encrypted key store
  is read through ONE shared resolver by every provider call (worker, chat catalog search, adapters, smoke test, health check,
  assistant). The resolver caches a store key for at most 30 seconds per server instance and is flushed at once on the instance
  that saved the key. Order: active store key, else the environment variable (`TREG_TOKEN` / `TREG_API_KEY`, `ANTHROPIC_API_KEY`).
- **Real status**, not a flag: an authenticated call to the provider (result, HTTP status class, latency, time), cached 60 seconds
  per instance, with a refresh button. The sidebar dots now show this instead of «مباشر»/«متوقف».
- **Real provider balance** (data provider): read from the provider, shown in the provider's own units (integer micro-USD, dollars
  derived for display only), with last refresh time and a refresh button. Anthropic has no balance API for a regular key, so the
  tab says so instead of showing a number.
- The platform's own recorded spend today (`provider_costs`, read-only) against the 0.80 USD daily cap; for the model provider,
  today's `llm_usage` cost against the daily cap. Last 20 activity rows for each.
- Low-balance warning below a configurable threshold (default 0.20 USD) and a banner on the admin home.
- One-step rollback to the previous key, from the UI.

## Security design
- Keys are encrypted with AES-256-GCM (random 12-byte nonce per value, authenticated, the provider name is authenticated data)
  using `PROVIDER_KEYS_ENCRYPTION_KEY`, a server-only variable (base64 of 32 random bytes). If it is missing or invalid, saving is
  refused with an Arabic message telling the owner to set it in Vercel; there is no plaintext fallback.
- The browser only ever receives a masked form (last 4 characters) and metadata. The key is accepted in one POST body, kept in a
  password field, cleared immediately, and never logged, stored in git, put in an error message or a test fixture.
- Tables: RLS on, `REVOKE ALL FROM PUBLIC, anon, authenticated`, `service_role` may only `SELECT`. Changes go only through two
  `SECURITY DEFINER` functions (`search_path` = `public, pg_temp`, `service_role` only) that verify the admin role inside the
  function and append to an append-only audit table (who, when, provider, last 4 only, action; UPDATE and DELETE blocked by trigger).
- The Next.js route also verifies admin before calling; a non-admin gets 403 and nothing is called.
- Safe switching: the new key is validated with a real, free provider call BEFORE it is saved. A failed validation saves nothing
  and the old key keeps working. A 401/403 on the stored key never switches keys silently: a reason code is logged and shown on the tab.
- The legacy `/api/admin/providers` POST no longer accepts secrets at all (it only changed one server instance's memory, which is
  why a "changed" key did not really switch). Switches and settings still use it.
- The bundle scan now also watches for `PROVIDER_KEYS_ENCRYPTION_KEY`.

## Endpoints chosen and their documented cost (no live call was made with a real key)
| Purpose | Call | Documented cost |
|---|---|---|
| Validate a candidate key and run the health check (data provider) | `GET https://treg.to/auth/me` with `X-Treg-Token` (public OpenAPI, «Auth Me», token mode) | Not a `/call/<endpoint-id>` route, so not metered; no price is listed for it |
| Real balance (data provider) | `GET https://treg.to/orgs/{org_id}/balance?limit=1` (public OpenAPI, «Org Balance»: amounts are integer micro-USD, any member may read it; `integrate.md` tells builders to monitor it) | Not metered; no price listed |
| Validate a candidate key and run the health check (model provider) | `GET https://api.anthropic.com/v1/models?limit=1` | Lists models, no tokens billed |
The team id for the balance route is read from the identity answer when it carries one, or typed once in the tab; if neither
works the tab says the team id is unknown and shows no number.

## Tests (offline, no network; mocked provider calls)
Before (main 83ef348), without a scratch Postgres: 167 files passed + 1 skipped; 1430 tests passed + 11 skipped.
After, without a scratch Postgres: 174 files passed + 2 skipped; 1514 tests passed + 21 skipped (84 new passing tests).
After, with `DIGR_TEST_PG` (scratch Postgres 16, never Supabase): 176 files passed; 1535 tests passed.
`tsc --noEmit`: exit 0. `npm run build`: exit 0; client bundle secret scan: zero secrets.
New files: `tests/provider-keys-{crypto,resolver,admin,route,call-sites,contract}.test.ts`, `tests/provider-status.test.ts`,
`tests/sql/provider-keys.local-pg.test.ts`, helper `tests/helpers/providerKeyTestKit.ts`. They cover: encryption round trip and
tamper detection; refusal when the encryption variable is missing or invalid; masked output; non-admin refused by the route and by
the SQL function; validation failure keeps the old key; rollback; resolver order and the 30 s cache; fallback to the environment
key when the table or function is missing, with one safe log line; audit rows; no key in any thrown error or captured log; a source
scan proving no direct key read exists outside the resolver; and, on a real Postgres, the functions, the trigger, the privileges,
concurrency and deleting an admin account.
A bug found by the real-Postgres test and fixed before review: a regex repetition above 255 is invalid in PostgreSQL.

## Not run
- Live validation or balance calls with real keys (rule 9). The shapes of the provider's identity and balance answers come from
  its public OpenAPI description; parsing is defensive and an unreadable answer is shown as unreadable, never as a number.
- Applying the migrations (never applied by the author).
- A browser session against the real admin account. The page was rendered in headless Chromium with a mocked API at phone and
  desktop widths (no horizontal overflow, replace flow, failure message, key only in the POST body, nothing in the DOM or storage).

## Remaining risks
- Until the encryption variable is set and the migrations applied, the tab shows an Arabic notice and the environment key is used.
- Losing `PROVIDER_KEYS_ENCRYPTION_KEY` makes stored keys unreadable: the platform falls back to the (possibly stale) environment
  key and the tab says so. Keep the value in a password manager.
- Other server instances pick up a new key within 30 seconds; the saving instance at once.
- Attempt limits and the last-401/403 memory are per server instance (the live health check is the authoritative indicator).
- A 403 from the data provider can also be a per-customer budget refusal; it is recorded as an auth rejection on the tab.
- Scripts under `scripts/` (local tools) still read the variables directly; the source scan covers `src/`.
- While an admin page is open the shell polls status each minute; each instance makes at most one real check per provider per minute.
- OpenAI key handling is unchanged (environment only).

## Migration files (not applied)
### `supabase/migrations/20261018160000_provider_api_keys_tables.sql`
```sql
-- Proposal only (not applied by the author): encrypted provider API keys and their audit trail.
--
-- The platform can switch a provider key from the admin panel without a redeploy. Keys are stored ENCRYPTED
-- (AES-256-GCM, random nonce per value, authenticated) by the application before they reach the database; the
-- encryption key lives only in the server environment (PROVIDER_KEYS_ENCRYPTION_KEY), never in the database.
-- This file adds only tables; the next file adds the functions that are the only way to change them.
--
-- Not a money table. Nothing here touches credit_ledger, jobs, topups, plans_quotes, provider_costs or profiles.

CREATE TABLE IF NOT EXISTS public.provider_api_keys (
  provider text PRIMARY KEY CHECK (provider IN ('treg', 'anthropic')),
  active_ciphertext text,
  active_last4 text CHECK (active_last4 IS NULL OR char_length(active_last4) BETWEEN 1 AND 4),
  active_set_at timestamptz,
  active_set_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  previous_ciphertext text,
  previous_last4 text CHECK (previous_last4 IS NULL OR char_length(previous_last4) BETWEEN 1 AND 4),
  previous_set_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.provider_api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_api_keys FROM PUBLIC, anon, authenticated;
-- Read-only for the server. Writes happen only inside the SECURITY DEFINER functions of the next file.
GRANT SELECT ON TABLE public.provider_api_keys TO service_role;

-- Append-only audit trail: who, when, which provider, the last 4 characters only, and what happened.
CREATE TABLE IF NOT EXISTS public.provider_key_audit (
  id bigserial PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('treg', 'anthropic')),
  action text NOT NULL CHECK (action IN ('set', 'rollback')),
  last4 text CHECK (last4 IS NULL OR char_length(last4) BETWEEN 1 AND 4),
  -- Deliberately no foreign key: an ON DELETE action would try to UPDATE this append-only table and block deleting an
  -- admin account. The actor id stays as written.
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_key_audit_created_idx ON public.provider_key_audit (created_at DESC);

ALTER TABLE public.provider_key_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_key_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.provider_key_audit TO service_role;
REVOKE ALL ON SEQUENCE public.provider_key_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_provider_key_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'provider_key_audit is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_provider_key_audit_mutation ON public.provider_key_audit;
CREATE TRIGGER trg_block_provider_key_audit_mutation
BEFORE UPDATE OR DELETE ON public.provider_key_audit
FOR EACH ROW EXECUTE FUNCTION public.block_provider_key_audit_mutation();
```

### `supabase/migrations/20261018160500_provider_api_keys_functions.sql`
```sql
-- Proposal only (not applied by the author): the only way to change a stored provider key.
-- Requires 20261018160000_provider_api_keys_tables.sql first.
--
-- Both functions are SECURITY DEFINER with a pinned search_path, revoked from PUBLIC / anon / authenticated and
-- granted to service_role only. The admin role is verified INSIDE each function from the auth record of
-- p_admin_id (raw_app_meta_data role = admin), the same pattern as admin_grant_credit_atomic: a route that
-- forgot its own check still cannot change a key. The function receives only ciphertext, never a plaintext key.

-- 1. Set a new active key. The current active key becomes "previous" (one-step rollback).
CREATE OR REPLACE FUNCTION public.admin_set_provider_key_atomic(
  p_admin_id uuid,
  p_provider text,
  p_ciphertext text,
  p_last4 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_row public.provider_api_keys%ROWTYPE;
  v_version integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('treg', 'anthropic') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_provider', 'error_ar', 'مزود غير معروف.');
  END IF;
  IF p_ciphertext IS NULL OR char_length(p_ciphertext) > 1300
     OR p_ciphertext !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{22}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_ciphertext', 'error_ar', 'صيغة المفتاح المشفّر غير صالحة.');
  END IF;
  IF p_last4 IS NULL OR p_last4 !~ '^[^[:space:]]{1,4}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_last4', 'error_ar', 'بيانات المفتاح غير صالحة.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('provider_key:' || p_provider, 0));
  SELECT * INTO v_row FROM public.provider_api_keys WHERE provider = p_provider FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.provider_api_keys (provider, active_ciphertext, active_last4, active_set_at, active_set_by, version)
    VALUES (p_provider, p_ciphertext, p_last4, now(), p_admin_id, 1);
    v_version := 1;
  ELSE
    UPDATE public.provider_api_keys SET
      previous_ciphertext = active_ciphertext,
      previous_last4 = active_last4,
      previous_set_at = active_set_at,
      active_ciphertext = p_ciphertext,
      active_last4 = p_last4,
      active_set_at = now(),
      active_set_by = p_admin_id,
      version = version + 1,
      updated_at = now()
    WHERE provider = p_provider
    RETURNING version INTO v_version;
  END IF;

  INSERT INTO public.provider_key_audit (provider, action, last4, actor_id) VALUES (p_provider, 'set', p_last4, p_admin_id);
  RETURN jsonb_build_object('success', true, 'provider', p_provider, 'version', v_version, 'last4', p_last4);
END;
$$;

-- 2. One-step rollback: the previous key becomes active and the replaced key becomes "previous".
CREATE OR REPLACE FUNCTION public.admin_rollback_provider_key_atomic(
  p_admin_id uuid,
  p_provider text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_row public.provider_api_keys%ROWTYPE;
  v_version integer;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_provider IS NULL OR p_provider NOT IN ('treg', 'anthropic') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_provider', 'error_ar', 'مزود غير معروف.');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('provider_key:' || p_provider, 0));
  SELECT * INTO v_row FROM public.provider_api_keys WHERE provider = p_provider FOR UPDATE;
  IF NOT FOUND OR v_row.previous_ciphertext IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'no_previous_key', 'error_ar', 'لا يوجد مفتاح سابق للرجوع إليه.');
  END IF;

  UPDATE public.provider_api_keys SET
    active_ciphertext = v_row.previous_ciphertext,
    active_last4 = v_row.previous_last4,
    active_set_at = now(),
    active_set_by = p_admin_id,
    previous_ciphertext = v_row.active_ciphertext,
    previous_last4 = v_row.active_last4,
    previous_set_at = v_row.active_set_at,
    version = version + 1,
    updated_at = now()
  WHERE provider = p_provider
  RETURNING version INTO v_version;

  INSERT INTO public.provider_key_audit (provider, action, last4, actor_id) VALUES (p_provider, 'rollback', v_row.previous_last4, p_admin_id);
  RETURN jsonb_build_object('success', true, 'provider', p_provider, 'version', v_version, 'last4', v_row.previous_last4);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_provider_key_atomic(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_provider_key_atomic(uuid, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.admin_rollback_provider_key_atomic(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rollback_provider_key_atomic(uuid, text) TO service_role;
```

Apply order, verification SELECTs and rollback: `docs/APPLY_MIGRATIONS_3.md`.
