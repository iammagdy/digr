# ربط الدومين `diger.tech`

الكود جاهز للدومين. اللي فاضل خطوات إعدادات خارج الكود، بالترتيب:

## 1) متغيرات البيئة (على الـ Site في Appwrite)
| المتغير | القيمة |
|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://diger.tech` |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | `support@diger.tech` (لازم الصندوق يكون شغال) |
| `APP_URL` | `https://diger.tech` |

بعد ما تغيّرهم اعمل إعادة نشر (redeploy) للـ Site، لأن `NEXT_PUBLIC_*` بتتحط وقت البناء.

## 2) الدومين نفسه
1. في Appwrite ← Sites ← Domains ← أضف `diger.tech` وكمان `www.diger.tech`.
2. عند مسجّل الدومين أضف سجلات DNS اللي Appwrite هيطلبها (غالبًا `CNAME` أو `A` للـ apex و`CNAME` لـ `www`). الشهادة (HTTPS) بتتعمل أوتوماتيك بعد ما الـ DNS يتفعّل.
3. `www.diger.tech` بيتحوّل لـ `diger.tech` من `next.config.mjs` (redirect دائم).

## 3) Appwrite Platform (مهم جدًا، من غيره تسجيل الدخول بيفشل بـ CORS)
Appwrite ← Overview ← Platforms ← أضف Web platform بالـ hostname `diger.tech` (وكمان `www.diger.tech` لو هتفتحه). سيب الدومين القديم `digr.thewise.cloud` لحد ما تتأكد إن كل حاجة شغالة.

## 4) الكوكيز والجلسات
لو الـ endpoint بتاع Appwrite على دومين تاني (`fra.cloud.appwrite.io`) المتصفحات ممكن تحجب كوكي الجلسة كـ third-party. الأفضل تربط Custom Domain للـ API نفسه (مثلًا `api.diger.tech`) وتحط `NEXT_PUBLIC_APPWRITE_ENDPOINT=https://api.diger.tech/v1`.

## 5) البريد (تأكيد الحساب / استعادة كلمة المرور / الإشعارات)
- روابط الرسائل بتتبني على `NEXT_PUBLIC_SITE_URL`، فهتكون `https://diger.tech/verify` و`https://diger.tech/reset`.
- لو هتبعت من `@diger.tech` اضبط SMTP في Appwrite (Messaging ← Providers) وأضف `SPF` و`DKIM` و`DMARC` في الـ DNS، وإلا الرسائل هتروح Spam.

## 6) بعد النشر راجع
- `https://diger.tech/robots.txt` و`https://diger.tech/sitemap.xml`.
- مشاركة الرابط على واتساب/تويتر بتعرض الصورة (`/og-image.png`).
- تسجيل جديد ← وصول رسالة التأكيد ← الرابط بيفتح على `diger.tech`.
- `/dashboard` و`/admin` و`/api` فيهم `X-Robots-Tag: noindex`.
