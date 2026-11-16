"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatAr } from "@/lib/arabicDigits";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import {
  ARRIVAL_MS, EDGE_MS, LIVE_CLOSE_AR, LIVE_CUT_NOTE_AR, LIVE_EMPTY_VALUE_AR, LIVE_NEXT_ROW_AR, LIVE_PHONE_EMPTY_AR, LIVE_PREV_ROW_AR, cellTextOf, displayCellsOf, openLinkLabelOf, rowPartsOf, statusLineOf,
} from "@/lib/agentMission/stage2/liveSheetView";
import { useLiveRows, useNow, type LiveRows } from "@/hooks/useLiveRows";
import { LiveSheetTabs, liveTitleOf } from "./LiveSheetGrid";
import { LiveSheetBar, LiveSheetCounter, LiveSheetDot, LiveStatusLine } from "./LiveSheetParts";

/**
 * STAGE 2: THE LIVE SHEET ON A PHONE (the Claude Design handoff «Diger live sheet», variant «peek»). A card in the chat: the live dot, the title, the counter and its bar, one status line,
 * the file's sheets as a segmented control, then the NEWEST THREE rows of the sheet (oldest on top), each landing with a short fade and a gold highlight. A tap on a row opens a bottom sheet
 * with every field of that row (the full text, its numbers as tiles, the link as a button, the rest as label and value). Nothing else to press: the full sheet is the file.
 */
const noop = () => undefined;
const PEEK = 3;

