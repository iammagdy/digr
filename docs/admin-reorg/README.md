# Admin reorganisation (layout and navigation only)

No API, SQL, money logic, key-pool behaviour, worker, price, customer page or customer text changed. No admin address moved: every `/admin/...` link opens the same page as before.

## Old → new navigation (20 pages, all kept, same addresses)

| Section (most used first) | Pages |
|---|---|
| نظرة عامة | نظرة عامة `/admin` · التشغيل `/admin/operations` · لوحة المؤتمر `/admin/conference` · الزوّار `/admin/visitors` |
| العملاء والطلبات | المستخدمون `/admin/users` · عمليات البحث `/admin/jobs` · رسائل الدعم `/admin/support` · طلبات غير مدعومة `/admin/requests` |
| الفلوس والشحن | طلبات الشحن `/admin/topups` · الإيرادات والأرباح `/admin/finance` · الأكواد الترويجية `/admin/promo-codes` |
| المزودون والمفاتيح | مزودو الخدمة `/admin/providers` · سجل الاستدعاءات `/admin/calls-log` |
| الوكيل والجودة | الوكيل `/admin/agent` · لوحة الأعطال `/admin/failures` · فحص المخطط `/admin/planner-selftest` · بحث عكسي `/admin/reverse-lookup` |
| الإعدادات | الإعدادات `/admin/settings` · سجل العمليات `/admin/audit` · نسخة احتياطية `/admin/export` |

Source of truth: `src/components/admin/nav.ts` (groups, one-line page descriptions, the old address list). `ADMIN_PAGES` in `icons.tsx` is unchanged.

«مزودو الخدمة» keeps its four provider tabs and each provider now has four short views: الحالة والرصيد · المفاتيح · الحدود · سجل المكالمات (the model provider: آخر النشاط). The address keeps the choice: `/admin/providers?p=treg&v=keys`; the plain address opens the TREG status view.

Screenshots in this folder were rendered in Chromium with the site's compiled CSS (`globals.css`) and the real components over fixture data: `keys-1280.png`, `keys-390.png`, `keys-menu-1280.png`, `providers-status-1280.png`, `providers-status-390.png`, `providers-calls-390.png`, `nav-drawer-390.png` (the logo image is missing there only because the harness does not serve `/public`).
