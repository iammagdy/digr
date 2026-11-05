"use client";

import { useLiveSheet } from "@/hooks/useLiveSheet";
import type { LiveData, LiveWindow } from "@/lib/agentMission/stage2/livePoller";
import { LiveSheetCards } from "./LiveSheetCards";
import { LiveSheetGrid } from "./LiveSheetGrid";
import { LiveWorkLog } from "./LiveWorkLog";

/**
 * STAGE 2 S10 (docs/STAGE-2.md): the live sheet of a running mission: on a desktop the grid (S9), on a phone the cards and the counter, and the work log under both. It polls only when
 * `enabled` (the mission answer said DIGER_STAGE2_LIVE_SHEET is on for the viewer); with nothing to show it draws nothing, so the page is today's.
 */
export function LiveSheetView({ data, onWindow }: { data: LiveData; onWindow?: (w: Partial<LiveWindow>) => void }) {
  return (
    <div className="flex flex-col gap-3" data-testid="live-sheet">
      <div className="hidden sm:block"><LiveSheetGrid data={data} onWindow={onWindow} /></div>
      <div className="sm:hidden"><LiveSheetCards data={data} onWindow={onWindow} /></div>
      <LiveWorkLog lines={data.workLog} />
    </div>
  );
}

export function LiveSheetPanel({ missionId, enabled }: { missionId: string; enabled: boolean }) {
  const { data, setWindow } = useLiveSheet(missionId, { enabled });
  if (!enabled || !data) return null;
  return <LiveSheetView data={data} onWindow={setWindow} />;
}

export default LiveSheetPanel;
