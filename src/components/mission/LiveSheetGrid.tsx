"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type UIEvent } from "react";
import { formatAr } from "@/lib/arabicDigits";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import type { LiveCell } from "@/lib/agentMission/stage2/liveSheet";
import {
  ARRIVAL_MS, COL_WIDTH, EDGE_MS, HEADER_HEIGHT, LIVE_CLOSE_AR, LIVE_CUT_NOTE_AR, LIVE_EMPTY_VALUE_AR, LIVE_FINAL_TITLE_AR, LIVE_GRID_TITLE_AR, LIVE_HIDE_AR, LIVE_NEXT_ROW_AR, LIVE_OPEN_CHIP_AR,
  LIVE_OPEN_LINK_AR, LIVE_PREV_ROW_AR, LIVE_ROW_NUMBER_LABEL_AR, LIVE_SHEETS_LABEL_AR, ROW_HEIGHT, ROW_NUMBER_WIDTH, VISIBLE_ROWS, cellTextOf, displayCellsOf, showSheetAr, statusLineOf, type ColKind,
} from "@/lib/agentMission/stage2/liveSheetView";
import { useLiveRows, useNow, type LiveRows } from "@/hooks/useLiveRows";
import { LiveSheetBar, LiveSheetCounter, LiveSheetDot, LiveStatusLine } from "./LiveSheetParts";

/**
 * STAGE 2: THE LIVE SHEET ON A DESKTOP (the Claude Design handoff «Diger live sheet», 16 Nov 2026). A spreadsheet that fills row by row: a slim toolbar (the live dot, the title, the counter,
 * the fold button), a thin bar, then a grid with a frozen header row and a frozen row-number column, fixed 32 px rows, one line per cell with an ellipsis, column widths by kind, links as a
 * small «فتح ↗» chip. New rows land at the bottom one at a time (a short fade and a gold highlight) and the grid FOLLOWS them, until the customer scrolls up: then a chip «نتائج جديدة ↓ (n)»
 * brings them back. A click on a row opens every field of it in a side panel. The file's sheets are Excel-like tabs at the bottom, next to one status line (it replaces the old «دفتر شغل»
 * box). Only rows of the route's answers are drawn; a row is virtualised (only the visible rows and 20 around them are in the page).
 */
export { LIVE_FINAL_TITLE_AR, LIVE_GRID_TITLE_AR, LIVE_PROGRESS_LABEL_AR, LIVE_SHEETS_LABEL_AR, cellTextOf } from "@/lib/agentMission/stage2/liveSheetView";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const SEL_BG = "color-mix(in oklab, var(--ac) 9%, var(--sf))";
const SKELETON_WIDTHS = [300, 150, 130, 128, 72, 84, 84];
const reducedMotion = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const noop = () => undefined;

export const liveTitleOf = (rows: Pick<LiveRows, "doneShown">): string => (rows.doneShown ? LIVE_FINAL_TITLE_AR : LIVE_GRID_TITLE_AR);

interface Col { h: string; kind: ColKind; w: number; grow: boolean }

/** One cell as the grid draws it (one line, ellipsis, the full value in its title). */
function GridCell({ c, col }: { c: LiveCell; col: Col }) {
  const center = col.kind === "number" || col.kind === "link" || c.k === "number";
  const style = { width: col.w, flex: col.grow ? `1 0 ${col.w}px` : "none" } as const;
  const base = `flex min-w-0 items-center overflow-hidden border-b border-e border-ln px-2 ${center ? "justify-center" : ""}`;
  if (c.k === "link") {
    return (
      <div role="gridcell" className={base} style={style} title={c.v}>
        <a href={c.v} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} aria-label="فتح الرابط" className="hit inline-flex h-[22px] items-center gap-[3px] whitespace-nowrap rounded-[6px] border border-ln2 bg-sf px-2 text-[11.5px] font-semibold text-ac no-underline hover:border-ac">{LIVE_OPEN_CHIP_AR}</a>
      </div>
    );
  }
  const text = cellTextOf(c);
  const isId = col.kind === "id";
  const ltr = c.k === "date" || isId || col.kind === "latin";
  return (
    <div role="gridcell" className={base} style={style} title={text || undefined}>
      <span dir={ltr ? "ltr" : "auto"} className={`block min-w-0 max-w-full truncate text-right [font-variant-numeric:tabular-nums] ${isId ? "font-mono text-[11.5px] text-fnt" : c.k === "date" ? "text-[12.5px] text-ink2" : "text-[13px] text-ink"} ${center ? "text-center" : ""}`}>{text}</span>
    </div>
  );
}

