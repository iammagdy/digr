"use client";

import { useState } from "react";
import { dayLabel } from "@/lib/dayLabel";
import { pendingBlockView } from "@/lib/requests/pendingBlock";
import type { PendingIndexRow } from "@/lib/requests/types";

/**
 * «مهام قيد الإعداد»: the questions and plans that wait for the customer (created in the last 72 hours, newest first, 5 shown and «عرض الكل» for the rest). Nothing is held before approval, so «إلغاء» only ends the request.
 * The list comes from «طلباتي» (one request for the whole page) and a change is handed back to it, so the block and the tabs always agree.
 */
export default function OpenMissionsList({ items, busyId, error, onCancel }: { items: PendingIndexRow[]; busyId: string | null; error: string; onCancel: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0 && !error) return null;
  const { visible, showAllLabel } = pendingBlockView(items, expanded);
  return (
    <section aria-label="مهام قيد الإعداد" data-testid="open-missions" className="flex flex-col gap-2 rounded-3xl border border-ln bg-sf p-4">
      <h2 className="m-0 text-sm font-medium text-ink">مهام قيد الإعداد</h2>
      <p className="m-0 text-xs leading-[1.8] text-mut">مهام تنتظرك ولم يُحجز لها رصيد؛ تنتهي صلاحيتها بعد ٧٢ ساعة إن لم تعتمدها.</p>
      {visible.map((m) => (
        <div key={m.id} data-testid="open-mission" className="flex items-center justify-between gap-2 border-t border-ln pt-2">
          <div className="min-w-0 flex-1">
            <p className="m-0 break-words text-[13px] leading-[1.7] text-ink">{m.requestText || "طلب بدون نص"}</p>
            <p className="m-0 break-words text-xs leading-[1.7] text-mut">{m.stateAr}{m.createdAt ? ` · ${dayLabel(m.createdAt)}` : ""}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            {m.conversationId && <a href={`/dashboard/chat?c=${encodeURIComponent(m.conversationId)}`} className="min-h-11 content-center text-[13px] text-ink underline">افتحها</a>}
            {m.cancellable && <button type="button" disabled={busyId === m.id} onClick={() => onCancel(m.id)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink disabled:opacity-60">إلغاء</button>}
          </div>
        </div>
      ))}
      {showAllLabel && <button type="button" onClick={() => setExpanded(true)} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink">{showAllLabel}</button>}
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
    </section>
  );
}
