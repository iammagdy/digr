# Codex execution report 2

Date: 2026-10-17. PR [#81](https://github.com/iammagdy/digr/pull/81), branch `codex/quote-cap-and-money-atomic`, remains a draft and is not merged.

## Commit and verification

- Starting commit: `8882cf569ce9806b044615a5402cba145b68a5c2`.
- Implementation commit: `a64ae4de4e496d4f541a87392c6a3f7c7ddb9468`.
- Latest code/dependency commit before this report: `ab010da1978291cf671120bd63fdb3d9eb4ae189`.
- Vercel deployment for `ab010da1978291cf671120bd63fdb3d9eb4ae189`: `dpl_B9qthLCpGfPrLYibF71kQdkRiGAL`, observed moving from `QUEUED` to `BUILDING`; a READY deployment for this exact SHA was not yet confirmed at report creation.
- Baseline before this work: 1,168 tests in 133 files passed (inherited run evidence).
- After this work: `npm test` passed 1,184 tests in 136 files; `npx tsc --noEmit` passed; `npm run build` passed, including the client bundle check: 88 files scanned, zero client bundle secrets.
- Test suite measured 17.59 seconds (Vitest reported 17.59s); browser timings were not measured.
- No migrations were applied. No Supabase query/write, provider call, job, or browser session was run. No customer points or provider spend were incurred.

## Task status

| Task | Result | Evidence |
|---|---|---|
| 1. Decision-maker field pricing | PASS (code and automated tests); live execution NOT RUN | Catalog prices are converted by the existing points calculator. The quote stores base/email/phone points. Worker settlement sends only counts derived from delivered rows. Rows missing requested contact fields remain visible with an Arabic review status; rows with neither requested field contribute zero units. `tests/decision-maker-pricing.test.ts` covers email-only, phone-only, both, neither, reserve buffer, and the 600-point cap. `tests/money-migration-contract.test.ts` checks SQL security and pricing contracts. |
| 2. Atomic quote and top-up paths | PASS (code and automated tests); database integration NOT RUN | `planManager.ts` calls `create_quote_atomic`; the admin route calls `approve_topup_atomic` and `reject_topup_atomic`. Missing-function responses alone use the legacy path and log one short line; other database errors are propagated. `tests/atomic-rpc.test.ts` verifies installed-function, missing-function fallback, and non-missing error behavior. |
| 3. Migration guide | PASS | Exact order, one read-only verification SELECT per file, and rollback notes are in `docs/APPLY_MIGRATIONS.md`. Atomic quote/top-up files are described as safe before/after deployment because of the missing-function fallback. Field-level people settlement must be installed before running a people job. |
| 4. npm audit | PASS with 2 moderate findings remaining | Before safe updates: 6 findings (2 moderate, 2 high, 2 critical): `exceljs`, `next`, `postcss`, `sharp`, `tar`, `uuid`. After patch/minor updates: 2 moderate findings remain (`exceljs` and its `uuid` dependency); `npm audit` exits 1 for these remaining findings. See the dependency table below. |
| 5. Tests/build/type check/PR/deployment | PARTIAL | Tests/build/type check passed. Commits were pushed after the code, migration-guide, and dependency steps. PR body update and a READY deployment for the latest report-containing head are pending. The latest observed deployment for the latest code/dependency SHA was BUILDING. |
| 6. Live browser phase | NOT RUN | PR #81 is open and draft, `mergedAt` is null. Name-only environment check returned `DIGER_TEST_EMAIL set: False`, `DIGER_TEST_PASSWORD set: False`. Per the owner gate, no production browser, login, request, approval, or download was attempted. |

### Browser scenarios

All are **NOT RUN** because the required merge-to-main and test-account environment gates are unmet.

| Scenario | Result | Evidence/reason |
|---|---|---|
| a. TikTok starter, placeholder block, real handle plan | NOT RUN | PR not merged; both test credential variables unset. |
| b. Five electricity companies | NOT RUN | Same gate. |
| c. Five Egypt contracting companies | NOT RUN | Same gate; no quote/approval or provider request. |
| d. Ten Saudi IT companies | NOT RUN | Same gate; no provider request body or provider result exists. |
| e. Liechtenstein rockets and German software companies | NOT RUN | Same gate. |
| f. Decision-makers and field-by-field price wording | NOT RUN | Same gate; unit coverage is automated only. |
| g. Greeting, wait, plan edit, expiry | NOT RUN | Same gate; no live conversation timings. |
| h. Social plan cards | NOT RUN | Same gate. |
| i. Excel/PDF contents and 390×844 mobile view | NOT RUN | Same gate; no file or screenshot was downloaded. |
| j. Cron/worker completion | NOT RUN | Same gate; no live job was run. |

## Dependency audit detail

Initial audit snapshot: 2 moderate, 2 high, 2 critical. `npm audit fix` stayed within patch/minor updates where possible; Next resolved to 15.5.28, Sharp to 0.35.5, and tar to 7.5.22. PostCSS was pinned through an override to 8.5.30 to fix the nested Next.js copy. Current audit reports 2 moderate findings.

| Initial finding | Production reachability | Action/safest next step |
|---|---|---|
| `next` — critical initially | Direct production framework; reachable | Lockfile now uses 15.5.28 (within the existing `^15` range); current audit no longer flags it. |
| `postcss` — high initially | Build-time CSS processing; not a production request handler | Nested copy overridden to 8.5.30 (patch/minor); current audit no longer flags it. |
| `sharp` — high initially | Optional Next.js image optimization dependency; production-reachable when that route is used | Lockfile now uses 0.35.5; current audit no longer flags it. |
| `tar` — critical initially | Tailwind oxide dependency in the production dependency tree; used for build/package handling, not application request handling | Lockfile now uses 7.5.22; current audit no longer flags it. |
| `exceljs` — moderate | Direct production dependency used to generate result workbooks | Kept at 4.4.0. npm's suggested ExcelJS 3.4.0 is a breaking downgrade. No safe patch/minor fix was available in this audit; review an upstream fixed release or a compatible maintained replacement. |
| `uuid` — moderate, transitive under ExcelJS | Included in the production tree with ExcelJS. ExcelJS's bundled code imports `uuid.v4`; the advisory concerns v3/v5/v6 when a buffer is supplied, which this application path does not call. | Kept at 8.3.2 because raising it to 11 is a major override. ExcelJS upstream PR #3085 proposing uuid 11 remained draft when checked. Reassess after a released compatible ExcelJS update; do not force-install. |

## Spend and ledger evidence

- Jobs run: none. Raw ledger rows: none exist for this run, so there is no reserve/charge/release arithmetic to report.
- Provider calls and provider spend: zero for this run. This is run-local spend, not a read of the provider's daily budget.
- Points spent: zero.
- Remaining provider budget today: NOT RUN; no read-only provider-budget query was made.
- Browser measurements: NOT RUN; no live browser was opened.
- Enrichment call behavior from code inspection: each candidate missing email can trigger the email lookup; each candidate missing phone can trigger the phone lookup. Each lookup allows one retry, so a candidate missing both can produce up to four outbound attempts (two endpoint lookups × two attempts). Each attempt may already incur provider-side cost even if no contact field is returned. No live provider cost was measured in this run.

## Owner follow-up

1. Review the draft PR and SQL appendix below. Do not merge until the reviewer approves the field-level accounting and migration behavior.
2. Apply each migration in `docs/APPLY_MIGRATIONS.md` one by one, run its SELECT, and stop at the first failed verification. Do not apply anything from this run before approval.
3. After merge and migration verification, set the non-admin test account variables in the runner and run the live browser phase. Stop at approval buttons; no job is authorized by this report.
4. Decide how to resolve the remaining ExcelJS/uuid moderate findings after an upstream compatible release or a reviewed replacement is available.

## Unverified and risky

- Catalog prices for the people search/email/phone endpoints were not queried live. If an endpoint has no catalog price, quote creation fails closed. The plan-level tests use mocked catalog prices only.
- None of the SQL was applied or executed against the live schema. Static tests check the required privileges and key expressions, not PostgreSQL execution or the actual column types in the live project.
- The previous-production job failure and ledger state were not queried in this run.
- The Vercel deployment for the latest code commit was observed queued, not READY, at the time recorded above. Vercel can still fail its remote build even though local build passed.
- The decision-maker RPC is required before the new code executes a decision-maker job; unlike quote/top-up RPCs, it intentionally does not fall back to the old flat-price settlement.

## SQL appendix

The exact migration files and full contents are appended below from the working tree. They are proposals only and were not applied.

### supabase/migrations/20261017150000_register_professional_people_search.sql

````sql
-- OPTIONAL. Not applied by the agent; the owner applies it if wanted.
--
-- The decision-maker service ("professional-people-search") is served from the reviewed code catalog while
-- the registry has no row for it (see getEnabledCapabilitiesWithCoreServices). Registering the row gives
-- the admin a switch for it and makes the live price visible in the registry. The code treats a disabled
-- row as a kill switch and never re-adds the service over it.
--
-- unit_price_credits = ceil(0.015 USD x 55 x 10 / 0.10) = 83 points per delivered person record.
-- The legacy "icypeas-people-search" entry is switched off: its execution path was found unreliable in live
-- testing and the code keeps it blocked (UNAVAILABLE_CAPABILITY_SLUGS).

INSERT INTO public.capability_registry
  (slug, name_ar, description_ar, endpoint_id, unit_price_credits, enabled, category, name_en, pricing_unit, unit_cost_usd, max_rows, pagination_type)
VALUES
  ('professional-people-search',
   'بحث وإثراء بيانات المهنيين',
   'البحث عن المهنيين وإثراء السجلات ببريد العمل ورقم الهاتف عند توفرهما من المصادر.',
   'treg.people.search',
   83,
   true,
   'people',
   'People Search and Contact Enrichment',
   'item',
   0.015,
   500,
   'none')
ON CONFLICT (slug) DO NOTHING;

UPDATE public.capability_registry
SET enabled = false
WHERE slug = 'icypeas-people-search';
````

### supabase/migrations/20261017175000_cleanup_capability_registry_social.sql

````sql
-- Registry cleanup proposal only. This migration is intentionally not applied here.
-- Effective unit prices use the same formula as computeRegistryPointsPerUnit /
-- calculateCapabilityUnitPricePoints: ceil(unit USD x USD/EGP x markup / EGP per point).
-- The code defaults are 55, 10, and 0.10; compare deployment environment overrides before applying.
-- ON CONFLICT DO NOTHING preserves an existing disabled row as an intentional kill switch.
-- Preserve exact pre-migration rows so rollback can restore disabled endpoints and any
-- capability with a colliding slug without guessing live registry column values.
CREATE TABLE IF NOT EXISTS public.capability_registry_backup_20261017175000 (
  slug text PRIMARY KEY,
  row_data jsonb NOT NULL
);
INSERT INTO public.capability_registry_backup_20261017175000(slug,row_data)
SELECT r.slug,to_jsonb(r)
FROM public.capability_registry r
WHERE r.endpoint_id = ANY (ARRAY[
  'facebook.page.posts','google.serp.organic','instagram.user.profile','instagram.user.posts',
  'telegram.channel.messages','tikhub.tiktok.search.video','tikhub.tiktok.user.posts',
  'twitter.search.tweets','twitter.user.tweets','youtube.channel.details','youtube.search.video',
  'internal-facebook-post-comments','internal-youtube-comments'
]) OR r.slug = ANY (ARRAY[
  'social-tiktok-comments','social-youtube-comments','social-facebook-comments',
  'social-tiktok-videos','social-youtube-videos','social-facebook-posts'
])
ON CONFLICT (slug) DO NOTHING;
REVOKE ALL ON TABLE public.capability_registry_backup_20261017175000 FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.capability_registry_backup_20261017175000 TO service_role;
WITH pricing AS (SELECT 55.0::numeric AS usd_to_egp, 10.0::numeric AS markup, 0.10::numeric AS point_value_egp),
capabilities(slug,name_ar,description_ar,endpoint_id,unit_cost_usd,customer_usd,max_rows,category,name_en,params_schema) AS (
  VALUES
    ('social-tiktok-comments','استخراج تعليقات فيديوهات تيك توك','سحب تعليقات مقاطع تيك توك المحددة أو المكتشفة من المصادر المتاحة.','tikhub.tiktok.video.comments',0.001::numeric,0.001::numeric,1000,'tiktok','TikTok comments','{"type":"object","properties":{"url":{"type":"string"},"query":{"type":"string"},"channel":{"type":"string"},"trending":{"type":"boolean"},"region":{"type":"string"}}}'::jsonb),
    ('social-youtube-comments','استخراج تعليقات مقاطع يوتيوب','سحب تعليقات مقاطع يوتيوب المحددة أو المكتشفة من المصادر المتاحة.','crawl4ai.youtube.video.comments',0.0009,0.0015,1000,'youtube','YouTube comments','{"type":"object","properties":{"url":{"type":"string"},"query":{"type":"string"},"channel":{"type":"string"},"trending":{"type":"boolean"},"region":{"type":"string"}}}'::jsonb),
    ('social-facebook-comments','استخراج تعليقات منشورات فيسبوك','سحب تعليقات منشورات فيسبوك العامة من المصادر المتاحة.','scrapecreators.x.v1-facebook-post-comments',0.00188,0.0019,500,'facebook','Facebook comments','{"type":"object","properties":{"url":{"type":"string"},"channel":{"type":"string"}}}'::jsonb),
    ('social-tiktok-videos','استخراج فيديوهات تيك توك','استخراج فيديوهات تيك توك بحسب البحث أو القناة أو الدولة.','tikhub.tiktok.search.videos',0.001::numeric,0.001::numeric,200,'tiktok','TikTok videos','{"type":"object","properties":{"query":{"type":"string"},"channel":{"type":"string"},"trending":{"type":"boolean"},"region":{"type":"string"}}}'::jsonb),
    ('social-youtube-videos','استخراج مقاطع يوتيوب','استخراج مقاطع يوتيوب بحسب البحث أو القناة أو المقاطع الرائجة.','crawl4ai.youtube.search.videos',0.0009,0.0009,48,'youtube','YouTube videos','{"type":"object","properties":{"query":{"type":"string"},"channel":{"type":"string"},"trending":{"type":"boolean"}}}'::jsonb),
    ('social-facebook-posts','استخراج منشورات صفحة فيسبوك','استخراج منشورات صفحة فيسبوك العامة.','anyapi.facebook.user.posts',0.002::numeric,0.002::numeric,60,'facebook','Facebook page posts','{"type":"object","properties":{"channel":{"type":"string"}}}'::jsonb)
)
INSERT INTO public.capability_registry
  (slug,name_ar,description_ar,endpoint_id,unit_price_credits,enabled,category,name_en,pricing_unit,unit_cost_usd,max_rows,pagination_type,params_schema)
SELECT c.slug,c.name_ar,c.description_ar,c.endpoint_id,
       GREATEST(1,CEIL(c.customer_usd*p.usd_to_egp*p.markup/p.point_value_egp)),
       true,c.category,c.name_en,'item',c.unit_cost_usd,c.max_rows,'cursor',c.params_schema
FROM capabilities c CROSS JOIN pricing p
ON CONFLICT (slug) DO NOTHING;

DELETE FROM public.capability_registry
WHERE endpoint_id = ANY (ARRAY[
  'facebook.page.posts','google.serp.organic','instagram.user.profile','instagram.user.posts',
  'telegram.channel.messages','tikhub.tiktok.search.video','tikhub.tiktok.user.posts',
  'twitter.search.tweets','twitter.user.tweets','youtube.channel.details','youtube.search.video',
  'internal-facebook-post-comments','internal-youtube-comments'
]);
````

### supabase/migrations/20261017175500_settle_completed_jobs_with_stale_lease.sql

````sql
-- Recovery migration proposal: allow settlement after persisted collection completion even if a stale lease remains.

CREATE OR REPLACE FUNCTION public.settle_job_atomic(
  p_job_id TEXT,
  p_points_cap NUMERIC DEFAULT 600,
  p_result_file_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_raw_charge NUMERIC;
  v_final_charge NUMERIC;
  v_rel_exists BOOLEAN;
  v_chg_exists BOOLEAN;
BEGIN
  -- 1. Lock job row
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  -- 2. Idempotency check: if already completed, return current state
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'job_id', p_job_id,
      'charged_credits', v_job.charged_credits,
      'delivered_units', v_job.delivered_units
    );
  END IF;

  -- 3. Strict status requirement: must be currently running
  IF v_job.status != 'running' THEN
    RAISE EXCEPTION 'Cannot settle job % with status % (must be running)', p_job_id, v_job.status;
  END IF;

  -- A live lease blocks settlement while collection is incomplete. Once the worker has
  -- persisted the terminal cursor or delivered the requested maximum, collection is final;
  -- claim_job_chunk rejects further claims in that state, so retire any stale lease and settle.
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) THEN
    IF v_job.current_cursor = 'completed' OR
       (v_job.target_volume_max IS NOT NULL AND COALESCE(v_job.delivered_units, 0) >= v_job.target_volume_max) THEN
      UPDATE public.jobs SET lease_until = NULL, updated_at = timezone('utc'::text, now()) WHERE id = p_job_id;
    ELSE
      RAISE EXCEPTION 'Cannot settle job % while active chunk lease is held until %', p_job_id, v_job.lease_until;
    END IF;
  END IF;

  -- 5. Unit price integrity: must be present and positive (no default fallback)
  IF v_job.unit_price IS NULL OR v_job.unit_price <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid unit_price: %', p_job_id, v_job.unit_price;
  END IF;

  -- 6. Accounting integrity check: reserve must exist in ledger
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  -- 7. Release hold first: insert rel_<jobId> if not already present
  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('rel_' || p_job_id)
  ) INTO v_rel_exists;

  IF NOT v_rel_exists THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'rel_' || p_job_id,
      v_job.user_id,
      v_job.reserved_credits,
      'release',
      p_job_id,
      'إرجاع الحجز عند التسوية النهائية للمهمة',
      timezone('utc'::text, now())
    );
  END IF;

  -- 8. Calculate charge from stored DB values
  v_raw_charge := CEIL(COALESCE(v_job.delivered_units, 0) * v_job.unit_price);
  v_final_charge := LEAST(v_raw_charge, v_job.reserved_credits, p_points_cap);

  -- 9. Debit actual charge: insert chg_<jobId> if not already present
  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('chg_' || p_job_id)
  ) INTO v_chg_exists;

  IF NOT v_chg_exists AND v_final_charge > 0 THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'chg_' || p_job_id,
      v_job.user_id,
      -v_final_charge,
      'charge',
      p_job_id,
      'خصم تكلفة النتائج المسلمة',
      timezone('utc'::text, now())
    );
  END IF;

  -- 10. Finalize job status
  UPDATE public.jobs
  SET status = 'completed',
      charged_credits = v_final_charge,
      result_file_id = COALESCE(p_result_file_id, result_file_id),
      lease_until = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'job_id', p_job_id,
    'user_id', v_job.user_id,
    'reserved_credits', v_job.reserved_credits,
    'charged_credits', v_final_charge,
    'delivered_units', v_job.delivered_units
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_job_atomic(
  p_job_id TEXT,
  p_error_message TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job RECORD;
  v_rel_exists BOOLEAN;
BEGIN
  -- 1. Lock job row
  SELECT * INTO v_job
  FROM public.jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job % not found', p_job_id;
  END IF;

  -- 2. Idempotency check: if already failed, return early
  IF v_job.status = 'failed' THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_released', true,
      'job_id', p_job_id,
      'released_credits', v_job.reserved_credits
    );
  END IF;

  IF v_job.status = 'completed' THEN
    RAISE EXCEPTION 'Cannot release already completed job %', p_job_id;
  END IF;

  -- 3. Accounting integrity check: reserve must exist in ledger
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 THEN
    RAISE EXCEPTION 'Job % has invalid reserved_credits', p_job_id;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = ('res_' || p_job_id)) THEN
    RAISE EXCEPTION 'Reserve record res_% does not exist for job %', p_job_id, p_job_id;
  END IF;

  -- 4. Release hold: insert rel_<jobId> if not already present
  SELECT EXISTS(
    SELECT 1 FROM public.credit_ledger WHERE id = ('rel_' || p_job_id)
  ) INTO v_rel_exists;

  IF NOT v_rel_exists THEN
    INSERT INTO public.credit_ledger (
      id,
      user_id,
      delta,
      type,
      job_id,
      note,
      created_at
    )
    VALUES (
      'rel_' || p_job_id,
      v_job.user_id,
      v_job.reserved_credits,
      'release',
      p_job_id,
      'إرجاع الحجز بالكامل عند تعثر المهمة',
      timezone('utc'::text, now())
    );
  END IF;

  -- 5. Mark job failed (zero charge debit)
  UPDATE public.jobs
  SET status = 'failed',
      charged_credits = 0,
      error_message = COALESCE(p_error_message, error_message, 'فشلت المهمة'),
      lease_until = NULL,
      updated_at = timezone('utc'::text, now())
  WHERE id = p_job_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_released', false,
    'job_id', p_job_id,
    'user_id', v_job.user_id,
    'released_credits', v_job.reserved_credits
  );
