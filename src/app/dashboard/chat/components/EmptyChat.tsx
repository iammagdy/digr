"use client";

import Link from "next/link";
import { CHIP_ICONS, PROMPTS } from "@/components/landing/data";

const STARTERS: Array<[string, number]> = [
  ["حساب عام على تيك توك", 0],
  ["منشورات آخر ٣ أشهر", 1],
  ["وسم أو هاشتاج", 3],
];

/** Design «مستخدم جديد»: welcome, three starters, and the zero-balance note. */
export default function EmptyChat({ firstName, zeroBalance, onStart }: { firstName: string; zeroBalance: boolean; onStart: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-[620px] flex-col justify-center gap-[22px] py-6" style={{ animation: "up .6s both" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/diger-app-icon.svg" alt="" className="block h-10 w-10 rounded-xl" />
      <div>
        <h2 className="m-0 font-display font-medium leading-[1.2] text-ink" style={{ fontSize: "clamp(26px,4cqi,34px)" }}>
          أهلًا {firstName}، بماذا نبدأ؟
        </h2>
        <p className="mb-0 mt-2.5 text-[15px] font-light leading-[1.9] text-mut">اكتب سؤالك البحثي بالعربية، وسنحدد التفاصيل والسعر معًا قبل أي جمع.</p>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,180px),1fr))" }}>
        {STARTERS.map(([label, i]) => (
          <button
            key={label} type="button" onClick={() => onStart(PROMPTS[i])}
            className="flex min-h-[76px] cursor-pointer flex-col items-start justify-between gap-2.5 rounded-[14px] border border-ln bg-sf p-3.5 text-right transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-gold"
          >
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-sf2 text-goldT">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={CHIP_ICONS[i]} /></svg>
            </span>
            <span className="text-[13px] leading-[1.7] text-ink">{label}</span>
          </button>
        ))}
      </div>
      {zeroBalance && (
        <p className="m-0 flex items-center justify-between gap-2.5 rounded-[18px] px-4 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)" }}>
          <span>رصيدك صفر — تحتاج نقاطًا لبدء أول بحث. يمكنك تجربة الأسئلة الآن والشحن لاحقًا.</span>
          <Link href="/dashboard/topup" className="flex min-h-11 shrink-0 items-center rounded-full bg-ac px-3.5 text-xs text-onac">اشحن</Link>
        </p>
      )}
    </div>
  );
}
