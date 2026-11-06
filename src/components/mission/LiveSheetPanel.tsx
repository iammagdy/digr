"use client";

import { useEffect } from "react";
import { useLiveSheet, type LiveReach } from "@/hooks/useLiveSheet";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import { LiveSheetCards } from "./LiveSheetCards";
import { LiveSheetGrid } from "./LiveSheetGrid";
import { LiveWorkLog } from "./LiveWorkLog";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): the live sheet of a running mission: on a desktop the grid (S9), on a phone the cards and the counter, and the work log's one line above both. It polls
 * only when `enabled` (the mission answer said DIGER_STAGE2_LIVE_SHEET is on for the viewer); with nothing to show it draws nothing, so the page is today's.
 *
 * LAUNCH ROUND: the same panel is drawn in the CONVERSATION (under the mission card, right after the approval) and on the request page. Its states, all from the route's own answers:
 *   - the route answered and the worker has saved nothing yet: one line saying the rows will appear here (no empty table, no number);
 *   - rows: the grid or the cards, with the counter of the snapshot;
 *   - the snapshot is the DONE one: titled as the final result and said to be the rows of the file (true by the equality contract; it never says the rows «arrived one by one»);
 *   - an ask failed: the last data stays, with one line saying it will try again (nothing is erased by a failure or a late answer).
 */
export const LIVE_WAITING_AR = "ستظهر هنا النتائج أولًا بأول فور حفظها.";
export const LIVE_FINAL_AR = "اكتمل الجمع، وهذه هي البيانات نفسها التي في ملفك.";
export const LIVE_RECONNECT_AR = "تعذّر التحديث الآن، وسنحاول مرة أخرى تلقائيًا. المعروض هو آخر ما وصلنا.";

export function LiveSheetView({ data, onWindow, reach = "ok" }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void; reach?: LiveReach }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="live-sheet" data-status={data.status}>
      <LiveWorkLog lines={data.workLog} />
      {data.status === "done" ? <p className="m-0 text-[13px] leading-[1.8] text-ink2" data-testid="live-final">{LIVE_FINAL_AR}</p> : null}
      {reach === "failing" ? <p role="status" className="m-0 rounded-[10px] bg-sf2 px-3 py-2 text-[13px] leading-[1.8] text-ink" data-testid="live-reconnect">{LIVE_RECONNECT_AR}</p> : null}
      <div className="hidden sm:block"><LiveSheetGrid data={data} onWindow={onWindow} /></div>
      <div className="sm:hidden"><LiveSheetCards data={data} onWindow={onWindow} /></div>
    </div>
  );
}

export function LiveSheetWaiting() {
  return <p dir="rtl" role="status" className="m-0 rounded-[12px] border border-dashed border-ln2 px-3 py-3 text-[13px] leading-[1.8] text-ink2" data-testid="live-waiting">{LIVE_WAITING_AR}</p>;
}

export function LiveSheetPanel({ missionId, enabled, missionLive, onData }: {
  missionId: string;
  enabled: boolean;
  /** Whether the mission still works (the card knows): while it does, «no snapshot yet» keeps the loop asking; once it has ended, the loop ends after three answers with no news. */
  missionLive?: boolean;
  /** STAGE 2 F-2: the last data the panel holds (null until its first answer), so the request card can show ONE progress counter. A failed poll keeps the last data; nothing is reported for it. */
  onData?: (data: LiveData | null) => void;
}) {
  const { data, waiting, reach, setWindow } = useLiveSheet(missionId, { enabled, ...(missionLive === undefined ? {} : { missionLive }) });
  useEffect(() => { onData?.(enabled ? data : null); }, [data, enabled, onData]);
  if (!enabled) return null;
  if (!data) return waiting && missionLive !== false ? <LiveSheetWaiting /> : null;
  return <LiveSheetView data={data} onWindow={setWindow} reach={reach} />;
}

export default LiveSheetPanel;
