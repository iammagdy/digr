"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { TEMPLATE_FORMS, templateFormById } from "@/lib/templateForms";
import TemplateFormCard from "./TemplateFormCard";

/**
 * THE START PAGE of the research assistant: one large input in the middle and a few short example chips under it; nothing else. A chip opens a small form (TemplateFormCard): it sends nothing by itself,
 * the request is built from the form's fields and sent only when the customer presses «أرسل». The input itself is the page's Composer, placed here so it sits in the middle of the page.
 */
export default function EmptyChat({
  firstName,
  zeroBalance,
  composer,
  onSend,
  initialTemplateId = null,
  sending = false,
}: {
  firstName: string;
  zeroBalance: boolean;
  /** The large input (the page's Composer in its centred form). */
  composer: ReactNode;
  /** Sends the request text a form built. */
  onSend: (text: string) => void | boolean | Promise<void | boolean>;
  /** A form opened from the address (the catalog's «ابدأ طلبًا»). */
  initialTemplateId?: string | null;
  sending?: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(initialTemplateId && templateFormById(initialTemplateId) ? initialTemplateId : null);
  const open = openId ? templateFormById(openId) : undefined;
  return (
    <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col items-center justify-center gap-6 py-6" style={{ animation: "up .6s both" }}>
      <h2 className="m-0 text-center font-display font-medium leading-[1.25] text-ink" style={{ fontSize: "clamp(26px,5cqi,36px)" }}>
        {firstName ? `أهلًا ${firstName}، بماذا نبدأ؟` : "أهلًا بك، بماذا نبدأ؟"}
      </h2>
      <div className="w-full">{composer}</div>
      <div className="flex w-full flex-col items-center gap-2.5">
        <p className="m-0 text-xs font-medium text-mut">أو ابدأ من مثال</p>
        <div className="flex flex-wrap justify-center gap-2" data-testid="example-chips" role="group" aria-label="أمثلة">
          {TEMPLATE_FORMS.map((t) => (
            <button
              key={t.id}
              type="button"
              data-testid={`example-chip-${t.id}`}
              aria-pressed={openId === t.id}
              onClick={() => setOpenId(openId === t.id ? null : t.id)}
              className={`min-h-11 max-w-full cursor-pointer rounded-full border px-4 text-[13px] font-medium text-ink transition-colors hover:border-gold ${openId === t.id ? "border-gold bg-sf2" : "border-ln bg-sf"}`}
            >
              {t.chipAr}
            </button>
          ))}
        </div>
      </div>
      {open ? <TemplateFormCard key={open.id} form={open} onSend={onSend} onClose={() => setOpenId(null)} disabled={sending} /> : null}
      {zeroBalance ? (
        <p className="m-0 flex w-full items-center justify-between gap-2.5 rounded-[18px] px-4 py-3 text-[13px] leading-[1.8] text-ink" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)" }}>
          <span>رصيدك صفر — تحتاج نقاطًا لبدء أول بحث. يمكنك تجربة الأسئلة الآن والشحن لاحقًا.</span>
          <Link href="/dashboard/topup" className="flex min-h-11 shrink-0 items-center rounded-full bg-ac px-3.5 text-xs text-onac">اشحن</Link>
        </p>
      ) : null}
    </div>
  );
}
