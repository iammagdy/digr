"use client";

import type { WorkLogLine } from "@/lib/agentMission/stage2/workLog";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): «دفتر شغل». The lines come from the fixed whitelist of `workLog.ts` (never a provider, an endpoint, a dollar amount or a model name); nothing here makes text
 * of its own but the labels.
 *
 * LAUNCH ROUND (the owner's design): ONE short status line, the NEWEST event with its Cairo time, replaced as the work goes on; the recent lines before it open under «آخر التحديثات».
 */
export const LIVE_WORK_LOG_TITLE_AR = "دفتر شغل";
export const LIVE_WORK_LOG_HISTORY_AR = "آخر التحديثات";

export function LiveWorkLog({ lines }: { lines: ReadonlyArray<WorkLogLine> }) {
  if (lines.length === 0) return null;
  const ordered = [...lines].sort((a, b) => a.at - b.at);
  const latest = ordered[ordered.length - 1];
  const earlier = ordered.slice(0, -1).reverse();
  return (
    <section dir="rtl" data-testid="live-work-log" className="flex min-w-0 flex-col gap-1 rounded-[12px] border border-ln bg-sf px-3 py-2" aria-label={LIVE_WORK_LOG_TITLE_AR}>
      <p className="m-0 flex min-w-0 items-baseline gap-2 text-[13px] leading-[1.8] text-ink" role="status" aria-live="polite" data-testid="live-work-latest">
        <span className="shrink-0 font-semibold">{LIVE_WORK_LOG_TITLE_AR}</span>
        <span className="shrink-0 text-ink2">{latest.timeAr}</span>
        <span className="min-w-0 break-words" data-testid="live-work-line">{latest.textAr}</span>
      </p>
      {earlier.length > 0 ? (
        <details data-testid="live-work-history">
          <summary className="min-h-11 cursor-pointer content-center text-[12px] text-ac">{LIVE_WORK_LOG_HISTORY_AR}</summary>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {earlier.map((l, i) => (
              <li key={`${l.at}-${i}`} className="flex gap-2 text-[13px] leading-[1.8] text-ink" data-testid="live-work-line">
                <span className="shrink-0 text-ink2">{l.timeAr}</span>
                <span className="min-w-0 break-words">{l.textAr}</span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

export default LiveWorkLog;
