"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge, Card, Eyebrow } from "@/components/ui";
import { formatNumber } from "@/lib/honestDisplay";
import { HeroLens } from "@/app/components/HeroLens";
import {
  buildReadyExampleTemplates,
  EXAMPLE_TEMPLATES_HEADING_AR,
  EXAMPLE_PRICE_DISCLAIMER_AR,
} from "@/functions/shared/exampleTemplates";

const READY_EXAMPLE_TEMPLATES = buildReadyExampleTemplates();

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const STATEMENTS = [
  { big: "تسأل بالعربية.", small: "بالفصحى أو بالعامية. المساعد يفهم السياق، ويوضّح معك التفاصيل التي تحدد الحجم والتكلفة." },
  { big: "توافق على السعر.", small: "خطة قابلة للتعديل وعرض سعر بالنقاط من الخادم. لا يبدأ أي جمع قبل موافقتك الصريحة." },
  { big: "تستلم ملفاتك.", small: "Excel وPDF وCSV مع دليل المنهجية — وتدفع على السجلات المسلَّمة فعلًا فقط." },
];

const DELIVERABLES = [
  { name: "CSV", ext: ".csv", desc: "ترميز UTF-8 للتحليل البرمجي", className: "file-fan__card--csv" },
  { name: "PDF", ext: ".pdf", desc: "ملخص تنفيذي", className: "file-fan__card--pdf" },
  { name: "Excel", ext: ".xlsx", desc: "ورقتا البيانات والدليل المنهجي", className: "file-fan__card--excel" },
];

const FAQS = [
  {
    q: "هل جمع البيانات العامة قانوني؟",
    a: "نجمع بيانات عامة فقط ولا نجمع بيانات خاصة. مسؤولية الاستخدام تخضع لشروط كل منصة وللقوانين المطبقة في بلدك، ونوصي بمراجعة سياسة المصدر قبل نشر النتائج.",
  },
  {
    q: "كيف تُحسب التكلفة؟",
    a: "يحسب الخادم التكلفة مقدمًا بناءً على عدد السجلات ونوع المنصة. يُحجز المبلغ مؤقتًا عند موافقتك، ولا يُخصم فعليًا إلا بعد تسليم السجلات — وأي فائض يُرد إلى رصيدك فورًا.",
  },
  {
    q: "هل يمكنني تعديل الخطة؟",
    a: "نعم — الخطة قابلة للمراجعة والتعديل بالكامل قبل الموافقة. أي تعديل يعيد حساب عرض السعر من الخادم، ولا يُعتمد عرض سعر منتهي الصلاحية أبدًا.",
  },
  {
    q: "كيف أشحن رصيدي؟",
    a: "من صفحة شحن الرصيد تجد بيانات الدفع المعتمدة. بعد التحويل تُدخل الرقم المرجعي وصورة الإيصال، وتتم المراجعة واعتماد الرصيد في محفظتك.",
  },
];

export default function LandingPage() {
  const [activeFaq, setActiveFaq] = useState<number | null>(0);
  const [calcVolume, setCalcVolume] = useState(1000);
  const calcPoints = Math.round(calcVolume * 0.085);
  const calcDeliveredCharge = Math.round(calcPoints * 0.92);
  const calcRefund = calcPoints - calcDeliveredCharge;

  useEffect(() => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      elements.forEach((element) => element.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        (entry.target as HTMLElement).classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.12 });
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-sand-50 text-ink-800">
      {/* Header */}
      <header className="landing-header sticky top-0 z-30">
        <div className="landing-header__inner mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="Digr — الرئيسية">
            <BrandLogo size="medium" />
            <span aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
            <span className="hidden text-sm font-medium text-foreground-muted sm:inline">بحثك يبدأ من هنا</span>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle className="h-10 w-10" />
            <Link href="/login" className="inline-flex min-h-10 items-center rounded-full px-3 sm:px-4 py-2 text-sm font-semibold text-ink-700 transition-colors hover:bg-sand-100">
              دخول
            </Link>
            <Link href="/register" className="inline-flex min-h-10 items-center rounded-full bg-action px-4 py-2 text-sm font-semibold text-on-action transition-colors hover:opacity-90">
              حساب جديد
            </Link>
          </div>
        </div>
      </header>

      <main>
        <HeroLens />

        <section id="statements" className="landing-statements">
          <div className="landing-statements__inner">
            {STATEMENTS.map((statement) => (
              <article key={statement.big} data-reveal="up">
                <h2 className="font-display">{statement.big}</h2>
                <p>{statement.small}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="deliverables" className="landing-deliverables">
          <div className="landing-deliverables__inner">
            <p data-reveal="up">ما تستلمه</p>
            <h2 className="font-display" data-reveal="up">ثلاثة ملفات. منهجية واحدة.</h2>
            <div className="file-fan" aria-label="ملفات البحث المتاحة">
              {DELIVERABLES.map((file) => (
                <article key={file.name} data-reveal="fan" className={`file-fan__card ${file.className}`}>
                  <div><span>{file.name}</span><span>{file.ext}</span></div>
                  <div className="file-fan__lines" aria-hidden="true"><i /><i /><i /><i /><i /></div>
                  <p>{file.desc}</p>
                </article>
              ))}
            </div>
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
                      <Badge tone="neutral">
                        {tpl.platformAr}
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

        <section id="pricing" className="landing-calculator">
          <div className="landing-calculator__inner">
            <p data-reveal="up">احسبها بنفسك</p>
            <h2 className="font-display" data-reveal="scale"><span className="tnum">{formatNumber(calcPoints)}</span><small>نقطة</small></h2>
            <p className="landing-calculator__egp">≈ {formatNumber(Number((calcPoints * 0.1).toFixed(2)), { minimumFractionDigits: 2 })} ج.م مقابل {formatNumber(calcVolume)} سجل</p>
            <label className="sr-only" htmlFor="landing-volume">عدد السجلات</label>
            <input id="landing-volume" type="range" min={100} max={1000} step={50} value={calcVolume} onChange={(event) => setCalcVolume(Number(event.target.value))} aria-label="عدد السجلات" />
            <p className="landing-calculator__note">يُحجز هذا المبلغ مؤقتًا عند موافقتك، ويُخصم فقط على السجلات المسلَّمة. لو وصلك ٩٢٪ منها، يرجع <strong>{formatNumber(calcRefund)} نقطة</strong> لرصيدك تلقائيًا.</p>
            <p className="landing-calculator__disclaimer">مثال توضيحي — السعر النهائي يُحسب من الخادم لكل خطة.</p>
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
        <section className="landing-cta">
          <p className="font-display">سؤال واحد يكفي للبدء.</p>
          <Link href="/register">أنشئ حسابك</Link>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-sand-200 bg-sand-100/60 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-5 px-4 text-sm text-ink-500 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2.5">
            <BrandLogo size="small" />
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
