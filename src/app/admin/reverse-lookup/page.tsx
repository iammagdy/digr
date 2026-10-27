"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";

const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const BTN = "hit min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-4 text-sm font-semibold text-ink disabled:opacity-50";

interface Identity { name: string; company: string; title: string; profileUrl: string }
type Outcome =
  | { ok: true; costUsd: number; identity: Identity; found: boolean; depth: number; hasDeeper: boolean; spentTodayUsd: number; capUsd: number }
  | { ok: false; reason: string; spentTodayUsd: number; capUsd: number; costUsd?: number; hasDeeper?: boolean };

const REASON_AR: Record<string, string> = {
  bad_input: "اكتب رقم هاتف أو بريدًا إلكترونيًا صحيحًا.",
  no_endpoint: "لا توجد خدمة بحث عكسي لهذا النوع من المدخلات.",
  daily_cap: "بلغ البحث العكسي حدّه اليومي من التكلفة؛ جرّب غدًا.",
  no_deeper: "لا يوجد بحث أعمق لهذا المدخل.",
  failed: "تعذّر إتمام البحث الآن.",
  audit_unavailable: "تعذّر تسجيل البحث في سجل المراجعة فلم يُنفَّذ.",
};

/** USD with Arabic-Indic digits: this screen is admin-only, the only place a cost in dollars is shown. */
const usd = (n: number) => `${toArabicDigits(n.toFixed(4))} دولار`;

export default function AdminReverseLookupPage() {
  const { toast } = useAdmin();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome | null>(null);
  const [depth, setDepth] = useState(0);
  const [spent, setSpent] = useState<{ spentTodayUsd: number; capUsd: number } | null>(null);

  useEffect(() => { adminFetch<{ spentTodayUsd: number; capUsd: number }>("/api/admin/reverse-lookup").then(setSpent).catch(() => {}); }, []);

  async function run(nextDepth: number) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await adminFetch<Outcome>("/api/admin/reverse-lookup", { method: "POST", body: JSON.stringify({ input: text, depth: nextDepth }) });
      setResult(r);
      setDepth(nextDepth);
      setSpent({ spentTodayUsd: r.spentTodayUsd, capUsd: r.capUsd });
    } catch (e) {
      toast(e instanceof Error ? e.message : "تعذّر البحث");
    } finally { setBusy(false); }
  }

  const okResult = result && result.ok ? result : null;
  return (
    <div className="flex flex-col gap-4" dir="rtl">
      <section className={SECTION} aria-label="بحث عكسي">
        <h2 className="m-0 text-base font-semibold text-ink">بحث عكسي</h2>
        <p className="m-0 text-[13px] font-light leading-[1.9] text-ink2">اكتب رقم هاتف أو بريدًا إلكترونيًا. يبدأ البحث بأرخص خدمة مناسبة، ولا يستخدم أي نقاط من أي عميل. كل بحث يُسجَّل في سجل المراجعة.</p>
        <input className={FIELD} inputMode="email" dir="ltr" placeholder="+20… أو name@company.com" value={text} onChange={(e) => setText(e.target.value)} aria-label="رقم الهاتف أو البريد" />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={BTN} disabled={busy || !text.trim()} onClick={() => run(0)}>بحث</button>
          {result && (result.ok ? result.hasDeeper : result.hasDeeper) ? <button type="button" className={BTN} disabled={busy} onClick={() => run(depth + 1)}>بحث أعمق</button> : null}
        </div>
        {spent ? <p className="m-0 text-[12px] font-light text-mut" data-testid="admin-lookup-cap">تكلفة اليوم {usd(spent.spentTodayUsd)} من حدّ {usd(spent.capUsd)}</p> : null}
      </section>

      {result && !result.ok ? <p className="m-0 rounded-xl border border-ln bg-sf2 px-3 py-2 text-[13px] text-ink" role="status">{REASON_AR[result.reason] ?? REASON_AR.failed}{result.costUsd ? ` (التكلفة ${usd(result.costUsd)})` : ""}</p> : null}

      {okResult ? (
        <section className={SECTION} aria-label="النتيجة" data-testid="admin-lookup-result">
          {okResult.found ? (
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              <dt className="font-medium text-ink2">الاسم</dt><dd className="m-0 text-ink">{okResult.identity.name || "—"}</dd>
              <dt className="font-medium text-ink2">الشركة</dt><dd className="m-0 text-ink">{okResult.identity.company || "—"}</dd>
              <dt className="font-medium text-ink2">المسمى</dt><dd className="m-0 text-ink">{okResult.identity.title || "—"}</dd>
              <dt className="font-medium text-ink2">رابط الملف</dt><dd className="m-0 text-ink" dir="ltr">{okResult.identity.profileUrl ? <a className="underline" href={okResult.identity.profileUrl} target="_blank" rel="noreferrer noopener">{okResult.identity.profileUrl}</a> : "—"}</dd>
            </dl>
          ) : <p className="m-0 text-[13px] text-ink2">لم تُرجع هذه الخدمة بيانات عن هذا المدخل.</p>}
          <p className="m-0 text-[12px] font-light text-mut" data-testid="admin-lookup-cost">تكلفة هذا البحث {usd(okResult.costUsd)}</p>
        </section>
      ) : null}
    </div>
  );
}
