-- Seed icypeas-companies-search and icypeas-people-search into capability_registry
-- Ensures Claude and the chat orchestration can always discover and quote these verified capabilities.

INSERT INTO public.capability_registry (
  slug, name_ar, description_ar, endpoint_id, unit_price_credits, enabled, category, name_en, pricing_unit, unit_cost_usd, max_rows, pagination_type, params_schema
) VALUES (
  'icypeas-companies-search',
  'بحث الشركات والمؤسسات التجارية',
  'البحث في بيانات ومعلومات وسجلات الشركات والمؤسسات التجارية',
  'icypeas.companies.search',
  3,
  true,
  'companies',
  'Company & Business Research',
  'item',
  0.00038,
  500,
  'none',
  '{"type":"object","properties":{"query":{"type":"object","description":"معايير تصفية الشركات"},"pagination":{"type":"object"}},"required":["query"]}'::jsonb
), (
  'icypeas-people-search',
  'بحث صناع القرار والمهنيين',
  'البحث في بيانات صناع القرار والمهنيين والمسؤولين التنفيذيين بالمسمى والشركة',
  'icypeas.people.search',
  3,
  true,
  'people',
  'Decision Makers & People Search',
  'item',
  0.00038,
  500,
  'none',
  '{"type":"object","properties":{"query":{"type":"object","description":"معايير تصفية صناع القرار"},"pagination":{"type":"object"}},"required":["query"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
  enabled = true,
  unit_price_credits = EXCLUDED.unit_price_credits,
  unit_cost_usd = EXCLUDED.unit_cost_usd,
  endpoint_id = EXCLUDED.endpoint_id;
