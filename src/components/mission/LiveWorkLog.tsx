"use client";

import type { WorkLogLine } from "@/lib/agentMission/stage2/workLog";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): «دفتر شغل», the newest lines first, each with its Cairo time. The lines come from the fixed whitelist of `workLog.ts` (never a provider, an endpoint, a
 * dollar amount or a model name); nothing here makes text of its own but the title.
 */
export const LIVE_WORK_LOG_TITLE_AR = "دفتر شغل";

export function LiveWorkLog({ lines }: { lines: ReadonlyArray<WorkLogLine> }) {
  if (lines.length === 0) return null;
  return (
    <section dir="rtl" data-testid="live-work-log" className="flex flex-col gap-1 rounded-[12px] border border-ln bg-sf p-3" aria-label={LIVE_WORK_LOG_TITLE_AR}>
      <h4 className="m-0 text-[13px] font-semibold text-ink">{LIVE_WORK_LOG_TITLE_AR}</h4>
      <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-live="polite">
        {[...lines].reverse().map((l, i) => (
          <li key={`${l.at}-${i}`} className="flex gap-2 text-[13px] leading-[1.8] text-ink" data-testid="live-work-line">
            <span className="shrink-0 text-ink2">{l.timeAr}</span>
            <span className="min-w-0 break-words">{l.textAr}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default LiveWorkLog;
