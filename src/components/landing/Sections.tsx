"use client";

import Link from "next/link";
import { useState } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { SAMPLE_FILES, SAMPLE_LABEL_AR, samplePreview, type OutputKind } from "@/lib/outputStandard";
import { computePublicCalculatorQuote } from "@/lib/calculatorPricing";
import { FAQS, SHEETS, STATEMENTS } from "./data";
import { Reveal } from "./Reveal";

const BORDER_TOP = "border-t border-ln";

export function Statements() {
  return (
    <section className={`${BORDER_TOP} px-5 py-[120px]`}>
      <div className="mx-auto flex max-w-[1000px] flex-col gap-14 min-[760px]:gap-24">
        {STATEMENTS.map((st) => (
          <div key={st.big} className="grid grid-cols-1 items-baseline gap-x-10 gap-y-3 min-[760px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Reveal as="p" className="m-0 font-extralight leading-[1.15] text-ink" style={{ fontSize: "clamp(40px,7.4cqi,88px)" }}>{st.big}</Reveal>
            <Reveal as="p" delay={180} className="m-0 max-w-[340px] text-[15px] font-light leading-[2] text-mut">{st.small}</Reveal>
          </div>
        ))}
      </div>
    </section>
  );
}

export function Sheets() {
  return (
    <section className={`${BORDER_TOP} overflow-hidden px-5 py-[110px]`}>
      <div className="mx-auto max-w-[1000px] text-center">
        <Reveal as="p" className="m-0 text-sm font-light text-mut">ما تستلمه</Reveal>
        <Reveal as="h2" delay={120} className="mb-0 mt-3 font-extralight text-ink" style={{ fontSize: "clamp(34px,5.4cqi,60px)" }}>ثلاثة ملفات. منهجية واحدة.</Reveal>
        <div className="relative mx-auto mt-16" style={{ width: "min(300px,62%)", aspectRatio: "3/4" }}>
          {SHEETS.map((sh) => (
            <Reveal
              key={sh.name}
              kind="fan"
              fan={sh.to}
              className="absolute inset-0 flex flex-col gap-[9px] rounded-[18px] border border-ln bg-sf p-[18px] text-right"
              style={{ boxShadow: "var(--shadow)", zIndex: sh.z, transition: `transform 1.4s cubic-bezier(.2,.7,.2,1) ${sh.delay}` }}
            >
              <div className="flex items-center justify-between"><span className="text-[15px] font-medium text-ink">{sh.name}</span><span className="text-[11px] text-fnt">{sh.ext}</span></div>
              <span className="h-px bg-ln" />
              {[90, 70, 82, 60, 76].map((w) => <span key={w} className="h-[7px] rounded bg-sf2" style={{ width: `${w}%` }} />)}
              <span className="mt-auto text-[11px] font-light leading-[1.7] text-mut">{sh.desc}</span>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/** A real result file's shape, built by the same code from FAKE data and labelled as a sample; the files are static downloads. */
export function SampleFile() {
  const [kind, setKind] = useState<OutputKind>("comments");
  const preview = samplePreview(kind);
  const file = SAMPLE_FILES[kind];
  return (
    <section className={`${BORDER_TOP} px-5 py-[100px]`} aria-labelledby="sample-file-title">
      <div className="mx-auto max-w-[900px] text-center">
        <Reveal as="p" className="m-0 text-sm font-light text-mut">شكل الملف الذي تستلمه</Reveal>
        <Reveal as="h2" delay={120} className="mb-0 mt-3 font-extralight text-ink" style={{ fontSize: "clamp(30px,4.6cqi,52px)" }}>
          <span id="sample-file-title">جدول واحد منظم، جاهز للتحليل</span>
        </Reveal>
        <div className="mt-8 flex flex-wrap justify-center gap-2" role="tablist" aria-label="نوع الملف">
          {(Object.keys(SAMPLE_FILES) as OutputKind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={`min-h-11 cursor-pointer rounded-full border bg-transparent px-4 text-[13px] text-ink ${kind === k ? "border-gold" : "border-ln"}`}
            >
              {SAMPLE_FILES[k].labelAr}
            </button>
          ))}
        </div>
        <div className="mx-auto mt-6 overflow-hidden rounded-[18px] border border-ln bg-sf text-right" data-testid="sample-file-preview" style={{ boxShadow: "var(--shadow)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ln bg-sf2 px-4 py-2.5">
            <span className="text-[12px] font-medium text-ink" data-testid="sample-label">{SAMPLE_LABEL_AR}</span>
            <span className="text-[11px] font-light text-mut">{file.descriptionAr}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-[12px]">
              <thead>
                <tr>{preview.headers.map((h) => <th key={h} className="whitespace-nowrap border-b border-ln bg-sf px-3 py-2 text-right font-medium text-ink">{h}</th>)}</tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i}>{row.map((cell, j) => <td key={j} dir="auto" className="border-b border-ln px-3 py-2 font-light text-ink2">{/^(?:https?:\/\/|[^\s@]+@)/.test(cell) ? cell : toArabicDigits(cell)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mb-0 mt-4 text-[12px] font-light leading-[1.9] text-mut">كل الأسماء والروابط والأرقام في هذا النموذج وهمية، ولا تخص أي شخص أو جهة حقيقية.</p>
        <a
          href={`/samples/${file.fileName}`}
          download
          data-testid="sample-download"
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-full border border-ln2 px-5 text-[13px] text-ink no-underline hover:border-gold"
        >
          تحميل النموذج التوضيحي (إكسل)
        </a>
      </div>
    </section>
  );
}

/** Uses the same catalog unit price and settlement calculation as the quote flow. */
export function Calculator() {
  const [vol, setVol] = useState(1000);
  const pts = computePublicCalculatorQuote("icypeas-companies-search", vol, vol).chargedPoints;
  return (
    <section className={`${BORDER_TOP} px-5 py-[110px]`}>
      <div className="mx-auto max-w-[760px] text-center">
        <Reveal as="p" className="m-0 text-sm font-light text-mut">احسبها بنفسك</Reveal>
        <Reveal as="p" kind="scale" delay={120} className="mb-0 mt-6 font-extralight leading-none text-ink" style={{ fontSize: "clamp(64px,13cqi,150px)" }}>
          {formatAr(pts)}<span className="text-xl text-mut" style={{ marginInlineStart: 10 }}>نقطة</span>
        </Reveal>
        <p className="mb-0 mt-3 text-[15px] font-light text-mut">≈ {formatAr(Number((pts * 0.1).toFixed(2)))} ج.م مقابل {formatAr(vol)} سجل</p>
        <input
          className="r6 mt-9"
          type="range" min={100} max={1000} step={50} value={vol}
          onChange={(e) => setVol(Number(e.target.value))}
          aria-label="عدد السجلات" style={{ direction: "rtl" }}
        />
        <p className="mx-auto mb-0 mt-6 max-w-[480px] text-sm font-light leading-[2] text-mut">
          هذه هي التكلفة المتوقعة للعدد المحدد. يُخصم فقط مقابل السجلات المطابقة التي يتم تسليمها.
        </p>
        <p className="mb-0 mt-2.5 text-[11px] text-fnt">مثال توضيحي — السعر النهائي يُحسب من النظام لكل خطة.</p>
      </div>
    </section>
  );
}

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section className={`${BORDER_TOP} px-5 py-[110px]`}>
      <div className="mx-auto max-w-[760px]">
        {FAQS.map(([q, a], i) => {
          const isOpen = open === i;
          return (
            <Reveal key={q} className="border-b border-ln">
              <button
                type="button"
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                className="flex min-h-[68px] w-full cursor-pointer items-center justify-between gap-4 border-0 bg-transparent py-[18px] text-right"
              >
                <span className="text-[17px] font-normal text-ink">{q}</span>
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-ln2 text-base font-extralight text-mut transition-transform duration-[350ms]" style={{ transform: `rotate(${isOpen ? 45 : 0}deg)` }}>+</span>
              </button>
              {isOpen && <p className="m-0 pb-6 text-[15px] font-light leading-[2] text-mut" style={{ animation: "up .4s both" }}>{a}</p>}
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

export function FinalCta({ initialSignedIn }: { initialSignedIn?: boolean } = {}) {
  return (
    <section className={`${BORDER_TOP} px-5 pb-[150px] pt-[130px] text-center`}>
      <Reveal as="h2" className="m-0 font-extralight text-ink" style={{ fontSize: "clamp(40px,7cqi,80px)" }}>سؤال واحد يكفي للبدء.</Reveal>
      <Link href={initialSignedIn ? "/dashboard/chat" : "/register"} className="mt-8 inline-flex min-h-14 items-center rounded-full bg-ac px-[34px] text-base text-onac">{initialSignedIn ? "لوحة التحكم" : "أنشئ حسابك"}</Link>
      <div className="mt-[72px] flex flex-wrap items-center justify-center gap-x-[18px] gap-y-1.5 text-xs font-light text-fnt">
        <span>© ٢٠٢٦ ديجر — من مصادر متاحة · موافقة صريحة قبل أي جمع</span>
        <Link href="/calculator" className="flex min-h-11 items-center text-xs text-mut">حاسبة التكلفة</Link>
        <Link href="/legal/terms" className="flex min-h-11 items-center text-xs text-mut">الشروط والأحكام</Link>
        <Link href="/legal/privacy" className="flex min-h-11 items-center text-xs text-mut">سياسة الخصوصية</Link>
        <Link href="/contact" className="flex min-h-11 items-center text-xs text-mut">تواصل معنا</Link>
      </div>
    </section>
  );
}

