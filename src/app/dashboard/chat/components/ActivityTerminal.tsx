"use client";

import { useEffect, useRef, useState } from "react";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import { deriveLiveActivitySnapshot, sanitizeActivityError, sanitizeActivityText } from "@/functions/shared/liveActivityFeed";
import { REQUEST_STATUS_LABEL_AR, resolveRequestKind } from "@/lib/jobs/requestStatus";
import { summarizeActivityCounts } from "@/lib/activityCounts";
import { settleTimelineEvents, timelineWaitingText } from "@/lib/honestDisplay";
import { producedFormats, type ResultFileIds, type ResultFormat } from "@/lib/producedFormats";
import { liveEventsForDisplay, PREVIEW_TITLE_AR, PREVIEW_WAITING_AR, postSelectionFromEvents, previewCountsLineAr, type LivePreviewSample } from "@/lib/liveJobView";
import RunningIndicator from "./RunningIndicator";

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
  /** Number of events fetched in this read; shown so a limited history is never mistaken for complete. */
  eventLimit?: number;
  /** A few accepted rows of the running request; null or missing: the counts only. */
  preview?: LivePreviewSample | null;
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
    dotClass: "bg-ac animate-pulse",
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
  eventLimit,
  preview,
}: ActivityTerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollActive = useRef(true);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // Counts come from the page lines the run already wrote (Arabic-Indic digits are read back). An explicit duplicates count wins.
  const counts = summarizeActivityCounts(events);
  const effectiveDuplicates = duplicatesRemoved || counts.excluded;
  const isLive = status === "running" || status === "queued";

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

  // The failure panel below renders the final, customer-safe reason, so its duplicate error event is left out of the list.
  const settledEvents = settleTimelineEvents(status === "failed" && errorAr ? events.filter((e) => e.kind !== "error") : events, status);
  // One remaining-time figure on the screen (the chat's, from the real chunk times): the worker's own time inside a page line is dropped here,
  // and a line that repeats the one before it is shown once.
  const displayEvents: TerminalEvent[] = settledEvents && settledEvents.length > 0 ? liveEventsForDisplay(settledEvents) : [];
  const liveSnapshot = deriveLiveActivitySnapshot({ events: displayEvents, rowsCollected, chargedCredits: chargedPoints, reservedCredits: reservedPoints, status });
  const spent = liveSnapshot.spentPoints ?? chargedPoints ?? 0;
  const reserved = liveSnapshot.reservedPoints ?? reservedPoints;
  const scopeNote = eventLimit !== undefined && displayEvents.length > 0 && events.length >= eventLimit ? `يعرض أحدث ${formatAr(eventLimit)} حدثًا مسجَّلًا.` : null;
  // While the review runs the accepted count is still being decided: it is shown as a plain count with a note, never as a shortfall.
  const acceptedNote = isLive && (counts.underReview ?? 0) > 0 ? "بعد انتهاء المراجعة" : requestedRows ? `من ${formatAr(requestedRows)} مطلوب` : null;

  return (
    <div
      dir="rtl"
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-sf text-ink font-sans antialiased select-text"
    >
      {/* 1. Panel Header */}
      <div className="flex shrink-0 flex-col border-b border-ln bg-sf2 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="flex h-2 w-2 shrink-0 rounded-full relative">
              <span className={`h-full w-full rounded-full ${phase.dotClass}`} />
            </span>
            <span className="text-xs font-semibold text-ink">سجل النشاط والتنفيذ</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium leading-none ${phase.badgeClass}`}
            >
              {phase.label}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
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

        {/* Real-time summary: what the source returned, what waits for review, what was accepted, and the points */}
        <div className="mt-2 grid grid-cols-4 gap-1 rounded-xl border border-ln bg-sf p-1.5 text-center" data-testid="activity-kpis">
          <div className="flex min-w-0 flex-col items-center justify-center" data-testid="kpi-received">
            <span className="text-[10px] leading-4 text-mut">استلمنا</span>
            <span className="text-xs font-semibold leading-5 text-ink">{counts.received === null ? "—" : formatAr(counts.received)}</span>
          </div>

          <div className="flex min-w-0 flex-col items-center justify-center border-s border-ln" data-testid="kpi-under-review">
            <span className="text-[10px] leading-4 text-mut">قيد المراجعة</span>
            <span className="text-xs font-semibold leading-5 text-ink">{counts.underReview === null ? "—" : formatAr(counts.underReview)}</span>
          </div>

          <div className="flex min-w-0 flex-col items-center justify-center border-s border-ln" data-testid="kpi-accepted">
            <span className="text-[10px] leading-4 text-mut">المقبول</span>
            <span className="text-xs font-semibold leading-5 text-ink">{formatAr(rowsCollected)}</span>
            {acceptedNote && <span className="text-[9px] leading-3 text-fnt" data-testid="kpi-accepted-note">{acceptedNote}</span>}
          </div>

          <div className="flex min-w-0 flex-col items-center justify-center border-s border-ln" data-testid="kpi-points">
            <span className="text-[10px] leading-4 text-mut">
              {status === "done" ? "النقاط المخصومة" : "النقاط المحجوزة"}
            </span>
            <span className="text-xs font-semibold leading-5 text-gold">
              {status === "done" && typeof chargedPoints === "number"
                ? formatAr(chargedPoints)
                : typeof reservedPoints === "number"
                ? formatAr(reservedPoints)
                : "—"}
            </span>
          </div>
        </div>
        {(effectiveDuplicates > 0 || (typeof reserved === "number" && reserved > 0)) && (
          <p className="m-0 mt-1.5 text-[11px] leading-4 text-mut" data-testid="activity-caption">
            {effectiveDuplicates > 0 ? `مكرر أو مستبعد ${formatAr(effectiveDuplicates)}` : ""}
            {effectiveDuplicates > 0 && typeof reserved === "number" && reserved > 0 ? " · " : ""}
            {typeof reserved === "number" && reserved > 0 ? `مصروف ${formatAr(spent)} من ${formatAr(reserved)}` : ""}
          </p>
        )}
      </div>

      {/* 2. Scrolling Events Output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 text-xs leading-5"
      >
        {liveSnapshot.capReached && (
          <p className="mb-2 mt-0 rounded-xl px-3 py-2 text-xs text-ink" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)" }}>
            {liveSnapshot.capReached.messageAr}
          </p>
        )}

        {isLive && (
          <section className="mb-2 rounded-xl border border-ln bg-sf2 p-2" data-testid="live-preview" aria-label={PREVIEW_TITLE_AR}>
            <h3 className="m-0 mb-1 text-[11px] font-semibold text-ink">{PREVIEW_TITLE_AR}</h3>
            {preview && preview.rows.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-0 border-collapse text-[11px] leading-4" data-testid="live-preview-table">
                  <thead>
                    <tr>
                      {preview.columns.map((column) => (
                        <th key={column.key} className="border-b border-ln px-1.5 py-1 text-start font-semibold text-mut">{column.titleAr}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="max-w-[10rem] break-words border-b border-ln/60 px-1.5 py-1 align-top text-ink">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="m-0 text-[11px] leading-4 text-mut" data-testid="live-preview-waiting">{PREVIEW_WAITING_AR}</p>
            )}
            <p className="m-0 mt-1 text-[11px] leading-4 text-mut" data-testid="live-preview-counts">
              {previewCountsLineAr({ accepted: rowsCollected, requested: requestedRows, received: counts.received, underReview: counts.underReview, posts: postSelectionFromEvents(events) })}
            </p>
          </section>
        )}

        {displayEvents.length === 0 && (
          <p className="m-0 py-1 text-xs text-mut" data-testid="activity-waiting">{timelineWaitingText(status)}</p>
        )}

        <ol className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="activity-events">
          {displayEvents.map((evt, idx) => {
            const isError = evt.kind === "error";
            const isProgress = evt.kind === "progress";
            const isWarning = evt.kind === "warning";

            const dotColor = isError
              ? "bg-bad"
              : isWarning
              ? "bg-gold"
              : isProgress
              ? "bg-ac"
              : "bg-mut/50";

            return (
              <li
                key={evt.$id || idx}
                data-testid="activity-event"
                className="flex items-start gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-sf2"
              >
                {/* The time has its own fixed-width box, isolated from the surrounding right-to-left text, so it never touches the line. */}
                <time
                  dir="ltr"
                  dateTime={evt.createdAt}
                  data-testid="activity-time"
                  className="tnum w-[3.6rem] shrink-0 select-none pt-px text-start text-[11px] leading-5 text-fnt"
                  style={{ unicodeBidi: "isolate" }}
                >
                  {clock(evt.createdAt)}
                </time>
                <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
                <span className={`min-w-0 flex-1 break-words ${isError ? "font-medium text-bad" : "text-ink"}`} data-testid="activity-text">
                  {toArabicDigits(evt.kind === "error" ? sanitizeActivityError(evt.textAr) : sanitizeActivityText(evt.textAr))}
                </span>
              </li>
            );
          })}
        </ol>

        {scopeNote && <p className="m-0 mt-2 text-[11px] text-fnt">{scopeNote}</p>}

        {status === "failed" && errorAr && !displayEvents.some((e) => e.kind === "error" || (errorAr && (e.textAr.includes(errorAr) || errorAr.includes(e.textAr)))) && (
          <div className="mt-2 rounded-xl border border-bad/30 bg-bad/5 p-2.5 text-xs text-bad leading-5">
            {sanitizeActivityError(errorAr)}
          </div>
        )}

        {status === "done" && (
          <div className="mt-2 rounded-xl border border-ln bg-sf2 p-2.5 text-xs text-ink leading-5">
            تم استخراج السجلات وإعداد ملفات النتائج وتوثيقها بنجاح.
          </div>
        )}

        {/* In-progress sign at the bottom of the list: only while the request runs, gone when it ends or fails. */}
        {isLive && <RunningIndicator className="mt-2 px-1.5 py-1" />}
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
        <div className="shrink-0 border-t border-ln bg-sf2 p-3">
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
        </div>
      )}
    </div>
  );
}
