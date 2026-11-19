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
