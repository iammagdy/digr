# Data quality and spend limits report

Branch `claude/data-quality-and-limits`, started from main `e7cf565` (PR #88). Main had not moved when the branch was finished
(see the final message for the dry-run merge and the exact SHAs: the merge commit and the production deployment id cannot be
known before the merge).

No database was read or written in this run, no provider was called, and no migration was applied.

## Test counts

| | Files | Tests passed | Skipped |
|---|---|---|---|
| Before (main `e7cf565`), scratch Postgres available | 184 passed | 1605 | 0 |
| After, scratch Postgres available | 189 passed | 1673 | 0 |
| Before, no scratch Postgres | 182 passed, 2 skipped | 1584 | 21 |
| After, no scratch Postgres | 186 passed, 3 skipped | 1646 | 27 |

`npx tsc --noEmit`: 0 errors. `npm run build`: exit 0; client-bundle secret scan "Zero client bundle secrets detected"
(104 static files). The scratch Postgres is PostgreSQL 16 started outside the repo; point `DIGR_TEST_PG` (or `DIGER_TEST_PG`)
at it. Existing tests changed on purpose: `research-relevance-gate` (football-dominated mixed text now goes to review instead
of being rejected) and `company-report-scope-and-fields` (review sheet starts with a notice row).

## A. Provider spend limits editable from the admin dashboard: DONE (store not applied)

| Piece | Evidence |
|---|---|
| One shared resolver, 30 s cache, flush on save, fallback 0.80 | `src/lib/server/providerLimits.ts`; `tests/provider-limits.test.ts` (30 tests): order settings, then legacy `pricing` row, then environment, then 0.80; unreadable store; cache TTL; flush; bad stored values ignored |
| Immediate effect | the worker's reserve call carries the saved limit on the next chunk (tests: 0.0123 and 999999999999 reach `p_daily_cap_usd`); the plan-estimate balance follows a saved limit at once |
| Per-job and per-user ceilings | `evaluateSpendCeilings`; worker test: a job already at its ceiling makes no provider call, reserves nothing, releases with zero charge and answers in plain Arabic; another user's spend never counts; nothing extra is queried when no ceiling is set |
| Validation | numbers only, Arabic-Indic digits accepted, negatives refused, percent 0 to 100, empty ceiling clears it, huge values (up to 1e12) accepted, zero accepted (stops all provider spend) |
| Admin only | route refuses a non-admin with 403 and a signed-out visitor with 401 (tested); the SQL function checks the admin again inside |
| Audit | append-only `provider_limits_audit` (who, when, old, new), UPDATE and DELETE blocked by trigger: tested on a real Postgres (`tests/sql/provider-limits.local-pg.test.ts`, 6 tests) |
| Works before the migration | the tab shows «مخزن الإعدادات غير جاهز…», fields are read-only, saving answers 409 in Arabic, every limit stays on the current constants (tested) |
| UI | «مزودو الخدمة» data-provider tab: daily limit, per-job ceiling, per-user ceiling, warning percent, today's recorded spend, percent of the daily limit and the real provider balance; model tab: the model's daily limit; warning banner in the tab and on the admin home at the threshold, plain message at the limit (render tests) |
| Where it is enforced | worker reserve, multi-step worker daily check, plan estimate (`checkPlanProviderCapacity`), the model's daily kill switch (`checkGlobalDailySpendCap`), the admin tab; the public calculator follows it through `/api/calculator/cap`, which returns customer points only and never the provider USD value |

Behaviour change to know about: for the model's daily limit, a value saved in the store now wins over the environment
variable (before, the variable won). With nothing stored nothing changes.

### Migration (not applied): `supabase/migrations/20261019100000_provider_limits.sql`

```sql
-- Proposal only (not applied by the author): admin-editable provider spend limits with an append-only audit trail.
--
-- The limits live in the existing settings_private row with key 'provider_limits' (value JSON). The application keeps
-- working on its built-in constants (0.80 USD per day for the data provider) until this file is applied, and the admin
-- tab says so in Arabic. Nothing here touches credit_ledger, jobs, topups, plans_quotes, provider_costs or profiles.
--
-- Value shape (all USD except warnPercent):
--   { "dailyUsd": 0.80, "perJobUsd": 0.05|null, "perUserDailyUsd": 0.30|null, "warnPercent": 80, "llmDailyUsd": 50 }

-- 1. Append-only audit: who, when, old value, new value. No foreign key on purpose (an ON DELETE action would try to
--    UPDATE this append-only table and block deleting an admin account).
CREATE TABLE IF NOT EXISTS public.provider_limits_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  old_value jsonb,
  new_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS provider_limits_audit_created_idx ON public.provider_limits_audit (created_at DESC);

ALTER TABLE public.provider_limits_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.provider_limits_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.provider_limits_audit TO service_role;
REVOKE ALL ON SEQUENCE public.provider_limits_audit_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_provider_limits_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION 'provider_limits_audit is append-only. UPDATE and DELETE operations are forbidden.';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_provider_limits_audit_mutation ON public.provider_limits_audit;
CREATE TRIGGER trg_block_provider_limits_audit_mutation
BEFORE UPDATE OR DELETE ON public.provider_limits_audit
FOR EACH ROW EXECUTE FUNCTION public.block_provider_limits_audit_mutation();

-- 2. The only way to change the limits. SECURITY DEFINER, pinned search_path, service_role only; the admin role is
--    verified INSIDE the function from the auth record of p_admin_id (raw_app_meta_data role = admin), the same
--    pattern as admin_grant_credit_atomic. p_limits is a PARTIAL object: only the keys present change; a JSON null for
--    perJobUsd / perUserDailyUsd clears that ceiling. Every key is validated here again (type, range).
CREATE OR REPLACE FUNCTION public.admin_set_provider_limits_atomic(
  p_admin_id uuid,
  p_limits jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_role text;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_val jsonb;
  c_max constant numeric := 1000000000000;
BEGIN
  SELECT raw_app_meta_data ->> 'role' INTO v_role FROM auth.users WHERE id = p_admin_id;
  IF p_admin_id IS NULL OR v_role IS DISTINCT FROM 'admin' THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_admin', 'error_ar', 'هذا الإجراء مخصص للمسؤولين فقط.');
  END IF;
  IF p_limits IS NULL OR jsonb_typeof(p_limits) <> 'object' OR p_limits = '{}'::jsonb THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_limits', 'error_ar', 'لم يصل أي تعديل صالح.');
  END IF;

  FOR v_key, v_val IN SELECT key, value FROM jsonb_each(p_limits) LOOP
    IF v_key NOT IN ('dailyUsd', 'perJobUsd', 'perUserDailyUsd', 'warnPercent', 'llmDailyUsd') THEN
      RETURN jsonb_build_object('success', false, 'error', 'unknown_key', 'error_ar', 'إعداد غير معروف.');
    END IF;
    IF v_key IN ('perJobUsd', 'perUserDailyUsd') AND jsonb_typeof(v_val) = 'null' THEN
      CONTINUE;
    END IF;
    IF jsonb_typeof(v_val) <> 'number' THEN
      RETURN jsonb_build_object('success', false, 'error', 'not_a_number', 'error_ar', 'القيمة يجب أن تكون رقمًا.');
    END IF;
    IF (v_val #>> '{}')::numeric < 0 THEN
      RETURN jsonb_build_object('success', false, 'error', 'negative', 'error_ar', 'لا يمكن أن تكون القيمة سالبة.');
    END IF;
    IF v_key = 'warnPercent' AND (v_val #>> '{}')::numeric > 100 THEN
      RETURN jsonb_build_object('success', false, 'error', 'percent_range', 'error_ar', 'نسبة التنبيه يجب أن تكون بين ٠ و١٠٠.');
    END IF;
    IF v_key <> 'warnPercent' AND (v_val #>> '{}')::numeric > c_max THEN
      RETURN jsonb_build_object('success', false, 'error', 'too_large', 'error_ar', 'الرقم أكبر من الحد المسموح.');
    END IF;
  END LOOP;

  PERFORM pg_advisory_xact_lock(hashtextextended('provider_limits', 0));
  SELECT value INTO v_old FROM public.settings_private WHERE key = 'provider_limits' FOR UPDATE;
  -- A null ceiling is stored as an absent key (no ceiling); everything else overwrites its own key only.
  v_new := (COALESCE(v_old, '{}'::jsonb) || (SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) FROM jsonb_each(p_limits) WHERE jsonb_typeof(value) <> 'null'))
           - COALESCE((SELECT array_agg(key) FROM jsonb_each(p_limits) WHERE jsonb_typeof(value) = 'null'), ARRAY[]::text[]);

  INSERT INTO public.settings_private (key, value, updated_at)
  VALUES ('provider_limits', v_new, now())
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

  INSERT INTO public.provider_limits_audit (actor_id, old_value, new_value) VALUES (p_admin_id, v_old, v_new);
  RETURN jsonb_build_object('success', true, 'limits', v_new);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_provider_limits_atomic(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_provider_limits_atomic(uuid, jsonb) TO service_role;
```

Apply order, verification SELECT and rollback: `docs/APPLY_MIGRATIONS_4.md`.

## B. Data extraction quality: DONE (offline-measured on synthetic fixtures)

| # | Item | Status | Evidence |
|---|---|---|---|
| B1 | Relevance gate per capability; uncertain rows to review, never charged | DONE | Companies: HVAC, plumbing and refrigeration text goes to review even under an energy label; an energy-adjacent label with the company's own electrical text is delivered. Tweets, comments, posts and videos: Arabic-aware matching (article, plural, feminine ending, word order, dialect spelling, a few English equivalents), a topic of several words found only in part goes to review, football-versus-basketball mixed text goes to review, language checked only when the request names one and the row states its own, an explicit foreign country on the row is rejected. People: a person located in another country is rejected. Uncertain social and people rows get a review sheet that says plainly they were not charged. Trending-video upload age still never rejects a row (existing contract, pinned by `activity-events-and-failures`; an explicit date window filters earlier). `tests/extraction-quality.test.ts` (18) |
| B2 | Pagination policy | DONE | Feeds (comments, posts, videos) now use the same caps as directory searches: small jobs read at most 4 chunks, stop after 2 (small) or 3 (large) consecutive chunks with no new matching row, hard ceiling 30. Worker replays: keeps fetching until the MATCHING count is reached, stops with zero charge when nothing matches, delivers as partial and settles only the matching rows when a cap stops it |
| B3 | De-duplication across pages and chunks | DONE | One module (`rowDedupe.ts`): company by website domain, then id, then name; person by profile link, else name and company; others by source id. Rows an earlier page sent to review count too. Now also applied to decision-maker jobs |
| B4 | Arabic column names for every capability | DONE | Delivered Excel of every benchmark capability: 0 Latin headers, plain dates, numeric counts (`extraction-benchmark.test.ts`); unmapped columns already read «حقل إضافي N»; the generic path now shows a plain date too |
| B5 | Per-row source and verification status | DONE | New column «حساب موثّق» for posts, comments and videos, only when the source returned a verification flag; companies and people keep their email and phone verification columns |
| B6 | Decision makers field by field | DONE | Replay: only requested fields that came back are charged (4 base, 3 email, 2 phone units), a person with none costs nothing, a duplicate person is dropped |
| B7 | Offline benchmark harness | DONE | `scripts/extraction-benchmark.ts`, fixtures in `tests/fixtures/extraction`, output committed as `docs/EXTRACTION_BENCHMARK.md` and checked by a test |

### Benchmark table

| Capability | Rows in | Duplicates | Delivered | Review | Rejected | Agreement (after) | False deliveries | Lost matches | Latin headers | Format issues | Before this change |
|---|---|---|---|---|---|---|---|---|---|---|---|
| icypeas-companies-search | 16 | 1 | 4 | 7 | 4 | 16/16 (100%) | 0 | 0 | 0 | 0 | 13/16, wrong 1, lost 2 |
| social-facebook-comments | 8 | 0 | 5 | 0 | 3 | 8/8 (100%) | 0 | 0 | 0 | 0 | 5/8, wrong 0, lost 3 |
| social-facebook-posts | 5 | 0 | 2 | 1 | 2 | 5/5 (100%) | 0 | 0 | 0 | 0 | 3/5, wrong 0, lost 1 |
| professional-people-search | 8 | 1 | 6 | 0 | 1 | 8/8 (100%) | 0 | 0 | 0 | 0 | 6/8, wrong 2, lost 0 |
| social-tiktok-comments | 10 | 1 | 4 | 1 | 4 | 10/10 (100%) | 0 | 0 | 0 | 0 | 8/10, wrong 1, lost 1 |
| social-tiktok-videos | 8 | 0 | 5 | 0 | 3 | 8/8 (100%) | 0 | 0 | 0 | 0 | 8/8, wrong 0, lost 0 |
| social-x-posts | 16 | 1 | 5 | 4 | 6 | 16/16 (100%) | 0 | 0 | 0 | 0 | 11/16, wrong 4, lost 1 |
| social-youtube-comments | 8 | 0 | 3 | 2 | 3 | 8/8 (100%) | 0 | 0 | 0 | 0 | 4/8, wrong 2, lost 2 |
| social-youtube-videos | 6 | 0 | 3 | 1 | 2 | 6/6 (100%) | 0 | 0 | 0 | 0 | 3/6, wrong 1, lost 2 |
| **Total** | 85 | 4 | 37 | 16 | 28 | 85/85 (100%) | 0 | 0 | | | 61/85, wrong 11, lost 12 |

"Before" is the gate and de-duplication of main `e7cf565` run on the same fixtures. The rows are synthetic and the rules were
tuned against them, so the perfect score proves the rules behave as written and guards against regressions; it is not a
measured accuracy on real customer data.

## C. Better planning: DONE

`src/lib/planExplanation.ts` writes, from the priced quote, what will be delivered (formats, count, review sheet not charged),
the cost range (from one matching record to the whole count, with the temporary hold) and, when the customer gave no number,
the sample size that was proposed. At most one question per turn (tested on three unclear requests). A large social plan keeps
the priced exploration offer (tested: 500 tweets). Each research request is still read from its own message first (tested).
`tests/planning-quality.test.ts` (8).

## D. Tests: DONE

Counts above; no regression in earlier feature tests.

## Remaining risks

- The limits store does nothing until the migration is applied by hand. Until then the platform runs on 0.80 USD per day and
  the tab says so.
- A limit of 0 stops all provider spend, and per-job or per-user ceilings stop jobs mid-way: matching rows already collected
  are kept and charged, the rest is released.
- The gate is stricter on partial topic matches: such rows now go to the review sheet (not charged) instead of being delivered,
  so some jobs deliver fewer rows than before.
- Feed jobs now stop earlier when pages stop matching, so they can end as partial.
- A company is treated as a repeat when it shares a website domain with an earlier one; two distinct companies on one domain
  would count as one.
- Benchmark rows are synthetic; real rejections should be added as fixtures.

## Owner TODO

1. Read `docs/APPLY_MIGRATIONS_4.md` and the SQL above, apply the one migration by hand, run its verification SELECT.
2. Open «مزودو الخدمة» and check the limits tab shows no «غير جاهز» notice, then set the limits you want.
3. Clean the test accounts through `docs/OWNER_SQL.md` before launch, run the Codex browser test again, then launch.
