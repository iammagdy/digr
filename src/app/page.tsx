"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, Eyebrow, Stamp } from "@/components/ui";
import { formatNumber } from "@/lib/honestDisplay";
import {
  buildReadyExampleTemplates,
  EXAMPLE_TEMPLATES_HEADING_AR,
  EXAMPLE_PRICE_DISCLAIMER_AR,
} from "@/functions/shared/exampleTemplates";

const READY_EXAMPLE_TEMPLATES = buildReadyExampleTemplates();

/* ------------------------------------------------------------------ */
/* Interactive dossier demo — clearly labeled as illustrative          */
/* ------------------------------------------------------------------ */

type DemoStep = "typing" | "plan" | "extracting" | "ready";

const PROMPT_TEXT = "استخرج لي بيانات حساب @unicef على تيك توك مع الإحصائيات العامة";

function DossierDemo() {
  const [step, setStep] = useState<DemoStep>("typing");
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (step === "typing") {
      if (typed.length < PROMPT_TEXT.length) {
        timer = setTimeout(() => setTyped(PROMPT_TEXT.slice(0, typed.length + 1)), 28);
      } else {
        timer = setTimeout(() => setStep("plan"), 700);
      }
    }
    return () => clearTimeout(timer);
  }, [step, typed]);

  const reset = () => {
    setTyped("");
    setStep("typing");
  };

  return (
    <div className="paper-dossier overflow-hidden rounded-3xl border border-sand-200 shadow-[var(--shadow-lift)]">
      {/* Dossier header */}
      <div className="flex items-center justify-between border-b border-sand-200 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-pine-800 text-sm font-bold text-white">دِ</span>
          <div>
            <p className="text-sm font-bold text-ink-900">ملف بحث تجريبي</p>
            <p className="text-xs text-sand-500">Digr Research Dossier</p>
          </div>
        </div>
        <Badge tone="warning">عرض توضيحي</Badge>
      </div>

      <div className="space-y-4 p-5 sm:p-6">
        {/* Step 1 — request */}
        <div>
          <p className="mb-1.5 text-xs font-semibold text-sand-500">طلب الباحث</p>
          <div className="min-h-14 rounded-xl border border-sand-200 bg-white p-3.5 text-sm leading-relaxed text-ink-900">
            {typed}
            {step === "typing" && <span aria-hidden="true" className="ms-0.5 inline-block h-4 w-0.5 animate-pulse bg-accent align-middle" />}
          </div>
        </div>

        {/* Step 2 — plan */}
        {(step === "plan" || step === "extracting" || step === "ready") && (
          <div className="animate-rise rounded-xl border border-accent/25 bg-accent-light/60 p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-bold text-accent-ink">خطة البحث المقترحة</p>
              <Stamp tone="accent">بانتظار موافقتك</Stamp>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <div><dt className="text-sand-500">المنصة</dt><dd className="font-semibold text-ink-900">تيك توك — ملف عام</dd></div>
              <div><dt className="text-sand-500">السجلات</dt><dd className="tnum font-semibold text-ink-900">١٬٠٠٠ سجل</dd></div>
              <div><dt className="text-sand-500">المخرجات</dt><dd className="font-semibold text-ink-900">Excel · PDF · CSV</dd></div>
              <div><dt className="text-sand-500">التكلفة التقديرية</dt><dd className="tnum font-bold text-amber-points">٨٥ نقطة</dd></div>
            </dl>
            {step === "plan" && (
              <Button size="sm" variant="accent" className="mt-3 w-full" onClick={() => setStep("extracting")}>
                أوافق على الخطة وابدأ البحث
              </Button>
            )}
          </div>
        )}

        {/* Step 3 — activity */}
        {(step === "extracting" || step === "ready") && (
          <div className="animate-rise rounded-xl border border-sand-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-bold text-ink-900">سجل النشاط</p>
              {step === "ready" ? <Stamp tone="success">مكتمل</Stamp> : <Stamp tone="info">جارٍ التنفيذ</Stamp>}
            </div>
            {step === "extracting" ? (
              <div className="space-y-2" role="status" aria-label="عرض توضيحي للنشاط">
                {["تهيئة مهمة الجمع", "جمع السجلات العامة", "توثيق المنهجية"].map((s, i) => (
                  <div key={s} className="flex items-center gap-2 text-xs text-sand-600">
                    <span className={`h-2 w-2 rounded-full ${i < 2 ? "bg-success" : "bg-accent motion-safe:animate-pulse motion-reduce:animate-none"}`} />
                    {s}
                  </div>
                ))}
                <Button size="sm" variant="secondary" className="mt-1" onClick={() => setStep("ready")}>
                  إتمام العرض
                </Button>
              </div>
            ) : (
              <div className="animate-rise space-y-2.5">
                <p className="tnum text-sm font-bold text-ink-900">تم تسليم ١٬٠٠٠ سجل موثّق</p>
                <div className="flex flex-wrap gap-2">
                  {["Excel", "PDF", "CSV"].map((f) => (
                    <span key={f} className="tnum inline-flex items-center gap-1.5 rounded-lg border border-sand-200 bg-sand-50 px-2.5 py-1.5 text-xs font-semibold text-ink-800">
                      <svg className="h-3.5 w-3.5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17V7a2 2 0 012-2h6l4 4h4a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                      </svg>
                      {f}
                    </span>
                  ))}
                </div>
                <button type="button" onClick={reset} className="text-xs font-semibold text-accent hover:text-accent-hover cursor-pointer">
                  إعادة تشغيل العرض
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <p className="border-t border-sand-200 bg-sand-50/70 px-5 py-2.5 text-center text-xs text-sand-500">
        محاكاة مرئية لأغراض الشرح — ليست عملية استخراج حقيقية
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const WORKFLOW_STEPS = [
  { title: "صِف سؤالك البحثي", desc: "اكتب ما تحتاجه بالعربية الفصحى أو العامية — المساعد يفهم السياق." },
  { title: "أجب عن أسئلة ذكية", desc: "بطاقات توضيحية تحدد المنصة والهدف والحجم والفترة الزمنية." },
  { title: "راجع خطة قابلة للتعديل", desc: "خطة بحث منظمة: الأهداف والحقول والمنهجية والقيود المتوقعة." },
  { title: "اطّلع على عرض سعر شفاف", desc: "تكلفة تقديرية بالنقاط من الخادم — بلا أي مفاجآت." },
  { title: "وافق صراحةً", desc: "لا يبدأ أي جمع قبل ضغطك زر الموافقة. قرارك أولاً." },
  { title: "تابع النشاط الحقيقي", desc: "سجل أحداث مسجّل من الخادم: المراحل والسجلات المجمّعة أولاً بأول." },
  { title: "حمّل ملفاتك", desc: "Excel وPDF وCSV مع دليل المنهجية ومصادر البيانات." },
];

const USE_CASES = [
  {
    title: "للباحثين الأكاديميين",
    desc: "مجموعات بيانات عامة موثّقة المنهجية، مع دليل متغيرات واضح.",
    tag: "منهجية موثّقة",
  },
  {
    title: "للمسوقين والمحللين",
    desc: "رصد اتجاهات الجمهور وقياس التفاعل حول الموضوعات والعلامات — بأرقام تغطية صادقة لا وعود مبالغ فيها.",
    tag: "تغطية صادقة",
  },
  {
    title: "للإحصائيين وفرق البيانات",
    desc: "ملفات CSV بترميز UTF-8 جاهزة للتحليل البرمجي، مع فصل واضح بين المطلوب والمجمّع والمتاح.",
    tag: "جاهز للتحليل",
  },
];

const FAQS = [
  {
    q: "هل جمع البيانات العامة عبر Digr قانوني؟",
    a: "نجمع بيانات عامة فقط ولا نجمع بيانات خاصة. مسؤولية الاستخدام تخضع لشروط كل منصة وللقوانين المطبقة في بلدك، ونوصي بمراجعة سياسة المصدر قبل نشر النتائج.",
  },
  {
    q: "كيف تُحسب تكلفة البحث بالنقاط؟",
    a: "يحسب الخادم التكلفة مقدمًا بناءً على عدد السجلات ونوع المنصة. النقطة الواحدة = ٠٫١٠ جنيه مصري. يُحجز المبلغ مؤقتًا عند موافقتك، ولا يُخصم فعليًا إلا بعد تسليم السجلات — وأي فائض يُرد إلى رصيدك فورًا.",
  },
  {
    q: "ما الملفات التي أستلمها؟",
    a: "لكل بحث مكتمل: ملف Excel (.xlsx) بورقتي البيانات والدليل المنهجي، وملف PDF (.pdf) بملخص تنفيذي، وملف CSV (.csv) بترميز UTF-8 للتحليل البرمجي.",
  },
  {
    q: "هل يمكنني تعديل الخطة قبل الموافقة؟",
    a: "نعم — الخطة قابلة للمراجعة والتعديل بالكامل قبل الموافقة. أي تعديل يعيد حساب عرض السعر من الخادم، ولا يُعتمد عرض سعر منتهي الصلاحية أبدًا.",
  },
  {
    q: "كيف أشحن رصيدي؟",
    a: "من صفحة شحن الرصيد تجد بيانات الدفع المعتمدة. بعد التحويل تُدخل الرقم المرجعي وصورة الإيصال، وتتم المراجعة واعتماد الرصيد في محفظتك.",
  },
];

export default function LandingPage() {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);

  return (
    <div className="min-h-screen bg-sand-50 text-ink-800">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-sand-200/80 bg-sand-50/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Digr — الرئيسية">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-pine-800 text-base font-bold text-white shadow-xs">دِ</span>
            <span className="text-xl font-bold tracking-tight text-ink-900">Digr</span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-medium text-ink-600 md:flex" aria-label="التنقل الرئيسي">
            <a href="#how" className="transition-colors hover:text-ink-900">طريقة العمل</a>
            <a href="#pricing" className="transition-colors hover:text-ink-900">النقاط والأسعار</a>
            <a href="#faq" className="transition-colors hover:text-ink-900">الأسئلة الشائعة</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="hidden rounded-xl px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:bg-sand-100 sm:inline-flex">
              تسجيل الدخول
            </Link>
            <Link href="/register" className="inline-flex min-h-10 items-center rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover">
              ابدأ بحثك
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-sand-200/70">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0">
            <div className="absolute -top-24 start-1/4 h-72 w-72 rounded-full bg-accent/8 blur-3xl" />
          </div>
          <div className="relative mx-auto grid max-w-6xl gap-10 px-4 pt-14 pb-16 sm:px-6 lg:grid-cols-2 lg:items-center lg:gap-14 lg:pt-20 lg:pb-24">
            <div>
              <Eyebrow>منصة البحث بالبيانات العامة</Eyebrow>
              <h1 className="font-display mt-4 text-4xl text-ink-900 sm:text-5xl lg:text-6xl">
                حوّل سؤالك البحثي إلى بيانات منظّمة جاهزة للتحليل
              </h1>
              <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-600 sm:text-lg">
                Digr مساعد بحثي ذكي بالعربية: يطرح عليك أسئلة توضيحية، يصمّم خطة بحث قابلة للتعديل،
                يعرض سعرًا شفافًا بالنقاط — ولا يبدأ الجمع إلا بموافقتك الصريحة.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link href="/register" className="inline-flex min-h-12 items-center rounded-2xl bg-accent px-7 py-3 text-base font-bold text-white shadow-[var(--shadow-ink)] transition-all hover:bg-accent-hover">
                  ابدأ بحثك
                </Link>
                <a href="#how" className="inline-flex min-h-12 items-center rounded-2xl border border-sand-300 bg-white px-7 py-3 text-base font-semibold text-ink-900 transition-colors hover:bg-sand-100">
                  شوف طريقة العمل
                </a>
              </div>
              <dl className="mt-10 grid max-w-md grid-cols-3 gap-4 border-t border-sand-200 pt-6">
                {[
                  ["بيانات عامة فقط", "بلا اختراق"],
                  ["موافقة صريحة", "قبل أي جمع"],
                  [`نقطة = ${formatNumber(0.1, { minimumFractionDigits: 2 })} ج.م`, "تسعير شفاف"],
                ].map(([term, desc]) => (
                  <div key={term}>
                    <dt className="text-sm font-bold text-ink-900">{term}</dt>
                    <dd className="mt-0.5 text-xs text-sand-500">{desc}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <div className="lg:ps-4">
              <DossierDemo />
            </div>
          </div>
        </section>

        {/* How it works — a true sequence */}
        <section id="how" className="border-b border-sand-200/70 bg-white py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Eyebrow>رحلة البحث</Eyebrow>
            <h2 className="font-display mt-3 max-w-2xl text-3xl text-ink-900 sm:text-4xl">من السؤال إلى الملفات — في سبع خطوات واضحة</h2>
            <ol className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
              {WORKFLOW_STEPS.map((s, i) => (
                <li key={s.title} className="relative border-t-2 border-pine-800/90 pt-4">
                  <span aria-hidden="true" className="tnum text-xs font-bold text-accent">٠{formatNumber(i + 1)}</span>
                  <h3 className="mt-1.5 text-base font-bold text-ink-900">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-ink-600">{s.desc}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Ready-to-use Example Templates ("أمثلة جاهزة") */}
        <section id="examples" className="border-b border-sand-200/70 bg-sand-50 py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <Eyebrow>{EXAMPLE_TEMPLATES_HEADING_AR}</Eyebrow>
                <h2 className="font-display mt-3 max-w-2xl text-3xl text-ink-900 sm:text-4xl">
                  قوالب بحث جاهزة للبدء والتعديل
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-600">
                  اختر أي مثال كنقطة انطلاق قابلة للتعديل داخل المساعد البحثي قبل اعتماد الخطة.
                </p>
              </div>
              <Badge tone="warning">{EXAMPLE_PRICE_DISCLAIMER_AR}</Badge>
            </div>

            <div className="mt-8 grid gap-5 sm:grid-cols-2">
              {READY_EXAMPLE_TEMPLATES.map((tpl) => (
                <Card key={tpl.id} className="flex flex-col justify-between p-5 sm:p-6">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge tone={tpl.status === "verified" ? "success" : "warning"}>
                        {tpl.platformAr} · {tpl.status === "verified" ? "متاح الآن" : "قيد التجهيز"}
                      </Badge>
                      <span className="tnum rounded-xl bg-amber-points-bg px-3 py-1 text-xs font-bold text-amber-points">
                        تقريبيًا {formatNumber(tpl.approximatePoints)} نقطة
                      </span>
                    </div>
                    <h3 className="text-lg font-bold text-ink-900">{tpl.titleAr}</h3>
                    <p className="text-sm leading-relaxed text-ink-600">{tpl.shortDescriptionAr}</p>
                    <div className="rounded-xl border border-sand-200 bg-sand-50/80 p-3 text-xs leading-relaxed text-ink-700">
                      <strong className="text-ink-900">ما الذي ستستلمه: </strong>
                      {tpl.deliverablesAr}
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-sand-100 pt-3">
                    <span className="text-xs text-sand-500">{tpl.disclaimerAr}</span>
                    <Link
                      href={`/dashboard/chat?prompt=${encodeURIComponent(tpl.editablePromptAr)}`}
                      className="inline-flex min-h-10 items-center rounded-xl bg-white border border-sand-300 px-3.5 py-1.5 text-xs font-bold text-ink-900 transition-colors hover:border-accent hover:text-accent"
                    >
                      استخدم وعدّل في المحادثة
                    </Link>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        </section>

        {/* Use cases — editorial, not three equal cards */}
        <section className="border-b border-sand-200/70 py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="grid gap-10 lg:grid-cols-5 lg:gap-14">
              <div className="lg:col-span-2">
                <Eyebrow>لمن صُمّم Digr؟</Eyebrow>
                <h2 className="font-display mt-3 text-3xl text-ink-900 sm:text-4xl">مصمّم لعقلية الباحث — لا للتقنيين فقط</h2>
                <p className="mt-4 leading-relaxed text-ink-600">
                  سواء كنت تكتب رسالة ماجستير أو تحلّل سوقًا أو تُعدّ تقريرًا إحصائيًا،
                  Digr يشرح لك في كل خطوة ماذا يحدث ولماذا — بلغة تفهمها.
                </p>
                <div className="mt-6">
                  <Stamp tone="accent">بيانات عامة · منهجية موثّقة · تغطية صادقة</Stamp>
                </div>
              </div>
              <div className="space-y-5 lg:col-span-3">
                {USE_CASES.map((u) => (
                  <article key={u.title} className="surface-card flex gap-4 p-5 sm:p-6">
                    <span aria-hidden="true" className="mt-1 h-10 w-1 shrink-0 rounded-full bg-accent/70" />
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-bold text-ink-900">{u.title}</h3>
                        <Badge tone="accent">{u.tag}</Badge>
                      </div>
                      <p className="mt-2 text-sm leading-relaxed text-ink-600">{u.desc}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Pricing — the ledger motif */}
        <section id="pricing" className="border-b border-sand-200/70 bg-pine-950 py-16 text-sand-100 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold text-pine-200">
                  <span aria-hidden="true" className="inline-block h-px w-6 bg-pine-200/60" />
                  شفافية مالية كاملة
                </p>
                <h2 className="font-display mt-3 text-3xl text-white sm:text-4xl">تعرف التكلفة قبل أن توافق — بالقرش</h2>
                <p className="mt-4 leading-relaxed text-sand-300">
                  نظام النقاط واضح: <strong className="tnum text-white">{formatNumber(1)} نقطة = {formatNumber(0.1, { minimumFractionDigits: 2 })} جنيه مصري</strong>.
                  يُحجز المبلغ التقديري مؤقتًا عند موافقتك، ولا يُخصم النهائي إلا بعد تسليم السجلات —
                  وأي فرق يُرد إلى رصيدك تلقائيًا.
                </p>
                <ul className="mt-6 space-y-3 text-sm">
                  {[
                    "عرض سعر محسوب من الخادم قبل أي التزام",
                    "حجز مؤقت — ثم خصم نهائي دقيق حسب المسلَّم فقط",
                    "سجل مالي غير قابل للتعديل لكل حركة",
                    "لا رسوم خفية ولا خصومات تلقائية",
                  ].map((t) => (
                    <li key={t} className="flex items-start gap-2.5">
                      <svg className="mt-0.5 h-4 w-4 shrink-0 text-pine-200" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-sand-200">{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm">
                <table className="w-full text-sm">
                  <caption className="px-5 pt-5 pb-3 text-right text-xs font-semibold text-pine-200">مثال توضيحي لدورة مبلغ — ليست أسعارًا فعلية</caption>
                  <tbody className="divide-y divide-white/10">
                    {[
                      ["عرض السعر التقديري", `${formatNumber(85)} نقطة`, "قبل الموافقة"],
                      ["المبلغ المحجوز", `${formatNumber(85)} نقطة`, "عند الموافقة"],
                      ["السجلات المسلَّمة فعلًا", `${formatNumber(920)} / ${formatNumber(1000)}`, "بعد التنفيذ"],
                      ["الخصم النهائي", `${formatNumber(78)} نقطة`, "حسب المسلَّم"],
                      ["المبلغ المُرد إلى رصيدك", `${formatNumber(7)} نقاط`, "تلقائيًا"],
                    ].map(([label, value, note]) => (
                      <tr key={label}>
                        <td className="px-5 py-3.5 text-sand-300">{label}<span className="block text-xs text-sand-500">{note}</span></td>
                        <td className="tnum px-5 py-3.5 text-left font-bold text-white">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="bg-white py-16 sm:py-24">
          <div className="mx-auto max-w-3xl px-4 sm:px-6">
            <div className="text-center">
              <Eyebrow><span className="mx-auto">إجابات واضحة</span></Eyebrow>
              <h2 className="font-display mt-3 text-3xl text-ink-900 sm:text-4xl">الأسئلة الشائعة</h2>
            </div>
            <div className="mt-10 space-y-3">
              {FAQS.map((item, idx) => {
                const open = activeFaq === idx;
                return (
                  <div key={idx} className={`overflow-hidden rounded-2xl border transition-colors ${open ? "border-accent/30 bg-accent-light/40" : "border-sand-200 bg-sand-50/60"}`}>
                    <button
                      type="button"
                      onClick={() => setActiveFaq(open ? null : idx)}
                      aria-expanded={open}
                      className="touch-target flex w-full cursor-pointer items-center justify-between gap-4 p-5 text-right"
                    >
                      <span className="text-sm font-bold text-ink-900 sm:text-base">{item.q}</span>
                      <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-lg leading-none transition-all ${open ? "border-accent bg-accent text-white" : "border-sand-300 text-sand-500"}`}>
                        {open ? "−" : "+"}
                      </span>
                    </button>
                    {open && (
                      <div className="animate-fade border-t border-sand-200/70 px-5 pt-3 pb-5 text-sm leading-relaxed text-ink-600">
                        {item.a}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-10 text-center">
              <Link href="/register" className="inline-flex min-h-12 items-center rounded-2xl bg-primary px-8 py-3 text-base font-bold text-white transition-colors hover:bg-primary-hover">
                أنشئ حسابك وابدأ أول بحث
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-sand-200 bg-sand-100/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-4 text-sm text-ink-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-pine-800 text-xs font-bold text-white">دِ</span>
            <span className="font-bold text-ink-900">Digr</span>
            <span aria-hidden="true" className="text-sand-300">|</span>
            <span>بيانات عامة جاهزة للتحليل</span>
          </div>
          <nav className="flex items-center gap-5" aria-label="روابط الحساب">
            <Link href="/login" className="transition-colors hover:text-ink-900">تسجيل الدخول</Link>
            <Link href="/register" className="transition-colors hover:text-ink-900">حساب جديد</Link>
          </nav>
          <p className="text-xs">© {new Date().getFullYear()} Digr — جميع الحقوق محفوظة</p>
        </div>
      </footer>
    </div>
  );
}
