-- ROLLBACK of apply.sql: restores the original values read on 2026-10-21 (SELECT only). Run BEFORE rolling the release back.
UPDATE public.capability_registry SET unit_price_credits = 9,  max_rows = 1000 WHERE slug = 'social-youtube-comments' RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 6,  max_rows = 1000 WHERE slug = 'social-tiktok-comments'  RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 11, max_rows = 500  WHERE slug = 'social-facebook-comments' RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 11                  WHERE slug = 'social-facebook-posts'    RETURNING slug, unit_price_credits, max_rows;
UPDATE public.capability_registry SET unit_price_credits = 3                   WHERE slug = 'icypeas-companies-search' RETURNING slug, unit_price_credits, max_rows;
UPDATE public.settings_private SET value = jsonb_set(value, '{jobMaxPointsCap}', '600'::jsonb), updated_at = now() WHERE key = 'pricing' AND (value ->> 'jobMaxPointsCap') = '5000' RETURNING key, value -> 'jobMaxPointsCap' AS job_max_points_cap;
