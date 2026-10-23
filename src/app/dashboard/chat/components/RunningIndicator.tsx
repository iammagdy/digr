"use client";

/**
 * The visible sign that a request is being worked on: three moving dots and the Arabic line. It is rendered only while the job runs
 * (the callers remove it when the job ends or fails). With reduced motion the dots stand still, fully visible (see `.run-dot`).
 */
export const RUNNING_LINE_AR = "جاري العمل على طلبك";

export default function RunningIndicator({ className = "" }: { className?: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="running-indicator" dir="rtl" className={`flex items-center gap-2 text-xs font-medium text-ink2 ${className}`}>
      <span aria-hidden="true" className="flex shrink-0 items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span key={i} className="run-dot h-1.5 w-1.5 rounded-full bg-ac" style={{ animationDelay: `${i * 0.18}s` }} />
        ))}
      </span>
      <span>{RUNNING_LINE_AR}</span>
    </div>
  );
}
