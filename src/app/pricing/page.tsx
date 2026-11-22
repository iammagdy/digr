import Link from "next/link";
import { PRICING_FAQ_AR, REQUEST_PRICING_AR } from "@/lib/pricingPage";

export const metadata = { title: "الأسعار", description: "تعرّف على تكلفة التسليم الكامل والحجز المؤقت لخطة طلبك." };

export default function PricingPage() {
  return (
    <main dir="rtl" lang="ar" className="min-h-full bg-bg px-5 py-12 font-sans text-ink">
      <div className="mx-auto flex max-w-[960px] flex-col gap-10">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ln pb-6">
          <div>
            <h1 className="m-0 font-display text-[40px] font-medium leading-[1.2] text-ink">تدفع على ما يصلك فعلًا</h1>
            <p className="mb-0 mt-3 max-w-[620px] text-[15px] font-light leading-[2] text-ink2">{REQUEST_PRICING_AR.description}</p>
          </div>
          <Link href="/calculator" className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline">{REQUEST_PRICING_AR.label}</Link>
        </header>

        <section aria-labelledby="limits-title" className="flex flex-col gap-3 rounded-[20px] border border-ln bg-sf2 p-6">
          <h2 id="limits-title" className="m-0 text-[18px] font-semibold">حدود نذكرها بصراحة</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm font-light leading-[1.9] text-ink2">
            <li>— لو كان الحجز أعلى من الحد المتاح، افتح الخطة لمراجعة العدد المناسب.</li>
            <li>— الحد الأدنى لاحتساب التكلفة هو ٢٠٠ نقطة عند تسليم كامل العدد المطلوب. وإذا سُلِّم لك أقل من المطلوب بسبب محدودية المتاح، تدفع فقط مقابل ما تم تسليمه لك فعلًا دون تطبيق الحد الأدنى، ولا يُخصم أي رصيد إذا لم يُسلَّم شيء.</li>
            <li>— قد يصلك أقل مما طلبت إن لم تتوفر سجلات كافية في المصدر، وتدفع مقابل ما وصل فقط.</li>
            <li>— نجمع من المصادر المتاحة علنًا فقط، ولا نصل إلى محتوى خاص.</li>
          </ul>
        </section>

        <section aria-labelledby="faq-title" className="flex flex-col gap-4">
          <h2 id="faq-title" className="m-0 font-display text-[26px] font-medium">أسئلة عن الأسعار</h2>
          {PRICING_FAQ_AR.map(([question, answer]) => (
            <div key={question} className="border-b border-ln pb-4">
              <h3 className="m-0 text-[16px] font-medium text-ink">{question}</h3>
              <p className="mb-0 mt-2 text-sm font-light leading-[1.9] text-mut">{answer}</p>
            </div>
          ))}
        </section>

        <div className="text-center">
          <Link href="/register" className="inline-flex min-h-12 items-center rounded-full bg-ac px-7 text-[15px] text-onac no-underline">ابدأ طلبك الأول</Link>
        </div>
      </div>
    </main>
  );
}
