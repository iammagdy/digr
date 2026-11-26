# DT-20261126-phone-arabic-digits — دعم الأرقام العربية والفارسية في أرقام الهواتف

## 1. السبب والتشخيص
- كانت دالتا `normalizePhone` (`src/lib/multiProvider/policy.ts`) و`phoneShape` (`src/lib/agentMission/contactShape.ts`) تعتمدان على تعبيرات نمطية للأرقام اللاتينية فقط (`\d` و`\D`)، مما أدى إلى إسقاط الأرقام المكتوبة بالأرقام العربية الهندية (`٠-٩`) أو الفارسية (`۰-۹`) عند الاستيعاب (`agent/src/items/ingest.ts`) ومكتشفات الاتصال (`contactFinders.ts`) وحساب الوحدات القابلة للفوترة (`billableRows.ts` و`decisionMakerPricing.ts`).

## 2. التعديل المنفّذ
- استدعاء الدالة المشتركة `normalizeDigits` (`src/lib/arabicDigits.ts`) كخطوة أولى داخل `normalizePhone` و`phoneShape` مع بقاء جميع القواعد اللاحقة مطابقة حرفيًا للأرقام اللاتينية دون تغيير أي نصوص عملاء أو قواعد تسعير.
- إضافة اختبارات التطابق والرفض العكسي وحساب الفوترة والاستيعاب في `tests/phone-arabic-digits.test.ts`، وتحديث التوقعات الثلاثة المقيّدة سابقًا في `tests/phone-trunk-zero.test.ts`.

## 3. الإثبات
- اجتياز `tests/phone-arabic-digits.test.ts` و`tests/phone-trunk-zero.test.ts` و`tests/dt-0119-06-contact-shape.test.ts` و`tests/phone-digits-kept.test.ts` و`tests/design-guards.test.ts`، واستيفاء بوابة `D-0220` الكاملة (`vitest`، `tsc --noEmit`، `agent:typecheck`).
