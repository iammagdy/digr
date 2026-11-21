import Link from "next/link";
import { SERVICES_CATALOG, catalogCounts } from "@/lib/servicesCatalog";
import { platformsCountAr, sectorsCountAr } from "@/lib/servicesCatalogText";
import { CONTACT_VERIFICATION_LABELS } from "@/lib/contactVerification";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { homePriceStrip } from "@/lib/pricingPage";

/** The three steps of a request, in the customer's words. */
export const OVERVIEW_STEPS_AR = [
  { title: "اطلب", text: "اكتب طلبك بالعربية كما تقوله لزميل، بالفصحى أو بالعامية." },
  { title: "راجع الخطة والسعر", text: "تظهر لك خطة قابلة للتعديل وسعرها بالنقاط." },
  { title: "استلم الملف", text: "ملف إكسل أو بي دي إف منظّم، ومعه دليل المتغيرات." },
] as const;

/** What the customer pays, in one place (the sentence that nothing is charged before approval is the hero's alone). */
export const OVERVIEW_PAYMENT_AR = "تدفع مقابل ما يُسلَّم فعلًا من سجلات مطابقة فقط. يُحجز مبلغ مؤقت يشمل احتياطيًا، وما لا يُستخدم منه حجز مؤقت مُحرَّر.";

/** Two small requests and their price, computed by the same estimate as the pricing page (nothing typed by hand). Static HTML. */
export function PriceStrip() {
  const items = homePriceStrip();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="price-strip-title" data-testid="price-strip" className="border-t border-ln px-5 py-10">
      <div className="mx-auto flex max-w-[1000px] flex-col items-center gap-4 text-center">
        <h2 id="price-strip-title" className="m-0 text-[15px] font-normal text-mut">كم يكلّف؟ أمثلة بالنقاط</h2>
        <ul className="m-0 flex w-full list-none flex-col items-stretch justify-center gap-3 p-0 min-[760px]:flex-row">
          {items.map((item) => (
            <li key={item.id} data-testid={`price-strip-${item.id}`} className="flex flex-1 flex-col gap-1 rounded-[18px] border border-ln bg-sf px-5 py-4">
              <span className="text-[15px] font-normal text-ink">{item.requestAr}</span>
              <span className="text-[22px] font-medium text-ink">{formatAr(item.points)} <span className="text-[14px] font-light text-mut">نقطة</span></span>
              <span className="text-[13px] font-light text-mut">≈ {formatAr(Number(item.egp.toFixed(2)))} ج.م</span>
            </li>
          ))}
        </ul>
        <p className="m-0 text-[13px] font-light leading-[1.9] text-mut">
          أسعار تقديرية من نظام التسعير نفسه، وسعر طلبك الفعلي يظهر في خطته.{" "}
          <Link href="/pricing" className="text-ink underline underline-offset-4">الأسعار</Link>{" · "}
          <Link href="/calculator" className="text-ink underline underline-offset-4">احسب طلبك</Link>
        </p>
      </div>
    </section>
  );
}

/** «إزاي بيشتغل وإيه اللي بتدفعه»: the three steps and what is paid, one section. */
export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="border-t border-ln px-5 py-16 min-[760px]:py-24">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-8">
        <h2 id="how-title" className="m-0 text-center font-extralight text-ink" style={{ fontSize: "clamp(28px,4.4cqi,48px)" }}>إزاي بيشتغل وإيه اللي بتدفعه</h2>
        <ol className="m-0 grid list-none grid-cols-1 gap-4 p-0 min-[760px]:grid-cols-3">
          {OVERVIEW_STEPS_AR.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-[22px] border border-ln bg-sf p-5 text-right">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sf2 text-[15px] font-medium text-goldT">{toArabicDigits(index + 1)}</span>
              <h3 className="m-0 text-[19px] font-medium text-ink">{step.title}</h3>
              <p className="m-0 text-[14px] font-light leading-[1.9] text-mut">{step.text}</p>
            </li>
          ))}
        </ol>
        <p data-testid="landing-payment" className="m-0 text-center text-[15px] font-normal leading-[2] text-ink">{OVERVIEW_PAYMENT_AR}</p>
      </div>
    </section>
  );
}

/** «إيه اللي ممكن تطلبه»: the data sectors (names from the catalog module only) and the decision makers with the verification statuses, one section. */
export function WhatYouCanAsk() {
  const counts = catalogCounts();
  return (
    <section id="what" aria-labelledby="what-title" className="border-t border-ln px-5 py-16 min-[760px]:py-24">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-10">
        <div className="flex flex-col gap-4 text-center">
          <h2 id="what-title" className="m-0 font-extralight text-ink" style={{ fontSize: "clamp(28px,4.4cqi,48px)" }}>إيه اللي ممكن تطلبه</h2>
          <p className="m-0 text-[14px] font-light leading-[1.9] text-mut">{`${sectorsCountAr(counts.sectors)} من ${platformsCountAr(counts.platforms)}، وكلها مصادر متاحة.`}</p>
          <ul className="m-0 flex list-none flex-wrap justify-center gap-2 p-0" data-testid="landing-sectors">
            {SERVICES_CATALOG.map((sector) => (
              <li key={sector.id} className="rounded-full border border-ln bg-sf px-4 py-2 text-[13px] text-ink">{sector.nameAr}</li>
            ))}
          </ul>
          <Link href="/services" className="mx-auto inline-flex min-h-11 items-center text-[15px] text-ink underline underline-offset-4">تصفّح خدماتنا</Link>
        </div>

        <div className="flex flex-col gap-4">
          <div data-testid="landing-decision-makers" className="flex flex-col gap-3 rounded-[24px] border border-ln2 bg-sf p-6 text-right min-[760px]:p-8">
            <h3 className="m-0 text-[24px] font-medium text-ink">صناع القرار وبيانات التواصل المهنية</h3>
            <p className="m-0 text-[15px] font-light leading-[2] text-ink2">من يقرر في الشركة، وبريد عمله وهاتف مكتبه عند توفرهما. بجانب كل بريد وكل هاتف حالة تحقق واضحة، فلا تعتمد رقمًا لم يتأكد.</p>
            <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="حالات التحقق">
              {CONTACT_VERIFICATION_LABELS.map((label) => (
                <li key={label} className="rounded-full bg-sf2 px-3 py-1 text-[12px] text-ink">{label}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The explanation block of the landing page: how it works and what is paid, then what can be asked. */
export function Overview() {
  return (
    <>
      <HowItWorks />
      <WhatYouCanAsk />
    </>
  );
}
