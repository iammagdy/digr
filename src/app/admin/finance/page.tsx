"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { EGP } from "@/components/admin/format";

interface Month { key: string; name: string; top: number; realized: number; refunds: number; cost: number; profit: number; margin: number | null }
interface Credit {
  realIncome: { egp: number; points: number; count: number };
  promoPoints: number; adminGrantPoints: number; consumedPoints: number; refundedPoints: number; outstandingPoints: number;
}
interface Resp {
  range: number;
  credit: Credit | null;
  cards: { rev: number; realized: number; refunds: number; treg: number; llm: number; profit: number; margin: number | null };
  monthly: Month[];
  costSplit: { treg: number; llm: number };
}

const MON_COLS = "minmax(0,1.4fr) repeat(5,minmax(0,1fr)) minmax(0,.6fr)";
const pct = (m: number | null) => (m === null ? "—" : `${formatAr(m, 0)}٪`);

export default function AdminFinancePage() {
  const { range, isMobile, providers } = useAdmin();
  const [d, setD] = useState<Resp | null>(null);
  const [error, setError] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    setD(null);
    const dates = `${from ? `&from=${from}` : ""}${to ? `&to=${to}` : ""}`;
    adminFetch<Resp>(`/api/admin/finance?range=${range}${dates}`).then((r) => { setD(r); setError(""); }).catch((e) => setError(e.message));
  }, [range, from, to]);

  if (error) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  if (!d) return <div className="flex flex-col gap-3.5">{[0, 1, 2].map((i) => <div key={i} className="h-36 rounded-[22px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}</div>;

  const c = d.cards;
  const cards = [
    { k: "شحن معتمد", v: EGP(c.rev), c: "var(--ink)", sub: "تدفق نقدي داخل" },
    { k: "إيراد محقق", v: EGP(c.realized), c: "var(--ink)", sub: "نقاط خُصمت على سجلات مسلَّمة (تشمل المستهلك من الرصيد المجاني)" },
    { k: "مستردات", v: EGP(c.refunds), c: "var(--goldT)", sub: "فرق الحجز المرتجع للمستخدمين" },
    { k: "تكلفة TREG", v: EGP(c.treg), c: "var(--mut)", sub: "استدعاءات جمع البيانات" },
    { k: "تكلفة النماذج", v: EGP(c.llm), c: "var(--mut)", sub: providers ? `${providers.llm.provider === "openai" ? "OpenAI" : providers.llm.provider === "anthropic" ? "Anthropic" : "وضع تجريبي"} · ${providers.llm.model}` : "النماذج اللغوية" },
    { k: "صافي الربح", v: EGP(c.profit), c: "var(--ok)", sub: c.margin === null ? "لا إيرادات بعد" : `هامش ${formatAr(c.margin, 1)}٪` },
  ];
  const totalCost = d.costSplit.treg + d.costSplit.llm;
  const wTreg = totalCost ? (d.costSplit.treg / totalCost) * 100 : 0;

  return (
    <div data-screen-label="Finance" className="flex flex-col gap-3.5">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,180px),1fr))" }}>
        {cards.map((x) => (
          <div key={x.k} className="rounded-[18px] border border-ln bg-sf p-3.5"><p className="m-0 text-xs text-mut">{x.k}</p><p className="mb-0 mt-1.5 whitespace-nowrap font-display text-[30px] leading-none" style={{ color: x.c }}>{x.v}</p><p className="mb-0 mt-1.5 text-[11px] text-fnt">{x.sub}</p></div>
        ))}
      </div>

      <section className="rounded-[22px] border border-ln bg-sf p-[18px]" aria-label="الدخل الحقيقي والرصيد المجاني">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="mb-1 mt-0 text-[15px] font-semibold text-ink">الدخل الحقيقي مقابل الرصيد المجاني</h2>
            <p className="m-0 text-xs text-fnt">الدخل الحقيقي هو شحن انستاباي المعتمد فقط. الرصيد الترويجي وهدايا الإدارة لا تُحسب دخلًا أبدًا.</p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-mut">من<input type="date" dir="ltr" value={from} onChange={(e) => setFrom(e.target.value)} className="min-h-11 rounded-xl border border-ln bg-bg px-2.5 text-[13px] text-ink" /></label>
            <label className="flex flex-col gap-1 text-[11px] text-mut">إلى<input type="date" dir="ltr" value={to} onChange={(e) => setTo(e.target.value)} className="min-h-11 rounded-xl border border-ln bg-bg px-2.5 text-[13px] text-ink" /></label>
            {(from || to) && <button type="button" onClick={() => { setFrom(""); setTo(""); }} className="min-h-11 cursor-pointer rounded-xl border border-ln2 bg-transparent px-3 text-xs text-ink">مسح التاريخ</button>}
          </div>
        </div>
        {d.credit ? (
          <div className="mt-3.5 grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,170px),1fr))" }}>
            {[
              ["دخل حقيقي (ج.م)", EGP(d.credit.realIncome.egp), `${formatAr(d.credit.realIncome.points)} نقطة · ${formatAr(d.credit.realIncome.count)} عملية`],
              ["نقاط ترويجية", formatAr(d.credit.promoPoints), "أكواد ترويجية"],
              ["نقاط هدية من الإدارة", formatAr(d.credit.adminGrantPoints), "إضافة يدوية"],
              ["نقاط مستهلكة", formatAr(d.credit.consumedPoints), "خصم على سجلات مسلَّمة"],
              ["نقاط مستردة", formatAr(d.credit.refundedPoints), "فرق الحجز المرتجع"],
              ["صافي المتبقي للعملاء", formatAr(d.credit.outstandingPoints), "كل الأرصدة حتى نهاية الفترة"],
            ].map(([k, v, sub]) => (
              <div key={k} className="rounded-[16px] border border-ln bg-bg p-3"><p className="m-0 text-xs text-mut">{k}</p><p className="mb-0 mt-1.5 whitespace-nowrap font-display text-[26px] leading-none text-ink">{v}</p><p className="mb-0 mt-1.5 text-[11px] text-fnt">{sub}</p></div>
            ))}
          </div>
        ) : <p className="mb-0 mt-3 text-[13px] text-fnt">تعذّر تحميل ملخص الرصيد الآن.</p>}
      </section>

      <section className="rounded-[22px] border border-ln bg-sf p-[18px]">
        <h2 className="mb-1 mt-0 text-[15px] font-semibold text-ink">الأداء الشهري</h2>
        <p className="mb-3.5 mt-0 text-xs text-fnt">الإيراد المحقق = النقاط المخصومة على السجلات المسلَّمة × قيمة النقطة</p>
        {!isMobile && (
          <div className="grid gap-2.5 border-b border-ln2 py-2.5 text-[11px] font-semibold text-mut" style={{ gridTemplateColumns: MON_COLS }}>
            <span>الشهر</span><span>شحن معتمد</span><span>إيراد محقق</span><span>مستردات</span><span>تكلفة المزودين</span><span>صافي الربح</span><span>الهامش</span>
          </div>
        )}
        {d.monthly.map((m) => (
          <div key={m.key} className="grid items-center gap-x-2.5 gap-y-1.5 border-b border-ln py-3 text-[13px] text-ink2" style={{ gridTemplateColumns: isMobile ? "repeat(3,minmax(0,1fr))" : MON_COLS }}>
            <span className="font-semibold text-ink" style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>{m.name}</span>
            <span>{isMobile && <span className="block text-[10px] text-fnt">شحن معتمد</span>}{EGP(m.top)}</span>
            <span>{isMobile && <span className="block text-[10px] text-fnt">إيراد محقق</span>}{EGP(m.realized)}</span>
            {!isMobile && <span className="text-mut">{EGP(m.refunds)}</span>}
            {!isMobile && <span className="text-mut">{EGP(m.cost)}</span>}
            <span className="font-semibold text-ok">{isMobile && <span className="block text-[10px] font-normal text-fnt">صافي الربح</span>}{EGP(m.profit)}</span>
            {!isMobile && <span><span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold text-ok" style={{ background: "color-mix(in oklab, var(--ok) 12%, transparent)" }}>{pct(m.margin)}</span></span>}
          </div>
        ))}
      </section>

      <section className="rounded-[22px] border border-ln bg-sf p-[18px]">
        <h2 className="mb-3 mt-0 text-[15px] font-semibold text-ink">توزيع التكلفة آخر {formatAr(range)} يومًا</h2>
        <div className="flex h-3 overflow-hidden rounded-xl bg-sf2"><span style={{ width: `${wTreg}%`, background: "var(--bar2)" }} /><span style={{ width: `${totalCost ? 100 - wTreg : 0}%`, background: "var(--bar)" }} /></div>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-mut">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--bar2)" }} />TREG (جمع البيانات) · {EGP(d.costSplit.treg)}</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: "var(--bar)" }} />النماذج اللغوية · {EGP(d.costSplit.llm)}</span>
        </div>
      </section>
    </div>
  );
}
