import Link from "next/link";
import { SERVICES_CATALOG, catalogCounts, coreServices } from "@/lib/servicesCatalog";
import { SERVICE_SOON_LINE_AR, SERVICE_STATUS_AVAILABLE_AR, SERVICE_STATUS_SOON_AR, isAvailableNow, statusCounts } from "@/lib/servicesAvailability";
import { platformsCountAr, sectorsCountAr } from "@/lib/servicesCatalogText";
import { CONTACT_VERIFICATION_LABELS } from "@/lib/contactVerification";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";

/** The three steps of a request, in the customer's words. */
export const OVERVIEW_STEPS_AR = [
  { title: "اطلب", text: "اكتب طلبك بالعربية كما تقوله لزميل، بالفصحى أو بالعامية." },
  { title: "راجع الخطة والسعر", text: "تظهر لك خطة قابلة للتعديل وسعرها بالنقاط قبل أن يُخصم أي شيء." },
  { title: "استلم الملف", text: "ملف إكسل أو بي دي إف منظّم، ومعه دليل المتغيرات." },
] as const;

/** What protects the customer, one line each. */
export const OVERVIEW_TRUST_AR = [
  "توافق على الخطة والسعر قبل أي خصم",
  "لا تدفع إلا على ما يُسلَّم فعلًا",
  "النقاط المحجوزة التي لا تُستخدم تعود إليك",
] as const;

/**
 * The landing page's explanation, right after the first screen: three steps, the data sectors (names from the catalog module only), the decision makers
 * line with the verification statuses a field can carry, and the trust points. A server component: static HTML, no bundle cost. Nothing here is typed by hand
 * that the catalog or the verification labels already say.
 */
export function Overview() {
  const counts = catalogCounts();
  const status = statusCounts(SERVICES_CATALOG);
  const core = coreServices().map((service) => ({ service, available: isAvailableNow(service.platformSlug, service.nameAr) }));
  const coreAvailable = core.filter((entry) => entry.available);
  const coreSoon = core.length - coreAvailable.length;
  return (
    <section id="overview" aria-labelledby="overview-title" className="border-t border-ln px-5 py-16 min-[760px]:py-24">
      <div className="mx-auto flex max-w-[1000px] flex-col gap-14">
        <div>
          <h2 id="overview-title" className="m-0 text-center font-extralight text-ink" style={{ fontSize: "clamp(30px,4.6cqi,52px)" }}>ديجر في ثلاث خطوات</h2>
          <ol className="m-0 mt-8 grid list-none grid-cols-1 gap-4 p-0 min-[760px]:grid-cols-3">
            {OVERVIEW_STEPS_AR.map((step, index) => (
              <li key={step.title} className="flex flex-col gap-2 rounded-[22px] border border-ln bg-sf p-5 text-right">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sf2 text-[15px] font-medium text-goldT">{toArabicDigits(index + 1)}</span>
                <h3 className="m-0 text-[19px] font-medium text-ink">{step.title}</h3>
                <p className="m-0 text-[14px] font-light leading-[1.9] text-mut">{step.text}</p>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-col gap-4 text-center">
          <h2 className="m-0 font-extralight text-ink" style={{ fontSize: "clamp(26px,4cqi,44px)" }}>البيانات التي نجمعها</h2>
          <p className="m-0 text-[14px] font-light leading-[1.9] text-mut">{`${sectorsCountAr(counts.sectors)} من ${platformsCountAr(counts.platforms)}، وكلها مصادر متاحة.`}</p>
          <p data-testid="landing-status-counts" className="m-0 text-[14px] font-normal text-ink">{`${SERVICE_STATUS_AVAILABLE_AR}: ${formatAr(status.available)}، ${SERVICE_STATUS_SOON_AR}: ${formatAr(status.soon)}`}</p>
          <ul className="m-0 flex list-none flex-wrap justify-center gap-2 p-0" data-testid="landing-sectors">
            {SERVICES_CATALOG.map((sector) => (
              <li key={sector.id} className="rounded-full border border-ln bg-sf px-4 py-2 text-[13px] text-ink">{sector.nameAr}</li>
            ))}
          </ul>
          <Link href="/services" className="mx-auto inline-flex min-h-11 items-center text-[15px] text-ink underline underline-offset-4">تصفّح خدماتنا</Link>
        </div>

        <div data-testid="landing-decision-makers" className="flex flex-col gap-3 rounded-[24px] border border-ln2 bg-sf p-6 text-right min-[760px]:p-8">
          <h2 className="m-0 text-[24px] font-medium text-ink">صناع القرار وبيانات التواصل المهنية</h2>
          <p className="m-0 text-[15px] font-light leading-[2] text-ink2">من يقرر في الشركة، وبريد عمله وهاتف مكتبه عند توفرهما. بجانب كل بريد وكل هاتف حالة تحقق واضحة، فلا تعتمد رقمًا لم يتأكد.</p>
          <div data-testid="landing-decision-status" className="flex flex-col gap-1 text-[14px] leading-[1.9] text-ink">
            {coreAvailable.map(({ service }) => <p key={service.slug} className="m-0"><span className="text-goldT">{SERVICE_STATUS_AVAILABLE_AR}</span>{`: ${service.nameAr}`}</p>)}
            {coreSoon > 0 && <p className="m-0"><span className="text-mut">{SERVICE_STATUS_SOON_AR}</span>{`: ${formatAr(coreSoon)} من خدمات التواصل المهنية. ${SERVICE_SOON_LINE_AR}`}</p>}
          </div>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="حالات التحقق">
            {CONTACT_VERIFICATION_LABELS.map((label) => (
              <li key={label} className="rounded-full bg-sf2 px-3 py-1 text-[12px] text-ink">{label}</li>
            ))}
          </ul>
        </div>

        <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 min-[760px]:grid-cols-3" data-testid="landing-trust">
          {OVERVIEW_TRUST_AR.map((point) => (
            <li key={point} className="rounded-[18px] border border-ln bg-sf px-5 py-4 text-center text-[15px] font-normal text-ink">{point}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
