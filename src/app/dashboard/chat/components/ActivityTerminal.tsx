"use client";

import { useEffect, useRef, useState } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { sanitizeActivityError, sanitizeActivityText } from "@/functions/shared/liveActivityFeed";
import { REQUEST_STATUS_LABEL_AR, resolveRequestKind } from "@/lib/jobs/requestStatus";
import { normalizeEasternArabicDigits } from "@/lib/arabicNumbers";
import { onRequestFormats, producedFormats, type ResultFileIds, type ResultFormat } from "@/lib/producedFormats";

const FORMAT_LABEL_AR: Record<ResultFormat, string> = { xlsx: "إكسل", pdf: "بي دي إف", csv: "سي إس في" };

export interface TerminalEvent {
  $id: string;
  textAr: string;
  count?: number;
  kind: "info" | "progress" | "warning" | "error";
  createdAt: string;
}

interface ActivityTerminalProps {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  events: TerminalEvent[];
  rowsCollected: number;
  requestedRows?: number;
  reservedPoints?: number;
  chargedPoints?: number;
  duplicatesRemoved?: number;
  errorAr?: string;
  onClose?: () => void;
  onDownload?: (ext: "xlsx" | "pdf" | "csv") => void;
  /** Stored file ids of the finished job; a missing id means that format was not produced. */
  fileIds?: ResultFileIds | null;
}

const clock = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? toArabicDigits(
        `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(
          d.getSeconds()
        ).padStart(2, "0")}`
      )
    : "";
};

const PHASE_LABELS: Record<string, { label: string; badgeClass: string; dotClass: string }> = {
  queued: {
    label: "في قائمة الانتظار",
    badgeClass: "bg-sf border border-ln text-mut",
    dotClass: "bg-gold animate-pulse",
  },
  running: {
    label: "جاري التنفيذ",
    badgeClass: "bg-sf border border-ln text-ink",
    dotClass: "bg-teal animate-pulse",
  },
  done: {
    label: "اكتمل بنجاح",
    badgeClass: "bg-sf border border-ln text-ink",
    dotClass: "bg-ok",
  },
  failed: {
    label: "تعذر الاستكمال",
    badgeClass: "bg-sf border border-bad/30 text-bad",
    dotClass: "bg-bad",
  },
  cancelled: {
    label: "تم الإلغاء",
    badgeClass: "bg-sf border border-ln text-mut",
    dotClass: "bg-mut",
  },
};

