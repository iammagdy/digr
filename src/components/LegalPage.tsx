"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Wordmark } from "@/components/Brand";
import type { LegalSection } from "@/lib/legalText";

/** Design «الشروط والأحكام» / «سياسة الخصوصية» (public, same layout for both). */
export default function LegalPage({ tab, title, sections }: { tab: "terms" | "privacy"; title: string; sections: LegalSection[] }) {
  const router = useRouter();
  const back = () => {
    if (window.history.length > 1) router.back();
    else router.push("/");
  };
  const tabCls = (on: boolean) => `flex min-h-11 items-center justify-center rounded-full text-[13px] font-medium text-ink ${on ? "bg-sf" : "bg-transparent"}`;
  return (
    <main data-screen-label="Legal" className="min-h-dvh bg-bg px-5 pb-[72px] pt-5 text-ink2" style={{ containerType: "inline-size" }}>
      <div className="mx-auto flex max-w-[760px] flex-col gap-[18px]">
        <div className="flex items-center justify-between gap-2.5">
          <button type="button" onClick={back} className="min-h-11 cursor-pointer rounded-full border-0 bg-sf2 px-4 text-[13px] text-ink">→ رجوع</button>
          <div className="flex items-center gap-1"><Link href="/" aria-label="ديجر" className="flex min-h-11 items-center"><Wordmark height={26} /></Link></div>
        </div>
        <nav className="grid grid-cols-2 gap-1 rounded-full bg-sf2 p-1" aria-label="الوثائق القانونية">
          <Link href="/legal/terms" aria-current={tab === "terms" ? "page" : undefined} className={tabCls(tab === "terms")}>الشروط والأحكام</Link>
          <Link href="/legal/privacy" aria-current={tab === "privacy" ? "page" : undefined} className={tabCls(tab === "privacy")}>سياسة الخصوصية</Link>
        </nav>
        <div>
          <h1 className="m-0 font-display font-medium leading-[1.15] text-ink" style={{ fontSize: "clamp(36px,6cqi,52px)" }}>{title}</h1>
          <p className="mb-0 mt-2 text-[13px] text-fnt">آخر تحديث: ١١ أكتوبر ٢٠٢٦</p>
        </div>
        <p className="m-0 rounded-2xl px-4 py-3 text-xs leading-[1.8] text-goldT" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)" }}>
          مسودة للتصميم — يجب مراجعة النص النهائي مع مستشار قانوني قبل النشر.
        </p>
        {sections.map(([h, p]) => (
          <section key={h} className="border-b border-ln pb-3.5 pt-1.5">
            <h2 className="m-0 text-[17px] font-semibold text-ink">{h}</h2>
            <p className="mb-0 mt-2 text-[15px] font-light leading-[2] text-ink2 [text-wrap:pretty]">{p}</p>
          </section>
        ))}
        <p className="m-0 text-[13px] text-mut">للتواصل: <span dir="ltr">support@digr.app</span></p>
      </div>
    </main>
  );
}
