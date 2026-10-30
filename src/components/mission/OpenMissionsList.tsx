"use client";

import { useCallback, useEffect, useState } from "react";

interface OpenMissionItem { id: string; stateAr: string; requestText: string; blocksNewRequests: boolean; cancellable: boolean; conversationId: string | null }

/**
 * «مهام قيد الإعداد»: the missions that exist but are not jobs yet (queued, being planned, a question waiting for the customer's answer, a plan waiting for approval), each with its state. It is read from the
 * same function that decides whether a new request is allowed, so whatever blocks a request is listed here. A mission that waits for the customer can be opened in its conversation or cancelled (nothing is held before approval).
 */
export default function OpenMissionsList() {
  const [items, setItems] = useState<OpenMissionItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/missions", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.success && Array.isArray(json.missions)) setItems(json.missions as OpenMissionItem[]);
    } catch { /* the list is a courtesy of «طلباتي»: it stays as it was */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function cancel(id: string) {
    setBusy(id);
    setError("");
    try {
      const res = await fetch(`/api/missions/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
      if (!res.ok) setError("تعذّر إلغاء المهمة الآن. حاول بعد قليل.");
    } catch { setError("تعذّر إلغاء المهمة الآن. حاول بعد قليل."); }
    setBusy(null);
    await load();
  }

  if (items.length === 0) return null;
  return (
    <section aria-label="مهام قيد الإعداد" data-testid="open-missions" className="flex flex-col gap-2 rounded-3xl border border-ln bg-sf p-4">
      <h2 className="m-0 text-sm font-medium text-ink">مهام قيد الإعداد</h2>
      <p className="m-0 text-xs leading-[1.8] text-mut">مهام لم تبدأ التنفيذ بعد ولم يُحجز لها رصيد. التي تنتظرك لا تمنعك من طلب جديد.</p>
      {items.map((m) => (
        <div key={m.id} data-testid="open-mission" className="flex flex-wrap items-center justify-between gap-2 border-t border-ln pt-2">
          <div className="min-w-0">
            <p className="m-0 truncate text-[13px] text-ink">{m.requestText || "طلب بدون نص"}</p>
            <p className="m-0 text-xs text-mut">{m.stateAr}</p>
          </div>
          <div className="flex gap-2">
            {m.conversationId && <a href={`/dashboard/chat?c=${encodeURIComponent(m.conversationId)}`} className="min-h-11 content-center text-[13px] text-ink underline">افتحها</a>}
            {m.cancellable && <button type="button" disabled={busy === m.id} onClick={() => void cancel(m.id)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink disabled:opacity-60">إلغاء</button>}
          </div>
        </div>
      ))}
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
    </section>
  );
}
