-- Registry cleanup proposal only. This migration is intentionally not applied here.
-- Effective unit prices use the same formula as computeRegistryPointsPerUnit /
-- calculateCapabilityUnitPricePoints: ceil(unit USD x USD/EGP x markup / EGP per point).
-- The code defaults are 55, 10, and 0.10; compare deployment environment overrides before applying.
-- ON CONFLICT DO NOTHING preserves an existing disabled row as an intentional kill switch.
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
