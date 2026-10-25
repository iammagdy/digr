import Link from "next/link";
import { PLATFORM_GUIDE } from "@/functions/shared/platformGuide";
import { SERVICE_STATUS_LINE_AR, catalogCounts, coreServices } from "@/lib/servicesCatalog";
import { DECISION_MAKERS_LINE_AR, SERVICES_PRIMARY_CTA_AR } from "@/lib/servicesAvailability";
import { FEATURED_CORE_NAMES } from "@/lib/servicesCatalogView";
import { formatAr } from "@/lib/arabicDigits";
import { platformsCountAr, sectorsCountAr, servicesCountAr } from "@/lib/servicesCatalogText";
import { CatalogBrowser } from "@/components/services/CatalogBrowser";

export const metadata = { title: "خدماتنا", description: "كل ما يجمعه ديجر من بيانات: القطاعات والمنصات والخدمات، وصناع القرار وبيانات التواصل المهنية." };

/** Static: the same HTML for everyone; the catalog is data in the bundle and the search runs in the browser. */
export const dynamic = "force-static";

export default function ServicesCatalogPage() {
  const counts = catalogCounts();
  const core = coreServices();
  const featured = FEATURED_CORE_NAMES.map((name) => core.find((service) => service.nameAr === name)).filter((service): service is NonNullable<typeof service> => Boolean(service));
  const rest = core.filter((service) => !FEATURED_CORE_NAMES.includes(service.nameAr));
  return (
    <main dir="rtl" lang="ar" className="min-h-dvh bg-bg px-4 py-10 font-sans text-ink min-[760px]:px-5 min-[760px]:py-12">
      <div className="mx-auto flex max-w-[1080px] flex-col gap-10">
        <header className="flex flex-col gap-6 border-b border-ln pb-8 min-[760px]:flex-row min-[760px]:items-end min-[760px]:justify-between">
          <div className="flex max-w-2xl flex-col gap-3">
            <Link href="/" className="text-sm text-mut no-underline hover:text-ink">ديجر — الصفحة الرئيسية</Link>
            <h1 className="m-0 font-display text-[38px] font-medium leading-[1.15] min-[760px]:text-[52px]">خدماتنا</h1>
            <p className="m-0 text-[16px] font-light leading-[2] text-ink2">{PLATFORM_GUIDE.product.descriptionAr}</p>
            <p data-testid="services-counts" className="m-0 text-sm leading-7 text-mut">{`تجد هنا ${sectorsCountAr(counts.sectors)} و${platformsCountAr(counts.platforms)} و${servicesCountAr(counts.services)}.`}</p>
            <p data-testid="services-status-line" className="m-0 text-sm font-semibold leading-7 text-ink">{SERVICE_STATUS_LINE_AR}</p>
          </div>
          <Link href="/register" className="inline-flex min-h-11 w-fit shrink-0 items-center rounded-full bg-ac px-6 text-sm text-onac no-underline">{SERVICES_PRIMARY_CTA_AR}</Link>
        </header>

        <p data-testid="decision-makers-line" className="m-0 -mb-6 text-sm font-semibold leading-7 text-ink">{DECISION_MAKERS_LINE_AR}</p>

        <section data-testid="core-b2b" aria-labelledby="core-title" className="flex flex-col gap-5 rounded-[28px] border border-ln2 bg-sf2 p-5 min-[760px]:p-8">
          <div className="flex flex-col gap-2">
            <h2 id="core-title" className="m-0 font-display text-[28px] font-medium text-ink">صناع القرار وبيانات التواصل المهنية</h2>
            <p className="m-0 max-w-2xl text-sm font-light leading-7 text-ink2">اعرف من يقرر في الشركة، وكيف تصل إليه مهنيًا: بريد العمل وهاتف العمل مع حالة التحقق من كل منهما.</p>
          </div>
          <ul data-testid="core-featured" className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((service) => (
              <li key={service.slug} className="flex flex-col gap-2 rounded-[18px] border border-ln bg-sf p-4">
                <span className="text-[15px] font-semibold leading-7">{service.nameAr}</span>
                <span className="text-[13px] font-light leading-6 text-mut">{service.explainAr}</span>
              </li>
            ))}
          </ul>
          <details data-testid="core-all" className="group rounded-[18px] border border-ln bg-sf">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-ink">
              <span>{`عرض باقي خدمات صناع القرار (${formatAr(rest.length)})`}</span>
              <span aria-hidden="true" className="text-lg leading-none text-mut group-open:hidden">+</span>
              <span aria-hidden="true" className="hidden text-lg leading-none text-mut group-open:inline">−</span>
            </summary>
            <ul className="m-0 grid list-none gap-x-6 gap-y-0 border-t border-ln p-0 min-[760px]:grid-cols-2">
              {rest.map((service) => (
                <li key={service.slug} className="flex flex-col gap-0.5 border-b border-ln px-4 py-3">
                  <span className="text-sm font-medium leading-7">{service.nameAr}</span>
                  <span className="text-[13px] font-light leading-6 text-mut">{service.explainAr}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>

        <section aria-labelledby="browse-title" className="flex flex-col gap-5">
          <h2 id="browse-title" className="m-0 font-display text-[30px] font-medium text-ink">كل القطاعات والمنصات</h2>
          <CatalogBrowser />
        </section>

        <section data-testid="services-bottom-cta" className="flex flex-col items-center gap-3 border-t border-ln pt-8 text-center">
          <Link href="/register" className="inline-flex min-h-11 items-center rounded-full bg-ac px-6 text-sm text-onac no-underline">{SERVICES_PRIMARY_CTA_AR}</Link>
        </section>
      </div>
    </main>
  );
}
