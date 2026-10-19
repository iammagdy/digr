import Link from "next/link";
import { buildPlatformGuideServices, PLATFORM_GUIDE } from "@/functions/shared/platformGuide";
import { cleanArText, computePublicCalculatorQuote, getPublicCalculatorOptions } from "@/lib/calculatorPricing";
import { formatAr } from "@/lib/arabicDigits";
import { publicCapabilityId } from "@/lib/publicCapabilityIds";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "@/functions/shared/decisionMakerPricing";

export default function ServicesCatalogPage() {
  const options = getPublicCalculatorOptions();
  const optionSlugs = new Set(options.map((option) => option.slug));
  const services = buildPlatformGuideServices().filter((service) =>
    optionSlugs.has(service.slug)
  );
  return (
    <main dir="rtl" lang="ar" className="min-h-screen bg-bg px-5 py-12 font-sans text-ink">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-7">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ln pb-5">
          <div>
            <Link href="/dashboard/chat" className="text-sm text-mut no-underline hover:text-ink">العودة إلى المساعد البحثي</Link>
            <h1 className="mb-0 mt-2 font-display text-3xl font-medium">كتالوج الخدمات</h1>
            <p className="mb-0 mt-2 max-w-2xl text-sm leading-7 text-mut">{PLATFORM_GUIDE.product.descriptionAr}</p>
          </div>
          <Link href="/dashboard/chat" className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline">ابدأ بحثك</Link>
        </header>
        <section className="grid gap-4 sm:grid-cols-2">
          {services.map((service) => {
            const quote = optionSlugs.has(service.slug) ? computePublicCalculatorQuote(service.slug, 1, 1) : null;
            const peoplePrice = service.slug === "professional-people-search" ? DECISION_MAKER_UNIT_PRICES_POINTS : null;
            return <article key={publicCapabilityId(service.slug)} className="rounded-[20px] border border-ln bg-sf p-5">
              <h2 className="m-0 text-lg font-semibold">{cleanArText(service.nameAr)}</h2>
              <p className="mb-4 mt-2 text-sm leading-7 text-mut">{cleanArText(service.descriptionAr)}</p>
              <p className="mb-2 text-sm"><strong>مثال:</strong> {cleanArText(service.exampleAr)}</p>
              <p className="m-0 text-sm"><strong>السعر:</strong> {peoplePrice
                ? `${formatAr(peoplePrice.basePerson)} نقطة للشخص، و${formatAr(peoplePrice.workEmail)} نقطة للبريد المهني عند توفره، و${formatAr(peoplePrice.phone)} نقطة للهاتف المكتبي عند توفره.`
                : quote
                  ? `${formatAr(quote.unitPricePoints)} نقطة لكل ${options.find((option) => option.slug === service.slug)?.unitLabelAr || "سجل"}.`
                  : "يحسب الخادم السعر بالنقاط بعد تحديد الخدمة المطابقة لموضوعك."}</p>
              <p className="m-0 mt-1 text-xs leading-6 text-mut">يصدر السعر النهائي من الخادم بعد تحديد العدد والنطاق، وبحد أقصى {formatAr(PLATFORM_GUIDE.product.pointCap)} نقطة للمهمة.</p>
            </article>;
          })}
          {PLATFORM_GUIDE.futureSources.map((future) => <article key={future.slug} className="rounded-[20px] border border-ln bg-sf2 p-5">
            <div className="flex items-center justify-between gap-3"><h2 className="m-0 text-lg font-semibold">{future.nameAr}</h2><span className="rounded-full bg-bg px-3 py-1 text-xs text-mut">{future.statusAr}</span></div>
          </article>)}
        </section>
      </div>
    </main>
  );
}