/** The side panel: every field of one row, under the file's headers. */
function RowPanel({ index, sheetName, headers, kinds, row, onPrev, onNext, onClose }: { index: number; sheetName: string; headers: string[]; kinds: ColKind[]; row: ReturnType<LiveRows["rowAt"]>; onPrev: () => void; onNext: () => void; onClose: () => void }) {
  if (!row) return null;
  const cells = displayCellsOf(row, headers);
  const title = `رقم ${formatAr(index + 1)} · ${sheetName}`;
  const btn = "hit inline-flex h-8 w-8 items-center justify-center rounded-[8px] border border-ln bg-sf text-ink2 hover:bg-sf2";
  return (
    <aside aria-label={title} data-testid="live-row-panel" className="ls-panel absolute inset-y-0 left-0 z-[7] flex w-[340px] max-w-[85%] flex-col border-s border-ln2 bg-sf" style={{ boxShadow: "var(--shadow)" }}>
      <div className="flex min-h-11 items-center gap-1.5 border-b border-ln bg-sf2 pe-1.5 ps-2">
        <p className="m-0 min-w-0 flex-1 truncate ps-2 text-[13px] font-semibold text-ink">{title}</p>
        <button type="button" onClick={onPrev} aria-label={LIVE_PREV_ROW_AR} className={btn}>↑</button>
        <button type="button" onClick={onNext} aria-label={LIVE_NEXT_ROW_AR} className={btn}>↓</button>
        <button type="button" onClick={onClose} aria-label={LIVE_CLOSE_AR} className="hit inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-[15px] text-mut hover:bg-sf2">✕</button>
      </div>
      <div className="flex-1 overflow-auto px-4 pb-3 pt-0.5">
        {row.cut ? <p className="m-0 mt-2.5 text-[11.5px] text-goldT" data-testid="live-row-cut">{LIVE_CUT_NOTE_AR}</p> : null}
        {headers.map((h, j) => {
          const c = cells[j];
          const kind = kinds[j];
          return (
            <div key={`${h}-${j}`} className="flex flex-col gap-1 border-b border-ln py-2.5">
              <p className="m-0 text-[11.5px] font-medium text-mut">{h}</p>
              {c.k === "link" ? (
                <>
                  <a href={c.v} target="_blank" rel="noopener noreferrer" className="hit inline-flex min-h-8 items-center gap-1.5 self-start rounded-full bg-ac px-3.5 text-[12.5px] font-semibold text-onac no-underline">{LIVE_OPEN_LINK_AR}</a>
                  <p dir="ltr" className="m-0 truncate text-right text-[11px] text-fnt">{c.v}</p>
                </>
              ) : c.k === "empty" ? (
                <p className="m-0 text-[13.5px] text-fnt">{LIVE_EMPTY_VALUE_AR}</p>
              ) : (
                <p dir={c.k === "date" || kind === "id" ? "ltr" : "auto"} className={`m-0 whitespace-pre-wrap text-right leading-[1.75] [overflow-wrap:anywhere] [font-variant-numeric:tabular-nums] ${kind === "id" ? "font-mono text-[12px] text-mut" : "text-[13.5px] text-ink"}`}>{cellTextOf(c)}</p>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** The file's sheets as Excel-like tabs (only with more than one), with each sheet's count of rows shown. */
export function LiveSheetTabs({ rows, onPick, variant = "desk" }: { rows: LiveRows; onPick: (key: string) => void; variant?: "desk" | "phone" }) {
  if (rows.sheets.length <= 1) return null;
  if (variant === "phone") {
    return (
      <div role="tablist" aria-label={LIVE_SHEETS_LABEL_AR} className="flex gap-0.5 rounded-[12px] bg-sf2 p-[3px]" data-testid="live-tabs">
        {rows.sheets.map((s) => {
          const on = s.stageKey === rows.active?.stageKey;
          return (
            <button key={s.stageKey} type="button" role="tab" aria-selected={on} onClick={() => onPick(s.stageKey)} className={`hit inline-flex min-h-[38px] min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[13px] ${on ? "bg-sf font-semibold text-ink" : "bg-transparent font-medium text-mut"}`} style={on ? { boxShadow: "0 1px 2px rgba(0,0,0,.08)" } : undefined}>
              <span className="truncate">{s.nameAr}</span><span className="text-[12px] text-mut [font-variant-numeric:tabular-nums]">{formatAr(s.shown)}</span>
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div role="tablist" aria-label={LIVE_SHEETS_LABEL_AR} className="flex shrink-0 overflow-x-auto [scrollbar-width:none]" data-testid="live-tabs">
      {rows.sheets.map((s) => {
        const on = s.stageKey === rows.active?.stageKey;
        return (
          <button key={s.stageKey} type="button" role="tab" aria-selected={on} onClick={() => onPick(s.stageKey)} className={`hit inline-flex min-h-[34px] items-center gap-1.5 whitespace-nowrap border-e border-ln px-3.5 text-[12.5px] ${on ? "bg-sf font-semibold text-ink" : "bg-transparent font-medium text-mut hover:text-ink"}`} style={{ boxShadow: `inset 0 -2px 0 ${on ? "var(--bar)" : "transparent"}` }}>
            <span>{s.nameAr}</span><span className="text-[11.5px] text-mut [font-variant-numeric:tabular-nums]">{formatAr(s.shown)}</span>
          </button>
        );
      })}
    </div>
  );
}

export function LiveSheetGrid({ data, onWindow = noop, reach = "ok", onShown }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void; reach?: "ok" | "failing"; onShown?: (delivered: number) => void }) {
  const rows = useLiveRows(data, onWindow);
  const running = !rows.doneShown && data.status === "running";
  useNow(rows.doneShown && rows.pending === 0 ? null : 1000);
  const [folded, setFolded] = useState(false);
  const [following, setFollowing] = useState(data.status === "running");
  const [newCount, setNewCount] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [detail, setDetail] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const progUntil = useRef(0);
  const userAt = useRef(0);
  const active = rows.active;
  const R = active?.shown ?? 0;
  const headers = active?.headers ?? [];
  const shownAll = rows.sheets.reduce((a, s) => a + s.shown, 0);

  useEffect(() => { onShown?.(rows.shownDelivered); }, [rows.shownDelivered, onShown]);

  const toBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    progUntil.current = Date.now() + 500;
    const go = () => { if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" }); else el.scrollTop = el.scrollHeight; };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go); else go();
  }, []);

  // a row landed in the sheet on screen: follow it, or count it for the chip
  const revealSeq = rows.lastReveal?.seq ?? 0;
  useEffect(() => {
    const r = rows.lastReveal;
    if (!r || !active || r.sheet !== active.stageKey) return;
    if (following) toBottom(true);
    else if (running) setNewCount((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq]);
  // the end: the position stays, nothing follows any more
  useEffect(() => { if (rows.doneShown) { setFollowing(false); setNewCount(0); } }, [rows.doneShown]);
  // the window to ask: the newest rows while following, else the rows around what the customer looks at
  const first = Math.floor(scrollTop / ROW_HEIGHT);
  useEffect(() => { if (following && data.status === "running") rows.follow(); }, [following, data.status, rows.follow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!following && !folded) rows.viewRange(first, first + VISIBLE_ROWS); }, [following, folded, first, rows.viewRange]); // eslint-disable-line react-hooks/exhaustive-deps
  // where the grid opens: at the newest row while following, else at the top (a sheet turned, the grid unfolded)
  useIsoLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (following) { progUntil.current = Date.now() + 500; el.scrollTop = el.scrollHeight; } else el.scrollTop = 0;
    setScrollTop(el.scrollTop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.stageKey, folded]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const st = el.scrollTop;
    if (Math.floor(st / ROW_HEIGHT) !== Math.floor(scrollTop / ROW_HEIGHT)) setScrollTop(st);
    if (!running) return;
    const dist = el.scrollHeight - el.clientHeight - st;
    if (dist <= ROW_HEIGHT * 0.75) { if (!following) { setFollowing(true); setNewCount(0); } }
    else if (following && Date.now() - userAt.current < 1500 && Date.now() > progUntil.current) setFollowing(false);
  };
  const markUser = () => { userAt.current = Date.now(); progUntil.current = 0; };
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => { markUser(); if (e.key === "Escape") setDetail(null); };
  const onRootKey = (e: KeyboardEvent<HTMLElement>) => { if (e.key === "Escape" && detail !== null) setDetail(null); };
  const pick = (key: string) => {
    rows.setActive(key);
    setNewCount(0);
    setDetail(null);
    setFollowing(data.status === "running");
  };
  const jumpNew = () => { setFollowing(true); setNewCount(0); toBottom(true); };

  const kinds = rows.kinds;
  const cols: Col[] = headers.map((h, i) => ({ h, kind: kinds[i] ?? "short", w: COL_WIDTH[kinds[i] ?? "short"], grow: false }));
  const longI = cols.findIndex((c) => c.kind === "long");
  if (longI >= 0) cols[longI].grow = true;
  const skeletonCols: Col[] = SKELETON_WIDTHS.map((w, i) => ({ h: "", kind: "short", w, grow: i === 0 }));
  const drawCols = cols.length > 0 ? cols : skeletonCols;
  const totalW = ROW_NUMBER_WIDTH + drawCols.reduce((a, c) => a + c.w, 0);

  let start = Math.max(0, first - 20);
  let end = Math.min(R, first + VISIBLE_ROWS + 20);
  if (R <= 80) { start = 0; end = R; }
  const t = Date.now();
  const title = liveTitleOf(rows);
  const line = statusLineOf({ status: data.status, failing: reach === "failing", shown: shownAll, pending: rows.pending, workLog: data.workLog, lastRowAt: rows.lastRowAt, sinceMs: rows.sinceMs, nowMs: t });
  const waiting = R === 0 && running;
  const fillers = Math.max(0, VISIBLE_ROWS - R);
  const showChip = running && !following && newCount > 0 && detail === null;
  const detailRow = detail !== null && detail < R ? rows.rowAt(detail) : undefined;

  return (
    <section dir="rtl" lang="ar" data-testid="live-grid" aria-label={title} onKeyDown={onRootKey} className="relative w-full min-w-0 overflow-hidden rounded-[12px] border border-ln bg-sf text-ink">
      <div className="flex min-h-12 items-center gap-2.5 px-3.5" data-testid="live-grid-head-line">
        <LiveSheetDot tone={line.tone} />
        <h3 className="m-0 whitespace-nowrap text-[15px] font-semibold text-ink">{title}</h3>
        <div className="min-w-0 flex-1" />
        <LiveSheetCounter delivered={rows.shownDelivered} promised={data.promised} />
        <button type="button" aria-expanded={!folded} onClick={() => { setFolded((f) => !f); setDetail(null); }} className="hit min-h-[30px] shrink-0 whitespace-nowrap rounded-[8px] border border-ln bg-transparent px-2.5 text-[12.5px] text-ink2 hover:bg-sf2 hover:text-ink" data-testid="live-fold">{folded ? showSheetAr(R) : LIVE_HIDE_AR}</button>
      </div>
      <LiveSheetBar delivered={rows.shownDelivered} promised={data.promised} />
      {!folded ? (
        <div className="relative">
          <div
            ref={scrollRef}
            role="grid"
            aria-label={title}
            aria-rowcount={R + 1}
            aria-colcount={drawCols.length + 1}
            aria-busy={running}
            tabIndex={0}
            onScroll={onScroll}
            onWheel={markUser}
            onTouchMove={markUser}
            onKeyDown={onGridKey}
            data-testid="live-grid-scroll"
            className="ls-grid relative overflow-auto bg-sf outline-offset-[-2px]"
            style={{ height: HEADER_HEIGHT + VISIBLE_ROWS * ROW_HEIGHT }}
          >
            <div style={{ width: totalW, minWidth: "100%" }}>
              <div role="row" aria-rowindex={1} className="sticky top-0 z-[3] flex bg-sf2" style={{ height: HEADER_HEIGHT }} data-testid="live-grid-head">
                <div role="columnheader" aria-label={LIVE_ROW_NUMBER_LABEL_AR} className="sticky start-0 z-[4] shrink-0 border-b border-e border-b-ln2 border-e-ln bg-sf2" style={{ width: ROW_NUMBER_WIDTH }} />
                {drawCols.map((c, i) => (
                  <div key={`${c.h}-${i}`} role="columnheader" title={c.h || undefined} className={`flex items-center overflow-hidden whitespace-nowrap border-b border-e border-b-ln2 border-e-ln bg-sf2 px-2 text-[12px] font-semibold ${c.kind === "emptycol" ? "text-fnt" : "text-ink"} ${c.kind === "number" || c.kind === "link" ? "justify-center" : ""}`} style={{ width: c.w, flex: c.grow ? `1 0 ${c.w}px` : "none" }}>
                    {c.h ? <span className="truncate" data-testid="live-grid-header">{c.h}</span> : <span className="skeleton block h-2 w-1/2 rounded" />}
                  </div>
                ))}
              </div>
              <div style={{ height: start * ROW_HEIGHT }} />
              {Array.from({ length: Math.max(0, end - start) }, (_, k) => {
                const i = start + k;
                const r = rows.rowAt(i);
                const sel = detail === i;
                const at = r ? rows.arrivedAt(r.id) : undefined;
                const age = at === undefined ? Infinity : t - at;
                const fresh = age < ARRIVAL_MS;
                const edge = age < EDGE_MS;
                const cells = r ? displayCellsOf(r, headers) : null;
                return (
                  <div
                    key={r ? r.id : `p${i}`}
                    role="row"
                    aria-rowindex={i + 2}
                    aria-selected={sel}
                    data-testid="live-grid-row"
                    data-fresh={fresh ? "true" : undefined}
                    onClick={() => { if (r) setDetail(i); }}
                    className={`flex cursor-pointer ${sel ? "" : "bg-sf hover:bg-sf2"} ${fresh ? "ls-row-in" : ""}`}
                    style={{ height: ROW_HEIGHT, ...(sel ? { background: SEL_BG } : {}) }}
                  >
                    <div role="rowheader" className="sticky start-0 z-[2] flex shrink-0 items-center justify-center border-b border-e border-ln bg-sf2 text-[11px] [font-variant-numeric:tabular-nums]" style={{ width: ROW_NUMBER_WIDTH, color: sel ? "var(--ink)" : "var(--mut)", fontWeight: sel ? 700 : 400, boxShadow: `inset -3px 0 0 ${sel ? "var(--ac)" : edge ? "var(--gold)" : "transparent"}` }}>{formatAr(i + 1)}</div>
                    {cells
                      ? cols.map((col, j) => <GridCell key={j} c={cells[j]} col={col} />)
                      : drawCols.map((col, j) => <div key={j} role="gridcell" className="border-b border-e border-ln" style={{ width: col.w, flex: col.grow ? `1 0 ${col.w}px` : "none" }} />)}
                  </div>
                );
              })}
              {Array.from({ length: fillers }, (_, k) => (
                <div key={`f${k}`} aria-hidden="true" className="flex bg-sf" style={{ height: ROW_HEIGHT }} data-testid={waiting && k < 5 ? "live-grid-skeleton" : undefined}>
                  <div className="sticky start-0 z-[2] shrink-0 border-b border-e border-ln bg-sf2" style={{ width: ROW_NUMBER_WIDTH }} />
                  {drawCols.map((col, j) => (
                    <div key={j} className={`flex items-center border-b border-e border-ln px-2 ${col.kind === "number" || col.kind === "link" ? "justify-center" : ""}`} style={{ width: col.w, flex: col.grow ? `1 0 ${col.w}px` : "none" }}>
                      {waiting && k < 5 ? <span className="skeleton block h-2 rounded" style={{ width: `${Math.max(24, [78, 62, 54, 70, 40, 36, 30][j % 7] - ((k * 7) % 20))}%` }} /> : null}
                    </div>
                  ))}
                </div>
              ))}
              <div style={{ height: Math.max(0, R - end) * ROW_HEIGHT }} />
            </div>
          </div>
          {showChip ? (
            <button type="button" onClick={jumpNew} data-testid="live-new-chip" className="ls-chip after:absolute after:-inset-2 after:content-[''] absolute bottom-3.5 left-1/2 z-[6] inline-flex min-h-8 -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border-0 bg-ac px-4 text-[12.5px] font-semibold text-onac" style={{ boxShadow: "var(--shadow)" }}>{`نتائج جديدة ↓ (${formatAr(newCount)})`}</button>
          ) : null}
          {detail !== null && detailRow && active ? (
            <RowPanel index={detail} sheetName={active.nameAr} headers={headers} kinds={kinds} row={detailRow} onPrev={() => setDetail((d) => Math.max(0, (d ?? 0) - 1))} onNext={() => setDetail((d) => Math.min(R - 1, (d ?? 0) + 1))} onClose={() => setDetail(null)} />
          ) : null}
        </div>
      ) : null}
      <div className="flex items-stretch border-t border-ln bg-sf2">
        <LiveSheetTabs rows={rows} onPick={pick} />
        <div className="flex min-h-[34px] min-w-0 flex-1 items-center px-3.5"><LiveStatusLine line={line} /></div>
      </div>
    </section>
  );
}

export default LiveSheetGrid;
