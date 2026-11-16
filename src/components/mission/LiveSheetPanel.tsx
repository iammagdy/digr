"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLiveSheet, type LiveReach } from "@/hooks/useLiveSheet";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import { LiveSheetCards } from "./LiveSheetCards";
import { LiveSheetGrid } from "./LiveSheetGrid";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): the live sheet of a running mission. It polls only when `enabled` (the mission answer said DIGER_STAGE2_LIVE_SHEET is on for the viewer); with nothing to
 * show it draws nothing.
 *
 * THE REDESIGN (the Claude Design handoff «Diger live sheet», 16 Nov 2026): the sheet's own width decides what is drawn: from 560 px the spreadsheet grid (`LiveSheetGrid`), below it the
 * phone card with the newest three rows (`LiveSheetCards`). Its states, all from the route's own answers:
 *   - the route answered and the worker has saved nothing yet: the grid's skeleton (the phone: one line), the counter «بانتظار أول الصفوف»;
 *   - rows: they land one at a time, and the counter follows the rows shown;
 *   - the DONE snapshot, every row shown: titled as the final result, the status line says they are the rows of the file (true by the equality contract);
 *   - an ask failed: the rows stay, the status line says it reconnects.
 */
export const LIVE_SHEET_BREAKPOINT = 560;
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** What the sheet shows before the worker's first snapshot (the route said «waiting»): no sheet, no row, no number. */
export const LIVE_EMPTY_DATA: LiveData = { changed: true, cursor: "", status: "running", delivered: 0, promised: null, counterAr: "", workLog: [], sheets: [], window: { stageKey: "", offset: 0, rows: [] }, truncated: false, retryAfterMs: null };

export function LiveSheetView({ data, onWindow, reach = "ok", onShown }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void; reach?: LiveReach; onShown?: (delivered: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"desktop" | "phone">("desktop");
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => { const w = el.clientWidth; if (w > 0) setMode(w >= LIVE_SHEET_BREAKPOINT ? "desktop" : "phone"); };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="w-full min-w-0" data-testid="live-sheet" data-status={data.status} data-mode={mode}>
      {mode === "desktop" ? <LiveSheetGrid data={data} onWindow={onWindow} reach={reach} onShown={onShown} /> : <LiveSheetCards data={data} onWindow={onWindow} reach={reach} onShown={onShown} />}
    </div>
  );
}

export function LiveSheetPanel({ missionId, enabled, missionLive, onData, rowsHint }: {
  missionId: string;
  enabled: boolean;
  /** Whether the mission still works (the card knows): while it does, «no snapshot yet» keeps the loop asking; once it has ended, the loop ends after three answers with no news. */
  missionLive?: boolean;
  /**
   * STAGE 2 F-2: the last data the panel holds (null until its first answer), so the request card can show ONE progress counter. A failed poll keeps the last data; nothing is reported for it.
   */
  onData?: (data: LiveData | null) => void;
  /**
   * The rows the card already knows were saved (its own events). While the sheet holds fewer, it asks at once instead of waiting out the slower interval of «no snapshot yet» (live, 16 Nov 2026:
   * the card said ٥٤ while the sheet still waited for its first rows, ~20 s behind).
   */
  rowsHint?: number;
}) {
  const { data, waiting, reach, setWindow, refresh } = useLiveSheet(missionId, { enabled, ...(missionLive === undefined ? {} : { missionLive }) });
  // the card's counter keeps the route's number (it never goes back while the sheet's rows land one at a time; the sheet's own counter catches up within seconds)
  useEffect(() => { onData?.(enabled ? data : null); }, [data, enabled, onData]);
  const known = data?.delivered ?? 0;
  useEffect(() => { if (enabled && typeof rowsHint === "number" && rowsHint > known) refresh(); }, [enabled, rowsHint, known, refresh]);
  if (!enabled) return null;
  const view = data ?? (waiting && missionLive !== false ? LIVE_EMPTY_DATA : null);
  if (!view) return null;
  return <LiveSheetView data={view} onWindow={setWindow} reach={reach} />;
}

export default LiveSheetPanel;
