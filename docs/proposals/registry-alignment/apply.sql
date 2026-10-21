-- PROPOSAL (not applied, not in supabase/migrations). Aligns stale registry rows and the stale cap setting with the new per-record prices and the 5,000-point cap.
-- Effect on customers: NONE. The code decides the unit price of these six services (recordUnitPricePoints) and takes the larger row ceiling of a social service
-- (registryMaxRows = max(row, code)), so these rows are display/consistency only. Run AFTER the new release is deployed (the old release reads the row price).
-- Originals are in rollback.sql. Run each statement; each prints the rows it changed.

UPDATE public.capability_registry SET unit_price_credits = 0.275, max_rows = 20000 WHERE slug = 'social-youtube-comments' AND unit_price_credits = 9 AND max_rows = 1000 RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 0.275, max_rows = 20000 WHERE slug = 'social-tiktok-comments'  AND unit_price_credits = 6 AND max_rows = 1000 RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 1.034, max_rows = 5000  WHERE slug = 'social-facebook-comments' AND unit_price_credits = 11 AND max_rows = 500 RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 3.4485                  WHERE slug = 'social-facebook-posts'    AND unit_price_credits = 11 RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 3.168                   WHERE slug = 'icypeas-companies-search' AND unit_price_credits = 3  RETURNING slug, unit_price_credits, max_rows;

-- the legacy cap in the pricing setting (the worker no longer reads it; the admin screens may still show it)
UPDATE public.settings_private SET value = jsonb_set(value, '{jobMaxPointsCap}', '5000'::jsonb), updated_at = now()
WHERE key = 'pricing' AND (value ->> 'jobMaxPointsCap') = '600' RETURNING key, value -> 'jobMaxPointsCap' AS job_max_points_cap;

-- NOT changed on purpose: social-tiktok-videos (6, 200) and social-youtube-videos (5, 48) keep their whole-point price and ceiling; professional-people-search (83, 500);
-- icypeas-companies-search max_rows stays 500 (a company job is cut at 500 records, 1,584 points: the provider pattern above 500 records is not measured);
-- social-facebook-posts max_rows stays 60 (a page gives 10 posts per call); unit_cost_usd is a per-CALL number on these rows and is ignored for these services.
-- provider_limits.dailyUsd (0.9) is the live provider daily limit and wins over pricing.providerDailySpendCapUsd (0.8): change it from the admin screen, not here.
