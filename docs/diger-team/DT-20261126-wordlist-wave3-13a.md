# DT-20261126-wordlist-wave3-13a — المرحلة 13A: فصل `walletEstimate` عن بطاقات الأدوات وضمان أمان حزمة المتصفح

## 1. ملخص التغيير والسبب
- **التكليف والمرجعية:** قرار مجز `D-0221` (تنفيذ المرحلة المالية `13A` بواسطة `جوني`)، وتكليف `DT-20261126-wordlist-wave3/O11` وفق خطة `tierA-v1.3-frozen.md` وتعديلات `A1–A6`.
- **الفرع والأساس:** `team/DT-20261126-wordlist-13a` فوق `origin/main` (`9b588cb4`).
- **لماذا:** فصل `src/lib/walletEstimate.ts` (المستورد مباشرةً داخل صفحة المتصفح `"use client"` في `src/app/dashboard/topup/page.tsx`) عن `src/lib/agentMission/foundation/toolCards/*` قبل حذفها في المرحلة `10`، وإزالة أسماء المزودين ومعرّفات الـ `endpoints` الثابتة منه إلى لقطة رقمية مولّدة (`data/treg/wallet_estimate_costs.json`) خالية من أي رموز مزودين أو وحدات خادم، مع الإبقاء على تطابق أرقام المحفظة بالبايت.

## 2. ما تم تنفيذه
1. **اختبار أمان المتصفح ومزامنة الأسعار (`13A-P01`):**
   - إنشاء `tests/wallet-estimate-browser.test.ts` للتحقق من شجرة الاستيراد العابرة لـ `src/lib/walletEstimate.ts` (صفر استيرادات `node:*`/`fs`/`path`/`crypto`/`child_process` أو `catalog.ts` أو `provider-metadata.json` أو `toolCards`)، ومن نقاء `data/treg/wallet_estimate_costs.json` (أرقام موجبة فقط، وصفر معرّفات أو أسماء مزودين/منصات)، وتطابق أرقامه مع `treg_catalog_sellable.json` + `treg.walletEstimateSlots`.
2. **بيانات `walletEstimateSlots` وسكربت المزامنة (`13A-P02`..`13A-P05`):**
   - إضافة كتلة `treg.walletEstimateSlots` داخل `data/capabilities/provider-metadata.json` وحفظها في `scripts/capabilities/sync-providers.ts`.
   - إنشاء `scripts/capabilities/sync-wallet-estimate.ts` (يدعم `--check`) وتوليد `data/treg/wallet_estimate_costs.json` (`175` بايت، `4` قيم رقمية صافية).
3. **تحديث `walletEstimate.ts` واختبار `round14` ومزامنة الحراسة (`13A-P06`..`13A-P08`):**
   - استبدال استيرادات `X_CARDS`/`YOUTUBE_CARDS` في `src/lib/walletEstimate.ts` بالاستيراد الثابت لـ `data/treg/wallet_estimate_costs.json` مع تحقق إخفاق آمن للقيم الموجبة وبقاء جميع الدوال والنصوص العربية وأرقام `walletCapacityOf` مطابقة بالبايت (`min=200`، `113=below_minimum`، `200=68/496`، `242=152/673`، `500=661/1761`، `1000=1649/3869`).
   - فك ارتباط `tests/round14-wallet-estimate.test.ts` عن `toolCards` بقراءة الأسعار من `data/treg/wallet_estimate_costs.json`.
   - مزامنة `tests/fixtures/design-guards-allow.json` (`treg_tokens: 461 -> 453`, `-8` في `src/lib/walletEstimate.ts`).

## 3. الإثبات
- اجتياز `tests/wallet-estimate-browser.test.ts` و`tests/round14-wallet-estimate.test.ts` و`tests/golden-quote-parity.test.ts` و`tests/design-guards.test.ts` و`npx tsx scripts/capabilities/sync-wallet-estimate.ts --check` و`npx tsx scripts/sync-design-guards-allow.ts --check` (`0 unallowed`, `0 stale`).
- استيفاء بوابة `D-0220` الكاملة (`vitest`، `tsc --noEmit`، `agent:typecheck`، `npm run build`) على الـ `HEAD` الدقيق قبل التصدير والدفع وفتح مسودة الـ `PR`.
