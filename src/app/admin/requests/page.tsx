"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import type { UnservedSummary } from "@/lib/server/unservedRequests";

/** Requests the platform could not serve: what customers asked for that we do not sell. Read only. */
export default function AdminUnservedRequestsPage() {
  const [data, setData] = useState<UnservedSummary | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    adminFetch<UnservedSummary>("/api/admin/unserved-requests").then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div data-screen-label="Unserved requests" className="flex flex-col gap-3.5">
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="unserved-by-family">
        <h2 id="unserved-by-family" className="m-0 text-base font-semibold text-ink">ما الذي طلبه العملاء ولا نبيعه</h2>
        {data && data.byFamily.length === 0 && <p className="mb-0 mt-2.5 text-[13px] text-mut">لا توجد طلبات غير مخدومة مسجلة.</p>}
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink2" data-testid="unserved-families">
          {data?.byFamily.map((f) => <li key={f.family}>{f.titleAr} — {formatAr(f.count)} طلب</li>)}
        </ul>
      </section>
      <section className="rounded-[20px] border border-ln bg-sf p-[18px]" aria-labelledby="unserved-latest">
        <h2 id="unserved-latest" className="m-0 text-base font-semibold text-ink">آخر الطلبات</h2>
        <ul className="m-0 mt-2.5 flex list-none flex-col gap-2 p-0 text-[13px] leading-[1.8] text-ink2" data-testid="unserved-items">
          {data?.items.slice(0, 50).map((item) => (
            <li key={item.id}>
              <span className="text-mut">{item.at ? new Date(item.at).toLocaleString("ar-EG") : ""}</span>
              {item.familiesAr.length > 0 ? <span className="text-mut"> · {item.familiesAr.join(" + ")}</span> : null}
              <br />{item.textAr}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
