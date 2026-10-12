"use client";

import { useState } from "react";
import {
  timelineWaitingText,
  type JobStatus,
  formatNumber,
  formatTime,
} from "@/lib/honestDisplay";
import { formatAr } from "@/lib/arabicDigits";
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
  /** Records the approved plan asked for (progress denominator). */
  requestedRows?: number;
}

export default function ActivityTimeline({
  status,
  events,
  rowsCollected,
  eventLimit,
  spentPoints,
  reservedPoints,
  requestedRows,
}: ActivityTimelineProps) {
  const [collapsed, setCollapsed] = useState(false);
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

  const spent = liveSnapshot.spentPoints ?? spentPoints ?? 0;
  const reserved = liveSnapshot.reservedPoints ?? reservedPoints;
  const pct = requestedRows && requestedRows > 0 ? Math.min(100, (rowsCollected / requestedRows) * 100) : status === "done" ? 100 : 0;

  return (
    <div className="mt-4" style={{ animation: "up .5s both" }} aria-label="سجل نشاط التنفيذ" role="region">
      <div className="flex items-baseline justify-between gap-3">
        <span className="tnum text-2xl font-normal text-ink">{formatAr(rowsCollected)}</span>
        <span className="text-[13px] font-light text-mut">
          {requestedRows ? `من ${formatAr(requestedRows)} سجل · ` : ""}
          {typeof reserved === "number" && reserved > 0 ? formatPointsSpentVsReserved(spent, reserved) : null}
        </span>
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-[3px] bg-sf2">
        <div className="h-full bg-gold" style={{ width: `${pct}%`, transition: "width .8s cubic-bezier(.2,.7,.2,1)" }} />
      </div>

      {(liveSnapshot.currentStepAr || liveSnapshot.currentPostIndex !== undefined) && status === "running" && (
        <p className="tnum mb-0 mt-3 text-xs font-light text-fnt">
          {liveSnapshot.currentStepAr}
          {liveSnapshot.currentPostIndex !== undefined && liveSnapshot.totalPosts !== undefined && (
            <> · {formatCurrentPostProgress(liveSnapshot.currentPostIndex, liveSnapshot.totalPosts, liveSnapshot.currentPostTitleOrUrl || "منشور عام")}</>
          )}
          {(liveSnapshot.lastBatchComments !== undefined) && <> · {formatItemsCollectedProgress(liveSnapshot.lastBatchComments, rowsCollected)}</>}
        </p>
      )}

      {liveSnapshot.capReached && (
        <p className="mb-0 mt-3 rounded-[14px] px-3.5 py-2.5 text-xs text-ink" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)" }}>
          {liveSnapshot.capReached.messageAr}
        </p>
      )}

      {hasEvents && (
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-expanded={!collapsed}
          className="mt-3 min-h-11 cursor-pointer border-0 bg-transparent px-0 text-xs text-mut"
        >
          {collapsed ? "عرض السجل" : "طي السجل"}
        </button>
      )}

      {!collapsed && (
        <div className="mt-1 flex flex-col gap-2.5">
          {hasEvents ? (
            events.map((evt, idx) => (
              <p
                key={evt.$id || idx}
                className="m-0 flex gap-3 text-sm font-light"
                style={{ color: evt.kind === "error" ? "var(--bad)" : "var(--ink2)", animation: "up .35s both" }}
              >
                <time className="tnum min-w-10 text-fnt" dateTime={evt.createdAt}>{formatTime(evt.createdAt)}</time>
                <span>
                  {sanitizeActivityText(evt.textAr)}
                  {evt.count !== undefined && <span className="tnum text-fnt"> · {formatNumber(evt.count)}</span>}
                </span>
              </p>
            ))
          ) : (
            <p className="m-0 text-sm font-light text-mut" style={{ animation: "breathe 1.4s infinite" }}>{timelineWaitingText(status)}</p>
          )}
          {scopeNote && <p className="m-0 text-xs text-fnt">{scopeNote}</p>}
        </div>
      )}
    </div>
  );
}
