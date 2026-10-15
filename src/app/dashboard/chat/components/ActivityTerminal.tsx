"use client";

import { useEffect, useRef, useState } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { formatNumber } from "@/lib/honestDisplay";

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
    badgeClass: "bg-amber-950/40 text-amber-300 border-amber-800/50",
    dotClass: "bg-amber-400 animate-pulse",
  },
  running: {
    label: "جاري التنفيذ",
    badgeClass: "bg-emerald-950/40 text-emerald-300 border-emerald-800/50",
    dotClass: "bg-emerald-400 animate-pulse",
  },
  done: {
    label: "اكتمل بنجاح",
    badgeClass: "bg-blue-950/40 text-blue-300 border-blue-800/50",
    dotClass: "bg-blue-400",
  },
  failed: {
    label: "تعذر الاستكمال",
    badgeClass: "bg-rose-950/40 text-rose-300 border-rose-800/50",
    dotClass: "bg-rose-400",
  },
  cancelled: {
    label: "تم الإلغاء",
    badgeClass: "bg-zinc-800/50 text-zinc-300 border-zinc-700/50",
    dotClass: "bg-zinc-400",
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
}: ActivityTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollActive = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Parse duplicates removed from events if not explicitly passed
  let effectiveDuplicates = duplicatesRemoved;
  if (!effectiveDuplicates && events) {
    for (const ev of events) {
      const match = ev.textAr.match(/استبعاد\s+(\d+)\s+سجل\s+مكرر/);
      if (match && match[1]) {
        effectiveDuplicates += parseInt(match[1], 10);
      }
    }
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

  const phase = PHASE_LABELS[status] || PHASE_LABELS.running;

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
      className="flex h-full w-full flex-col overflow-hidden bg-[#0c1017] text-[#c9d1d9] font-sans antialiased select-text"
    >
      {/* 1. Terminal Header */}
      <div className="flex shrink-0 flex-col border-b border-[#21262d] bg-[#161b22] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-2.5 w-2.5 rounded-full relative">
              <span className={`h-full w-full rounded-full ${phase.dotClass}`} />
            </span>
            <span className="text-xs font-semibold text-[#f0f6fc]">سجل النشاط والتنفيذ</span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${phase.badgeClass}`}
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
                className="flex h-7 w-7 items-center justify-center rounded-lg text-[#8b949e] hover:bg-[#21262d] hover:text-[#f0f6fc] transition-colors"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* Real-time KPI Summary */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-[#30363d] bg-[#0d1117] p-2.5 text-center text-xs">
          <div className="flex flex-col items-center justify-center">
            <span className="text-[11px] text-[#8b949e]">المقبول الفريد</span>
            <span className="mt-0.5 font-mono text-xs font-bold text-[#f0f6fc]">
              {formatAr(rowsCollected)}
              {requestedRows ? ` / ${formatAr(requestedRows)}` : ""}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center border-x border-[#21262d]">
            <span className="text-[11px] text-[#8b949e]">التكرار المستبعد</span>
            <span className="mt-0.5 font-mono text-xs font-bold text-amber-300">
              {formatAr(effectiveDuplicates)}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center">
            <span className="text-[11px] text-[#8b949e]">
              {status === "done" ? "النقاط المخصومة" : "النقاط المحجوزة"}
            </span>
            <span className="mt-0.5 font-mono text-xs font-bold text-emerald-400">
              {status === "done" && typeof chargedPoints === "number"
                ? formatAr(chargedPoints)
                : typeof reservedPoints === "number"
                ? formatAr(reservedPoints)
                : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Scrolling Terminal Output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed space-y-2.5 selection:bg-[#264f78]"
      >
        <div className="text-[11px] text-[#8b949e] border-b border-[#21262d] pb-2 mb-3">
          محطة رصد مهام الاستخراج المباشر — ديجر
        </div>

        {displayEvents.map((evt, idx) => {
          const isError = evt.kind === "error";
          const isProgress = evt.kind === "progress";
          const isWarning = evt.kind === "warning";

          const indicator = isError ? "[×]" : isWarning ? "[!]" : isProgress ? "[>]" : "[•]";
          const textColor = isError
            ? "text-rose-400"
            : isWarning
            ? "text-amber-300"
            : isProgress
            ? "text-emerald-300"
            : "text-[#c9d1d9]";

          return (
            <div
              key={evt.$id || idx}
              className={`flex items-start gap-2.5 rounded px-1.5 py-0.5 transition-colors ${textColor} hover:bg-[#161b22]`}
            >
              <span className="shrink-0 text-[#8b949e] select-none text-[11px]">
                {clock(evt.createdAt)}
              </span>
              <span className="shrink-0 select-none text-[11px] opacity-75">{indicator}</span>
              <span className="flex-1 break-words">
                {evt.textAr}
                {typeof evt.count === "number" && evt.count > 0 && (
                  <span className="mr-1.5 rounded bg-[#21262d] px-1.5 py-0.2 text-[10px] text-[#f0f6fc]">
                    {formatNumber(evt.count)}
                  </span>
                )}
              </span>
            </div>
          );
        })}

        {status === "failed" && errorAr && (
          <div className="mt-3 rounded border border-rose-900/60 bg-rose-950/30 p-2.5 text-xs text-rose-300">
            [خطأ في التنفيذ]: {errorAr}
          </div>
        )}

        {status === "done" && (
          <div className="mt-3 rounded border border-blue-900/60 bg-blue-950/30 p-2.5 text-xs text-blue-200">
            [اكتمل التنفيذ]: تم حفظ الملفات النهائية وتسوية الرصيد بنجاح.
          </div>
        )}
      </div>

      {/* User Scrolled Up Pill */}
      {userScrolledUp && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10">
          <button
            type="button"
            onClick={scrollToBottom}
            className="flex items-center gap-1.5 rounded-full border border-[#30363d] bg-[#161b22] px-3 py-1 text-xs text-[#f0f6fc] shadow-lg hover:bg-[#21262d] transition-all"
          >
            <span>أحدث الأحداث ↓</span>
          </button>
        </div>
      )}

      {/* 3. Footer Actions (when completed) */}
      {status === "done" && onDownload && (
        <div className="shrink-0 border-t border-[#21262d] bg-[#161b22] p-3">
          <div className="text-[11px] text-[#8b949e] mb-2">الملفات الجاهزة للتحميل:</div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onDownload("xlsx")}
              className="flex-1 min-h-9 cursor-pointer rounded-lg border border-[#30363d] bg-[#0d1117] px-3 text-xs font-semibold text-[#f0f6fc] hover:border-emerald-600 transition-colors"
            >
              تحميل Excel
            </button>
            <button
              type="button"
              onClick={() => onDownload("pdf")}
              className="flex-1 min-h-9 cursor-pointer rounded-lg border border-[#30363d] bg-[#0d1117] px-3 text-xs font-semibold text-[#f0f6fc] hover:border-blue-600 transition-colors"
            >
              تحميل PDF
            </button>
            <button
              type="button"
              onClick={() => onDownload("csv")}
              className="flex-1 min-h-9 cursor-pointer rounded-lg border border-[#30363d] bg-[#0d1117] px-3 text-xs font-semibold text-[#f0f6fc] hover:border-[#8b949e] transition-colors"
            >
              تحميل CSV
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
