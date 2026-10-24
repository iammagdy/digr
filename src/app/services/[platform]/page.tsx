import Link from "next/link";
import { notFound } from "next/navigation";
import { servicesByGroup } from "@/lib/servicesCatalog";
import { SERVICES_PRIMARY_CTA_AR, platformsProvenFirst } from "@/lib/servicesAvailability";
import { PLATFORM_ENTRIES, featuredServices, platformEntryBySlug, platformHref, remainingServices } from "@/lib/servicesCatalogView";
import { servicesCountAr } from "@/lib/servicesCatalogText";

/** Static: one page per platform, generated at build from the catalog module. Nothing here depends on the request. */
export const dynamic = "force-static";
export const dynamicParams = false;

/** The first services are shown as cards; the rest as a plain list below. */
const FEATURED_COUNT = 6;

export function generateStaticParams() {
  return PLATFORM_ENTRIES.map(({ platform }) => ({ platform: platform.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ platform: string }> }) {
  const entry = platformEntryBySlug((await params).platform);
  return entry ? { title: `${entry.platform.nameAr} — خدماتنا`, description: entry.platform.descAr } : {};
}

export default async function PlatformServicesPage({ params }: { params: Promise<{ platform: string }> }) {
  const entry = platformEntryBySlug((await params).platform);
  if (!entry) notFound();
  const { platform, sector } = entry;
  const featured = featuredServices(platform, FEATURED_COUNT);
  const rest = remainingServices(platform, featured);
  const others = platformsProvenFirst(sector.platforms).filter((other) => other.slug !== platform.slug);
  return (
    <main dir="rtl" lang="ar" className="min-h-screen bg-bg px-4 py-10 font-sans text-ink min-[760px]:px-5 min-[760px]:py-12">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-10">
        <header className="flex flex-col gap-6 border-b border-ln pb-8">
          <nav aria-label="مسار الصفحة" className="flex flex-wrap items-center gap-2 text-sm text-mut">
            <Link href="/services" className="text-mut no-underline hover:text-ink">خدماتنا</Link>
            <span aria-hidden="true">›</span>
            <Link href={`/services#${sector.id}`} className="text-mut no-underline hover:text-ink">{sector.nameAr}</Link>
          </nav>
          <div className="flex flex-wrap items-center justify-between gap-5">
            <div className="flex flex-col gap-1">
              <h1 className="m-0 font-display text-[34px] font-medium leading-[1.2] min-[760px]:text-[44px]">{platform.nameAr}</h1>
              <p className="m-0 text-sm text-mut">{servicesCountAr(platform.services.length)}</p>
            </div>
            <Link href="/register" className="inline-flex min-h-11 items-center rounded-full bg-ac px-5 text-sm text-onac no-underline">{SERVICES_PRIMARY_CTA_AR}</Link>
          </div>
          <p className="m-0 max-w-2xl text-[15px] font-light leading-[2] text-ink2">{platform.descAr}</p>
        </header>

        <section aria-labelledby="featured-title" className="flex flex-col gap-4">
          <h2 id="featured-title" className="m-0 font-display text-[26px] font-medium">{rest.length > 0 ? "أبرز الخدمات" : "الخدمات"}</h2>
          <ul data-testid="featured-services" className="m-0 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {featured.map((service) => (
              <li key={service.slug} className="flex flex-col gap-2 rounded-[18px] border border-ln bg-sf p-4">
                <span className="text-[15px] font-semibold leading-7">{service.nameAr}</span>
                <span className="text-[13px] font-light leading-6 text-mut">{service.explainAr}</span>
              </li>
            ))}
          </ul>
        </section>

        {rest.length > 0 && (
          <section aria-labelledby="more-title" className="flex flex-col gap-4">
            <h2 id="more-title" className="m-0 font-display text-[26px] font-medium">باقي الخدمات</h2>
            {servicesByGroup({ ...platform, services: rest }).map(({ group, services }) => (
              <div key={group} className="flex flex-col gap-2">
                <h3 className="m-0 text-[13px] font-semibold text-ink2">{group}</h3>
                <ul className="m-0 flex list-none flex-col overflow-hidden rounded-[18px] border border-ln bg-sf p-0">
                  {services.map((service) => (
                    <li key={service.slug} className="flex flex-col gap-1 border-b border-ln px-4 py-3 last:border-b-0 min-[760px]:flex-row min-[760px]:items-baseline min-[760px]:gap-6">
                      <span className="text-sm font-medium leading-7 min-[760px]:w-[40%] min-[760px]:shrink-0">{service.nameAr}</span>
                      <span className="text-[13px] font-light leading-6 text-mut">{service.explainAr}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}

        {others.length > 0 && (
          <section aria-labelledby="others-title" className="flex flex-col gap-3">
            <h2 id="others-title" className="m-0 font-display text-[22px] font-medium">منصات أخرى في {sector.nameAr}</h2>
            <div className="flex flex-wrap gap-2">
              {others.map((other) => (
                <Link key={other.slug} href={platformHref(other.slug)} className="inline-flex min-h-11 items-center rounded-full border border-ln bg-sf px-4 text-sm text-ink no-underline hover:border-ln2">{other.nameAr}</Link>
              ))}
            </div>
          </section>
        )}

        <section data-testid="platform-bottom-cta" className="flex flex-col items-center gap-3 border-t border-ln pt-8 text-center">
          <Link href="/register" className="inline-flex min-h-11 items-center rounded-full bg-ac px-6 text-sm text-onac no-underline">{SERVICES_PRIMARY_CTA_AR}</Link>
        </section>
      </div>
    </main>
  );
}
