"use client";

import { useState } from "react";
import { Badge, StatusDot, type StatusTone } from "@/components/ui";
import {
  timelineWaitingText,
  type JobStatus,
  JOB_STATUS_LABEL_MAP,
  JOB_STATUS_TONE_MAP,
  formatNumber,
  formatTime,
} from "@/lib/honestDisplay";
import {
  deriveLiveActivitySnapshot,
  formatCurrentPostProgress,
  formatItemsCollectedProgress,
  formatPointsSpentVsReserved,
  sanitizeActivityText,
} from "@/functions/shared/liveActivityFeed";

export interface JobEvent {
  $id: string;
  textAr: string;
  count?: number;
  kind: "info" | "progress" | "warning" | "error";
  createdAt: string;
}

interface ActivityTimelineProps {
  status: JobStatus;
  events: JobEvent[];
  rowsCollected: number;
  /** Number of events fetched in this read; shown so a limited history is never mistaken for complete. */
  eventLimit?: number;
  spentPoints?: number;
  reservedPoints?: number;
}

const STATUS_META: Record<JobStatus, { label: string; tone: StatusTone; pulse: boolean }> = {
  queued: { label: JOB_STATUS_LABEL_MAP.queued, tone: JOB_STATUS_TONE_MAP.queued, pulse: false },
  running: { label: JOB_STATUS_LABEL_MAP.running, tone: JOB_STATUS_TONE_MAP.running, pulse: true },
  done: { label: JOB_STATUS_LABEL_MAP.done, tone: JOB_STATUS_TONE_MAP.done, pulse: false },
  failed: { label: JOB_STATUS_LABEL_MAP.failed, tone: JOB_STATUS_TONE_MAP.failed, pulse: false },
  cancelled: { label: JOB_STATUS_LABEL_MAP.cancelled, tone: JOB_STATUS_TONE_MAP.cancelled, pulse: false },
};

const KIND_TONE: Record<JobEvent["kind"], StatusTone> = {
  info: "info",
  progress: "accent",
  warning: "warning",
  error: "danger",
};

export default function ActivityTimeline({
  status,
  events,
  rowsCollected,
  eventLimit,
  spentPoints,
  reservedPoints,
}: ActivityTimelineProps) {
  const [collapsed, setCollapsed] = useState(false);
  const meta = STATUS_META[status];
  const hasEvents = events && events.length > 0;
  const scopeNote =
    eventLimit !== undefined && hasEvents && events.length >= eventLimit
      ? `يعرض أحدث ${formatNumber(eventLimit)} حدثًا مسجَّلًا.`
      : null;

  const liveSnapshot = deriveLiveActivitySnapshot({
    events: events || [],
    rowsCollected,
    chargedCredits: spentPoints,
    reservedCredits: reservedPoints,
    status,
  });

  const showPointsBar =
    typeof liveSnapshot.reservedPoints === "number" && liveSnapshot.reservedPoints > 0;

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-sand-200 bg-white shadow-[var(--shadow-card)]" aria-label="سجل نشاط التنفيذ">
      <header className="flex items-center justify-between gap-3 border-b border-sand-100 bg-sand-50/70 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusDot tone={meta.tone} pulse={meta.pulse} />
          <h3 className="truncate text-sm font-bold text-ink-900">سجل النشاط</h3>
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="min-h-11 shrink-0 cursor-pointer rounded-xl px-3 text-xs font-semibold text-sand-600 transition-colors hover:bg-sand-100 hover:text-ink-900"
        >
          {collapsed ? "عرض السجل" : "طي السجل"}
        </button>
      </header>

      {!collapsed && (
        <div className="p-4">
          {/* Live Progress Summary Strip (Arabic & Points Only) */}
          {(liveSnapshot.currentStepAr || showPointsBar || liveSnapshot.currentPostIndex !== undefined || rowsCollected > 0) && (
            <div className="mb-4 grid grid-cols-1 gap-2 rounded-xl border border-sand-200 bg-sand-50/80 p-3 text-xs sm:grid-cols-2">
              {liveSnapshot.currentStepAr && (
                <div>
                  <span className="text-sand-500">الخطوة الحالية: </span>
                  <strong className="text-ink-900">{liveSnapshot.currentStepAr}</strong>
                </div>
              )}
              {liveSnapshot.currentPostIndex !== undefined && liveSnapshot.totalPosts !== undefined && (
                <div className="tnum">
                  <strong className="text-ink-900">
                    {formatCurrentPostProgress(
                      liveSnapshot.currentPostIndex,
                      liveSnapshot.totalPosts,
                      liveSnapshot.currentPostTitleOrUrl || "منشور عام"
                    )}
                  </strong>
                </div>
              )}
              {(liveSnapshot.lastBatchComments !== undefined || rowsCollected > 0) && (
                <div className="tnum">
                  <strong className="text-ink-900">
                    {formatItemsCollectedProgress(
                      liveSnapshot.lastBatchComments ?? rowsCollected,
                      rowsCollected
                    )}
                  </strong>
                </div>
              )}
              {showPointsBar && (
                <div className="tnum">
                  <strong className="text-amber-points">
                    {formatPointsSpentVsReserved(
                      liveSnapshot.spentPoints ?? 0,
                      liveSnapshot.reservedPoints!
                    )}
                  </strong>
                </div>
              )}
            </div>
          )}

          {liveSnapshot.capReached && (
            <div className="mb-3 rounded-xl border border-amber-points/30 bg-amber-points-bg px-3.5 py-2.5 text-xs font-semibold text-ink-900">
              {liveSnapshot.capReached.messageAr}
            </div>
          )}

          {hasEvents ? (
            <>
              <ol className="relative space-y-0 border-s border-sand-200 ps-5">
                {events.map((evt, idx) => (
                  <li key={evt.$id || idx} className="relative pb-4 last:pb-0">
                    <span aria-hidden="true" className="absolute -start-5 top-1 flex h-4 w-4 -translate-x-1/2 items-center justify-center">
                      <StatusDot tone={KIND_TONE[evt.kind]} />
                    </span>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-xs font-semibold leading-relaxed text-ink-900">{sanitizeActivityText(evt.textAr)}</p>
                      <time className="tnum shrink-0 text-xs text-sand-500" dateTime={evt.createdAt}>{formatTime(evt.createdAt)}</time>
                    </div>
                    {evt.count !== undefined && (
                      <p className="tnum mt-0.5 text-xs text-sand-500">الرقم المسجّل في هذا الحدث: {formatNumber(evt.count)}</p>
                    )}
                  </li>
                ))}
              </ol>
              {scopeNote && <p className="mt-3 text-xs text-sand-500">{scopeNote}</p>}
            </>
          ) : (
            <div className="rounded-xl bg-sand-50/70 px-4 py-6 text-center">
              <p className="text-xs leading-relaxed text-sand-600">{timelineWaitingText(status)}</p>
            </div>
          )}

          {status === "done" && (
            <p className="tnum mt-3 border-t border-sand-100 pt-3 text-xs text-sand-600">
              اكتمل التنفيذ وفق سجلّ الخادم — السجلات المجمّعة: <strong className="text-ink-900">{formatNumber(rowsCollected)}</strong>.
              راجع ملاحظات التغطية في لوحة النتائج.
            </p>
          )}
          {status === "failed" && (
            <p className="mt-3 border-t border-sand-100 pt-3 text-xs leading-relaxed text-danger">
              توقّف التنفيذ بسبب خطأ. لن يُخصم من رصيدك أي مبلغ عن السجلات غير المسلَّمة.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

