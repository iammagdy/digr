import Link from "next/link";
import { notFound } from "next/navigation";
import { DEMO_LABEL_AR } from "@/lib/landingDemos";
import { SEGMENTS, segmentBySlug, segmentExample, segmentPeopleLineAr } from "@/lib/segments";
import { liveDailyCapPoints } from "@/lib/server/liveDailyCap";

/** The one-job size follows the live daily limit, like the calculator: refreshed every five minutes. */
export const revalidate = 300;

export function generateStaticParams() {
  return SEGMENTS.map((segment) => ({ segment: segment.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ segment: string }> }) {
  const segment = segmentBySlug((await params).segment);
  return segment ? { title: segment.nameAr, description: segment.headlineAr } : {};
}

export default async function SegmentPage({ params }: { params: Promise<{ segment: string }> }) {
  const segment = segmentBySlug((await params).segment);
  if (!segment) notFound();
  const dailyCapPoints = await liveDailyCapPoints();
  const example = segmentExample(segment, dailyCapPoints);
  const peopleLine = segmentPeopleLineAr(segment, dailyCapPoints);
  return (
    <main dir="rtl" lang="ar" className="min-h-screen bg-bg px-5 py-12 font-sans text-ink">
      <div className="mx-auto flex max-w-[860px] flex-col gap-9">
        <header className="border-b border-ln pb-6">
          <Link href="/" className="text-sm text-mut no-underline hover:text-ink">ديجر — الصفحة الرئيسية</Link>
          <p className="mb-0 mt-4 text-sm font-light text-mut">لـ{segment.nameAr}</p>
          <h1 className="mb-0 mt-2 font-display text-[36px] font-medium leading-[1.25] text-ink">{segment.headlineAr}</h1>
          <p className="mb-0 mt-3 text-[15px] font-light leading-[2] text-ink2">{segment.painAr}</p>
        </header>

        <section aria-labelledby="uses-title" className="flex flex-col gap-3">
          <h2 id="uses-title" className="m-0 text-[20px] font-medium">ما الذي تحصل عليه</h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px] font-light text-ink2">
            {segment.usesAr.map((use) => <li key={use}>— {use}</li>)}
          </ul>
          {peopleLine ? <p data-testid="people-per-request" className="m-0 text-[14px] font-light leading-[1.9] text-mut">صنّاع القرار: {peopleLine}</p> : null}
        </section>

        <section aria-labelledby="example-title" data-testid="segment-example" className="flex flex-col gap-3 rounded-[22px] border border-ln bg-sf p-6">
          <div className="flex items-center justify-between gap-2">
            <h2 id="example-title" className="m-0 text-[18px] font-medium">{segment.exampleTitleAr}</h2>
            <span className="shrink-0 rounded-full border border-ln2 px-2.5 py-0.5 text-[11px] text-mut">{DEMO_LABEL_AR}</span>
          </div>
          <p className="m-0 rounded-[14px] bg-sf2 p-3.5 text-[14px] font-light leading-[1.9] text-ink">{segment.exampleRequestAr}</p>
          {example.understoodAr ? <p className="m-0 text-[14px] font-light leading-[1.9] text-ink2">{example.understoodAr}</p> : null}
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] font-light text-mut">
            {segment.examplePlanAr.map((line) => <li key={line}>— {line}</li>)}
          </ul>
          <p data-testid="segment-price" className="m-0 text-[17px] font-medium text-ink">{example.priceAr}</p>
          {example.notesAr.map((note) => <p key={note} className="m-0 text-[12px] font-light leading-[1.8] text-mut">{note}</p>)}
          <p className="m-0 text-[13px] font-light leading-[1.9] text-mut">{segment.exampleOutputAr}</p>
          <p className="m-0 text-[12px] font-light leading-[1.9] text-mut">مثال توضيحي: السعر النهائي يظهر في خطتك قبل أن توافق، ولا يُخصم شيء قبل موافقتك.</p>
        </section>

        <div className="flex flex-wrap items-center gap-3">
          <Link href="/register" className="inline-flex min-h-12 items-center rounded-full bg-ac px-7 text-[15px] text-onac no-underline">ابدأ بحسابك المجاني</Link>
          <Link href="/pricing" className="inline-flex min-h-12 items-center rounded-full border border-ln2 px-6 text-[14px] text-ink no-underline">الأسعار</Link>
          <Link href="/calculator" className="inline-flex min-h-12 items-center rounded-full border border-ln2 px-6 text-[14px] text-ink no-underline">احسب طلبك</Link>
        </div>

        <nav aria-label="فئات أخرى" className="flex flex-wrap gap-3 border-t border-ln pt-5 text-sm text-mut">
          {SEGMENTS.filter((other) => other.slug !== segment.slug).map((other) => <Link key={other.slug} href={`/for/${other.slug}`} className="text-mut">{other.nameAr}</Link>)}
        </nav>
      </div>
    </main>
  );
}
