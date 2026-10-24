"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { durationAr, type VisitorsResponse } from "./visitorFormat";

/** A small summary of today's visitors on the admin overview. One admin call on mount, no polling; silent when the numbers cannot be read. */
export function VisitorsSummaryCard() {
  const [data, setData] = useState<VisitorsResponse | null>(null);
  useEffect(() => {
    let cancelled = false;
    adminFetch<VisitorsResponse>("/api/admin/visitors?range=today").then((r) => { if (!cancelled) setData(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const s = data?.available ? data.summary : null;
  if (!s) return null;
  const items = [
    ["زيارات اليوم", formatAr(s.visits)],
    ["زوّار فريدون", formatAr(s.uniqueVisitors)],
    ["حسابات جديدة", data?.newAccounts == null ? "—" : formatAr(data.newAccounts)],
    ["طلبات مقدّمة", data?.submittedRequests == null ? "—" : formatAr(data.submittedRequests)],
    ["متوسط مدة الزيارة", durationAr(s.avgVisitSeconds)],
  ];
  return (
    <section className="min-w-0 rounded-[22px] border border-ln bg-sf p-[18px]" aria-label="زوّار اليوم" data-testid="visitors-summary-card">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">زوّار اليوم</h3>
        <Link href="/admin/visitors" className="min-h-11 content-center text-xs font-semibold text-ink underline">كل التفاصيل</Link>
      </div>
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,130px),1fr))" }}>
        {items.map(([label, value]) => <div key={label}><p className="m-0 text-xs text-mut">{label}</p><p className="mb-0 mt-1 font-display text-[22px] leading-none text-ink">{value}</p></div>)}
      </div>
    </section>
  );
}
