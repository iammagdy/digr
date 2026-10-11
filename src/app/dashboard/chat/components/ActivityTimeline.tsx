"use client";

import { useState } from "react";
import { Badge, StatusDot, type StatusTone } from "@/components/ui";
import { timelineWaitingText, type JobStatus } from "@/lib/honestDisplay";

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
}

const STATUS_META: Record<JobStatus, { label: string; tone: StatusTone; pulse: boolean }> = {
  queued: { label: "في الانتظار", tone: "warning", pulse: false },
  running: { label: "جارٍ التنفيذ", tone: "info", pulse: true },
  done: { label: "مكتمل", tone: "success", pulse: false },
  failed: { label: "فشل التنفيذ", tone: "danger", pulse: false },
  cancelled: { label: "ملغى", tone: "neutral", pulse: false },
};

const KIND_TONE: Record<JobEvent["kind"], StatusTone> = {
  info: "info",
  progress: "accent",
  warning: "warning",
  error: "danger",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export default function ActivityTimeline({ status, events, rowsCollected, eventLimit }: ActivityTimelineProps) {
  const [collapsed, setCollapsed] = useState(false);
  const meta = STATUS_META[status];
  const hasEvents = events && events.length > 0;
  const scopeNote =
    eventLimit !== undefined && hasEvents && events.length >= eventLimit
      ? `يعرض أحدث ${eventLimit.toLocaleString("ar-EG")} حدثًا مسجَّلًا.`
      : null;

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
          {hasEvents ? (
            <>
              <ol className="relative space-y-0 border-s border-sand-200 ps-5">
                {events.map((evt, idx) => (
                  <li key={evt.$id || idx} className="relative pb-4 last:pb-0">
                    <span aria-hidden="true" className="absolute -start-5 top-1 flex h-4 w-4 -translate-x-1/2 items-center justify-center">
                      <StatusDot tone={KIND_TONE[evt.kind]} />
                    </span>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-xs font-semibold leading-relaxed text-ink-900">{evt.textAr}</p>
                      <time className="tnum shrink-0 text-xs text-sand-500" dateTime={evt.createdAt}>{formatTime(evt.createdAt)}</time>
                    </div>
                    {evt.count !== undefined && (
                      <p className="tnum mt-0.5 text-xs text-sand-500">الرقم المسجّل في هذا الحدث: {evt.count.toLocaleString("ar-EG")}</p>
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
              اكتمل التنفيذ وفق سجلّ الخادم — السجلات المجمّعة: <strong className="text-ink-900">{rowsCollected.toLocaleString("ar-EG")}</strong>.
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
