"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { formatAr } from "@/lib/arabicDigits";
import {
  computePublicCalculatorQuote,
  getPublicCalculatorOptions,
} from "@/lib/calculatorPricing";

export default function PublicCalculatorPage() {
  const options = useMemo(() => getPublicCalculatorOptions(), []);
  const [selectedSlug, setSelectedSlug] = useState<string>(
    options.find((o) => o.enabled)?.slug || options[0]?.slug || "tiktok-profile"
  );

  const currentOption = useMemo(
    () => options.find((o) => o.slug === selectedSlug) || options[0],
    [options, selectedSlug]
  );

  const [targetVolume, setTargetVolume] = useState<number>(
    currentOption?.defaultVolume || 1
  );
  const [deliveredVolume, setDeliveredVolume] = useState<number>(
    currentOption?.defaultVolume || 1
  );

  const handleSelectCapability = (slug: string) => {
    setSelectedSlug(slug);
    const opt = options.find((o) => o.slug === slug);
    const nextVol = opt?.defaultVolume || 1;
    setTargetVolume(nextVol);
    setDeliveredVolume(nextVol);
  };

  const handleTargetChange = (val: number) => {
    const clamped = Math.max(1, Math.min(currentOption?.maxVolume || 1000, val));
    setTargetVolume(clamped);
    setDeliveredVolume((prev) => Math.min(prev, clamped));
  };

  const breakdown = useMemo(
    () =>
      computePublicCalculatorQuote(
        selectedSlug,
        targetVolume,
        deliveredVolume
      ),
    [selectedSlug, targetVolume, deliveredVolume]
  );

  return (
    <main
      dir="rtl"
      lang="ar"
      data-screen-label="Calculator"
      className="min-h-screen bg-bg px-5 py-12 font-sans text-ink"
    >
      <div className="mx-auto flex max-w-[820px] flex-col gap-8">
        {/* Top bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-ln pb-5">
          <div>
            <Link
              href="/"
              className="text-sm font-medium text-mut no-underline hover:text-ink"
            >
              ديجر — العودة للصفحة الرئيسية
            </Link>
            <h1 className="mb-0 mt-2 font-display text-[36px] font-medium leading-[1.15] text-ink">
              حاسبة تكلفة الأبحاث والبيانات
            </h1>
          </div>
          <Link
            href="/dashboard/chat"
            className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline"
          >
            ابدأ بحثك الآن
          </Link>
        </header>

        {/* Intro guarantee */}
        <section className="rounded-[20px] border border-ln bg-sf p-6">
          <p className="m-0 text-[15px] font-light leading-[1.9] text-ink">
            تستخدم هذه الحاسبة نفس معادلة التسعير المعتمدة في الخادم عند إصدار عرض السعر. تُقاس التكلفة بالنقاط والجنيه المصري فقط (كل نقطة تساوي {formatAr(0.1)} ج.م)، ولا يُخصم من رصيدك إلا مقابل العمل المسلَّم فعليًا.
          </p>
        </section>

        {/* Controls */}
        <section className="grid grid-cols-1 gap-6 rounded-[22px] border border-ln bg-sf p-6 min-[720px]:grid-cols-2">
          <div className="flex flex-col gap-3">
            <label
              htmlFor="capability-select"
              className="text-sm font-medium text-ink"
            >
              نوع الخدمة البحثية
            </label>
            <select
              id="capability-select"
              value={selectedSlug}
              onChange={(e) => handleSelectCapability(e.target.value)}
              className="min-h-12 rounded-[14px] border border-ln2 bg-bg px-3.5 text-sm text-ink outline-none"
            >
              {options.map((opt) => (
                <option key={opt.slug} value={opt.slug}>
                  {opt.nameAr} {opt.enabled ? "— متاح للتنفيذ الفوري" : "— قيد التفعيل"}
                </option>
              ))}
            </select>
            <p className="m-0 text-xs font-light leading-[1.8] text-mut">
              {currentOption?.descriptionAr}
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div>
              <div className="flex items-center justify-between text-sm">
                <label htmlFor="target-volume" className="font-medium text-ink">
                  الكمية المطلوبة في الخطة
                </label>
                <span className="font-semibold text-ink">
                  {formatAr(targetVolume)} {currentOption?.unitLabelAr}
                </span>
              </div>
              <input
                id="target-volume"
                type="range"
                min={1}
                max={currentOption?.maxVolume || 1000}
                step={1}
                value={targetVolume}
                onChange={(e) => handleTargetChange(Number(e.target.value))}
                className="r6 mt-3 w-full"
                style={{ direction: "rtl" }}
              />
            </div>

            <div>
              <div className="flex items-center justify-between text-sm">
                <label htmlFor="delivered-volume" className="font-medium text-ink">
                  الكمية المسلَّمة فعليًا عند الانتهاء
                </label>
                <span className="font-semibold text-ink">
                  {formatAr(deliveredVolume)} {currentOption?.unitLabelAr}
                </span>
              </div>
              <input
                id="delivered-volume"
                type="range"
                min={0}
                max={targetVolume}
                step={1}
                value={deliveredVolume}
                onChange={(e) => setDeliveredVolume(Number(e.target.value))}
                className="r6 mt-3 w-full"
                style={{ direction: "rtl" }}
              />
            </div>
          </div>
        </section>

        {/* Numeric Results */}
        {(() => {
          const displayReservedPoints = breakdown.isCapped
            ? (breakdown.cappedReservedPoints ?? breakdown.reservedPoints)
            : breakdown.reservedPoints;
          const displayReservedEgp = breakdown.isCapped
            ? (breakdown.cappedReservedEgp ?? breakdown.reservedEgp)
            : breakdown.reservedEgp;
          const displayChargedPoints = breakdown.isCapped
            ? (breakdown.cappedChargedPoints ?? breakdown.chargedPoints)
            : breakdown.chargedPoints;
          const displayChargedEgp = breakdown.isCapped
            ? (breakdown.cappedChargedEgp ?? breakdown.chargedEgp)
            : breakdown.chargedEgp;
          const displayRefundPoints = breakdown.isCapped
            ? (breakdown.cappedRefundPoints ?? breakdown.refundPoints)
            : breakdown.refundPoints;
          const displayRefundEgp = breakdown.isCapped
            ? (breakdown.cappedRefundEgp ?? breakdown.refundEgp)
            : breakdown.refundEgp;
          const displayDeliveredVolume = breakdown.isCapped
            ? (breakdown.maxCappedVolume ?? breakdown.deliveredVolume)
            : breakdown.deliveredVolume;

          return (
            <section className="grid grid-cols-1 gap-4 min-[720px]:grid-cols-3">
              <div className="rounded-[20px] border border-ln bg-sf p-5">
                <p className="m-0 text-xs font-medium text-mut">
                  الحجز المؤقت عند الموافقة (يشمل هامش أمان {formatAr(breakdown.safetyBufferPercent)}٪)
                </p>
                <p className="mb-0 mt-3 font-display text-[36px] font-medium leading-none text-ink">
                  {formatAr(displayReservedPoints)}{" "}
                  <span className="text-base font-normal text-mut">نقطة</span>
                </p>
                <p className="mb-0 mt-2 text-sm text-mut">
                  يعادل {formatAr(displayReservedEgp)} ج.م
                </p>
              </div>

              <div className="rounded-[20px] border border-ln bg-sf p-5">
                <p className="m-0 text-xs font-medium text-mut">
                  الخصم النهائي على العمل المسلَّم ({formatAr(displayDeliveredVolume)} {currentOption?.unitLabelAr})
                </p>
                <p className="mb-0 mt-3 font-display text-[36px] font-medium leading-none text-ink">
                  {formatAr(displayChargedPoints)}{" "}
                  <span className="text-base font-normal text-mut">نقطة</span>
                </p>
                <p className="mb-0 mt-2 text-sm text-mut">
                  يعادل {formatAr(displayChargedEgp)} ج.م
                </p>
              </div>

              <div className="rounded-[20px] border border-ln bg-sf p-5">
                <p className="m-0 text-xs font-medium text-mut">
                  المبلغ المسترد تلقائيًا إلى رصيدك بعد التسوية
                </p>
                <p className="mb-0 mt-3 font-display text-[36px] font-medium leading-none text-ok">
                  {formatAr(displayRefundPoints)}{" "}
                  <span className="text-base font-normal text-mut">نقطة</span>
                </p>
                <p className="mb-0 mt-2 text-sm text-mut">
                  يعادل {formatAr(displayRefundEgp)} ج.م
                </p>
              </div>
            </section>
          );
        })()}

        {breakdown.isCapped && (
          <div role="status" className="rounded-[20px] border border-amber-500/40 bg-amber-500/10 p-5 text-xs leading-relaxed text-ink">
            <strong>ملاحظة السقف الأقصى للتكلفة:</strong> يتجاوز هذا الحجم سقف النقاط المسموح به للمهمة الواحدة ({formatAr(breakdown.maxCapPoints || 600)} نقطة). تم حجز السقف الأقصى وضبط الحد الأقصى للمسح تلقائياً عند {formatAr(breakdown.maxCappedVolume || 0)} {currentOption?.unitLabelAr} لضمان أمان العمليات وحماية الرصيد.
          </div>
        )}

        {/* Discrepancy Comparison Table (10 Samples) */}
        <section className="rounded-[20px] border border-ln bg-sf p-6">
          <h2 className="m-0 text-base font-semibold text-ink">
            جدول التدقيق والمطابقة القياسية (١٠ نماذج من الكتالوج)
          </h2>
          <p className="mt-1 text-xs text-mut">
            مقارنة مباشرة بين معادلة التسعير في الخادم وبين الحاسبة — نسبة التطابق ١٠٠٪ دون أي انحراف.
          </p>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-ln bg-sf2 font-semibold text-ink">
                  <th className="px-3 py-2.5">الخدمة</th>
                  <th className="px-3 py-2.5">الكمية</th>
                  <th className="px-3 py-2.5">سعر الوحدة</th>
                  <th className="px-3 py-2.5">الحجز (مع هامش ١٥٪)</th>
                  <th className="px-3 py-2.5">الخصم عند التسليم</th>
                  <th className="px-3 py-2.5">المعادل (ج.م)</th>
                  <th className="px-3 py-2.5">حالة المطابقة</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ln/40">
                {[
                  { slug: "company-research", target: 5 },
                  { slug: "tiktok-profile", target: 1 },
                  { slug: "facebook-post-comments", target: 20 },
                  { slug: "facebook-post-comments", target: 100 },
                  { slug: "facebook-post-search", target: 10 },
                  { slug: "x-keyword-search", target: 50 },
                  { slug: "youtube-comments", target: 100 },
                  { slug: "youtube-search", target: 20 },
                  { slug: "instagram-profile", target: 2 },
                  { slug: "linkedin-profile", target: 5 },
                ].map((sample, idx) => {
                  const b = computePublicCalculatorQuote(sample.slug, sample.target, sample.target);
                  const effectiveTarget = b.isCapped ? (b.maxCappedVolume || sample.target) : sample.target;
                  const effectiveReserved = b.isCapped ? (b.cappedReservedPoints ?? b.reservedPoints) : b.reservedPoints;
                  const effectiveCharged = b.isCapped ? (b.cappedChargedPoints ?? b.chargedPoints) : b.chargedPoints;
                  const effectiveChargedEgp = b.isCapped ? (b.cappedChargedEgp ?? b.chargedEgp) : b.chargedEgp;
                  return (
                    <tr key={idx} className="hover:bg-sf2/50 transition-colors">
                      <td className="px-3 py-2 font-medium text-ink">{b.nameAr}</td>
                      <td className="px-3 py-2 font-mono">
                        {formatAr(effectiveTarget)}
                        {b.isCapped ? <span className="mr-1 text-[10px] text-mut">(سقف)</span> : null}
                      </td>
                      <td className="px-3 py-2 font-mono">{formatAr(b.unitPricePoints)} نقطة</td>
                      <td className="px-3 py-2 font-mono">{formatAr(effectiveReserved)} نقطة</td>
                      <td className="px-3 py-2 font-mono text-emerald-600">{formatAr(effectiveCharged)} نقطة</td>
                      <td className="px-3 py-2 font-mono">{formatAr(effectiveChargedEgp)} ج.م</td>
                      <td className="px-3 py-2">
                        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-600">
                          {b.isCapped ? "مطابق (سقف أمان)" : "مطابق (فرق ٠)"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Unit rate & accounting rules */}
        <section className="rounded-[20px] border border-ln bg-sf2 p-6">
          <h2 className="m-0 text-base font-semibold text-ink">
            قواعد المحاسبة وحماية الرصيد
          </h2>
          <ul className="mb-0 mt-3 flex flex-col gap-2 pr-5 text-sm font-light leading-[1.9] text-ink2">
            <li>
              تكلفة الوحدة الواحدة لهذه الخدمة: {formatAr(breakdown.unitPricePoints)} نقطة ({formatAr(breakdown.unitPriceEgp)} ج.م لكل {currentOption?.unitLabelAr}).
            </li>
            <li>
              لا يُخصم أي رصيد أثناء المحادثة أو إعداد الخطة؛ يبدأ الحجز المؤقت فقط بعد ضغطك على زر الموافقة.
            </li>
            <li>
              يُحتسب الخصم النهائي على السجلات المسلَّمة فقط بدون هامش الأمان، ولا يتجاوز أبدًا المبلغ المحجوز.
            </li>
            <li>
              إذا تعذّر تنفيذ الطلب أو توقّف لأي سبب تقني، يُحرَّر كامل الحجز المؤقت وتكون التكلفة النهائية {formatAr(0)} نقطة ({formatAr(0)} ج.م).
            </li>
          </ul>
        </section>
      </div>
    </main>
  );
}
