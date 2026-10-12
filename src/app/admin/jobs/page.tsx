"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { EGP, tint } from "@/components/admin/format";
import { dayLabel } from "@/lib/dayLabel";

interface JobRow { id: string; title: string; platform: string; createdAt: string; user: string; requested: number | null; delivered: number; held: number; charged: number; costEgp: number | null; status: "done" | "running" | "failed" | "refunded" }
interface Resp { jobs: JobRow[]; stats: { last30: number; runningNow: number; successRate: number | null; refundedPoints: number } }

const JST: Record<string, [string, string]> = { done: ["مكتمل", "var(--ok)"], running: ["قيد التنفيذ", "var(--info)"], failed: ["فشل · استرداد", "var(--bad)"], refunded: ["مسترد", "var(--goldT)"] };
const TABS: Array<[string, string]> = [["all", "الكل"], ["running", "قيد التنفيذ"], ["done", "مكتمل"], ["failed", "فشل"], ["refunded", "مسترد"]];
const COLS = "minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.7fr) minmax(0,.8fr)";

export default function AdminJobsPage() {
  const { isMobile } = useAdmin();
  const [filter, setFilter] = useState("all");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    adminFetch<Resp>(`/api/admin/jobs?status=${filter}`).then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message));
  }, [filter]);

  const stats = [
    { k: "مهام آخر ٣٠ يومًا", v: data ? formatAr(data.stats.last30) : "…", c: "var(--ink)" },
    { k: "قيد التنفيذ الآن", v: data ? formatAr(data.stats.runningNow) : "…", c: "var(--info)" },
    { k: "نسبة النجاح", v: data ? (data.stats.successRate == null ? "—" : `${formatAr(data.stats.successRate, 1)}٪`) : "…", c: "var(--ok)" },
    { k: "نقاط مستردة", v: data ? formatAr(data.stats.refundedPoints) : "…", c: "var(--goldT)" },
  ];

  return (
    <div data-screen-label="Jobs" className="flex flex-col gap-3.5">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,160px),1fr))" }}>
        {stats.map((s) => <div key={s.k} className="rounded-[18px] border border-ln bg-sf p-3.5"><p className="m-0 text-xs text-mut">{s.k}</p><p className="mb-0 mt-1.5 font-display text-[30px] leading-none" style={{ color: s.c }}>{s.v}</p></div>)}
      </div>
      <div className="no-scrollbar flex max-w-full gap-1 self-start overflow-x-auto rounded-[14px] bg-sf2 p-1" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)} className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold" style={{ background: filter === id ? "var(--sf)" : "transparent", color: filter === id ? "var(--ink)" : "var(--mut)", boxShadow: filter === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{label}</button>
        ))}
      </div>
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      <div className="overflow-hidden rounded-[20px] border border-ln bg-sf">
        {!isMobile && (
          <div className="grid gap-3 bg-sf2 px-[18px] py-3 text-[11px] font-semibold text-mut" style={{ gridTemplateColumns: COLS }}>
            <span>البحث</span><span>المستخدم</span><span>السجلات</span><span>النقاط (حجز / خصم)</span><span>تكلفة TREG</span><span>الحالة</span>
          </div>
        )}
        {!data && [0, 1, 2].map((i) => <div key={i} className="h-[68px] border-t border-ln bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}
        {data?.jobs.map((j) => {
          const [label, color] = JST[j.status];
          const pct = j.requested ? Math.min(100, (j.delivered / j.requested) * 100) : j.status === "done" ? 100 : 0;
          return (
            <div key={j.id} className="grid items-center gap-x-3 gap-y-2 border-t border-ln px-[18px] py-3.5 text-[13px] text-ink2 first:border-t-0" style={{ gridTemplateColumns: isMobile ? "minmax(0,1fr) auto" : COLS }}>
              <span className="min-w-0" style={{ gridColumn: isMobile ? "1 / -1" : "auto" }}>
                <span className="block truncate font-semibold text-ink">{j.title}</span>
                <span className="block text-[11px] text-fnt">{j.platform} · {dayLabel(j.createdAt)}</span>
              </span>
              <span className="min-w-0 truncate">{j.user}</span>
              <span><span className="block">{formatAr(j.delivered)}{j.requested ? ` / ${formatAr(j.requested)}` : ""}</span><span className="mt-1 block h-1 overflow-hidden rounded bg-sf2"><span className="block h-full" style={{ width: `${pct}%`, background: j.status === "failed" ? "var(--bad)" : "var(--bar)" }} /></span></span>
              <span dir="ltr" className="text-right">{formatAr(j.held)} / {formatAr(j.charged)}</span>
              <span>{j.status === "refunded" || j.costEgp == null ? "—" : EGP(j.costEgp)}</span>
              <span><span className="whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11px] font-semibold" style={{ background: tint(color === "var(--goldT)" ? "var(--gold)" : color, 14), color }}>{label}</span></span>
            </div>
          );
        })}
        {data && data.jobs.length === 0 && <p className="m-0 p-10 text-center text-[13px] text-fnt">لا توجد عمليات بحث في هذا القسم.</p>}
      </div>
    </div>
  );
}
