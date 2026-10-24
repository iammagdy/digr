"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { DEVICE_LABEL_AR, countryNameAr, type VisitRange } from "@/lib/analytics/summary";
import { RANGE_LABEL_AR, durationAr, percentAr, type VisitorsResponse } from "@/components/admin/visitorFormat";

const RANGES: VisitRange[] = ["today", "7d", "all"];
const CARD = "min-w-0 rounded-[22px] border border-ln bg-sf p-[18px]";

export default function AdminVisitorsPage() {
  const [range, setRange] = useState<VisitRange>("today");
  const [data, setData] = useState<VisitorsResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setData(null);
    adminFetch<VisitorsResponse>(`/api/admin/visitors?range=${range}`).then((r) => { if (!cancelled) { setData(r); setError(""); } }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [range]);

  const s = data?.summary;
  const kpis = s ? [
    { k: "الزيارات", v: formatAr(s.visits) },
    { k: "مشاهدات الصفحات", v: formatAr(s.pageViews) },
    { k: "الزوّار الفريدون", v: formatAr(s.uniqueVisitors) },
    { k: "حسابات جديدة", v: data?.newAccounts == null ? "—" : formatAr(data.newAccounts) },
    { k: "تسجيلات الدخول", v: formatAr(s.logins.events) },
    { k: "الطلبات المقدّمة", v: data?.submittedRequests == null ? "—" : formatAr(data.submittedRequests) },
    { k: "متوسط مدة الزيارة", v: durationAr(s.avgVisitSeconds) },
  ] : [];
  const deviceTotal = s ? s.devices.mobile + s.devices.desktop + s.devices.tablet : 0;

  return (
    <div data-screen-label="Visitors" className="flex flex-col gap-3.5">
      <div className="no-scrollbar flex max-w-full gap-1 self-start overflow-x-auto rounded-[14px] bg-sf2 p-1" role="tablist" aria-label="الفترة">
        {RANGES.map((id) => (
          <button key={id} type="button" role="tab" aria-selected={range === id} onClick={() => setRange(id)} data-testid={`visitors-range-${id}`}
            className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold"
            style={{ background: range === id ? "var(--sf)" : "transparent", color: range === id ? "var(--ink)" : "var(--mut)", boxShadow: range === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{RANGE_LABEL_AR[id]}</button>
        ))}
      </div>
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      {!data && !error && <p className="m-0 text-[13px] text-mut">جارٍ التحميل…</p>}
      {data && !data.available && (
        <p role="status" className="m-0 rounded-[14px] bg-sf2 px-3.5 py-3 text-[13px] text-ink" data-testid="visitors-unavailable">تتبع الزوّار غير مُفعَّل بعد: جدول الزيارات لم يُنشأ في قاعدة البيانات. الخطوات في مجلد المقترحات «visitor-analytics».</p>
      )}
      {s && (
        <>
          {s.truncated && <p role="status" className="m-0 rounded-[14px] bg-sf2 px-3.5 py-3 text-[13px] text-ink" data-testid="visitors-truncated">هذه الفترة أكبر مما يُقرأ دفعة واحدة؛ الأرقام تغطي أحدث {formatAr(20000)} سجل زيارة فقط.</p>}
          <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,170px),1fr))" }} data-testid="visitors-kpis">
            {kpis.map((item) => <div key={item.k} className="rounded-[18px] border border-ln bg-sf p-3.5"><p className="m-0 text-xs text-mut">{item.k}</p><p className="mb-0 mt-1.5 font-display text-[28px] leading-none text-ink">{item.v}</p></div>)}
          </div>

          <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))" }}>
            <section className={CARD} aria-label="مسار الزائر" data-testid="visitors-funnel">
              <h3 className="m-0 mb-3 text-sm font-semibold text-ink">مسار الزائر: من أول زيارة إلى أول طلب</h3>
              {[["زار الموقع", s.funnel.visited], ["أنشأ حسابًا", s.funnel.signedUp], ["قدّم أول طلب", s.funnel.requested]].map(([label, value], index, all) => (
                <div key={String(label)} className="mb-2.5 last:mb-0">
                  <div className="flex items-center justify-between gap-2 text-[13px]"><span className="text-ink2">{label}</span><span className="font-semibold text-ink">{formatAr(Number(value))}{index > 0 ? ` · ${percentAr(Number(value), Number(all[index - 1][1]))}` : ""}</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-sf2"><div className="h-full" style={{ width: `${s.funnel.visited ? Math.min(100, (Number(value) / s.funnel.visited) * 100) : 0}%`, background: "var(--bar)" }} /></div>
                </div>
              ))}
              <p className="m-0 mt-3 text-[11px] text-mut">يُربط الحساب بالزائر عند تسجيل الدخول من المتصفح نفسه؛ من أنشأ حسابه من جهاز آخر لا يظهر في الخطوة الأخيرة.</p>
            </section>

            <section className={CARD} aria-label="الأجهزة" data-testid="visitors-devices">
              <h3 className="m-0 mb-3 text-sm font-semibold text-ink">الأجهزة</h3>
              {(["mobile", "desktop", "tablet"] as const).map((device) => (
                <div key={device} className="mb-2.5 last:mb-0">
                  <div className="flex items-center justify-between gap-2 text-[13px]"><span className="text-ink2">{DEVICE_LABEL_AR[device]}</span><span className="font-semibold text-ink">{formatAr(s.devices[device])} · {percentAr(s.devices[device], deviceTotal)}</span></div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded bg-sf2"><div className="h-full" style={{ width: `${deviceTotal ? (s.devices[device] / deviceTotal) * 100 : 0}%`, background: "var(--bar)" }} /></div>
                </div>
              ))}
            </section>

            <section className={CARD} aria-label="أكثر الصفحات زيارة" data-testid="visitors-pages">
              <h3 className="m-0 mb-3 text-sm font-semibold text-ink">أكثر الصفحات زيارة</h3>
              {s.topPages.length === 0 ? <p className="m-0 text-[13px] text-mut">لا زيارات في هذه الفترة.</p> : (
                <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {s.topPages.map((page) => <li key={page.path} className="flex items-center justify-between gap-2 text-[13px]"><span dir="ltr" className="min-w-0 truncate text-right text-ink2">{page.path}</span><span className="shrink-0 font-semibold text-ink">{formatAr(page.views)}</span></li>)}
                </ol>
              )}
            </section>

            <section className={CARD} aria-label="الدول" data-testid="visitors-countries">
              <h3 className="m-0 mb-3 text-sm font-semibold text-ink">الدول</h3>
              {s.countries.length === 0 ? <p className="m-0 text-[13px] text-mut">لا زيارات في هذه الفترة.</p> : (
                <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
                  {s.countries.map((country) => <li key={String(country.code)} className="flex items-center justify-between gap-2 text-[13px]"><span className="text-ink2">{countryNameAr(country.code)}</span><span className="shrink-0 font-semibold text-ink">{formatAr(country.visits)}</span></li>)}
                </ol>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