export default function ActivityTerminal({
  status,
  events,
  rowsCollected,
  requestedRows,
  reservedPoints,
  chargedPoints,
  duplicatesRemoved = 0,
  errorAr,
  onClose,
  onDownload,
  fileIds,
}: ActivityTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollActive = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Parse duplicates removed from events if not explicitly passed. Events carry Arabic-Indic digits.
  // Per-page lines already include every exclusion of that page, so they win over the separate audit line.
  let effectiveDuplicates = duplicatesRemoved;
  if (!effectiveDuplicates && events) {
    let fromPages = 0;
    let fromAudit = 0;
    for (const ev of events) {
      const text = normalizeEasternArabicDigits(ev.textAr);
      const page = text.match(/مكرر أو مستبعد\s+(\d+)/);
      if (page && page[1]) fromPages += parseInt(page[1], 10);
      const audit = text.match(/استبعاد\s+(\d+)\s+سجل\s+مكرر/);
      if (audit && audit[1]) fromAudit += parseInt(audit[1], 10);
    }
    effectiveDuplicates = fromPages > 0 ? fromPages : fromAudit;
  }

  // Handle user scroll detection
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceToBottom < 40;
    isAutoScrollActive.current = atBottom;
    setUserScrolledUp(!atBottom);
  };

  // Auto-scroll when new events arrive if user was at bottom
  useEffect(() => {
    if (isAutoScrollActive.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, status, rowsCollected]);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isAutoScrollActive.current = true;
      setUserScrolledUp(false);
    }
  };

  // A finished run is "مكتمل" only when the requested volume was delivered (shared with the requests list).
  const finishedKind = status === "done" ? resolveRequestKind({ status, delivered: rowsCollected, requested: requestedRows }) : null;
  const basePhase = PHASE_LABELS[status] || PHASE_LABELS.running;
  const phase = finishedKind
    ? { ...basePhase, label: REQUEST_STATUS_LABEL_AR[finishedKind], dotClass: finishedKind === "partial" ? "bg-gold" : basePhase.dotClass }
    : basePhase;

  // Fallback initial event when events list is empty
  const displayEvents: TerminalEvent[] =
    events && events.length > 0
      ? events
      : [
          {
            $id: "init_default",
            textAr: "تم قبول الطلب وجاري بدء التنفيذ...",
            kind: "info",
            createdAt: new Date().toISOString(),
          },
        ];

  return (
    <div
      dir="rtl"
      className="flex h-full w-full flex-col overflow-hidden bg-sf text-ink font-sans antialiased select-text"
    >
      {/* 1. Panel Header */}
      <div className="flex shrink-0 flex-col border-b border-ln bg-sf2 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2.5 w-2.5 rounded-full relative">
              <span className={`h-full w-full rounded-full ${phase.dotClass}`} />
            </span>
            <span className="text-xs font-semibold text-ink">سجل النشاط والتنفيذ</span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium leading-none ${phase.badgeClass}`}
            >
              {phase.label}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="إغلاق لوحة النشاط"
                className="flex h-8 w-8 items-center justify-center rounded-full text-mut hover:bg-sf hover:text-ink transition-colors cursor-pointer"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Real-time KPI Summary */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-2xl border border-ln bg-sf p-2.5 text-center text-xs">
          <div className="flex flex-col items-center justify-center">
            <span className="text-[11px] text-mut">المقبول الفريد</span>
            <span className="mt-0.5 text-xs font-semibold text-ink">
              {formatAr(rowsCollected)}
              {requestedRows ? ` / ${formatAr(requestedRows)}` : ""}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center border-x border-ln">
            <span className="text-[11px] text-mut">التكرار المستبعد</span>
            <span className="mt-0.5 text-xs font-semibold text-ink">
              {formatAr(effectiveDuplicates)}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center">
            <span className="text-[11px] text-mut">
              {status === "done" ? "النقاط المخصومة" : "النقاط المحجوزة"}
            </span>
            <span className="mt-0.5 text-xs font-semibold text-gold">
              {status === "done" && typeof chargedPoints === "number"
                ? formatAr(chargedPoints)
                : typeof reservedPoints === "number"
                ? formatAr(reservedPoints)
                : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Scrolling Events Output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 text-[13px] leading-relaxed space-y-3"
      >
        {displayEvents.map((evt, idx) => {
          const isError = evt.kind === "error";
          const isProgress = evt.kind === "progress";
          const isWarning = evt.kind === "warning";

          const dotColor = isError
            ? "bg-bad"
            : isWarning
            ? "bg-gold"
            : isProgress
            ? "bg-teal"
            : "bg-mut/50";

          return (
            <div
              key={evt.$id || idx}
              className="flex items-start gap-2.5 rounded-xl px-2 py-1.5 transition-colors hover:bg-sf2"
            >
              <span className="shrink-0 text-fnt select-none text-xs tnum pt-0.5">
                {clock(evt.createdAt)}
              </span>
              <span className={`h-2 w-2 rounded-full shrink-0 mt-1.5 ${dotColor}`} />
              <span className={`flex-1 break-words leading-relaxed ${isError ? "text-bad font-medium" : "text-ink"}`}>
                {toArabicDigits(evt.kind === "error" ? sanitizeActivityError(evt.textAr) : sanitizeActivityText(evt.textAr))}
                {typeof evt.count === "number" && evt.count > 0 && (
                  <span className="mr-1.5 rounded-full bg-sf2 border border-ln px-2 py-0.5 text-[11px] text-mut">
                    {formatAr(evt.count)}
                  </span>
                )}
              </span>
            </div>
          );
        })}

        {status === "failed" && errorAr && !displayEvents.some((e) => e.kind === "error" || (errorAr && (e.textAr.includes(errorAr) || errorAr.includes(e.textAr)))) && (
          <div className="mt-3 rounded-2xl border border-bad/30 bg-bad/5 p-3 text-xs text-bad leading-relaxed">
            {sanitizeActivityError(errorAr)}
          </div>
        )}

        {status === "done" && (
          <div className="mt-3 rounded-2xl border border-ln bg-sf2 p-3 text-xs text-ink leading-relaxed">
            تم استخراج السجلات وإعداد ملفات النتائج وتوثيقها بنجاح.
          </div>
        )}
      </div>

      {/* User Scrolled Up Pill */}
      {userScrolledUp && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 rounded-full border border-ln bg-sf px-3 py-1 text-xs text-ink shadow-sm hover:bg-sf2 transition-all cursor-pointer"
          >
            <span>أحدث الأحداث ↓</span>
          </button>
        </div>
      )}

      {/* 3. Footer Actions (when completed) */}
      {status === "done" && onDownload && (
        <div className="shrink-0 border-t border-ln bg-sf2 p-3.5">
          <div className="text-xs text-mut mb-2 font-medium">الملفات الجاهزة للتحميل:</div>
          <div className="flex flex-wrap gap-2">
            {producedFormats(fileIds).map((ext) => (
              <button
                key={ext}
                type="button"
                onClick={() => onDownload(ext)}
                className="flex-1 min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-3.5 text-xs font-medium text-ink hover:bg-sf2 transition-colors"
              >
                {`تحميل ${FORMAT_LABEL_AR[ext]}`}
              </button>
            ))}
          </div>
          {onRequestFormats(fileIds).length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-mut">تُجهَّز عند الطلب:</span>
              {onRequestFormats(fileIds).map((ext) => (
                <button
                  key={ext}
                  type="button"
                  onClick={() => onDownload(ext)}
                  className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-3 text-[11px] text-ink hover:bg-sf transition-colors"
                >
                  {`جهّز ${FORMAT_LABEL_AR[ext]}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
