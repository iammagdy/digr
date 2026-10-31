import type { Metadata } from "next";
import Link from "next/link";
import { HELP_SECTIONS, HELP_SUPPORT_EMAIL, HELP_SUPPORT_LINE_AR } from "@/lib/helpContent";

export const metadata: Metadata = { title: "مركز المساعدة", description: "كيف تطلب، وكيف تعمل النقاط، وماذا يحدث عند الاعتماد، وكيف تستلم ملفاتك، وما سياسة الحجز المؤقت." };
export const dynamic = "force-static";

/** «مركز المساعدة»: a plain Arabic page (how to ask, how points work, approval, files, refunds) and the way to reach support. */
export default function HelpPage() {
  return (
    <main dir="rtl" lang="ar" data-screen-label="Help" className="min-h-full bg-bg px-5 py-10 font-sans text-ink min-[760px]:py-12">
      <div className="mx-auto flex max-w-[760px] flex-col gap-8">
        <header className="flex flex-col gap-3 border-b border-ln pb-6">
          <h1 className="m-0 font-display text-[36px] font-medium leading-[1.2] text-ink min-[760px]:text-[44px]">مركز المساعدة</h1>
          <p className="m-0 text-[15px] font-light leading-[2] text-ink2">أجوبة قصيرة عن أكثر ما يسأل عنه العملاء. ولو احتجت مساعدة في طلب بعينه فاكتب لنا.</p>
          <nav aria-label="أقسام المساعدة" className="flex flex-wrap gap-2">
            {HELP_SECTIONS.map((s) => <a key={s.id} href={`#${s.id}`} className="inline-flex min-h-11 items-center rounded-full border border-ln bg-sf px-4 text-[13px] text-ink no-underline hover:border-ln2">{s.titleAr}</a>)}
          </nav>
        </header>
        {HELP_SECTIONS.map((s) => (
          <section key={s.id} id={s.id} aria-labelledby={`h-${s.id}`} className="flex scroll-mt-4 flex-col gap-2.5 border-b border-ln pb-6">
            <h2 id={`h-${s.id}`} className="m-0 text-[21px] font-semibold text-ink">{s.titleAr}</h2>
            {s.paragraphsAr.map((p) => <p key={p} className="m-0 text-[15px] font-light leading-[2] text-ink2">{p}</p>)}
          </section>
        ))}
        <section aria-labelledby="h-support" data-testid="help-support" className="flex flex-col gap-3 rounded-[20px] border border-ln bg-sf p-5">
          <h2 id="h-support" className="m-0 text-[21px] font-semibold text-ink">تواصل مع الدعم</h2>
          <p className="m-0 text-[15px] font-light leading-[2] text-ink2">{HELP_SUPPORT_LINE_AR}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Link href="/contact" data-testid="help-contact-link" className="inline-flex min-h-12 items-center justify-center rounded-full bg-ac px-6 text-[15px] font-semibold text-onac no-underline sm:min-w-[180px]">اكتب لنا</Link>
            <a href={`mailto:${HELP_SUPPORT_EMAIL}`} className="inline-flex min-h-12 items-center justify-center rounded-full border border-ln2 px-5 text-[14px] text-ink no-underline"><span dir="ltr">{HELP_SUPPORT_EMAIL}</span></a>
          </div>
        </section>
      </div>
    </main>
  );
}
