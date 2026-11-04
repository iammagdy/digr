"use client";

import { useState } from "react";
import { dayLabel } from "@/lib/dayLabel";
import { pendingBlockView, pendingSummaryAr } from "@/lib/requests/pendingBlock";
import type { PendingIndexRow } from "@/lib/requests/types";

/**
 * «طلبات تنتظرك»: the questions and plans that wait for the customer (created in the last 72 hours, newest first, 5 shown and «عرض الكل» for the rest). Nothing is held before approval, so «إلغاء» only ends the request.
 * ROUND 14: it is ONE LINE («٤ خطط تنتظر اعتمادك») that expands, and it sits BELOW the requests that are running (the page orders them); an open list never pushes a running request off the screen.
 * The list comes from «طلباتي» (one request for the whole page) and a change is handed back to it, so the block and the tabs always agree.
 */
export default function OpenMissionsList({ items, busyId, error, onCancel, defaultOpen = false }: { items: PendingIndexRow[]; busyId: string | null; error: string; onCancel: (id: string) => void; /** Open from the start (tests; the page never sets it). */ defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0 && !error) return null;
  const { visible, showAllLabel } = pendingBlockView(items, expanded);
  return (
    <section aria-label="طلبات تنتظرك" data-testid="open-missions" className="flex flex-col gap-2 rounded-3xl border border-ln bg-sf p-4">
      <button type="button" aria-expanded={open} aria-controls="open-missions-list" data-testid="open-missions-toggle" onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 border-0 bg-transparent p-0 text-start text-[14px] font-medium text-ink">
        <span className="min-w-0 break-words">{pendingSummaryAr(items)}</span>
        <span aria-hidden="true" className="shrink-0 text-mut">{open ? "▴" : "▾"}</span>
      </button>
      {open ? (
        <div id="open-missions-list" className="flex flex-col gap-2" data-testid="open-missions-list">
          <p className="m-0 text-xs leading-[1.8] text-mut">طلبات تنتظرك ولم يُحجز لها رصيد؛ تنتهي صلاحيتها بعد ٧٢ ساعة إن لم تعتمدها.</p>
          {visible.map((m) => (
            <div key={m.id} data-testid="open-mission" className="flex items-center justify-between gap-2 border-t border-ln pt-2">
              <div className="min-w-0 flex-1">
                <p className="m-0 break-words text-[13px] leading-[1.7] text-ink">{m.requestText || "طلب بدون نص"}</p>
                <p className="m-0 break-words text-xs leading-[1.7] text-mut">{m.stateAr}{m.createdAt ? ` · ${dayLabel(m.createdAt)}` : ""}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {m.conversationId && <a href={`/dashboard/chat?c=${encodeURIComponent(m.conversationId)}`} className="min-h-11 content-center text-[13px] text-ink underline">افتحها</a>}
                {m.cancellable && <button type="button" disabled={busyId !== null} onClick={() => onCancel(m.id)} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink disabled:opacity-60">{busyId === m.id ? "جارٍ الإلغاء…" : "إلغاء"}</button>}
              </div>
            </div>
          ))}
          {showAllLabel && <button type="button" onClick={() => setExpanded(true)} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-4 text-[13px] text-ink">{showAllLabel}</button>}
        </div>
      ) : null}
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
    </section>
  );
}
