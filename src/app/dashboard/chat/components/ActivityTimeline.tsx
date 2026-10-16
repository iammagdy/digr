"use client";

import {
  timelineWaitingText,
  type JobStatus,
  formatNumber,
} from "@/lib/honestDisplay";
import { formatAr, toArabicDigits } from "@/lib/arabicDigits";

/** Design timeline clock: 24-hour «١٢:٤٠», no AM/PM. */
const clock = (iso?: string) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? toArabicDigits(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`) : "";
};
import {
  deriveLiveActivitySnapshot,
  sanitizeActivityError,
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
  const hasEvents = events && events.length > 0;
  const scopeNote =
    eventLimit !== undefined && hasEvents && events.length >= eventLimit
      ? `يعرض أحدث ${formatAr(eventLimit)} حدثًا مسجَّلًا.`
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
        <span className="text-2xl font-normal text-ink">{formatAr(rowsCollected)}</span>
        <span className="text-[13px] font-light text-mut">
          {requestedRows ? `من ${formatAr(requestedRows)} سجل · ` : ""}
          {typeof reserved === "number" && reserved > 0 ? `مصروف ${formatAr(spent)} من ${formatAr(reserved)}` : null}
        </span>
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-[3px] bg-sf2">
        <div className="h-full bg-gold" style={{ width: `${pct}%`, transition: "width .8s cubic-bezier(.2,.7,.2,1)" }} />
      </div>

      {liveSnapshot.capReached && (
        <p className="mb-0 mt-3 rounded-[14px] px-3.5 py-2.5 text-xs text-ink" style={{ background: "color-mix(in oklab, var(--gold) 10%, transparent)" }}>
          {liveSnapshot.capReached.messageAr}
        </p>
      )}

      {(
        <div className="mt-4 flex flex-col gap-3">
          {hasEvents ? (
            events.map((evt, idx) => (
              <p
                key={evt.$id || idx}
                className="m-0 flex gap-3 text-sm font-light"
                style={{ color: evt.kind === "error" ? "var(--bad)" : "var(--ink2)", animation: "up .35s both" }}
              >
                <time className="tnum min-w-10 text-fnt" dateTime={evt.createdAt}>{clock(evt.createdAt)}</time>
                <span>
                  {toArabicDigits(evt.kind === "error" ? sanitizeActivityError(evt.textAr) : sanitizeActivityText(evt.textAr))}
                  {evt.count !== undefined && <span className="tnum text-fnt"> · {formatAr(evt.count)}</span>}
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
