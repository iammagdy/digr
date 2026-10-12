-- 1. Public Settings (Pricing)
INSERT INTO public.settings_public (key, value)
VALUES (
  'pricing',
  jsonb_build_object(
    'creditValueEgp', 0.10,
    'safetyBuffer', 0.15,
    'minPoints', 1,
    'markup', 10.0,
    'usdToEgp', 55.0
  )
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = NOW();

-- 2. Private Settings (Pricing & Provider Spend Cap)
INSERT INTO public.settings_private (key, value)
VALUES (
  'pricing',
  jsonb_build_object(
    'usdToEgp', 55.0,
    'markup', 10.0,
    'minMarginThreshold', 0.20,
    'providerDailySpendCapUsd', 0.80,
    'jobMaxPointsCap', 600
  )
)
ON CONFLICT (key) DO UPDATE
SET value = EXCLUDED.value, updated_at = NOW();

-- 3. Capability Registry (Only tiktok-profile enabled)
INSERT INTO public.capability_registry (slug, name_ar, description_ar, endpoint_id, unit_price_credits, enabled)
VALUES
  ('tiktok-profile', 'استخراج ملف تيك توك الشخصي', 'استخراج الإحصائيات الشاملة والنبذة التعريفية وحالة التوثيق لحساب تيك توك عام', 'tikhub.tiktok.user.profile', 6, true),
  ('tiktok-user-videos', 'مقاطع فيديو مستخدم تيك توك', 'استخراج أحدث مقاطع الفيديو المنشورة في حساب تيك توك عام مع إحصائيات المشاهدة والتفاعل', 'tikhub.tiktok.user.posts', 2, false),
  ('tiktok-keyword-videos', 'بحث مقاطع تيك توك بالكلمات الدلالية', 'البحث عن مقاطع تيك توك حسب الكلمات المفتاحية والوسوم', 'tikhub.tiktok.search.video', 2, false),
  ('x-user-tweets', 'تغريدات مستخدم منصة X', 'استخراج التغريدات الأخيرة لحساب مستخدم على منصة X', 'twitter.user.tweets', 2, false),
  ('x-keyword-search', 'بحث منشورات منصة X (تويتر)', 'البحث في المنشورات العامة على منصة X بالكلمات الدلالية', 'twitter.search.tweets', 2, false),
  ('instagram-profile', 'ملف إنستغرام الشخصي', 'استخراج بيانات الملف الشخصي وحالة الحساب على إنستغرام', 'instagram.user.profile', 7, false),
  ('instagram-user-posts', 'منشورات مستخدم إنستغرام', 'جمع أحدث المنشورات والصور لحساب إنستغرام عام', 'instagram.user.posts', 3, false),
  ('youtube-channel', 'بيانات قناة يوتيوب', 'استخراج إحصائيات قناة يوتيوب والمشتركين وقوائم التشغيل', 'youtube.channel.details', 6, false),
  ('youtube-video-search', 'بحث مقاطع يوتيوب', 'البحث في مقاطع الفيديو على يوتيوب واستخراج تفاصيل المقاطع', 'youtube.search.video', 3, false),
  ('facebook-page-posts', 'منشورات صفحة فيسبوك', 'استخراج منشورات صفحة عامة على فيسبوك وتفاعلات المتابعين', 'facebook.page.posts', 3, false),
  ('google-serp-search', 'نتائج بحث جوجل (SERP)', 'استخراج النتائج العضوية من محرك بحث جوجل', 'google.serp.organic', 11, false),
  ('telegram-channel-posts', 'رسائل قناة تيليجرام', 'استخراج الرسائل والمنشورات العامة من قناة تيليجرام', 'telegram.channel.messages', 2, false)
ON CONFLICT (slug) DO UPDATE
SET 
  name_ar = EXCLUDED.name_ar,
  description_ar = EXCLUDED.description_ar,
  endpoint_id = EXCLUDED.endpoint_id,
  unit_price_credits = EXCLUDED.unit_price_credits,
  enabled = EXCLUDED.enabled;

-- 4. Templates
INSERT INTO public.templates (id, title_ar, prompt_ar, category, enabled)
VALUES
  ('tiktok-profile', 'ملف تيك توك الشخصي', 'استخراج بيانات الملف الشخصي لحساب تيك توك عام مع إحصائيات المتابعين والمشاهدات', 'tiktok', true),
  ('tiktok-user-videos', 'فيديوهات حساب تيك توك', 'جمع أحدث مقاطع الفيديو لحساب تيك توك مع معدلات التفاعل والمشاهدات', 'tiktok', false),
  ('x-keyword-search', 'بحث منشورات X (تويتر)', 'البحث في تغريدات ومنشورات منصة X بكلمة مفتاحية محددة', 'x', false),
  ('instagram-profile', 'ملف إنستغرام الشخصي', 'استخراج بيانات حساب إنستغرام العام مع عدد المتابعين والتفاعل', 'instagram', false),
  ('youtube-channel', 'بيانات قناة يوتيوب', 'استخراج إحصائيات قناة يوتيوب والمشتركين وقوائم التشغيل', 'youtube', false),
  ('facebook-page-posts', 'منشورات صفحة فيسبوك', 'استخراج منشورات صفحة عامة على فيسبوك وتفاعلات المتابعين', 'facebook', false)
ON CONFLICT (id) DO UPDATE
SET
  title_ar = EXCLUDED.title_ar,
  prompt_ar = EXCLUDED.prompt_ar,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled;
