"use client";

import Link from "next/link";
import { formatAr } from "@/lib/arabicDigits";
import MissionEstimator from "@/components/calculator/MissionEstimator";

/** THE CALCULATOR PAGE: one title, one line about how the price is made, the three choices with their one result (MissionEstimator), and the accounting rules in three lines. */
export default function PublicCalculatorPage() {
  return (
    <main dir="rtl" lang="ar" data-screen-label="Calculator" className="min-h-full bg-bg px-5 py-10 font-sans text-ink min-[760px]:py-12">
      <div className="mx-auto flex max-w-[820px] flex-col gap-6">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ln pb-5">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="m-0 font-display text-[34px] font-medium leading-[1.2] text-ink">حاسبة التكلفة</h1>
            <p className="m-0 max-w-[620px] text-[15px] font-light leading-[1.9] text-ink2">
              تستخدم هذه الحاسبة نفس معادلة التسعير المعتمدة في النظام عند إصدار عرض السعر. تُقاس التكلفة بالنقاط والجنيه المصري فقط (كل نقطة تساوي {formatAr(0.1)} ج.م).
            </p>
          </div>
          <Link href="/dashboard/chat" className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline">ابدأ بحثك الآن</Link>
        </header>

        <MissionEstimator />

        <section className="rounded-[20px] border border-ln bg-sf2 p-5">
          <h2 className="m-0 text-base font-semibold text-ink">قواعد المحاسبة وحماية الرصيد</h2>
          <ul className="mb-0 mt-3 flex flex-col gap-2 pr-5 text-sm font-light leading-[1.9] text-ink2">
            <li>لا يُخصم أي رصيد أثناء المحادثة أو إعداد الخطة. بعد موافقتك، يُخصم فقط مقابل العمل المسلَّم فعليًا.</li>
            <li>إذا تعذّر تنفيذ الطلب، لن يُخصم أي رصيد.</li>
            <li>لكل طلب حد أقصى لحماية رصيدك؛ الأحجام الكبيرة تُقسَّم على أكثر من طلب.</li>
          </ul>
        </section>
      </div>
    </main>
  );
}
