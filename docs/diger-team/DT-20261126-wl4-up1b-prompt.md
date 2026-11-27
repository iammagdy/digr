تنفيذ المرحلة (UP1b-prompt) من موجة إزالة قوائم الكلمات الرابعة (DT-20261126-wordlist-wave4) بناءً على القرار (D-0240).

أولًا التغيير: تلميحات أدوات الـ(planner) في (src/lib/agentMission/capabilities/prompt.ts) بقت تكتب اسم المزوّد (`firecrawl` و`contextdev`) من ثوابت ملف الهوية (`src/lib/multiProvider/types.ts`) بدل النصوص الثابتة، والنص اللي النموذج بيقراه فضل نفس النص بالحرف.

ثانيًا قائمة الاستثناءات والاختبارات: نزلت قائمة (treg_tokens) بمقدار (−١) مع تحديث السقف في (tests/design-guards-allow-monotonic.test.ts) وإضافة (tests/wl4-up1b-prompt.test.ts) بـ ٣ اختبارات بتثبت تطابق التلميحات وغياب النصوص الثابتة.

ثالثًا الرجوع: يمكن التراجع عن التعديل في أي وقت بعمل (revert) عبر (git).