function RowSheet({ rows, index, onIndex, onClose }: { rows: LiveRows; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const active = rows.active;
  const row = rows.rowAt(index);
  if (!active || !row) return null;
  const cells = displayCellsOf(row, active.headers);
  const parts = rowPartsOf(cells, active.headers, rows.kinds);
  const title = `رقم ${formatAr(index + 1)} · ${active.nameAr}`;
  const iconBtn = "inline-flex h-11 w-11 items-center justify-center bg-transparent text-[16px]";
  return (
    <div dir="rtl" lang="ar" className="fixed inset-0 z-[80]" data-testid="live-row-sheet">
      <div onClick={onClose} className="ls-fade absolute inset-0" style={{ background: "rgba(10,14,13,.4)" }} />
      <div role="dialog" aria-modal="true" aria-label={title} className="ls-sheet-up absolute inset-x-0 bottom-0 flex max-h-[84%] flex-col rounded-t-[22px] bg-sf text-ink" style={{ boxShadow: "var(--shadow)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        <div className="flex justify-center pt-2"><span className="h-1 w-9 rounded-sm bg-ln2" /></div>
        <div className="flex min-h-[50px] items-center gap-0.5 pe-1 ps-1.5">
          <p className="m-0 min-w-0 flex-1 truncate ps-3 text-[14px] font-semibold">{title}</p>
          <button type="button" onClick={() => onIndex(Math.max(0, index - 1))} aria-label={LIVE_PREV_ROW_AR} disabled={!rows.rowAt(index - 1)} className={`${iconBtn} text-ink2 disabled:opacity-40`}>↑</button>
          <button type="button" onClick={() => onIndex(index + 1)} aria-label={LIVE_NEXT_ROW_AR} disabled={!rows.rowAt(index + 1)} className={`${iconBtn} text-ink2 disabled:opacity-40`}>↓</button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label={LIVE_CLOSE_AR} className={`${iconBtn} text-mut`}>✕</button>
        </div>
        <div className="flex flex-col gap-3.5 overflow-auto overscroll-contain px-[18px] pb-5">
          {row.cut ? <p className="m-0 text-[11.5px] text-goldT">{LIVE_CUT_NOTE_AR}</p> : null}
          {parts.text ? <p dir="auto" className="m-0 whitespace-pre-wrap text-right text-[15.5px] leading-[1.8] [overflow-wrap:anywhere]" data-testid="live-row-text">{parts.text.c.v}</p> : null}
          {parts.stats.length > 0 ? (
            <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${parts.stats.length}, minmax(0, 1fr))` }}>
              {parts.stats.map((s) => (
                <div key={s.i} className="flex flex-col gap-0.5 rounded-[12px] bg-sf2 px-3 py-2.5">
                  <span className="font-display text-[22px] font-semibold leading-[1.1] [font-variant-numeric:tabular-nums]">{cellTextOf(s.c)}</span>
                  <span className="text-[12px] text-mut">{s.word}</span>
                </div>
              ))}
            </div>
          ) : null}
          {parts.link ? <a href={parts.link.c.v} target="_blank" rel="noopener noreferrer" className="flex min-h-[46px] items-center justify-center rounded-[14px] bg-ac text-[14px] font-semibold text-onac no-underline">{openLinkLabelOf(active.nameAr)}</a> : null}
          <div className="flex flex-col">
            {parts.rest.map((f) => {
              const ltr = f.c.k === "date" || f.kind === "id" || f.kind === "latin";
              return (
                <div key={f.i} className="flex gap-3 border-t border-ln py-2.5 text-[13.5px]">
                  <span className="w-24 shrink-0 text-mut">{f.h}</span>
                  {f.c.k === "empty" ? <span className="min-w-0 flex-1 text-fnt">{LIVE_EMPTY_VALUE_AR}</span> : (
                    <span dir={ltr ? "ltr" : "auto"} className={`min-w-0 flex-1 text-right [overflow-wrap:anywhere] ${f.kind === "id" ? "font-mono text-[12px] text-mut" : "text-ink"}`}>{f.kind === "latin" && f.h === "الحساب" && !f.c.v.startsWith("@") ? `@${f.c.v}` : cellTextOf(f.c)}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function LiveSheetCards({ data, onWindow = noop, reach = "ok", onShown }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void; reach?: "ok" | "failing"; onShown?: (delivered: number) => void }) {
  const rows = useLiveRows(data, onWindow);
  useNow(rows.doneShown && rows.pending === 0 ? null : 1000);
  const [detail, setDetail] = useState<number | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => { onShown?.(rows.shownDelivered); }, [rows.shownDelivered, onShown]);
  // the phone always shows the newest rows: it asks for them (the sheet turned or not)
  useEffect(() => { rows.follow(); }, [rows.follow]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = rows.active;
  const R = active?.shown ?? 0;
  const t = Date.now();
  const title = liveTitleOf(rows);
  const shownAll = rows.sheets.reduce((a, s) => a + s.shown, 0);
  const line = statusLineOf({ status: data.status, failing: reach === "failing", shown: shownAll, pending: rows.pending, workLog: data.workLog, lastRowAt: rows.lastRowAt, sinceMs: rows.sinceMs, nowMs: t });
  const peek: number[] = [];
  for (let i = Math.max(0, R - PEEK); i < R; i += 1) if (rows.rowAt(i)) peek.push(i);

  return (
    <section dir="rtl" lang="ar" data-testid="live-cards" aria-label={title} className="w-full min-w-0 overflow-hidden rounded-[20px] border border-ln bg-sf text-ink">
      <div className="flex flex-col gap-2 px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2.5">
          <LiveSheetDot tone={line.tone} />
          <h3 className="m-0 min-w-0 flex-1 truncate text-[14.5px] font-semibold">{title}</h3>
          <LiveSheetCounter delivered={rows.shownDelivered} promised={data.promised} size="phone" />
        </div>
        <LiveSheetBar delivered={rows.shownDelivered} promised={data.promised} thick={4} rule={false} />
        <LiveStatusLine line={line} wrap />
        <LiveSheetTabs rows={rows} variant="phone" onPick={(k) => { rows.setActive(k); setDetail(null); }} />
      </div>
      <div className="border-t border-ln" role="list" aria-label={active?.nameAr ?? title}>
        {peek.map((i) => {
          const r = rows.rowAt(i)!;
          const cells = displayCellsOf(r, active!.headers);
          const parts = rowPartsOf(cells, active!.headers, rows.kinds);
          const at = rows.arrivedAt(r.id);
          const age = at === undefined ? Infinity : t - at;
          const text = parts.text ? parts.text.c.v : cells.map(cellTextOf).find((x) => x) ?? "";
          return (
            <button
              key={r.id}
              type="button"
              role="listitem"
              onClick={() => setDetail(i)}
              data-testid="live-card"
              data-fresh={age < ARRIVAL_MS ? "true" : undefined}
              className={`flex w-full flex-col gap-1 border-b border-ln bg-sf px-4 last:border-b-0 py-[11px] text-right ${age < ARRIVAL_MS ? "ls-phone-in" : ""}`}
              style={{ boxShadow: `inset -3px 0 0 ${age < EDGE_MS ? "var(--gold)" : "transparent"}` }}
            >
              <span dir="auto" className="line-clamp-2 w-full text-right text-[13.5px] leading-[1.6] text-ink [overflow-wrap:anywhere]">{text}</span>
              <span className="flex flex-wrap gap-3 text-[12px] text-mut">
                <span className="text-fnt [font-variant-numeric:tabular-nums]">رقم {formatAr(i + 1)}</span>
                {parts.stats.slice(0, 2).map((s) => <span key={s.i}><span className="sr-only"> · </span><b className="font-semibold text-ink">{cellTextOf(s.c)}</b> {s.word}</span>)}
              </span>
            </button>
          );
        })}
        {R === 0 ? <p className="m-0 px-6 py-[22px] text-center text-[13px] text-fnt" data-testid="live-cards-empty">{LIVE_PHONE_EMPTY_AR}</p> : null}
      </div>
      {mounted && detail !== null ? createPortal(<RowSheet rows={rows} index={detail} onIndex={setDetail} onClose={() => setDetail(null)} />, document.body) : null}
    </section>
  );
}

export default LiveSheetCards;
