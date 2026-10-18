"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { useAdmin } from "@/components/admin/AdminShell";
import { dateTimeAr } from "@/components/admin/format";

interface Msg { id: string; name: string; email: string; message: string; jobId: string | null; source: string; status: string; emailed: boolean; createdAt: string }
const STATUS_AR: Record<string, string> = { new: "جديدة", read: "مقروءة", closed: "مغلقة" };

export default function AdminSupportPage() {
  const { toast } = useAdmin();
  const [rows, setRows] = useState<Msg[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await adminFetch<{ messages: Msg[]; migrationPending: boolean }>("/api/admin/support");
      setRows(r.messages); setPending(r.migrationPending); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل الرسائل"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const setStatus = async (id: string, status: string) => {
    try { await adminFetch("/api/admin/support", { method: "PATCH", body: JSON.stringify({ id, status }) }); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : "تعذّر تحديث الحالة"); }
  };

  if (error) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  return (
    <div data-screen-label="Support" className="flex flex-col gap-3">
      {pending && <p role="status" className="m-0 rounded-[14px] border border-ln bg-sf2 p-3 text-[13px] leading-[1.9] text-ink2">رسائل الدعم غير مفعّلة بعد: تحديث قاعدة البيانات الخاص بها لم يُطبَّق.</p>}
      {!rows && <div className="h-24 rounded-[18px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />}
      {rows && rows.length === 0 && !pending && <p className="m-0 text-[13px] text-fnt">لا توجد رسائل بعد.</p>}
      {rows?.map((m) => (
        <article key={m.id} className="rounded-[18px] border border-ln bg-sf p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[14px] font-semibold text-ink">{m.name}</span>
            <span className="text-xs text-mut">{dateTimeAr(m.createdAt)} · {STATUS_AR[m.status] || m.status}{m.source === "job_report" ? " · بلاغ عن طلب" : ""}</span>
          </div>
          <p dir="ltr" className="m-0 mt-0.5 text-right text-xs text-fnt">{m.email}</p>
          {m.jobId && <p className="m-0 mt-1 text-xs text-mut">رقم الطلب: <span dir="ltr">{m.jobId}</span></p>}
          <p className="mb-0 mt-2 whitespace-pre-wrap text-[14px] leading-[1.9] text-ink2">{m.message}</p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {(["new", "read", "closed"] as const).filter((s) => s !== m.status).map((s) => (
              <button key={s} type="button" onClick={() => setStatus(m.id, s)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-xs text-ink">وسم كـ {STATUS_AR[s]}</button>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
