"use client";

import { useCallback, useEffect, useState } from "react";

type GoodwillItem = {
  id: string;
  userId: string;
  jobId: string;
  titleAr: string;
  bodyAr: string;
  status: string;
  reasonCode: string;
  customerCategory: string;
  customerDetails: string;
  delta: number | null;
  createdAt: string;
};

export default function AdminGoodwillPage() {
  const [refunds, setRefunds] = useState<GoodwillItem[]>([]);
  const [reviews, setReviews] = useState<GoodwillItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/goodwill", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "تعذر تحميل القائمة");
      setEnabled(payload.enabled === true);
      setRefunds(Array.isArray(payload.refunds) ? payload.refunds : []);
      setReviews(Array.isArray(payload.reviews) ? payload.reviews : []);
      setStorageAvailable(payload.storageAvailable !== false);
    } catch (cause: any) {
      setError(cause.message || "تعذر تحميل القائمة");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const renderItems = (items: GoodwillItem[], empty: string) => items.length === 0
    ? <p className="rounded-xl border border-dashed border-sand-300 bg-white p-6 text-sm text-sand-500">{empty}</p>
    : <div className="space-y-3">{items.map((item) => (
      <article key={item.id} className="rounded-xl border border-sand-200 bg-white p-4 shadow-2xs">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="font-bold text-ink-900">{item.titleAr || (item.delta ? `رد ${item.delta} نقطة` : "مراجعة نتيجة")}</h3>
          <span className="rounded-full bg-sand-100 px-2.5 py-1 text-xs text-sand-700">{item.status === "pending" ? "بانتظار المراجعة" : item.status}</span>
        </div>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-sand-700">{item.bodyAr}</p>
        {item.customerDetails && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950">تفاصيل المستخدم: {item.customerDetails}</p>}
        <dl className="mt-3 grid grid-cols-1 gap-1 text-xs text-sand-500 sm:grid-cols-3">
          <div>المستخدم: <code dir="ltr">{item.userId}</code></div>
          <div>الطلب: <code dir="ltr">{item.jobId}</code></div>
          <div>{item.createdAt ? new Date(item.createdAt).toLocaleString("ar-EG") : ""}</div>
        </dl>
        {item.reasonCode && <p className="mt-2 text-[11px] text-sand-500">رمز المراجعة: <code dir="ltr">{item.reasonCode}</code></p>}
      </article>
    ))}</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-8 text-right">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-sand-200 pb-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-900">ردود حسن النية ومراجعات النتائج</h1>
          <p className="mt-1 text-sm text-sand-600">عرض فقط — لا توجد أزرار لتعديل الرصيد أو تغيير نتيجة المراجعة.</p>
        </div>
        <button type="button" onClick={() => void load()} className="min-h-11 rounded-lg border border-sand-300 bg-white px-4 text-sm font-semibold text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary">تحديث القائمة</button>
      </header>
      {enabled === false && <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">الميزة غير مفعّلة حالياً.</p>}
      {!storageAvailable && <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">تخزين المراجعات غير متاح حالياً؛ لم يتم عرض بيانات مخزنة.</p>}
      {error && <p role="alert" className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">{error}</p>}
      {loading ? <p role="status" className="py-6 text-sm text-sand-500">جاري تحميل السجلات…</p> : (
        <>
          <section className="space-y-3">
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-ink-900">ردود النقاط المسجلة</h2><span className="text-xs text-sand-500">{refunds.length}</span></div>
            {renderItems(refunds, "لا توجد ردود حسن نية مسجلة.")}
          </section>
          <section className="space-y-3">
            <div className="flex items-center justify-between"><h2 className="text-lg font-bold text-ink-900">قائمة المراجعة</h2><span className="text-xs text-sand-500">{reviews.length}</span></div>
            {renderItems(reviews, "لا توجد نتائج بانتظار المراجعة.")}
          </section>
        </>
      )}
    </div>
  );
}
