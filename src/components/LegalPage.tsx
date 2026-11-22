"use client";

import Link from "next/link";
import type { LegalSection } from "@/lib/legalText";
import { SUPPORT_EMAIL } from "@/lib/site";

export type LegalTab = "terms" | "privacy" | "refunds" | "acceptable-use" | "cookies";

export interface LegalTabItem {
  id: LegalTab;
  label: string;
  href: string;
}

const TABS: LegalTabItem[] = [
  { id: "terms", label: "الشروط", href: "/legal/terms" },
  { id: "privacy", label: "الخصوصية", href: "/legal/privacy" },
  { id: "refunds", label: "الرصيد", href: "/legal/refunds" },
  { id: "acceptable-use", label: "الاستخدام", href: "/legal/acceptable-use" },
  { id: "cookies", label: "ملفات الارتباط", href: "/legal/cookies" },
];

/** Public legal pages layout (Arabic-only, RTL, shared tabs navigation). */
export default function LegalPage({
  tab,
  title,
  intro,
  sections,
}: {
  tab: LegalTab;
  title: string;
  intro?: string;
  sections: LegalSection[];
}) {
  const tabCls = (on: boolean) =>
    `flex min-h-11 items-center justify-center rounded-full text-[13px] font-medium transition-colors ${
      on ? "bg-sf text-ink shadow-xs" : "bg-transparent text-mut hover:text-ink"
    }`;

  return (
    <main data-screen-label="Legal" className="min-h-full bg-bg px-5 pb-[72px] pt-5 text-ink2" style={{ containerType: "inline-size" }}>
      <div className="mx-auto flex max-w-[760px] flex-col gap-[18px]">
        <nav className="grid grid-cols-2 gap-1 rounded-[22px] bg-sf2 p-1.5 sm:grid-cols-5 sm:rounded-full" aria-label="الوثائق القانونية">
          {TABS.map((t) => (
            <Link
              key={t.id}
              href={t.href}
              aria-current={tab === t.id ? "page" : undefined}
              className={tabCls(tab === t.id)}
            >
              {t.label}
            </Link>
          ))}
        </nav>
        <div>
          <h1 className="m-0 font-display font-medium leading-[1.15] text-ink" style={{ fontSize: "clamp(36px,6cqi,52px)" }}>{title}</h1>
          <p className="mb-0 mt-2 text-[13px] text-fnt">آخر تحديث: نوفمبر ٢٠٢٦</p>
          {intro && <p className="mb-0 mt-3 text-[15px] font-light leading-[2] text-ink2 [text-wrap:pretty]">{intro}</p>}
        </div>
        {sections.map(([h, p]) => (
          <section key={h} className="border-b border-ln pb-3.5 pt-1.5">
            <h2 className="m-0 text-[17px] font-semibold text-ink">{h}</h2>
            <div className="mb-0 mt-2 text-[15px] font-light leading-[2] text-ink2 [text-wrap:pretty] whitespace-pre-line">{p}</div>
          </section>
        ))}
        <p className="m-0 text-[13px] text-mut">للتواصل: <span dir="ltr">{SUPPORT_EMAIL}</span></p>
      </div>
    </main>
  );
}
