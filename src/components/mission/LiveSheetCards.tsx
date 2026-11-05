"use client";

import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import { cellTextOf, LIVE_PAGE_ROWS, pageLineAr } from "./LiveSheetGrid";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): THE LIVE SHEET ON A PHONE (narrower than 640 px): the counter «X من N» on top (the file's own numbers), then one card per row with its first three filled
 * cells under their headers, and «عرض المزيد» for the next window. Draws only what the route sent.
 */
export const LIVE_COUNTER_TITLE_AR = "المجموع حتى الآن";
export const LIVE_MORE_AR = "عرض المزيد";
export const LIVE_BACK_AR = "عرض السابق";
const CARD_CELLS = 3;

export function LiveSheetCards({ data, onWindow = () => undefined }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void }) {
  const sheet = data.sheets.find((s) => s.stageKey === data.window.stageKey) ?? data.sheets[0];
  const offset = data.window.offset;
  const total = sheet?.total ?? 0;
  return (
    <section dir="rtl" data-testid="live-cards" className="flex flex-col gap-2">
      <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-[12px] bg-sf2 px-3 py-2 text-[14px] text-ink" role="status" data-testid="live-counter">
        <span className="text-ink2">{LIVE_COUNTER_TITLE_AR}</span>
        <span className="min-w-0 break-words text-[18px] font-semibold">{data.counterAr}</span>
      </p>
      {sheet ? (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {data.window.rows.map((r) => (
            <li key={r.id} className="rounded-[12px] border border-ln bg-sf p-3" data-testid="live-card">
              <dl className="m-0 flex flex-col gap-1">
                {r.cells.map((c, i) => ({ c, h: sheet.headers[i] })).filter((x) => x.c.k !== "empty" && x.h).slice(0, CARD_CELLS).map(({ c, h }) => (
                  <div key={h} className="flex flex-col">
                    <dt className="text-[12px] text-ink2">{h}</dt>
                    <dd className="m-0 break-words text-[14px] text-ink">{c.k === "link" ? <a href={c.v} target="_blank" rel="noopener noreferrer" className="text-ac underline">{c.v}</a> : cellTextOf(c)}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      {sheet ? <p className="m-0 text-center text-[12px] text-ink2" data-testid="live-cards-page">{pageLineAr(offset, data.window.rows.length, total)}</p> : null}
      <div className="flex justify-center gap-2">
        {offset > 0 ? <button type="button" className="min-h-11 rounded-full border border-ln2 px-4 text-[13px]" onClick={() => onWindow({ offset: Math.max(0, offset - LIVE_PAGE_ROWS), limit: LIVE_PAGE_ROWS })}>{LIVE_BACK_AR}</button> : null}
        {offset + data.window.rows.length < total ? <button type="button" className="min-h-11 rounded-full border border-ln2 px-4 text-[13px]" onClick={() => onWindow({ offset: offset + LIVE_PAGE_ROWS, limit: LIVE_PAGE_ROWS })}>{LIVE_MORE_AR}</button> : null}
      </div>
    </section>
  );
}

export default LiveSheetCards;
