import { pointsAr } from "@/lib/pointsFormat";
import Link from "next/link";
import { buildPlatformGuideServices, PLATFORM_GUIDE } from "@/functions/shared/platformGuide";
import { cleanArText, computePublicCalculatorQuote, getPublicCalculatorOptions } from "@/lib/calculatorPricing";
import { publicCapabilityId } from "@/lib/publicCapabilityIds";
import { DECISION_MAKER_UNIT_PRICES_POINTS } from "@/functions/shared/decisionMakerPricing";
import { unitPriceLabelAr } from "@/lib/pointsFormat";
import { SERVICE_STATUS_LINE_AR, catalogCounts, coreServices } from "@/lib/servicesCatalog";
import { DECISION_MAKERS_LINE_AR, SERVICES_PRIMARY_CTA_AR } from "@/lib/servicesAvailability";
import { platformsCountAr, sectorsCountAr, servicesCountAr } from "@/lib/servicesCatalogText";
import { CatalogBrowser } from "@/components/services/CatalogBrowser";

export const metadata = { title: "خدماتنا", description: "كل ما يجمعه ديجر من بيانات: القطاعات والمنصات والخدمات، وصناع القرار وبيانات التواصل المهنية." };

/** Static: the same HTML for everyone; the catalog is data in the bundle and the search runs in the browser. */
export const dynamic = "force-static";

export default function ServicesCatalogPage() {
  const options = getPublicCalculatorOptions();
  const optionSlugs = new Set(options.map((option) => option.slug));
  // Prices only where a priced option already exists, through the shared pricing function; nothing here says anything about a service's status.
  const services = buildPlatformGuideServices().filter((service) => optionSlugs.has(service.slug));
  const counts = catalogCounts();
  const core = coreServices();
  return (
    <main dir="rtl" lang="ar" className="min-h-screen bg-bg px-4 py-10 font-sans text-ink min-[760px]:px-5 min-[760px]:py-12">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-9">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-ln pb-6">
          <div>
            <Link href="/" className="text-sm text-mut no-underline hover:text-ink">ديجر — الصفحة الرئيسية</Link>
            <h1 className="mb-0 mt-2 font-display text-3xl font-medium min-[760px]:text-[40px]">خدماتنا</h1>
            <p className="mb-0 mt-3 max-w-2xl text-[15px] font-light leading-[2] text-ink2">{PLATFORM_GUIDE.product.descriptionAr}</p>
            <p data-testid="services-counts" className="mb-0 mt-2 max-w-2xl text-sm leading-7 text-mut">{`تجد هنا ${sectorsCountAr(counts.sectors)} و${platformsCountAr(counts.platforms)} و${servicesCountAr(counts.services)}.`}</p>
            <p data-testid="services-status-line" className="mb-0 mt-2 max-w-2xl text-sm font-semibold leading-7 text-ink">{SERVICE_STATUS_LINE_AR}</p>
          </div>
          <Link href="/register" className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline">{SERVICES_PRIMARY_CTA_AR}</Link>
        </header>

        <p data-testid="decision-makers-line" className="m-0 -mb-4 text-sm font-semibold leading-7 text-ink">{DECISION_MAKERS_LINE_AR}</p>

        <section data-testid="core-b2b" aria-labelledby="core-title" className="flex flex-col gap-4 rounded-[24px] border border-ln2 bg-sf p-5 min-[760px]:p-7">
          <div>
            <h2 id="core-title" className="m-0 font-display text-[26px] font-medium text-ink">صناع القرار وبيانات التواصل المهنية</h2>
            <p className="m-0 mt-2 max-w-2xl text-sm font-light leading-7 text-ink2">اعرف من يقرر في الشركة، وكيف تصل إليه مهنيًا: بريد العمل وهاتف العمل مع حالة التحقق لكل حقل. بيانات مهنية مرتبطة بالشركة والمنصب فقط. حالة كل خدمة مبيّنة أمامها.</p>
          </div>
          <ul className="m-0 grid list-none gap-x-6 gap-y-1 p-0 text-sm leading-7 text-ink min-[760px]:grid-cols-2">
            {core.map((service) => (
              <li key={service.slug} className="flex flex-col gap-0.5 border-b border-ln py-1.5">
                <span className="font-medium">{service.nameAr}</span>
                <span className="text-[13px] font-light leading-6 text-mut">{service.explainAr}</span>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="browse-title" className="flex flex-col gap-4">
          <h2 id="browse-title" className="m-0 font-display text-[26px] font-medium text-ink">كل القطاعات والمنصات</h2>
          <CatalogBrowser />
        </section>

        <section aria-labelledby="priced-title" className="flex flex-col gap-4">
          <h2 id="priced-title" className="m-0 font-display text-[26px] font-medium text-ink">خدمات بأسعار معلنة</h2>
          <div className="grid gap-4 sm:grid-cols-2">
          {services.map((service) => {
            const quote = optionSlugs.has(service.slug) ? computePublicCalculatorQuote(service.slug, 1, 1) : null;
            const peoplePrice = service.slug === "professional-people-search" ? DECISION_MAKER_UNIT_PRICES_POINTS : null;
            return <article key={publicCapabilityId(service.slug)} className="rounded-[20px] border border-ln bg-sf p-5">
              <h3 className="m-0 text-lg font-semibold">{cleanArText(service.nameAr)}</h3>
              <p className="mb-4 mt-2 text-sm leading-7 text-mut">{cleanArText(service.descriptionAr)}</p>
              <p className="mb-2 text-sm"><strong>مثال:</strong> {cleanArText(service.exampleAr)}</p>
              <p className="m-0 text-sm"><strong>السعر:</strong> {peoplePrice
                ? `${pointsAr(peoplePrice.basePerson)} للشخص، و${pointsAr(peoplePrice.workEmail)} للبريد المهني عند توفره، و${pointsAr(peoplePrice.phone)} للهاتف المكتبي عند توفره.`
                : quote
                  ? `${unitPriceLabelAr(quote.unitPricePoints, options.find((option) => option.slug === service.slug)?.unitLabelAr || "سجل")}.`
                  : "يحسب النظام السعر بالنقاط بعد تحديد الخدمة المطابقة لموضوعك."}</p>
              <p className="m-0 mt-1 text-xs leading-6 text-mut">يصدر السعر النهائي من النظام بعد تحديد العدد والنطاق، وبحد أقصى {pointsAr(PLATFORM_GUIDE.product.pointCap)} للمهمة.</p>
            </article>;
          })}
          </div>
        </section>

        <section data-testid="services-bottom-cta" className="flex flex-col items-center gap-3 border-t border-ln pt-8 text-center">
          <Link href="/register" className="inline-flex min-h-11 items-center rounded-full bg-ac px-6 text-sm text-onac no-underline">{SERVICES_PRIMARY_CTA_AR}</Link>
        </section>
      </div>
    </main>
  );
}
