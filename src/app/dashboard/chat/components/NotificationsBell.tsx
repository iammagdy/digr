"use client";

import { useCallback, useEffect, useState } from "react";

type Notice = { id: string; kind: string; titleAr: string; bodyAr: string; status: "read" | "unread"; delta: number | null; jobId: string | null; createdAt: string };

export default function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/notifications", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "تعذر تحميل الإشعارات");
      setItems(Array.isArray(payload.items) ? payload.items : []);
      setUnreadCount(Number(payload.unreadCount) || 0);
    } catch (cause: any) {
      setError(cause.message || "تعذر تحميل الإشعارات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function markRead(item: Notice) {
    if (item.status === "read") return;
    try {
      const response = await fetch("/api/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error || "تعذر تحديث الإشعار");
      setItems((current) => current.map((notice) => notice.id === item.id ? { ...notice, status: "read" } : notice));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch (cause: any) {
      setError(cause.message || "تعذر تحديث الإشعار");
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unreadCount ? `الإشعارات، ${unreadCount} غير مقروء` : "الإشعارات"}
        aria-expanded={open}
        onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}
        className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-sand-300 bg-white text-sand-700 transition-colors hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {unreadCount > 0 && <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-5 rounded-full bg-danger px-1 text-center text-[10px] font-bold leading-5 text-white">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>

      {open && (
        <section aria-label="قائمة الإشعارات" className="absolute left-1/2 top-full z-50 mt-2 w-[min(88vw,24rem)] -translate-x-1/2 overflow-hidden rounded-xl border border-sand-300 bg-white text-right shadow-xl">
          <header className="flex items-center justify-between border-b border-sand-200 px-4 py-3">
            <h2 className="text-sm font-bold text-ink-900">الإشعارات</h2>
            <button type="button" onClick={() => void load()} className="min-h-11 min-w-11 rounded-lg px-2 text-xs text-primary hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none">تحديث</button>
          </header>
          {error && <p role="alert" className="px-4 py-3 text-xs text-danger">{error}</p>}
          <div className="max-h-[60dvh] overflow-y-auto">
            {loading && items.length === 0 ? <p role="status" className="px-4 py-6 text-center text-xs text-sand-500">جاري التحميل…</p>
              : items.length === 0 ? <p className="px-4 py-6 text-center text-xs text-sand-500">لا توجد إشعارات جديدة.</p>
                : items.map((item) => (
                  <button key={item.id} type="button" onClick={() => void markRead(item)} className={`block min-h-11 w-full border-b border-sand-100 px-4 py-3 text-right transition-colors hover:bg-sand-50 focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none ${item.status === "unread" ? "bg-primary/5" : "bg-white"}`}>
                    <span className="flex items-start justify-between gap-3">
                      <span className="text-xs font-bold text-ink-900">{item.titleAr}</span>
                      {item.status === "unread" && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="غير مقروء" />}
                    </span>
                    <span className="mt-1 block text-xs leading-5 text-sand-700">{item.bodyAr}</span>
                    {item.createdAt && <time className="mt-1 block text-[10px] text-sand-500" dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("ar-EG")}</time>}
                  </button>
                ))}
          </div>
        </section>
      )}
    </div>
  );
}