END;
$$;

REVOKE ALL ON FUNCTION public.settle_job_atomic(TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_job_atomic(TEXT, NUMERIC, TEXT) TO service_role;

REVOKE ALL ON FUNCTION public.release_job_atomic(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_job_atomic(TEXT, TEXT) TO service_role;
````

### supabase/migrations/20261017180000_create_quote_atomic.sql

````sql
-- Proposal only; do not apply until the owner reviews the matching caller change.
-- The function stores server-computed items and prices and never accepts an LLM price.
CREATE OR REPLACE FUNCTION public.create_quote_atomic(
  p_user_id uuid,
  p_quote_id text,
  p_quote_hash text,
  p_items jsonb,
  p_total_points numeric,
  p_output_formats text[],
  p_expires_at timestamptz,
  p_previous_quote_ids text[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cap numeric := 600;
  v_existing public.plans_quotes%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR NULLIF(btrim(p_quote_id), '') IS NULL OR NULLIF(btrim(p_quote_hash), '') IS NULL THEN
    RAISE EXCEPTION 'user, quote id, and quote hash are required';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'quote items must be a non-empty JSON array';
  END IF;
  IF p_total_points IS NULL OR p_total_points <= 0 OR p_total_points > v_cap THEN
    RAISE EXCEPTION 'quote reserve must be between 0 and % points', v_cap;
  END IF;
  IF p_output_formats IS NULL OR cardinality(p_output_formats) = 0 OR
     EXISTS (SELECT 1 FROM unnest(p_output_formats) f WHERE f NOT IN ('xlsx','csv','pdf')) THEN
    RAISE EXCEPTION 'unsupported output formats';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'quote expiry must be in the future';
  END IF;

  -- Lock the user's profile, then supersede only the prior quotes for this conversation
  -- whose IDs the server resolved from its authenticated messages table.
  PERFORM 1 FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quote owner profile does not exist';
  END IF;
  SELECT * INTO v_existing FROM public.plans_quotes WHERE id = p_quote_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
       OR v_existing.quote_hash IS DISTINCT FROM p_quote_hash
       OR v_existing.items IS DISTINCT FROM p_items
       OR v_existing.total_reserved_credits IS DISTINCT FROM p_total_points THEN
      RAISE EXCEPTION 'quote idempotency conflict for %', p_quote_id;
    END IF;
    RETURN jsonb_build_object('success',true,'quote_id',p_quote_id,
      'status',v_existing.status,'total_reserved_credits',v_existing.total_reserved_credits,
      'expires_at',v_existing.expires_at,'already_created',true);
  END IF;
  PERFORM 1 FROM public.plans_quotes
  WHERE user_id = p_user_id AND status = 'quoted'
    AND id = ANY(COALESCE(p_previous_quote_ids, '{}'::text[]))
  FOR UPDATE;
  UPDATE public.plans_quotes
  SET status = 'expired'
  WHERE user_id = p_user_id
    AND status = 'quoted'
    AND id = ANY(COALESCE(p_previous_quote_ids, '{}'::text[]));

  INSERT INTO public.plans_quotes
    (id,user_id,quote_hash,status,items,total_reserved_credits,output_formats,expires_at,created_at)
  VALUES
    (p_quote_id,p_user_id,p_quote_hash,'quoted',p_items,p_total_points,to_jsonb(p_output_formats),p_expires_at,now());

  RETURN jsonb_build_object('success',true,'quote_id',p_quote_id,'status','quoted','total_reserved_credits',p_total_points,'expires_at',p_expires_at);
END;
$$;

REVOKE ALL ON FUNCTION public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_quote_atomic(uuid,text,text,jsonb,numeric,text[],timestamptz,text[]) TO service_role;
````

### supabase/migrations/20261017180500_approve_topup_atomic_privileges.sql

````sql
-- Proposal only: atomic top-up approval and rejection with service_role-only execution.
CREATE OR REPLACE FUNCTION public.approve_topup_atomic(
  p_topup_id text,
  p_confirmed_amount_egp numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topup record;
  v_effective_amount numeric;
  v_credit_value_egp numeric := 0.1;
  v_credits integer;
  v_ledger_id text;
  v_existing_ledger record;
  v_new_balance numeric;
BEGIN
  -- 1. Lock topup row FOR UPDATE
  SELECT * INTO v_topup
  FROM public.topups
  WHERE id = p_topup_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_found', 'error_ar', 'طلب الشحن غير موجود.');
  END IF;

  -- 2. Idempotency check: if already approved, return early with current balance
  IF v_topup.status = 'approved' THEN
    SELECT COALESCE(SUM(delta), 0) INTO v_new_balance
    FROM public.credit_ledger WHERE user_id = v_topup.user_id;

    RETURN jsonb_build_object(
      'success', true,
      'already_approved', true,
      'user_id', v_topup.user_id,
      'amount_egp', v_topup.amount_egp,
      'balance', v_new_balance
    );
  END IF;

  IF v_topup.status != 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status', 'error_ar', 'لا يمكن اعتماد طلب بحالة: ' || v_topup.status);
  END IF;

  -- 3. Exact matching credit conversion calculation
  v_effective_amount := COALESCE(p_confirmed_amount_egp, v_topup.amount_egp);
  IF v_effective_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_amount', 'error_ar', 'مبلغ الشحن يجب أن يكون أكبر من الصفر.');
  END IF;

  SELECT (value->>'creditValueEgp')::numeric INTO v_credit_value_egp
  FROM public.settings_public WHERE key = 'pricing';
  IF v_credit_value_egp IS NULL OR v_credit_value_egp <= 0 THEN
    v_credit_value_egp := 0.1;
  END IF;

  v_credits := floor(v_effective_amount / v_credit_value_egp)::integer;

  -- 4. Ledger conflict verification: check existing row matching user & amount
  v_ledger_id := 'top_' || p_topup_id;
  SELECT user_id, delta INTO v_existing_ledger
  FROM public.credit_ledger
  WHERE id = v_ledger_id;

  IF FOUND THEN
    IF v_existing_ledger.user_id != v_topup.user_id OR v_existing_ledger.delta != v_credits THEN
      RAISE EXCEPTION 'ledger_conflict: existing row % has mismatched user or delta', v_ledger_id;
    END IF;
  ELSE
    INSERT INTO public.credit_ledger (id, user_id, delta, type, note)
    VALUES (
      v_ledger_id,
      v_topup.user_id,
      v_credits,
      'topup',
      'شحن رصيد (طلب: ' || p_topup_id || '، مرجع: ' || COALESCE(v_topup.reference, '-') || ')'
    );
  END IF;

  -- 5. Update topup status to approved (only real columns in public.topups)
  UPDATE public.topups
  SET 
    status = 'approved',
    amount_egp = v_effective_amount
  WHERE id = p_topup_id;

  SELECT COALESCE(SUM(delta), 0) INTO v_new_balance
  FROM public.credit_ledger WHERE user_id = v_topup.user_id;

  RETURN jsonb_build_object(
    'success', true,
    'already_approved', false,
    'user_id', v_topup.user_id,
    'credits', v_credits,
    'effective_amount_egp', v_effective_amount,
    'balance', v_new_balance
  );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_topup_atomic(text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_topup_atomic(text, numeric) TO service_role;

CREATE OR REPLACE FUNCTION public.reject_topup_atomic(p_topup_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_topup public.topups%ROWTYPE;
BEGIN
  SELECT * INTO v_topup FROM public.topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'topup_not_found');
  END IF;
  IF v_topup.status = 'rejected' THEN
    RETURN jsonb_build_object('success', true, 'already_rejected', true, 'topup_id', p_topup_id);
  END IF;
  IF v_topup.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_status');
  END IF;
  UPDATE public.topups SET status = 'rejected' WHERE id = p_topup_id;
  RETURN jsonb_build_object('success', true, 'already_rejected', false, 'topup_id', p_topup_id);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_topup_atomic(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_topup_atomic(text) TO service_role;
````

### supabase/migrations/20261017181000_settle_decision_maker_fields.sql

````sql
-- Proposal only. Computes field-level charges from the server-priced accepted quote.
CREATE OR REPLACE FUNCTION public.settle_people_job_atomic(
  p_job_id text,
  p_base_units integer,
  p_email_units integer,
  p_phone_units integer,
  p_points_cap numeric DEFAULT 600,
  p_result_file_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_quote public.plans_quotes%ROWTYPE;
  v_item jsonb;
  v_prices jsonb;
  v_base_price numeric;
  v_email_price numeric;
  v_phone_price numeric;
  v_raw_charge numeric;
  v_charge numeric;
  v_existing_charge numeric;
  v_requested_fields jsonb;
BEGIN
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job % not found', p_job_id; END IF;
  IF v_job.status = 'completed' THEN
    RETURN jsonb_build_object('success',true,'already_settled',true,'job_id',p_job_id,
      'charged_credits',v_job.charged_credits,'delivered_units',v_job.delivered_units);
  END IF;
  IF v_job.status <> 'running' THEN RAISE EXCEPTION 'Job % is not running', p_job_id; END IF;
  IF v_job.lease_until IS NOT NULL AND v_job.lease_until > timezone('utc'::text, now()) THEN
    IF v_job.current_cursor = 'completed' OR
       (v_job.target_volume_max IS NOT NULL AND COALESCE(v_job.delivered_units,0) >= v_job.target_volume_max) THEN
      UPDATE public.jobs SET lease_until = NULL, updated_at = timezone('utc'::text,now()) WHERE id = p_job_id;
    ELSE
      RAISE EXCEPTION 'Cannot settle job % while collection is incomplete', p_job_id;
    END IF;
  END IF;
  IF p_base_units < 0 OR p_email_units < 0 OR p_phone_units < 0 OR
     p_base_units > COALESCE(v_job.delivered_units,0) OR p_email_units > p_base_units OR p_phone_units > p_base_units THEN
    RAISE EXCEPTION 'Invalid delivered contact units for job %', p_job_id;
  END IF;
  IF v_job.reserved_credits IS NULL OR v_job.reserved_credits <= 0 OR
     NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'res_' || p_job_id) THEN
    RAISE EXCEPTION 'Job % has no valid credit reserve', p_job_id;
  END IF;
  SELECT * INTO v_quote FROM public.plans_quotes
  WHERE 'job_quote_' || md5(id) = p_job_id AND user_id = v_job.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Accepted quote for job % not found', p_job_id; END IF;
  IF v_quote.status <> 'accepted' THEN RAISE EXCEPTION 'Quote for job % is not accepted', p_job_id; END IF;
  v_item := v_quote.items -> 0;
  v_requested_fields := v_item -> 'params' -> 'requiredContactFields';
  IF (p_email_units > 0 AND NOT (COALESCE(v_requested_fields, '[]'::jsonb) @> '["work_email"]'::jsonb)) OR
     (p_phone_units > 0 AND NOT (COALESCE(v_requested_fields, '[]'::jsonb) @> '["phone"]'::jsonb)) OR
     p_base_units < GREATEST(p_email_units,p_phone_units) OR
     p_base_units > p_email_units + p_phone_units THEN
    RAISE EXCEPTION 'Delivered contact units do not match requested fields for job %', p_job_id;
  END IF;
  v_prices := v_item -> 'contactUnitPricesPoints';
  IF jsonb_typeof(v_prices) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Quote for job % has no contact field prices', p_job_id;
  END IF;
  v_base_price := (v_prices ->> 'basePerson')::numeric;
  v_email_price := (v_prices ->> 'workEmail')::numeric;
  v_phone_price := (v_prices ->> 'phone')::numeric;
  IF v_base_price IS NULL OR v_email_price IS NULL OR v_phone_price IS NULL OR
     v_base_price <= 0 OR v_email_price <= 0 OR v_phone_price <= 0 THEN
    RAISE EXCEPTION 'Quote for job % has invalid contact field prices', p_job_id;
  END IF;
  v_raw_charge := CEIL(p_base_units*v_base_price + p_email_units*v_email_price + p_phone_units*v_phone_price);
  v_charge := LEAST(v_raw_charge, v_job.reserved_credits, COALESCE(p_points_cap,600), 600);
  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger WHERE id = 'rel_' || p_job_id) THEN
    INSERT INTO public.credit_ledger(id,user_id,delta,type,job_id,note,created_at)
    VALUES ('rel_' || p_job_id,v_job.user_id,v_job.reserved_credits,'release',p_job_id,
      'إرجاع الرصيد المحجوز بعد التسوية',timezone('utc'::text,now()));
  END IF;
  IF v_charge > 0 THEN
    SELECT delta INTO v_existing_charge FROM public.credit_ledger WHERE id = 'chg_' || p_job_id FOR UPDATE;
    IF FOUND THEN
      IF v_existing_charge IS DISTINCT FROM -v_charge THEN RAISE EXCEPTION 'Charge ledger conflict for job %', p_job_id; END IF;
    ELSE
      INSERT INTO public.credit_ledger(id,user_id,delta,type,job_id,note,created_at)
      VALUES ('chg_' || p_job_id,v_job.user_id,-v_charge,'charge',p_job_id,
        'خصم السجلات وحقول التواصل المعادة',timezone('utc'::text,now()));
    END IF;
  END IF;
  UPDATE public.jobs SET status='completed', charged_credits=v_charge,
    result_file_id=COALESCE(p_result_file_id,result_file_id), lease_until=NULL,
    updated_at=timezone('utc'::text,now()) WHERE id=p_job_id;
  RETURN jsonb_build_object('success',true,'already_settled',false,'job_id',p_job_id,
    'reserved_credits',v_job.reserved_credits,'charged_credits',v_charge,
    'base_units',p_base_units,'email_units',p_email_units,'phone_units',p_phone_units,
    'delivered_units',v_job.delivered_units);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_people_job_atomic(text,integer,integer,integer,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_people_job_atomic(text,integer,integer,integer,numeric,text) TO service_role;
````
