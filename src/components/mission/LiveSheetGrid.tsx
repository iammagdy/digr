"use client";

import { formatAr, toArabicDigits } from "@/lib/arabicDigits";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import type { LiveCell } from "@/lib/agentMission/stage2/liveSheet";

/**
 * STAGE 2 S9 (docs/STAGE-2.md): THE LIVE SHEET ON A DESKTOP, drawn like the file: one tab per sheet (the file's sheet names), the file's headers in order (right to left, the header row
 * frozen while the rows scroll), and pages of 50 rows from the polling window. A date shows its Cairo text, a link is a link, a number shows Arabic-Indic digits (the value itself is the
 * file's). The «م» numbering is the file's own column when the file has one; nothing is added. Draws only what the route sent.
 */
export const LIVE_PAGE_ROWS = 50;
export const LIVE_GRID_TITLE_AR = "ما جمعناه حتى الآن";
export const LIVE_PREV_AR = "السابق";
export const LIVE_NEXT_AR = "التالي";

export const cellTextOf = (c: LiveCell): string => (c.k === "date" ? c.d ?? c.v : c.k === "number" ? toArabicDigits(c.v) : c.v);

/** «١–٥٠ من ١٢٠»: the rows of the page shown, of the sheet's total. */
export const pageLineAr = (offset: number, shown: number, total: number): string => (total === 0 ? formatAr(0) : `${formatAr(offset + 1)}–${formatAr(offset + shown)} من ${formatAr(total)}`);

export function LiveSheetGrid({ data, onWindow = () => undefined }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void }) {
  const active = data.sheets.find((s) => s.stageKey === data.window.stageKey) ?? data.sheets[0];
  if (!active) return null;
  const offset = data.window.offset;
  const rows = data.window.rows;
  return (
    <section dir="rtl" data-testid="live-grid" className="flex flex-col gap-2" aria-label={LIVE_GRID_TITLE_AR}>
      <h3 className="m-0 text-[15px] font-semibold text-ink">{LIVE_GRID_TITLE_AR}</h3>
      {data.sheets.length > 1 ? (
        <div role="tablist" className="flex flex-wrap gap-2">
          {data.sheets.map((s) => (
            <button key={s.stageKey} role="tab" type="button" aria-selected={s.stageKey === active.stageKey} className={`min-h-11 rounded-full border px-4 text-[13px] ${s.stageKey === active.stageKey ? "border-0 bg-ac text-onac" : "border-ln2 bg-transparent text-ink"}`} onClick={() => onWindow({ sheet: s.stageKey, offset: 0, limit: LIVE_PAGE_ROWS })}>
              {s.nameAr} ({formatAr(s.total)})
            </button>
          ))}
        </div>
      ) : null}
      <div className="max-h-[480px] overflow-auto rounded-[10px] border border-ln" data-testid="live-grid-scroll">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 z-10 bg-sf2" data-testid="live-grid-head">
            <tr>{active.headers.map((h) => <th key={h} scope="col" className="whitespace-nowrap border-b border-ln px-2 py-2 text-right font-semibold text-ink">{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="odd:bg-sf even:bg-sf2" data-testid="live-grid-row">
                {r.cells.map((c, i) => (
                  <td key={i} className="max-w-[320px] break-words border-b border-ln px-2 py-1 align-top text-ink">
                    {c.k === "link" ? <a href={c.v} target="_blank" rel="noopener noreferrer" className="text-ac underline">{c.v}</a> : cellTextOf(c)}
                  </td>
                ))}
                <td className="border-b border-ln px-2 py-1 align-top text-ink2">{r.id}</td>
                {r.parentId !== null ? <td className="border-b border-ln px-2 py-1 align-top text-ink2">{r.parentId}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between gap-2 text-[13px] text-ink2">
        <button type="button" className="min-h-11 rounded-full border border-ln2 px-4 disabled:opacity-50" disabled={offset === 0} onClick={() => onWindow({ offset: Math.max(0, offset - LIVE_PAGE_ROWS), limit: LIVE_PAGE_ROWS })}>{LIVE_PREV_AR}</button>
        <span data-testid="live-grid-page">{pageLineAr(offset, rows.length, (data.sheets.find((s) => s.stageKey === active.stageKey)?.total ?? rows.length))}</span>
        <button type="button" className="min-h-11 rounded-full border border-ln2 px-4 disabled:opacity-50" disabled={offset + rows.length >= (data.sheets.find((s) => s.stageKey === active.stageKey)?.total ?? 0)} onClick={() => onWindow({ offset: offset + LIVE_PAGE_ROWS, limit: LIVE_PAGE_ROWS })}>{LIVE_NEXT_AR}</button>
      </div>
    </section>
  );
}

export default LiveSheetGrid;
