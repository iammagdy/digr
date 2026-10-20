"use client";

import Link from "next/link";
import { MISSION_TEMPLATES } from "@/lib/missionTemplates";

interface StarterItem {
  label: string;
  prompt: string;
  iconPath: string;
}

const STARTERS: StarterItem[] = [
  {
    label: "شركات ومؤسسات (إكسل)",
    prompt: "ابحث لي عن ٥ شركات [المقاولات/نوع النشاط] في [مصر/الدولة] في ملف إكسل",
    iconPath: "M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z",
  },
  {
    label: "حساب عام على تيك توك",
    prompt: "بيانات حساب [@اسم_الحساب] على تيك توك مع الإحصائيات العامة",
    iconPath: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5",
  },
  {
    label: "منشورات آخر ٣ أشهر",
    prompt: "منشورات حساب [@اسم_الحساب] خلال آخر [٣ أشهر]",
    iconPath: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  },
  {
    label: "وسم أو هاشتاج",
    prompt: "المنشورات العامة على وسم [#الوسم] خلال آخر شهر",
    iconPath: "M9 3L7 21M17 3l-2 18M4 8.5h16M3 15.5h16",
  },
];

/** Design «مستخدم جديد»: welcome, four starters with editable placeholders, and the zero-balance note. */
export default function EmptyChat({
  firstName,
  zeroBalance,
  onStart,
}: {
  firstName: string;
  zeroBalance: boolean;
  onStart: (prompt: string) => void;
}) {
  return (
    <div className="mx-auto flex min-h-full max-w-[680px] flex-col justify-center gap-[22px] py-6" style={{ animation: "up .6s both" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/diger-app-icon.svg" alt="" className="block h-10 w-10 rounded-xl" />
      <div>
        <h2 className="m-0 font-display font-medium leading-[1.2] text-ink" style={{ fontSize: "clamp(26px,4cqi,34px)" }}>
          {firstName ? `أهلًا ${firstName}، بماذا نبدأ؟` : "أهلًا بك، بماذا نبدأ؟"}
        </h2>
        <p className="mb-0 mt-2.5 text-[15px] font-light leading-[1.9] text-mut">
          اختر قالباً للتعديل عليه أو اكتب سؤالك البحثي بالعربية، وسنحدد التفاصيل والسعر معًا قبل أي جمع.
        </p>
      </div>
      <div>
        <p className="m-0 mb-2 text-xs font-medium text-mut">مهام كبيرة</p>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,260px),1fr))" }} data-testid="mission-templates">
          {MISSION_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`mission-template-${t.id}`}
              onClick={() => onStart(t.promptAr)}
              className="flex min-h-[108px] cursor-pointer flex-col items-start justify-between gap-2 rounded-[14px] border border-ln bg-sf p-3.5 text-right transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-gold"
            >
              <span className="flex items-center gap-2.5">
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-sf2 text-goldT">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={t.iconPath} /></svg>
                </span>
                <span className="text-[13px] font-medium leading-[1.7] text-ink">{t.titleAr}</span>
              </span>
              <span className="text-xs font-light leading-[1.8] text-mut">{t.flowAr}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="m-0 mb-2 text-xs font-medium text-mut">أمثلة سريعة</p>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,150px),1fr))" }}>
        {STARTERS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => onStart(s.prompt)}
            className="flex min-h-[76px] cursor-pointer flex-col items-start justify-between gap-2.5 rounded-[14px] border border-ln bg-sf p-3.5 text-right transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-gold"
          >
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-sf2 text-goldT">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={s.iconPath} /></svg>
            </span>
            <span className="text-[13px] leading-[1.7] text-ink">{s.label}</span>
          </button>
        ))}
      </div>
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
